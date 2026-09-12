import type { CropKeyframe, ReframeTrack } from "@/api";

// ============================================================
// CROP PREVIEW
//
// The renderer reads a 9:16 window out of a 16:9 source, so the editor must show
// the same window. Rendering the whole source inside a portrait frame (what this
// replaced) drew a 1920x1080 video into a 340x604 box: 338x190 of content and 412
// pixels of black bars — the preview said the clips were not 9:16 when the
// rendered file is a clean 1080x1920 crop.
//
// Across a CUT the crop holds, then snaps. Across a speaker GLIDE it
// interpolates so the editor does not chatter between stepped keyframes.
// ============================================================

const TARGET_ASPECT = 9 / 16;
const PRE_CUT_HOLD_SEC = 1 / 12 + 0.02;

/** Drop crop keyframes in the 12fps bin leading into a camera cut. */
export function holdCropUntilCuts(track: ReframeTrack): ReframeTrack {
  if (!track.cuts?.length || track.keyframes.length < 2) return track;
  const keyframes = track.keyframes.filter((keyframe) => {
    if (keyframe.t <= 1e-6) return true;
    return !track.cuts!.some((cut) => keyframe.t >= cut - PRE_CUT_HOLD_SEC && keyframe.t < cut - 1e-4);
  });
  if (keyframes.length === track.keyframes.length) return track;
  return { ...track, keyframes };
}

/** A fixed centre crop, matching `cropGeometry` in the renderer. */
export function centreCrop(sourceWidth: number, sourceHeight: number): CropKeyframe {
  let w = Math.min(sourceWidth, Math.round(sourceHeight * TARGET_ASPECT));
  let h = Math.round(w / TARGET_ASPECT);
  if (h > sourceHeight) {
    h = sourceHeight;
    w = Math.round(h * TARGET_ASPECT);
  }
  return {
    t: 0,
    cx: sourceWidth / 2,
    cy: sourceHeight / 2,
    width: Math.max(2, Math.round(w / 2) * 2),
  };
}

/**
 * The crop in force at `seconds` on the CLIP timeline (t=0 at `track.originSec`).
 *
 * Falls back to a centred 9:16 window when no track is stored, which is what
 * fixes the framing of a clip that has never been analysed or rendered.
 */
export function cropAtTime(
  track: ReframeTrack | undefined,
  seconds: number,
  sourceWidth: number,
  sourceHeight: number
): CropKeyframe {
  const fallback = centreCrop(sourceWidth, sourceHeight);
  if (!track || track.keyframes.length === 0) return fallback;
  track = holdCropUntilCuts(track);
  // A whole-frame pillarbox shows everything, so its "crop" is the full frame.
  if (track.mode === "resize") {
    return { t: 0, cx: sourceWidth / 2, cy: sourceHeight / 2, width: sourceWidth };
  }

  let previous = track.keyframes[0]!;
  let upcoming: CropKeyframe | undefined;
  for (const keyframe of track.keyframes) {
    if (keyframe.t <= seconds + 0.001) previous = keyframe;
    else {
      upcoming = keyframe;
      break;
    }
  }
  if (!upcoming) return previous;

  // Across a camera cut the crop holds then snaps. Interpolating here is what
  // makes the next speaker's head slide in from the side of the 9:16 window.
  const span = upcoming.t - previous.t;
  const cutBetween = track.cuts?.some((cut) => cut > previous.t + 1e-4 && cut <= upcoming.t + 1e-4);
  // Modern tracks identify camera cuts explicitly. Distance alone is not a
  // safe discriminator: a fast glide between two widely separated speakers
  // can legitimately move more than a quarter crop-width per keyframe.
  const legacyJump =
    track.cuts === undefined &&
    (Math.abs(upcoming.cx - previous.cx) > 0.25 * previous.width || span < 0.12);
  const jump = cutBetween || legacyJump;
  if (jump) return previous;

  const u = Math.max(0, Math.min(1, (seconds - previous.t) / span));
  return {
    t: seconds,
    cx: previous.cx + (upcoming.cx - previous.cx) * u,
    cy: previous.cy + (upcoming.cy - previous.cy) * u,
    width: previous.width + (upcoming.width - previous.width) * u,
  };
}

