import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { directorModel } from "../config/models";
import { resolveGenreProfile } from "../config/genres";
import { listCaptionStyles } from "../config/caption-styles";
import { listCaptionFonts } from "../config/caption-fonts";
import { Clip, ClipProject, type IClip } from "../models";
import { effectInfo, isEffectId } from "../config/effects";
import { transitionInfo } from "../config/transitions";
import type {
  BehindTitle,
  CameraMove,
  CaptionScene,
  CreatorPlan,
  Cutaway,
  DirectorTurn,
  EffectSpan,
  MediaAsset,
  PauseCut,
  ReframeTrack,
  SoundtrackHit,
  SpeedSpan,
  TextEnter,
  TextExit,
  TextMotion,
  VttWordTiming,
} from "../types/clip.types";
import {
  MAX_CAMERA_MOVES,
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  MAX_CAPTION_SCENES,
  MAX_CUTAWAYS,
  MAX_DIRECTOR_TURNS,
  MAX_EFFECT_SPANS,
  MAX_FOLLOW_ZOOM,
  MAX_SPEED_SPANS,
  MAX_TITLES,
  MAX_TRANSITION_SEC,
} from "../types/clip.types";
import { getErrorMessage } from "../types";
import { buildWordTimeline } from "./mining.service";
import { expandWordTimings } from "./transcript.service";
import { detectClipPauses, type PauseCandidate } from "./pause-detect.service";
import { faceAnchorAt, headTravel, sourceToOutput, windowsFor } from "./creator-timeline";
import { sanitizeCreatorPlan } from "./creator-plan.service";
import { listBuiltinAudio, listCustomAudio, MAX_SOUNDTRACK_HITS } from "./soundtrack.service";
import { updateClipEdit } from "./clip.service";
import { listMediaAssets } from "./media-library.service";
import { stockForQuery, stockSources } from "./stock.service";
import { TEXT_ENTERS, TEXT_EXITS, TEXT_MOTIONS } from "./text-motion";

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
// On demand only. Notes, `keep` lanes and the last few turns make a second
// pass an iteration on the first rather than a reshuffle. A lane the answer
// leaves out stays as it is; an empty list clears it.
//
// Cutaways may name a library asset or a stock query: queries are searched
// and downloaded before the answer is applied, and one that finds nothing is
// left out of the plan (with a warning), never the render.
// ============================================

export type DirectorLane = "cuts" | "camera" | "captions" | "titles" | "sfx" | "speed" | "fx" | "cutaways";

export const DIRECTOR_LANES: DirectorLane[] = ["cuts", "camera", "speed", "fx", "cutaways", "captions", "titles", "sfx"];

export interface DirectInput {
  notes?: string;
  keep?: DirectorLane[];
}

export interface DirectResult {
  clip: IClip;
  summary: string;
  model: string;
  /** What the pass could not do, e.g. a stock query that found nothing. */
  warnings: string[];
}

/** Cap on the word grid handed to the model; a 60 s clip is ~180 words. */
const MAX_WORDS = 420;
/** A beat is snapped onto a spoken onset this close to it. */
const SNAP_SEC = 0.18;

