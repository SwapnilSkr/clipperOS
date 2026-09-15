import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { senseModel } from "../config/models";
import { Clip, ClipProject } from "../models";
import type { AssetSense, ClipSense, MediaAsset, RenderReview } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { ensureDir, fileExists } from "../utils";
import { runCommand } from "../utils/process.utils";
import { ensureProjectMedia } from "./ingest.service";
import { listMediaAssets, resolveMediaFile, updateMediaSense } from "./media-library.service";
import { audioPart, chat, fileDataUrl, jsonIn, type ChatPart } from "./openrouter.service";
import { listBuiltinAudio, listCustomAudio, resolveAssetPath, updateAudioSense, type AudioAsset } from "./soundtrack.service";
import { describeCurrentPlan } from "./director.service";

// ============================================
// SENSE — what the harness sees and hears.
//
// The Director used to work from words alone. This gives it the picture:
//
//   senseClip     the clip window as a small proxy video (with its audio)
//                 goes to a video-input model, which returns the shots, the
//                 visible beats worth cutting on, B-roll it would earn, how
//                 it sounds, and its own read of the hook and payoff. Cached
//                 on the clip, keyed to the trim.
//   senseAudio    every music bed and sound effect — built-in, uploaded or
//                 generated — described once from its actual sound, so the
//                 Director chooses "the sinister industrial drone" rather
//                 than "Drive". Cached in the asset's sidecar.
//   senseMedia    the same for stills and videos in the library.
//   reviewRender  the RENDERED clip, watched next to the plan that made it:
//                 an editor's score, what hurt, what to keep. Feeds the
//                 taste memory.
//
// Proxies are 360p, 8 fps, mono 48k AAC — a 45 s clip is ~1 MB and ~3.5k
// tokens on Gemini 3.8 Flash (about half a cent).
// ============================================

const PROXY_HEIGHT = 360;
const PROXY_FPS = 8;
/** Longest proxy the harness will watch in one go. */
export const MAX_PROXY_SEC = 180;

function proxyDir(): string {
  return join(config.processingPath, "sense");
}

