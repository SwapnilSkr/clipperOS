import type {
  CameraAnchor,
  CameraMove,
  CameraPlan,
  CreatorPlan,
  CropKeyframe,
  FollowResponse,
  PauseCut,
  ReframeTrack,
} from "../types/clip.types";

// ============================================
// CREATOR TIMELINE — pure maths shared by the renderer and the editor.
//
// A beat plan is written in absolute SOURCE seconds. Pause cuts remove spans,
// so the OUTPUT clock (what the viewer sees, what SFX hits are placed on) runs
// slower than the source clock. Everything that converts between the two, and
// everything that says "how zoomed is the picture at this instant", lives here
// so the preview and the burn cannot disagree.
//
// Ported verbatim to client/src/lib/creator-timeline.ts. If a rule changes
// here, change it there; scripts/validate-creator.ts asserts the two agree.
// ============================================

export interface TimeWindow {
  startSec: number;
  endSec: number;
}

/** A kept span shorter than this is absorbed into the surrounding cut. */
export const MIN_KEPT_SEC = 0.25;
/** A cut shorter than this is not worth a splice. */
export const MIN_CUT_SEC = 0.12;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Enabled cuts, clipped to the trim, sorted, and merged where they overlap or
 * touch. The only cut list the renderer and the player should ever look at.
 */
export function activeCuts(cuts: PauseCut[] | undefined, trimStart: number, trimEnd: number): TimeWindow[] {
  const spans = (cuts ?? [])
    .filter((cut) => cut.enabled)
    .map((cut) => ({
      startSec: Math.max(trimStart, cut.startSec),
      endSec: Math.min(trimEnd, cut.endSec),
    }))
    .filter((span) => span.endSec - span.startSec >= MIN_CUT_SEC)
    .sort((a, b) => a.startSec - b.startSec);

  const merged: TimeWindow[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.startSec <= last.endSec + 1e-6) {
      last.endSec = Math.max(last.endSec, span.endSec);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * The kept windows of a trim after its cuts — the complement of `activeCuts`.
 * Always returns at least one window; a plan that would cut everything keeps
 * the whole trim rather than rendering nothing.
 */
export function windowsFor(trimStart: number, trimEnd: number, cuts?: PauseCut[]): TimeWindow[] {
  const removed = activeCuts(cuts, trimStart, trimEnd);
  const kept: TimeWindow[] = [];
  let cursor = trimStart;
  for (const cut of removed) {
    if (cut.startSec - cursor >= MIN_KEPT_SEC) kept.push({ startSec: round3(cursor), endSec: round3(cut.startSec) });
    cursor = Math.max(cursor, cut.endSec);
  }
  if (trimEnd - cursor >= MIN_KEPT_SEC) kept.push({ startSec: round3(cursor), endSec: round3(trimEnd) });
  if (kept.length === 0) return [{ startSec: round3(trimStart), endSec: round3(trimEnd) }];
  return kept;
}

export function outputDuration(windows: TimeWindow[]): number {
  return windows.reduce((sum, window) => sum + Math.max(0, window.endSec - window.startSec), 0);
}

/** Index of the window containing `sourceSec`, or -1 when it falls in a cut. */
export function windowIndexAt(windows: TimeWindow[], sourceSec: number): number {
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i]!;
    if (sourceSec >= window.startSec - 1e-6 && sourceSec < window.endSec + 1e-6) return i;
  }
  return -1;
}

/**
 * Source → output. A time inside a cut maps to the output instant where the
 * cut happens, so a marker placed in dead air lands on the splice.
 */
export function sourceToOutput(windows: TimeWindow[], sourceSec: number): number {
  let elapsed = 0;
  for (const window of windows) {
    if (sourceSec < window.startSec) return elapsed;
    if (sourceSec <= window.endSec) return elapsed + (sourceSec - window.startSec);
    elapsed += window.endSec - window.startSec;
  }
  return elapsed;
}