export interface DirectorPlanJson {
  summary?: unknown;
  cuts?: unknown;
  camera?: unknown;
  captionScenes?: unknown;
  titles?: unknown;
  sfx?: unknown;
  speed?: unknown;
  effects?: unknown;
  cutaways?: unknown;
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
 * Caption cues inside the window, clip-relative — only when a word grid
 * exists, because a grid built from word-level VTT drops words (a name, a
 * place) that the cue text still carries.
 */
function linesFor(project: { wordTimings?: VttWordTiming[]; captions?: { startSec: number; endSec: number; text: string }[] }, startSec: number, endSec: number) {
  if (!project.wordTimings?.length) return [];
  return (project.captions ?? [])
    .filter((cue) => cue.endSec > startSec && cue.startSec < endSec && cue.text.trim())
    .map((cue) => ({ t: round3(Math.max(0, cue.startSec - startSec)), text: cue.text.replace(/\s+/g, " ").trim() }));
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
export function describeCurrentPlan(
  plan: CreatorPlan | undefined,
  sfx: SoundtrackHit[] | undefined,
  trimStart: number,
  mediaLabels: Map<string, string> = new Map()
): string {
  if (!plan) return "";
  const rel = (t: number) => (t - trimStart).toFixed(2);
  const lines: string[] = [];
  const cuts = (plan.cuts ?? []).filter((cut) => cut.enabled);
  if (cuts.length) lines.push(`cuts applied: ${cuts.map((cut) => `${cut.id} ${rel(cut.startSec)}–${rel(cut.endSec)}`).join(", ")}`);
  if (plan.camera?.follow) {
    const follow = plan.camera.follow;
    lines.push(
      `follow: ${follow.enabled ? `on, tightness ${follow.tightness}, zoom ${follow.zoom ?? 1}, response ${follow.response ?? "natural"}, axis ${follow.axis ?? "both"}, lead ${follow.lead ?? 0}` : "off"}`
    );
  }
  for (const move of plan.camera?.moves ?? []) {
    const framing = [
      move.zoomFrom !== undefined ? `zoomFrom ${move.zoomFrom}` : "",
      move.pan ? `pan (${move.pan.x}, ${move.pan.y})` : "",
      move.rampSec !== undefined ? `ramp ${move.rampSec}s` : "",
    ].filter(Boolean);
    lines.push(
      `move ${move.kind} ${rel(move.startSec)}–${rel(move.endSec)} zoom ${move.zoom}${framing.length ? ` ${framing.join(" ")}` : ""} anchor ${typeof move.anchor === "string" ? move.anchor : "custom"} ease ${move.ease}`
    );
  }
  for (const span of plan.speed ?? []) {
    const flags = [span.smooth ? "smooth" : "", span.captions ? "captions on" : ""].filter(Boolean).join(" ");
    lines.push(`speed ${span.kind}${span.kind === "freeze" ? "" : ` ${span.rate}×`} ${rel(span.startSec)}–${rel(span.endSec)}${flags ? ` ${flags}` : ""}`);
  }
  for (const effect of plan.effects ?? []) {
    lines.push(`effect ${effect.effectId} ${rel(effect.startSec)}–${rel(effect.endSec)} amount ${effect.amount}${effect.variant ? ` variant ${effect.variant}` : ""}`);
  }
  for (const cutaway of plan.cutaways ?? []) {
    const label = mediaLabels.get(cutaway.assetId);
    lines.push(
      `cutaway asset ${cutaway.assetId}${label ? ` "${label}"` : ""} ${rel(cutaway.startSec)}–${rel(cutaway.endSec)} fit ${cutaway.fit} motion ${cutaway.motion} in ${cutaway.in.transitionId} ${cutaway.in.sec}s out ${cutaway.out.transitionId} ${cutaway.out.sec}s`
    );
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
  /** Caption cues with their full wording, when the word grid may have dropped some. */
  lines?: { t: number; text: string }[];
  cuts: number[];
  face?: { x: number; y: number; width: number; presence: string; travel: { x: number; y: number }; gaze?: string };
  /** Whether the source has room to pan up and down under a 9:16 window (it is taller than 16:9). */
  verticalPan?: boolean;
  pauses: PauseCandidate[];
  genre: { label: string; summary: string };
  styles: { id: string; summary: string }[];
  fonts: string[];
  sfx: { id: string; label: string }[];
  effects: { id: string; group: string; summary: string; variants?: string[] }[];
  transitions: { id: string; summary: string }[];
  /** The media library, most useful first. */
  media: { id: string; kind: "image" | "video"; label: string; width?: number; height?: number; durationSec?: number }[];
  /** A stock provider is configured, so a cutaway may ask for a query. */
  stock: boolean;
  current?: CreatorPlan;
  currentSfx?: SoundtrackHit[];
  notes?: string;
  keep: DirectorLane[];
  turns?: DirectorTurn[];
}

/**
 * Which way the speaker faces across the clip, time-weighted, in words: what a
 * "frame" move toward what they look at, or a "look" anchor, has to go on.
 */
export function gazeSummary(track: ReframeTrack | undefined, trimStart: number, trimEnd: number): string | undefined {
  if (!track || track.mode === "resize") return undefined;
  const origin = track.originSec ?? 0;
  const keys = track.keyframes.filter((key) => key.fyaw != null);
  let left = 0;
  let right = 0;
  let total = 0;
  keys.forEach((key, index) => {
    const from = Math.max(trimStart, key.t + origin);
    const to = Math.min(trimEnd, index + 1 < keys.length ? keys[index + 1]!.t + origin : trimEnd);
    if (to <= from) return;
    total += to - from;
    if (key.fyaw! < -0.25) left += to - from;
    else if (key.fyaw! > 0.25) right += to - from;
  });
  if (total < 1) return undefined;
  const pct = (value: number) => Math.round((value / total) * 100);
  return `faces the camera ${pct(total - left - right)}% of the time, screen-left ${pct(left)}%, screen-right ${pct(right)}%`;
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
      )}% of the frame wide (${brief.face.presence}); the head travels ${Math.round(brief.face.travel.x * 100)}% of the frame across and ${Math.round(brief.face.travel.y * 100)}% up within a shot (under 3% is a still speaker — choose "smooth" or "natural"; over 8% is animated — "snappy" reads well).${brief.face.gaze ? ` The speaker ${brief.face.gaze}.` : ""} The head and shoulders below it fill most of the width down to the bottom. A behind-title is only visible where it clears the body: put it at the face's height with a width well past both sides of the head (sizeScale ≥ 2 for 1–2 short words), or above the head (y ≈ face y − 0.22) if there is room.`
    : "No face track: anchor camera moves on \"center\" and keep titles in front.";
  const keep = brief.keep.length ? `KEEP these lanes exactly as they are in the current plan (leave their keys out of your answer): ${brief.keep.join(", ")}.` : "";
  const mediaLabels = new Map(brief.media.map((item) => [item.id, item.label]));
  const described = describeCurrentPlan(brief.current, brief.currentSfx, brief.trimStart, mediaLabels);
  const current = described ? `\nCURRENT PLAN (clip-relative seconds):\n${described.slice(0, 6000)}` : "";
  const turns = brief.turns?.length
    ? `\nEARLIER PASSES ON THIS CLIP (oldest first). This pass builds on them: keep what earlier notes asked for unless the new notes change it.\n${brief.turns
        .map((turn, index) => `${index + 1}. creator: ${turn.notes ? `"${turn.notes}"` : "(no notes)"} → you: ${turn.summary.slice(0, 400)}`)
        .join("\n")}\n`
    : "";
  const notes = brief.notes
    ? `\nTHE CREATOR'S NOTES FOR THIS PASS — these override every default rule below, and every lane not under KEEP must change where they ask:\n"${brief.notes}"\n`
    : "";
  const effects = brief.effects
    .map((effect) => `${effect.id} (${effect.group}) — ${effect.summary}${effect.variants?.length ? ` [variants: ${effect.variants.join(", ")}]` : ""}`)
    .join("; ");
  const media = brief.media.length
    ? brief.media
        .map(
          (item) =>
            `${item.id} — ${item.kind} "${item.label}"${item.width && item.height ? ` ${item.width}x${item.height}` : ""}${item.durationSec ? ` ${item.durationSec.toFixed(0)}s` : ""}`
        )
        .join("\n")
    : "(empty)";
  const cutawaySource = brief.stock
    ? `a library "asset" id when one fits and is sharp (at least 720 on its short side — skip smaller ones), otherwise a stock "query": 2–4 concrete, visual nouns ("server room racks", not "compute") and a "kind" (video preferred, image for a still idea)`
    : brief.media.length
      ? `a library "asset" id only (no stock search is configured)`
      : `nothing — there is no library media and no stock search, so return "cutaways": []`;

  return `You are the editor of a short-form vertical clip (a YouTube Short / Reel). You write the BEAT PLAN a professional editor would build for retention: tighten dead air, punch the camera in on the lines that matter, let the camera ride the speaker, style the captions per scene, put a hook title behind the speaker for the first beat, drop sound effects on every move — and, where they earn it, slow motion, looks and B-roll cutaways.
${notes}${turns}
Genre: ${brief.genre.label} — ${brief.genre.summary}
Clip length: ${brief.duration.toFixed(1)}s. All times below and in your answer are CLIP-RELATIVE SOURCE seconds (0 = the first frame), even inside slow motion.
The mined PEAK (the payoff line) is at ${brief.peak.at.toFixed(2)}s${brief.peak.line ? `: "${brief.peak.line}"` : ""}.
Shot changes (camera cuts in the source) at: ${cuts}.
${face}

WORDS (onset word | onset word …):
${words}
${brief.lines?.length ? `\nLINES (cue start, full wording — the WORDS grid misses some words; a word missing there is spoken inside its line here, so time it from the line's start and its neighbours):\n${brief.lines.map((line) => `${line.t.toFixed(2)} ${line.text}`).join("\n").slice(0, 6000)}\n` : ""}
DEAD AIR CANDIDATES (id start–end, seconds saved):
${pauses}

CAPTION LOOKS (id — summary): ${brief.styles.map((style) => `${style.id} — ${style.summary}`).join("; ")}
FONTS: ${brief.fonts.join(", ")}
SOUND EFFECTS (id — label): ${brief.sfx.map((sound) => `${sound.id} — ${sound.label}`).join("; ")}
EFFECTS (id (group) — summary): ${effects}
TRANSITIONS (for cutaways): ${brief.transitions.map((item) => `${item.id} — ${item.summary}`).join("; ")}
CUTAWAY MOTIONS: none, in (slow push in), out (slow pull out), left, right, up, down (drifts)
MEDIA LIBRARY (id — kind "label"):
${media}
${current}
${keep}

EDITING RULES
- The first 2 seconds decide everything. Open with a "pull" camera move (start tight, settle) or a hard "punch", a hook caption scene, and a short TITLE (2–4 words, a curiosity gap, NOT the first caption's words) behind the speaker.
- Cut dead air: apply the candidates that save ≥ 0.25s unless the pause is a deliberate dramatic beat before the peak.
- Camera: 3–7 moves total for a 30–45s clip. "punch" on the peak line and on 1–3 other strong lines (zoom 1.15–1.3, anchor "face", ease "cut" for impact or "out" for a softer landing). A "push" (slow creep, zoom 1.08–1.14) under a build-up. Never overlap moves; leave at least 0.8s between them. follow.enabled true for talking-head footage: it pins the head and lets the room drift, so use tightness 0.7–0.9 and zoom 1.12–1.22 (below 1.08 there is no room to pin). follow.response is how fast the camera answers the head: "snappy" rides every nod (energetic, animated speakers), "natural" (default) keeps leans, "smooth" keeps only posture (calm, interview). follow.axis "both" unless the footage only moves one way. follow.lead 0–1 leans the frame toward where the speaker faces (0.3–0.6 for someone talking to an off-camera host).
- A "frame" move sets a framing and holds it to its end: "pan" { x, y } moves the 9:16 window over the wider source, −1..1 of the room either side (x −1 shows the source's left edge, +1 its right; ${brief.verticalPan ? "y moves it up (−) or down (+)" : "y has no room on this 16:9 source, keep it 0"}); "zoom" is where it ends, "zoomFrom" where it starts (zoomFrom 1.3 → zoom 1 is a reveal: a zoom OUT, down to 0.75 shows past the follow zoom), "rampSec" how long it takes to get there (0.3–0.8). Use it to show what the speaker looks or points at (pan toward the side they face), or for a reveal. anchor "look" converges ahead of the face, the way it faces.
- A "hold" move locks the camera off for its span: the follow stops riding the head (at the move's zoom, 1 for none) and glides back after. Use it for a still, weighty beat — a stare, a pause before the payoff — on an animated speaker; 1–3s.
- Speed (lane "speed"): the voice FADES OUT during slow motion and a freeze (music and SFX carry on), so only on a beat that carries without words — a reaction, a gesture, the breath after the payoff — ≤ 1.2s, rate 0.4–0.6, never on the hook words (first 2s) and never over a word the line needs. "freeze" 0.3–0.8s on a punchline reaction. "fast" (1.5–2×, voice kept) only to rush a setup. At most 1 speed span unless the notes ask. "smooth": true only for motion (a gesture, a head turn). "captions": true keeps captions on through it.
- Effects (lane "effects"): accents, not wallpaper — at most 3 per 30s, one look per caption scene, amount 0.4–0.8. Glitch/strobe/flicker/rgbsplit/shake/pulse are 0.2–1s hits on a cut, a punch or a hard word; colour and texture looks (bw, vhs, oldfilm…) can hold a short scene (a flashback, an "old way" line). Never cover the whole clip unless the notes ask.
- Cutaways (lane "cutaways"): B-roll laid over the speaker while the voice runs on. At most 2 per clip, 1.2–3s each, starting on the onset of the word that names what is shown, never in the first 1.5s and never over the peak line. Media: ${cutawaySource}. Transitions ≤ 0.4s ("dissolve" or "cut" by default; a slide or zoom for energy). fit "cover" for portrait media, "blur" for a wide shot you want to see whole.
- Caption scenes: 2–4 scenes. The hook (first 2–4s) big and bold; the peak line its own scene with highlight "word" and a warm accent; the rest calm. Scenes must not overlap.
- Titles (lane "titles", the creator's own text on screen, separate from the transcript captions): exactly 1 (the hook, 0–2.5s) unless the notes ask for more, depth "behind", placed where it peeks out around the head: y between the face's y and 0.62, large (sizeScale 1.6–2.4), uppercase. A second title only for a payoff punchline. "animation" is how it arrives: pop, fade, rise, zoom_in (grows from small), zoom_out (shrinks from big), slide_left / slide_right / slide_up / slide_down, drop, words (word by word); "exit" how it leaves: none, fade, pop, zoom_in, zoom_out, slide_left / slide_right / slide_up / slide_down, sink; "motion" while on screen: none, grow, shrink, pulse, wiggle, float. Default "pop" in, "fade" out, no motion; a punchline can "zoom_out" in and "pulse".
- SFX: a "swoosh" or "whoosh" on each camera move start (gain 0.6–0.9), a "riser" 0.6s before the peak punch, a "boom" or "thud" on the peak, a "pop" on the hook title's start, a "tick" on each applied cut (optional), a "whoosh" on a cutaway's arrival. At most ${MAX_SOUNDTRACK_HITS} hits.
- Times must land on word onsets from the WORDS list where possible.
- A key you leave out of your answer leaves that lane exactly as it is in the current plan; an empty list clears the lane. Respect every KEEP instruction exactly.

Return ONLY JSON, no prose, with this shape (all times clip-relative source seconds):
{
  "summary": "2–3 sentences: what the plan does and why, in an editor's voice",
  "cuts": ["pause2", "pause5"],
  "camera": {
    "follow": { "enabled": true, "tightness": 0.85, "zoom": 1.16, "response": "natural", "axis": "both", "lead": 0 },
    "moves": [
      { "kind": "pull|punch|push|hold", "start": 0, "end": 0.6, "zoom": 1.2, "anchor": "face|center|look", "ease": "cut|out|in_out" },
      { "kind": "frame", "start": 14.2, "end": 16.0, "zoomFrom": 1, "zoom": 1.1, "pan": { "x": -0.6, "y": 0 }, "rampSec": 0.5, "anchor": "look", "ease": "in_out" }
    ]
  },
  "speed": [{ "kind": "slow|fast|freeze", "start": 31.2, "end": 32.1, "rate": 0.5, "smooth": false, "captions": false }],
  "effects": [{ "effect": "vhs", "start": 0, "end": 1.8, "amount": 0.6 }],
  "cutaways": [{ "query": "server room racks", "kind": "video", "start": 12.4, "end": 14.6, "fit": "cover", "motion": "in", "in": { "transition": "dissolve", "sec": 0.3 }, "out": { "transition": "dissolve", "sec": 0.3 } }],
  "captionScenes": [{ "label": "hook", "start": 0, "end": 2.8, "styleId": "creator_hook", "overrides": { "highlight": "word", "uppercase": true, "peakColor": "#fde047", "fontFamily": "Anton", "sizeScale": 1.3 } }],
  "titles": [{ "text": "THE ONE RULE", "start": 0.1, "end": 2.4, "x": 0.5, "y": 0.5, "sizeScale": 1.9, "depth": "behind", "animation": "pop", "exit": "fade", "motion": "none", "color": "#ffffff", "fontFamily": "Anton" }],
  "sfx": [{ "asset": "swoosh", "at": 0.0, "gain": 0.8 }]
}
(A cutaway from the library carries "asset": "<library id>" in place of "query" and "kind".)`;
}

const CUTAWAY_MOTIONS: Cutaway["motion"][] = ["none", "in", "out", "left", "right", "up", "down"];

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A registry id from a model's loose spelling: exact, then ignoring case and
 * punctuation ("rgb_split", "Slide-Left"), then a label ("Black & white"),
 * then a common name for it ("slide", "flash", "crossfade").
 */
export function lenientRegistryId(
  value: unknown,
  entries: { id: string; label: string }[],
  aliases: Record<string, string> = {}
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const key = squash(value);
  return (
    entries.find((entry) => entry.id === value)?.id ??
    entries.find((entry) => squash(entry.id) === key || squash(entry.label) === key)?.id ??
    aliases[key]
  );
}

/** xfade's names and editors' words for the transitions in the registry. */
const TRANSITION_ALIASES: Record<string, string> = {
  fade: "dissolve",
  crossfade: "dissolve",
  crossdissolve: "dissolve",
  mix: "dissolve",
  none: "cut",
  hardcut: "cut",
  slide: "slide_left",
  push: "slide_left",
  wipe: "wipe_right",
  flash: "dip_white",
  whiteflash: "dip_white",
  fadewhite: "dip_white",
  dipwhite: "dip_white",
  fadeblack: "dip_black",
  dip: "dip_black",
  zoomin: "zoom",
  iris: "circle_open",
  circle: "circle_open",
  circleopen: "circle_open",
  softwipe: "smooth_left",
  pixel: "pixelize",
  pixelate: "pixelize",
  zoomout: "zoom",
};

/** Editors' words for effects in the registry. */
const EFFECT_ALIASES: Record<string, string> = {
  blackandwhite: "bw",
  monochrome: "bw",
  grayscale: "bw",
  greyscale: "bw",
  chromatic: "rgbsplit",
  chromaticaberration: "rgbsplit",
  rgbshift: "rgbsplit",
  tv: "brokentv",
  static: "brokentv",
  camerashake: "shake",
  handheld: "shake",
  letterbox: "bars",
  cinematicbars: "bars",
  film: "oldfilm",
  filmgrain: "grain",
  noise: "grain",
  vintage: "oldfilm",
  glow: "bloom",
};

/** A cutaway edge from the model: a known transition (dissolve otherwise), its length clamped. */
function directorEdge(raw: unknown): Cutaway["in"] {
  const edge = (typeof raw === "object" && raw !== null ? raw : typeof raw === "string" ? { transition: raw } : {}) as Record<string, unknown>;
  const transitionId = lenientRegistryId(edge.transition ?? edge.transitionId ?? edge.id, transitionInfo(), TRANSITION_ALIASES) ?? "dissolve";
  return { transitionId, sec: transitionId === "cut" ? 0 : round3(Math.max(0, Math.min(MAX_TRANSITION_SEC, num(edge.sec) ?? 0.3))) };
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
  /** Media assets a cutaway may use: the library plus anything fetched for this answer. */
  mediaIds?: Set<string>;
  windowsOutput: (sourceSec: number) => number;
}): { plan: CreatorPlan; sfx: SoundtrackHit[]; summary: string } {
  const { answer, trimStart, trimEnd, onsets, candidates, current, keep } = input;
  const duration = trimEnd - trimStart;
  const abs = (t: number | undefined, snap = true) => {
    const local = Math.max(0, Math.min(duration, t ?? 0));
    return round3(trimStart + (snap ? snapToWord(local, onsets) : local));
  };
  // A lane is rewritten only when it is not locked AND the answer speaks to
  // it: a key left out keeps the lane, so a note about captions never wipes
  // the B-roll.
  const rewrite = (lane: DirectorLane, key: keyof DirectorPlanJson) => !keep.includes(lane) && answer[key] !== undefined;
  const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []);

  // ---- cuts: ids of candidates ----
  let cuts: PauseCut[] | undefined = current?.cuts;
  if (rewrite("cuts", "cuts")) {
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
  if (rewrite("camera", "camera")) {
    const raw = (answer.camera ?? {}) as Record<string, unknown>;
    const follow = raw.follow as Record<string, unknown> | undefined;
    const moves: CameraMove[] = list(raw.moves).slice(0, MAX_CAMERA_MOVES).map((move, index) => {
      const pan = move.pan as Record<string, unknown> | undefined;
      const zoomFrom = num(move.zoomFrom);
      const rampSec = num(move.rampSec);
      const out: CameraMove = {
        id: newId("move", index),
        kind: move.kind === "push" || move.kind === "pull" || move.kind === "frame" || move.kind === "hold" ? move.kind : "punch",
        startSec: abs(num(move.start)),
        endSec: abs(num(move.end), false),
        zoom: Math.min(MAX_CAMERA_ZOOM, Math.max(MIN_CAMERA_ZOOM, num(move.zoom) ?? 1.2)),
        anchor: move.anchor === "center" || move.anchor === "look" ? move.anchor : "face",
        ease: move.ease === "cut" || move.ease === "in_out" ? move.ease : "out",
      };
      if (zoomFrom !== undefined && Math.abs(zoomFrom - 1) >= 0.005) {
        out.zoomFrom = Math.min(MAX_CAMERA_ZOOM, Math.max(MIN_CAMERA_ZOOM, zoomFrom));
      }
      if (pan && (num(pan.x) || num(pan.y))) {
        out.pan = { x: Math.max(-1, Math.min(1, num(pan.x) ?? 0)), y: Math.max(-1, Math.min(1, num(pan.y) ?? 0)) };
      }
      if (rampSec !== undefined) out.rampSec = Math.max(0, Math.min(3, rampSec));
      return out;
    });
    const lead = follow ? num(follow.lead) : undefined;
    camera = {
      moves,
      follow: follow
        ? {
            enabled: Boolean(follow.enabled),
            tightness: Math.max(0, Math.min(1, num(follow.tightness) ?? 0.7)),
            zoom: Math.min(MAX_FOLLOW_ZOOM, Math.max(1, num(follow.zoom) ?? 1)),
            ...(follow.response === "snappy" || follow.response === "smooth" ? { response: follow.response } : {}),
            ...(follow.axis === "x" || follow.axis === "y" ? { axis: follow.axis } : {}),
            ...(lead !== undefined && lead > 0 ? { lead: Math.min(1, lead) } : {}),
          }
        : current?.camera?.follow,
    };
  }

  // ---- speed ----
  let speed = current?.speed;
  if (rewrite("speed", "speed")) {
    speed = list(answer.speed)
      .slice(0, MAX_SPEED_SPANS)
      .map((span, index): SpeedSpan => {
        const kind = span.kind === "fast" || span.kind === "freeze" ? span.kind : "slow";
        // The sanitiser puts the rate on the kind's side of 1.
        const out: SpeedSpan = {
          id: newId("speed", index),
          kind,
          startSec: abs(num(span.start)),
          endSec: abs(num(span.end), false),
          rate: kind === "freeze" ? 0 : (num(span.rate) ?? (kind === "fast" ? 1.5 : 0.5)),
        };
        if (span.smooth === true) out.smooth = true;
        if (span.captions === true) out.captions = true;
        return out;
      });
  }

  // ---- effects ----
  let effects = current?.effects;
  if (rewrite("fx", "effects")) {
    effects = list(answer.effects)
      .map((effect): Record<string, unknown> => ({
        ...effect,
        effect: lenientRegistryId(effect.effect ?? effect.effectId ?? effect.id, effectInfo(), EFFECT_ALIASES),
      }))
      .filter((effect) => isEffectId(effect.effect))
      .slice(0, MAX_EFFECT_SPANS)
      .map((effect, index): EffectSpan => ({
        id: newId("fx", index),
        effectId: String(effect.effect),
        startSec: abs(num(effect.start)),
        endSec: abs(num(effect.end), false),
        amount: round3(Math.max(0, Math.min(1, num(effect.amount) ?? 0.7))),
        ...(typeof effect.variant === "string" ? { variant: effect.variant } : {}),
      }));
  }

  // ---- cutaways: only those whose media resolved ----
  let cutaways = current?.cutaways;
  if (rewrite("cutaways", "cutaways")) {
    const mediaIds = input.mediaIds ?? new Set<string>();
    cutaways = list(answer.cutaways)
      .filter((cutaway) => typeof cutaway.asset === "string" && mediaIds.has(cutaway.asset))
      .slice(0, MAX_CUTAWAYS)
      .map((cutaway, index): Cutaway => ({
        id: newId("cutaway", index),
        startSec: abs(num(cutaway.start)),
        endSec: abs(num(cutaway.end), false),
        assetId: String(cutaway.asset),
        fit: cutaway.fit === "blur" ? "blur" : "cover",
        motion: CUTAWAY_MOTIONS.includes(cutaway.motion as Cutaway["motion"]) ? (cutaway.motion as Cutaway["motion"]) : "in",
        in: directorEdge(cutaway.in),
        out: directorEdge(cutaway.out),
      }));
  }

  // ---- caption scenes ----
  let captionScenes = current?.captionScenes;
  if (rewrite("captions", "captionScenes")) {
    captionScenes = list(answer.captionScenes).slice(0, MAX_CAPTION_SCENES).map((scene, index): CaptionScene => ({
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
  if (rewrite("titles", "titles")) {
    titles = list(answer.titles)
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
        animation: (TEXT_ENTERS as unknown[]).includes(title.animation) ? (title.animation as TextEnter) : "pop",
        depth: title.depth === "front" ? "front" : "behind",
        ...((TEXT_EXITS as unknown[]).includes(title.exit) ? { exit: title.exit as TextExit } : {}),
        ...((TEXT_MOTIONS as unknown[]).includes(title.motion) && title.motion !== "none" ? { motion: title.motion as TextMotion } : {}),
      }));
  }

  // ---- sfx: on the OUTPUT clock, after the cuts and speed above ----
  let sfx = input.currentSfx;
  if (rewrite("sfx", "sfx")) {
    const users = input.currentSfx.filter((hit) => !hit.id.startsWith("dir_"));
    const placed: SoundtrackHit[] = list(answer.sfx)
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
    speed,
    effects,
    cutaways,
    director: { summary, generatedAt: new Date().toISOString() },
  });
  return { plan, sfx, summary };
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "shot", "stock", "video", "image", "photo", "footage", "clip", "of", "a", "an"]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

/** The library asset whose label shares the most words with a query, if any does. */
export function libraryMatch(query: string, library: MediaAsset[]): MediaAsset | undefined {
  const wanted = new Set(tokens(query));
  let best: MediaAsset | undefined;
  let bestScore = 0;
  for (const asset of library) {
    const score = tokens(asset.label).filter((word) => wanted.has(word)).length;
    if (score > bestScore) {
      best = asset;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Give every cutaway in the answer a real asset before it is applied: a
 * library id is kept, a query is searched on stock (first portrait result,
 * downloaded once) and falls back to the library asset whose label matches
 * it. One that finds nothing loses its `asset`, so `applyDirectorAnswer`
 * leaves it out — the plan stays valid and the render never depends on it.
 */
export async function resolveDirectorMedia(input: {
  cutaways: unknown;
  library: MediaAsset[];
  /** Absent when no stock provider is configured. */
  findStock?: (query: string, kind: "image" | "video") => Promise<MediaAsset>;
}): Promise<{ cutaways: Record<string, unknown>[]; assets: MediaAsset[]; warnings: string[] }> {
  const raw = Array.isArray(input.cutaways) ? (input.cutaways as unknown[]).slice(0, MAX_CUTAWAYS) : [];
  const byId = new Map(input.library.map((asset) => [asset.id, asset]));
  const fetched = new Map<string, Promise<MediaAsset>>();
  const assets: MediaAsset[] = [];
  const warnings: string[] = [];

  const cutaways = await Promise.all(
    raw
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map(async (item) => {
        const out: Record<string, unknown> = { ...item };
        if (typeof item.asset === "string" && byId.has(item.asset)) return out;
        delete out.asset;
        const query = typeof item.query === "string" ? item.query.trim().slice(0, 80) : "";
        if (!query) {
          warnings.push("A cutaway named no media it could use, so it was left out.");
          return out;
        }
        const kind = item.kind === "image" ? "image" : "video";
        let reason = "no stock search is configured";
        if (input.findStock) {
          const key = `${kind}:${query.toLowerCase()}`;
          if (!fetched.has(key)) fetched.set(key, input.findStock(query, kind));
          try {
            const asset = await fetched.get(key)!;
            if (!assets.some((known) => known.id === asset.id)) assets.push(asset);
            out.asset = asset.id;
            return out;
          } catch (error: unknown) {
            reason = getErrorMessage(error);
          }
        }
        const match = libraryMatch(query, input.library);
        if (match) {
          out.asset = match.id;
          return out;
        }
        warnings.push(`No media for the "${query}" cutaway (${reason}), so it was left out.`);
        return out;
      })
  );
  return { cutaways, assets, warnings };
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
  const lines = linesFor(project, trimStart, trimEnd);
  // A cue's start is a real onset too, often of a word the grid dropped.
  const onsets = [...words.map((word) => word.t), ...lines.map((line) => line.t)];
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
  const [builtin, custom, library] = [listBuiltinAudio(), await listCustomAudio().catch(() => []), await listMediaAssets().catch(() => [])];
  const sounds = [...builtin, ...custom].filter((asset) => asset.kind === "sfx");
  const keep = (input.keep ?? []).filter((lane): lane is DirectorLane => DIRECTOR_LANES.includes(lane));
  const stock = stockSources().length > 0;
  const current = clip.edit?.creator;
  const previousTurns: DirectorTurn[] = (current?.director?.turns ?? []).map((turn) => ({
    ...(turn.notes ? { notes: turn.notes } : {}),
    summary: turn.summary,
    at: turn.at,
  }));

  const brief: DirectorBrief = {
    duration,
    trimStart,
    peak: { at: round3(clip.peakSec - trimStart), line: clip.peakLine },
    words,
    lines,
    cuts,
    face: faceAtHook
      ? {
          x: faceAtHook.x,
          y: faceAtHook.y,
          width: faceWidth,
          presence: facePresence > 0 ? "tracked throughout" : "briefly",
          travel: headTravel(track) ?? { x: 0, y: 0 },
          gaze: gazeSummary(track, trimStart, trimEnd),
        }
      : undefined,
    verticalPan: track ? track.sourceHeight / track.sourceWidth > 9 / 16 + 0.05 : false,
    pauses: candidates,
    genre: { label: profile.label, summary: profile.summary },
    styles: listCaptionStyles().map((style) => ({ id: style.id, summary: style.summary })),
    fonts: listCaptionFonts().map((font) => font.family),
    sfx: sounds.map((sound) => ({ id: sound.id, label: sound.label })),
    effects: effectInfo().map((effect) => ({
      id: effect.id,
      group: effect.group,
      summary: effect.summary,
      variants: effect.variants?.map((variant) => variant.id),
    })),
    transitions: transitionInfo().map(({ id, summary }) => ({ id, summary })),
    media: library
      .slice(0, 40)
      .map((asset) => ({ id: asset.id, kind: asset.kind, label: asset.label, width: asset.width, height: asset.height, durationSec: asset.durationSec })),
    stock,
    current,
    currentSfx: clip.edit?.soundtrack?.sfx,
    notes: input.notes?.trim() || undefined,
    keep,
    turns: previousTurns,
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
      maxOutputTokens: 4000,
    });
    text = result.text ?? "";
  } catch (error: unknown) {
    throw new Error(`The Director could not reach the model: ${getErrorMessage(error)}`);
  }
  const answer = extractJson(text);
  if (!answer) throw new Error("The Director returned something that was not a plan. Try again.");

  // Stock queries become library assets before anything is applied.
  const warnings: string[] = [];
  const mediaIds = new Set(library.map((asset) => asset.id));
  if (answer.cutaways !== undefined && !keep.includes("cutaways")) {
    const resolved = await resolveDirectorMedia({
      cutaways: answer.cutaways,
      library,
      findStock: stock ? stockForQuery : undefined,
    });
    answer.cutaways = resolved.cutaways;
    for (const asset of resolved.assets) mediaIds.add(asset.id);
    warnings.push(...resolved.warnings);
  }

  // SFX are placed on the output clock, which depends on the cuts and speed the plan applies.
  const applyWith = (windowsOutput: (sourceSec: number) => number) =>
    applyDirectorAnswer({
      answer,
      trimStart,
      trimEnd,
      onsets,
      candidates,
      current,
      currentSfx: clip.edit?.soundtrack?.sfx ?? [],
      keep,
      sfxIds: new Set(sounds.map((sound) => sound.id)),
      mediaIds,
      windowsOutput,
    });
  const provisional = applyWith((sourceSec) => sourceSec - trimStart);
  const windows = windowsFor(trimStart, trimEnd, provisional.plan.cuts, provisional.plan.speed);
  const applied = applyWith((sourceSec) => sourceToOutput(windows, sourceSec));
  const { plan, sfx } = applied;
  // The model describes what it meant to do; say what could not be done, so
  // the creator and the next pass are not told about a cutaway that is not there.
  const summary = warnings.length ? `${applied.summary} (Not done: ${warnings.join(" ")})`.slice(0, 1200) : applied.summary;
  const notes = input.notes?.trim() || undefined;
  const at = new Date().toISOString();
  plan.director = {
    notes,
    summary,
    model,
    generatedAt: at,
    turns: [...previousTurns, { ...(notes ? { notes } : {}), summary: summary || "(no summary)", at }].slice(-MAX_DIRECTOR_TURNS),
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
      `${plan.speed?.length ?? 0} speed, ${plan.effects?.length ?? 0} fx, ${plan.cutaways?.length ?? 0} cutaways, ` +
      `${plan.captionScenes?.length ?? 0} scenes, ${plan.titles?.length ?? 0} titles, ${sfx.length} hits` +
      (warnings.length ? ` — ${warnings.join(" ")}` : "")
  );
  return { clip: updated, summary, model, warnings };
}
