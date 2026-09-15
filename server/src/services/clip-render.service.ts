import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import ffmpeg from "fluent-ffmpeg";
import "../config/ffmpeg-bootstrap";
import { config } from "../config";
import { resolveGenreProfile } from "../config/genres";
import {
  resolveCaptionStyle,
  resolveEffectiveCaptionStyle,
  type CaptionStyle,
} from "../config/caption-styles";
import { Clip, ClipProject, type IClip, type IClipProject } from "../models";
import type {
  CaptionScene,
  CleanupRegion,
  CaptionTextOverride,
  CaptionWordOverride,
  ClipSegment,
  CropKeyframe,
  ReframeTrack,
  VideoEffects,
  VttWordTiming,
} from "../types/clip.types";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "../types/clip.types";
import { getErrorMessage, isNodeError } from "../types";
import {
  assVideoFilter,
  createScratchDir,
  deleteFile,
  ensureDir,
  fileExists,
  getFileSize,
  listFiles,
  projectMediaDir,
  projectOutputDir,
  runCommand,
} from "../utils";
import {
  assOptionsFromStyle,
  buildTimelineCaptions,
  renderAss,
  type AssOptions,
  type CaptionSceneSpan,
} from "./caption.service";
import { activeCleanupRegions, cleanupDelogoChain, inpaintCleanupPrepass } from "./cleanup.service";
import { getVideoMetadata, hasAudioStream } from "./ffmpeg.service";
import { ensureProjectMedia } from "./ingest.service";
import { buildWordTimeline } from "./mining.service";
import { expandWordTimings } from "./transcript.service";
import { resolveReframe } from "./reframe.service";
import { holdCropUntilCuts } from "./speaker-reframe.service";
import { cdnUrlFor, deleteKey, isS3Configured, uploadFileAtKey } from "./s3.service";
import { recomputeProjectStorage } from "./clip.service";
import { mixSoundtrackOntoClip, soundtrackNeedsMix, soundtrackSpansOutro } from "./soundtrack.service";
import { appendOutroToClip, loadSharedOutroLibrary, overlaySharedOutroLibrary, pickProjectOutro } from "./outro.service";
import { creatorPlanActive } from "./creator-plan.service";
import {
  type TimeWindow,
  cameraTrackFor,
  followCx,
  followLead,
  followTightnessX,
  windowsFor,
} from "./creator-timeline";
import { cameraFilterChain, panExpr } from "./camera.service";
import { effectsFilterChain } from "./effects.service";
import { cutawaysInWindow, prepareCutaway, type PreparedCutaway } from "./cutaway.service";
import { ensureClipMatte, matteSpansFor, type ClipMatte } from "./matte.service";
import { renderTitlesAss } from "./title.service";

// ============================================
// CLIP RENDER
//
// One FFmpeg pass per clip: seek -> reframe crop -> scale to 1080x1920 ->
// burn captions -> encode. A merge is the same idea with N seeked inputs
// concatenated inside one filtergraph, so it costs one pass and writes NO
// intermediate segment files.
//
// Everything transient happens inside a scratch directory that is removed
// wholesale in `finally`. The only thing that ever leaves it is the finished
// artefact — uploaded to S3 (which then becomes its home) or moved into the
// project's output directory.
// ============================================

export interface RenderClipOptions {
  reframeMode?: "center" | "smart";
  /** Override the clip's caption preference for this render. */
  captions?: boolean;
}

/** A clip window may sit this far from the source's end and still be readable. */
const SEEK_TOLERANCE_SEC = 0.5;
const MIN_OUTPUT_BYTES = 10_000;
/** Below this a segment is noise, not a cut. */
const MIN_SEGMENT_SEC = 0.2;

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** A 9:16 crop window fitted inside the source, clamped to both edges. */
function cropGeometry(sourceWidth: number, sourceHeight: number): { w: number; h: number } {
  let w = Math.min(sourceWidth, Math.round(sourceHeight * (OUTPUT_WIDTH / OUTPUT_HEIGHT)));
  let h = Math.round(w * (OUTPUT_HEIGHT / OUTPUT_WIDTH));
  if (h > sourceHeight) {
    h = sourceHeight;
    w = Math.round(h * (OUTPUT_WIDTH / OUTPUT_HEIGHT));
  }
  return { w: even(Math.min(w, sourceWidth)), h: even(Math.min(h, sourceHeight)) };
}

/** Crop the frame around one keyframe's centre, then scale to the output size. */
export function cropChainFor(keyframe: CropKeyframe, track: ReframeTrack, tightness = 0, lead = 0): string {
  const { sourceWidth, sourceHeight } = track;
  const { w, h } = cropGeometry(sourceWidth, sourceHeight);
  const x = Math.max(0, Math.min(sourceWidth - w, Math.round(followCx(keyframe, tightness, sourceWidth, lead) - w / 2)));
  const y = Math.max(0, Math.min(sourceHeight - h, Math.round(keyframe.cy - h / 2)));
  return `crop=${w}:${h}:${x}:${y},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1`;
}

/**
 * Move a track's clock so t=0 is `windowStartSec` on the source. Analysis is
 * keyed to a stable span; a trim only changes which slice we encode.
 */
export function shiftTrackToWindow(track: ReframeTrack, windowStartSec: number): ReframeTrack {
  const origin = track.originSec ?? 0;
  const delta = origin - windowStartSec;
  if (Math.abs(delta) < 1e-4) return track;
  return {
    ...track,
    originSec: windowStartSec,
    keyframes: track.keyframes.map((keyframe) => ({ ...keyframe, t: keyframe.t + delta })),
    cuts: track.cuts?.map((cut) => cut + delta),
  };
}

/**
 * One crop filter for the whole window. The decoder never stops: a camera cut
 * in the source is just the next frame, and the 9:16 window follows the speaker
 * by changing `x` — the way an NLE keyframes Position on a single clip.
 *
 * `windowStartSec` is the source time of filter t=0 (the encode seek). Defaults
 * to the track's analysis origin so a saved trim does not shift the snaps.
 */
export function cropChainForTrack(
  track: ReframeTrack,
  windowStartSec?: number,
  tightness = 0,
  windowEndSec?: number,
  camera: {
    /** Follow lead room (0..1): the crop leans toward the head's gaze. */
    lead?: number;
    /** A pan in source pixels as expressions of the window clock (camera.service panExpr). */
    pan?: { x: string; y: string };
  } = {}
): string {
  const shifted = shiftTrackToWindow(track, windowStartSec ?? track.originSec ?? 0);
  if (shifted.mode === "resize") return reframeFilterChain(shifted);
  let keyframes = coalesceKeyframes(
    collapseHoldKeyframes(keyframesForWindow(shifted.keyframes, windowEndSec, windowStartSec)),
    MAX_SEGMENTS_PER_WINDOW
  );
  if (keyframes.length === 0) {
    keyframes = [{ t: 0, cx: shifted.sourceWidth / 2, cy: shifted.sourceHeight / 2, width: shifted.sourceWidth }];
  }
  // A still crop is one filter with constant offsets — unless a pan moves it.
  if (keyframes.length === 1 && !camera.pan) return cropChainFor(keyframes[0]!, shifted, tightness, camera.lead);

  const { sourceWidth, sourceHeight } = shifted;
  const { w, h } = cropGeometry(sourceWidth, sourceHeight);
  const y = Math.max(0, Math.min(sourceHeight - h, Math.round((sourceHeight - h) / 2)));
  // Follow blends the steady seat crop toward the recorded face per keyframe.
  const xOf = (keyframe: CropKeyframe) =>
    Math.max(0, Math.min(sourceWidth - w, Math.round(followCx(keyframe, tightness, sourceWidth, camera.lead ?? 0) - w / 2)));

  // The pan as a FLAT sum: the first crop, plus one clipped ramp (glide) or
  // step (snap) per keyframe. Nested `if(lt(t,…),…,if(…))` pieces would read
  // the same, but FFmpeg's expression parser allows ~100 levels of function
  // nesting and a following camera records the head at up to 10 keyframes a
  // second — a 30 s shot overflowed it ("Missing ')' or too many args").
  let xExpr = String(xOf(keyframes[0]!));
  for (let i = 0; i < keyframes.length - 1; i++) {
    const from = keyframes[i]!;
    const to = keyframes[i + 1]!;
    const delta = xOf(to) - xOf(from);
    if (delta === 0) continue;
    const span = to.t - from.t;
    const cutBetween = shifted.cuts?.some((cut) => cut > from.t + 1e-4 && cut <= to.t + 1e-4);
    const legacyJump =
      shifted.cuts === undefined &&
      (Math.abs(to.cx - from.cx) > 0.25 * from.width || span < 0.12);
    // 1ms early on a SNAP so a frame whose PTS is 0.03ms under the rounded
    // scene time (1097.329567 vs 1097.3296) still gets the new crop. A glide
    // keeps the exact keyframe so interpolation does not jump a millisecond.
    xExpr +=
      cutBetween || legacyJump
        ? `+${delta}*gte(t\\,${Math.max(from.t, to.t - 0.001).toFixed(4)})`
        : `+${delta}*clip((t-${from.t.toFixed(4)})/${Math.max(span, 0.001).toFixed(4)}\\,0\\,1)`;
  }

  // A pan is one more term; `crop` clamps the result to the source.
  if (camera.pan) {
    xExpr += `+${escapeCommas(camera.pan.x)}`;
    if (camera.pan.y !== "0") return `crop=w=${w}:h=${h}:x=${xExpr}:y=${y}+${escapeCommas(camera.pan.y)},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1`;
  }
  return `crop=w=${w}:h=${h}:x=${xExpr}:y=${y},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1`;
}

