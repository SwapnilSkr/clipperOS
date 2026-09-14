import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { directorModel } from "../config/models";
import { resolveGenreProfile } from "../config/genres";
import { listCaptionStyles } from "../config/caption-styles";
import { listCaptionFonts } from "../config/caption-fonts";
import { Clip, ClipProject, type IClip } from "../models";
import type {
  BehindTitle,
  CameraMove,
  CaptionScene,
  CreatorPlan,
  PauseCut,
  ReframeTrack,
  SoundtrackHit,
  VttWordTiming,
} from "../types/clip.types";
import {
  MAX_CAMERA_MOVES,
  MAX_CAMERA_ZOOM,
  MAX_CAPTION_SCENES,
  MAX_FOLLOW_ZOOM,
  MAX_TITLES,
} from "../types/clip.types";
import { getErrorMessage } from "../types";
import { buildWordTimeline } from "./mining.service";
import { expandWordTimings } from "./transcript.service";
import { detectClipPauses, type PauseCandidate } from "./pause-detect.service";
import { faceAnchorAt, headTravel, sourceToOutput, windowsFor } from "./creator-timeline";
import { sanitizeCreatorPlan } from "./creator-plan.service";
import { listBuiltinAudio, listCustomAudio, MAX_SOUNDTRACK_HITS } from "./soundtrack.service";
import { updateClipEdit } from "./clip.service";

// ============================================
// THE DIRECTOR — one call that writes the whole beat plan.
//
// Given what the pipeline already knows about a clip — every word and when it
// is spoken, the mined peak, the shot changes, where the speaker's face sits,
// the dead air, and what looks and sounds exist — the model returns a plan in
// CLIP-RELATIVE seconds. Everything it says is then snapped to real word
// onsets, clamped to the trim, sanitised like any other edit, and saved
// through the same path the editor uses. A failed or malformed answer leaves
// the stored plan untouched.
//
// On demand only. Notes and `keep` lanes make a second pass an iteration on
// the first rather than a reshuffle.
// ============================================

export type DirectorLane = "cuts" | "camera" | "captions" | "titles" | "sfx";

export interface DirectInput {
  notes?: string;
  keep?: DirectorLane[];
}

export interface DirectResult {
  clip: IClip;
  summary: string;
  model: string;
}

/** Cap on the word grid handed to the model; a 60 s clip is ~180 words. */
const MAX_WORDS = 420;
/** A beat is snapped onto a spoken onset this close to it. */
const SNAP_SEC = 0.18;

interface DirectorPlanJson {
  summary?: unknown;
  cuts?: unknown;
  camera?: unknown;
  captionScenes?: unknown;
  titles?: unknown;
  sfx?: unknown;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function extractJson(text: string): DirectorPlanJson | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as DirectorPlanJson;
  } catch {
    return null;
  }
}

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function newId(prefix: string, index: number): string {
  return `dir_${prefix}${index + 1}_${Date.now().toString(36)}`;
}

/** Word onsets inside the window, clip-relative. */
function wordsFor(project: { wordTimings?: VttWordTiming[]; captions?: { startSec: number; endSec: number; text: string }[] }, startSec: number, endSec: number) {
  const all = expandWordTimings(
    project.wordTimings?.length
      ? project.wordTimings
      : buildWordTimeline(project.captions ?? []).map((w) => ({ t: w.startSec, word: w.text }))
  );
  return all.filter((word) => word.t >= startSec - 0.05 && word.t <= endSec).map((word) => ({ t: round3(word.t - startSec), word: word.word }));
}

/**
 * A model's caption overrides, coerced to what the sanitiser accepts. Anything
 * it cannot make sense of is dropped rather than failing the whole plan.
 */