/** Output → source. Clamped to the last window's end. */
export function outputToSource(windows: TimeWindow[], outputSec: number): number {
  let elapsed = 0;
  for (const window of windows) {
    const length = window.endSec - window.startSec;
    if (outputSec <= elapsed + length) return window.startSec + Math.max(0, outputSec - elapsed);
    elapsed += length;
  }
  const last = windows[windows.length - 1];
  return last ? last.endSec : 0;
}

/**
 * Where playback should be if it is at `sourceSec`: unchanged inside a window,
 * otherwise the start of the next kept window (or the end when none is left).
 */
export function nextKeptTime(windows: TimeWindow[], sourceSec: number): number {
  for (const window of windows) {
    if (sourceSec < window.startSec) return window.startSec;
    if (sourceSec <= window.endSec) return sourceSec;
  }
  const last = windows[windows.length - 1];
  return last ? last.endSec : sourceSec;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export function easeOutCubic(u: number): number {
  const c = Math.max(0, Math.min(1, u));
  return 1 - Math.pow(1 - c, 3);
}

export function easeInOutCubic(u: number): number {
  const c = Math.max(0, Math.min(1, u));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** How long a punch's edges ramp for. `cut` is instant. */
export function moveRampSec(move: CameraMove): number {
  if (move.ease === "cut") return 0;
  return Math.min(0.22, Math.max(0, (move.endSec - move.startSec) / 3));
}

/** A push creeps in and lets go over this long at its end. */
export function pushReleaseSec(move: CameraMove): number {
  return Math.min(0.3, Math.max(0.05, (move.endSec - move.startSec) / 4));
}

/**
 * 0-1 share of the move's zoom in force at `sourceSec` (0 outside the span).
 * This is the numeric twin of the FFmpeg expression in camera.service.ts.
 */
export function moveAmountAt(move: CameraMove, sourceSec: number): number {
  const span = move.endSec - move.startSec;
  if (span <= 0 || sourceSec < move.startSec || sourceSec >= move.endSec) return 0;
  const ease = move.ease === "in_out" ? easeInOutCubic : easeOutCubic;
  const local = sourceSec - move.startSec;
  if (move.kind === "punch") {
    const ramp = moveRampSec(move);
    if (ramp <= 0) return 1;
    if (local < ramp) return ease(local / ramp);
    if (span - local < ramp) return ease((span - local) / ramp);
    return 1;
  }
  if (move.kind === "push") {
    const release = pushReleaseSec(move);
    const creep = Math.max(0.05, span - release);
    if (local < creep) return local / creep;
    return easeOutCubic((span - local) / release);
  }
  // pull: start at full zoom, settle to none.
  return 1 - ease(local / span);
}

export interface CameraState {
  /** Combined digital zoom, ≥ 1. */
  zoom: number;
  /** Fractions of the output frame the zoom converges on. */
  ax: number;
  ay: number;
}

/** The move in force at `sourceSec`, if any. Moves are non-overlapping after sanitising. */
export function moveAt(camera: CameraPlan | undefined, sourceSec: number): CameraMove | undefined {
  return camera?.moves.find((move) => sourceSec >= move.startSec && sourceSec < move.endSec);
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** How hard the crop follows the face: 0 unless creator mode's follow is on. */
export function followTightness(plan: CreatorPlan | undefined): number {
  if (!plan?.enabled || !plan.camera?.follow?.enabled) return 0;
  return Math.max(0, Math.min(1, plan.camera.follow.tightness));
}

/** Tightness across the frame (the pan); 0 when the follow is vertical-only. */
export function followTightnessX(plan: CreatorPlan | undefined): number {
  return (plan?.camera?.follow?.axis ?? "both") === "y" ? 0 : followTightness(plan);
}

/** Tightness up the frame (the slide); 0 when the follow is horizontal-only. */
export function followTightnessY(plan: CreatorPlan | undefined): number {
  return (plan?.camera?.follow?.axis ?? "both") === "x" ? 0 : followTightness(plan);
}

/**
 * How far a face sample reaches when smoothing, in seconds (Gaussian sigma),
 * per response. Snappy keeps a nod; natural keeps a lean; smooth keeps only
 * posture. The path itself is analysed once — this is applied on the way out,
 * so changing it never re-analyses.
 */
export const FOLLOW_SIGMA_SEC: Record<FollowResponse, number> = { snappy: 0.07, natural: 0.3, smooth: 0.7 };

export function followSigma(plan: CreatorPlan | undefined): number {
  return FOLLOW_SIGMA_SEC[plan?.camera?.follow?.response ?? "natural"];
}

/**
 * Follow needs headroom: the head is pinned vertically by sliding the zoomed
 * picture, and that slide is only (zoom − 1) of the frame. This is the least
 * a following camera zooms.
 */
export const FOLLOW_MIN_ZOOM = 1.08;

/** The persistent zoom while following; 1 when not following. */
export function followZoom(plan: CreatorPlan | undefined): number {
  const follow = plan?.enabled ? plan.camera?.follow : undefined;
  if (!follow?.enabled) return 1;
  return Math.max(FOLLOW_MIN_ZOOM, follow.zoom ?? FOLLOW_MIN_ZOOM);
}

/**
 * The crop centre with follow applied. The analysis keeps the crop steady on
 * the SEAT and records the face beside it; follow blends the crop toward the
 * face by `tightness`, so at 1 the 9:16 window mirrors the speaker's motion.
 */
export function followCx(keyframe: CropKeyframe, tightness: number, sourceWidth: number): number {
  if (!(tightness > 0) || keyframe.fx == null) return keyframe.cx;
  const half = keyframe.width / 2;
  const faceCx = Math.max(half, Math.min(sourceWidth - half, keyframe.fx));
  return keyframe.cx + (faceCx - keyframe.cx) * tightness;
}

/** The 9:16 crop box the renderer would use for a keyframe, source pixels. */
export function cropBoxAt(
  keyframe: CropKeyframe,
  track: Pick<ReframeTrack, "sourceWidth" | "sourceHeight">,
  tightness = 0
): { x: number; y: number; w: number; h: number } {
  const { sourceWidth, sourceHeight } = track;
  let w = Math.min(sourceWidth, Math.round(sourceHeight * (9 / 16)));
  let h = Math.round(w * (16 / 9));
  if (h > sourceHeight) {
    h = sourceHeight;
    w = Math.round(h * (9 / 16));
  }
  const cx = followCx(keyframe, tightness, sourceWidth);
  const x = Math.max(0, Math.min(sourceWidth - w, Math.round(cx - w / 2)));
  const y = Math.max(0, Math.min(sourceHeight - h, Math.round(keyframe.cy - h / 2)));
  return { x, y, w, h };
}

/** A keyframe's face projected into OUTPUT-frame fractions, or undefined. */
export function faceAnchorOfKeyframe(
  keyframe: CropKeyframe,
  track: Pick<ReframeTrack, "sourceWidth" | "sourceHeight">,
  tightness = 0
): { x: number; y: number } | undefined {
  if (keyframe.fx == null) return undefined;
  const box = cropBoxAt(keyframe, track, tightness);
  return {
    x: Math.max(0.1, Math.min(0.9, (keyframe.fx - box.x) / box.w)),
    y: Math.max(0.1, Math.min(0.9, ((keyframe.fy ?? keyframe.cy) - box.y) / box.h)),
  };
}

/**
 * The speaker's face as a fraction of the OUTPUT frame at `sourceSec`, or
 * undefined when the track carries no face. Projects the face through the
 * 9:16 crop box in force at that instant (same clamping as the renderer).
 */
export const FACE_SMOOTH_SIGMA_SEC = FOLLOW_SIGMA_SEC.natural;

/** The face-carrying keyframes of the shot containing `t`, in order, and the shot's span. */
function shotFaces(track: ReframeTrack, t: number): { faces: CropKeyframe[]; from: number; to: number } {
  let from = -Infinity;
  let to = Infinity;
  for (const cut of track.cuts ?? []) {
    if (cut <= t + 1e-4) from = Math.max(from, cut);
    else to = Math.min(to, cut);
  }
  const faces = track.keyframes.filter((key) => key.fx != null && key.t + 1e-4 >= from && key.t + 1e-4 < to);
  const last = track.keyframes[track.keyframes.length - 1];
  const end = Math.max(last?.t ?? 0, (track.untilSec ?? 0) - (track.originSec ?? 0));
  return { faces, from: Math.max(from, faces[0]?.t ?? 0), to: Math.min(to, end) };
}

/** The face path within a shot: linear between its keyframes, held beyond them. */
function faceOnPath(faces: CropKeyframe[], t: number): { x: number; y: number } | undefined {
  let before: CropKeyframe | undefined;
  let after: CropKeyframe | undefined;
  for (const key of faces) {
    if (key.t <= t + 1e-4) before = key;
    else {
      after = key;
      break;
    }
  }
  const at = (key: CropKeyframe) => ({ x: key.fx!, y: key.fy ?? key.cy });
  if (!before) return after ? at(after) : undefined;
  if (!after) return at(before);
  const u = (t - before.t) / (after.t - before.t);
  return { x: lerp(before.fx!, after.fx!, u), y: lerp(before.fy ?? before.cy, after.fy ?? after.cy, u) };
}

/** Sampling step when integrating the face path, seconds. */
const FACE_PATH_STEP_SEC = 1 / 24;

/**
 * The track with each keyframe's face averaged over the surrounding path in
 * the same shot. A detector box breathes with head tilt and a beard; a camera
 * that pins to the raw box would twitch with it. The average is over TIME on
 * the interpolated path, not over keyframes: the analyser emits keyframes as
 * the head moves and none while it rests, so a per-keyframe mean would lean
 * toward the motion. Seat centres are left alone.
 */
export function smoothedTrack(track: ReframeTrack, sigmaSec = FACE_SMOOTH_SIGMA_SEC): ReframeTrack {
  const reach = sigmaSec * 3;
  const keyframes: CropKeyframe[] = [];
  for (const keyframe of track.keyframes) {
    if (keyframe.fx == null) {
      keyframes.push(keyframe);
      continue;
    }
    const shot = shotFaces(track, keyframe.t);
    let weight = 0;
    let fx = 0;
    let fy = 0;
    for (let dt = -reach; dt <= reach + 1e-9; dt += FACE_PATH_STEP_SEC) {
      const t = keyframe.t + dt;
      if (t + 1e-4 < shot.from || t + 1e-4 >= shot.to) continue;
      const face = faceOnPath(shot.faces, t);
      if (!face) continue;
      const w = Math.exp(-(dt * dt) / (2 * sigmaSec * sigmaSec));
      weight += w;
      fx += w * face.x;
      fy += w * face.y;
    }
    keyframes.push(weight > 0 ? { ...keyframe, fx: fx / weight, fy: fy / weight } : keyframe);
    // The last sample of a shot is held to its end, so the average taken AT it
    // (still looking back over the motion that led there) would be held too.
    // One reach later every sample is the rest itself: settle there.
    const last = shot.faces[shot.faces.length - 1];
    if (last === keyframe && keyframe.t + reach < shot.to - 1e-3) {
      keyframes.push({ ...keyframe, t: keyframe.t + reach, fx: keyframe.fx, fy: keyframe.fy ?? keyframe.cy });
    }
  }
  return { ...track, keyframes };
}

/**
 * Where the head rests in this keyframe's shot: the time-weighted mean face-y
 * fraction along the shot's path (a 20 s hold counts for 20 s, a 0.5 s dip
 * for 0.5 s).
 */
export function faceRestY(keyframe: CropKeyframe, track: ReframeTrack): number {
  const shot = shotFaces(track, keyframe.t);
  const fractionOf = (key: CropKeyframe) => {
    const box = cropBoxAt(key, track);
    return ((key.fy ?? key.cy) - box.y) / box.h;
  };
  let sum = 0;
  let span = 0;
  for (let i = 0; i < shot.faces.length; i++) {
    const key = shot.faces[i]!;
    const next = shot.faces[i + 1];
    // A linear segment's mean is the mean of its ends; the last keyframe holds to the shot's end.
    const dt = (next ? next.t : shot.to) - key.t;
    if (dt <= 0) continue;
    sum += ((fractionOf(key) + (next ? fractionOf(next) : fractionOf(key))) / 2) * dt;
    span += dt;
  }
  if (span <= 0) return fractionOf(shot.faces[0] ?? keyframe);
  return sum / span;
}

/**
 * How far the head travels within one shot, as fractions of the 9:16 crop —
 * the most any shot moves, across and up. What a follow has to work with:
 * 0.02 is a still speaker, 0.1 a lively one.
 */
export function headTravel(track: ReframeTrack | undefined): { x: number; y: number } | undefined {
  if (!track || track.mode === "resize") return undefined;
  const faces = track.keyframes.filter((key) => key.fx != null);
  if (faces.length === 0) return undefined;
  const cuts = track.cuts ?? [];
  const shotOf = (t: number) => cuts.filter((cut) => cut <= t + 1e-4).length;
  const shots = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>();
  for (const key of faces) {
    const shot = shotOf(key.t);
    const x = key.fx!;
    const y = key.fy ?? key.cy;
    const range = shots.get(shot) ?? { minX: x, maxX: x, minY: y, maxY: y };
    range.minX = Math.min(range.minX, x);
    range.maxX = Math.max(range.maxX, x);
    range.minY = Math.min(range.minY, y);
    range.maxY = Math.max(range.maxY, y);
    shots.set(shot, range);
  }
  const box = cropBoxAt(faces[0]!, track);
  let x = 0;
  let y = 0;
  for (const range of shots.values()) {
    x = Math.max(x, (range.maxX - range.minX) / box.w);
    y = Math.max(y, (range.maxY - range.minY) / box.h);
  }
  return { x, y };
}

/**
 * The follow camera's anchor at a keyframe. Horizontally the pan already
 * pins the head (followCx); vertically the anchor slides the zoomed picture
 * against the head's departure from rest — by tightness × zoom/(zoom − 1),
 * which is exactly what keeps the head still on screen while the room moves.
 */
export function followAnchorOfKeyframe(
  keyframe: CropKeyframe,
  track: ReframeTrack,
  plan: CreatorPlan | undefined
): { x: number; y: number } | undefined {
  if (keyframe.fx == null) return undefined;
  const tightness = followTightnessY(plan);
  const zoom = followZoom(plan);
  const box = cropBoxAt(keyframe, track, followTightnessX(plan));
  const x = (keyframe.fx - box.x) / box.w;
  const fy = ((keyframe.fy ?? keyframe.cy) - box.y) / box.h;
  const pinned = zoom > 1 && tightness > 0 ? fy + (tightness * (fy - faceRestY(keyframe, track))) / (zoom - 1) : fy;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, pinned)) };
}