/** Commas separate filter options; inside an expression they must be escaped. */
function escapeCommas(expression: string): string {
  return expression.replace(/,/g, "\\,");
}

/**
 * Build the `-vf` chain for a reframe track (without captions).
 *
 * Uses the track's FIRST keyframe — i.e. a fixed crop. Moving crops use
 * `cropChainForTrack` on a single pass instead.
 */
export function reframeFilterChain(track: ReframeTrack): string {
  if (track.mode === "resize") {
    return (
      `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
    );
  }
  const keyframe = track.keyframes[0] ?? {
    t: 0,
    cx: track.sourceWidth / 2,
    cy: track.sourceHeight / 2,
    width: track.sourceWidth,
  };
  return cropChainFor(keyframe, track);
}

/** Word timings for a project: real onsets when present, else derived from cues. */
function wordTimingsFor(project: {
  wordTimings?: VttWordTiming[];
  captions?: { startSec: number; endSec: number; text: string }[];
}): VttWordTiming[] {
  if (project.wordTimings?.length) return expandWordTimings(project.wordTimings);
  if (!project.captions?.length) return [];
  return expandWordTimings(
    buildWordTimeline(project.captions).map((w) => ({ t: w.startSec, word: w.text }))
  );
}

/** The caption preset for a clip, with per-clip overrides layered on. */
function styleForClip(
  clip: IClip,
  overrides?: { captionStyleId?: string }
): CaptionStyle {
  const base = resolveCaptionStyle(overrides?.captionStyleId ?? clip.edit?.captionStyleId);
  return resolveEffectiveCaptionStyle(base, clip.edit?.captionOverrides);
}

/**
 * A caption scene's look. A scene that names a preset starts from that preset;
 * one that does not starts from the clip's own look. Its overrides go on top.
 * The client's `sceneStyleFor` follows the same rule.
 */
export function styleForScene(clipStyle: CaptionStyle, scene: CaptionScene): CaptionStyle {
  const base = scene.styleId ? resolveCaptionStyle(scene.styleId) : clipStyle;
  return resolveEffectiveCaptionStyle(base, scene.overrides);
}

/** The grouper's spans and the ASS writer's looks for a clip's caption scenes. */
function sceneCaptionInputs(
  clipStyle: CaptionStyle,
  scenes: CaptionScene[] | undefined
): { spans: CaptionSceneSpan[]; looks: Record<string, AssOptions> } {
  const spans: CaptionSceneSpan[] = [];
  const looks: Record<string, AssOptions> = {};
  for (const scene of scenes ?? []) {
    const style = styleForScene(clipStyle, scene);
    spans.push({ id: scene.id, startSec: scene.startSec, endSec: scene.endSec, chunkWords: style.chunkWords });
    looks[scene.id] = assOptionsFromStyle(style);
  }
  return { spans, looks };
}

/** Whether this render should burn captions. Explicit request > stored edit > genre. */
function captionsOnFor(
  clip: IClip,
  defaultOn: boolean,
  overrides?: { captionsOn?: boolean }
): boolean {
  if (overrides?.captionsOn !== undefined) return overrides.captionsOn;
  if (clip.edit?.captionsOn !== undefined) return clip.edit.captionsOn;
  return defaultOn;
}

/**
 * Write the ASS for one window into the scratch directory.
 *
 * Returns undefined when the span carries no word onsets — burning an empty
 * caption file would be a wasted filter pass, and the render logs why instead.
 */
async function writeCaptions(
  scratchDir: string,
  name: string,
  project: { wordTimings?: VttWordTiming[]; captions?: { startSec: number; endSec: number; text: string }[] },
  startSec: number,
  duration: number,
  peakLine: string | undefined,
  peakSec: number,
  style: CaptionStyle,
  textOverrides: CaptionTextOverride[] = [],
  peakEmphasis = true,
  wordOverrides: CaptionWordOverride[] = [],
  scenes: CaptionScene[] = []
): Promise<string | undefined> {
  const { spans, looks } = sceneCaptionInputs(style, scenes);
  const captions = buildTimelineCaptions(
    wordTimingsFor(project),
    startSec,
    duration,
    peakLine,
    peakSec,
    style.chunkWords,
    textOverrides,
    peakEmphasis,
    wordOverrides,
    spans
  );
  if (captions.length === 0) return undefined;

  const assPath = join(scratchDir, name);
  await writeFile(assPath, renderAss(captions, assOptionsFromStyle(style), looks), "utf-8");
  return assPath;
}

/** A segment resolved against the source, ready to be wired into a filtergraph. */
interface PreparedSegment {
  startSec: number;
  /** Source seconds read from the file. */
  duration: number;
  /** Seconds on the output clock: `duration` unless the segment is re-timed. */
  outputDuration: number;
  /** Playback rate; 1 plays as shot, 0 holds the first frame. */
  rate: number;
  smooth?: boolean;
  /** Creator-mode looks in the chain: it may branch, so it needs a filtergraph. */
  looks?: boolean;
  /** The complete per-frame chain: cleanup, crop, camera, effects, captions. */
  filterChain: string;
  /** The same chain in two halves, for a graph that lays cutaways between them. */
  picture: string;
  /** Captions (with their leading comma) and the final format. */
  tail: string;
  /** Stock shots over this window, in order. */
  cutaways: PreparedCutaway[];
  /**
   * Creator-mode titles. `behind` needs the matte composite; `front` is one
   * more `ass` burn under the captions. Absent on the original render path.
   */
  titles?: {
    picture: string;
    effects: string;
    captions: string;
    behindAss?: string;
    /** White silhouette of the behind layer, for its alpha. */
    behindMaskAss?: string;
    frontAss?: string;
    /** Source time of this window's start, for the matte's own clock. */
    windowStartSec: number;
    fps: number;
    /** The matte is stored small; it is scaled back to source size before the crop. */
    sourceWidth: number;
    sourceHeight: number;
  };
}

const DEFAULT_VIDEO_EFFECTS: Required<VideoEffects> = {
  grade: "natural",
  motion: "none",
  zoom: 1.06,
  sharpen: 0,
  vignette: false,
  audio: "natural",
};

function effectiveVideoEffects(effects?: VideoEffects): Required<VideoEffects> {
  return { ...DEFAULT_VIDEO_EFFECTS, ...effects };
}

/** FFmpeg treatment for the picture only. Captions are added after this chain. */
export function videoEffectFilterChain(
  effects: VideoEffects | undefined,
  peakAtSec?: number,
  options: { skipMotion?: boolean } = {}
): string {
  const value = effectiveVideoEffects(effects);
  // Creator mode owns the camera: its plan replaces the clip-wide motion.
  if (options.skipMotion) value.motion = "none";
  const filters: string[] = [];
  const grade = {
    natural: "",
    vibrant: "eq=contrast=1.06:saturation=1.14:brightness=0.01",
    warm: "eq=contrast=1.04:saturation=1.07:gamma_r=1.04:gamma_b=0.98",
    cool: "eq=contrast=1.05:saturation=0.98:gamma_r=0.98:gamma_b=1.04",
    cinematic: "eq=contrast=1.10:saturation=0.86:gamma=0.98",
  }[value.grade];
  if (grade) filters.push(grade);
  if (value.sharpen > 0) {
    filters.push(`unsharp=5:5:${value.sharpen.toFixed(2)}:5:5:0`);
  }
  if (value.vignette) filters.push("vignette=PI/5");

  const amount = Math.max(0, value.zoom - 1);
  let zoomExpression = "";
  if (amount > 0 && value.motion === "hook_push") {
    zoomExpression = `1+${amount.toFixed(4)}*max(0\\,1-t/0.45)`;
  } else if (amount > 0 && value.motion === "peak_punch" && peakAtSec !== undefined) {
    zoomExpression = `1+${amount.toFixed(4)}*max(0\\,1-abs(t-${peakAtSec.toFixed(4)})/0.38)`;
  }
  if (zoomExpression) {
    // The crop's offsets restate the scaled size: `crop` keeps the iw/ih of
    // its first frame across a mid-stream size change (see cameraFilterChain),
    // so `(iw-W)/2` would pin a peak punch to the corner instead of the centre.
    const scaledW = `trunc(${OUTPUT_WIDTH}*(${zoomExpression})/2)*2`;
    const scaledH = `trunc(${OUTPUT_HEIGHT}*(${zoomExpression})/2)*2`;
    filters.push(
      `scale=w='${scaledW}':h='${scaledH}':eval=frame`,
      `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='(${scaledW}-${OUTPUT_WIDTH})/2':y='(${scaledH}-${OUTPUT_HEIGHT})/2'`,
      // The even-rounded scale leaves a hair of non-square SAR behind; a
      // concat of such parts is refused, and a single file would carry it.
      "setsar=1"
    );
  }
  return filters.join(",");
}

export function audioEffectFilterChain(effects?: VideoEffects): string {
  const audio = effectiveVideoEffects(effects).audio;
  if (audio === "voice") {
    return "highpass=f=80,lowpass=f=12000,acompressor=threshold=0.12:ratio=3:attack=20:release=250:makeup=1.5,alimiter=limit=0.95";
  }
  if (audio === "loud") {
    return "highpass=f=70,acompressor=threshold=0.10:ratio=4:attack=10:release=180:makeup=2,alimiter=limit=0.95";
  }
  return "";
}

interface Delivered {
  outputUrl: string;
  outputKey?: string;
  outputPath?: string;
  bytes: number;
}

/** Revision-stamped progress write: a superseded render's writes silently no-op. */
async function setProgress(clipId: string, revision: number, progress: number): Promise<void> {
  await Clip.updateOne(
    { _id: clipId, renderRevision: revision },
    { $set: { renderProgress: Math.max(0, Math.min(100, Math.round(progress))) } }
  );
}

function reportProgress(clipId: string, revision: number, progress: number): void {
  // Best-effort, but not a bare `void`: an unhandled rejection has no handler
  // anywhere in this process.
  void setProgress(clipId, revision, progress).catch((error: unknown) => {
    console.warn(`⚠️  Render progress write failed for ${clipId}: ${getErrorMessage(error)}`);
  });
}

// ---- span preview ----------------------------------------------------------

const spanPreviewJobs = new Map<string, Promise<SpanPreview>>();

export interface SpanPreview {
  /** File under the project's media dir; served by the clip controller. */
  path: string;
  key: string;
  durationSec: number;
}

function spanPreviewDir(projectId: string): string {
  return join(projectMediaDir(projectId), "previews");
}

export function spanPreviewPath(projectId: string, clipId: string, key: string): string {
  return join(spanPreviewDir(projectId), `${clipId}-${key}.mp4`);
}

/**
 * Render just [startSec, endSec] of a clip with its stored plan — the exact
 * picture the burn would produce — quickly, to a local file the editor plays
 * beside the live preview. Nothing about the clip changes: no status, no
 * delivery, no outro or soundtrack (the picture is what a look is checked on).
 * Fast preset, higher CRF; keyed on the span and the plan, so a repeat of the
 * same request is served from disk.
 */
export async function renderSpanPreview(clipId: string, startSec: number, endSec: number): Promise<SpanPreview> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error(`Clip not found: ${clipId}`);
  if (clip.kind === "merge") throw new Error("Span previews are for single clips");
  const project = await ClipProject.findById(clip.projectId);
  if (!project) throw new Error(`Project not found for clip ${clipId}`);
  const profile = resolveGenreProfile(project.genreId);
  const mediaPath = await ensureProjectMedia(String(project._id));
  const meta = await getVideoMetadata(mediaPath);
  const trimmed = resolveWindow(clip, meta.durationSec);
  const from = Math.max(trimmed.startSec, Math.min(startSec, endSec));
  const to = Math.min(trimmed.endSec, Math.max(startSec, endSec));
  if (to - from < MIN_SEGMENT_SEC) throw new Error("That span is too short to preview");

  const plan = clip.edit?.creator;
  const planKey = Bun.hash(JSON.stringify({ edit: plainEdit(clip), from, to })).toString(36);
  const key = planKey;
  const outputPath = spanPreviewPath(String(project._id), clipId, key);
  if (await fileExists(outputPath)) {
    return { path: outputPath, key, durationSec: to - from };
  }
  const inflight = spanPreviewJobs.get(outputPath);
  if (inflight) return inflight;

  const task = (async (): Promise<SpanPreview> => {
    const scratchDir = await createScratchDir(`span-${clipId}`);
    try {
      const kept: TimeWindow[] = creatorPlanActive(plan)
        ? windowsFor(trimmed.startSec, trimmed.endSec, plan.cuts, plan.speed)
        : [{ startSec: trimmed.startSec, endSec: trimmed.endSec }];
      const windows: SourceWindow[] = kept
        .map((window) => ({ ...window, startSec: Math.max(window.startSec, from), endSec: Math.min(window.endSec, to) }))
        .filter((window) => window.endSec - window.startSec >= MIN_SEGMENT_SEC)
        .map((window, index) => ({
          startSec: round3(window.startSec),
          endSec: round3(window.endSec),
          mode: clip.edit?.reframeMode ?? "smart",
          rate: window.rate,
          smooth: window.smooth,
          captions: window.captions,
          label: `Preview part ${index + 1}`,
        }));
      if (windows.length === 0) throw new Error("That span is entirely cut");
      // A behind-title in the span uses the matte (built or cached by the same
      // path the render takes; a preview is worth the one-off build).
      const matte = creatorPlanActive(plan) && matteSpansFor(plan, from, to).length > 0 ? await ensureClipMatte(clipId) : null;
      const prepared = await prepareSegments({
        clip,
        project,
        mediaPath,
        sourceWidth: meta.width,
        sourceHeight: meta.height,
        sourceDuration: meta.durationSec,
        sourceFps: meta.frameRate,
        windows,
        options: {},
        defaultCaptionsOn: profile.captionsDefault,
        scratchDir,
        persistTrack: true,
        inputTimeOffset: 0,
        delogoRegions: activeCleanupRegions(clip),
        matte,
      });
      await mkdir(spanPreviewDir(String(project._id)), { recursive: true });
      const audioFx = audioEffectFilterChain(clip.edit?.videoEffects);
      const hasAudio = await hasAudioStream(mediaPath);
      const scratchOutput = join(scratchDir, "span.mp4");
      await encodeMerge(mediaPath, scratchOutput, prepared.segments, hasAudio, prepared.duration, audioFx, () => undefined, matte ?? undefined, {
        preset: "veryfast",
        crf: 26,
        fps: meta.frameRate,
      });
      await rename(scratchOutput, outputPath);
      // Keep the folder small: the newest handful per clip.
      await pruneSpanPreviews(String(project._id), clipId, outputPath);
      return { path: outputPath, key, durationSec: prepared.duration };
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  })().finally(() => spanPreviewJobs.delete(outputPath));
  spanPreviewJobs.set(outputPath, task);
  return task;
}

const MAX_SPAN_PREVIEWS_PER_CLIP = 6;

async function pruneSpanPreviews(projectId: string, clipId: string, keep: string): Promise<void> {
  const dir = spanPreviewDir(projectId);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.startsWith(`${clipId}-`));
  const stats = await Promise.all(
    names.map(async (name) => ({ path: join(dir, name), mtime: (await stat(join(dir, name))).mtimeMs }))
  );
  stats
    .filter((entry) => entry.path !== keep)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(MAX_SPAN_PREVIEWS_PER_CLIP - 1)
    .forEach((entry) => void rm(entry.path, { force: true }).catch(() => undefined));
}

/** The edit as the sanitiser would emit it: the part of the clip a preview depends on. */
function plainEdit(clip: IClip): unknown {
  const source = clip.edit as { toObject?: () => unknown } | undefined;
  return source && typeof source.toObject === "function" ? source.toObject() : source;
}

/**
 * Render one clip and store it.
 *
 * Re-runnable: a rendered clip is overwritten in place. The clip's stored `edit`
 * supplies the window, framing and caption look; explicit `options` (the board's
 * toolbar) win for a one-off render.
 */
export async function renderClip(clipId: string, options: RenderClipOptions = {}): Promise<string> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error(`Clip not found: ${clipId}`);
  const project = await ClipProject.findById(clip.projectId);
  if (!project) throw new Error(`Project not found for clip ${clipId}`);

  const revision = (clip.renderRevision ?? 0) + 1;
  const startedAt = Date.now();
  const scratchDir = await createScratchDir(`render-${clipId}`);
  const profile = resolveGenreProfile(project.genreId);

  try {
    await Clip.updateOne(
      { _id: clipId },
      {
        $set: {
          status: "rendering",
          renderProgress: 5,
          renderRevision: revision,
        },
        // `$set: { renderError: undefined }` is dropped by mongoose; the last
        // failure would outlive the render that fixed it.
        $unset: { renderError: 1 },
      }
    );

    const mediaPath = await ensureProjectMedia(String(project._id));
    const meta = await getVideoMetadata(mediaPath);
    await setProgress(clipId, revision, 15);

    // One scratch directory per render — the one `finally` removes. A second
    // `createScratchDir` here used to shadow it, so every render's real files
    // sat in a directory nothing deleted until the 6-hour sweeper.
    let outputPath = join(scratchDir, "out.mp4");
    const mergeSegments = clip.kind === "merge" ? (clip.segments ?? []) : [];

    // Build the source windows this clip renders from: a merge contributes one per
    // part, anything else contributes a single trimmed window. Each then expands
    // into one or more segments from its reframe keyframes.
    const windows: SourceWindow[] = [];
    if (mergeSegments.length > 0) {
      mergeSegments.forEach((segment, index) => {
        const startSec = Math.max(0, segment.startSec);
        const endSec = Math.min(segment.endSec, meta.durationSec);
        windows.push({
          startSec,
          endSec,
          // A merge defaults to the deterministic centre crop: N vision calls for
          // one render is a bad trade, and its parts usually share framing.
          mode: options.reframeMode ?? segment.reframeMode ?? clip.edit?.reframeMode ?? "center",
          captionsOn: segment.captionsOn,
          captionStyleId: segment.captionStyleId,
          label: `Segment ${index + 1}`,
        });
      });
    } else {
      const trimmed = resolveWindow(clip, meta.durationSec);
      const mode = options.reframeMode ?? clip.edit?.reframeMode ?? "smart";
      const plan = clip.edit?.creator;
      // Creator mode: pause cuts split the trim into kept windows, which then
      // render exactly like a merge's parts — one concat, no intermediates.
      const kept: TimeWindow[] = creatorPlanActive(plan)
        ? windowsFor(trimmed.startSec, trimmed.endSec, plan.cuts, plan.speed)
        : [{ startSec: trimmed.startSec, endSec: trimmed.endSec }];
      kept.forEach((window, index) => {
        windows.push({
          startSec: window.startSec,
          endSec: window.endSec,
          mode,
          rate: window.rate,
          smooth: window.smooth,
          captions: window.captions,
          label: kept.length > 1 ? `Part ${index + 1}` : undefined,
        });
      });
    }

    // ---- cleanup: reconstruct burned-in text/watermarks BEFORE the crop ----
    // The rects are in source pixels, so this has to happen on the uncropped
    // frame. Inpainting produces one cleaned intermediate for the whole span;
    // when it is unavailable, delogo is prepended to each segment's chain instead.
    const cleanupRegions = activeCleanupRegions(clip);
    const spanStart = Math.min(...windows.map((w) => w.startSec));
    const spanEnd = Math.max(...windows.map((w) => w.endSec));
    const cleanedPath = await inpaintCleanupPrepass({
      mediaPath,
      spanStartSec: spanStart,
      spanDurationSec: spanEnd - spanStart,
      regions: cleanupRegions,
      sourceWidth: meta.width,
      sourceHeight: meta.height,
      scratchDir,
    });
    // Reading a cleaned intermediate rebases every segment time to its start.
    const inputPath = cleanedPath ?? mediaPath;
    const inputTimeOffset = cleanedPath ? spanStart : 0;

    // Behind-subject titles need the person matte. Best-effort: without it the
    // title is burned in front and the render says so.
    let matte: ClipMatte | null = null;
    let matteNote: string | undefined;
    if (
      mergeSegments.length === 0 &&
      creatorPlanActive(clip.edit?.creator) &&
      matteSpansFor(clip.edit?.creator, windows[0]!.startSec, windows[windows.length - 1]!.endSec).length > 0
    ) {
      matte = await ensureClipMatte(clipId);
      if (!matte) matteNote = "titles in front (no person matte)";
      await setProgress(clipId, revision, 18);
    }

    const prepared = await prepareSegments({
      clip,
      project,
      mediaPath: inputPath,
      sourceWidth: meta.width,
      sourceHeight: meta.height,
      sourceDuration: meta.durationSec,
      sourceFps: meta.frameRate,
      windows,
      options,
      defaultCaptionsOn: profile.captionsDefault,
      scratchDir,
      // Only a single-window clip has a stable window to key a cache on.
      persistTrack: mergeSegments.length === 0,
      inputTimeOffset,
      // delogo is only needed when the inpaint pass did not run.
      delogoRegions: cleanedPath ? [] : cleanupRegions,
      matte,
    });
    const duration = prepared.duration;
    const renderedMode = prepared.mode;
    const reframeNote =
      [
        prepared.note ??
          (mergeSegments.length > 0
            ? `Merged from ${mergeSegments.length} segment${mergeSegments.length === 1 ? "" : "s"}`
            : undefined),
        matteNote,
      ]
        .filter(Boolean)
        .join(" · ") || undefined;

    await Clip.findByIdAndUpdate(clipId, { $set: { reframeMode: renderedMode, reframeNote } });

    const audioFx = audioEffectFilterChain(clip.edit?.videoEffects);
    const hasTitles = prepared.segments.some((segment) => segment.titles);
    const hasAudio = audioFx || prepared.segments.length > 1 || hasTitles ? await hasAudioStream(inputPath) : true;
    const retimed = prepared.segments.some((segment) => segment.rate !== 1);
    const looks = prepared.segments.some((segment) => segment.looks || segment.cutaways.length > 0);
    if (prepared.segments.length === 1 && !hasTitles && !retimed && !looks) {
      // One segment keeps the original single-pass encode, byte-for-byte.
      const only = prepared.segments[0]!;
      await encode(inputPath, outputPath, only.startSec, only.duration, only.filterChain, hasAudio ? audioFx : "", (pct) =>
        reportProgress(clipId, revision, 20 + pct * 0.7)
      );
    } else {
      // Titles need a filtergraph (a second layer, and the matte as an input),
      // which the concat path already is — even for one segment.
      await encodeMerge(inputPath, outputPath, prepared.segments, hasAudio, duration, audioFx, (pct) =>
        reportProgress(clipId, revision, 20 + pct * 0.7), matte ?? undefined, { fps: meta.frameRate }
      );
    }

    await validateArtifact(outputPath, duration);

    await loadSharedOutroLibrary();
    const library = overlaySharedOutroLibrary(project);
    const freshEdit = await Clip.findById(clipId).select("edit.outro edit.soundtrack").lean();
    const outroAttach = freshEdit?.edit?.outro ?? clip.edit?.outro;
    const soundtrack = freshEdit?.edit?.soundtrack ?? clip.edit?.soundtrack;
    const chosen = pickProjectOutro(library.items, outroAttach?.outroId, library.defaultOutroId);
    const mixAfterJoin = soundtrackSpansOutro(soundtrack, duration);

    if (soundtrackNeedsMix(soundtrack) && !mixAfterJoin) {
      reportProgress(clipId, revision, 90);
      outputPath = await mixSoundtrackOntoClip(
        String(project._id),
        outputPath,
        duration,
        soundtrack,
        scratchDir
      );
      await validateArtifact(outputPath, duration);
    }

    reportProgress(clipId, revision, 94);
    const joined = await appendOutroToClip(
      String(project._id),
      outputPath,
      duration,
      outroAttach,
      scratchDir,
      chosen
    );
    outputPath = joined.path;
    await validateArtifact(outputPath, joined.durationSec);

    if (soundtrackNeedsMix(soundtrack) && mixAfterJoin) {
      reportProgress(clipId, revision, 96);
      outputPath = await mixSoundtrackOntoClip(
        String(project._id),
        outputPath,
        joined.durationSec,
        soundtrack,
        scratchDir,
        { voiceUntilSec: duration }
      );
      await validateArtifact(outputPath, joined.durationSec);
    }

    const delivered = await deliverArtifact(clip, project, outputPath, revision);

    await persistOutput(clipId, revision, delivered);
    await recomputeProjectStorage(String(project._id));

    console.log(
      `🎬 Rendered clip ${clip.rank} of ${project._id} in ` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s (${renderedMode}, ` +
        `${prepared.segments.length} segment${prepared.segments.length === 1 ? "" : "s"}` +
        `${clip.kind === "merge" ? `, merged from ${mergeSegments.length}` : ""}) -> ` +
        `${delivered.outputKey ?? "local"}`
    );
    return delivered.outputUrl;
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    // Only the current render may fail the clip. A superseded job's error must
    // not overwrite the newer render's status.
    await Clip.updateOne(
      { _id: clipId, renderRevision: revision },
      { $set: { status: "failed", renderProgress: 0, renderError: message } }
    );
    throw error;
  } finally {
    // Wholesale scratch removal: the .ass files, the pre-upload MP4, and any
    // partial left by an FFmpeg crash all go together. Nothing per-file to
    // forget.
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Clamp a mined clip's (or its edit's) window to the actual media. */
function resolveWindow(
  clip: IClip,
  sourceDuration: number
): { startSec: number; endSec: number; duration: number } {
  const startSec = Math.max(0, clip.edit?.trimStartSec ?? clip.startSec);
  const endSec = Math.min(clip.edit?.trimEndSec ?? clip.endSec, sourceDuration);

  // Uploaded sources can carry an embedded subtitle track whose timings run past
  // the video; a seek beyond EOF produces an empty file that FFmpeg still
  // reports as success.
  if (startSec >= sourceDuration - SEEK_TOLERANCE_SEC) {
    throw new Error(
      `This clip starts at ${startSec.toFixed(1)}s but the source video is only ` +
        `${sourceDuration.toFixed(1)}s long. The transcript's timings do not match the ` +
        `media — re-import the source so its subtitles line up with its own duration.`
    );
  }
  if (endSec - startSec < MIN_SEGMENT_SEC) {
    throw new Error(
      `The trimmed window (${startSec.toFixed(1)}s–${endSec.toFixed(1)}s) is empty.`
    );
  }
  return { startSec, endSec, duration: Math.max(0.5, endSec - startSec) };
}

/** A source window to render, before its reframe keyframes expand it. */
export interface SourceWindow {
  startSec: number;
  endSec: number;
  /** Framing strategy requested for this window. */
  mode: "center" | "smart";
  /** Creator-mode speed: absent/1 as shot, <1 slow, >1 fast, 0 a freeze. */
  rate?: number;
  smooth?: boolean;
  /** Captions stay on inside a slowed window (off by default: the voice is faded). */
  captions?: boolean;
  captionStyleId?: string;
  captionsOn?: boolean;
  /** For error messages. */
  label?: string;
}

/** Cap on segments from ONE window. A filtergraph is a literal argument list. */
const MAX_SEGMENTS_PER_WINDOW = 240;

/**
 * Only the keyframes a window can show: the one in force at its start, those
 * inside it, and the first beyond its end (the pan interpolates into it). The
 * track covers the whole clip; with pause cuts, each window would otherwise
 * carry — and thin — every other window's keyframes too.
 */
function keyframesForWindow(
  keyframes: CropKeyframe[],
  windowEndSec: number | undefined,
  windowStartSec: number | undefined
): CropKeyframe[] {
  if (windowEndSec === undefined || windowStartSec === undefined) return keyframes;
  const windowLen = windowEndSec - windowStartSec;
  const lastBefore = keyframes.filter((keyframe) => keyframe.t <= 1e-4).length - 1;
  const firstAfter = keyframes.findIndex((keyframe) => keyframe.t >= windowLen - 1e-4);
  return keyframes.slice(Math.max(0, lastBefore), firstAfter < 0 ? keyframes.length : firstAfter + 1);
}

/**
 * Reduce a keyframe list to at most `max` entries.
 *
 * Only reached by a long, continuously moving shot. Keyframes are grouped and
 * each group collapses to its first entry, so timing survives with a coarser
 * glide.
 *
 * A CUT is never grouped across. Note the test for one is the SIZE of the crop
 * step, not the time between keyframes: a glide legitimately emits keyframes one
 * frame apart (the EMA moves >10px per frame while closing a large gap), so
 * timing cannot tell a cut from a fast pan. A single step of more than a quarter
 * of the crop width can only come from a discontinuity, and collapsing the pair
 * would turn a hard cut into exactly the slow drift the pair exists to prevent.
 */
export function coalesceKeyframes(keyframes: CropKeyframe[], max: number): CropKeyframe[] {
  if (keyframes.length <= max) return keyframes;
  const perGroup = Math.ceil(keyframes.length / max);

  const groups: CropKeyframe[] = [];
  let sinceGroup = 0;
  for (let i = 0; i < keyframes.length; i++) {
    const current = keyframes[i]!;
    if (sinceGroup === 0 || current.held) groups.push(current);
    sinceGroup++;

    const next = keyframes[i + 1];
    const isCut = next !== undefined && Math.abs(next.cx - current.cx) > 0.25 * current.width;
    if (isCut || sinceGroup >= perGroup) sinceGroup = 0;
  }
  return groups;
}

/**
 * Drop the one-frame "hold" keyframe that sits on the old crop immediately
 * before a snap. Preview interpolation needs it; concat does not — keeping it
 * produces an ~80ms piece that shows up as a hitch at the hard cut.
 */
export function collapseHoldKeyframes(keyframes: CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length < 2) return keyframes;
  const out: CropKeyframe[] = [keyframes[0]!];
  for (let i = 1; i < keyframes.length; i++) {
    const previous = out[out.length - 1]!;
    const current = keyframes[i]!;
    const next = keyframes[i + 1];
    // A keyframe that only records the face moving is not a duplicate: creator
    // mode's follow pans on exactly that data.
    const sameFace =
      Math.abs((current.fx ?? 0) - (previous.fx ?? 0)) <= 4 &&
      Math.abs((current.fy ?? 0) - (previous.fy ?? 0)) <= 4;
    const sameCrop =
      sameFace && Math.abs(current.cx - previous.cx) <= 4 && Math.abs(current.width - previous.width) <= 4;
    const holdBeforeSnap =
      next !== undefined &&
      next.t - current.t <= 0.12 &&
      Math.abs(current.cx - previous.cx) <= 0.25 * previous.width &&
      Math.abs(next.cx - current.cx) > 0.25 * current.width;
    // A hold's plateau is two equal keyframes on purpose: dropping the second
    // would glide straight through it.
    if ((sameCrop || holdBeforeSnap) && !current.held) continue;
    out.push(current);
  }
  return out;
}