export function lenientOverrides(raw: unknown): CaptionScene["overrides"] {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const out: NonNullable<CaptionScene["overrides"]> = {};
  const hex = (value: unknown) => (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : undefined);
  const chunk = num(source.chunkWords);
  if (chunk != null) out.chunkWords = Math.max(1, Math.min(8, Math.round(chunk)));
  const size = num(source.sizeScale);
  if (size != null) out.sizeScale = Math.max(0.5, Math.min(2.4, size));
  const vertical = num(source.verticalFrac);
  if (vertical != null) out.verticalFrac = Math.max(0.05, Math.min(0.8, vertical));
  const horizontal = num(source.horizontalFrac);
  if (horizontal != null) out.horizontalFrac = Math.max(0.05, Math.min(0.95, horizontal));
  const text = hex(source.textColor);
  if (text) out.textColor = text;
  const peak = hex(source.peakColor);
  if (peak) out.peakColor = peak;
  if (source.background === "box" || source.background === "none") out.background = source.background;
  if (source.animation === "pop" || source.animation === "fade" || source.animation === "none") out.animation = source.animation;
  if (typeof source.fontFamily === "string" && source.fontFamily.trim()) out.fontFamily = source.fontFamily.trim();
  if (source.uppercase !== undefined) out.uppercase = Boolean(source.uppercase);
  if (source.peakEmphasis !== undefined) out.peakEmphasis = Boolean(source.peakEmphasis);
  const highlight = source.highlight;
  if (highlight === "word" || highlight === true || highlight === "karaoke" || highlight === "words") out.highlight = "word";
  else if (highlight === "none" || highlight === false) out.highlight = "none";
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Nearest spoken onset within SNAP_SEC, else the time itself. */
function snapToWord(t: number, onsets: number[]): number {
  let best = t;
  let bestDelta = SNAP_SEC;
  for (const onset of onsets) {
    const delta = Math.abs(onset - t);
    if (delta < bestDelta) {
      best = onset;
      bestDelta = delta;
    }
  }
  return best;
}

/** The stored plan, described in clip-relative seconds so the model can iterate on it. */
export function describeCurrentPlan(plan: CreatorPlan | undefined, sfx: SoundtrackHit[] | undefined, trimStart: number): string {
  if (!plan) return "";
  const rel = (t: number) => (t - trimStart).toFixed(2);
  const lines: string[] = [];
  const cuts = (plan.cuts ?? []).filter((cut) => cut.enabled);
  if (cuts.length) lines.push(`cuts applied: ${cuts.map((cut) => `${cut.id} ${rel(cut.startSec)}–${rel(cut.endSec)}`).join(", ")}`);
  if (plan.camera?.follow) {
    const follow = plan.camera.follow;
    lines.push(
      `follow: ${follow.enabled ? `on, tightness ${follow.tightness}, zoom ${follow.zoom ?? 1}, response ${follow.response ?? "natural"}, axis ${follow.axis ?? "both"}` : "off"}`
    );
  }
  for (const move of plan.camera?.moves ?? []) {
    lines.push(`move ${move.kind} ${rel(move.startSec)}–${rel(move.endSec)} zoom ${move.zoom} anchor ${typeof move.anchor === "string" ? move.anchor : "custom"} ease ${move.ease}`);
  }
  for (const scene of plan.captionScenes ?? []) {
    lines.push(`caption scene "${scene.label ?? ""}" ${rel(scene.startSec)}–${rel(scene.endSec)} look ${scene.styleId ?? "clip"} ${JSON.stringify(scene.overrides ?? {})}`);
  }
  for (const title of plan.titles ?? []) {
    lines.push(`title "${title.text}" ${rel(title.startSec)}–${rel(title.endSec)} at (${title.x}, ${title.y}) size ${title.sizeScale} ${title.depth} ${title.animation}`);
  }
  for (const hit of sfx ?? []) lines.push(`sfx ${hit.assetId} at ${hit.atSec.toFixed(2)} (output clock) gain ${hit.gain ?? 0.9}`);
  return lines.join("\n");
}

export interface DirectorBrief {
  duration: number;
  /** Absolute source time of the clip's first frame (for describing the current plan). */
  trimStart: number;
  peak: { at: number; line?: string };
  words: { t: number; word: string }[];
  cuts: number[];
  face?: { x: number; y: number; width: number; presence: string; travel: { x: number; y: number } };
  pauses: PauseCandidate[];
  genre: { label: string; summary: string };
  styles: { id: string; summary: string }[];
  fonts: string[];
  sfx: { id: string; label: string }[];
  current?: CreatorPlan;
  currentSfx?: SoundtrackHit[];
  notes?: string;
  keep: DirectorLane[];
}

export function buildDirectorPrompt(brief: DirectorBrief): string {
  const words = brief.words
    .slice(0, MAX_WORDS)
    .map((word) => `${word.t.toFixed(2)} ${word.word}`)
    .join(" | ");
  const pauses = brief.pauses.length
    ? brief.pauses
        .map(
          (pause) =>
            `${pause.id} ${(pause.startSec - brief.trimStart).toFixed(2)}–${(pause.endSec - brief.trimStart).toFixed(2)} (−${pause.savesSec.toFixed(2)}s)`
        )
        .join("\n")
    : "(none found)";
  const cuts = brief.cuts.length ? brief.cuts.map((cut) => cut.toFixed(2)).join(", ") : "none";
  const face = brief.face
    ? `The speaker's face sits at x=${Math.round(brief.face.x * 100)}% y=${Math.round(brief.face.y * 100)}% of the 9:16 frame at the start and is about ${Math.round(
        brief.face.width * 100
      )}% of the frame wide (${brief.face.presence}); the head travels ${Math.round(brief.face.travel.x * 100)}% of the frame across and ${Math.round(brief.face.travel.y * 100)}% up within a shot (under 3% is a still speaker — choose "smooth" or "natural"; over 8% is animated — "snappy" reads well). The head and shoulders below it fill most of the width down to the bottom. A behind-title is only visible where it clears the body: put it at the face's height with a width well past both sides of the head (sizeScale ≥ 2 for 1–2 short words), or above the head (y ≈ face y − 0.22) if there is room.`
    : "No face track: anchor camera moves on \"center\" and keep titles in front.";
  const keep = brief.keep.length ? `KEEP these lanes exactly as they are in the current plan (copy them through unchanged): ${brief.keep.join(", ")}.` : "";
  const described = describeCurrentPlan(brief.current, brief.currentSfx, brief.trimStart);
  const current = described ? `\nCURRENT PLAN (clip-relative seconds):\n${described.slice(0, 3500)}` : "";
  const notes = brief.notes
    ? `\nTHE CREATOR'S NOTES FOR THIS PASS — these override every default rule below, and every lane not under KEEP must change where they ask:\n"${brief.notes}"\n`
    : "";

  return `You are the editor of a short-form vertical clip (a YouTube Short / Reel). You write the BEAT PLAN a professional editor would build for retention: tighten dead air, punch the camera in on the lines that matter, let the camera ride the speaker, style the captions per scene, put a hook title behind the speaker for the first beat, and drop sound effects on every move.
${notes}
Genre: ${brief.genre.label} — ${brief.genre.summary}
Clip length: ${brief.duration.toFixed(1)}s. All times below and in your answer are CLIP-RELATIVE seconds (0 = the first frame).
The mined PEAK (the payoff line) is at ${brief.peak.at.toFixed(2)}s${brief.peak.line ? `: "${brief.peak.line}"` : ""}.
Shot changes (camera cuts in the source) at: ${cuts}.
${face}

WORDS (onset word | onset word …):
${words}

DEAD AIR CANDIDATES (id start–end, seconds saved):
${pauses}

CAPTION LOOKS (id — summary): ${brief.styles.map((style) => `${style.id} — ${style.summary}`).join("; ")}
FONTS: ${brief.fonts.join(", ")}
SOUND EFFECTS (id — label): ${brief.sfx.map((sound) => `${sound.id} — ${sound.label}`).join("; ")}
${current}
${keep}

EDITING RULES
- The first 2 seconds decide everything. Open with a "pull" camera move (start tight, settle) or a hard "punch", a hook caption scene, and a short TITLE (2–4 words, a curiosity gap, NOT the first caption's words) behind the speaker.
- Cut dead air: apply the candidates that save ≥ 0.25s unless the pause is a deliberate dramatic beat before the peak.
- Camera: 3–7 moves total for a 30–45s clip. "punch" on the peak line and on 1–3 other strong lines (zoom 1.15–1.3, anchor "face", ease "cut" for impact or "out" for a softer landing). A "push" (slow creep, zoom 1.08–1.14) under a build-up. Never overlap moves; leave at least 0.8s between them. follow.enabled true for talking-head footage: it pins the head and lets the room drift, so use tightness 0.7–0.9 and zoom 1.12–1.22 (below 1.08 there is no room to pin). follow.response is how fast the camera answers the head: "snappy" rides every nod (energetic, animated speakers), "natural" (default) keeps leans, "smooth" keeps only posture (calm, interview). follow.axis "both" unless the footage only moves one way.
- Caption scenes: 2–4 scenes. The hook (first 2–4s) big and bold; the peak line its own scene with highlight "word" and a warm accent; the rest calm. Scenes must not overlap.
- Titles: exactly 1 (the hook, 0–2.5s) unless the notes ask for more, depth "behind", placed where it peeks out around the head: y between the face's y and 0.62, large (sizeScale 1.6–2.4), uppercase, "pop". A second title only for a payoff punchline.
- SFX: a "swoosh" or "whoosh" on each camera move start (gain 0.6–0.9), a "riser" 0.6s before the peak punch, a "boom" or "thud" on the peak, a "pop" on the hook title's start, a "tick" on each applied cut (optional). At most ${MAX_SOUNDTRACK_HITS} hits.
- Times must land on word onsets from the WORDS list where possible.
- Respect every KEEP instruction exactly.

Return ONLY JSON, no prose, with this shape (all times clip-relative seconds):
{
  "summary": "2–3 sentences: what the plan does and why, in an editor's voice",
  "cuts": ["pause2", "pause5"],
  "camera": {
    "follow": { "enabled": true, "tightness": 0.85, "zoom": 1.16, "response": "natural", "axis": "both" },
    "moves": [{ "kind": "pull|punch|push", "start": 0, "end": 0.6, "zoom": 1.2, "anchor": "face|center", "ease": "cut|out|in_out" }]
  },
  "captionScenes": [{ "label": "hook", "start": 0, "end": 2.8, "styleId": "creator_hook", "overrides": { "highlight": "word", "uppercase": true, "peakColor": "#fde047", "fontFamily": "Anton", "sizeScale": 1.3 } }],
  "titles": [{ "text": "THE ONE RULE", "start": 0.1, "end": 2.4, "x": 0.5, "y": 0.5, "sizeScale": 1.9, "depth": "behind", "animation": "pop", "color": "#ffffff", "fontFamily": "Anton" }],
  "sfx": [{ "asset": "swoosh", "at": 0.0, "gain": 0.8 }]
}`;
}

/** The model's clip-relative answer, turned into a sanitised absolute plan. */
export function applyDirectorAnswer(input: {
  answer: DirectorPlanJson;
  trimStart: number;
  trimEnd: number;
  onsets: number[];
  candidates: PauseCandidate[];
  current: CreatorPlan | undefined;
  currentSfx: SoundtrackHit[];
  keep: DirectorLane[];
  sfxIds: Set<string>;
  windowsOutput: (sourceSec: number) => number;
}): { plan: CreatorPlan; sfx: SoundtrackHit[]; summary: string } {
  const { answer, trimStart, trimEnd, onsets, candidates, current, keep } = input;
  const duration = trimEnd - trimStart;
  const abs = (t: number | undefined, snap = true) => {
    const local = Math.max(0, Math.min(duration, t ?? 0));
    return round3(trimStart + (snap ? snapToWord(local, onsets) : local));
  };
  const kept = (lane: DirectorLane) => keep.includes(lane);

  // ---- cuts: ids of candidates ----
  let cuts: PauseCut[] | undefined = current?.cuts;
  if (!kept("cuts")) {
    const wanted = new Set(Array.isArray(answer.cuts) ? answer.cuts.map((id) => String(id)) : []);
    const users = (current?.cuts ?? []).filter((cut) => cut.source === "user");
    cuts = [
      ...users,
      ...candidates.map((candidate) => ({
        id: candidate.id,
        startSec: candidate.startSec,
        endSec: candidate.endSec,
        enabled: wanted.has(candidate.id),
        source: "director" as const,
      })),
    ];
  }

  // ---- camera ----
  let camera = current?.camera;
  if (!kept("camera")) {
    const raw = (answer.camera ?? {}) as Record<string, unknown>;
    const follow = raw.follow as Record<string, unknown> | undefined;
    const movesRaw = Array.isArray(raw.moves) ? (raw.moves as Record<string, unknown>[]) : [];
    const moves: CameraMove[] = movesRaw.slice(0, MAX_CAMERA_MOVES).map((move, index) => ({
      id: newId("move", index),
      kind: move.kind === "push" || move.kind === "pull" ? move.kind : "punch",
      startSec: abs(num(move.start)),
      endSec: abs(num(move.end), false),
      zoom: Math.min(MAX_CAMERA_ZOOM, Math.max(1, num(move.zoom) ?? 1.2)),
      anchor: move.anchor === "center" ? "center" : "face",
      ease: move.ease === "cut" || move.ease === "in_out" ? move.ease : "out",
    }));
    camera = {
      moves,
      follow: follow
        ? {
            enabled: Boolean(follow.enabled),
            tightness: Math.max(0, Math.min(1, num(follow.tightness) ?? 0.7)),
            zoom: Math.min(MAX_FOLLOW_ZOOM, Math.max(1, num(follow.zoom) ?? 1)),
            ...(follow.response === "snappy" || follow.response === "smooth" ? { response: follow.response } : {}),
            ...(follow.axis === "x" || follow.axis === "y" ? { axis: follow.axis } : {}),
          }
        : current?.camera?.follow,
    };
  }

  // ---- caption scenes ----
  let captionScenes = current?.captionScenes;
  if (!kept("captions")) {
    const raw = Array.isArray(answer.captionScenes) ? (answer.captionScenes as Record<string, unknown>[]) : [];
    captionScenes = raw.slice(0, MAX_CAPTION_SCENES).map((scene, index): CaptionScene => ({
      id: newId("scene", index),
      startSec: abs(num(scene.start)),
      endSec: abs(num(scene.end), false),
      label: typeof scene.label === "string" ? scene.label : undefined,
      styleId: typeof scene.styleId === "string" ? scene.styleId : undefined,
      overrides: lenientOverrides(scene.overrides),
    }));
  }

  // ---- titles ----
  let titles = current?.titles;
  if (!kept("titles")) {
    const raw = Array.isArray(answer.titles) ? (answer.titles as Record<string, unknown>[]) : [];
    titles = raw
      .filter((title) => typeof title.text === "string" && title.text.trim())
      .slice(0, MAX_TITLES)
      .map((title, index): BehindTitle => ({
        id: newId("title", index),
        text: String(title.text),
        startSec: abs(num(title.start), false),
        endSec: abs(num(title.end), false),
        x: Math.max(0.05, Math.min(0.95, num(title.x) ?? 0.5)),
        y: Math.max(0.05, Math.min(0.95, num(title.y) ?? 0.5)),
        sizeScale: Math.max(0.5, Math.min(3, num(title.sizeScale) ?? 1.8)),
        fontFamily: typeof title.fontFamily === "string" ? title.fontFamily : undefined,
        color: typeof title.color === "string" && /^#[0-9a-f]{6}$/i.test(title.color) ? title.color : "#ffffff",
        uppercase: title.uppercase === undefined ? true : Boolean(title.uppercase),
        animation: title.animation === "fade" || title.animation === "rise" || title.animation === "none" ? title.animation : "pop",
        depth: title.depth === "front" ? "front" : "behind",
      }));
  }

  // ---- sfx: on the OUTPUT clock, after the cuts above ----
  let sfx = input.currentSfx;
  if (!kept("sfx")) {
    const raw = Array.isArray(answer.sfx) ? (answer.sfx as Record<string, unknown>[]) : [];
    const users = input.currentSfx.filter((hit) => !hit.id.startsWith("dir_"));
    const placed: SoundtrackHit[] = raw
      .filter((hit) => typeof hit.asset === "string" && input.sfxIds.has(hit.asset as string))
      .slice(0, MAX_SOUNDTRACK_HITS)
      .map((hit, index) => ({
        id: newId("hit", index),
        assetId: String(hit.asset),
        atSec: round3(Math.max(0, input.windowsOutput(abs(num(hit.at), false)))),
        gain: Math.max(0, Math.min(1.5, num(hit.gain) ?? 0.8)),
      }));
    sfx = [...users, ...placed].slice(0, MAX_SOUNDTRACK_HITS);
  }

  const summary = typeof answer.summary === "string" ? answer.summary.trim().slice(0, 1200) : "";
  const plan = sanitizeCreatorPlan({
    enabled: true,
    version: 1,
    cuts,
    camera,
    captionScenes,
    titles,
    director: { ...current?.director, summary, generatedAt: new Date().toISOString() },
  });
  return { plan, sfx, summary };
}

export async function directClip(clipId: string, input: DirectInput = {}): Promise<DirectResult> {
  if (!config.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not set — the Director needs a model");
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");
  if (clip.kind === "merge") throw new Error("The Director works on a single clip, not a merge");
  const project = await ClipProject.findById(clip.projectId);
  if (!project) throw new Error("Project not found");

  const trimStart = clip.edit?.trimStartSec ?? clip.startSec;
  const trimEnd = clip.edit?.trimEndSec ?? clip.endSec;
  const duration = trimEnd - trimStart;
  if (!(duration > 1)) throw new Error("The clip window is too short to direct");

  const words = wordsFor(project, trimStart, trimEnd);
  const onsets = words.map((word) => word.t);
  const pauses = await detectClipPauses(clipId, { startSec: trimStart, endSec: trimEnd }).catch(() => null);
  const candidates = pauses?.candidates ?? [];
  const track: ReframeTrack | undefined = clip.reframeTrack?.track;
  const cuts = (track?.cuts ?? [])
    .map((cut) => round3(cut + (track?.originSec ?? 0) - trimStart))
    .filter((cut) => cut > 0.1 && cut < duration - 0.1);
  const faceAtHook = faceAnchorAt(track, trimStart + 0.5);
  const facePresence = track?.keyframes.filter((key) => key.fx != null).length ?? 0;
  const firstFace = track?.keyframes.find((key) => key.fw != null);
  const faceWidth = firstFace?.fw && firstFace.width ? Math.min(0.9, firstFace.fw / firstFace.width) : 0.3;
  const profile = resolveGenreProfile(project.genreId);
  const [builtin, custom] = [listBuiltinAudio(), await listCustomAudio().catch(() => [])];
  const sounds = [...builtin, ...custom].filter((asset) => asset.kind === "sfx");
  const keep = (input.keep ?? []).filter((lane): lane is DirectorLane =>
    ["cuts", "camera", "captions", "titles", "sfx"].includes(lane)
  );

  const brief: DirectorBrief = {
    duration,
    trimStart,
    peak: { at: round3(clip.peakSec - trimStart), line: clip.peakLine },
    words,
    cuts,
    face: faceAtHook
      ? {
          x: faceAtHook.x,
          y: faceAtHook.y,
          width: faceWidth,
          presence: facePresence > 0 ? "tracked throughout" : "briefly",
          travel: headTravel(track) ?? { x: 0, y: 0 },
        }
      : undefined,
    pauses: candidates,
    genre: { label: profile.label, summary: profile.summary },
    styles: listCaptionStyles().map((style) => ({ id: style.id, summary: style.summary })),
    fonts: listCaptionFonts().map((font) => font.family),
    sfx: sounds.map((sound) => ({ id: sound.id, label: sound.label })),
    current: clip.edit?.creator,
    currentSfx: clip.edit?.soundtrack?.sfx,
    notes: input.notes?.trim() || undefined,
    keep,
  };

  const model = directorModel();
  const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });
  const startedAt = Date.now();
  let text: string;
  try {
    const result = await generateText({
      model: openrouter(model),
      prompt: buildDirectorPrompt(brief),
      temperature: 0.45,
      maxOutputTokens: 2600,
    });
    text = result.text ?? "";
  } catch (error: unknown) {
    throw new Error(`The Director could not reach the model: ${getErrorMessage(error)}`);
  }
  const answer = extractJson(text);
  if (!answer) throw new Error("The Director returned something that was not a plan. Try again.");

  // SFX are placed on the output clock, which depends on the cuts the plan applies.
  const provisional = applyDirectorAnswer({
    answer,
    trimStart,
    trimEnd,
    onsets,
    candidates,
    current: clip.edit?.creator,
    currentSfx: clip.edit?.soundtrack?.sfx ?? [],
    keep,
    sfxIds: new Set(sounds.map((sound) => sound.id)),
    windowsOutput: (sourceSec) => sourceSec - trimStart,
  });
  const windows = windowsFor(trimStart, trimEnd, provisional.plan.cuts);
  const { plan, sfx, summary } = applyDirectorAnswer({
    answer,
    trimStart,
    trimEnd,
    onsets,
    candidates,
    current: clip.edit?.creator,
    currentSfx: clip.edit?.soundtrack?.sfx ?? [],
    keep,
    sfxIds: new Set(sounds.map((sound) => sound.id)),
    windowsOutput: (sourceSec) => sourceToOutput(windows, sourceSec),
  });
  plan.director = {
    ...plan.director,
    notes: input.notes?.trim() || undefined,
    summary,
    model,
    generatedAt: new Date().toISOString(),
  };

  const updated = await updateClipEdit(clipId, {
    edit: {
      creator: plan,
      soundtrack: { ...(clip.edit?.soundtrack ?? {}), sfx },
    },
  });
  console.log(
    `🎬 Directed clip ${clip.rank} of ${project._id} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
      `(${model}): ${plan.cuts?.filter((cut) => cut.enabled).length ?? 0} cuts, ${plan.camera?.moves.length ?? 0} moves, ` +
      `${plan.captionScenes?.length ?? 0} scenes, ${plan.titles?.length ?? 0} titles, ${sfx.length} hits`
  );
  return { clip: updated, summary, model };
}