/** Piecewise-linear interpolation of per-keyframe anchors; holds across a cut. */
function anchorAt(
  track: ReframeTrack,
  sourceSec: number,
  anchorOf: (keyframe: CropKeyframe) => { x: number; y: number } | undefined
): { x: number; y: number } | undefined {
  const t = sourceSec - (track.originSec ?? 0);
  // Keyframes that carry a face, each projected first — the interpolation is
  // then linear in anchor space, which is exactly what the FFmpeg expression
  // does (camera.service.ts keyframeValueExpr).
  const points = track.keyframes
    .map((keyframe) => ({ keyT: keyframe.t, anchor: anchorOf(keyframe) }))
    .filter((point): point is { keyT: number; anchor: { x: number; y: number } } => point.anchor != null);
  if (points.length === 0) return undefined;
  let previous = points[0]!;
  let upcoming: (typeof points)[number] | undefined;
  for (const point of points) {
    if (point.keyT <= t + 1e-3) previous = point;
    else {
      upcoming = point;
      break;
    }
  }
  if (!upcoming) return previous.anchor;
  const cutBetween = track.cuts?.some((cut) => cut > previous.keyT + 1e-4 && cut <= upcoming!.keyT + 1e-4);
  const span = upcoming.keyT - previous.keyT;
  if (cutBetween || span < 1e-3) return previous.anchor;
  const u = Math.max(0, Math.min(1, (t - previous.keyT) / span));
  return {
    x: lerp(previous.anchor.x, upcoming.anchor.x, u),
    y: lerp(previous.anchor.y, upcoming.anchor.y, u),
  };
}