/**
 * One window, one piece. Camera cuts stay inside the clip — splicing there is
 * what made the join look like an extra edit.
 */
export function windowSegments(
  window: SourceWindow,
  track: ReframeTrack
): { startSec: number; endSec: number; keyframe: CropKeyframe }[] {
  const fallback: CropKeyframe = {
    t: 0,
    cx: track.sourceWidth / 2,
    cy: track.sourceHeight / 2,
    width: track.sourceWidth,
  };
  return [
    {
      startSec: window.startSec,
      endSec: window.endSec,
      keyframe: track.keyframes[0] ?? fallback,
    },
  ];
}

/**
 * Resolve a reframe track for one window, reusing the clip's cached track when
 * it was resolved for the same window and mode.
 *
 * The speaker analysis is the expensive part of a render, so a re-render of an
 * unchanged clip must not pay for it twice. `persist` is off for merge parts,
 * which have no single window to key a cache on.
 */
/** Bump when framing maths changes so a cached shaky track is not reused. */
const REFRAME_CACHE_VERSION = 16;

type ReframeCacheKey = { startSec: number; endSec: number; mode: string; v?: number };

function stampTrackSpan(track: ReframeTrack, startSec: number, endSec: number): ReframeTrack {
  return holdCropUntilCuts({ ...track, originSec: startSec, untilSec: endSec });
}

