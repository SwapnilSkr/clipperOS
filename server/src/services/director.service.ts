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
  ClipSense,
  CreatorPlan,
  Cutaway,
  DirectorAsk,
  DirectorAssetMode,
  DirectorLesson,
  DirectorTurn,
  DirectorUndo,
  MusicBed,
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
import { faceAnchorAt, headTravel, outputToSource, sourceToOutput, windowsFor } from "./creator-timeline";
import { plainCreatorPlan, sanitizeCreatorPlan } from "./creator-plan.service";
import { DEFAULT_BED_DIP, DEFAULT_BED_GAIN, listBuiltinAudio, listCustomAudio, MAX_MUSIC_BEDS, MAX_SOUNDTRACK_HITS, musicBeds, type AudioAsset } from "./soundtrack.service";
import { generateImageNow, generateMusicNow, startGeneration } from "./ai-assets.service";
import { fileDataUrl, chatStream, type ChatPart } from "./openrouter.service";
import { proxyClip, senseClip, senseLibrary } from "./sense.service";
import { describeLessons, lessonsFor } from "./taste.service";
import { ensureProjectMedia } from "./ingest.service";
import { freesoundConfigured, sfxForQuery } from "./freesound.service";
import { updateClipEdit } from "./clip.service";
import { listMediaAssets } from "./media-library.service";
import { stockForQuery, stockSources } from "./stock.service";
import { TEXT_ENTERS, TEXT_EXITS, TEXT_MOTIONS } from "./text-motion";
import { ASK_FORMAT, cleanDirectorAsks, PROPOSAL_FORMAT } from "./director-asks";
import { editorKnowledge } from "./director-knowledge.service";
import { readRequest } from "./director-request.service";

// ============================================
// THE DIRECTOR — one call that writes the whole beat plan.
//
// Given what the pipeline knows about a clip — every word and when it is
// spoken, the mined peak, the shot changes, where the speaker's face sits,
// the dead air, what looks and sounds exist — AND what the harness saw and
// heard (sense.service: the clip itself is attached as video, every sound
// and picture in the library is described from its content, the creator's
// taste is a list of learned lessons), the model returns a plan in
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

export type DirectorLane = "cuts" | "camera" | "captions" | "titles" | "sfx" | "speed" | "fx" | "cutaways" | "music";

export const DIRECTOR_LANES: DirectorLane[] = ["cuts", "camera", "speed", "fx", "cutaways", "captions", "titles", "sfx", "music"];

export interface DirectInput {
  notes?: string;
  keep?: DirectorLane[];
  /**
   * Where B-roll may come from: the library only, stock search, generated
   * on OpenRouter, or both stock and generation (the Director picks per
   * cutaway). Default: stock when a provider is configured, else library.
   */
  assets?: DirectorAssetMode;
  /** Let the pass lay music beds (default true). */
  music?: boolean;
  /** Attach the clip itself so the model watches it (default true). */
  see?: boolean;
  /**
   * Plan first: the Director says what it would do, lane by lane, and asks
   * up to four questions it cannot settle from the brief, each with options
   * and the one it recommends. Nothing is applied; the proposal is kept as a
   * turn, and the next pass (with the answers) carries it. A note can switch
   * a pass either way (director-request.service).
   */
  plan?: boolean;
  /** Options picked for the waiting proposal's questions. */
  answers?: { question: string; choice: string }[];
}

export interface DirectResult {
  clip: IClip;
  summary: string;
  model: string;
  /** What the pass could not do, e.g. a stock query that found nothing. */
  warnings: string[];
  /** Generated assets still rendering; they swap in when done. */
  pending: string[];
  /** What the harness saw, for the panel. */
  sense?: ClipSense;
  /** A plan turn: what it asked, and that nothing was applied. */
  questions?: string[];
  /** The same questions with their options and the recommended one. */
  asks?: DirectorAsk[];
  planned?: boolean;
  /** Every panel setting the creator's note overrode this pass (and a switch between proposing and cutting). */
  followed: string[];
}

/** Cap on the word grid handed to the model; a 60 s clip is ~180 words. */
const MAX_WORDS = 420;
/** A beat is snapped onto a spoken onset this close to it. */
const SNAP_SEC = 0.18;

export interface DirectorPlanJson {
  /** In Auto, a Director that stopped to ask: { why, proposal, asks } instead of a plan. */
  decide?: unknown;
  summary?: unknown;
  cuts?: unknown;
  music?: unknown;
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

export function extractJson(text: string): DirectorPlanJson | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice) as DirectorPlanJson;
  } catch {
    // Models slip a trailing comma in now and then; nothing else is guessed at.
    try {
      return JSON.parse(slice.replace(/,(\s*[}\]])/g, "$1")) as DirectorPlanJson;
    } catch {
      return null;
    }
  }
}

/** One stage of a pass, as the panel shows it while the Director works. */
export type DirectorStepId = "read" | "undo" | "look" | "think" | "broll" | "sound" | "music" | "save";

export type DirectorEvent =
  | { type: "step"; id: DirectorStepId; state: "run" | "done" | "fail"; label: string; detail?: string }
  /** The model's thinking, as it streams (Gemini sends short summaries). */
  | { type: "thinking"; text: string }
  /** How much of the answer has been written so far. */
  | { type: "writing"; chars: number };

export type DirectorProgress = (event: DirectorEvent) => void;

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

/**
 * The stored plan lane by lane, in clip-relative seconds. With `trimEnd`, hits
 * and beds are told on the source clock as well — the clock the model answers
 * in — so a lane copied back from here lands where it already is.
 */
export function describePlanLanes(
  plan: CreatorPlan | undefined,
  sfx: SoundtrackHit[] | undefined,
  trimStart: number,
  mediaLabels: Map<string, string> = new Map(),
  beds: MusicBed[] = [],
  trimEnd?: number
): Record<DirectorLane, string[]> {
  const lanes: Record<DirectorLane, string[]> = { cuts: [], camera: [], speed: [], fx: [], cutaways: [], captions: [], titles: [], sfx: [], music: [] };
  const rel = (t: number) => (t - trimStart).toFixed(2);
  const cuts = (plan?.cuts ?? []).filter((cut) => cut.enabled);
  if (cuts.length) lanes.cuts.push(`cuts applied: ${cuts.map((cut) => `${cut.id} ${rel(cut.startSec)}–${rel(cut.endSec)}`).join(", ")}`);
  if (plan?.camera?.follow) {
    const follow = plan.camera.follow;
    lanes.camera.push(
      `follow: ${follow.enabled ? `on, tightness ${follow.tightness}, zoom ${follow.zoom ?? 1}, response ${follow.response ?? "natural"}, axis ${follow.axis ?? "both"}, lead ${follow.lead ?? 0}` : "off"}`
    );
  }
  for (const move of plan?.camera?.moves ?? []) {
    const framing = [
      move.zoomFrom !== undefined ? `zoomFrom ${move.zoomFrom}` : "",
      move.pan ? `pan (${move.pan.x}, ${move.pan.y})` : "",
      move.rampSec !== undefined ? `ramp ${move.rampSec}s` : "",
    ].filter(Boolean);
    lanes.camera.push(
      `move ${move.kind} ${rel(move.startSec)}–${rel(move.endSec)} zoom ${move.zoom}${framing.length ? ` ${framing.join(" ")}` : ""} anchor ${typeof move.anchor === "string" ? move.anchor : "custom"} ease ${move.ease}`
    );
  }
  for (const span of plan?.speed ?? []) {
    const flags = [span.smooth ? "smooth" : "", span.captions ? "captions on" : ""].filter(Boolean).join(" ");
    lanes.speed.push(`speed ${span.kind}${span.kind === "freeze" ? "" : ` ${span.rate}×`} ${rel(span.startSec)}–${rel(span.endSec)}${flags ? ` ${flags}` : ""}`);
  }
  for (const effect of plan?.effects ?? []) {
    lanes.fx.push(`effect ${effect.effectId} ${rel(effect.startSec)}–${rel(effect.endSec)} amount ${effect.amount}${effect.variant ? ` variant ${effect.variant}` : ""}`);
  }
  for (const cutaway of plan?.cutaways ?? []) {
    const label = mediaLabels.get(cutaway.assetId);
    lanes.cutaways.push(
      `cutaway asset ${cutaway.assetId}${label ? ` "${label}"` : ""} ${rel(cutaway.startSec)}–${rel(cutaway.endSec)} fit ${cutaway.fit} motion ${cutaway.motion} in ${cutaway.in.transitionId} ${cutaway.in.sec}s out ${cutaway.out.transitionId} ${cutaway.out.sec}s`
    );
  }
  for (const scene of plan?.captionScenes ?? []) {
    // A plain copy with its keys sorted: the same overrides read the same whichever path stored them.
    const overrides = JSON.parse(JSON.stringify(scene.overrides ?? {})) as Record<string, unknown>;
    lanes.captions.push(`caption scene "${scene.label ?? ""}" ${rel(scene.startSec)}–${rel(scene.endSec)} look ${scene.styleId ?? "clip"} ${JSON.stringify(overrides, Object.keys(overrides).sort())}`);
  }
  for (const title of plan?.titles ?? []) {
    const look = [title.exit ? `exit ${title.exit}` : "", title.motion ? `motion ${title.motion}` : "", title.color ? `color ${title.color}` : "", title.fontFamily ? `font ${title.fontFamily}` : ""].filter(Boolean);
    lanes.titles.push(
      `title "${title.text}" ${rel(title.startSec)}–${rel(title.endSec)} at (${title.x}, ${title.y}) size ${title.sizeScale} ${title.depth} ${title.animation}${look.length ? ` ${look.join(" ")}` : ""}`
    );
  }
  const windows = trimEnd !== undefined ? windowsFor(trimStart, trimEnd, plan?.cuts, plan?.speed) : undefined;
  const clock = (outputSec: number) => (windows ? `${(outputToSource(windows, outputSec) - trimStart).toFixed(2)} source (${outputSec.toFixed(2)} output clock)` : `${outputSec.toFixed(2)} (output clock)`);
  const named = (id: string) => `${id}${mediaLabels.get(id) ? ` "${mediaLabels.get(id)}"` : ""}`;
  for (const hit of sfx ?? []) lanes.sfx.push(`sfx ${named(hit.assetId)} at ${clock(hit.atSec)} gain ${hit.gain ?? 0.9}`);
  for (const bed of beds) {
    lanes.music.push(
      `music bed ${named(bed.assetId)} level ${bed.gain ?? DEFAULT_BED_GAIN} dip ${bed.dip ?? DEFAULT_BED_DIP} in ${clock(bed.inSec ?? 0)}${bed.outSec != null ? ` out ${clock(bed.outSec)}` : ""}${bed.offsetSec ? ` offset ${bed.offsetSec}` : ""}`
    );
  }
  return lanes;
}