/** The follow camera's anchor at an instant. */
export function followAnchorAt(
  track: ReframeTrack | undefined,
  sourceSec: number,
  plan: CreatorPlan | undefined
): { x: number; y: number } | undefined {
  if (!track || track.mode === "resize") return undefined;
  return anchorAt(track, sourceSec, (keyframe) => followAnchorOfKeyframe(keyframe, track, plan));
}

export function faceAnchorAt(
  track: ReframeTrack | undefined,
  sourceSec: number,
  tightness = 0
): { x: number; y: number } | undefined {
  if (!track || track.mode === "resize") return undefined;
  return anchorAt(track, sourceSec, (keyframe) => faceAnchorOfKeyframe(keyframe, track, tightness));
}
export function resolveAnchor(
  anchor: CameraAnchor,
  track: ReframeTrack | undefined,
  sourceSec: number,
  tightness = 0
): { x: number; y: number } {
  if (anchor === "center") return { x: 0.5, y: 0.5 };
  if (anchor === "face") return faceAnchorAt(track, sourceSec, tightness) ?? { x: 0.5, y: 0.42 };
  return { x: Math.max(0, Math.min(1, anchor.x)), y: Math.max(0, Math.min(1, anchor.y)) };
}

/**
 * The camera at `sourceSec`: follow zoom (rides the face) × the move in force.
 * The move's anchor is sampled once, at the move's midpoint, so a punch
 * converges on one point instead of chasing detector jitter.
 */