const EXPAND_OVERLAP_SEC = 1.25;

function trackSpanStart(track: ReframeTrack): number {
  return track.originSec ?? 0;
}

function trackSpanEnd(track: ReframeTrack): number {
  return track.untilSec ?? 0;
}

/** True when `a` already covers `b`'s analysed span. */
export function trackCoversSpan(a: ReframeTrack, b: ReframeTrack): boolean {
  return trackSpanStart(a) <= trackSpanStart(b) + 0.05 && trackSpanEnd(a) >= trackSpanEnd(b) - 0.05;
}

/**
 * Join two analysed spans that overlap or abut. Used when the user extends a
 * trim: the already-edited region keeps its snaps, and only the new tail (or
 * head) is analysed.
 */
export function stitchReframeTracks(a: ReframeTrack, b: ReframeTrack): ReframeTrack {
  if (trackCoversSpan(a, b)) return holdCropUntilCuts(a);
  if (trackCoversSpan(b, a)) return holdCropUntilCuts(b);

  const [left, right] = trackSpanStart(a) <= trackSpanStart(b) ? [a, b] : [b, a];
  const leftOrigin = trackSpanStart(left);
  const rightOrigin = trackSpanStart(right);
  const leftUntil = trackSpanEnd(left);
  if (rightOrigin > leftUntil + 0.08) return holdCropUntilCuts(leftUntil >= trackSpanEnd(right) ? left : right);

  const shift = rightOrigin - leftOrigin;
  const joinAt = shift;
  const head = left.keyframes.filter((keyframe) => keyframe.t < joinAt + 1e-4);
  const tail = right.keyframes
    .map((keyframe) => ({ ...keyframe, t: keyframe.t + shift }))
    .filter((keyframe) => keyframe.t >= joinAt - 1e-4);
  while (head.length > 0 && tail.length > 0 && head[head.length - 1]!.t >= tail[0]!.t - 1e-4) {
    head.pop();
  }
  const cuts = [
    ...(left.cuts ?? []).filter((cut) => cut < joinAt + 1e-4),
    ...(right.cuts ?? []).map((cut) => cut + shift).filter((cut) => cut >= joinAt - 1e-4),
  ];
  return holdCropUntilCuts({
    ...left,
    originSec: leftOrigin,
    untilSec: Math.max(leftUntil, trackSpanEnd(right)),
    keyframes: [...head, ...tail],
    cuts,
  });
}