function keyOf(...parts: (string | number)[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** A small proxy of `[startSec, endSec]` of a video, cached by its inputs. */
export async function proxyClip(sourcePath: string, startSec: number, endSec: number): Promise<string> {
  const dir = proxyDir();
  await ensureDir(dir);
  const source = await stat(sourcePath);
  const path = join(dir, `${keyOf(sourcePath, source.size, source.mtimeMs, startSec.toFixed(2), endSec.toFixed(2))}.mp4`);
  if (await fileExists(path)) return path;
  const duration = Math.min(MAX_PROXY_SEC, Math.max(0.5, endSec - startSec));
  const tmp = `${path}.part.mp4`;
  await runCommand(
    config.ffmpegPath,
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", startSec.toFixed(3), "-t", duration.toFixed(3), "-i", sourcePath,
      "-vf", `scale=-2:${PROXY_HEIGHT},fps=${PROXY_FPS}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-ac", "1", "-c:a", "aac", "-b:a", "48k",
      "-movflags", "+faststart",
      tmp,
    ],
    { label: "sense proxy" }
  );
  await rm(path, { force: true }).catch(() => undefined);
  await runCommand("mv", [tmp, path], { label: "sense proxy" });
  return path;
}

async function videoPart(path: string): Promise<ChatPart> {
  return { type: "video_url", video_url: { url: await fileDataUrl(path, "video/mp4") } };
}

const CLIP_SENSE_PROMPT = `You are the eyes of a short-form video editor. Watch this clip (it is the exact window that will be published as a vertical Short) and report what the transcript cannot: what is SEEN and how it SOUNDS. Times are seconds from the start of this video. Be specific and concrete; an editor will cut on what you say.

Return ONLY JSON:
{
  "overall": "2–3 sentences: setting, lighting, framing, colour palette, who is on screen, their energy and how the delivery lands",
  "shots": [{ "start": 0, "end": 12.4, "framing": "medium close-up, speaker left of centre, off-camera host right", "note": "what changes in this shot", "energy": 3 }],
  "moments": [{ "t": 4.2, "what": "leans in and points at the camera", "use": "punch in here" }],
  "broll": [{ "t": 9.8, "idea": "what to cut away to and why it earns its place", "query": "2–4 concrete visual nouns for a stock search" }],
  "audio": "room, noise floor, music already present, pace and pauses, laughter, anything the mix must respect",
  "hook": "what visually or verbally grabs in the first 2 seconds, or what is missing",
  "payoff": "where the clip lands its point and how the speaker sells it"
}
Rules: 3–10 shots (a shot ends where the camera cuts or the framing clearly changes); 4–12 moments, each on a visible action, reaction, prop, gesture, look, on-screen text or a beat of silence; 0–4 broll ideas, only where a picture would say more than the face — never over the payoff. "energy" is 1–5.`;

export function parseClipSense(text: string, model: string, window: { startSec: number; endSec: number }): ClipSense | null {
  const raw = jsonIn<Record<string, unknown>>(text);
  if (!raw) return null;
  const n = (value: unknown, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const s = (value: unknown, max = 600) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []);
  const span = Math.round((window.endSec - window.startSec) * 1000) / 1000;
  const inside = (t: number) => Math.round(Math.max(0, Math.min(span, t)) * 1000) / 1000;
  return {
    for: { startSec: window.startSec, endSec: window.endSec },
    model,
    at: new Date().toISOString(),
    overall: s(raw.overall, 900),
    shots: list(raw.shots)
      .slice(0, 12)
      .map((shot) => ({
        start: inside(n(shot.start)),
        end: inside(n(shot.end)),
        framing: s(shot.framing, 200),
        note: s(shot.note, 300),
        energy: Math.max(1, Math.min(5, Math.round(n(shot.energy, 3)))),
      }))
      .filter((shot) => shot.end > shot.start),
    moments: list(raw.moments)
      .slice(0, 16)
      .map((moment) => ({ t: inside(n(moment.t)), what: s(moment.what, 200), use: s(moment.use, 200) }))
      .filter((moment) => moment.what),
    broll: list(raw.broll)
      .slice(0, 6)
      .map((idea) => ({ t: inside(n(idea.t)), idea: s(idea.idea, 300), query: s(idea.query, 80) }))
      .filter((idea) => idea.query),
    audio: s(raw.audio, 600),
    hook: s(raw.hook, 400),
    payoff: s(raw.payoff, 400),
  };
}

/** The clip window's sense, cached on the clip until the trim changes. */
export async function senseClip(clipId: string, options: { force?: boolean } = {}): Promise<ClipSense> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");
  const startSec = clip.edit?.trimStartSec ?? clip.startSec;
  const endSec = clip.edit?.trimEndSec ?? clip.endSec;
  const cached = clip.sense;
  if (
    !options.force &&
    cached &&
    Math.abs(cached.for.startSec - startSec) < 0.05 &&
    Math.abs(cached.for.endSec - endSec) < 0.05
  ) {
    return cached;
  }
  const sourcePath = await ensureProjectMedia(String(clip.projectId));
  const proxy = await proxyClip(sourcePath, startSec, endSec);
  const model = senseModel();
  const startedAt = Date.now();
  const result = await chat({
    model,
    parts: [{ type: "text", text: CLIP_SENSE_PROMPT }, await videoPart(proxy)],
    reasoning: "low",
    maxTokens: 6000,
    temperature: 0.3,
    label: "sense clip",
  });
  const sense = parseClipSense(result.text, model, { startSec, endSec });
  if (!sense) throw new Error("The harness could not describe the clip (no JSON in the answer)");
  await Clip.updateOne({ _id: clipId }, { $set: { sense } });
  console.log(
    `👁  Sensed clip ${clip.rank} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${model}, ${result.usage.videoTokens ?? 0} video + ${result.usage.audioTokens ?? 0} audio tokens${result.usage.cost != null ? `, $${result.usage.cost.toFixed(4)}` : ""}): ${sense.shots.length} shots, ${sense.moments.length} moments, ${sense.broll.length} b-roll ideas`
  );
  return sense;
}

const AUDIO_SENSE_PROMPT = `You are a music supervisor cataloguing a sound for a short-form video editor. Listen and describe it so the editor can pick it without hearing it, and judge whether it is clean enough to publish. Return ONLY JSON:
{ "line": "one line: what it is, genre/character, instrumentation, mood", "tags": ["3–8 tags: mood, genre, texture, 'loopable', 'vocals', 'one-shot', 'riser', 'impact'"], "bpm": 90, "energy": 3, "suits": ["2–4 uses in a vertical clip: 'under a calm story', 'a cold open', 'a punch-in hit'"], "quality": 4, "flaws": ["only real problems: 'hiss or noise floor', 'clipping', 'roomy or distant', 'clicks or handling noise', 'long silence before the sound', 'low bitrate artifacts', 'several sounds not one'"] }
"energy" is 1–5. "quality" is 1–5 as a recording: 5 is a library-grade sound, 3 is usable in a mix, 1–2 would be heard as bad on a phone. For a sound effect, bpm is 0 and "line" says what the hit does (a whoosh, a sub boom, a UI tick).`;

const MEDIA_SENSE_PROMPT = `You are cataloguing a picture for a short-form video editor's B-roll library, and judging whether it would hold up full-screen on a phone for two seconds. Describe it so the editor can pick it by content without seeing it, then judge it hard: a picture that would make the video look cheap must be flagged. Return ONLY JSON:
{ "line": "one line: subject, action or composition, lighting, colour, camera move if any", "tags": ["3–8 tags: subject, setting, mood, colours, 'portrait', 'slow motion', 'text on screen'"], "energy": 2, "suits": ["2–4 uses: 'a reveal', 'a cutaway on the word city', 'a calm intro'"], "quality": 4, "flaws": ["only real problems: 'text or lettering', 'watermark or logo', 'AI artifacts', 'distorted hands or faces', 'subject cut off', 'blurry', 'flat lighting', 'looks like clip art'"] }
"energy" is 1–5 (how much motion or intensity). "quality" is 1–5, judged as a viewer on a phone would at a glance: 5 could pass for a shot from a film; 4 is polished; 3 is fine for two seconds; 2 has something a viewer would notice; 1 is embarrassing. Generated and stylised pictures are welcome — do NOT mark a picture down for being fantastical, illustrated on purpose, or obviously not a photo. Mark it down only for what a viewer would notice: lettering or captions baked in, a watermark or logo, warped anatomy or objects, smeared or duplicated details, a subject cut off by the frame, blur where there should be focus, a flat clip-art look. Any lettering or watermark caps quality at 2.`;

export function parseAssetSense(text: string, model: string): AssetSense | null {
  const raw = jsonIn<Record<string, unknown>>(text);
  if (!raw || typeof raw.line !== "string") return null;
  const strings = (value: unknown, max: number) =>
    Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 40)).filter(Boolean).slice(0, max) : [];
  const bpm = Number(raw.bpm);
  const energy = Number(raw.energy);
  const quality = Number(raw.quality);
  const flaws = strings(raw.flaws, 6);
  return {
    line: raw.line.trim().slice(0, 240),
    tags: strings(raw.tags, 8),
    ...(Number.isFinite(bpm) && bpm > 0 ? { bpm: Math.round(bpm) } : {}),
    ...(Number.isFinite(energy) ? { energy: Math.max(1, Math.min(5, Math.round(energy))) } : {}),
    suits: strings(raw.suits, 4),
    ...(Number.isFinite(quality) ? { quality: Math.max(1, Math.min(5, Math.round(quality))) } : {}),
    ...(flaws.length ? { flaws } : {}),
    model,
    at: new Date().toISOString(),
  };
}

/** Describe one sound from its audio; cached in its sidecar. */
export async function senseAudio(asset: AudioAsset, options: { force?: boolean } = {}): Promise<AssetSense | undefined> {
  if (asset.sense && !options.force) return asset.sense;
  const path = await resolveAssetPath("none", asset.id);
  if (!path) return undefined;
  const model = senseModel();
  const result = await chat({
    model,
    parts: [{ type: "text", text: `${AUDIO_SENSE_PROMPT}\nThe file is labelled "${asset.label}" (${asset.kind}, ${asset.durationSec.toFixed(1)} s).` }, await audioPart(path, "m4a")],
    reasoning: "low",
    // Gemini's reasoning counts against the cap: room for it and the JSON.
    maxTokens: 2500,
    temperature: 0.2,
    label: "sense audio",
  });
  const sense = parseAssetSense(result.text, model);
  if (!sense) {
    console.warn(`Could not read a description for sound ${asset.id}: ${result.text.slice(-200).replace(/\s+/g, " ")}`);
    return undefined;
  }
  await updateAudioSense(asset.id, sense);
  return sense;
}

/** Describe one still or video from its pixels; cached in its sidecar. */
export async function senseMedia(asset: MediaAsset, options: { force?: boolean } = {}): Promise<AssetSense | undefined> {
  if (asset.sense && !options.force) return asset.sense;
  const file = await resolveMediaFile(asset.id);
  if (!file) return undefined;
  const model = senseModel();
  const part: ChatPart =
    asset.kind === "image"
      ? { type: "image_url", image_url: { url: await fileDataUrl(file.path, "image/jpeg") } }
      : await videoPart(await proxyClip(file.path, 0, Math.min(asset.durationSec ?? 10, 20)));
  const result = await chat({
    model,
    parts: [{ type: "text", text: `${MEDIA_SENSE_PROMPT}\nThe file is labelled "${asset.label}" (${asset.kind}${asset.durationSec ? `, ${asset.durationSec.toFixed(1)} s` : ""}).` }, part],
    reasoning: "low",
    // Gemini's reasoning counts against the cap: room for it and the JSON.
    maxTokens: 2500,
    temperature: 0.2,
    label: "sense media",
  });
  const sense = parseAssetSense(result.text, model);
  if (!sense) {
    console.warn(`Could not read a description for media ${asset.id}: ${result.text.slice(-200).replace(/\s+/g, " ")}`);
    return undefined;
  }
  await updateMediaSense(asset.id, sense);
  return sense;
}

/**
 * The whole library described, filling in what is missing — up to `budget`
 * new descriptions per call so a first pass on a big library does not stall
 * a Director run; the rest are picked up next time.
 */
export async function senseLibrary(budget = 12): Promise<{ audio: AudioAsset[]; media: MediaAsset[]; described: number; failed: number }> {
  const [builtin, custom, media] = await Promise.all([listBuiltinAudio(), listCustomAudio().catch(() => []), listMediaAssets().catch(() => [])]);
  const audio = [...builtin, ...custom];
  let described = 0;
  let failed = 0;
  const jobs: (() => Promise<void>)[] = [];
  for (const asset of audio) {
    if (asset.sense) continue;
    jobs.push(async () => {
      const sense = await senseAudio(asset).catch((error: unknown) => {
        console.warn(`Could not describe sound ${asset.id}: ${getErrorMessage(error)}`);
        failed++;
        return undefined;
      });
      if (sense) {
        asset.sense = sense;
        described++;
      }
    });
  }
  for (const asset of media) {
    if (asset.sense) continue;
    jobs.push(async () => {
      const sense = await senseMedia(asset).catch((error: unknown) => {
        console.warn(`Could not describe media ${asset.id}: ${getErrorMessage(error)}`);
        failed++;
        return undefined;
      });
      if (sense) {
        asset.sense = sense;
        described++;
      }
    });
  }
  // A few at a time: each is one multimodal call.
  const queue = jobs.slice(0, budget);
  const width = 4;
  for (let i = 0; i < queue.length; i += width) await Promise.all(queue.slice(i, i + width).map((job) => job()));
  return { audio, media, described, failed };
}

const REVIEW_PROMPT = `You are a senior short-form editor reviewing a finished vertical clip before it is published. Watch it as a viewer would on a phone: does the first 2 seconds hook, do the captions read, do the camera moves land on the lines that matter, do the sound effects and music serve the voice or fight it, does any cutaway feel pasted on, does the pacing sag, is the payoff sold? Times are seconds from the start of this video.

Return ONLY JSON:
{ "score": 7, "verdict": "2–3 sentences, an editor's honest read", "issues": [{ "t": 3.4, "what": "what hurts", "fix": "the concrete change" }], "keep": ["what works and must stay"] }
"score" is 1–10. 0–6 issues, most damaging first; 1–4 keeps.`;

export function parseRenderReview(text: string, model: string, revision: number): RenderReview | null {
  const raw = jsonIn<Record<string, unknown>>(text);
  if (!raw) return null;
  const s = (value: unknown, max = 400) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const score = Number(raw.score);
  return {
    revision,
    model,
    at: new Date().toISOString(),
    score: Number.isFinite(score) ? Math.max(1, Math.min(10, Math.round(score))) : 5,
    verdict: s(raw.verdict, 600),
    issues: (Array.isArray(raw.issues) ? (raw.issues as Record<string, unknown>[]) : [])
      .slice(0, 6)
      .map((issue) => ({
        ...(Number.isFinite(Number(issue.t)) ? { t: Math.max(0, Number(issue.t)) } : {}),
        what: s(issue.what, 240),
        fix: s(issue.fix, 240),
      }))
      .filter((issue) => issue.what),
    keep: (Array.isArray(raw.keep) ? (raw.keep as unknown[]) : []).filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 240)).slice(0, 4),
  };
}

/** Watch the rendered clip next to its plan; the review is stored on the clip. */
export async function reviewRender(clipId: string, renderedPath: string, options: { proxied?: boolean } = {}): Promise<RenderReview> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");
  const project = await ClipProject.findById(clip.projectId).select("title genreId").lean();
  const trimStart = clip.edit?.trimStartSec ?? clip.startSec;
  const plan = describeCurrentPlan(clip.edit?.creator, clip.edit?.soundtrack?.sfx, trimStart, new Map(), clip.edit?.soundtrack?.beds ?? []);
  const proxy = options.proxied ? renderedPath : await proxyClip(renderedPath, 0, MAX_PROXY_SEC);
  const model = senseModel();
  const notes = clip.edit?.creator?.director?.summary;
  const result = await chat({
    model,
    parts: [
      {
        type: "text",
        text: `${REVIEW_PROMPT}\n\nProject: "${project?.title ?? ""}". The peak line is "${clip.peakLine ?? ""}".${notes ? `\nThe Director's intent for this cut: ${notes}` : ""}${plan ? `\nThe plan that made it (clip-relative source seconds; the video's clock may run faster where dead air was cut):\n${plan.slice(0, 3000)}` : ""}`,
      },
      await videoPart(proxy),
    ],
    reasoning: "low",
    maxTokens: 3000,
    temperature: 0.3,
    label: "review render",
  });
  const review = parseRenderReview(result.text, model, clip.renderRevision ?? 0);
  if (!review) throw new Error("The harness could not review the render (no JSON in the answer)");
  await Clip.updateOne({ _id: clipId }, { $set: { review } });
  console.log(`🎞  Reviewed render of clip ${clip.rank}: ${review.score}/10 — ${review.verdict.slice(0, 120)}`);
  return review;
}

/** Drop cached proxies older than a day. */
export async function sweepSenseProxies(): Promise<number> {
  const dir = proxyDir();
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  const names = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 24 * 3600 * 1000) {
      await rm(path, { force: true }).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}
