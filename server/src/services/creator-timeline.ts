import type {
  CameraAnchor,
  CameraMove,
  CameraPlan,
  CreatorPlan,
  CropKeyframe,
  Cutaway,
  FollowResponse,
  PauseCut,
  ReframeTrack,
  SpeedSpan,
} from "../types/clip.types";
import { MAX_SPEED_RATE, MIN_SPEED_RATE } from "../types/clip.types";

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
  /**
   * Playback rate of this window: 1 (or absent) plays as shot; 0.5 is slow
   * motion; 0 holds the first frame for the window's length (a freeze).
   */
  rate?: number;
  /** Motion-interpolated slow motion. */
  smooth?: boolean;
  /** Captions stay on inside a slowed window. */
  captions?: boolean;
}

/** Seconds this window occupies on the OUTPUT clock. */
export function windowLength(window: TimeWindow): number {
  const source = Math.max(0, window.endSec - window.startSec);
  const rate = window.rate ?? 1;
  return rate > 0 ? source / rate : source;
}

/** The rate a speed span asks for: its own for slow/fast, 0 for a freeze. */
export function speedRate(span: Pick<SpeedSpan, "kind" | "rate">): number {
  if (span.kind === "freeze") return 0;
  return Math.max(MIN_SPEED_RATE, Math.min(MAX_SPEED_RATE, span.rate));
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
export function windowsFor(trimStart: number, trimEnd: number, cuts?: PauseCut[], speed?: SpeedSpan[]): TimeWindow[] {
  const removed = activeCuts(cuts, trimStart, trimEnd);
  const kept: TimeWindow[] = [];
  let cursor = trimStart;
  for (const cut of removed) {
    if (cut.startSec - cursor >= MIN_KEPT_SEC) kept.push({ startSec: round3(cursor), endSec: round3(cut.startSec) });
    cursor = Math.max(cursor, cut.endSec);
  }
  if (trimEnd - cursor >= MIN_KEPT_SEC) kept.push({ startSec: round3(cursor), endSec: round3(trimEnd) });
  if (kept.length === 0) return [{ startSec: round3(trimStart), endSec: round3(trimEnd) }];
  return splitBySpeed(kept, speed);
}

/** A speed span shorter than this is ignored: one frame cannot slow down. */
export const MIN_SPEED_SEC = 0.15;

/**
 * Speed spans, clipped to the trim, sorted, with any overlap dropped in favour
 * of the earlier span. The only list the renderer and the player look at.
 */
export function activeSpeed(speed: SpeedSpan[] | undefined, trimStart: number, trimEnd: number): SpeedSpan[] {
  // Fields copied one by one: the renderer hands in mongoose subdocuments,
  // and spreading one of those copies its internals rather than its fields.
  const spans = (speed ?? [])
    .map((span) => ({
      id: span.id,
      startSec: Math.max(trimStart, span.startSec),
      endSec: Math.min(trimEnd, span.endSec),
      kind: span.kind,
      rate: span.rate,
      smooth: span.smooth,
      captions: span.captions,
    }))
    .filter((span) => span.endSec - span.startSec >= MIN_SPEED_SEC)
    .sort((a, b) => a.startSec - b.startSec);
  const kept: SpeedSpan[] = [];
  for (const span of spans) {
    const last = kept[kept.length - 1];
    if (last && span.startSec < last.endSec - 1e-6) continue;
    kept.push(span);
  }
  return kept;
}

/**
 * Cut each kept window at the edges of the speed spans that touch it, so a
 * window is either entirely at one rate or entirely as shot. A cut inside a
 * speed span leaves both halves at that span's rate.
 */
function splitBySpeed(windows: TimeWindow[], speed: SpeedSpan[] | undefined): TimeWindow[] {
  const spans = activeSpeed(speed, windows[0]!.startSec, windows[windows.length - 1]!.endSec);
  if (spans.length === 0) return windows;
  const out: TimeWindow[] = [];
  for (const window of windows) {
    let cursor = window.startSec;
    for (const span of spans) {
      if (span.endSec <= cursor + 1e-6 || span.startSec >= window.endSec - 1e-6) continue;
      const from = Math.max(cursor, span.startSec);
      const to = Math.min(window.endSec, span.endSec);
      if (from - cursor >= 1e-3) out.push({ startSec: round3(cursor), endSec: round3(from) });
      const piece: TimeWindow = { startSec: round3(from), endSec: round3(to), rate: speedRate(span) };
      if (span.smooth && piece.rate! > 0 && piece.rate! < 1) piece.smooth = true;
      if (span.captions) piece.captions = true;
      out.push(piece);
      cursor = to;
    }
    if (window.endSec - cursor >= 1e-3) out.push({ startSec: round3(cursor), endSec: round3(window.endSec) });
  }
  return out;
}

export function outputDuration(windows: TimeWindow[]): number {
  return windows.reduce((sum, window) => sum + windowLength(window), 0);
}

/** The rate in force at a source instant: 1 outside every speed window. */
export function rateAt(windows: TimeWindow[], sourceSec: number): number {
  const index = windowIndexAt(windows, sourceSec);
  return index < 0 ? 1 : (windows[index]!.rate ?? 1);
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
    const rate = window.rate ?? 1;
    // A frozen window: source time passes 1:1 on the held frame.
    if (sourceSec <= window.endSec) return elapsed + (sourceSec - window.startSec) / (rate > 0 ? rate : 1);
    elapsed += windowLength(window);
  }
  return elapsed;
}