function hydrateCachedTrack(
  cached: IClip["reframeTrack"]
): { track: ReframeTrack; key: ReframeCacheKey } | undefined {
  if (!cached?.track) return undefined;
  const key = (cached.for as ReframeCacheKey | undefined) ?? {
    startSec: cached.track.originSec ?? 0,
    endSec: cached.track.untilSec ?? 0,
    mode: "smart",
    v: 0,
  };
  return {
    track: stampTrackSpan(
      cached.track,
      cached.track.originSec ?? key.startSec,
      cached.track.untilSec ?? key.endSec
    ),
    key,
  };
}

function trackCoversWindow(track: ReframeTrack, window: SourceWindow): boolean {
  if (track.originSec == null || track.untilSec == null) return false;
  return track.originSec <= window.startSec + 0.05 && track.untilSec >= window.endSec - 0.05;
}

async function resolveTrack(input: {
  clip: IClip;
  mediaPath: string;
  window: SourceWindow;
  sourceWidth: number;
  sourceHeight: number;
  persist: boolean;
  /** The whole span the clip will need, so one analysis covers every window. */
  coverHint?: { startSec: number; endSec: number };
}): Promise<ReframeTrack> {
  const requestedMode = input.window.mode;
  const hydrated = hydrateCachedTrack(input.clip.reframeTrack);
  if (
    hydrated &&
    hydrated.key.mode === requestedMode &&
    hydrated.key.v === REFRAME_CACHE_VERSION &&
    trackCoversWindow(hydrated.track, input.window)
  ) {
    return hydrated.track;
  }

  const coverStart = round3(
    Math.min(
      input.window.startSec,
      input.clip.startSec,
      input.coverHint?.startSec ?? input.window.startSec,
      hydrated?.track.originSec ?? input.window.startSec
    )
  );
  const coverEnd = round3(
    Math.max(
      input.window.endSec,
      input.clip.endSec,
      input.coverHint?.endSec ?? input.window.endSec,
      hydrated?.track.untilSec ?? input.window.endSec
    )
  );

  const analyseSpan = async (startSec: number, endSec: number): Promise<ReframeTrack> =>
    stampTrackSpan(
      await resolveReframe({
        videoPath: input.mediaPath,
        startSec,
        endSec,
        sourceWidth: input.sourceWidth,
        sourceHeight: input.sourceHeight,
        mode: requestedMode,
      }),
      startSec,
      endSec
    );

  let track: ReframeTrack;
  const cached =
    hydrated && hydrated.key.mode === requestedMode && hydrated.key.v === REFRAME_CACHE_VERSION
      ? hydrated.track
      : undefined;
  const canExtendEnd =
    cached?.originSec != null &&
    cached.untilSec != null &&
    cached.originSec <= input.window.startSec + 0.05 &&
    cached.untilSec < coverEnd - 0.05;
  const canExtendStart =
    cached?.originSec != null &&
    cached.untilSec != null &&
    cached.untilSec >= input.window.endSec - 0.05 &&
    cached.originSec > coverStart + 0.05;

  if (canExtendEnd) {
    const extraStart = round3(Math.max(0, cached.untilSec! - EXPAND_OVERLAP_SEC));
    track = stitchReframeTracks(cached, await analyseSpan(extraStart, coverEnd));
  } else if (canExtendStart) {
    const extraEnd = round3(cached.originSec! + EXPAND_OVERLAP_SEC);
    track = stitchReframeTracks(await analyseSpan(coverStart, extraEnd), cached);
  } else {
    track = await analyseSpan(coverStart, coverEnd);
  }

  if (input.persist) {
    track = await persistReframeTrack(input.clip._id, track, requestedMode);
  }
  return track;
}

