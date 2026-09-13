import { copyFile, rename, rm, writeFile } from "node:fs/promises";
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
  CleanupRegion,
  CaptionTextOverride,
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
  getFileSize,
  listFiles,
  projectOutputDir,
  runCommand,
} from "../utils";
import { assOptionsFromStyle, buildTimelineCaptions, renderAss } from "./caption.service";
import { activeCleanupRegions, cleanupDelogoChain, inpaintCleanupPrepass } from "./cleanup.service";
import { getVideoMetadata, hasAudioStream } from "./ffmpeg.service";
import { ensureProjectMedia } from "./ingest.service";
import { buildWordTimeline } from "./mining.service";
import { resolveReframe } from "./reframe.service";
import { holdCropUntilCuts } from "./speaker-reframe.service";
import { cdnUrlFor, deleteKey, isS3Configured, uploadFileAtKey } from "./s3.service";
import { recomputeProjectStorage } from "./clip.service";
import { mixSoundtrackOntoClip, soundtrackNeedsMix } from "./soundtrack.service";

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
export function cropChainFor(keyframe: CropKeyframe, track: ReframeTrack): string {
  const { sourceWidth, sourceHeight } = track;
  const { w, h } = cropGeometry(sourceWidth, sourceHeight);
  const x = Math.max(0, Math.min(sourceWidth - w, Math.round(keyframe.cx - w / 2)));
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
export function cropChainForTrack(track: ReframeTrack, windowStartSec?: number): string {
  const shifted = shiftTrackToWindow(track, windowStartSec ?? track.originSec ?? 0);
  if (shifted.mode === "resize") return reframeFilterChain(shifted);
  const keyframes = coalesceKeyframes(collapseHoldKeyframes(shifted.keyframes), MAX_SEGMENTS_PER_WINDOW);
  if (keyframes.length <= 1) {
    return cropChainFor(
      keyframes[0] ?? {
        t: 0,
        cx: shifted.sourceWidth / 2,
        cy: shifted.sourceHeight / 2,
        width: shifted.sourceWidth,
      },
      shifted
    );
  }

  const { sourceWidth, sourceHeight } = shifted;
  const { w, h } = cropGeometry(sourceWidth, sourceHeight);
  const y = Math.max(0, Math.min(sourceHeight - h, Math.round((sourceHeight - h) / 2)));
  const xOf = (keyframe: CropKeyframe) =>
    Math.max(0, Math.min(sourceWidth - w, Math.round(keyframe.cx - w / 2)));

  let xExpr = String(xOf(keyframes[keyframes.length - 1]!));
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const from = keyframes[i]!;
    const to = keyframes[i + 1]!;
    const x0 = xOf(from);
    const x1 = xOf(to);
    const span = to.t - from.t;
    const cutBetween = shifted.cuts?.some((cut) => cut > from.t + 1e-4 && cut <= to.t + 1e-4);
    const legacyJump =
      shifted.cuts === undefined &&
      (Math.abs(to.cx - from.cx) > 0.25 * from.width || span < 0.12);
    const jump = cutBetween || legacyJump;
    const piece =
      jump || x0 === x1
        ? String(x0)
        : `${x0}+(t-${from.t.toFixed(4)})/${Math.max(span, 0.001).toFixed(4)}*${x1 - x0}`;
    // 1ms early on a SNAP so a frame whose PTS is 0.03ms under the rounded
    // scene time (1097.329567 vs 1097.3296) still gets the new crop. A glide
    // keeps the exact keyframe so interpolation does not jump a millisecond.
    const edge = jump ? Math.max(from.t, to.t - 0.001) : to.t;
    xExpr = `if(lt(t\\,${edge.toFixed(4)})\\,${piece}\\,${xExpr})`;
  }

  return `crop=w=${w}:h=${h}:x=${xExpr}:y=${y},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1`;
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
  if (project.wordTimings?.length) return project.wordTimings;
  if (!project.captions?.length) return [];
  return buildWordTimeline(project.captions).map((w) => ({ t: w.startSec, word: w.text }));
}

/** The caption preset for a clip, with per-clip overrides layered on. */
function styleForClip(
  clip: IClip,
  overrides?: { captionStyleId?: string }
): CaptionStyle {
  const base = resolveCaptionStyle(overrides?.captionStyleId ?? clip.edit?.captionStyleId);
  return resolveEffectiveCaptionStyle(base, clip.edit?.captionOverrides);
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
  peakEmphasis = true
): Promise<string | undefined> {
  const captions = buildTimelineCaptions(
    wordTimingsFor(project),
    startSec,
    duration,
    peakLine,
    peakSec,
    style.chunkWords,
    textOverrides,
    peakEmphasis
  );
  if (captions.length === 0) return undefined;

  const assPath = join(scratchDir, name);
  await writeFile(assPath, renderAss(captions, assOptionsFromStyle(style)), "utf-8");
  return assPath;
}

