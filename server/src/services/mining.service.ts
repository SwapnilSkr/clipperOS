// ============================================
// MOMENT MINING — the creative core of the clipper.
//
// GENRE-AGNOSTIC BY CONSTRUCTION. This file contains no genre knowledge: it
// segments, chunks, calls the model, and resolves ids back to real times. What
// makes a clip good — what qualifies, what to reject, how to score, how long it
// should be, what the peak is — is read from a GenreProfile (config/genres.ts)
// and injected into the prompt and the ranking.
//
// Input : CaptionCue[] (YouTube auto-captions, messy + rolling, or Whisper words)
//          + a genre profile
// Output: MomentCandidate[] ranked, deduped, scored
//
// The single most important output is `peakSec` (+ `peakLine` when the peak is
// spoken): the exact instant of the payoff, punchline, resolving play, or drop.
// For line-peak genres a mislocated peak ruins the clip, because downstream the
// caption emphasis and (later) the music drop align to it.
//
// Pipeline:
//   1. buildWordTimeline  — undo YouTube's rolling-caption duplication
//   2. segmentSentences   — sentence-ish units (punctuation OR pause OR length)
//   3. chunkSentences     — ~12 min windows with overlap
//   4. mineChunk          — one LLM call per chunk, returns SENTENCE IDS not floats
//   5. resolveCandidate   — ids -> times, verbatim transcript, peak sub-location,
//                           cue-boundary snapping, duration fitting, re-scoring
//   6. merge              — cross-chunk dedupe + global re-rank
//
// Ported from the reference workspace's moment-mining service, where the
// segmentation and peak-location strategy were tuned against real episodes.
// Those are load-bearing — change them with evidence.
// ============================================

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels, type Tier } from "../config/models";
import {
  resolveGenreProfile,
  scoreForProfile,
  type GenreProfile,
} from "../config/genres";
import type { CaptionCue, MomentCandidate, ScoreMap } from "../types/clip.types";
import { getErrorMessage } from "../types";

const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });

// ---------------------------------------------------------------------------
// Genre-neutral tuning constants
//
// Anything that varies by genre (clip length, axes, what qualifies) lives in the
// GenreProfile. What remains here is genuinely universal geometry.
// ---------------------------------------------------------------------------

/**
 * Chunk width. A 2h episode is ~18k words / ~24k tokens — it *fits* in a modern
 * context window but quality degrades badly: the model skims, and the peak
 * timestamps it returns drift by tens of seconds. 12 minutes is ~1.8k words,
 * small enough that the model attends to every individual sentence.
 */
const CHUNK_SEC = 12 * 60;
/** Overlap between adjacent chunks, so a max-length moment is whole in one. */
const CHUNK_OVERLAP_SEC = 120;
/**
 * How many chunk calls to run at once. Mining is I/O-bound on the LLM and this
 * is the single biggest latency lever for a long episode.
 */
const CHUNK_CONCURRENCY = 8;
/** Candidates requested per chunk before global re-ranking. */
const PER_CHUNK_CANDIDATES = 4;

/** Start a beat early rather than clipping the first syllable. */
const LEAD_IN_SEC = 0.25;

/** Two candidates overlapping more than this fraction are the same moment. */
const DEDUPE_OVERLAP = 0.45;

/**
 * The peak must sit at least this far into the clip, as a fraction of its
 * duration. A peak at +0.3s of a 38s clip means there is no build, and the rest
 * is anticlimax. Observed whenever the model mistakes the topic sentence for the
 * peak, so we fix it by extending the clip backwards, not by moving the peak.
 */
const MIN_PEAK_POSITION = 0.2;

/** Below this a candidate is not worth showing a human. */
const MIN_TOTAL_SCORE = 3.5;


// ---------------------------------------------------------------------------
// 1-2. Caption normalization -> word timeline
// ---------------------------------------------------------------------------

interface TimedWord {
  text: string;
  startSec: number;
  endSec: number;
}

/** Bare comparison form for overlap detection — casing/punctuation insensitive. */
function normWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

const MAX_ROLLING_OVERLAP = 40;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * YouTube auto-captions arrive HTML-escaped and use `>>` as a speaker-change
 * marker. Both leak straight into `transcript` and then into burned-in captions
 * if not stripped here.
 */