export interface CropBox {
  /** Crop size in SOURCE pixels. */
  width: number;
  height: number;
  /** Crop top-left in SOURCE pixels. */
  x: number;
  y: number;
}

/** Resolve a keyframe into a clamped crop box within the source frame. */
export function cropBoxFor(
  keyframe: CropKeyframe,
  sourceWidth: number,
  sourceHeight: number
): CropBox {
  const height = Math.min(sourceHeight, Math.round(keyframe.width / TARGET_ASPECT));
  const width = Math.min(sourceWidth, Math.round(keyframe.width));
  const x = Math.max(0, Math.min(sourceWidth - width, Math.round(keyframe.cx - width / 2)));
  const y = Math.max(0, Math.min(sourceHeight - height, Math.round(keyframe.cy - height / 2)));
  return { width, height, x, y };
}

export interface CropTransform {
  /** Scale to apply to the source so the crop fills the frame. */
  scale: number;
  /** Offset of the source's top-left, in frame pixels. */
  left: number;
  top: number;
  box: CropBox;
}

/**
 * How to place the source inside a `frameWidth` x `frameHeight` portrait frame so
 * that exactly the crop is visible.
 *
 * The frame's aspect is the output's, so the crop maps onto it 1:1 by width.
 */
export function cropTransformFor(
  track: ReframeTrack | undefined,
  seconds: number,
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number
): CropTransform {
  return cropLayoutFor(
    cropAtTime(track, seconds, sourceWidth, sourceHeight),
    sourceWidth,
    sourceHeight,
    frameWidth,
    frameHeight
  );
}

/** Place a known keyframe's crop in the portrait frame. */
export function cropLayoutFor(
  keyframe: CropKeyframe,
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number
): CropTransform {
  const box = cropBoxFor(keyframe, sourceWidth, sourceHeight);
  const scale = Math.min(frameWidth / box.width, frameHeight / box.height);
  return {
    scale,
    left: Math.round(-box.x * scale),
    top: Math.round(-box.y * scale),
    box,
  };
}

/**
 * Paint the current video frame through the 9:16 crop. CSS-translating the
 * <video> is always a frame late on a camera cut — the new picture shows
 * through the old window, then the window slides, which is the head arriving
 * from the left. Drawing the crop from this frame's currentTime keeps them
 * on the same paint.
 */
export function sourceTimeOnTrack(
  track: ReframeTrack | undefined,
  sourceTime: number,
  fallbackOrigin: number
): number {
  return sourceTime - (track?.originSec ?? fallbackOrigin);
}

/**
 * Paint the current video frame through the 9:16 crop. CSS-translating the
 * <video> is always a frame late on a camera cut — the new picture shows
 * through the old window, then the window slides, which is the head arriving
 * from the left. Drawing the crop from this frame's currentTime keeps them
 * on the same paint.
 */
export function paintCropPreview(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  track: ReframeTrack | undefined,
  clipTime: number,
  sourceWidth: number,
  sourceHeight: number
): void {
  if (video.readyState < 2 || sourceWidth < 2 || sourceHeight < 2) return;
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width < 2 || canvas.height < 2) return;
  const box = cropBoxFor(cropAtTime(track, clipTime, sourceWidth, sourceHeight), sourceWidth, sourceHeight);
  ctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
}

/** The inverse: a point in frame pixels -> SOURCE pixels. */
export function frameToSource(
  transform: CropTransform,
  frameX: number,
  frameY: number
): { x: number; y: number } {
  return { x: transform.box.x + frameX / transform.scale, y: transform.box.y + frameY / transform.scale };
}

/** The forward: a source pixel -> frame pixels. */
export function sourceToFrame(
  transform: CropTransform,
  sourceX: number,
  sourceY: number
): { x: number; y: number } {
  return {
    x: (sourceX - transform.box.x) * transform.scale,
    y: (sourceY - transform.box.y) * transform.scale,
  };
}
