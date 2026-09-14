import type { CameraMove, CreatorPlan, CropKeyframe, ReframeTrack } from "../types/clip.types";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "../types/clip.types";
import {
  followAnchorOfKeyframe,
  followTightnessX,
  followZoom,
  moveRampSec,
  pushReleaseSec,
  resolveAnchor,
} from "./creator-timeline";

// ============================================
// CAMERA — creator mode's digital zoom as an FFmpeg filter chain.
//
// `crop` cannot animate its width per frame (verified: w/h are evaluated once),
// so a zoom is `scale` with `eval=frame` followed by a fixed-size `crop` whose
// x/y expressions place the anchor. Every expression here is a piecewise
// function of the segment-local clock `t`, built the same way
// cropChainForTrack builds its pan: nested `if(lt(t, edge), piece, rest)`.
//
// The numeric twin of every curve lives in creator-timeline.ts
// (cameraStateAt); scripts/validate-creator.ts evaluates these expressions
// and asserts they agree, so the preview and the burn stay one camera.
// ============================================

/**
 * Piecewise anchor keyframes beyond this are thinned, like crop keyframes.
 * A following camera answers the head at up to ~10 samples a second; a window
 * is scoped to its own keyframes first, so the cap only bites on a long,
 * continuously moving shot.
 */
const MAX_ANCHOR_PIECES = 240;

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** Commas separate filters; inside an expression they must be escaped. */
function escapeExpression(expression: string): string {
  return expression.replace(/,/g, "\\,");
}

/** Ease functions over a clamped 0-1 argument. */
function easeExpr(kind: CameraMove["ease"], u: string): string {
  const c = `clip(${u},0,1)`;
  if (kind === "in_out") return `if(lt(${c},0.5),4*pow(${c},3),1-pow(-2*${c}+2,3)/2)`;
  return `(1-pow(1-${c},3))`;
}

/**
 * The move's 0-1 amount as an expression of window-local `t`, for a move whose
 * span is [a, b) on that clock. Mirrors moveAmountAt exactly.
 */
export function moveAmountExpr(move: CameraMove, a: number, b: number): string {
  const span = b - a;
  if (move.kind === "punch") {
    const ramp = moveRampSec(move);
    if (ramp <= 0) return "1";
    return `if(lt(t-${num(a)},${num(ramp)}),${easeExpr(move.ease, `(t-${num(a)})/${num(ramp)}`)},if(lt(${num(b)}-t,${num(ramp)}),${easeExpr(move.ease, `(${num(b)}-t)/${num(ramp)}`)},1))`;
  }
  if (move.kind === "push") {
    const release = pushReleaseSec(move);
    const creep = Math.max(0.05, span - release);
    return `if(lt(t-${num(a)},${num(creep)}),(t-${num(a)})/${num(creep)},${easeExpr("out", `(${num(b)}-t)/${num(release)}`)})`;
  }
  return `(1-${easeExpr(move.ease, `(t-${num(a)})/${num(span)}`)})`;
}

interface LocalMove {
  move: CameraMove;
  a: number;
  b: number;
  amount: string;
  anchor: { x: number; y: number };
}

/**
 * Piecewise-linear expression of a per-keyframe value over the window's clock.
 * Holds across a cut, interpolates within a shot — the pan's own rule.
 */
function keyframeValueExpr(
  track: ReframeTrack,
  windowStartSec: number,
  windowEndSec: number,
  valueOf: (keyframe: CropKeyframe) => number | undefined,
  fallback: number
): string {
  const shift = (track.originSec ?? 0) - windowStartSec;
  let points = track.keyframes
    .map((keyframe) => ({ t: keyframe.t + shift, value: valueOf(keyframe), keyT: keyframe.t }))
    .filter((point): point is { t: number; value: number; keyT: number } => point.value != null);
  if (points.length === 0) return num(fallback);
  // Only this window's stretch of the path, with the keyframe in force at its
  // start and the first beyond its end (the pieces either side interpolate).
  const windowLen = windowEndSec - windowStartSec;
  const lastBefore = points.filter((point) => point.t <= 1e-4).length - 1;
  const firstAfter = points.findIndex((point) => point.t >= windowLen - 1e-4);
  points = points.slice(Math.max(0, lastBefore), firstAfter < 0 ? points.length : firstAfter + 1);
  if (points.length > MAX_ANCHOR_PIECES) {
    const step = points.length / MAX_ANCHOR_PIECES;
    const thinned: typeof points = [];
    for (let i = 0; i < points.length; i += step) thinned.push(points[Math.floor(i)]!);
    if (thinned[thinned.length - 1] !== points[points.length - 1]) thinned.push(points[points.length - 1]!);
    points = thinned;
  }
  // A flat sum of ramps and steps, never nested: FFmpeg's expression parser
  // allows ~100 levels of function nesting, and a dense follow path has more
  // keyframes than that in one window (see cropChainForTrack).
  let expr = num(points[0]!.value);
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const delta = to.value - from.value;
    if (Math.abs(delta) < 1e-4) continue;
    const span = to.t - from.t;
    const cutBetween = track.cuts?.some((cut) => cut > from.keyT + 1e-4 && cut <= to.keyT + 1e-4);
    expr +=
      cutBetween || span < 1e-3
        ? `+${num(delta)}*gte(t,${num(to.t)})`
        : `+${num(delta)}*clip((t-${num(from.t)})/${num(span)},0,1)`;
  }
  return expr;
}