/** Output → source. Clamped to the last window's end. */
export function outputToSource(windows: TimeWindow[], outputSec: number): number {
  let elapsed = 0;
  for (const window of windows) {
    const length = windowLength(window);
    if (outputSec <= elapsed + length) {
      const rate = window.rate ?? 1;
      return window.startSec + Math.max(0, outputSec - elapsed) * (rate > 0 ? rate : 1);
    }
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
  const span = Math.max(0, move.endSec - move.startSec);
  if (move.rampSec !== undefined) return Math.min(span, Math.max(0, move.rampSec));
  return Math.min(move.kind === "frame" ? 0.6 : 0.22, span / (move.kind === "frame" ? 2 : 3));
}

/** The zoom a move starts from: 1 unless it says otherwise. */
export function moveZoomFrom(move: CameraMove): number {
  return move.zoomFrom ?? 1;
}

/** The move's zoom at a 0-1 amount: from `zoomFrom` to `zoom`. */
export function moveZoomAt(move: CameraMove, amount: number): number {
  const from = moveZoomFrom(move);
  return from + (move.zoom - from) * amount;
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
  // A hold is a locked-off shot: its framing is in force for the whole span
  // (the camera path itself is frozen by heldTrack).
  if (move.kind === "hold") return 1;
  if (move.kind === "frame") {
    // Ramp to the framing, hold it to the end; the end is a cut.
    const ramp = moveRampSec(move);
    return ramp <= 0 || local >= ramp ? 1 : ease(local / ramp);
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
/** How far the crop leans toward the head's gaze at full lead, in crop widths. */
export const LEAD_ROOM = 0.2;
/** How far ahead of the face a "look" anchor sits at full yaw, in output widths. */
export const LOOK_ROOM = 0.3;

/** 0..1 lead room; 0 unless creator mode's follow is on. */
export function followLead(plan: CreatorPlan | undefined): number {
  if (!plan?.enabled || !plan.camera?.follow?.enabled) return 0;
  return Math.max(0, Math.min(1, plan.camera.follow.lead ?? 0));
}

export function followCx(keyframe: CropKeyframe, tightness: number, sourceWidth: number, lead = 0): number {
  const half = keyframe.width / 2;
  let cx = keyframe.cx;
  if (tightness > 0 && keyframe.fx != null) {
    const faceCx = Math.max(half, Math.min(sourceWidth - half, keyframe.fx));
    cx += (faceCx - keyframe.cx) * tightness;
  }
  // Lead room: the crop leans the way the head faces, so the speaker looks
  // into space rather than at the frame's edge.
  if (lead > 0 && keyframe.fyaw != null) cx += lead * keyframe.fyaw * LEAD_ROOM * keyframe.width;
  return Math.max(half, Math.min(sourceWidth - half, cx));
}

export interface PanPx {
  x: number;
  y: number;
}

/** The 9:16 crop box the renderer would use for a keyframe, source pixels. */
export function cropBoxAt(
  keyframe: CropKeyframe,
  track: Pick<ReframeTrack, "sourceWidth" | "sourceHeight">,
  tightness = 0,
  lead = 0,
  pan: PanPx = { x: 0, y: 0 }
): { x: number; y: number; w: number; h: number } {
  const { sourceWidth, sourceHeight } = track;
  let w = Math.min(sourceWidth, Math.round(sourceHeight * (9 / 16)));
  let h = Math.round(w * (16 / 9));
  if (h > sourceHeight) {
    h = sourceHeight;
    w = Math.round(h * (9 / 16));
  }
  const cx = followCx(keyframe, tightness, sourceWidth, lead) + pan.x;
  const x = Math.max(0, Math.min(sourceWidth - w, Math.round(cx - w / 2)));
  const y = Math.max(0, Math.min(sourceHeight - h, Math.round(keyframe.cy + pan.y - h / 2)));
  return { x, y, w, h };
}

/**
 * How far the 9:16 window can move either side of centre, source pixels: the
 * room a pan of ±1 uses up. Zero vertically for a 16:9 source.
 */
export function panSlack(track: Pick<ReframeTrack, "sourceWidth" | "sourceHeight">): PanPx {
  const box = cropBoxAt({ t: 0, cx: track.sourceWidth / 2, cy: track.sourceHeight / 2, width: 0 }, track);
  return { x: (track.sourceWidth - box.w) / 2, y: (track.sourceHeight - box.h) / 2 };
}

/** The pan in force at an instant, as −1..1 fractions of the slack: the active move's, scaled by its amount. */
export function panAt(plan: CreatorPlan | undefined, sourceSec: number): PanPx {
  if (!plan?.enabled || !plan.camera) return { x: 0, y: 0 };
  const move = moveAt(plan.camera, sourceSec);
  if (!move?.pan) return { x: 0, y: 0 };
  const amount = moveAmountAt(move, sourceSec);
  return { x: move.pan.x * amount, y: move.pan.y * amount };
}

/** The pan in force at an instant, source pixels. */
export function panPxAt(
  plan: CreatorPlan | undefined,
  track: Pick<ReframeTrack, "sourceWidth" | "sourceHeight"> | undefined,
  sourceSec: number
): PanPx {
  if (!track) return { x: 0, y: 0 };
  const pan = panAt(plan, sourceSec);
  const slack = panSlack(track);
  return { x: pan.x * slack.x, y: pan.y * slack.y };
}

/** A keyframe's face projected into OUTPUT-frame fractions, or undefined. */
export function faceAnchorOfKeyframe(
  keyframe: CropKeyframe,
  track: Pick<ReframeTrack, "sourceWidth" | "sourceHeight">,
  tightness = 0,
  lead = 0,
  pan: PanPx = { x: 0, y: 0 }
): { x: number; y: number } | undefined {
  if (keyframe.fx == null) return undefined;
  const box = cropBoxAt(keyframe, track, tightness, lead, pan);
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
function faceOnPath(faces: CropKeyframe[], t: number): { x: number; y: number; yaw: number } | undefined {
  let before: CropKeyframe | undefined;
  let after: CropKeyframe | undefined;
  for (const key of faces) {
    if (key.t <= t + 1e-4) before = key;
    else {
      after = key;
      break;
    }
  }
  const at = (key: CropKeyframe) => ({ x: key.fx!, y: key.fy ?? key.cy, yaw: key.fyaw ?? 0 });
  if (!before) return after ? at(after) : undefined;
  if (!after) return at(before);
  const u = (t - before.t) / (after.t - before.t);
  return {
    x: lerp(before.fx!, after.fx!, u),
    y: lerp(before.fy ?? before.cy, after.fy ?? after.cy, u),
    yaw: lerp(before.fyaw ?? 0, after.fyaw ?? 0, u),
  };
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
    let fyaw = 0;
    for (let dt = -reach; dt <= reach + 1e-9; dt += FACE_PATH_STEP_SEC) {
      const t = keyframe.t + dt;
      if (t + 1e-4 < shot.from || t + 1e-4 >= shot.to) continue;
      const face = faceOnPath(shot.faces, t);
      if (!face) continue;
      const w = Math.exp(-(dt * dt) / (2 * sigmaSec * sigmaSec));
      weight += w;
      fx += w * face.x;
      fy += w * face.y;
      fyaw += w * face.yaw;
    }
    keyframes.push(
      weight > 0
        ? { ...keyframe, fx: fx / weight, fy: fy / weight, ...(keyframe.fyaw == null ? {} : { fyaw: fyaw / weight }) }
        : keyframe
    );
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

/** Seconds a hold takes to let go and rejoin the tracked path. */
export const HOLD_RELEASE_SEC = 0.35;

/** The plan's locked-off spans, absolute source seconds, in order. */
export function holdSpans(plan: CreatorPlan | undefined): { startSec: number; endSec: number }[] {
  if (!plan?.enabled || !plan.camera) return [];
  return plan.camera.moves
    .filter((move) => move.kind === "hold")
    .map((move) => ({ startSec: move.startSec, endSec: move.endSec }))
    .sort((a, b) => a.startSec - b.startSec);
}

/**
 * The crop keyframe the renderer is showing at track time `t`: interpolated
 * between keyframes as the crop expression glides, held where it snaps (a
 * shot cut, or a legacy jump). Fields copied one by one (mongoose).
 */
export function keyframeStateAt(track: Pick<ReframeTrack, "keyframes" | "cuts">, t: number): CropKeyframe {
  const keys = track.keyframes;
  const copy = (key: CropKeyframe, u = 0, next?: CropKeyframe): CropKeyframe => {
    const mix = (a: number | undefined, b: number | undefined) => (a == null ? undefined : b == null || !next ? a : lerp(a, b, u));
    const out: CropKeyframe = {
      t,
      cx: next ? lerp(key.cx, next.cx, u) : key.cx,
      cy: next ? lerp(key.cy, next.cy, u) : key.cy,
      width: key.width,
    };
    const fx = mix(key.fx, next?.fx);
    const fy = mix(key.fy, next?.fy);
    const fw = mix(key.fw, next?.fw);
    const fyaw = mix(key.fyaw, next?.fyaw);
    if (fx != null) out.fx = fx;
    if (fy != null) out.fy = fy;
    if (fw != null) out.fw = fw;
    if (fyaw != null) out.fyaw = fyaw;
    return out;
  };
  if (t <= keys[0]!.t) return copy(keys[0]!);
  let before = keys[0]!;
  let after: CropKeyframe | undefined;
  for (const key of keys) {
    if (key.t <= t + 1e-6) before = key;
    else {
      after = key;
      break;
    }
  }
  if (!after) return copy(before);
  const cutBetween = track.cuts?.some((cut) => cut > before.t + 1e-4 && cut <= after.t + 1e-4);
  const legacyJump = track.cuts === undefined && (Math.abs(after.cx - before.cx) > 0.25 * before.width || after.t - before.t < 0.12);
  if (cutBetween || legacyJump) return copy(before);
  return copy(before, (t - before.t) / (after.t - before.t), after);
}

/**
 * Lock the camera off for each hold: the crop (and the face the zoom pins)
 * stays where it was at the hold's first frame, then glides back onto the
 * tracked path over HOLD_RELEASE_SEC. A hold never crosses a shot cut — the
 * next shot frames its own speaker — so it ends there.
 */
export function heldTrack(track: ReframeTrack, holds: { startSec: number; endSec: number }[]): ReframeTrack {
  if (track.mode === "resize" || holds.length === 0 || track.keyframes.length === 0) return track;
  const origin = track.originSec ?? 0;
  let keyframes = track.keyframes;
  for (const hold of holds) {
    const a = hold.startSec - origin;
    const nextCut = track.cuts?.find((cut) => cut > a + 1e-4);
    const endsOnCut = nextCut !== undefined && nextCut <= hold.endSec - origin;
    const b = endsOnCut ? nextCut! - 0.01 : hold.endSec - origin;
    if (b - a < 0.05) continue;
    const held = keyframeStateAt({ keyframes, cuts: track.cuts }, a);
    const resume = endsOnCut ? nextCut! : Math.min(b + HOLD_RELEASE_SEC, nextCut ?? Infinity);
    keyframes = [
      ...keyframes.filter((key) => key.t < a - 1e-4),
      { ...held, t: round3(a), held: true },
      { ...held, t: round3(b), held: true },
      ...keyframes.filter((key) => key.t >= resume - 1e-4 && key.t > b + 1e-4),
    ];
  }
  return { ...track, keyframes };
}

/**
 * The camera path the renderer and the player both frame from: the smoothed
 * face path when the camera follows (by the plan's response), with the plan's
 * holds locked off on top.
 */
export function cameraTrackFor(track: ReframeTrack, plan: CreatorPlan | undefined): ReframeTrack {
  const base = followTightness(plan) > 0 ? smoothedTrack(track, followSigma(plan)) : track;
  return heldTrack(base, holdSpans(plan));
}

/** A transition that takes no time. */
const NO_TRANSITION = "cut";

/** How far a Ken Burns drift travels, as a share of the frame. */
export const CUTAWAY_DRIFT = 0.12;

/** The span a cutaway is on screen, transitions included, source seconds. */
export function cutawaySpan(cutaway: Cutaway): { startSec: number; endSec: number } {
  const tIn = cutaway.in.transitionId === NO_TRANSITION ? 0 : Math.max(0, cutaway.in.sec);
  const tOut = cutaway.out.transitionId === NO_TRANSITION ? 0 : Math.max(0, cutaway.out.sec);
  return { startSec: cutaway.startSec - tIn, endSec: cutaway.endSec + tOut };
}

/** The cutaway on screen at an instant, with where it is in its life. */
export function cutawayAt(
  plan: CreatorPlan | undefined,
  sourceSec: number
): { cutaway: Cutaway; progress: number; inU: number; outU: number; mediaSec: number } | undefined {
  if (!plan?.enabled || !plan.cutaways?.length) return undefined;
  for (const cutaway of plan.cutaways) {
    const span = cutawaySpan(cutaway);
    if (sourceSec < span.startSec || sourceSec >= span.endSec) continue;
    const length = Math.max(0.01, span.endSec - span.startSec);
    const tIn = cutaway.startSec - span.startSec;
    const tOut = span.endSec - cutaway.endSec;
    return {
      cutaway,
      /** 0→1 across the whole appearance: what the drift follows. */
      progress: (sourceSec - span.startSec) / length,
      /** 0→1 through the transition in (1 once fully on). */
      inU: tIn > 0 ? Math.min(1, (sourceSec - span.startSec) / tIn) : 1,
      /** 0→1 through the transition out (0 until it starts). */
      outU: tOut > 0 ? Math.max(0, (sourceSec - cutaway.endSec) / tOut) : 0,
      /** Seconds into the media: its offset plus time since it appeared. */
      mediaSec: (cutaway.offsetSec ?? 0) + (sourceSec - span.startSec),
    };
  }
  return undefined;
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
  plan: CreatorPlan | undefined,
  pan: PanPx = { x: 0, y: 0 }
): { x: number; y: number } | undefined {
  if (keyframe.fx == null) return undefined;
  const tightness = followTightnessY(plan);
  const zoom = followZoom(plan);
  const box = cropBoxAt(keyframe, track, followTightnessX(plan), followLead(plan), pan);
  const x = (keyframe.fx - box.x) / box.w;
  const fy = ((keyframe.fy ?? keyframe.cy) - box.y) / box.h;
  const pinned = zoom > 1 && tightness > 0 ? fy + (tightness * (fy - faceRestY(keyframe, track))) / (zoom - 1) : fy;
  // Not clamped here: FFmpeg interpolates the anchor, then `crop` clamps the
  // offset it produces. cameraStateAt clamps the same way, at the end — a
  // per-keyframe clamp would bend the interpolation between two keyframes.
  return { x, y: pinned };
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
  const pan = panPxAt(plan, track, sourceSec);
  return anchorAt(track, sourceSec, (keyframe) => followAnchorOfKeyframe(keyframe, track, plan, pan));
}

export function faceAnchorAt(
  track: ReframeTrack | undefined,
  sourceSec: number,
  tightness = 0,
  lead = 0,
  pan: PanPx = { x: 0, y: 0 }
): { x: number; y: number } | undefined {
  if (!track || track.mode === "resize") return undefined;
  return anchorAt(track, sourceSec, (keyframe) => faceAnchorOfKeyframe(keyframe, track, tightness, lead, pan));
}

/** Which way the head faces at an instant (−1..1), interpolated; 0 without a track. */
export function faceYawAt(track: ReframeTrack | undefined, sourceSec: number): number {
  if (!track || track.mode === "resize") return 0;
  return anchorAt(track, sourceSec, (keyframe) => (keyframe.fyaw == null ? undefined : { x: keyframe.fyaw, y: 0 }))?.x ?? 0;
}

export function resolveAnchor(
  anchor: CameraAnchor,
  track: ReframeTrack | undefined,
  sourceSec: number,
  tightness = 0,
  lead = 0,
  pan: PanPx = { x: 0, y: 0 }
): { x: number; y: number } {
  if (anchor === "center") return { x: 0.5, y: 0.5 };
  if (anchor === "face") return faceAnchorAt(track, sourceSec, tightness, lead, pan) ?? { x: 0.5, y: 0.42 };
  if (anchor === "look") {
    // Ahead of the face, the way it looks: a zoom there gives look room.
    const face = faceAnchorAt(track, sourceSec, tightness, lead, pan) ?? { x: 0.5, y: 0.42 };
    return { x: Math.max(0.1, Math.min(0.9, face.x + LOOK_ROOM * faceYawAt(track, sourceSec))), y: face.y };
  }
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
  const moveZoom = move ? moveZoomAt(move, amount) : 1;
  // A move may zoom out below the follow zoom, never past the crop itself.
  const zoom = Math.max(1, fz * moveZoom);
  if (zoom <= 1 + 1e-6) return none;

  const tightness = followTightnessX(plan);
  const lead = followLead(plan);
  const followAnchor = fz > 1 ? (followAnchorAt(track, sourceSec, plan) ?? { x: 0.5, y: 0.42 }) : { x: 0.5, y: 0.5 };
  if (!move) return { zoom, ax: unit(followAnchor.x), ay: unit(followAnchor.y) };
  // The move's anchor is sampled once, at its midpoint, so a punch converges
  // on one point instead of chasing detector jitter. With a follow zoom under
  // it, the anchor slides from the face toward the move's point as the move
  // builds, so the punch never yanks the picture.
  const mid = (move.startSec + move.endSec) / 2;
  const moveAnchor = resolveAnchor(move.anchor, track, mid, tightness, lead, panPxAt(plan, track, mid));
  if (fz <= 1) return { zoom, ax: unit(moveAnchor.x), ay: unit(moveAnchor.y) };
  return {
    zoom,
    ax: unit(lerp(followAnchor.x, moveAnchor.x, amount)),
    ay: unit(lerp(followAnchor.y, moveAnchor.y, amount)),
  };
}

/** Clamped to the frame, as `crop` clamps the offset an anchor produces. */
function unit(value: number): number {
  return Math.max(0, Math.min(1, value));
}