async function persistReframeTrack(
  clipId: IClip["_id"],
  track: ReframeTrack,
  mode: string
): Promise<ReframeTrack> {
  const latest = await Clip.findById(clipId).select("reframeTrack");
  const existing = hydrateCachedTrack(latest?.reframeTrack);
  let toWrite = track;
  if (existing && existing.key.mode === mode && existing.key.v === REFRAME_CACHE_VERSION) {
    if (trackCoversSpan(existing.track, track) && !trackCoversSpan(track, existing.track)) {
      // A slower job for a shorter window finished after a wider one. Keep the cover.
      return existing.track;
    }
    if (!trackCoversSpan(track, existing.track)) {
      toWrite = stitchReframeTracks(existing.track, track);
    }
  }
  const startSec = toWrite.originSec ?? 0;
  const endSec = toWrite.untilSec ?? 0;
  await Clip.updateOne(
    { _id: clipId },
    {
      $set: {
        reframeTrack: {
          track: toWrite,
          for: { startSec, endSec, mode, v: REFRAME_CACHE_VERSION },
        },
      },
    }
  );
  return toWrite;
}

const previewJobs = new Map<string, Promise<ReframeTrack>>();

/**
 * Resolve (and cache) a reframe track for the editor preview, so the 9:16
 * window matches what a smart render would produce — not a silent centre crop
 * of the gap between two chairs.
 */
export async function previewClipReframe(input: {
  clipId: string;
  startSec?: number;
  endSec?: number;
  mode?: "center" | "smart";
}): Promise<ReframeTrack> {
  const clip = await Clip.findById(input.clipId);
  if (!clip) throw new Error("Clip not found");
  if (clip.kind === "merge") {
    throw new Error("Merged clips pick framing per part at render time");
  }
  if (clip.status === "rendering") {
    if (clip.reframeTrack?.track) return clip.reframeTrack.track;
    throw new Error("This clip is rendering; framing will land with the output");
  }

  const project = await ClipProject.findById(clip.projectId);
  if (!project) throw new Error("Project not found");
  if (project.mediaStatus !== "ready" || !project.mediaPath) {
    throw new Error("The source video is not on this machine yet");
  }

  const meta = await getVideoMetadata(project.mediaPath);
  const trimmed = resolveWindow(clip, meta.durationSec);
  const reqStart = round3(input.startSec ?? trimmed.startSec);
  const reqEnd = round3(input.endSec ?? trimmed.endSec);
  const window: SourceWindow = {
    startSec: round3(Math.min(clip.startSec, reqStart)),
    endSec: round3(Math.max(clip.endSec, reqEnd)),
    mode: input.mode ?? clip.edit?.reframeMode ?? "smart",
  };
  if (!(window.endSec - window.startSec > 0.2)) {
    throw new Error("The trimmed window is too short to analyse");
  }

  const jobKey = `${input.clipId}:${window.startSec}:${window.endSec}:${window.mode}`;
  const inflight = previewJobs.get(jobKey);
  if (inflight) return inflight;

  const task = resolveTrack({
    clip,
    mediaPath: project.mediaPath,
    window,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    persist: true,
  }).finally(() => previewJobs.delete(jobKey));
  previewJobs.set(jobKey, task);
  return task;
}

/**
 * Resolve every window against the source — framing, keyframe expansion and
 * captions — into the flat segment list the encoder consumes.
 *
 * Windows come from the clip's edit (one window) or from a merge's parts (N), and
 * each expands to one or more segments depending on its reframe track. This is
 * the single place that knows how a clip becomes a list of encoded pieces.
 */