/** The stored plan, described in clip-relative seconds so the model can iterate on it. */
export function describeCurrentPlan(
  plan: CreatorPlan | undefined,
  sfx: SoundtrackHit[] | undefined,
  trimStart: number,
  mediaLabels: Map<string, string> = new Map(),
  beds: MusicBed[] = [],
  trimEnd?: number
): string {
  if (!plan) return "";
  const lanes = describePlanLanes(plan, sfx, trimStart, mediaLabels, beds, trimEnd);
  return DIRECTOR_LANES.flatMap((lane) => lanes[lane]).join("\n");
}

/** The lanes that read differently between two states of the edit. */
export function changedLanes(before: Record<DirectorLane, string[]>, after: Record<DirectorLane, string[]>): DirectorLane[] {
  return DIRECTOR_LANES.filter((lane) => before[lane].join("\n") !== after[lane].join("\n"));
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
  /** Sounds and beds, each with what the harness heard in it when it has listened. */
  sfx: { id: string; label: string; line?: string }[];
  music: { id: string; label: string; durationSec: number; line?: string; bpm?: number; energy?: number; suits?: string[] }[];
  effects: { id: string; group: string; summary: string; variants?: string[] }[];
  transitions: { id: string; summary: string }[];
  /** The media library, most useful first, with what the harness saw in each. */
  media: { id: string; kind: "image" | "video"; label: string; width?: number; height?: number; durationSec?: number; line?: string }[];
  /** A stock provider is configured, so a cutaway may ask for a query. */
  stock: boolean;
  /** Freesound is configured, so a hit may ask for a query the catalogue lacks. */
  freesound?: boolean;
  /** Where B-roll may come from this pass. */
  assets: DirectorAssetMode;
  /** Whether this pass may lay music. */
  wantsMusic: boolean;
  /** The creator asked for a bed made to order. */
  composeMusic?: boolean;
  /** What the harness saw and heard in the clip (sense.service). */
  sense?: ClipSense;
  /** What the Director has learned about this creator's taste. */
  lessons: DirectorLesson[];
  current?: CreatorPlan;
  currentSfx?: SoundtrackHit[];
  currentBeds?: MusicBed[];
  notes?: string;
  keep: DirectorLane[];
  turns?: DirectorTurn[];
  /** The note revises an edit the Director already made: change what it asks, leave the rest. */
  followUp?: boolean;
  /** The lanes the note reads as touching (director-request), a hint for a follow-up. */
  touches?: DirectorLane[];
  /** Lanes the creator changed by hand since the Director's last pass. */
  handEdited?: DirectorLane[];
  /** The editor, its tools and the models behind them (director-knowledge). */
  knowledge?: string;
  /** The clip's own caption look, used wherever no caption scene is set. */
  captions?: { styleId: string; chunkWords: number };
  /** The note fixed the caption words on screen at a time for the whole clip. */
  wordsPerLine?: number;
  /** Panel settings the note overrode, so the model knows what it may now use. */
  followed?: string[];
  /** In Auto, the model may stop and ask instead of cutting when the notes leave the direction open. */
  mayAsk?: boolean;
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
  const mediaLabels = new Map([...brief.media, ...brief.sfx, ...brief.music].map((item) => [item.id, item.label]));
  const described = describeCurrentPlan(brief.current, brief.currentSfx, brief.trimStart, mediaLabels, brief.currentBeds ?? [], brief.trimStart + brief.duration);
  const handEdited = brief.handEdited?.length
    ? `\nSINCE YOUR LAST PASS THE CREATOR CHANGED THESE LANES BY HAND: ${brief.handEdited.join(", ")}. CURRENT PLAN already holds their changes — keep them unless the notes ask otherwise.`
    : "";
  const current = described ? `\nCURRENT PLAN (clip-relative seconds; hits and beds on both clocks — answer in source seconds):\n${described.slice(0, 7000)}${handEdited}` : "";
  const turnKind = (turn: DirectorTurn) =>
    turn.kind === "plan"
      ? " PROPOSED"
      : turn.kind === "reply"
        ? " ANSWERED (nothing changed)"
        : turn.kind === "undo"
          ? " TOOK BACK A PASS (the edit went back to how it was before it)"
          : `${turn.changed ? ` CUT [changed: ${turn.changed.join(", ") || "nothing"}]` : ""}${turn.undone ? " — LATER TAKEN BACK by the creator: none of it is in CURRENT PLAN; do not bring it back unless asked" : ""}`;
  const turns = brief.turns?.length
    ? `\nTHE CONVERSATION SO FAR ON THIS CLIP (oldest first). This pass builds on it: keep what earlier notes asked for unless the new notes change it, and read "that", "it", "again", "more", "less", "like before" against it. A turn marked PROPOSED is a plan you laid out and questions you asked without cutting; the creator's notes after it are the answers — apply that plan with those answers now.\n${brief.turns
        .map((turn, index) => `${index + 1}. creator: ${turn.notes ? `"${turn.notes}"` : "(no notes)"} → you${turnKind(turn)}: ${turn.summary.slice(0, 700)}${
            turn.asks?.length
              ? ` You asked: ${turn.asks
                  .map((ask) => `${ask.question}${ask.options.length ? ` [${ask.options.map((option, index) => `${option.label}${index === (ask.recommended ?? 0) ? " (recommended)" : ""}`).join(" / ")}]` : ""}`)
                  .join(" | ")}`
              : turn.questions?.length
                ? ` You asked: ${turn.questions.join(" | ")}`
                : ""
          }`)
        .join("\n")}\n`
    : "";
  const count = brief.wordsPerLine ?? 0;
  const wordsPerLine = count
    ? `CAPTIONS HOLD ${count} WORD${count === 1 ? "" : "S"} ON SCREEN AT A TIME FOR THE WHOLE CLIP: every caption scene's overrides carry "chunkWords": ${count}. A peak scene still grips — bigger, bolder, uppercase, a warm highlight — but keeps ${count}.\n`
    : "";
  const followUp =
    brief.followUp && brief.notes
      ? `THIS NOTE REVISES THE EDIT YOU ALREADY MADE (CURRENT PLAN below) — take it the way an editor takes a client's notes on a cut:
- Change ONLY what the note asks for${brief.touches?.length ? ` (it reads as touching: ${brief.touches.join(", ")})` : ""}, plus what that change forces (a hit that sat on a moved camera move moves with it). Leave the key of every other lane OUT of your answer so it stays exactly as it is — do not re-time, re-roll or "improve" a lane the note does not ask about.
- A lane you do return replaces that lane whole: start from its items in CURRENT PLAN and change only what the note asks, so nothing else in it is lost.
- The EDITING RULES below are how to lay a lane from scratch; for a revision the note and CURRENT PLAN come first.
- "summary": 1–3 sentences on what you changed this turn and why — not the whole edit again.
`
      : "";
  const notes = brief.notes
    ? `\nTHE CREATOR'S NOTES FOR THIS PASS — the most important part of this brief. Do EVERYTHING they ask, in their words' meaning: they override every default rule and rule of thumb below (a rule says "at most 2 cutaways" and the notes want B-roll throughout: lay more). Every lane not under KEEP must change where they ask. If they ask a question, answer it at the start of "summary" from EDITOR KNOWLEDGE. If something they ask cannot be done with the tools here, say so in "summary" rather than skipping it silently:\n"${brief.notes}"\n${
        brief.followed?.length ? `The panel's settings were changed to follow them: ${brief.followed.join(" ")}\n` : ""
      }${followUp}${wordsPerLine}`
    : wordsPerLine;
  const effects = brief.effects
    .map((effect) => `${effect.id} (${effect.group}) — ${effect.summary}${effect.variants?.length ? ` [variants: ${effect.variants.join(", ")}]` : ""}`)
    .join("; ");
  const media = brief.media.length
    ? brief.media
        .map(
          (item) =>
            `${item.id} — ${item.kind} "${item.label}"${item.width && item.height ? ` ${item.width}x${item.height}` : ""}${item.durationSec ? ` ${item.durationSec.toFixed(0)}s` : ""}${item.line ? ` — ${item.line}` : ""}`
        )
        .join("\n")
    : "(empty)";
  const libraryPick = `a library "asset" id when one fits and is sharp (at least 720 on its short side — skip smaller ones)`;
  const stockPick = `a stock "query": 2–4 concrete, visual nouns ("server room racks", not "compute") and a "kind" (video preferred, image for a still idea)`;
  const aiPick = `a "generate": { "kind": "image|video", "prompt": "..." } — a picture made to order. Write the prompt like a cinematographer's brief: one clear subject, setting, light, lens, mood, 15–40 words, vertical, composed for a two-second glance (no busy scenes, never any text or logos). It is generated to match the footage's lighting and palette and checked by the harness before use — one that would look cheap is dropped. "video" for motion (5–8 s, a slow move), "image" for a still the cutaway will drift over. A generated video takes minutes: its still is placed now and the motion swaps in when it is ready.`;
  const cutawaySource =
    brief.assets === "ai"
      ? `${libraryPick}, otherwise ${aiPick}`
      : brief.assets === "both"
        ? `${libraryPick}, otherwise ${brief.stock ? `${stockPick} for real-world footage (a place, an object, a crowd), or ` : ""}${aiPick} for anything stylised, abstract, or that stock will not have`
        : brief.assets === "stock" && brief.stock
          ? `${libraryPick}, otherwise ${stockPick}`
          : brief.media.length
            ? `a library "asset" id only (no stock search or generation for this pass)`
            : `nothing — there is no library media and no stock search, so return "cutaways": []`;
  const seen = brief.sense
    ? `\nWHAT THE HARNESS SAW AND HEARD (it watched this exact window; times are clip-relative):