function cleanCueText(raw: string): string {
  return raw
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? " ")
    .replace(/&#\d+;/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[[^\]]*\]/g, " ") // [Music], [Applause]
    .replace(/>>+/g, " ") // speaker-change markers
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rebuild a single non-repeating word stream from rolling captions: for each
 * cue, find the longest prefix of its words that is already a suffix of what
 * we've emitted, drop it, and spread the genuinely-new words across the cue's
 * time span.
 */
export function buildWordTimeline(cues: CaptionCue[]): TimedWord[] {
  const ordered = [...cues]
    .filter((c) => c && typeof c.startSec === "number" && c.text?.trim())
    .sort((a, b) => a.startSec - b.startSec);

  const words: TimedWord[] = [];
  const norm: string[] = []; // parallel array of normWord() for overlap search

  for (const cue of ordered) {
    const raw = cleanCueText(cue.text).split(" ").filter(Boolean);
    if (!raw.length) continue;

    const cand = raw.map(normWord);
    let overlap = 0;
    const maxK = Math.min(raw.length, norm.length, MAX_ROLLING_OVERLAP);
    for (let k = maxK; k > 0; k--) {
      let match = true;
      for (let i = 0; i < k; i++) {
        if (norm[norm.length - k + i] !== cand[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        overlap = k;
        break;
      }
    }

    const fresh = raw.slice(overlap);
    if (!fresh.length) continue;

    const start = cue.startSec;
    const end = Math.max(cue.endSec ?? start, start + 0.05);
    const step = (end - start) / fresh.length;
    for (let i = 0; i < fresh.length; i++) {
      const wStart = start + step * i;
      words.push({ text: fresh[i], startSec: wStart, endSec: wStart + step });
      norm.push(cand[overlap + i]);
    }
  }

  return words;
}

/** Sorted, deduped cue boundaries used for snapping clip edges. */
function cueBoundaries(cues: CaptionCue[]): { starts: number[]; ends: number[] } {
  const starts = new Set<number>();
  const ends = new Set<number>();
  for (const c of cues) {
    if (!c?.text?.trim()) continue;
    // Skip YouTube's 10ms filler cues — they are not real speech boundaries.
    if ((c.endSec ?? 0) - c.startSec < 0.05) continue;
    starts.add(c.startSec);
    ends.add(c.endSec);
  }
  return {
    starts: [...starts].sort((a, b) => a - b),
    ends: [...ends].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------------------
// 3. Sentence-ish segmentation
// ---------------------------------------------------------------------------

interface Sentence {
  id: number;
  startSec: number;
  endSec: number;
  text: string;
  wordStart: number;
  wordEnd: number; // exclusive
}

/** Pause long enough to be a sentence break when punctuation is absent. */
const PAUSE_BREAK_SEC = 0.75;
const MAX_SENTENCE_WORDS = 34;
const MIN_SENTENCE_WORDS = 4;

/**
 * Auto-caption cues break at arbitrary points, so we re-segment into
 * sentence-ish units before mining. Punctuation is used when present; when the
 * track has none we fall back to speech pauses and a hard word cap.
 */
export function segmentSentences(words: TimedWord[]): Sentence[] {
  const out: Sentence[] = [];
  let bufStart = 0;

  const flush = (endExclusive: number) => {
    if (endExclusive <= bufStart) return;
    const slice = words.slice(bufStart, endExclusive);
    const text = slice.map((w) => w.text).join(" ").trim();
    if (!text) {
      bufStart = endExclusive;
      return;
    }
    const prev = out[out.length - 1];
    // Merge runt fragments backwards so we never hand the LLM a 2-word "unit".
    if (prev && slice.length < MIN_SENTENCE_WORDS) {
      prev.text = `${prev.text} ${text}`;
      prev.endSec = slice[slice.length - 1].endSec;
      prev.wordEnd = endExclusive;
    } else {
      out.push({
        id: out.length,
        startSec: slice[0].startSec,
        endSec: slice[slice.length - 1].endSec,
        text,
        wordStart: bufStart,
        wordEnd: endExclusive,
      });
    }
    bufStart = endExclusive;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const len = i + 1 - bufStart;
    const terminal = /[.!?]["')\]]?$/.test(w.text);
    const gap = next ? next.startSec - w.endSec : 0;

    if (terminal && len >= MIN_SENTENCE_WORDS) flush(i + 1);
    else if (!terminal && next && gap >= PAUSE_BREAK_SEC && len >= MIN_SENTENCE_WORDS) flush(i + 1);
    else if (len >= MAX_SENTENCE_WORDS) flush(i + 1);
  }
  flush(words.length);

  return out.map((s, i) => ({ ...s, id: i }));
}

// ---------------------------------------------------------------------------
// 4. Chunking
// ---------------------------------------------------------------------------

interface Chunk {
  index: number;
  sentences: Sentence[];
}

function chunkSentences(sentences: Sentence[]): Chunk[] {
  if (!sentences.length) return [];
  const total = sentences[sentences.length - 1].endSec;
  const chunks: Chunk[] = [];
  const stride = CHUNK_SEC - CHUNK_OVERLAP_SEC;

  for (let start = 0, index = 0; start < total; start += stride, index++) {
    const end = start + CHUNK_SEC;
    const slice = sentences.filter((s) => s.startSec >= start && s.startSec < end);
    if (slice.length >= 8) chunks.push({ index, sentences: slice });
    if (end >= total) break;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 5. Scoring
//
// Scoring is data-driven and lives in config/genres.ts: each profile names its
// axes and their weights, and decides which (if any) are near-veto gates.
// `scoreForProfile` is the only entry point — see that file for the model.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. LLM mining
// ---------------------------------------------------------------------------

interface RawMoment {
  startId?: number;
  endId?: number;
  peakId?: number;
  peakLine?: string;
  scores?: Record<string, unknown>;
  rationale?: string;
  suggestedThemes?: string[];
}

/**
 * Assemble the mining prompt from a genre profile.
 *
 * Every genre-varying part — what qualifies, what to reject, how to score, how
 * long a clip should be, what the peak is, which themes exist — is injected. The
 * only fixed text is the explanation of the transcript's format, which is true
 * for every source we ingest.
 */
function buildPrompt(chunk: Chunk, profile: GenreProfile): string {
  const body = chunk.sentences
    .map((s) => `#${s.id} [${s.startSec.toFixed(1)}] ${s.text}`)
    .join("\n");

  const { min, target, max } = profile.clipDuration;
  const peakIsLine = profile.peakKind === "line";

  const bullet = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");
  const axisBlock = profile.scoringAxes
    .map((a) => `- ${a.id}: ${a.description}`)
    .join("\n");
  const scoreShape = profile.scoringAxes.map((a) => `"${a.id}": 8`).join(", ");

  const peakLineRule = peakIsLine
    ? [
        "  - peakLine: copy that sentence VERBATIM from the transcript above, character for character, including its bad punctuation and casing. Do not clean it up, do not paraphrase, do not merge two sentences. If the sentence unit is long and only part of it is the peak, copy the exact contiguous words of the peak, still verbatim.",
        "  - THE PEAK LINE MUST BE FLUENT SPEECH, because it is burned on screen. Reject as peak any sentence carrying stutters, repeated words, false starts or filler — it reads as broken text to the viewer. If the real peak is disfluent, pick the exact contiguous FLUENT fragment that carries the meaning, or choose a different sentence. A clean 8/10 line beats a stuttering 10/10 one, every time.",
      ].join("\n")
    : [
        '  - peakLine: copy the line spoken at that moment VERBATIM if there is a clear one. If the peak is NOT a spoken line — it is an action, a play, a drop, or silence — return the empty string "" and rely on peakId for the timing. Do NOT invent a line, and do NOT move peakId onto a sentence that merely describes the moment.',
        "  - The span must contain the PEAK itself, not merely build toward it. A clip that never reaches the moment is worthless.",
      ].join("\n");

  return `You are the clip editor for a ${profile.label} channel. You are reading a slice of a long transcript and selecting the few spans that would work as standalone ${min}-${max} second vertical clips.

The transcript below is machine-generated from auto-captions: punctuation and casing are unreliable and some words are mis-transcribed. Read through that. Each line is one sentence-ish unit, numbered, with its start time in seconds.

TRANSCRIPT:
${body}

=== WHAT QUALIFIES ===
${profile.qualification.join("\n")}

=== REJECT ===
${bullet(profile.rejects)}

=== REWARD ===
${bullet(profile.rewards)}

=== THE ${peakIsLine ? "PEAK LINE" : "PEAK"} — YOUR MOST IMPORTANT JOB ===
${profile.peakGuidance.join("\n")}
${peakLineRule}

=== SPAN RULES ===
- startId must begin a sentence, endId must end one. The span is inclusive.
- Aim for a span whose total duration is ${min}-${max} seconds, closest to ${target}. Shorter spans have no room to land anything; longer ones lose retention.
- Prefer starting one sentence EARLIER than feels necessary if it resolves an unanswered question, a pronoun, or a missing setup.

=== SCORING (each 0-10, be harsh, use the whole range) ===
${axisBlock}

=== SUGGESTED THEMES ===
Choose 1-3 from exactly this list: ${profile.themes.join(", ")}
${profile.themeGuidance}

Return the ${PER_CHUNK_CANDIDATES} best spans in this slice. If fewer than ${PER_CHUNK_CANDIDATES} genuinely qualify, return only those that do — returning two strong spans is better than four padded ones. If none qualify, return an empty array. Do not lower your bar to fill the quota.

OUTPUT JSON ONLY (no markdown, no commentary):
{
  "moments": [
    {
      "startId": 12,
      "endId": 19,
      "peakId": 18,
      "peakLine": ${peakIsLine ? '"verbatim copy of the peak sentence from the transcript above"' : '"verbatim line at the peak, or \\"\\" if the peak is not spoken"'},
      "scores": { ${scoreShape} },
      "rationale": "one line: what the peak is and why it works",
      "suggestedThemes": [${profile.themes.slice(0, 2).map((t) => `"${t}"`).join(", ")}]
    }
  ]
}`;
}

function extractMoments(text: string): RawMoment[] {
  // Models occasionally wrap in fences, prepend prose, or return a bare array.
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]) as { moments?: RawMoment[] };
      if (Array.isArray(parsed?.moments)) return parsed.moments;
    } catch {
      /* fall through to array form */
    }
  }
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]) as RawMoment[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// 7. Resolution: ids -> real times, verbatim text, precise peak location
// ---------------------------------------------------------------------------

function snapStart(t: number, starts: number[]): number {
  let best = starts.length ? starts[0] : t;
  for (const s of starts) {
    if (s <= t + 0.001) best = s;
    else break;
  }
  // Prefer a beat of lead-in over clipping the first syllable.
  return Math.max(0, best - LEAD_IN_SEC);
}

function snapEnd(t: number, ends: number[]): number {
  for (const e of ends) if (e >= t - 0.001) return e;
  return ends.length ? ends[ends.length - 1] : t;
}

/**
 * Locate a quoted peak line inside the word timeline and return the exact time
 * its FIRST word is spoken, plus the verbatim transcript text it corresponds to.
 *
 * We never trust the model's own timestamp, and we never trust its quote to be
 * character-exact either — models silently normalise punctuation and casing. We
 * match on normalised words within a window around the sentence the model
 * pointed at, then read the VERBATIM span back out of the timeline. That makes
 * "peakLine appears literally in transcript" true by construction.
 */
function locatePeakLine(
  words: TimedWord[],
  quote: string,
  searchFrom: number,
  searchTo: number
): { line: string; sec: number } | null {
  const q = quote
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(normWord)
    .filter(Boolean);
  if (q.length < 3) return null;

  const lo = Math.max(0, searchFrom);
  const hi = Math.min(words.length, searchTo);

  const at = (i: number) => normWord(words[i].text);

  // Exact word-sequence match first.
  for (let i = lo; i + q.length <= hi; i++) {
    let ok = true;
    for (let j = 0; j < q.length; j++) {
      if (at(i + j) !== q[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return {
        line: words.slice(i, i + q.length).map((w) => w.text).join(" "),
        sec: words[i].startSec,
      };
    }
  }

  // Fuzzy fallback: best-overlap window of the same length. The bar is
  // deliberately high (75% of words, AND the first word must match exactly). A
  // loose fuzzy match is worse than no match: it returns a confident-looking
  // timestamp pointing at the wrong sentence.
  let bestScore = 0;
  let bestAt = -1;
  for (let i = lo; i + q.length <= hi; i++) {
    if (at(i) !== q[0]) continue; // first word must anchor
    let hits = 0;
    for (let j = 0; j < q.length; j++) if (at(i + j) === q[j]) hits++;
    if (hits > bestScore) {
      bestScore = hits;
      bestAt = i;
    }
  }
  if (bestAt >= 0 && bestScore / q.length >= 0.75) {
    return {
      line: words.slice(bestAt, bestAt + q.length).map((w) => w.text).join(" "),
      sec: words[bestAt].startSec,
    };
  }
  return null;
}

/**
 * Keep only themes the profile actually offers, so a model that invents a theme
 * can't write an arbitrary value into the clip. Falls back to the profile's
 * first theme rather than a genre-specific constant.
 */
function sanitizeThemes(input: unknown, allowed: string[]): string[] {
  const allowedSet = new Set(allowed);
  const list = Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const raw of list) {
    const key = String(raw).toLowerCase().trim().replace(/[\s-]+/g, "_");
    if (allowedSet.has(key) && !out.includes(key)) out.push(key);
    if (out.length === 3) break;
  }
  return out.length ? out : allowed.slice(0, 1);
}

function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(10, Math.round(v * 10) / 10));
}

interface ResolveDeps {
  words: TimedWord[];
  sentences: Sentence[];
  boundaries: { starts: number[]; ends: number[] };
  profile: GenreProfile;
}

function resolveCandidate(raw: RawMoment, deps: ResolveDeps): MomentCandidate | null {
  const { words, sentences, boundaries, profile } = deps;
  // Clip length is a genre property: a football play wants ~20s, an advice clip
  // wants ~32s. Everything here reads the profile rather than a constant.
  const MIN_CLIP_SEC = profile.clipDuration.min;
  const MAX_CLIP_SEC = profile.clipDuration.max;

  const byId = (id: unknown): Sentence | undefined =>
    typeof id === "number" ? sentences[Math.round(id)] : undefined;

  let first = byId(raw.startId);
  let last = byId(raw.endId);
  if (!first || !last) return null;
  if (first.id > last.id) [first, last] = [last, first];

  // --- fit the span to the profile's duration band, by whole sentences ---
  const peakSentence = byId(raw.peakId) ?? last;
  let lo = first.id;
  let hi = last.id;
  const dur = () => sentences[hi].endSec - sentences[lo].startSec;

  // Too short: grow, preferring to grow forward (keeps the cold open intact),
  // then backward. Never grow past the max.
  let guard = 0;
  while (dur() < MIN_CLIP_SEC && guard++ < 60) {
    const canFwd = hi + 1 < sentences.length;
    const canBack = lo > 0;
    if (!canFwd && !canBack) break;
    if (canFwd && sentences[hi + 1].endSec - sentences[lo].startSec <= MAX_CLIP_SEC) hi++;
    else if (canBack && sentences[hi].endSec - sentences[lo - 1].startSec <= MAX_CLIP_SEC) lo--;
    else break;
  }
  // Too long: trim from the front first — the peak lives near the end, and the
  // front is where the LLM tends to over-include setup.
  guard = 0;
  while (dur() > MAX_CLIP_SEC && guard++ < 60) {
    const peakId = Math.min(Math.max(peakSentence.id, lo), hi);
    if (lo < peakId && lo < hi) lo++;
    else if (hi > peakId && hi > lo) hi--;
    else break;
  }
  if (dur() < MIN_CLIP_SEC * 0.6) return null;
  if (dur() > MAX_CLIP_SEC + 5) return null;

  // --- peak-position guard ---
  const rawPeakLine = typeof raw.peakLine === "string" ? raw.peakLine.trim() : "";
  const preLocated = rawPeakLine
    ? locatePeakLine(words, rawPeakLine, sentences[lo].wordStart, sentences[hi].wordEnd)
    : null;
  const peakAt = preLocated?.sec ?? peakSentence.startSec;
  guard = 0;
  while (
    lo > 0 &&
    guard++ < 60 &&
    (peakAt - sentences[lo].startSec) / dur() < MIN_PEAK_POSITION &&
    sentences[hi].endSec - sentences[lo - 1].startSec <= MAX_CLIP_SEC
  ) {
    lo--;
  }
  if ((peakAt - sentences[lo].startSec) / dur() < MIN_PEAK_POSITION * 0.5) return null;

  const spanSentences = sentences.slice(lo, hi + 1);
  const wordStart = spanSentences[0].wordStart;
  const wordEnd = spanSentences[spanSentences.length - 1].wordEnd;

  const startSec = snapStart(spanSentences[0].startSec, boundaries.starts);
  const endSec = snapEnd(spanSentences[spanSentences.length - 1].endSec, boundaries.ends);
  if (!(endSec > startSec)) return null;

  // Transcript is read verbatim out of the word timeline, NOT reassembled from
  // the model's output — so it is always exactly what was said.
  const transcript = words.slice(wordStart, wordEnd).map((w) => w.text).join(" ").trim();
  const minWords = Math.max(8, Math.round(MIN_CLIP_SEC * 0.5));
  if (transcript.split(" ").length < minWords) return null;

  // --- resolve the peak ---
  // peakLine is only ever set to text read back OUT of the word timeline, so
  // "peakLine appears verbatim in transcript" holds by construction.
  const peakSentenceClamped = sentences[Math.min(Math.max(peakSentence.id, lo), hi)];
  const pointedSentenceText = words
    .slice(peakSentenceClamped.wordStart, peakSentenceClamped.wordEnd)
    .map((w) => w.text)
    .join(" ")
    .trim();

  const located = rawPeakLine
    ? locatePeakLine(words, rawPeakLine, wordStart, wordEnd)
    : null;

  let peakSec = peakSentenceClamped.startSec;
  let peakLine: string | undefined;

  if (located) {
    peakSec = located.sec;
    peakLine = located.line;
  } else if (profile.peakKind === "line") {
    // For a line-peak genre the line IS the product, so fall back to the verbatim
    // sentence the model pointed at rather than discarding an otherwise good span.
    peakLine = pointedSentenceText;
  }
  // Otherwise: a moment peak with no usable line. This is the intended
  // sports/music case — the peak is a play or a drop, and peakSec is the product.

  if (peakSec < startSec || peakSec > endSec) return null;
  if (peakLine && !transcript.includes(peakLine)) {
    // Never persist a line that isn't literally in the transcript.
    if (profile.peakKind === "line") return null;
    peakLine = undefined;
  }

  // Only the profile's axes are collected, so the score map shape always matches
  // the genre that produced it.
  const scores: ScoreMap = {};
  for (const axis of profile.scoringAxes) {
    scores[axis.id] = clampScore(raw.scores?.[axis.id]);
  }

  return {
    id: `mm-${Math.round(startSec * 1000)}-${Math.round(endSec * 1000)}`,
    startSec: Math.round(startSec * 1000) / 1000,
    endSec: Math.round(endSec * 1000) / 1000,
    transcript,
    peakSec: Math.round(peakSec * 1000) / 1000,
    peakKind: profile.peakKind,
    peakLine: peakLine || undefined,
    scores,
    // Recomputed locally — the model is asked for the axes only, never for the
    // ranking key, so ranking stays consistent across chunks and models.
    totalScore: scoreForProfile(profile, scores, peakLine),
    rationale: String(raw.rationale ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    suggestedThemes: sanitizeThemes(raw.suggestedThemes, profile.themes),
  };
}

// ---------------------------------------------------------------------------
// 8. Cross-chunk merge
// ---------------------------------------------------------------------------

function overlapFraction(a: MomentCandidate, b: MomentCandidate): number {
  const inter = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  if (inter <= 0) return 0;
  return inter / Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
}

/**
 * Adjacent chunks overlap by design, so the same moment is usually mined twice.
 * Keep the higher-scoring version — typically the chunk where the moment sat
 * mid-window with full surrounding context rather than at a ragged edge.
 */
export function dedupeCandidates(list: MomentCandidate[]): MomentCandidate[] {
  const sorted = [...list].sort((a, b) => b.totalScore - a.totalScore);
  const kept: MomentCandidate[] = [];
  for (const c of sorted) {
    if (kept.some((k) => overlapFraction(c, k) > DEDUPE_OVERLAP)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => b.totalScore - a.totalScore);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MineMomentsInput {
  captions: CaptionCue[];
  /** The genre whose editorial rules drive this run. Defaults to motivation. */
  genreId?: string;
  /** How many candidates to return after global re-ranking. Default 12. */
  targetCount?: number;
  tier?: Tier;
  /** Called after each chunk finishes, for live progress. */
  onProgress?: (done: number, total: number) => void;
}

export interface MineMomentsResult {
  candidates: MomentCandidate[];
  chunks: number;
  words: number;
  sentences: number;
  /** The resolved genre id, echoed back so callers can persist what ran. */
  genreId: string;
  /** Wall-clock milliseconds for the whole mining pass. */
  elapsedMs: number;
}

/** Mine a full transcript for standalone short-form candidates, ranked best-first. */
export async function mineMoments(input: MineMomentsInput): Promise<MineMomentsResult> {
  const { captions, targetCount = 12, tier, onProgress } = input;
  const profile = resolveGenreProfile(input.genreId);
  const startedAt = Date.now();
  const empty = (chunks = 0, words = 0, sentences = 0): MineMomentsResult => ({
    candidates: [],
    chunks,
    words,
    sentences,
    genreId: profile.id,
    elapsedMs: Date.now() - startedAt,
  });

  if (!captions?.length) return empty();

  const words = buildWordTimeline(captions);
  const sentences = segmentSentences(words);
  const boundaries = cueBoundaries(captions);
  if (sentences.length < 8) {
    console.warn("⚠️  Mining: transcript too short to mine");
    return empty(0, words.length, sentences.length);
  }

  const chunks = chunkSentences(sentences);
  const llm = resolveModels(tier).llm;
  const durationMin = (sentences[sentences.length - 1].endSec / 60).toFixed(1);
  console.log(
    `⛏️  Mining ${durationMin} min transcript as "${profile.id}" — ${words.length} words, ` +
      `${sentences.length} units, ${chunks.length} chunks via ${llm}`
  );

  const deps: ResolveDeps = { words, sentences, boundaries, profile };
  const collected: MomentCandidate[] = [];
  let done = 0;
  onProgress?.(0, chunks.length);

  const runChunk = async (chunk: Chunk): Promise<void> => {
    try {
      const { text, usage } = await generateText({
        model: openrouter(llm),
        prompt: buildPrompt(chunk, profile),
        temperature: 0.4, // selection task — we want judgement, not invention
        // Bound the response: some models otherwise ramble instead of returning
        // the small JSON object the prompt asks for.
        maxOutputTokens: config.llmMaxOutputTokens,
      });
      if (usage) {
        // Token field names moved across AI SDK majors; read defensively.
        const u = usage as unknown as { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
        const input = u.inputTokens ?? u.promptTokens ?? 0;
        const output = u.outputTokens ?? u.completionTokens ?? 0;
        console.log(`   · chunk ${chunk.index + 1}: ${input} in / ${output} out`);
      }

      const raws = extractMoments(text);
      if (!raws.length) {
        console.warn(`⚠️  Chunk ${chunk.index + 1}: no parsable moments returned`);
      }
      for (const raw of raws) {
        const resolved = resolveCandidate(raw, deps);
        if (resolved) collected.push(resolved);
      }
    } catch (error: unknown) {
      // One bad chunk must not lose an entire episode's mining run.
      console.warn(`⚠️  Chunk ${chunk.index + 1} mining failed: ${getErrorMessage(error)}`);
    } finally {
      done++;
      onProgress?.(done, chunks.length);
    }
  };

  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + CHUNK_CONCURRENCY).map(runChunk));
  }

  const ranked = dedupeCandidates(collected).filter((c) => c.totalScore >= MIN_TOTAL_SCORE);
  console.log(
    `⛏️  Mined ${collected.length} raw → ${ranked.length} ranked "${profile.id}" candidates ` +
      `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
  );

  return {
    candidates: ranked.slice(0, targetCount),
    chunks: chunks.length,
    words: words.length,
    sentences: sentences.length,
    genreId: profile.id,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Exported for the validation script — not part of the public mining flow. */
export const __internals = {
  buildWordTimeline,
  segmentSentences,
  cueBoundaries,
  chunkSentences,
  CHUNK_SEC,
  CHUNK_OVERLAP_SEC,
  MIN_PEAK_POSITION,
  CHUNK_CONCURRENCY,
  PER_CHUNK_CANDIDATES,
};