/** A segment resolved against the source, ready to be wired into a filtergraph. */
interface PreparedSegment {
  startSec: number;
  duration: number;
  filterChain: string;
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
  peakAtSec?: number
): string {
  const value = effectiveVideoEffects(effects);
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
    filters.push(
      `scale=w='trunc(iw*(${zoomExpression})/2)*2':h='trunc(ih*(${zoomExpression})/2)*2':eval=frame`,
      `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(iw-${OUTPUT_WIDTH})/2:(ih-${OUTPUT_HEIGHT})/2`
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
          renderError: undefined,
        },
      }
    );

    const mediaPath = await ensureProjectMedia(String(project._id));
    const meta = await getVideoMetadata(mediaPath);
    await setProgress(clipId, revision, 15);

    const scratchDir = await createScratchDir(`render-${clipId}`);
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
      windows.push({
        startSec: trimmed.startSec,
        endSec: trimmed.endSec,
        mode: options.reframeMode ?? clip.edit?.reframeMode ?? "smart",
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

    const prepared = await prepareSegments({
      clip,
      project,
      mediaPath: inputPath,
      sourceWidth: meta.width,
      sourceHeight: meta.height,
      sourceDuration: meta.durationSec,
      windows,
      options,
      defaultCaptionsOn: profile.captionsDefault,
      scratchDir,
      // Only a single-window clip has a stable window to key a cache on.
      persistTrack: mergeSegments.length === 0,
      inputTimeOffset,
      // delogo is only needed when the inpaint pass did not run.
      delogoRegions: cleanedPath ? [] : cleanupRegions,
    });
    const duration = prepared.duration;
    const renderedMode = prepared.mode;
    const reframeNote =
      prepared.note ??
      (mergeSegments.length > 0
        ? `Merged from ${mergeSegments.length} segment${mergeSegments.length === 1 ? "" : "s"}`
        : undefined);

    await Clip.findByIdAndUpdate(clipId, { $set: { reframeMode: renderedMode, reframeNote } });

    const audioFx = audioEffectFilterChain(clip.edit?.videoEffects);
    const hasAudio = audioFx || prepared.segments.length > 1 ? await hasAudioStream(inputPath) : true;
    if (prepared.segments.length === 1) {
      // One segment keeps the original single-pass encode, byte-for-byte.
      const only = prepared.segments[0]!;
      await encode(inputPath, outputPath, only.startSec, only.duration, only.filterChain, hasAudio ? audioFx : "", (pct) =>
        reportProgress(clipId, revision, 20 + pct * 0.7)
      );
    } else {
      await encodeMerge(inputPath, outputPath, prepared.segments, hasAudio, duration, audioFx, (pct) =>
        reportProgress(clipId, revision, 20 + pct * 0.7)
      );
    }

    await validateArtifact(outputPath, duration);

    if (soundtrackNeedsMix(clip.edit?.soundtrack)) {
      reportProgress(clipId, revision, 90);
      outputPath = await mixSoundtrackOntoClip(
        String(project._id),
        outputPath,
        duration,
        clip.edit?.soundtrack,
        scratchDir
      );
      await validateArtifact(outputPath, duration);
    }

    const delivered = await deliverArtifact(clip, project, outputPath);

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
  captionStyleId?: string;
  captionsOn?: boolean;
  /** For error messages. */
  label?: string;
}

/** Cap on segments from ONE window. A filtergraph is a literal argument list. */
const MAX_SEGMENTS_PER_WINDOW = 120;

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
    if (sinceGroup === 0) groups.push(current);
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
    const sameCrop =
      Math.abs(current.cx - previous.cx) <= 4 && Math.abs(current.width - previous.width) <= 4;
    const holdBeforeSnap =
      next !== undefined &&
      next.t - current.t <= 0.12 &&
      Math.abs(current.cx - previous.cx) <= 0.25 * previous.width &&
      Math.abs(next.cx - current.cx) > 0.25 * current.width;
    if (sameCrop || holdBeforeSnap) continue;
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
const REFRAME_CACHE_VERSION = 11;

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
      hydrated?.track.originSec ?? input.window.startSec
    )
  );
  const coverEnd = round3(
    Math.max(
      input.window.endSec,
      input.clip.endSec,
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
}): Promise<{ segments: PreparedSegment[]; duration: number; mode: IClip["reframeMode"]; note?: string }> {
  const segments: PreparedSegment[] = [];
  let duration = 0;
  let mode: IClip["reframeMode"];
  let note: string | undefined;

  for (let w = 0; w < input.windows.length; w++) {
    const window = input.windows[w]!;
    if (window.endSec - window.startSec < MIN_SEGMENT_SEC) {
      throw new Error(
        `${window.label ?? `Segment ${w + 1}`} (${window.startSec.toFixed(1)}s–${window.endSec.toFixed(
          1
        )}s) is empty or past the end of the source video.`
      );
    }

    const track = await resolveTrack({
      clip: input.clip,
      mediaPath: input.mediaPath,
      window,
      sourceWidth: input.sourceWidth,
      sourceHeight: input.sourceHeight,
      persist: input.persistTrack,
    });
    mode ??= track.mode;
    note ??= track.note;

    const pieceDuration = window.endSec - window.startSec;
    duration += pieceDuration;

    let assPath: string | undefined;
    if (input.options.captions ?? captionsOnFor(input.clip, input.defaultCaptionsOn, window)) {
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
        input.clip.edit?.captionOverrides?.peakEmphasis !== false
      );
    }

    const base = cropChainForTrack(track, window.startSec);
    const pictureEffects = videoEffectFilterChain(
      input.clip.edit?.videoEffects,
      input.clip.peakSec >= window.startSec && input.clip.peakSec <= window.endSec
        ? input.clip.peakSec - window.startSec
        : undefined
    );

    const delogo = cleanupDelogoChain(
      input.delogoRegions,
      input.sourceWidth,
      input.sourceHeight,
      window.startSec,
      pieceDuration
    );

    segments.push({
      startSec: window.startSec - input.inputTimeOffset,
      duration: pieceDuration,
      filterChain: `${delogo ? `${delogo},` : ""}${base}${pictureEffects ? `,${pictureEffects}` : ""}${assPath ? `,${assVideoFilter(assPath)}` : ""},format=yuv420p`,
    });
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
  scratchOutputPath: string
): Promise<Delivered> {
  const bytes = await getFileSize(scratchOutputPath);
  const clipId = String(clip._id);

  if (project.storage === "s3" && isS3Configured() && project.s3Prefix) {
    const key = `${project.s3Prefix}clips/${clipId}.mp4`;
    const outputUrl = await uploadFileAtKey(scratchOutputPath, key, "video/mp4");

    // Retire the old rank-keyed object for this clip. Safe only after the new
    // key is verified above — until then the clip's only copy is the old object.
    const legacyKey = `${project.s3Prefix}clips/${clip.rank}.mp4`;
    if (legacyKey !== key) {
      await deleteKey(legacyKey).catch((error: unknown) => {
        console.warn(`⚠️  Could not retire legacy S3 key ${legacyKey}: ${getErrorMessage(error)}`);
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
  const $unset: Record<string, 1> = {};
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
  if (!rendered || rendered.durationSec < duration * 0.5) {
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
      .on("error", (err) => reject(new Error(`Render failed: ${err.message}`)))
      .run();
  });
}

/**
 * Concatenate discontiguous windows (a user-made merge). Each window is already
 * one continuous decode with a keyframed crop, so this is only for joining
 * separate source ranges — not for camera cuts inside a window.
 */
async function encodeMerge(
  mediaPath: string,
  outputPath: string,
  segments: PreparedSegment[],
  audio: boolean,
  totalDuration: number,
  audioFilter: string,
  onProgress: (pct: number) => void
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

  const graph: string[] = [];
  const concatParts: string[] = [];
  segments.forEach((segment, index) => {
    const trim = `trim=start=${segment.startSec.toFixed(4)}:duration=${segment.duration.toFixed(4)}`;
    graph.push(`[${index}:v]${trim},${alignPtsToTrim(segment.startSec)},${segment.filterChain}[v${index}]`);
    if (audio) {
      graph.push(
        `[${index}:a]atrim=start=${segment.startSec.toFixed(4)}:duration=${segment.duration.toFixed(4)},aresample=async=1:first_pts=0,asetpts=PTS-(${segment.startSec.toFixed(4)}/TB)${audioFilter ? `,${audioFilter}` : ""}[a${index}]`
      );
    }
    concatParts.push(`[v${index}]`);
    if (audio) concatParts.push(`[a${index}]`);
  });
  graph.push(
    `${concatParts.join("")}concat=n=${segments.length}:v=1:a=${audio ? 1 : 0}[outv]${audio ? "[outa]" : ""}`
  );

  args.push("-filter_complex", graph.join(";"), "-map", "[outv]");
  if (audio) args.push("-map", "[outa]");
  args.push(
    "-c:v", "libx264",
    "-preset", config.ffmpegPreset,
    "-crf", String(config.ffmpegCrf),
    "-pix_fmt", "yuv420p"
  );
  if (audio) args.push("-c:a", "aac", "-b:a", "128k");
  args.push("-movflags", "+faststart", "-progress", "pipe:1", outputPath);

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