Overall: ${brief.sense.overall}
Hook: ${brief.sense.hook}
Payoff: ${brief.sense.payoff}
Audio: ${brief.sense.audio}
Shots: ${brief.sense.shots.map((shot) => `${shot.start.toFixed(1)}–${shot.end.toFixed(1)} ${shot.framing} (energy ${shot.energy})${shot.note ? ` — ${shot.note}` : ""}`).join("; ")}
Visible moments to cut on: ${brief.sense.moments.map((moment) => `${moment.t.toFixed(1)} ${moment.what} → ${moment.use}`).join("; ") || "(none)"}
B-roll that would earn its place: ${brief.sense.broll.map((idea) => `${idea.t.toFixed(1)} ${idea.idea} [${idea.query}]`).join("; ") || "(none)"}
`
    : "";
  const musicCatalogue = brief.music.length
    ? brief.music
        .map(
          (bed) =>
            `${bed.id} — "${bed.label}" ${bed.durationSec.toFixed(0)}s${bed.line ? ` — ${bed.line}` : ""}${bed.bpm ? ` ${bed.bpm} BPM` : ""}${bed.energy ? ` energy ${bed.energy}/5` : ""}${bed.suits?.length ? ` suits: ${bed.suits.join(", ")}` : ""}`
        )
        .join("\n")
    : "(none)";
  const generateBed = ` { "generate": { "prompt": "..." }, ... } with a music brief (genre, mood, tempo, instrumentation, 15–40 words, instrumental) in place of "asset"`;
  const musicSource = brief.composeMusic
    ? ` THE CREATOR ASKED FOR MUSIC MADE TO ORDER: lay one bed as${generateBed}, written for this clip's tone, energy and pacing (it is generated, kept in the library for later, and replaces the catalogue pick) — unless the notes name a catalogue track.`
    : brief.assets === "ai" || brief.assets === "both"
      ? ` A bed may also be made to order:${generateBed} — only when nothing in the catalogue fits the clip's tone (a bed made on an earlier pass is in the catalogue: reuse it when it fits).`
      : "";
  const musicRules = brief.wantsMusic
    ? `- Music (lane "music"): 0–2 beds under the voice, on the OUTPUT clock like SFX. Pick by what the catalogue says the bed sounds like, matched to the genre, the speaker's energy and the harness's read of the tone — a calm story wants a low-energy pad, a hype peak a driving loop. Usually one bed for the whole clip at level 0.15–0.3 with dip 0.55–0.8 so it sits under speech; a second bed can take over at the peak (in at the peak punch, the first going out there) for a lift. Set "offset" to start a bed past a quiet intro. No music when the source already has music (see Audio) or the genre is music/performance.${musicSource}`
    : `- Music: leave the "music" key out of your answer (this pass does not lay music).`;
  const lessons = brief.lessons.length
    ? `\nWHAT THIS CREATOR LIKES (learned from their edits, their feedback and reviewed renders — follow these over the default rules below):\n${describeLessons(brief.lessons)}\n`
    : "";

  return `You are the editor of a short-form vertical clip (a YouTube Short / Reel). You write the BEAT PLAN a professional editor would build for retention: tighten dead air, punch the camera in on the lines that matter, let the camera ride the speaker, style the captions per scene, put a hook title behind the speaker for the first beat, drop sound effects on every move, lay a music bed that serves the voice — and, where they earn it, slow motion, looks and B-roll cutaways.${brief.sense ? " You have WATCHED the clip: use what you saw (a gesture, a look, a laugh, a prop, a cut in the source) to time and choose the beats, not only the words." : ""}
${notes}${turns}${lessons}${brief.knowledge ? `\n${brief.knowledge}\n` : ""}
Genre: ${brief.genre.label} — ${brief.genre.summary}${
    brief.captions ? `\nClip captions (wherever no caption scene is set): look ${brief.captions.styleId}, ${brief.captions.chunkWords} word${brief.captions.chunkWords === 1 ? "" : "s"} at a time. A scene without "chunkWords" uses its own look's count instead.` : ""
  }
Clip length: ${brief.duration.toFixed(1)}s. All times below and in your answer are CLIP-RELATIVE SOURCE seconds (0 = the first frame), even inside slow motion.
The mined PEAK (the payoff line) is at ${brief.peak.at.toFixed(2)}s${brief.peak.line ? `: "${brief.peak.line}"` : ""}.
Shot changes (camera cuts in the source) at: ${cuts}.
${face}

WORDS (onset word | onset word …):
${words}
${brief.lines?.length ? `\nLINES (cue start, full wording — the WORDS grid misses some words; a word missing there is spoken inside its line here, so time it from the line's start and its neighbours):\n${brief.lines.map((line) => `${line.t.toFixed(2)} ${line.text}`).join("\n").slice(0, 6000)}\n` : ""}
DEAD AIR CANDIDATES (id start–end, seconds saved):
${pauses}
${seen}
CAPTION LOOKS (id — summary): ${brief.styles.map((style) => `${style.id} — ${style.summary}`).join("; ")}
FONTS: ${brief.fonts.join(", ")}
SOUND EFFECTS (id — label — what it sounds like): ${brief.sfx.map((sound) => `${sound.id} — ${sound.label}${sound.line ? ` — ${sound.line}` : ""}`).join("; ")}
MUSIC BEDS (id — label — what it sounds like):
${musicCatalogue}
EFFECTS (id (group) — summary): ${effects}
TRANSITIONS (for cutaways): ${brief.transitions.map((item) => `${item.id} — ${item.summary}`).join("; ")}
CUTAWAY MOTIONS: none, in (slow push in), out (slow pull out), left, right, up, down (drifts)
MEDIA LIBRARY (id — kind "label"):
${media}
${current}
${keep}

