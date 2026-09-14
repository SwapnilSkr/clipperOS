import type { BehindTitle, CropKeyframe, ReframeTrack } from "@/api";
import { followCx, type CameraState } from "@/lib/creator-timeline";
import { activeTitles, titleEntranceAt, titleFontPx, wrapTitle, TITLE_DEFAULT_FONT } from "@/lib/titles";

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
  sourceHeight: number,
  /** Creator mode's follow: blend the seat crop toward the recorded face. */
  tightness = 0
): CropKeyframe {
  const fallback = centreCrop(sourceWidth, sourceHeight);
  if (!track || track.keyframes.length === 0) return fallback;
  track = holdCropUntilCuts(track);
  // A whole-frame pillarbox shows everything, so its "crop" is the full frame.
  if (track.mode === "resize") {
    return { t: 0, cx: sourceWidth / 2, cy: sourceHeight / 2, width: sourceWidth };
  }

  let previousKey = track.keyframes[0]!;
  let upcomingKey: CropKeyframe | undefined;
  for (const keyframe of track.keyframes) {
    if (keyframe.t <= seconds + 0.001) previousKey = keyframe;
    else {
      upcomingKey = keyframe;
      break;
    }
  }
  const previous = { ...previousKey, cx: followCx(previousKey, tightness, sourceWidth) };
  if (!upcomingKey) return previous;
  const upcoming = { ...upcomingKey, cx: followCx(upcomingKey, tightness, sourceWidth) };

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
  frameHeight: number,
  tightness = 0
): CropTransform {
  return cropLayoutFor(
    cropAtTime(track, seconds, sourceWidth, sourceHeight, tightness),
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
/** What the creator desk layers onto a painted frame. */
export interface PaintExtras {
  /** Digital zoom + anchor, applied like the burn: after the crop. */
  camera?: CameraState;
  /** Titles on the plan; the ones active at `sourceSec` are drawn. */
  titles?: BehindTitle[];
  /** Absolute source time of the frame, for title timing. */
  sourceSec?: number;
  /** The person matte video (source space, small), kept in step with the source. */
  matte?: { video: HTMLVideoElement; width: number; height: number } | null;
  /** CSS font stack + weight for a title's family. */
  fontFor?: (family: string) => { stack: string; weight: number };
}

/** The part of the crop box that survives a zoom converging on (ax, ay). */
function zoomedBox(box: CropBox, camera: CameraState | undefined): CropBox {
  if (!camera || camera.zoom <= 1.0001) return box;
  const width = box.width / camera.zoom;
  const height = box.height / camera.zoom;
  return {
    width,
    height,
    x: box.x + (box.width - width) * camera.ax,
    y: box.y + (box.height - height) * camera.ay,
  };
}

let scratchCanvas: HTMLCanvasElement | null = null;
let maskCanvas: HTMLCanvasElement | null = null;

/**
 * The matte is a grayscale VIDEO: opaque everywhere, luma is the mask. Canvas
 * compositing only reads alpha, so the luma is copied into the alpha channel
 * here (limited-range 16..235 mapped to 0..255). One pass per painted frame,
 * only while a behind-title is on screen.
 */
function lumaToAlphaMask(
  matte: NonNullable<PaintExtras["matte"]>,
  box: CropBox,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number
): HTMLCanvasElement | null {
  maskCanvas ??= document.createElement("canvas");
  if (maskCanvas.width !== width || maskCanvas.height !== height) {
    maskCanvas.width = width;
    maskCanvas.height = height;
  }
  const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!mctx) return null;
  const sx = matte.width / sourceWidth;
  const sy = matte.height / sourceHeight;
  mctx.globalCompositeOperation = "source-over";
  mctx.drawImage(matte.video, box.x * sx, box.y * sy, box.width * sx, box.height * sy, 0, 0, width, height);
  const image = mctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = data[i]!;
    data[i + 3] = luma <= 16 ? 0 : luma >= 235 ? 255 : Math.round(((luma - 16) / 219) * 255);
  }
  mctx.putImageData(image, 0, 0);
  return maskCanvas;
}

