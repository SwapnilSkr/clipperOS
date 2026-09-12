/**
 * Standalone mining validation — run against a real video before trusting the
 * pipeline:
 *
 *   bun run validate:mining <youtube-url-or-id> [genreId]
 *
 * Fetches the transcript only (no media download), mines it under the chosen
 * genre (or lets detection choose), and prints the ranked candidates. Exits
 * non-zero if any contract invariant is violated:
 *   - at least one candidate is produced
 *   - peakLine, when present, appears verbatim inside transcript
 *   - peakSec falls inside [startSec, endSec]
 *   - duration is within the genre's target band
 */
import { fetchYoutubeTranscript, parseYoutubeVideoId } from "../src/services/ingest.service";
import { mineMoments } from "../src/services/mining.service";
import { detectGenre } from "../src/services/genre-detect.service";
import { isKnownGenre, listGenreProfiles, resolveGenreProfile } from "../src/config/genres";

function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function scoreBar(score: number): string {
  const filled = Math.round(score);
  return `${"█".repeat(Math.max(0, filled))}${"░".repeat(Math.max(0, 10 - filled))}`;
}

const urlArg = process.argv[2];
const genreArg = process.argv[3];

if (!urlArg) {
  console.error("usage: bun run validate:mining <youtube-url-or-id> [genreId]");
  console.error(`genres: ${listGenreProfiles().map((p) => p.id).join(", ")}`);
  process.exit(1);
}
if (genreArg && !isKnownGenre(genreArg)) {
  console.error(`Unknown genre "${genreArg}". Known: ${listGenreProfiles().map((p) => p.id).join(", ")}`);
  process.exit(1);
}

const videoId = parseYoutubeVideoId(urlArg);
if (!videoId) {
  console.error(`Could not parse a video id from: ${urlArg}`);
  process.exit(1);
}

console.log(`🎯 Validating mining for ${videoId}\n`);

const t0 = Date.now();
const { cues } = await fetchYoutubeTranscript(videoId);
const captionMs = Date.now() - t0;
console.log(`📝 ${cues.length} caption cues fetched in ${captionMs}ms\n`);

if (!cues.length) {
  console.error("❌ No captions available — nothing to mine.");
  process.exit(2);
}

// Resolve the genre: explicit flag wins, else detection decides (which is also
// what the pipeline does by default).
let genreId = genreArg;
if (!genreId) {
  const detection = await detectGenre({
    title: `(video ${videoId})`,
    transcriptSample: cues.slice(0, 400).map((c) => c.text).join(" "),
  });
  genreId = detection.genreId;
  console.log(
    `🎭 Auto-detected genre: ${genreId}` + (detection.reason ? ` — ${detection.reason}` : "")
  );
}
const profile = resolveGenreProfile(genreId);
console.log(`🎬 Using profile: ${profile.label} (${profile.id})\n`);

const result = await mineMoments({
  captions: cues,
  genreId,
  targetCount: 10,
  onProgress: (done, total) => {
    if (total > 1) process.stdout.write(`\r   mining chunk ${done}/${total}…`);
    if (done === total) process.stdout.write("\r".padEnd(40) + "\r");
  },
});

console.log(
  `⛏️  ${result.words} words → ${result.sentences} sentence units → ` +
    `${result.chunks} chunks in ${(result.elapsedMs / 1000).toFixed(1)}s\n`
);

if (!result.candidates.length) {
  console.error(`❌ No qualifying candidates found under "${profile.id}".`);
  process.exit(3);
}

const { min: MIN, max: MAX, target: TARGET } = profile.clipDuration;
console.log("─".repeat(78));
for (const [i, c] of result.candidates.entries()) {
  const dur = (c.endSec - c.startSec).toFixed(1);
  console.log(
    `#${i + 1}  ${c.totalScore.toFixed(2)}  ${scoreBar(c.totalScore)}  ` +
      `${timecode(c.startSec)}–${timecode(c.endSec)} (${dur}s)`
  );
  const axes = profile.scoringAxes
    .map((a) => `${a.label} ${c.scores[a.id] ?? "?"}`)
    .join("  ");
  console.log(`     ${axes}`);
  console.log(
    c.peakLine
      ? `     PEAK: "${c.peakLine}"`
      : `     PEAK: (a moment at ${c.peakSec.toFixed(1)}s — no spoken line)`
  );
  console.log(`     ${c.rationale}`);
  console.log(`     themes: ${c.suggestedThemes.join(", ")}`);
  console.log("─".repeat(78));
}

// ---- contract invariants ----
const failures: string[] = [];
for (const c of result.candidates) {
  if (c.peakLine && !c.transcript.includes(c.peakLine)) {
    failures.push(`${c.id}: peakLine is not verbatim inside transcript`);
  }
  if (c.peakSec < c.startSec - 0.01 || c.peakSec > c.endSec + 0.01) {
    failures.push(`${c.id}: peakSec ${c.peakSec} outside [${c.startSec}, ${c.endSec}]`);
  }
  if (profile.peakKind === "line" && !c.peakLine) {
    failures.push(`${c.id}: a "${profile.id}" clip must have a peak line`);
  }
  if (c.peakKind !== profile.peakKind) {
    failures.push(`${c.id}: peakKind ${c.peakKind} != profile ${profile.peakKind}`);
  }
  const dur = c.endSec - c.startSec;
  if (dur < MIN * 0.6 || dur > MAX + 5) {
    failures.push(`${c.id}: duration ${dur.toFixed(1)}s outside the ${profile.id} band`);
  }
  // Every declared axis must be scored — a missing axis means the prompt shape
  // and the parser disagree.
  for (const axis of profile.scoringAxes) {
    if (typeof c.scores[axis.id] !== "number") {
      failures.push(`${c.id}: axis "${axis.id}" missing from scores`);
    }
  }
  // And no extraneous axes.
  const declared = new Set(profile.scoringAxes.map((a) => a.id));
  for (const key of Object.keys(c.scores)) {
    if (!declared.has(key)) failures.push(`${c.id}: unexpected axis "${key}" in scores`);
  }
}

console.log(
  `Profile: ${profile.label} · target ${MIN}-${MAX}s (ideal ${TARGET}) · ` +
    `peak kind: ${profile.peakKind} · captions: ${profile.captionsDefault ? "on" : "off"}`
);

if (failures.length) {
  console.error("❌ INVARIANT FAILURES:");
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(4);
}

console.log(
  `✅ ${result.candidates.length} candidates under "${profile.id}", all invariants hold. ` +
    `End-to-end ${((captionMs + result.elapsedMs) / 1000).toFixed(1)}s.`
);
process.exit(0);