EDITING RULES
- The first 2 seconds decide everything. Open with a "pull" camera move (start tight, settle) or a hard "punch", a hook caption scene, and a short TITLE (2–4 words, a curiosity gap, NOT the first caption's words) behind the speaker.
- Cut dead air: apply the candidates that save ≥ 0.25s unless the pause is a deliberate dramatic beat before the peak. When the notes ask to remove dead air, pauses, silences or unnecessary cuts, apply EVERY candidate, however short, except a deliberate beat right before the peak line.
- Camera: 3–7 moves total for a 30–45s clip. "punch" on the peak line and on 1–3 other strong lines (zoom 1.15–1.3, anchor "face", ease "cut" for impact or "out" for a softer landing). A "push" (slow creep, zoom 1.08–1.14) under a build-up. Never overlap moves; leave at least 0.8s between them. follow.enabled true for talking-head footage: it pins the head and lets the room drift, so use tightness 0.7–0.9 and zoom 1.12–1.22 (below 1.08 there is no room to pin). follow.response is how fast the camera answers the head: "snappy" rides every nod (energetic, animated speakers), "natural" (default) keeps leans, "smooth" keeps only posture (calm, interview). follow.axis "both" unless the footage only moves one way. follow.lead 0–1 leans the frame toward where the speaker faces (0.3–0.6 for someone talking to an off-camera host).
- A "frame" move sets a framing and holds it to its end: "pan" { x, y } moves the 9:16 window over the wider source, −1..1 of the room either side (x −1 shows the source's left edge, +1 its right; ${brief.verticalPan ? "y moves it up (−) or down (+)" : "y has no room on this 16:9 source, keep it 0"}); "zoom" is where it ends, "zoomFrom" where it starts (zoomFrom 1.3 → zoom 1 is a reveal: a zoom OUT, down to 0.75 shows past the follow zoom), "rampSec" how long it takes to get there (0.3–0.8). Use it to show what the speaker looks or points at (pan toward the side they face), or for a reveal. anchor "look" converges ahead of the face, the way it faces.
- A "hold" move locks the camera off for its span: the follow stops riding the head (at the move's zoom, 1 for none) and glides back after. Use it for a still, weighty beat — a stare, a pause before the payoff — on an animated speaker; 1–3s.
- Speed (lane "speed"): the voice FADES OUT during slow motion and a freeze (music and SFX carry on), so only on a beat that carries without words — a reaction, a gesture, the breath after the payoff — ≤ 1.2s, rate 0.4–0.6, never on the hook words (first 2s) and never over a word the line needs. "freeze" 0.3–0.8s on a punchline reaction. "fast" (1.5–2×, voice kept) only to rush a setup. At most 1 speed span unless the notes ask. "smooth": true only for motion (a gesture, a head turn). "captions": true keeps captions on through it.
- Effects (lane "effects"): accents, not wallpaper — at most 3 per 30s, one look per caption scene, amount 0.4–0.8. Glitch/strobe/flicker/rgbsplit/shake/pulse are 0.2–1s hits on a cut, a punch or a hard word; colour and texture looks (bw, vhs, oldfilm…) can hold a short scene (a flashback, an "old way" line). Never cover the whole clip unless the notes ask.
- Cutaways (lane "cutaways"): B-roll laid over the speaker while the voice runs on. At most 2 per clip, 1.2–3s each, starting on the onset of the word that names what is shown, never in the first 1.5s and never over the peak line. Media: ${cutawaySource}. Transitions ≤ 0.4s ("dissolve" or "cut" by default; a slide or zoom for energy). fit "cover" for portrait media, "blur" for a wide shot you want to see whole.
- Caption scenes: 2–4 scenes. The hook (first 2–4s) big and bold; the peak line its own scene with highlight "word" and a warm accent; the rest calm. Scenes must not overlap.
- Titles (lane "titles", the creator's own text on screen, separate from the transcript captions): exactly 1 (the hook, 0–2.5s) unless the notes ask for more, depth "behind", placed where it peeks out around the head: y between the face's y and 0.62, large (sizeScale 1.6–2.4), uppercase. A second title only for a payoff punchline. "animation" is how it arrives: pop, fade, rise, zoom_in (grows from small), zoom_out (shrinks from big), slide_left / slide_right / slide_up / slide_down, drop, words (word by word); "exit" how it leaves: none, fade, pop, zoom_in, zoom_out, slide_left / slide_right / slide_up / slide_down, sink; "motion" while on screen: none, grow, shrink, pulse, wiggle, float. Default "pop" in, "fade" out, no motion; a punchline can "zoom_out" in and "pulse".
- SFX: a whoosh-type sound on each camera move start (gain 0.6–0.9), a riser 0.6s before the peak punch, a low impact on the peak, a pop on the hook title's start, a tick on each applied cut (optional), a whoosh on a cutaway's arrival — choose by what each sound IS in the catalogue, including the creator's own uploads. At most ${MAX_SOUNDTRACK_HITS} hits.${brief.freesound ? ` A sound the catalogue lacks that the picture calls for (glass shattering, a door slam, a coin drop, a crowd gasp) may be a { "query": "2–4 concrete words", "at": …, "gain": … } instead of an "asset": it is searched in Freesound, listened to, and only placed if the recording is clean — at most 3 per pass, and never for a plain whoosh, hit or tick the catalogue already has.` : ""}
${musicRules}
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
  "sfx": [{ "asset": "swoosh", "at": 0.0, "gain": 0.8 }],
  "music": [{ "asset": "warm", "level": 0.22, "dip": 0.65, "in": 0, "out": null, "offset": 0 }]
}
(A cutaway from the library carries "asset": "<library id>" in place of "query" and "kind"; a generated one carries "generate". A bed's "out" is null for the end of the clip.)${brief.mayAsk ? DECIDE_INSTRUCTION : ""}`;
}

/**
 * In Auto, a note that leaves the direction open may be answered with
 * questions instead of a plan. Offered only when stopping can make sense:
 * there is a note, it did not say go ahead, and no proposal is being answered.
 */
export const DECIDE_INSTRUCTION = `

STOP AND ASK INSTEAD — only when the creator's notes leave a real fork in direction that the brief cannot settle and a wrong guess would waste the pass (two very different tones, asks that pull against each other, a change of direction with several distinct ways to go). Precise requests, anything the rules or the lessons settle, and small choices are NEVER a reason to stop: make the call yourself and cut. When you do stop, return ONLY:
{ "decide": { "why": "3–8 words on what forks", "proposal": "...", "asks": [...] } }
"proposal": ${PROPOSAL_FORMAT}
"asks": ${ASK_FORMAT}`;

/** In plan mode the same brief ends here instead of with the plan's JSON shape. */
export const PLAN_MODE_INSTRUCTION = `

PLAN FIRST — do NOT write the plan yet. Read the brief, then answer as the editor talking to the creator before touching the timeline.
Return ONLY JSON: { "proposal": "...", "asks": [...] }
"proposal": ${PROPOSAL_FORMAT}
"asks": ${ASK_FORMAT}`;

/** The brief with the plan's JSON shape replaced by the proposal's: the rules stay, the answer changes. */
export function planPrompt(fullPrompt: string): string {
  const cut = fullPrompt.indexOf("Return ONLY JSON, no prose, with this shape");
  return (cut > 0 ? fullPrompt.slice(0, cut) : fullPrompt) + PLAN_MODE_INSTRUCTION;
}

/** A proposal: what it would do, and its questions with options (an older answer's plain questions too). */
export function parsePlanProposal(text: string): { proposal: string; asks: DirectorAsk[]; questions: string[]; why?: string } | null {
  const raw = extractJson(text) as unknown as Record<string, unknown> | null;
  if (!raw || typeof raw.proposal !== "string" || !raw.proposal.trim()) return null;
  const asks = cleanDirectorAsks(Array.isArray(raw.asks) && raw.asks.length ? raw.asks : raw.questions);
  const why = typeof raw.why === "string" && raw.why.trim() ? raw.why.trim().slice(0, 160) : undefined;
  return { proposal: raw.proposal.trim().slice(0, 1200), asks, questions: asks.map((ask) => ask.question), ...(why ? { why } : {}) };
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
  /** Which of those are stills: a still never sits static, it drifts. */
  stillIds?: Set<string>;
  /** Music beds the plan may lay, and the ones already on the clip. */
  musicIds?: Set<string>;
  currentBeds?: MusicBed[];
  windowsOutput: (sourceSec: number) => number;
}): { plan: CreatorPlan; sfx: SoundtrackHit[]; beds: MusicBed[]; summary: string } {
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
        motion:
          CUTAWAY_MOTIONS.includes(cutaway.motion as Cutaway["motion"]) && !(cutaway.motion === "none" && input.stillIds?.has(String(cutaway.asset)))
            ? (cutaway.motion as Cutaway["motion"])
            : "in",
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

  // ---- music beds: on the OUTPUT clock, like SFX; the creator's own beds stay ----
  let beds = input.currentBeds ?? [];
  if (rewrite("music", "music")) {
    const users = beds.filter((bed) => !bed.id.startsWith("dir_"));
    const musicIds = input.musicIds ?? new Set<string>();
    // A track the creator already laid is not laid again: it would play on top of itself.
    const playing = new Set(users.map((bed) => bed.assetId));
    const placed: MusicBed[] = list(answer.music)
      .filter((bed) => typeof bed.asset === "string" && musicIds.has(bed.asset as string) && !playing.has(bed.asset as string))
      .slice(0, MAX_MUSIC_BEDS)
      .map((bed, index) => {
        const inSec = round3(Math.max(0, input.windowsOutput(abs(num(bed.in) ?? 0, false))));
        const outRaw = num(bed.out);
        const outSec = outRaw != null && outRaw > 0 ? round3(Math.max(inSec + 0.5, input.windowsOutput(abs(outRaw, false)))) : undefined;
        const out: MusicBed = {
          id: newId("bed", index),
          assetId: String(bed.asset),
          gain: round3(Math.max(0, Math.min(1, num(bed.level ?? bed.gain) ?? DEFAULT_BED_GAIN))),
          dip: round3(Math.max(0, Math.min(1, num(bed.dip) ?? DEFAULT_BED_DIP))),
        };
        if (inSec > 0.0005) out.inSec = inSec;
        if (outSec != null) out.outSec = outSec;
        const offset = num(bed.offset ?? bed.offsetSec);
        if (offset != null && offset > 0) out.offsetSec = round3(offset);
        return out;
      });
    beds = [...users, ...placed].slice(0, MAX_MUSIC_BEDS);
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
  return { plan, sfx, beds, summary };
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
  /** Absent when this pass may not generate. Makes a still now; a video is a job that swaps in later. */
  generate?: (prompt: string, kind: "image" | "video") => Promise<{ asset: MediaAsset; pendingVideo?: boolean }>;
}): Promise<{ cutaways: Record<string, unknown>[]; assets: MediaAsset[]; warnings: string[]; pending: { assetId: string; prompt: string }[] }> {
  const raw = Array.isArray(input.cutaways) ? (input.cutaways as unknown[]).slice(0, MAX_CUTAWAYS) : [];
  const byId = new Map(input.library.map((asset) => [asset.id, asset]));
  const fetched = new Map<string, Promise<MediaAsset>>();
  const assets: MediaAsset[] = [];
  const warnings: string[] = [];
  const pending: { assetId: string; prompt: string }[] = [];
  let generated = 0;

  const cutaways = await Promise.all(
    raw
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map(async (item) => {
        const out: Record<string, unknown> = { ...item };
        if (typeof item.asset === "string" && byId.has(item.asset)) return out;
        delete out.asset;
        const wanted = item.generate as Record<string, unknown> | undefined;
        const prompt = wanted && typeof wanted.prompt === "string" ? wanted.prompt.trim().slice(0, 600) : "";
        if (prompt && input.generate) {
          if (generated >= MAX_GENERATED_PER_PASS) {
            warnings.push(`Only ${MAX_GENERATED_PER_PASS} pictures are generated per pass; "${prompt.slice(0, 40)}…" was left out.`);
            return out;
          }
          generated++;
          const kind = wanted!.kind === "video" ? "video" : "image";
          try {
            const made = await input.generate(prompt, kind);
            assets.push(made.asset);
            out.asset = made.asset.id;
            if (made.pendingVideo) pending.push({ assetId: made.asset.id, prompt });
            return out;
          } catch (error: unknown) {
            warnings.push(`Could not generate "${prompt.slice(0, 40)}…" (${getErrorMessage(error)}), so that cutaway was left out.`);
            return out;
          }
        }
        const query = typeof item.query === "string" ? item.query.trim().slice(0, 80) : prompt.split(/[,.]/)[0]?.trim().slice(0, 80) ?? "";
        if (!query) {
          warnings.push("A cutaway named no media it could use, so it was left out.");
          return out;
        }
        const kind = item.kind === "image" ? "image" : "video";
        let reason = prompt ? "generation is off for this pass" : "no stock search is configured";
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
  return { cutaways, assets, warnings, pending };
}

/** Pictures a single pass may generate (a still is ~10 s and a few cents; a video is minutes). */
export const MAX_GENERATED_PER_PASS = 3;
/** Sounds a single pass may look up on Freesound (each is a search, a download and a listen). */
export const MAX_FOUND_SFX_PER_PASS = 3;

/**
 * Hits the answer asked to have found: each `query` becomes a library sound
 * before the plan is applied, or is dropped with a warning. Same query, one
 * lookup.
 */
export async function resolveDirectorSfx(input: {
  sfx: unknown;
  sfxIds: Set<string>;
  findSound?: (query: string) => Promise<AudioAsset>;
}): Promise<{ sfx: Record<string, unknown>[]; assets: AudioAsset[]; warnings: string[] }> {
  const raw = Array.isArray(input.sfx) ? (input.sfx as unknown[]).slice(0, MAX_SOUNDTRACK_HITS) : [];
  const assets: AudioAsset[] = [];
  const warnings: string[] = [];
  const found = new Map<string, Promise<AudioAsset>>();
  const sfx: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const hit = { ...(item as Record<string, unknown>) };
    if (typeof hit.asset === "string" && input.sfxIds.has(hit.asset)) {
      sfx.push(hit);
      continue;
    }
    const query = typeof hit.query === "string" ? hit.query.trim().slice(0, 80) : "";
    if (!query) {
      warnings.push(`A hit named a sound not in the catalogue${typeof hit.asset === "string" ? ` ("${hit.asset}")` : ""}, so it was left out.`);
      continue;
    }
    if (!input.findSound) {
      warnings.push(`The "${query}" hit needs Freesound (FREESOUND_API_KEY), so it was left out.`);
      continue;
    }
    const key = query.toLowerCase();
    if (!found.has(key)) {
      if (found.size >= MAX_FOUND_SFX_PER_PASS) {
        warnings.push(`Only ${MAX_FOUND_SFX_PER_PASS} sounds are looked up per pass; "${query}" was left out.`);
        continue;
      }
      found.set(key, input.findSound(query));
    }
    try {
      const asset = await found.get(key)!;
      if (!assets.some((known) => known.id === asset.id)) assets.push(asset);
      hit.asset = asset.id;
      delete hit.query;
      sfx.push(hit);
    } catch (error: unknown) {
      warnings.push(`No clean sound for "${query}" (${getErrorMessage(error)}), so that hit was left out.`);
    }
  }
  return { sfx, assets, warnings };
}

/**
 * Beds the answer asked to have made: each `generate` becomes a real
 * library track before the plan is applied (Lyria answers in ~15–40 s).
 */
export async function resolveDirectorMusic(input: {
  music: unknown;
  musicIds: Set<string>;
  generate?: (prompt: string) => Promise<AudioAsset>;
  /** A track library to search by query, when one is configured. */
  findTrack?: (query: string, bpm: { min?: number; max?: number }) => Promise<AudioAsset>;
}): Promise<{ music: Record<string, unknown>[]; assets: AudioAsset[]; warnings: string[] }> {
  const raw = Array.isArray(input.music) ? (input.music as unknown[]).slice(0, MAX_MUSIC_BEDS) : [];
  const assets: AudioAsset[] = [];
  const warnings: string[] = [];
  let generated = 0;
  const music: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const bed = { ...(item as Record<string, unknown>) };
    if (typeof bed.asset === "string" && input.musicIds.has(bed.asset)) {
      music.push(bed);
      continue;
    }
    const query = typeof bed.query === "string" ? bed.query.trim().slice(0, 120) : "";
    if (query && input.findTrack) {
      try {
        const asset = await input.findTrack(query, { min: num(bed.bpmMin), max: num(bed.bpmMax) });
        assets.push(asset);
        bed.asset = asset.id;
        delete bed.query;
        music.push(bed);
      } catch (error: unknown) {
        warnings.push(`No track for "${query}" (${getErrorMessage(error)}).`);
      }
      continue;
    }
    const wanted = bed.generate as Record<string, unknown> | undefined;
    const prompt = wanted && typeof wanted.prompt === "string" ? wanted.prompt.trim().slice(0, 600) : "";
    if (!prompt || !input.generate) {
      warnings.push(prompt ? "A bed asked to be generated, but generation is off for this pass." : query ? `The "${query}" bed named no track in the catalogue, so it was left out.` : "A bed named no track in the catalogue, so it was left out.");
      continue;
    }
    if (generated >= 1) {
      warnings.push("Only one bed is generated per pass.");
      continue;
    }
    generated++;
    try {
      const asset = await input.generate(prompt);
      assets.push(asset);
      bed.asset = asset.id;
      music.push(bed);
    } catch (error: unknown) {
      warnings.push(`Could not generate the bed "${prompt.slice(0, 40)}…" (${getErrorMessage(error)}).`);
    }
  }
  return { music, assets, warnings };
}

/** The clip's stored turns, field by field: the stored plan is a mongoose subdocument. */
function storedTurns(current: CreatorPlan | undefined): DirectorTurn[] {
  return (current?.director?.turns ?? []).map((turn) => ({
    ...(turn.notes ? { notes: turn.notes } : {}),
    summary: turn.summary,
    at: turn.at,
    ...(turn.kind === "plan" ? { kind: "plan" as const, ...(turn.questions?.length ? { questions: turn.questions } : {}) } : {}),
    ...(turn.kind === "plan" && turn.asks?.length ? { asks: cleanDirectorAsks(JSON.parse(JSON.stringify(turn.asks))) } : {}),
    ...(turn.kind === "reply" ? { kind: "reply" as const } : {}),
    ...(turn.kind === "undo" ? { kind: "undo" as const } : {}),
    ...(turn.changed ? { changed: [...turn.changed] } : {}),
    ...(turn.undone ? { undone: true } : {}),
  }));
}

const plainCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The latest pass still standing, and the edit as it was before it when that was kept. */
function standingPass(turns: DirectorTurn[], kept: DirectorUndo[] | undefined): { index: number; turn: DirectorTurn; before?: DirectorUndo } | undefined {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if ((turn.kind && turn.kind !== "pass") || turn.undone) continue;
    return { index, turn, ...(kept?.some((item) => item.at === turn.at) ? { before: kept.find((item) => item.at === turn.at) } : {}) };
  }
  return undefined;
}

/**
 * Take back the Director's latest standing pass: its lanes, hits, beds and
 * caption length go back to how they were before it. The conversation keeps
 * the pass, marked taken back, so the next pass knows not to bring it back.
 * A pass taken back makes the one before it the next to take back.
 */
export async function undoDirectorPass(clipId: string, notes?: string, options: { turn?: boolean } = {}): Promise<{ clip: IClip; summary: string }> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");
  const current = clip.edit?.creator;
  const turns = storedTurns(current);
  const kept = plainCopy((clip.directorUndo ?? []) as DirectorUndo[]);
  const standing = standingPass(turns, kept);
  if (!standing) throw new Error("There is no pass of the Director's left to take back.");
  if (!standing.before) throw new Error("That pass was made before passes could be taken back — change it with a note instead.");
  const before = standing.before;
  const asked = standing.turn.notes;
  const summary = `Took back ${asked ? `“${asked.length > 90 ? `${asked.slice(0, 90)}…` : asked}”` : "the last pass"} — the edit is as it was before it.`;
  const plain = current ? plainCreatorPlan(current as unknown as Record<string, unknown>) : undefined;
  const director = {
    ...(plain?.director ?? {}),
    turns: [
      ...turns.map((turn, index) => (index === standing.index ? { ...turn, undone: true } : turn)),
      ...(options.turn === false ? [] : [{ ...(notes ? { notes: notes.slice(0, 600) } : {}), summary, at: new Date().toISOString(), kind: "undo" as const }]),
    ].slice(-MAX_DIRECTOR_TURNS),
  };
  const overrides = clip.edit?.captionOverrides ? (plainCopy(clip.edit.captionOverrides) as Record<string, unknown>) : {};
  const chunkChanged = overrides.chunkWords !== before.chunkWords;
  if (before.chunkWords === undefined) delete overrides.chunkWords;
  else overrides.chunkWords = before.chunkWords;
  const updated = await updateClipEdit(clipId, {
    edit: {
      creator: { ...(before.creator ?? { enabled: false, version: 1 as const }), director },
      soundtrack: { ...(clip.edit?.soundtrack ? plainCopy(clip.edit.soundtrack) : {}), sfx: before.sfx, beds: before.beds },
      // An empty map resets the clip to its look.
      ...(chunkChanged ? { captionOverrides: overrides as NonNullable<typeof clip.edit>["captionOverrides"] } : {}),
    },
  });
  await Clip.updateOne(
    { _id: clipId },
    {
      $set: { directorUndo: kept.filter((item) => item.at !== standing.turn.at), ...(before.directed ? { directed: before.directed } : {}) },
      ...(before.directed ? {} : { $unset: { directed: 1 } }),
    }
  );
  console.log(`🎬 Took back a pass on clip ${clip.rank} (${standing.turn.at})`);
  return { clip: updated, summary };
}

export async function directClip(
  clipId: string,
  input: DirectInput = {},
  progress: DirectorProgress = () => {},
  /** A note that also took the last pass back: its reading, carried into the pass on the edit as it was. */
  carried?: { request: Awaited<ReturnType<typeof readRequest>>; tookBack: string }
): Promise<DirectResult> {
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
  // Dead air is found while the note is read below.
  const pausesFound = detectClipPauses(clipId, { startSec: trimStart, endSec: trimEnd }).catch(() => null);
  const track: ReframeTrack | undefined = clip.reframeTrack?.track;
  const cuts = (track?.cuts ?? [])
    .map((cut) => round3(cut + (track?.originSec ?? 0) - trimStart))
    .filter((cut) => cut > 0.1 && cut < duration - 0.1);
  const faceAtHook = faceAnchorAt(track, trimStart + 0.5);
  const facePresence = track?.keyframes.filter((key) => key.fx != null).length ?? 0;
  const firstFace = track?.keyframes.find((key) => key.fw != null);
  const faceWidth = firstFace?.fw && firstFace.width ? Math.min(0.9, firstFace.fw / firstFace.width) : 0.3;
  const profile = resolveGenreProfile(project.genreId);
  const stock = stockSources().length > 0;
  const warnings: string[] = [];
  // The note outranks the panel: it is read first, and switches the B-roll
  // source, music, watching, locks — and between proposing and cutting —
  // wherever it asks.
  const knowledge = editorKnowledge();
  const current = clip.edit?.creator;
  const previousTurns = storedTurns(current);
  // The edit as it stands, lane by lane: what a pass changes, and what the creator changed by hand, are read against it.
  const plainCurrent = current ? plainCreatorPlan(current as unknown as Record<string, unknown>) : undefined;
  const currentBeds = musicBeds(clip.edit?.soundtrack);
  const lanesNow = describePlanLanes(plainCurrent, clip.edit?.soundtrack?.sfx, trimStart, new Map(), currentBeds);
  const standing = standingPass(previousTurns, clip.directorUndo);
  // The editor saves before every pass, so whatever differs from the Director's last pass is the creator's own hand.
  const handEdited =
    clip.directed?.plan && standing && clip.directed.at === standing.turn.at
      ? changedLanes(describePlanLanes(plainCopy(clip.directed.plan), clip.directed.sfx, trimStart, new Map(), clip.directed.beds ?? []), lanesNow)
      : [];
  // A question asked while a proposal waits is answered in between; the proposal still waits.
  const last = [...previousTurns].reverse().find((turn) => turn.kind !== "reply" && turn.kind !== "undo");
  const waiting =
    last?.kind === "plan" ? { proposal: last.summary, asks: last.asks ?? (last.questions ?? []).map((question) => ({ question, options: [] })) } : undefined;
  // Answers picked for a waiting proposal travel with the note: in full to
  // the models, in short on the turn.
  const answers = (input.answers ?? []).filter((item) => item.question?.trim() && item.choice?.trim());
  const typed = input.notes?.trim() || undefined;
  const notesForModel =
    [typed, answers.length ? `My answers to your questions: ${answers.map((item) => `${item.question.trim()} → ${item.choice.trim()}`).join("; ")}` : ""]
      .filter(Boolean)
      .join("\n") || undefined;
  const turnNotes = [typed, answers.length ? `Picked: ${answers.map((item) => item.choice.trim()).join(" · ")}` : ""].filter(Boolean).join(" — ").slice(0, 600) || undefined;
  if (notesForModel && !carried) progress({ type: "step", id: "read", state: "run", label: "Reading your note" });
  // The note is read in the light of the conversation and the edit as it stands.
  const context =
    notesForModel && !carried
      ? {
          turns: previousTurns,
          plan: describeCurrentPlan(
            plainCurrent,
            clip.edit?.soundtrack?.sfx,
            trimStart,
            // Names, not ids: the reader answers the creator in words.
            new Map(
              (
                await Promise.all([
                  listCustomAudio().catch(() => [] as AudioAsset[]),
                  plainCurrent?.cutaways?.length ? listMediaAssets().catch(() => [] as MediaAsset[]) : Promise.resolve([] as MediaAsset[]),
                ])
              )
                .flat()
                .concat(listBuiltinAudio())
                .map((asset): [string, string] => [asset.id, asset.label])
            ),
            currentBeds,
            trimEnd
          ),
          undoable: Boolean(standing?.before),
        }
      : undefined;
  const request =
    carried?.request ??
    (await readRequest(
      notesForModel,
      {
        assets: input.assets ?? (stock ? "stock" : "library"),
        music: input.music !== false,
        see: input.see !== false,
        keep: (input.keep ?? []).filter((lane): lane is DirectorLane => DIRECTOR_LANES.includes(lane)),
        plan: input.plan === true,
      },
      stock,
      knowledge,
      waiting,
      context
    ));
  if (request.warning) warnings.push(request.warning);
  const { assets, keep, followed, wordsPerLine, mayAsk } = request.pass;
  const wantsMusic = request.pass.music;
  const see = request.pass.see;
  const planFirst = request.pass.plan;
  if (notesForModel && !carried) {
    progress({
      type: "step",
      id: "read",
      state: request.warning ? "fail" : "done",
      label: "Read your note",
      detail:
        request.warning ??
        (request.pass.undo
          ? request.pass.edits
            ? "Take the last pass back, then the rest of the note"
            : "Take the last pass back"
          : !request.pass.edits && request.pass.reply
            ? "A question — nothing to change"
            : followed.length
              ? followed.join(" · ")
              : "The panel settings stand"),
    });
  }

  // "Undo that" takes the last pass back first; whatever else the note asks is
  // then a pass on the edit as it was.
  if (request.pass.undo && !carried) {
    progress({ type: "step", id: "undo", state: "run", label: "Taking back the last pass" });
    let undone: Awaited<ReturnType<typeof undoDirectorPass>> | undefined;
    try {
      undone = await undoDirectorPass(clipId, turnNotes, { turn: !request.pass.edits });
      progress({ type: "step", id: "undo", state: "done", label: "Took back the last pass", detail: undone.summary });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      progress({ type: "step", id: "undo", state: "fail", label: "Could not take it back", detail: message });
      if (request.pass.edits) warnings.push(message);
      else request.pass.reply = message;
    }
    if (undone && !request.pass.edits) return { clip: undone.clip, summary: undone.summary, model: directorModel(), warnings, pending: [], followed: [] };
    if (undone) return directClip(clipId, input, progress, { request, tookBack: undone.summary });
  }

  if (!request.pass.edits && request.pass.reply) {
    // A note that only asks something is answered; the clip stays as it is.
    const plain = current ? plainCreatorPlan(current as unknown as Record<string, unknown>) : undefined;
    const summary = request.pass.reply;
    const director = {
      ...(plain?.director?.summary ? { summary: plain.director.summary } : {}),
      ...(plain?.director?.generatedAt ? { generatedAt: plain.director.generatedAt } : {}),
      notes: turnNotes,
      model: directorModel(),
      turns: [...previousTurns, { ...(turnNotes ? { notes: turnNotes } : {}), summary, at: new Date().toISOString(), kind: "reply" as const }].slice(-MAX_DIRECTOR_TURNS),
    };
    const updated = await updateClipEdit(clipId, {
      edit: { creator: { ...(plain ?? { enabled: false, version: 1 as const }), director } },
    });
    console.log(`🎬 Answered a question on clip ${clip.rank} of ${project._id} (${directorModel()})`);
    return { clip: updated, summary, model: directorModel(), warnings, pending: [], followed: [] };
  }

  // The harness looks and listens first: the clip (cached per trim), and
  // every sound and picture it has not described yet.
  const lookStarted = Date.now();
  progress({ type: "step", id: "look", state: "run", label: see ? "Watching the clip, listening to the library" : "Listening to the library" });
  const [candidates, sense, catalogue, lessons] = await Promise.all([
    pausesFound.then((found) => found?.candidates ?? []),
    see
      ? senseClip(clipId).catch((error: unknown) => {
          warnings.push(`The Director could not watch the clip (${getErrorMessage(error)}); it worked from the words.`);
          return undefined;
        })
      : Promise.resolve(undefined),
    senseLibrary(12).catch(async (error: unknown) => {
      warnings.push(`Some sounds and pictures are not described yet (${getErrorMessage(error)}).`);
      const [builtin, custom, media] = await Promise.all([listBuiltinAudio(), listCustomAudio().catch(() => []), listMediaAssets().catch(() => [])]);
      return { audio: [...builtin, ...custom], media, described: 0, failed: 0 };
    }),
    lessonsFor(String(project._id)).catch(() => [] as DirectorLesson[]),
  ]);
  const sounds = catalogue.audio.filter((asset) => asset.kind === "sfx");
  const beds = catalogue.audio.filter((asset) => asset.kind === "music");
  const library = catalogue.media;
  progress({
    type: "step",
    id: "look",
    state: "done",
    label: see && sense ? "Watched the clip" : "Read the words",
    detail: [
      sense ? `${sense.shots.length} shots, ${sense.moments.length} moments` : see ? "could not watch — working from the words" : "",
      `${candidates.length} pause${candidates.length === 1 ? "" : "s"}`,
      `${sounds.length} sounds, ${beds.length} beds, ${library.length} pictures${catalogue.described ? ` (${catalogue.described} newly described)` : ""}`,
      lessons.length ? `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}` : "",
      // Cached looks are instant; only real work gets a time.
      Date.now() - lookStarted >= 1000 ? `${((Date.now() - lookStarted) / 1000).toFixed(1)}s` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  });

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
    sfx: sounds.map((sound) => ({ id: sound.id, label: sound.label, line: sound.sense?.line })),
    music: beds.map((bed) => ({
      id: bed.id,
      label: bed.label,
      durationSec: bed.durationSec,
      line: bed.sense?.line,
      bpm: bed.sense?.bpm,
      energy: bed.sense?.energy,
      suits: bed.sense?.suits,
    })),
    effects: effectInfo().map((effect) => ({
      id: effect.id,
      group: effect.group,
      summary: effect.summary,
      variants: effect.variants?.map((variant) => variant.id),
    })),
    transitions: transitionInfo().map(({ id, summary }) => ({ id, summary })),
    media: library
      .slice(0, 40)
      .map((asset) => ({ id: asset.id, kind: asset.kind, label: asset.label, width: asset.width, height: asset.height, durationSec: asset.durationSec, line: asset.sense?.line })),
    stock,
    freesound: freesoundConfigured(),
    assets,
    wantsMusic,
    composeMusic: request.pass.composeMusic,
    sense,
    lessons,
    current: plainCurrent,
    currentSfx: clip.edit?.soundtrack?.sfx,
    currentBeds,
    notes: notesForModel,
    keep,
    turns: previousTurns,
    // Revising a standing pass, not answering a proposal.
    followUp: Boolean(standing) && !waiting,
    touches: request.pass.lanes,
    handEdited,
    knowledge,
    captions: {
      styleId: clip.edit?.captionStyleId ?? "clean",
      chunkWords:
        clip.edit?.captionOverrides?.chunkWords ?? listCaptionStyles().find((style) => style.id === (clip.edit?.captionStyleId ?? "clean"))?.chunkWords ?? 3,
    },
    wordsPerLine,
    followed,
    mayAsk,
  };

  const model = directorModel();
  const startedAt = Date.now();
  // The model gets the clip itself alongside the brief when it can watch,
  // so a beat can land on something it saw, not only on a word.
  const parts: ChatPart[] = [{ type: "text", text: planFirst ? planPrompt(buildDirectorPrompt(brief)) : buildDirectorPrompt(brief) }];
  if (see && sense) {
    const proxy = await proxyClip(await ensureProjectMedia(String(project._id)), trimStart, trimEnd);
    parts.push({ type: "video_url", video_url: { url: await fileDataUrl(proxy, "video/mp4") } });
  }
  const readable = (text: string) => (planFirst ? parsePlanProposal(text) !== null : extractJson(text) !== null);
  const thinkLabel = planFirst ? "Thinking through a proposal" : "Directing";
  progress({ type: "step", id: "think", state: "run", label: thinkLabel });
  // max_tokens covers the thinking as well as the answer: a full plan runs to
  // several thousand tokens after the model has thought, so the ceiling is
  // generous (only what is written is billed). An answer that still comes back
  // cut off or unreadable is asked for once more, thinking less.
  let text = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let written = 0;
    let lastWriting = 0;
    try {
      const result = await chatStream({
        model,
        parts,
        temperature: 0.45,
        maxTokens: planFirst ? 12_000 : 32_000,
        reasoning: attempt === 0 ? "medium" : "low",
        label: "director",
        timeoutMs: 300_000,
        onReasoning: (delta) => progress({ type: "thinking", text: delta }),
        onContent: (delta) => {
          written += delta.length;
          if (Date.now() - lastWriting < 250) return;
          lastWriting = Date.now();
          progress({ type: "writing", chars: written });
        },
      });
      text = result.text;
      const ok = readable(text);
      console.log(
        `🎬 Director answer for clip ${clip.rank}: ${result.finishReason ?? "no finish reason"}, ${result.usage.completionTokens} tokens ` +
          `(${result.usage.reasoningTokens ?? 0} thinking), ${text.length} chars${ok ? "" : " — UNREADABLE"}`
      );
      if (ok) break;
      console.warn(`Director answer unreadable (${result.finishReason}): ${text.slice(0, 200).replace(/\s+/g, " ")} … ${text.slice(-200).replace(/\s+/g, " ")}`);
      if (attempt === 0) {
        progress({
          type: "step",
          id: "think",
          state: "run",
          label: thinkLabel,
          detail: result.finishReason === "length" ? "The answer ran out of room — asking again" : "The answer did not come back as a plan — asking again",
        });
      }
    } catch (error: unknown) {
      if (attempt === 1) throw new Error(`The Director could not reach the model: ${getErrorMessage(error)}`);
      progress({ type: "step", id: "think", state: "run", label: thinkLabel, detail: `The model stalled (${getErrorMessage(error)}) — asking again` });
    }
  }
  progress({ type: "step", id: "think", state: readable(text) ? "done" : "fail", label: thinkLabel, detail: `${((Date.now() - startedAt) / 1000).toFixed(1)}s` });

  // Plan first — or, in Auto, a Director that stopped to ask because the note
  // leaves the direction open — lays out the cut and asks. Nothing is cut:
  // the proposal and its questions become a turn the next pass reads.
  const answer = planFirst ? null : extractJson(text);
  const stopped = mayAsk && answer?.decide ? parsePlanProposal(JSON.stringify(answer.decide)) : null;
  if (planFirst || stopped) {
    const proposal = stopped ?? parsePlanProposal(text);
    if (!proposal) throw new Error("The Director's proposal came back unreadable twice. Try again — the server log has what it sent.");
    if (stopped) followed.push(`Stopped to ask before cutting — ${stopped.why ?? "your note leaves the direction open"}.`);
    const at = new Date().toISOString();
    const summary = proposal.proposal;
    // Field by field off a plain copy: the stored plan is a mongoose subdocument.
    const plain = current ? plainCreatorPlan(current as unknown as Record<string, unknown>) : undefined;
    const director = {
      ...(plain?.director?.summary ? { summary: plain.director.summary } : {}),
      ...(plain?.director?.generatedAt ? { generatedAt: plain.director.generatedAt } : {}),
      notes: turnNotes,
      model,
      turns: [
        ...previousTurns,
        { ...(turnNotes ? { notes: turnNotes } : {}), summary, at, kind: "plan" as const, ...(proposal.asks.length ? { questions: proposal.questions, asks: proposal.asks } : {}) },
      ].slice(-MAX_DIRECTOR_TURNS),
    };
    const updated = await updateClipEdit(clipId, {
      edit: { creator: { ...(plain ?? { enabled: false, version: 1 as const }), director } },
    });
    console.log(
      `🎬 ${stopped ? "Stopped to ask on" : "Planned"} clip ${clip.rank} of ${project._id} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${model}): ${proposal.asks.length} question(s)`
    );
    return { clip: updated, summary, model, warnings, pending: [], sense, questions: proposal.questions, asks: proposal.asks, planned: true, followed };
  }

  if (!answer) throw new Error("The Director's plan came back unreadable twice. Try again — the server log has what it sent.");

  // Stock queries, Freesound lookups and generation requests become library
  // assets before anything is applied — all three at once, since each only
  // touches its own lane.
  const mediaIds = new Set(library.map((asset) => asset.id));
  const stillIds = new Set(library.filter((asset) => asset.kind === "image").map((asset) => asset.id));
  const sfxIds = new Set(sounds.map((sound) => sound.id));
  const musicIds = new Set(beds.map((bed) => bed.id));
  const pending: string[] = [];
  const pendingVideos: { assetId: string; prompt: string }[] = [];
  const mayGenerate = assets === "ai" || assets === "both";
  // A bed may be made to order in AI / Both, or whenever the note asks for one.
  const mayGenerateMusic = mayGenerate || request.pass.composeMusic === true;
  if (!wantsMusic) delete answer.music;
  // Only an item that has to be fetched or made is worth a line in the panel.
  const fetches = (items: unknown, known: Set<string>, key: string) =>
    Array.isArray(items) &&
    items.some((item) => typeof item === "object" && item !== null && !known.has(String((item as Record<string, unknown>)[key])));
  // Every lane is resolved; only one that fetches or makes something shows a step.
  const sourcing = async (
    id: DirectorStepId,
    labels: [string, string],
    shown: boolean,
    run: () => Promise<{ warnings: string[]; found: string }>
  ) => {
    if (shown) progress({ type: "step", id, state: "run", label: labels[0] });
    const result = await run();
    warnings.push(...result.warnings);
    if (shown) {
      progress({ type: "step", id, state: result.found || !result.warnings.length ? "done" : "fail", label: labels[1], detail: [result.found, ...result.warnings].filter(Boolean).join(" · ") });
    }
  };
  const named = (list: { label?: string; id: string }[]) => (list.length ? list.map((asset) => asset.label ?? asset.id).join(", ") : "");
  await Promise.all([
    answer.cutaways !== undefined && !keep.includes("cutaways")
      ? sourcing("broll", ["Finding B-roll", "B-roll"], fetches(answer.cutaways, mediaIds, "asset"), async () => {
          const resolved = await resolveDirectorMedia({
            cutaways: answer.cutaways,
            library,
            findStock: stock && assets !== "ai" && assets !== "library" ? stockForQuery : undefined,
            generate: mayGenerate
              ? async (prompt, kind) => {
                  // A still now, in every case, matched to the footage's look and
                  // checked by the harness; a video is a job that replaces it when done.
                  const still = await generateImageNow(prompt, "9:16", { look: sense?.overall });
                  if (!still) throw new Error("no image came back");
                  return { asset: still, pendingVideo: kind === "video" };
                }
              : undefined,
          });
          answer.cutaways = resolved.cutaways;
          for (const asset of resolved.assets) {
            mediaIds.add(asset.id);
            if (asset.kind === "image") stillIds.add(asset.id);
          }
          pendingVideos.push(...resolved.pending);
          return { warnings: resolved.warnings, found: named(resolved.assets) };
        })
      : undefined,
    answer.sfx !== undefined && !keep.includes("sfx")
      ? sourcing("sound", ["Finding sounds on Freesound", "Sounds"], freesoundConfigured() && fetches(answer.sfx, sfxIds, "asset"), async () => {
          // A sound the catalogue lacks comes from Freesound, when configured.
          const findSound = freesoundConfigured() ? (query: string) => sfxForQuery(query) : undefined;
          const resolved = await resolveDirectorSfx({ sfx: answer.sfx, sfxIds, findSound });
          answer.sfx = resolved.sfx;
          for (const asset of resolved.assets) sfxIds.add(asset.id);
          return { warnings: resolved.warnings, found: named(resolved.assets) };
        })
      : undefined,
    wantsMusic && answer.music !== undefined && !keep.includes("music")
      ? sourcing("music", mayGenerateMusic ? ["Making a music bed", "Music"] : ["Choosing music", "Music"], fetches(answer.music, musicIds, "asset"), async () => {
          const resolved = await resolveDirectorMusic({
            music: answer.music,
            musicIds,
            generate: mayGenerateMusic ? (prompt) => generateMusicNow(prompt) : undefined,
          });
          answer.music = resolved.music;
          for (const asset of resolved.assets) musicIds.add(asset.id);
          return { warnings: resolved.warnings, found: named(resolved.assets) };
        })
      : undefined,
  ]);

  // SFX and beds are placed on the output clock, which depends on the cuts and speed the plan applies.
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
      sfxIds,
      mediaIds,
      stillIds,
      musicIds,
      currentBeds,
      windowsOutput,
    });
  const provisional = applyWith((sourceSec) => sourceSec - trimStart);
  const windows = windowsFor(trimStart, trimEnd, provisional.plan.cuts, provisional.plan.speed);
  const applied = applyWith((sourceSec) => sourceToOutput(windows, sourceSec));
  const { plan, sfx } = applied;

  // Videos still rendering: the still stands in; the job knows which cutaway to fill.
  for (const wanted of pendingVideos) {
    const cutaway = plan.cutaways?.find((item) => item.assetId === wanted.assetId);
    if (!cutaway) continue;
    try {
      const job = await startGeneration({
        kind: "video",
        prompt: wanted.prompt,
        aspectRatio: "9:16",
        durationSec: Math.max(5, Math.min(15, Math.ceil(cutaway.endSec - cutaway.startSec) + 1)),
        fromAssetId: wanted.assetId,
        target: { clipId, cutawayId: cutaway.id },
      });
      if (job.status === "failed") warnings.push(`The video for "${wanted.prompt.slice(0, 40)}…" could not start (${job.error}); its still stays.`);
      else pending.push(`Motion for "${wanted.prompt.slice(0, 40)}…" is rendering; its still stands in until it lands.`);
    } catch (error: unknown) {
      warnings.push(`The video for "${wanted.prompt.slice(0, 40)}…" could not start (${getErrorMessage(error)}); its still stays.`);
    }
  }

  // The model describes what it meant to do; say what could not be done, so
  // the creator and the next pass are not told about a cutaway that is not there.
  const said = warnings.length ? `${applied.summary} (Not done: ${warnings.join(" ")})` : applied.summary;
  const summary = (carried ? `${carried.tookBack} ${said}` : said).slice(0, 1200);
  const notes = turnNotes;
  const at = new Date().toISOString();

  // A note that fixed the caption length holds it everywhere: on every scene
  // (a look's own count would otherwise take over inside it) and on the clip.
  if (wordsPerLine && plan.captionScenes) {
    plan.captionScenes = plan.captionScenes.map((scene) => ({ ...scene, overrides: { ...scene.overrides, chunkWords: wordsPerLine } }));
  }
  // What this pass changed, lane by lane, against the edit it started from.
  const changedNow = changedLanes(lanesNow, describePlanLanes(plan, sfx, trimStart, new Map(), applied.beds));
  const changed = DIRECTOR_LANES.filter(
    (lane) => changedNow.includes(lane) || (lane === "captions" && wordsPerLine !== undefined && wordsPerLine !== clip.edit?.captionOverrides?.chunkWords)
  );
  plan.director = {
    notes,
    summary,
    model,
    generatedAt: at,
    turns: [...previousTurns, { ...(notes ? { notes } : {}), summary: summary || "(no summary)", at, kind: "pass" as const, changed }].slice(-MAX_DIRECTOR_TURNS),
  };
  progress({ type: "step", id: "save", state: "run", label: "Laying it on the timeline" });
  const updated = await updateClipEdit(clipId, {
    edit: {
      creator: plan,
      soundtrack: { ...(clip.edit?.soundtrack ?? {}), sfx, beds: applied.beds },
      ...(wordsPerLine
        ? { captionOverrides: { ...(clip.edit?.captionOverrides ? JSON.parse(JSON.stringify(clip.edit.captionOverrides)) : {}), chunkWords: wordsPerLine } }
        : {}),
    },
  });
  // What was directed, kept apart from what the creator goes on to edit, so
  // the difference can be read as taste when the clip is rendered.
  // And the edit as it was before this pass, so the pass can be taken back.
  const before: DirectorUndo = plainCopy({
    at,
    ...(plainCurrent ? { creator: { ...plainCurrent, director: undefined } } : {}),
    sfx: clip.edit?.soundtrack?.sfx ?? [],
    beds: currentBeds,
    ...(clip.edit?.captionOverrides?.chunkWords !== undefined ? { chunkWords: clip.edit.captionOverrides.chunkWords } : {}),
    ...(clip.directed ? { directed: clip.directed } : {}),
  });
  await Clip.updateOne(
    { _id: clipId },
    { $set: { directed: { plan, sfx, beds: applied.beds, at }, directorUndo: [...plainCopy(clip.directorUndo ?? []), before].slice(-MAX_DIRECTOR_TURNS) } }
  );
  const count = (n: number, one: string, many = `${one}s`) => (n ? `${n} ${n === 1 ? one : many}` : "");
  progress({
    type: "step",
    id: "save",
    state: "done",
    label: "Laid it on the timeline",
    detail:
      [
        count(plan.cuts?.filter((cut) => cut.enabled).length ?? 0, "cut"),
        count(plan.camera?.moves.length ?? 0, "camera move"),
        count(plan.speed?.length ?? 0, "speed change"),
        count(plan.effects?.length ?? 0, "effect"),
        count(plan.cutaways?.length ?? 0, "cutaway"),
        count(plan.captionScenes?.length ?? 0, "caption scene"),
        count(plan.titles?.length ?? 0, "title"),
        count(sfx.length, "hit"),
        count(applied.beds.length, "music bed"),
      ]
        .filter(Boolean)
        .join(" · ") || "nothing changed",
  });
  console.log(
    `🎬 Directed clip ${clip.rank} of ${project._id} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
      `(${model}${see && sense ? ", watched" : ""}, ${catalogue.described} new descriptions, ${lessons.length} lessons): ${plan.cuts?.filter((cut) => cut.enabled).length ?? 0} cuts, ${plan.camera?.moves.length ?? 0} moves, ` +
      `${plan.speed?.length ?? 0} speed, ${plan.effects?.length ?? 0} fx, ${plan.cutaways?.length ?? 0} cutaways, ` +
      `${plan.captionScenes?.length ?? 0} scenes, ${plan.titles?.length ?? 0} titles, ${sfx.length} hits, ${applied.beds.length} beds` +
      ` — changed ${changed.join(", ") || "nothing"}${handEdited.length ? ` — hand-edited since the last pass: ${handEdited.join(", ")}` : ""}` +
      (warnings.length ? ` — ${warnings.join(" ")}` : "")
  );
  return { clip: updated, summary, model, warnings, pending, sense, followed };
}