function drawTitle(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  title: BehindTitle,
  sourceSec: number,
  fontFor?: PaintExtras["fontFor"]
): void {
  const entrance = titleEntranceAt(title, sourceSec);
  if (entrance.alpha <= 0) return;
  const scale = canvas.height / 1920;
  const px = titleFontPx(title);
  const font = fontFor?.(title.fontFamily ?? TITLE_DEFAULT_FONT);
  const lines = wrapTitle(title.uppercase ? title.text.toUpperCase() : title.text, px);
  const lineHeight = px * 1.12 * scale;
  const cx = title.x * canvas.width;
  const cy = title.y * canvas.height + entrance.dy * scale;
  ctx.save();
  ctx.globalAlpha = entrance.alpha;
  ctx.translate(cx, cy);
  ctx.scale(entrance.scale, entrance.scale);
  ctx.font = `${font?.weight ?? 400} ${px * scale}px ${font?.stack ?? `${TITLE_DEFAULT_FONT}, Impact, sans-serif`}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, px * scale * 0.09);
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.fillStyle = title.color;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 6 * scale;
  ctx.shadowOffsetY = 4 * scale;
  lines.forEach((line, index) => {
    const y = (index - (lines.length - 1) / 2) * lineHeight;
    ctx.strokeText(line, 0, y);
    ctx.fillText(line, 0, y);
  });
  ctx.restore();
}

/**
 * Paint the current video frame through the 9:16 crop, then creator mode's
 * layers in the burn's order: picture (crop + zoom) → behind-titles → the
 * speaker's cutout → front-titles. Captions are a DOM overlay on top.
 */
export function paintCropPreview(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  track: ReframeTrack | undefined,
  clipTime: number,
  sourceWidth: number,
  sourceHeight: number,
  tightness = 0,
  extras: PaintExtras = {}
): void {
  if (video.readyState < 2 || sourceWidth < 2 || sourceHeight < 2) return;
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width < 2 || canvas.height < 2) return;
  const crop = cropBoxFor(cropAtTime(track, clipTime, sourceWidth, sourceHeight, tightness), sourceWidth, sourceHeight);
  const box = zoomedBox(crop, extras.camera);
  ctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);

  const sourceSec = extras.sourceSec;
  const titles = sourceSec != null ? activeTitles(extras.titles, sourceSec) : [];
  if (titles.length === 0 || sourceSec == null) return;

  const behind = titles.filter((title) => title.depth === "behind");
  const front = titles.filter((title) => title.depth === "front");
  const matte = extras.matte;
  const matteReady = Boolean(matte && matte.video.readyState >= 2);

  if (behind.length > 0 && matteReady && matte) {
    for (const title of behind) drawTitle(ctx, canvas, title, sourceSec, extras.fontFor);
    // The cutout: the same frame region masked by the matte, composited back.
    scratchCanvas ??= document.createElement("canvas");
    if (scratchCanvas.width !== canvas.width || scratchCanvas.height !== canvas.height) {
      scratchCanvas.width = canvas.width;
      scratchCanvas.height = canvas.height;
    }
    const sctx = scratchCanvas.getContext("2d");
    const mask = lumaToAlphaMask(matte, box, sourceWidth, sourceHeight, canvas.width, canvas.height);
    if (sctx && mask) {
      sctx.globalCompositeOperation = "source-over";
      sctx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
      sctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, scratchCanvas.width, scratchCanvas.height);
      sctx.globalCompositeOperation = "destination-in";
      sctx.drawImage(mask, 0, 0);
      sctx.globalCompositeOperation = "source-over";
      ctx.drawImage(scratchCanvas, 0, 0);
    }
  } else {
    // No matte yet: a behind-title shows in front rather than not at all.
    for (const title of behind) drawTitle(ctx, canvas, title, sourceSec, extras.fontFor);
  }
  for (const title of front) drawTitle(ctx, canvas, title, sourceSec, extras.fontFor);
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