async function prepareSegments(input: {
  clip: IClip;
  project: IClipProject;
  mediaPath: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceDuration: number;
  sourceFps: number;
  windows: SourceWindow[];
  options: RenderClipOptions;
  defaultCaptionsOn: boolean;
  scratchDir: string;
  /** Cache the resolved track on the clip (only meaningful for one window). */
  persistTrack: boolean;
  /**
   * Seconds to subtract from a segment's source time to address the file we
   * actually read. Non-zero when the input is a cleaned intermediate covering
   * [spanStart, spanEnd) rather than the whole source.
   */
  inputTimeOffset: number;
  /** Regions to absorb with delogo, when the inpaint pass did not run. */
  delogoRegions: CleanupRegion[];
  /** The person matte, when behind-titles have one. */
  matte?: ClipMatte | null;
}): Promise<{ segments: PreparedSegment[]; duration: number; mode: IClip["reframeMode"]; note?: string }> {
  const segments: PreparedSegment[] = [];
  let duration = 0;
  let mode: IClip["reframeMode"];
  let note: string | undefined;
  // Pause cuts split one clip into several windows that share one analysis.
  // `input.clip` was loaded before the first window persisted its track, so
  // without this the second window would miss the cache and analyse again.
  let lastTrack: { track: ReframeTrack; mode: string } | undefined;

  for (let w = 0; w < input.windows.length; w++) {
    const window = input.windows[w]!;
    if (window.endSec - window.startSec < MIN_SEGMENT_SEC) {
      throw new Error(
        `${window.label ?? `Segment ${w + 1}`} (${window.startSec.toFixed(1)}s–${window.endSec.toFixed(
          1
        )}s) is empty or past the end of the source video.`
      );
    }

    const track =
      lastTrack && lastTrack.mode === window.mode && trackCoversWindow(lastTrack.track, window)
        ? lastTrack.track
        : await resolveTrack({
            clip: input.clip,
            mediaPath: input.mediaPath,
            window,
            sourceWidth: input.sourceWidth,
            sourceHeight: input.sourceHeight,
            persist: input.persistTrack,
            coverHint: input.persistTrack
              ? {
                  startSec: Math.min(...input.windows.map((item) => item.startSec)),
                  endSec: Math.max(...input.windows.map((item) => item.endSec)),
                }
              : undefined,
          });
    if (input.persistTrack) lastTrack = { track, mode: window.mode };
    mode ??= track.mode;
    note ??= track.note;

    const pieceDuration = window.endSec - window.startSec;
    const rate = window.rate ?? 1;
    const pieceOutput = rate > 0 ? pieceDuration / rate : pieceDuration;
    duration += pieceOutput;

    const plan = input.clip.edit?.creator;
    const creatorActive = creatorPlanActive(plan) && input.persistTrack;

    let assPath: string | undefined;
    // A slowed or frozen window has its voice faded out, so its captions are
    // off unless the span asks for them.
    const captionsWanted = rate === 1 || rate > 1 || window.captions === true;
    if (captionsWanted && (input.options.captions ?? captionsOnFor(input.clip, input.defaultCaptionsOn, window))) {
      assPath = await writeCaptions(
        input.scratchDir,
        `segment_${w}.ass`,
        input.project,
        window.startSec,
        pieceDuration,
        input.clip.peakLine,
        input.clip.peakSec,
        styleForClip(input.clip, window),
        input.clip.edit?.captionTextOverrides,
        input.clip.edit?.captionOverrides?.peakEmphasis !== false,
        input.clip.edit?.captionWordOverrides,
        creatorActive ? plan.captionScenes : []
      );
    }

    // A following camera rides the smoothed face path, never the raw box; how
    // smoothed is the plan's response. Holds lock it off on top.
    const cameraTrack = creatorActive ? cameraTrackFor(track, plan) : track;
    const base = cropChainForTrack(
      cameraTrack,
      window.startSec,
      creatorActive ? followTightnessX(plan) : 0,
      window.endSec,
      creatorActive
        ? { lead: followLead(plan), pan: panExpr(plan, cameraTrack, window.startSec, window.endSec) }
        : {}
    );
    const camera = creatorActive
      ? cameraFilterChain({ plan, track: cameraTrack, windowStartSec: window.startSec, windowEndSec: window.endSec })
      : "";
    const pictureEffects = videoEffectFilterChain(
      input.clip.edit?.videoEffects,
      input.clip.peakSec >= window.startSec && input.clip.peakSec <= window.endSec
        ? input.clip.peakSec - window.startSec
        : undefined,
      { skipMotion: creatorActive }
    );

    const delogo = cleanupDelogoChain(
      input.delogoRegions,
      input.sourceWidth,
      input.sourceHeight,
      window.startSec,
      pieceDuration
    );

    const captionsFilter = assPath ? `,${assVideoFilter(assPath)}` : "";
    // Creator-mode looks, after the grade and before the words. Labels carry
    // the segment index: some looks split the graph.
    const looks = creatorActive ? effectsFilterChain(plan, window.startSec, window.endSec, `s${w}`) : "";
    const picture = `${delogo ? `${delogo},` : ""}${base}${camera ? `,${camera}` : ""}${pictureEffects ? `,${pictureEffects}` : ""}${looks ? `,${looks}` : ""}`;
    const cutaways = creatorActive
      ? (await cutawaysInWindow(plan, window.startSec, window.endSec))
          .map((item) => prepareCutaway(item.cutaway, item.asset, item.path, window.startSec, window.endSec))
          .filter((item): item is PreparedCutaway => item !== undefined)
      : [];
    const segment: PreparedSegment = {
      startSec: window.startSec - input.inputTimeOffset,
      duration: pieceDuration,
      outputDuration: pieceOutput,
      rate,
      smooth: window.smooth,
      looks: looks.length > 0,
      filterChain: `${picture}${captionsFilter},format=yuv420p`,
      picture,
      tail: `${captionsFilter},format=yuv420p`,
      cutaways,
    };

    // Creator-mode titles: separate ASS files per layer, timed on this window.
    // A behind-title only goes behind when the matte exists; otherwise it joins
    // the front layer so the words are never lost.
    if (creatorActive && plan.titles?.length) {
      const titles = input.matte
        ? plan.titles
        : plan.titles.map((title) => (title.depth === "behind" ? { ...title, depth: "front" as const } : title));
      const behind = renderTitlesAss(titles, window.startSec, window.endSec, "behind");
      const behindMask = renderTitlesAss(titles, window.startSec, window.endSec, "behind", "mask");
      const front = renderTitlesAss(titles, window.startSec, window.endSec, "front");
      if (behind || front) {
        let behindAss: string | undefined;
        let behindMaskAss: string | undefined;
        let frontAss: string | undefined;
        if (behind && behindMask) {
          behindAss = join(input.scratchDir, `titles_behind_${w}.ass`);
          behindMaskAss = join(input.scratchDir, `titles_behind_mask_${w}.ass`);
          await writeFile(behindAss, behind, "utf-8");
          await writeFile(behindMaskAss, behindMask, "utf-8");
        }
        if (front) {
          frontAss = join(input.scratchDir, `titles_front_${w}.ass`);
          await writeFile(frontAss, front, "utf-8");
        }
        segment.titles = {
          picture: `${base}${camera ? `,${camera}` : ""}`,
          effects: picture,
          captions: captionsFilter,
          behindAss,
          behindMaskAss,
          frontAss,
          windowStartSec: window.startSec,
          fps: input.sourceFps,
          sourceWidth: input.sourceWidth,
          sourceHeight: input.sourceHeight,
        };
      }
    }
    segments.push(segment);
  }

  return { segments, duration, mode: mode ?? "center", note };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Zero the filter clock at the trim's requested start, not at the first decoded
 * frame. `PTS-STARTPTS` is one frame late when startSec falls between frames,
 * so the new shot plays through the old 9:16 crop (table / cabinet flash).
 */
function alignPtsToTrim(startSec: number): string {
  return `setpts=PTS-(${startSec.toFixed(4)}/TB)`;
}

/**
 * Upload or move the finished artefact, then leave the scratch copy to the
 * caller's cleanup.
 *
 * S3 mode: upload to a stable per-clip key, verify, and retire the legacy
 * rank-keyed object. The local file is deliberately NOT kept — S3 is the home,
 * and the CDN URL is what the player and downloads use.
 *
 * Local mode: move it into the project's output directory.
 */
async function deliverArtifact(
  clip: IClip,
  project: IClipProject,
  scratchOutputPath: string,
  revision: number
): Promise<Delivered> {
  const bytes = await getFileSize(scratchOutputPath);
  const clipId = String(clip._id);

  if (project.storage === "s3" && isS3Configured() && project.s3Prefix) {
    // The key carries the render revision. A stable key was served through
    // CloudFront, which ignores query strings by default, so every re-render
    // played back — and downloaded — as the previous render until the edge
    // cache expired. A new key per render is a new object at the edge.
    const key = `${project.s3Prefix}clips/${clipId}.r${revision}.mp4`;
    const outputUrl = await uploadFileAtKey(scratchOutputPath, key, "video/mp4");

    // Retire the previous objects for this clip — the last render's key and
    // the legacy rank-keyed / unrevisioned ones. Safe only after the new key
    // is verified above: until then the clip's only copy is the old object.
    const retire = new Set([
      `${project.s3Prefix}clips/${clip.rank}.mp4`,
      `${project.s3Prefix}clips/${clipId}.mp4`,
      ...(clip.outputKey ? [clip.outputKey] : []),
    ]);
    retire.delete(key);
    for (const oldKey of retire) {
      await deleteKey(oldKey).catch((error: unknown) => {
        console.warn(`⚠️  Could not retire S3 key ${oldKey}: ${getErrorMessage(error)}`);
      });
    }
    // S3 is the home copy. Drop any leftover local render for this clip (a
    // previous local-mode encode, or an S3-fallback file) so output/ does not
    // keep a twin of the object we just uploaded.
    await retireLocalClipRenders(String(project._id), clipId, clip.outputPath);
    return { outputUrl, outputKey: key, bytes };
  }

  if (project.storage === "s3") {
    console.warn("⚠️  OUTPUT_STORAGE=s3 but S3 is not configured — serving the render locally");
  }

  const outDir = projectOutputDir(String(project._id));
  await ensureDir(outDir);
  const finalName = `clip_${String(clip.rank).padStart(2, "0")}_${clipId}.mp4`;
  const finalPath = join(outDir, finalName);

  // A previous render may sit under a different name (rank changed, or a legacy
  // name). Remove any stale render for THIS clip so the directory holds one.
  for (const name of await listFiles(outDir)) {
    if (name !== basename(finalPath) && name.includes(clipId) && name.endsWith(".mp4")) {
      await deleteFile(join(outDir, name)).catch(() => undefined);
    }
  }

  await moveFile(scratchOutputPath, finalPath);
  return { outputUrl: `/api/clips/${clipId}/download`, outputPath: finalPath, bytes };
}

/** Drop local mp4s for one clip. Safe after S3 has the verified object. */
async function retireLocalClipRenders(
  projectId: string,
  clipId: string,
  recordedPath?: string
): Promise<void> {
  const outDir = projectOutputDir(projectId);
  const candidates = new Set<string>();
  if (recordedPath) candidates.add(recordedPath);
  for (const name of await listFiles(outDir)) {
    if (name.includes(clipId) && name.endsWith(".mp4")) candidates.add(join(outDir, name));
  }
  await Promise.all([...candidates].map((path) => deleteFile(path).catch(() => undefined)));
}

/** `rename` is atomic on one filesystem; fall back to a copy when it is not. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EXDEV") {
      await copyFile(from, to);
      await deleteFile(from);
      return;
    }
    throw error;
  }
}

/** Record the delivered artefact, guarded by the render revision. */
async function persistOutput(clipId: string, revision: number, delivered: Delivered): Promise<void> {
  const $set: Record<string, unknown> = {
    status: "rendered",
    renderProgress: 100,
    outputUrl: delivered.outputUrl,
    outputBytes: delivered.bytes,
    renderedAt: new Date(),
    renderRevision: revision,
  };
  const $unset: Record<string, 1> = { renderError: 1 };
  if (delivered.outputKey) $set.outputKey = delivered.outputKey;
  else $unset.outputKey = 1;
  if (delivered.outputPath) $set.outputPath = delivered.outputPath;
  else $unset.outputPath = 1;

  await Clip.updateOne({ _id: clipId, renderRevision: revision }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
}

/**
 * FFmpeg exits 0 even when it wrote no frames (e.g. a seek past EOF), which
 * would otherwise be recorded as a successful render. Verify the artefact
 * actually carries video before declaring success.
 */
async function validateArtifact(outputPath: string, duration: number): Promise<void> {
  const outputSize = await getFileSize(outputPath).catch(() => 0);
  if (outputSize < MIN_OUTPUT_BYTES) {
    throw new Error(
      `Render produced an empty file (${outputSize} bytes). The requested window could ` +
        `not be read from the source.`
    );
  }
  const rendered = await getVideoMetadata(outputPath).catch(() => null);
  if (!rendered || rendered.durationSec < duration * 0.85) {
    throw new Error(
      `Render produced only ${rendered?.durationSec?.toFixed(1) ?? "0"}s of a ` +
        `${duration.toFixed(1)}s clip.`
    );
  }
}

function encode(
  mediaPath: string,
  outputPath: string,
  startSec: number,
  duration: number,
  filterChain: string,
  audioFilter: string,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const preroll = Math.min(2, Math.max(0, startSec));
    const cmd = ffmpeg(mediaPath)
      .inputOptions(["-ss", String(startSec - preroll), "-copyts"])
      .output(outputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .audioBitrate("128k");

    // Discrete-argument form: fluent-ffmpeg corrupts values containing exactly
    // one space when passed as an array, which would break the ass= path.
    const setOption = cmd.outputOptions.bind(cmd) as (...args: string[]) => typeof cmd;
    // Input -ss is only keyframe-accurate. trim+copyts keeps source PTS, then
    // setpts zeros them at the requested in-point — not at the first decoded
    // frame, which is what made the 18:17 camera cut flash a CU crop onto the
    // two-shot for one frame.
    setOption(
      "-vf",
      `trim=start=${startSec.toFixed(4)}:duration=${duration.toFixed(4)},${alignPtsToTrim(startSec)},${filterChain}`
    );
    setOption(
      "-af",
      `atrim=start=${startSec.toFixed(4)}:duration=${duration.toFixed(4)},asetpts=PTS-(${startSec.toFixed(4)}/TB)${audioFilter ? `,${audioFilter}` : ""}`
    );
    setOption("-preset", config.ffmpegPreset);
    setOption("-crf", String(config.ffmpegCrf));
    setOption("-pix_fmt", "yuv420p");
    setOption("-movflags", "+faststart");

    cmd
      .on("progress", (p) => {
        if (p.percent != null && Number.isFinite(p.percent)) {
          onProgress(Math.max(0, Math.min(100, p.percent)));
        }
      })
      .on("end", () => resolve())
      .on("error", (err, _stdout, stderr) => reject(new Error(`Render failed: ${ffmpegCause(err.message, stderr)}`)))
      .run();
  });
}

/**
 * The line that says WHY. fluent-ffmpeg's message ends in the last stderr
 * line, which for a filter that failed to parse is only "Conversion failed!";
 * the cause was printed first.
 */
function ffmpegCause(message: string, stderr: string | null | undefined): string {
  const cause = (stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /error|invalid|missing|failed to|no such|cannot|too many|not found/i.test(line) && !/conversion failed/i.test(line));
  if (!cause) return message;
  return `${message.split("\n")[0]} — ${cause.slice(0, 300)}`;
}

/**
 * Concatenate discontiguous windows (a user-made merge). Each window is already
 * one continuous decode with a keyframed crop, so this is only for joining
 * separate source ranges — not for camera cuts inside a window.
 */
/**
 * The per-segment video graph. Without titles it is the single-pass chain;
 * with them the picture is split so the behind-title sits between the
 * background and the speaker's cutout (matte), and the front layer and the
 * captions go on top.
 */
function segmentVideoGraph(
  index: number,
  segment: PreparedSegment,
  matte?: ClipMatte,
  matteIndex?: number,
  cutawayInputs: number[] = [],
  fps = 30
): string[] {
  const trim = `trim=start=${segment.startSec.toFixed(4)}:duration=${segment.duration.toFixed(4)}`;
  const head = `[${index}:v]${trim},${alignPtsToTrim(segment.startSec)}`;
  const titles = segment.titles;
  // Re-timing is the LAST step: crop, camera, captions and titles are all
  // written on the source clock, so the whole finished picture is stretched.
  const out = segment.rate === 1 ? `[v${index}]` : `[vt${index}]`;
  const retime = segment.rate === 1 ? [] : [`[vt${index}]${rateVideoChain(segment)}[v${index}]`];
  // Cutaways lie between the picture and the words: B-roll under the captions.
  const cutaways = cutawayGraph(index, segment, cutawayInputs, fps);
  if (!titles) {
    if (cutaways.lines.length === 0) return [`${head},${segment.filterChain}${out}`, ...retime];
    return [`${head},${segment.picture}[pic${index}]`, ...cutaways.lines, `[${cutaways.output}]null${segment.tail}${out}`, ...retime];
  }

  const front = titles.frontAss ? `,${assVideoFilter(titles.frontAss)}` : "";
  const lines: string[] = [];
  if (titles.behindAss && titles.behindMaskAss && matte && matteIndex != null) {
    const duration = segment.duration.toFixed(4);
    const fps = titles.fps > 0 ? titles.fps : 30;
    const matteStart = Math.max(0, titles.windowStartSec - matte.originSec).toFixed(4);
    // libass writes no alpha, so the layer is two renders on black — the colour
    // and its white silhouette — merged into RGBA. One second longer than the
    // picture so `shortest` ends on the picture.
    const canvas = `color=c=black:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:r=${fps}:d=${(segment.duration + 1).toFixed(2)}`;
    lines.push(
      `${head},${titles.effects}[base${index}]`,
      `[base${index}]split=2[bg${index}][fg${index}]`,
      `${canvas},format=yuv420p,${assVideoFilter(titles.behindAss)},format=rgba[tc${index}]`,
      `${canvas},format=yuv420p,${assVideoFilter(titles.behindMaskAss)},format=gray[tm${index}]`,
      `[tc${index}][tm${index}]alphamerge[tb${index}]`,
      `[bg${index}][tb${index}]overlay=shortest=1:format=auto[bgt${index}]`,
      // The matte through the same crop and camera as the picture.
      `[${matteIndex}:v]trim=start=${matteStart}:duration=${duration},setpts=PTS-STARTPTS[mraw${index}]`,
      `[mraw${index}]scale=${titles.sourceWidth}:${titles.sourceHeight},${titles.picture},format=gray[mk${index}]`,
      `[fg${index}]format=rgba[fga${index}]`,
      `[fga${index}][mk${index}]alphamerge[cut${index}]`,
      `[bgt${index}][cut${index}]overlay=format=auto[vb${index}]`
    );
    if (cutaways.lines.length > 0) {
      lines.push(`[vb${index}]null[pic${index}]`, ...cutaways.lines, `[${cutaways.output}]null${front}${titles.captions},format=yuv420p${out}`, ...retime);
    } else {
      lines.push(`[vb${index}]null${front}${titles.captions},format=yuv420p${out}`, ...retime);
    }
    return lines;
  }
  if (cutaways.lines.length > 0) {
    return [`${head},${titles.effects}[pic${index}]`, ...cutaways.lines, `[${cutaways.output}]null${front}${titles.captions},format=yuv420p${out}`, ...retime];
  }
  return [`${head},${titles.effects}${front}${titles.captions},format=yuv420p${out}`, ...retime];
}

/**
 * The cutaway streams of a segment laid on `[pic<index>]` one after another.
 * `output` is the label carrying the picture once every cutaway is on it.
 */
function cutawayGraph(
  index: number,
  segment: PreparedSegment,
  cutawayInputs: number[],
  fps: number
): { lines: string[]; output: string } {
  const lines: string[] = [];
  let current = `pic${index}`;
  segment.cutaways.forEach((cutaway, k) => {
    const inputIndex = cutawayInputs[k];
    if (inputIndex === undefined) return;
    const label = `cw${index}_${k}`;
    lines.push(...cutaway.lines(inputIndex, label, fps));
    lines.push(`[${current}][${label}]${cutaway.overlay}[${label}p]`);
    current = `${label}p`;
  });
  return { lines, output: current };
}

/**
 * Stretch a finished segment to its output length. A freeze holds the first
 * frame; slow motion stretches the timestamps (optionally
 * synthesising the in-between frames); fast motion compresses them.
 */
function rateVideoChain(segment: PreparedSegment): string {
  // `loop` repeats the first frame forever; `trim` ends it at the span's length.
  if (segment.rate <= 0) return `loop=loop=-1:size=1:start=0,trim=duration=${segment.outputDuration.toFixed(4)},setpts=PTS-STARTPTS`;
  const stretch = `setpts=PTS/${segment.rate.toFixed(4)}`;
  if (segment.smooth && segment.rate < 1) return `${stretch},minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1`;
  return stretch;
}

/**
 * The voice for a re-timed segment. Slow motion and a freeze fade it out over
 * the first 0.2 s and pad silence to the output length; fast motion keeps the
 * words, pitch-corrected (atempo takes 0.5–100 per stage, so 3× is one stage).
 */
function rateAudioChain(segment: PreparedSegment): string {
  if (segment.rate === 1) return "";
  if (segment.rate > 1) return `,atempo=${segment.rate.toFixed(4)}`;
  return `,afade=t=out:st=0:d=0.2,apad=whole_dur=${segment.outputDuration.toFixed(4)}`;
}

async function encodeMerge(
  mediaPath: string,
  outputPath: string,
  segments: PreparedSegment[],
  audio: boolean,
  totalDuration: number,
  audioFilter: string,
  onProgress: (pct: number) => void,
  matte?: ClipMatte,
  encoder: { preset?: string; crf?: number; fps?: number } = {}
): Promise<void> {
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-nostats"];
  for (const segment of segments) {
    const preroll = Math.min(2, Math.max(0, segment.startSec));
    args.push(
      "-ss",
      String(segment.startSec - preroll),
      "-copyts",
      "-to",
      String(segment.startSec + segment.duration),
      "-i",
      mediaPath
    );
  }
  let matteIndex: number | undefined;
  let nextInput = segments.length;
  if (matte && segments.some((segment) => segment.titles?.behindAss)) {
    matteIndex = nextInput++;
    args.push("-i", matte.path);
  }
  // Every cutaway's media is one more input, numbered after the footage.
  const cutawayInputs = segments.map((segment) =>
    segment.cutaways.map((cutaway) => {
      args.push(...cutaway.inputArgs(cutaway.lengthSec));
      return nextInput++;
    })
  );
  const fps = segments.find((segment) => segment.titles?.fps)?.titles?.fps ?? encoder.fps ?? 30;

  const graph: string[] = [];
  const concatParts: string[] = [];
  segments.forEach((segment, index) => {
    graph.push(...segmentVideoGraph(index, segment, matte, matteIndex, cutawayInputs[index], fps));
    if (audio) {
      graph.push(
        // Zero the clock BEFORE aresample: with `first_pts=0` on audio whose
        // timestamps still read the source's (copyts), aresample pads the whole
        // gap with silence — minutes of it for a window deep into an episode —
        // and concat waits on that audio before it will start the next part.
        `[${index}:a]atrim=start=${segment.startSec.toFixed(4)}:duration=${segment.duration.toFixed(4)},asetpts=PTS-(${segment.startSec.toFixed(4)}/TB),aresample=async=1:first_pts=0${audioFilter ? `,${audioFilter}` : ""}${rateAudioChain(segment)}[a${index}]`
      );
    }
    concatParts.push(`[v${index}]`);
    if (audio) concatParts.push(`[a${index}]`);
  });
  graph.push(
    `${concatParts.join("")}concat=n=${segments.length}:v=1:a=${audio ? 1 : 0}[outv]${audio ? "[outa]" : ""}`
  );

  if (process.env.CLIPPER_DEBUG_GRAPH) console.log(`[graph]\n${graph.join(";\n")}`);
  args.push("-filter_complex", graph.join(";"), "-map", "[outv]");
  if (audio) args.push("-map", "[outa]");
  args.push(
    "-c:v", "libx264",
    "-preset", encoder.preset ?? config.ffmpegPreset,
    "-crf", String(encoder.crf ?? config.ffmpegCrf),
    "-pix_fmt", "yuv420p"
  );
  if (audio) args.push("-c:a", "aac", "-b:a", "128k");
  args.push("-t", totalDuration.toFixed(4), "-movflags", "+faststart", "-progress", "pipe:1", outputPath);

  await runCommand(config.ffmpegPath, args, {
    label: "merge render",
    onStdout: (line) => {
      const match = /^out_time_us=(\d+)$/.exec(line.trim()) ?? /^out_time_ms=(\d+)$/.exec(line.trim());
      if (!match || totalDuration <= 0) return;
      const seconds = Number(match[1]) / 1_000_000;
      onProgress(Math.max(0, Math.min(100, (seconds / totalDuration) * 100)));
    },
  });
}