export interface CameraChainInput {
  plan: CreatorPlan;
  track: ReframeTrack;
  windowStartSec: number;
  windowEndSec: number;
}

/**
 * The zoom (Z), and anchor (AX, AY) expressions for one window, unescaped.
 * Returns undefined when the plan asks for no zoom at all in this window.
 */
export function cameraExpressions(
  input: CameraChainInput
): { zoom: string; ax: string; ay: string } | undefined {
  const { plan, track, windowStartSec, windowEndSec } = input;
  if (!plan.enabled || !plan.camera) return undefined;
  const tightness = followTightnessX(plan);
  const fz = followZoom(plan);

  const locals: LocalMove[] = plan.camera.moves
    .filter((move) => move.zoom > 1 && move.startSec < windowEndSec && move.endSec > windowStartSec)
    .map((move) => {
      const a = move.startSec - windowStartSec;
      const b = move.endSec - windowStartSec;
      return {
        move,
        a,
        b,
        amount: moveAmountExpr(move, a, b),
        anchor: resolveAnchor(move.anchor, track, (move.startSec + move.endSec) / 2, tightness),
      };
    });
  if (fz <= 1 && locals.length === 0) return undefined;

  const active = (local: LocalMove) => `gte(t,${num(local.a)})*lt(t,${num(local.b)})`;

  // Z(t)
  let zoom = num(fz);
  for (let i = locals.length - 1; i >= 0; i--) {
    const local = locals[i]!;
    const dz = num(local.move.zoom - 1);
    zoom = `if(${active(local)},${num(fz)}*(1+${dz}*${local.amount}),${zoom})`;
  }

  // Follow anchor: the head pinned through the crop, per keyframe.
  const anchorExpr = (pick: (anchor: { x: number; y: number }) => number, fallback: number) =>
    keyframeValueExpr(
      track,
      windowStartSec,
      windowEndSec,
      (key) => {
        const anchor = followAnchorOfKeyframe(key, track, plan);
        return anchor ? pick(anchor) : undefined;
      },
      fallback
    );
  const fax = fz > 1 ? anchorExpr((anchor) => anchor.x, 0.5) : "0.5";
  const fay = fz > 1 ? anchorExpr((anchor) => anchor.y, 0.42) : "0.5";

  // AX/AY: inside a move, blend from the follow anchor toward the move's own
  // anchor by the move's amount (no follow zoom: the move's anchor outright).
  //
  // Written as FAX*(1-M) + P, where M is the active move's amount and P its
  // weighted anchor, so the (long) follow-anchor expression appears ONCE
  // rather than once per move — the argument list is a command line.
  if (fz <= 1) {
    let ax = "0.5";
    let ay = "0.5";
    for (let i = locals.length - 1; i >= 0; i--) {
      const local = locals[i]!;
      ax = `if(${active(local)},${num(local.anchor.x)},${ax})`;
      ay = `if(${active(local)},${num(local.anchor.y)},${ay})`;
    }
    return { zoom, ax, ay };
  }
  let amountOfActive = "0";
  let weightedX = "0";
  let weightedY = "0";
  for (let i = locals.length - 1; i >= 0; i--) {
    const local = locals[i]!;
    amountOfActive = `if(${active(local)},${local.amount},${amountOfActive})`;
    weightedX = `if(${active(local)},${num(local.anchor.x)}*${local.amount},${weightedX})`;
    weightedY = `if(${active(local)},${num(local.anchor.y)}*${local.amount},${weightedY})`;
  }
  return {
    zoom,
    ax: locals.length > 0 ? `(${fax})*(1-(${amountOfActive}))+(${weightedX})` : fax,
    ay: locals.length > 0 ? `(${fay})*(1-(${amountOfActive}))+(${weightedY})` : fay,
  };
}

/**
 * The filter chain that applies the camera to a 1080x1920 picture. Empty when
 * there is nothing to apply.
 */
export function cameraFilterChain(input: CameraChainInput): string {
  const expressions = cameraExpressions(input);
  if (!expressions) return "";
  const z = escapeExpression(expressions.zoom);
  const ax = escapeExpression(expressions.ax);
  const ay = escapeExpression(expressions.ay);
  // The scaled size, written out again for the crop: `crop` keeps the `iw`/`ih`
  // of the FIRST frame it configures on and never refreshes them when `scale`
  // changes size mid-stream (verified on FFmpeg 8), so an anchor written as
  // `(iw-1080)*AX` slides against a stale size and is silently clamped.
  const scaledW = `trunc(${OUTPUT_WIDTH}*(${z})/2)*2`;
  const scaledH = `trunc(${OUTPUT_HEIGHT}*(${z})/2)*2`;
  return (
    `scale=w='${scaledW}':h='${scaledH}':eval=frame,` +
    // `scale` adjusts the SAR to keep the display aspect after the even-rounded
    // size; concat refuses inputs whose SAR differ, so pin it back to square.
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='(${scaledW}-${OUTPUT_WIDTH})*(${ax})':y='(${scaledH}-${OUTPUT_HEIGHT})*(${ay})',setsar=1`
  );
}