export function cameraStateAt(
  plan: CreatorPlan | undefined,
  track: ReframeTrack | undefined,
  sourceSec: number
): CameraState {
  const none: CameraState = { zoom: 1, ax: 0.5, ay: 0.5 };
  if (!plan?.enabled || !plan.camera) return none;
  const fz = followZoom(plan);
  const move = moveAt(plan.camera, sourceSec);
  const amount = move ? moveAmountAt(move, sourceSec) : 0;
  const moveZoom = move ? 1 + (move.zoom - 1) * amount : 1;
  const zoom = fz * moveZoom;
  if (zoom <= 1 + 1e-6) return none;

  const tightness = followTightnessX(plan);
  const followAnchor = fz > 1 ? (followAnchorAt(track, sourceSec, plan) ?? { x: 0.5, y: 0.42 }) : { x: 0.5, y: 0.5 };
  if (!move) return { zoom, ax: followAnchor.x, ay: followAnchor.y };
  // The move's anchor is sampled once, at its midpoint, so a punch converges
  // on one point instead of chasing detector jitter. With a follow zoom under
  // it, the anchor slides from the face toward the move's point as the move
  // builds, so the punch never yanks the picture.
  const moveAnchor = resolveAnchor(move.anchor, track, (move.startSec + move.endSec) / 2, tightness);
  if (fz <= 1) return { zoom, ax: moveAnchor.x, ay: moveAnchor.y };
  return {
    zoom,
    ax: lerp(followAnchor.x, moveAnchor.x, amount),
    ay: lerp(followAnchor.y, moveAnchor.y, amount),
  };
}
