/**
 * Creator mode invariants, no media needed.
 *
 *   bun run creator:validate
 *
 * Covers the beat-plan sanitiser, the source/output clock mapping across pause
 * cuts, the pause-candidate rules, and the camera curves. Exits non-zero on
 * the first broken invariant.
 */
import { sanitizeCreatorPlan, isEmptyCreatorPlan } from "../src/services/creator-plan.service";
import {
  activeCuts,
  cameraStateAt,
  cameraTrackFor,
  heldTrack,
  holdSpans,
  keyframeStateAt,
  cropBoxAt,
  faceRestY,
  FOLLOW_MIN_ZOOM,
  FOLLOW_SIGMA_SEC,
  followAnchorOfKeyframe,
  followCx,
  followSigma,
  followTightnessX,
  followTightnessY,
  followZoom,
  headTravel,
  LEAD_ROOM,
  LOOK_ROOM,
  moveAmountAt,
  moveZoomAt,
  nextKeptTime,
  outputDuration,
  outputToSource,
  panPxAt,
  panSlack,
  rateAt,
  resolveAnchor,
  smoothedTrack,
  sourceToOutput,
  windowsFor,
} from "../src/services/creator-timeline";
import { pauseCandidates, parseSilenceLog, wordGaps } from "../src/services/pause-detect.service";
import type { CameraMove, CreatorPlan, MediaAsset, ReframeTrack } from "../src/types/clip.types";

function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function near(a: number, b: number, tolerance = 1e-3): boolean {
  return Math.abs(a - b) <= tolerance;
}

// ---- sanitiser ----
const plan = sanitizeCreatorPlan({
  enabled: true,
  version: 1,
  cuts: [
    { id: "b", startSec: 12, endSec: 12.5, enabled: true, source: "user" },
    { id: "a", startSec: 10, endSec: 10.6, enabled: true, source: "director" },
    { id: "tiny", startSec: 20, endSec: 20.01, enabled: true, source: "user" },
  ],
  camera: {
    follow: { enabled: true, tightness: 1.7, zoom: 9 },
    moves: [
      { id: "m2", kind: "punch", startSec: 15, endSec: 17, zoom: 1.2, anchor: "face", ease: "cut" },
      { id: "m1", kind: "pull", startSec: 14, endSec: 16, zoom: 3, anchor: { x: 2, y: -1 }, ease: "out" },
      { id: "flat", kind: "push", startSec: 18, endSec: 19, zoom: 1, anchor: "center", ease: "out" },
    ],
  },
  captionScenes: [{ id: "s1", startSec: 10, endSec: 13, overrides: { highlight: "word", sizeScale: 99 } }],
  titles: [{ id: "t1", text: "  hello   world ", startSec: 10, endSec: 12, x: 0.5, y: 0.2, sizeScale: 1, color: "#FFAA00", animation: "pop", depth: "behind" }],
});
check("cuts are sorted and the sub-frame one is dropped", plan.cuts?.map((cut) => cut.id).join(",") === "a,b");
check("follow tightness and zoom are clamped", plan.camera?.follow?.tightness === 1 && plan.camera?.follow?.zoom === 1.3);
check("moves are ordered and made exclusive", plan.camera?.moves.map((m) => `${m.id}:${m.startSec}`).join(",") === "m1:14,m2:16");
check("a flat move is discarded", !plan.camera?.moves.some((move) => move.id === "flat"));
check("custom anchor is clamped to the frame", JSON.stringify(plan.camera?.moves[0]?.anchor) === JSON.stringify({ x: 1, y: 0 }));
check("scene overrides go through the caption sanitiser", plan.captionScenes?.[0]?.overrides?.sizeScale === 3 && plan.captionScenes?.[0]?.overrides?.highlight === "word");
check("title text is normalised and colour lower-cased", plan.titles?.[0]?.text === "hello world" && plan.titles?.[0]?.color === "#ffaa00");
check("an empty disabled plan reads as no plan", isEmptyCreatorPlan(sanitizeCreatorPlan({ enabled: false, version: 1, cuts: [] })));
let threw = false;
try {
  sanitizeCreatorPlan({ enabled: true, version: 1, titles: [{ id: "x", text: "", startSec: 0, endSec: 1, color: "#fff" }] });
} catch {
  threw = true;
}
check("a title without text is rejected", threw);

// ---- clock mapping ----
const cuts = [
  { id: "c1", startSec: 12, endSec: 13, enabled: true, source: "user" as const },
  { id: "c2", startSec: 12.8, endSec: 14, enabled: true, source: "user" as const },
  { id: "off", startSec: 16, endSec: 17, enabled: false, source: "user" as const },
  { id: "c3", startSec: 19.85, endSec: 20.5, enabled: true, source: "user" as const },
];
const merged = activeCuts(cuts, 10, 20);
check("overlapping cuts merge, disabled ones are ignored, the trim clips", merged.length === 2 && near(merged[0]!.endSec, 14) && near(merged[1]!.endSec, 20));
const windows = windowsFor(10, 20, cuts);
check("windows are the complement of the cuts", windows.length === 2 && near(windows[0]!.endSec, 12) && near(windows[1]!.startSec, 14));
check("a cut running past the trim is clipped to it", near(windows[1]!.endSec, 19.85));
check("output duration drops the cut seconds", near(outputDuration(windows), 7.85));
check("source→output inside a window", near(sourceToOutput(windows, 15), 3));
check("source→output inside a cut lands on the splice", near(sourceToOutput(windows, 13), 2));
check("output→source round-trips", near(outputToSource(windows, sourceToOutput(windows, 17.25)), 17.25));
check("nextKeptTime jumps a cut", near(nextKeptTime(windows, 12.4), 14) && near(nextKeptTime(windows, 11), 11));
check("a plan that cuts everything keeps the trim", windowsFor(10, 11, [{ id: "all", startSec: 9, endSec: 12, enabled: true, source: "user" }]).length === 1);

// ---- speed spans: windows split at their edges, the output clock stretches ----
{
  const speed = [
    { id: "s1", startSec: 15, endSec: 16, kind: "slow" as const, rate: 0.5 },
    { id: "f1", startSec: 17, endSec: 17.5, kind: "freeze" as const, rate: 0 },
    { id: "x1", startSec: 18, endSec: 19, kind: "fast" as const, rate: 2 },
    { id: "overlap", startSec: 15.5, endSec: 16.5, kind: "slow" as const, rate: 0.25 },
  ];
  const timed = windowsFor(10, 20, cuts, speed);
  const rates = timed.map((window) => window.rate ?? 1);
  check("speed: kept windows split at span edges, one rate each", timed.length === 8 && rates.join(",") === "1,1,0.5,1,0,1,2,1", `${timed.length} windows, rates ${rates.join(",")}`);
  check("speed: an overlapping span is dropped in favour of the earlier one", !timed.some((window) => window.rate === 0.25));
  // 7.85 s of source; the slow second doubles, the frozen half holds, the fast second halves.
  check("speed: output duration = Σ len/rate, a freeze counts its length", near(outputDuration(timed), 7.85 + 1 + 0 - 0.5));
  check("speed: source→output stretches inside a slow window", near(sourceToOutput(timed, 15.5), sourceToOutput(timed, 15) + 1));
  check("speed: output→source round-trips through slow, freeze and fast", [15.25, 17.2, 18.6, 19.5].every((sec) => near(outputToSource(timed, sourceToOutput(timed, sec)), sec)));
  check("speed: rateAt reads the window", rateAt(timed, 15.5) === 0.5 && rateAt(timed, 17.2) === 0 && rateAt(timed, 18.5) === 2 && rateAt(timed, 14.5) === 1);
  check("speed: no spans leaves the windows untouched", JSON.stringify(windowsFor(10, 20, cuts, [])) === JSON.stringify(windows));
  check("speed: a span shorter than a frame is ignored", windowsFor(10, 20, [], [{ id: "tiny", startSec: 12, endSec: 12.05, kind: "slow", rate: 0.5 }]).length === 1);
}

// ---- pause candidates ----
const words = [
  { t: 10.0, word: "so" },
  { t: 10.3, word: "here" },
  { t: 11.2, word: "is" },
  { t: 12.9, word: "the" },
  { t: 13.1, word: "thing" },
];
const gaps = wordGaps(words, 10, 15);
check("onset gaps above the threshold are found", gaps.length === 3 && near(gaps[0]!.startSec, 10.3) && near(gaps[1]!.startSec, 11.2) && near(gaps[2]!.startSec, 13.1));
const silence = parseSilenceLog(
  ["[silencedetect @ 0x1] silence_start: 1.55", "[silencedetect @ 0x1] silence_end: 2.85 | silence_duration: 1.3"],
  10
);
check("silencedetect output is parsed to absolute time", silence.length === 1 && near(silence[0]!.startSec, 11.55) && near(silence[0]!.endSec, 12.85));
const candidates = pauseCandidates(gaps, silence, 10, 15);
check("only the silent gap becomes a candidate, padded inward", candidates.length === 1 && near(candidates[0]!.startSec, 11.63) && near(candidates[0]!.endSec, 12.73));
check("candidates arrive disabled for the user to accept", candidates.every((item) => !item.enabled));
const blind = pauseCandidates(gaps, null, 10, 15);
check("without audio the gap is trusted but the opening word is spared", blind.length >= 1 && blind[0]!.startSec > gaps[0]!.startSec + 0.3);

// ---- camera curves ----
const punch: CameraMove = { id: "p", kind: "punch", startSec: 10, endSec: 12, zoom: 1.3, anchor: "center", ease: "cut" };
check("a hard punch is full zoom inside and none outside", moveAmountAt(punch, 10) === 1 && moveAmountAt(punch, 11.99) === 1 && moveAmountAt(punch, 12) === 0 && moveAmountAt(punch, 9.99) === 0);
const eased: CameraMove = { ...punch, ease: "out" };
check("an eased punch ramps at both edges", moveAmountAt(eased, 10) === 0 && moveAmountAt(eased, 10.11) > 0.5 && moveAmountAt(eased, 11) === 1 && moveAmountAt(eased, 11.95) < 1);
const pull: CameraMove = { ...punch, kind: "pull", ease: "out" };
check("a pull starts tight and settles", moveAmountAt(pull, 10) === 1 && moveAmountAt(pull, 11) < 0.2 && moveAmountAt(pull, 11.99) < 0.01);
const push: CameraMove = { ...punch, kind: "push", ease: "out" };
check("a push creeps in and releases", moveAmountAt(push, 10) === 0 && moveAmountAt(push, 11) > 0.5 && moveAmountAt(push, 11.69) > 0.95 && moveAmountAt(push, 11.99) < 0.2);

const track: ReframeTrack = {
  mode: "crop",
  keyframes: [
    { t: 0, cx: 960, cy: 540, width: 608, fx: 1000, fy: 380, fw: 120 },
    { t: 2, cx: 1100, cy: 540, width: 608, fx: 1140, fy: 420, fw: 120 },
  ],
  sourceWidth: 1920,
  sourceHeight: 1080,
  confidence: 0.9,
  provider: "faces",
  originSec: 10,
  untilSec: 20,
};
const state = cameraStateAt(
  { enabled: true, version: 1, camera: { follow: { enabled: true, tightness: 1, zoom: 1.1 }, moves: [{ ...punch, anchor: "face" }] } },
  track,
  11
);
check("follow zoom and a punch multiply", near(state.zoom, 1.1 * 1.3));
check("a face anchor sits inside the frame near the face", state.ax > 0.4 && state.ax < 0.7 && state.ay > 0.3 && state.ay < 0.5);
const off = cameraStateAt({ enabled: false, version: 1, camera: { moves: [punch] } }, track, 11);
check("a disabled plan has no camera", off.zoom === 1 && off.ax === 0.5);

// Follow pins the head: its on-screen position must not move while the face
// drifts through the shot. The head sits at Z*fy − (Z−1)*AY of the output.
{
  const zoom = 1.2;
  const pinned = { enabled: true, version: 1 as const, camera: { follow: { enabled: true, tightness: 1, zoom }, moves: [] } };
  const loose = { ...pinned, camera: { ...pinned.camera, follow: { enabled: true, tightness: 0, zoom } } };
  const headY = (plan: typeof pinned, sec: number) => {
    const key = track.keyframes[0]!;
    const box = cropBoxAt(key, track);
    const fy = ((key.fy! + ((track.keyframes[1]!.fy! - key.fy!) * (sec - 10)) / 2) - box.y) / box.h;
    const state = cameraStateAt(plan, track, sec);
    return zoom * fy - (zoom - 1) * state.ay;
  };
  const drift = Math.abs(headY(loose, 10) - headY(loose, 12));
  const held = Math.abs(headY(pinned, 10) - headY(pinned, 12));
  check("a loose follow lets the head move on screen", drift > 0.02, `drift ${drift.toFixed(3)}`);
  check("a tight follow holds the head still while the face moves", held < 1e-3, `held ${held.toFixed(4)}`);
  check("follow always zooms enough to have headroom", followZoom({ ...pinned, camera: { follow: { enabled: true, tightness: 1 }, moves: [] } }) === FOLLOW_MIN_ZOOM);
}

// The camera rides a smoothed face path: box jitter goes, a lean stays, and a
// cut is a wall the average never looks across.
{
  const jittery: ReframeTrack = {
    ...track,
    cuts: [2.05],
    keyframes: Array.from({ length: 40 }, (_, i) => {
      const t = i * 0.1;
      const lean = t < 2.05 ? 0 : 60;
      return { t, cx: 960, cy: 540, width: 608, fx: 1000, fy: 300 + lean + (i % 2 === 0 ? 20 : -20), fw: 120 };
    }),
  };
  const smooth = smoothedTrack(jittery);
  const before = smooth.keyframes.filter((key) => key.t < 2).map((key) => key.fy!);
  const after = smooth.keyframes.filter((key) => key.t > 2.1).map((key) => key.fy!);
  check("frame-to-frame box jitter is smoothed away", before.every((fy) => Math.abs(fy - 300) < 4), `max ${Math.max(...before.map((fy) => Math.abs(fy - 300))).toFixed(1)}`);
  const interior = smooth.keyframes.filter((key) => key.t > 2.1 && key.t < 3.2).map((key) => key.fy!);
  check("a lean after a cut is kept and the cut is not blurred", interior.every((fy) => Math.abs(fy - 360) < 4) && Math.abs(smooth.keyframes[20]!.fy! - 300) < 4);
  // The path is integrated over TIME: the analyser emits keyframes while the
  // head moves and none while it rests, so a rest must weigh by how long it
  // lasts, and a head that has stopped is held where it stopped.
  // Spans to 21 s: 20 s of rest, a 0.5 s rise, 0.5 s held at the top.
  const rested: ReframeTrack = {
    ...track,
    untilSec: 31,
    cuts: [],
    keyframes: [
      { t: 0, cx: 960, cy: 540, width: 608, fx: 1000, fy: 300, fw: 120 },
      ...Array.from({ length: 10 }, (_, i) => ({ t: 20 + i * 0.05, cx: 960, cy: 540, width: 608, fx: 1000, fy: 300 + (i + 1) * 6, fw: 120 })),
      { t: 20.5, cx: 960, cy: 540, width: 608, fx: 1000, fy: 360, fw: 120 },
    ],
  };
  const restedSmooth = smoothedTrack(rested, FOLLOW_SIGMA_SEC.snappy);
  const settled = restedSmooth.keyframes[restedSmooth.keyframes.length - 1]!.fy!;
  check("a head that stopped is held where it stopped, not pulled back toward the motion", Math.abs(settled - 360) < 2, `settled ${settled.toFixed(1)}`);
  const restBox = cropBoxAt(rested.keyframes[0]!, rested);
  const rest = faceRestY(rested.keyframes[5]!, rested);
  const restPx = restBox.y + rest * restBox.h;
  check("rest is the time-weighted position: 20 s at 300 outweighs 0.5 s of motion", Math.abs(restPx - 300) < 6, `rest ${restPx.toFixed(1)} px`);
  check("response picks the smoothing: snappy < natural < smooth", FOLLOW_SIGMA_SEC.snappy < FOLLOW_SIGMA_SEC.natural && FOLLOW_SIGMA_SEC.natural < FOLLOW_SIGMA_SEC.smooth);
  const snappyPlan = { enabled: true, version: 1 as const, camera: { follow: { enabled: true, tightness: 1, zoom: 1.2, response: "snappy" as const }, moves: [] } };
  check("followSigma reads the plan's response, natural by default", followSigma(snappyPlan) === FOLLOW_SIGMA_SEC.snappy && followSigma({ ...snappyPlan, camera: { ...snappyPlan.camera, follow: { enabled: true, tightness: 1, zoom: 1.2 } } }) === FOLLOW_SIGMA_SEC.natural);
  // A nod survives snappy and is gone by smooth.
  const nodding: ReframeTrack = {
    ...track,
    cuts: [],
    keyframes: Array.from({ length: 60 }, (_, i) => {
      const t = i * 0.1;
      const nod = t >= 3 && t < 3.4 ? 40 : 0;
      return { t, cx: 960, cy: 540, width: 608, fx: 1000, fy: 300 + nod, fw: 120 };
    }),
  };
  const nodAt = (sigma: number) => Math.max(...smoothedTrack(nodding, sigma).keyframes.map((key) => key.fy! - 300));
  check("snappy keeps most of a 0.4 s nod; smooth drops most of it", nodAt(FOLLOW_SIGMA_SEC.snappy) > 30 && nodAt(FOLLOW_SIGMA_SEC.smooth) < 12, `snappy ${nodAt(FOLLOW_SIGMA_SEC.snappy).toFixed(0)} px, smooth ${nodAt(FOLLOW_SIGMA_SEC.smooth).toFixed(0)} px`);
  // Axis: a horizontal-only follow leaves the vertical pin alone, and vice versa.
  const both = { enabled: true, version: 1 as const, camera: { follow: { enabled: true, tightness: 1, zoom: 1.2 }, moves: [] } };
  const acrossOnly = { ...both, camera: { ...both.camera, follow: { ...both.camera.follow, axis: "x" as const } } };
  const upOnly = { ...both, camera: { ...both.camera, follow: { ...both.camera.follow, axis: "y" as const } } };
  check("axis x pans but never slides", followTightnessX(acrossOnly) === 1 && followTightnessY(acrossOnly) === 0);
  check("axis y slides but never pans", followTightnessX(upOnly) === 0 && followTightnessY(upOnly) === 1);
  const anchorBoth = followAnchorOfKeyframe(nodding.keyframes[32]!, nodding, both)!;
  const anchorAcross = followAnchorOfKeyframe(nodding.keyframes[32]!, nodding, acrossOnly)!;
  const anchorUp = followAnchorOfKeyframe(nodding.keyframes[32]!, nodding, upOnly)!;
  check("axis x: anchor y is the face itself (no pin), x matches the two-way follow", Math.abs(anchorAcross.y - ((340 - cropBoxAt(nodding.keyframes[32]!, nodding).y) / cropBoxAt(nodding.keyframes[32]!, nodding).h)) < 1e-6 && Math.abs(anchorAcross.x - anchorBoth.x) < 1e-6);
  check("axis y: anchor y pins like the two-way follow", Math.abs(anchorUp.y - anchorBoth.y) < 1e-6);
  const travel = headTravel(nodding)!;
  check("headTravel reports the nod as a fraction of the crop", Math.abs(travel.y - 40 / cropBoxAt(nodding.keyframes[0]!, nodding).h) < 1e-6 && travel.x === 0, `${travel.x.toFixed(3)}, ${travel.y.toFixed(3)}`);
}

console.log("\nall creator-mode checks passed");

// ---- camera expressions agree with the numeric camera ----
import { cameraExpressions, cameraFilterChain, panExpr } from "../src/services/camera.service";
import { cropChainForTrack } from "../src/services/clip-render.service";
import { config } from "../src/config";

/**
 * A tiny evaluator for the FFmpeg expression subset the camera emits:
 * numbers, `t`, + - * /, parentheses, and if/lt/gt/gte/clip/pow/log/min/max.
 */
function evalExpr(source: string, t: number): number {
  let pos = 0;
  const peek = () => source[pos];
  const eat = (ch: string) => {
    if (source[pos] !== ch) throw new Error(`expected ${ch} at ${pos} in ${source.slice(pos, pos + 20)}`);
    pos++;
  };
  function expr(): number {
    let value = term();
    while (peek() === "+" || peek() === "-") {
      const op = source[pos++];
      const rhs = term();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }
  function term(): number {
    let value = factor();
    while (peek() === "*" || peek() === "/") {
      const op = source[pos++];
      const rhs = factor();
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  }
  function factor(): number {
    if (peek() === "-") {
      pos++;
      return -factor();
    }
    if (peek() === "(") {
      pos++;
      const value = expr();
      eat(")");
      return value;
    }
    const match = /^[a-z]+/.exec(source.slice(pos));
    if (match) {
      pos += match[0].length;
      if (match[0] === "t") return t;
      eat("(");
      const args: number[] = [expr()];
      while (peek() === ",") {
        pos++;
        args.push(expr());
      }
      eat(")");
      const [a = 0, b = 0, c = 0] = args;
      switch (match[0]) {
        case "if": return a !== 0 ? b : c;
        case "lt": return a < b ? 1 : 0;
        case "gt": return a > b ? 1 : 0;
        case "gte": return a >= b ? 1 : 0;
        case "clip": return Math.min(c, Math.max(b, a));
        case "pow": return Math.pow(a, b);
        case "log": return Math.log(a);
        case "min": return Math.min(a, b);
        case "max": return Math.max(a, b);
        default: throw new Error(`unknown function ${match[0]}`);
      }
    }
    const number = /^\d+(\.\d+)?/.exec(source.slice(pos));
    if (!number) throw new Error(`unexpected ${source.slice(pos, pos + 12)}`);
    pos += number[0].length;
    return Number(number[0]);
  }
  const value = expr();
  if (pos !== source.length) throw new Error(`trailing input at ${pos}: ${source.slice(pos, pos + 20)}`);
  return value;
}

const richTrack: ReframeTrack = {
  ...track,
  cuts: [4.5],
  keyframes: [
    { t: 0, cx: 960, cy: 540, width: 608, fx: 1000, fy: 380, fw: 120 },
    { t: 1.5, cx: 980, cy: 540, width: 608, fx: 1060, fy: 400, fw: 120 },
    { t: 3, cx: 1100, cy: 540, width: 608, fx: 1180, fy: 430, fw: 130 },
    { t: 4.5, cx: 600, cy: 540, width: 608, fx: 620, fy: 360, fw: 110 },
    { t: 7, cx: 640, cy: 540, width: 608, fx: 700, fy: 390, fw: 110 },
  ],
};
const plans: CreatorPlan[] = [
  {
    enabled: true,
    version: 1,
    camera: {
      follow: { enabled: true, tightness: 0.8, zoom: 1.12 },
      moves: [
        { id: "a", kind: "pull", startSec: 100, endSec: 100.6, zoom: 1.2, anchor: "face", ease: "out" },
        { id: "b", kind: "punch", startSec: 102, endSec: 103.2, zoom: 1.3, anchor: "center", ease: "in_out" },
        { id: "c", kind: "push", startSec: 104, endSec: 106.5, zoom: 1.15, anchor: { x: 0.3, y: 0.7 }, ease: "out" },
        { id: "d", kind: "punch", startSec: 107, endSec: 108, zoom: 1.25, anchor: "face", ease: "cut" },
      ],
    },
  },
  {
    enabled: true,
    version: 1,
    camera: {
      moves: [{ id: "solo", kind: "punch", startSec: 101, endSec: 102, zoom: 1.4, anchor: "face", ease: "out" }],
    },
  },
  { enabled: true, version: 1, camera: { follow: { enabled: true, tightness: 1, zoom: 1.2 }, moves: [] } },
  {
    enabled: true,
    version: 1,
    camera: {
      follow: { enabled: true, tightness: 0.85, zoom: 1.18, lead: 0.5 },
      moves: [
        { id: "f", kind: "frame", startSec: 100.5, endSec: 102, zoom: 1.3, zoomFrom: 1.1, pan: { x: 0.6, y: 0 }, rampSec: 0.4, anchor: "look", ease: "in_out" },
        { id: "o", kind: "punch", startSec: 103, endSec: 104, zoom: 0.85, anchor: "face", ease: "out" },
        { id: "p", kind: "pull", startSec: 105, endSec: 106, zoom: 1.4, zoomFrom: 1.2, anchor: { x: 0.2, y: 0.3 }, ease: "cut" },
      ],
    },
  },
  {
    enabled: true,
    version: 1,
    camera: {
      follow: { enabled: true, tightness: 0.9, zoom: 1.2 },
      moves: [
        { id: "h", kind: "hold", startSec: 100.6, endSec: 102.2, zoom: 1, anchor: "face", ease: "cut" },
        { id: "h2", kind: "hold", startSec: 105.2, endSec: 107, zoom: 1.15, anchor: "look", ease: "out" },
      ],
    },
  },
];
let worst = 0;
let evaluated = 0;
for (const cameraPlan of plans) {
  for (const window of [
    { startSec: 100, endSec: 104 },
    { startSec: 104.3, endSec: 109 },
  ]) {
    // Holds lock the path the camera reads, as the render does (cameraTrackFor).
    const planTrack = holdSpans(cameraPlan).length ? heldTrack(richTrack, holdSpans(cameraPlan)) : richTrack;
    const expressions = cameraExpressions({ plan: cameraPlan, track: planTrack, windowStartSec: window.startSec, windowEndSec: window.endSec });
    for (let local = 0; local < window.endSec - window.startSec; local += 0.037) {
      const sourceSec = window.startSec + local;
      const numeric = cameraStateAt(cameraPlan, planTrack, sourceSec);
      // No expression means "nothing to apply in this window" — identity.
      const zoom = expressions ? evalExpr(expressions.zoom, local) : 1;
      const ax = expressions ? evalExpr(expressions.ax, local) : 0.5;
      const ay = expressions ? evalExpr(expressions.ay, local) : 0.5;
      const error = Math.max(Math.abs(zoom - numeric.zoom), Math.abs(ax - numeric.ax) * (numeric.zoom - 1), Math.abs(ay - numeric.ay) * (numeric.zoom - 1));
      if (process.env.SWEEP_DEBUG && error > 2e-3) console.log(`plan ${plans.indexOf(cameraPlan)} t=${sourceSec.toFixed(3)} zoom ${zoom.toFixed(4)}/${numeric.zoom.toFixed(4)} ax ${ax.toFixed(4)}/${numeric.ax.toFixed(4)} ay ${ay.toFixed(4)}/${numeric.ay.toFixed(4)}`);
      worst = Math.max(worst, error);
      evaluated++;
    }
  }
}
check(`camera expressions match the numeric camera at ${evaluated} instants`, worst < 2e-3, `worst error ${worst.toExponential(2)}`);
const longest = Math.max(
  ...plans.map((cameraPlan) => {
    const expressions = cameraExpressions({ plan: cameraPlan, track: richTrack, windowStartSec: 100, windowEndSec: 109 });
    return expressions ? expressions.zoom.length + expressions.ax.length + expressions.ay.length : 0;
  })
);
check("camera expressions stay command-line sized", longest < 20_000, `${longest} chars`);

// The chain through FFmpeg itself. `crop` keeps the iw/ih of its first frame
// when `scale` changes size mid-stream, so an anchor written against iw/ih is
// wrong (and silently clamped) whenever a window starts at another zoom than
// it later has — the evaluator above cannot see that. Trace the real filter.
{
  const traced: CreatorPlan = {
    enabled: true,
    version: 1,
    camera: {
      follow: { enabled: true, tightness: 1, zoom: 1.2 },
      moves: [{ id: "p", kind: "punch", startSec: 101, endSec: 102, zoom: 1.3, anchor: "face", ease: "cut" }],
    },
  };
  const window = { startSec: 100, endSec: 104 };
  const chain = cameraFilterChain({ plan: traced, track: richTrack, windowStartSec: window.startSec, windowEndSec: window.endSec });
  const graph = `color=c=black:s=1080x1920:r=10:d=4,${chain}`;
  const proc = Bun.spawnSync([config.ffmpegPath, "-hide_banner", "-loglevel", "trace", "-filter_complex", graph, "-f", "null", "-"], { stderr: "pipe", stdout: "pipe" });
  const log = new TextDecoder().decode(proc.stderr);
  let worstPx = 0;
  let samples = 0;
  for (const match of log.matchAll(/Parsed_crop_\d+ @ [^\]]+\] n:\d+ t:([\d.]+)(?: pos:-?\d+)? x:(\d+) y:(\d+)/g)) {
    const t = Number(match[1]);
    const numeric = cameraStateAt(traced, richTrack, window.startSec + t);
    const scaledW = Math.trunc((1080 * numeric.zoom) / 2) * 2;
    const scaledH = Math.trunc((1920 * numeric.zoom) / 2) * 2;
    const x = (scaledW - 1080) * numeric.ax;
    const y = (scaledH - 1920) * numeric.ay;
    worstPx = Math.max(worstPx, Math.abs(Number(match[2]) - x), Math.abs(Number(match[3]) - y));
    samples++;
  }
  check("ffmpeg places the crop where the numeric camera says, across a zoom change", samples >= 30 && worstPx <= 2, `${samples} frames, worst ${worstPx.toFixed(1)}px`);
}

// A dense head path in ONE window. FFmpeg's expression parser allows ~100
// levels of function nesting; the pan and anchors are flat sums so a shot
// with hundreds of keyframes still parses — this failed a real render.
{
  const dense: ReframeTrack = {
    ...track,
    originSec: 100,
    untilSec: 145,
    cuts: [20.05],
    keyframes: Array.from({ length: 400 }, (_, i) => {
      const t = i * 0.1;
      const sway = Math.round(40 * Math.sin(t * 1.3));
      return { t, cx: 960 + sway, cy: 540, width: 608, fx: 1000 + sway, fy: 380 + Math.round(20 * Math.cos(t * 2.1)), fw: 120 };
    }),
  };
  const followed: CreatorPlan = { enabled: true, version: 1, camera: { follow: { enabled: true, tightness: 0.85, zoom: 1.18, response: "snappy" }, moves: [] } };
  const window = { startSec: 100, endSec: 140 };
  const base = cropChainForTrack(smoothedTrack(dense, followSigma(followed)), window.startSec, followTightnessX(followed), window.endSec);
  const camera = cameraFilterChain({ plan: followed, track: smoothedTrack(dense, followSigma(followed)), windowStartSec: window.startSec, windowEndSec: window.endSec });
  check("dense window: expressions are flat sums, not nested pieces", !base.includes("if(lt(t") && !camera.includes("if(lt(t"));
  const graph = `color=c=black:s=1920x1080:r=5:d=1,${base},${camera}`;
  const proc = Bun.spawnSync([config.ffmpegPath, "-hide_banner", "-v", "error", "-filter_complex", graph, "-f", "null", "-"], { stderr: "pipe", stdout: "pipe" });
  const err = new TextDecoder().decode(proc.stderr);
  check("dense window: ffmpeg accepts a 400-keyframe pan + follow in one window", proc.exitCode === 0, err.slice(0, 160) || `${base.length + camera.length} chars`);
}

// ---- creative camera: zoom out, frame moves, pan, look room, lead ----
{
  const yawTrack: ReframeTrack = {
    ...richTrack,
    keyframes: richTrack.keyframes.map((key) => ({ ...key, fyaw: 0.8 })),
  };
  const frame: CameraMove = { id: "f", kind: "frame", startSec: 100.5, endSec: 102, zoom: 1.3, zoomFrom: 1.1, pan: { x: 0.6, y: 0 }, rampSec: 0.4, anchor: "look", ease: "out" };
  const plan: CreatorPlan = { enabled: true, version: 1, camera: { moves: [frame] } };
  check("frame: amount ramps over rampSec then holds", moveAmountAt(frame, 100.5) === 0 && moveAmountAt(frame, 100.9) === 1 && moveAmountAt(frame, 101.9) === 1 && moveAmountAt(frame, 102) === 0);
  check("zoomFrom: the move starts from it", near(moveZoomAt(frame, 0), 1.1) && near(moveZoomAt(frame, 1), 1.3));
  const out: CameraMove = { id: "o", kind: "punch", startSec: 103, endSec: 104, zoom: 0.85, anchor: "face", ease: "cut" };
  const outPlan: CreatorPlan = { enabled: true, version: 1, camera: { follow: { enabled: true, tightness: 0.8, zoom: 1.18 }, moves: [out] } };
  check("zoom out: under a follow zoom the picture opens up, never past the crop", near(cameraStateAt(outPlan, yawTrack, 103.5).zoom, Math.max(1, 1.18 * 0.85)));
  const slack = panSlack(yawTrack);
  check("pan slack: half the room either side of a 9:16 crop, none vertically on 16:9", near(slack.x, (1920 - 608) / 2) && slack.y === 0);
  const panned = panPxAt(plan, yawTrack, 101.5);
  check("pan: at full amount the crop moves pan × slack source pixels", near(panned.x, 0.6 * slack.x));
  check("pan: zero outside the move", panPxAt(plan, yawTrack, 99).x === 0 && panPxAt(plan, yawTrack, 102.5).x === 0);
  const noLook = resolveAnchor("face", yawTrack, 101, 0.8, 0, panned);
  const look = resolveAnchor("look", yawTrack, 101, 0.8, 0, panned);
  check("look: the anchor sits ahead of the face, the way it faces", near(look.x - noLook.x, LOOK_ROOM * 0.8, 1e-3) && near(look.y, noLook.y));
  const key = yawTrack.keyframes[0]!;
  check("lead: the crop leans toward the gaze by lead × yaw × LEAD_ROOM crop widths", near(followCx(key, 0, 1920, 1) - followCx(key, 0, 1920, 0), 0.8 * LEAD_ROOM * key.width));
  check("lead: off without a yaw", followCx(richTrack.keyframes[0]!, 0, 1920, 1) === followCx(richTrack.keyframes[0]!, 0, 1920, 0));

  // The base crop through FFmpeg: a still track, a frame move that pans right.
  const still: ReframeTrack = { ...richTrack, cuts: [], keyframes: [{ t: 0, cx: 960, cy: 540, width: 608, fx: 1000, fy: 380, fw: 120 }] };
  const window = { startSec: 100, endSec: 103 };
  const chain = cropChainForTrack(still, window.startSec, 0, window.endSec, { pan: panExpr(plan, still, window.startSec, window.endSec) });
  const graph = `color=c=black:s=1920x1080:r=10:d=3,${chain}`;
  const proc = Bun.spawnSync([config.ffmpegPath, "-hide_banner", "-loglevel", "trace", "-filter_complex", graph, "-f", "null", "-"], { stderr: "pipe", stdout: "pipe" });
  const log = new TextDecoder().decode(proc.stderr);
  let worstPx = 0;
  let samples = 0;
  for (const match of log.matchAll(/Parsed_crop_\d+ @ [^\]]+\] n:\d+ t:([\d.]+)(?: pos:-?\d+)? x:(\d+) y:(\d+)/g)) {
    const t = Number(match[1]);
    const box = cropBoxAt(still.keyframes[0]!, still, 0, 0, panPxAt(plan, still, window.startSec + t));
    worstPx = Math.max(worstPx, Math.abs(Number(match[2]) - box.x));
    samples++;
  }
  check("ffmpeg pans the base crop where panPxAt says, through the ramp and the hold", proc.exitCode === 0 && samples >= 25 && worstPx <= 1.5, `${samples} frames, worst ${worstPx.toFixed(1)}px`);
}

// ---- hold: the camera locks off, then rejoins the path ----
{
  const moving: ReframeTrack = {
    mode: "crop",
    sourceWidth: 1920,
    sourceHeight: 1080,
    confidence: 1,
    provider: "faces",
    originSec: 100,
    untilSec: 107,
    cuts: [4],
    keyframes: Array.from({ length: 13 }, (_, i) => ({ t: i * 0.5, cx: 700 + 50 * i, cy: 540, width: 608, fx: 740 + 50 * i, fy: 380 + 6 * i, fw: 120 })),
  };
  const hold: CameraMove = { id: "h", kind: "hold", startSec: 101.2, endSec: 102.4, zoom: 1, anchor: "face", ease: "cut" };
  const cutHold: CameraMove = { id: "h2", kind: "hold", startSec: 103.5, endSec: 104.8, zoom: 1.1, anchor: "face", ease: "cut" };
  const plan: CreatorPlan = { enabled: true, version: 1, camera: { follow: { enabled: true, tightness: 1, zoom: 1.15, response: "snappy" }, moves: [hold, cutHold] } };
  check("hold: the sanitiser keeps a hold that neither zooms nor pans", sanitizeCreatorPlan(plan).camera?.moves.filter((move) => move.kind === "hold").length === 2);
  check("hold: amount is 1 for the whole span", moveAmountAt(hold, 101.2) === 1 && moveAmountAt(hold, 102.39) === 1 && moveAmountAt(hold, 102.4) === 0);
  const held = heldTrack(moving, holdSpans(plan));
  const x = (source: ReframeTrack, sourceSec: number) => keyframeStateAt(source, sourceSec - 100).cx;
  const lockedAt = x(moving, 101.2);
  check(
    "hold: the crop stays where it was at the hold's first frame",
    [101.2, 101.6, 102.0, 102.4].every((t) => near(x(held, t), lockedAt)) && !near(x(moving, 102.4), lockedAt, 1)
  );
  check("hold: the path is untouched before it and rejoined after the release", near(x(held, 100.8), x(moving, 100.8)) && near(x(held, 103.0), x(moving, 103.0)));
  const face = (source: ReframeTrack, sourceSec: number) => keyframeStateAt(source, sourceSec - 100).fy!;
  check("hold: the face the zoom pins is held too", near(face(held, 101.3), face(held, 102.3)));
  check(
    "hold: a shot cut ends it — the next shot frames its own speaker",
    near(x(held, 103.9), x(moving, 103.5)) && near(x(held, 104.2), x(moving, 104.2))
  );
  const stateA = cameraStateAt(plan, held, 101.3);
  const stateB = cameraStateAt(plan, held, 102.3);
  check("hold: the camera state (zoom and anchor) is constant through it", near(stateA.zoom, stateB.zoom) && near(stateA.ax, stateB.ax) && near(stateA.ay, stateB.ay));
  check("cameraTrackFor: smoothing then holds, what the render and the player share", JSON.stringify(cameraTrackFor(moving, plan).keyframes.filter((key) => key.t > 1.2 && key.t < 2.4)) === "[]");

  // Through FFmpeg: the base crop's x over the window, frame by frame.
  const chain = cropChainForTrack(held, 100, 1, 103);
  const graph = `color=c=black:s=1920x1080:r=10:d=3,${chain}`;
  const proc = Bun.spawnSync([config.ffmpegPath, "-hide_banner", "-loglevel", "trace", "-filter_complex", graph, "-f", "null", "-"], { stderr: "pipe", stdout: "pipe" });
  const log = new TextDecoder().decode(proc.stderr);
  const inHold: number[] = [];
  let worstPx = 0;
  for (const match of log.matchAll(/Parsed_crop_\d+ @ [^\]]+\] n:\d+ t:([\d.]+)(?: pos:-?\d+)? x:(\d+) y:(\d+)/g)) {
    const t = Number(match[1]);
    const px = Number(match[2]);
    if (t >= 1.2 && t <= 2.4) inHold.push(px);
    worstPx = Math.max(worstPx, Math.abs(px - cropBoxAt(keyframeStateAt(held, t), held, 1).x));
  }
  check(
    "ffmpeg: the crop does not move through the hold and follows the held path elsewhere",
    proc.exitCode === 0 && inHold.length >= 12 && Math.max(...inHold) - Math.min(...inHold) <= 1 && worstPx <= 1.5,
    `${inHold.length} held frames, spread ${Math.max(...inHold) - Math.min(...inHold)}px, worst ${worstPx.toFixed(1)}px`
  );
}

console.log("\nall camera checks passed");

// ---- the Director's answer becomes a sane plan ----
import { applyDirectorAnswer, lenientOverrides } from "../src/services/director.service";

const directed = applyDirectorAnswer({
  answer: {
    summary: "  Tight hook, punch the peak.  ",
    cuts: ["pause2", "nope"],
    camera: {
      follow: { enabled: true, tightness: 0.7, zoom: 1.08 },
      moves: [
        { kind: "pull", start: 0, end: 0.6, zoom: 1.2, anchor: "face", ease: "out" },
        { kind: "punch", start: 10.04, end: 11.5, zoom: 9, anchor: "face", ease: "cut" },
      ],
    },
    captionScenes: [{ label: "hook", start: 0.02, end: 2.5, styleId: "creator_hook", overrides: { highlight: true, peakColor: "gold", sizeScale: 1.2 } }],
    titles: [{ text: "the one rule", start: 0.1, end: 2.4, x: 0.5, y: 0.5, sizeScale: 1.9, depth: "behind" }, { text: "   " }],
    sfx: [{ asset: "swoosh", at: 0, gain: 0.8 }, { asset: "kazoo", at: 1 }, { asset: "boom", at: 10.04, gain: 5 }],
  },
  trimStart: 100,
  trimEnd: 140,
  onsets: [0, 0.4, 1.2, 10.0, 11.4],
  candidates: [
    { id: "pause1", startSec: 105, endSec: 105.5, enabled: false, source: "director", savesSec: 0.5 },
    { id: "pause2", startSec: 108, endSec: 109, enabled: false, source: "director", savesSec: 1 },
  ],
  current: { enabled: true, version: 1, cuts: [{ id: "mine", startSec: 120, endSec: 120.4, enabled: true, source: "user" }], titles: [{ id: "old", text: "OLD", startSec: 101, endSec: 102, x: 0.5, y: 0.5, sizeScale: 1, color: "#ffffff", animation: "pop", depth: "front" }] },
  currentSfx: [{ id: "user_hit", assetId: "hit", atSec: 3, gain: 1 }],
  keep: ["titles"],
  sfxIds: new Set(["swoosh", "boom", "hit"]),
  windowsOutput: (sourceSec) => sourceSec - 100,
});
check("director cuts: named candidates enabled, unknown ignored, the user's own cut kept", directed.plan.cuts?.map((cut) => `${cut.id}:${cut.enabled}`).join(",") === "pause1:false,pause2:true,mine:true");
check("director moves land on word onsets and zoom is capped", near(directed.plan.camera!.moves[1]!.startSec, 110) && directed.plan.camera!.moves[1]!.zoom === 1.5);
check("director scene overrides are coerced, not rejected", directed.plan.captionScenes?.[0]?.overrides?.highlight === "word" && directed.plan.captionScenes?.[0]?.overrides?.peakColor === undefined);
check("a kept lane survives untouched", directed.plan.titles?.length === 1 && directed.plan.titles[0]!.text === "OLD");
check("director sfx: unknown assets dropped, gains clamped, user hits kept", directed.sfx.map((hit) => hit.assetId).join(",") === "hit,swoosh,boom" && directed.sfx[2]!.gain === 1.5);
check("the summary is trimmed into the plan", directed.plan.director?.summary === "Tight hook, punch the peak.");
check("lenient overrides drop nonsense and keep the rest", JSON.stringify(lenientOverrides({ chunkWords: 99, background: "glow", uppercase: 1 })) === JSON.stringify({ chunkWords: 8, uppercase: true }));


// ---- Creator Mode II: the Director writes speed, looks, B-roll and framing ----
import { buildDirectorPrompt, gazeSummary, libraryMatch, resolveDirectorMedia, resolveDirectorMusic, type DirectorLane, type DirectorPlanJson } from "../src/services/director.service";

const stored: CreatorPlan = {
  enabled: true,
  version: 1,
  speed: [{ id: "s_user", kind: "slow", startSec: 120, endSec: 121, rate: 0.5 }],
  effects: [{ id: "fx_user", effectId: "vhs", startSec: 101, endSec: 102, amount: 0.6 }],
  cutaways: [{ id: "c_user", assetId: "lib1", startSec: 125, endSec: 127, fit: "cover", motion: "in", in: { transitionId: "dissolve", sec: 0.3 }, out: { transitionId: "cut", sec: 0 } }],
  captionScenes: [{ id: "scene_user", startSec: 100, endSec: 103 }],
};
const baseDirect = {
  trimStart: 100,
  trimEnd: 140,
  onsets: [0, 0.4, 1.2, 10.0, 11.4, 20.0],
  candidates: [],
  current: stored,
  currentSfx: [],
  keep: [] as DirectorLane[],
  sfxIds: new Set(["swoosh"]),
  mediaIds: new Set(["lib1", "stock9"]),
  windowsOutput: (sourceSec: number) => sourceSec - 100,
};

// A pass that only talks about captions must not wipe the lanes it left out.
const captionsOnly = applyDirectorAnswer({ ...baseDirect, answer: { summary: "Calmer captions.", captionScenes: [{ start: 0, end: 5, styleId: "clean" }] } });
check(
  "lanes the answer leaves out keep their speed, effects and cutaways",
  captionsOnly.plan.speed?.[0]?.id === "s_user" && captionsOnly.plan.effects?.[0]?.id === "fx_user" && captionsOnly.plan.cutaways?.[0]?.id === "c_user"
);
check("the lane the answer speaks to is rewritten", captionsOnly.plan.captionScenes?.length === 1 && captionsOnly.plan.captionScenes[0]!.styleId === "clean");
const cleared = applyDirectorAnswer({ ...baseDirect, answer: { effects: [], speed: [] } });
check("an empty list clears a lane", cleared.plan.effects === undefined && cleared.plan.speed === undefined && cleared.plan.cutaways?.length === 1);

const full: DirectorPlanJson = {
  summary: "Slow the reaction, VHS the flashback, cut to the racks.",
  camera: {
    moves: [
      { kind: "frame", start: 9.95, end: 12, zoomFrom: 1.3, zoom: 0.6, pan: { x: -3, y: 0.2 }, rampSec: 0.5, anchor: "look", ease: "in_out" },
    ],
  },
  speed: [
    { kind: "slow", start: 19.97, end: 21, rate: 2 },
    { kind: "freeze", start: 30, end: 30.5, rate: 0.5 },
    { kind: "fast", start: 35, end: 36, rate: 0.5, smooth: true },
  ],
  effects: [
    { effect: "vhs", start: 1.21, end: 3, amount: 4 },
    { effect: "made_up", start: 4, end: 5 },
    { effectId: "glitch", start: 10, end: 10.5 },
  ],
  cutaways: [
    { asset: "stock9", start: 11.39, end: 13, motion: "sideways", in: { transition: "slide_left", sec: 9 }, out: { transition: "nope" } },
    { query: "never resolved", start: 15, end: 17 },
  ],
};
const directedFull = applyDirectorAnswer({ ...baseDirect, keep: ["cuts"], answer: full });
const frame = directedFull.plan.camera!.moves[0]!;
check(
  "director frame moves keep pan (clamped), zoomFrom, rampSec and the look anchor",
  frame.kind === "frame" && frame.pan?.x === -1 && frame.pan?.y === 0.2 && frame.zoomFrom === 1.3 && frame.zoom === 0.75 && frame.rampSec === 0.5 && frame.anchor === "look" && near(frame.startSec, 110)
);
const [slow, freeze, fast] = directedFull.plan.speed ?? [];
check(
  "director speed: kinds keep their side of 1, freezes have no rate, starts snap to words",
  slow?.rate === 0.9 && near(slow.startSec, 120) && freeze?.kind === "freeze" && freeze.rate === 0 && fast?.rate === 1.1 && fast.smooth === undefined
);
check(
  "director effects: unknown ids dropped, amount clamped, effectId accepted as a synonym",
  directedFull.plan.effects?.map((effect) => `${effect.effectId}:${effect.amount}`).join(",") === "vhs:1,glitch:0.7" && near(directedFull.plan.effects![0]!.startSec, 101.2)
);
const cutaway = directedFull.plan.cutaways?.[0];
check(
  "director cutaways: unresolved media dropped, motion and transitions coerced",
  directedFull.plan.cutaways?.length === 1 && cutaway?.assetId === "stock9" && cutaway.motion === "in" && cutaway.in.transitionId === "slide_left" && cutaway.in.sec === 1.5 && cutaway.out.transitionId === "dissolve" && near(cutaway.startSec, 111.4)
);
const loose = applyDirectorAnswer({
  ...baseDirect,
  answer: {
    effects: [{ effect: "RGB_Split", start: 1, end: 2 }, { effect: "Black & White", start: 3, end: 4 }, { effect: "chromatic aberration", start: 5, end: 6 }],
    cutaways: [{ asset: "lib1", start: 20, end: 22, in: "crossfade", out: { transition: "slide" } }, { asset: "lib1", start: 25, end: 27, in: { transition: "Slide-Up" }, out: { transitionId: "flash" } }],
  },
});
check(
  "director ids are matched leniently: case, punctuation, labels and editors' words",
  loose.plan.effects?.map((effect) => effect.effectId).join(",") === "rgbsplit,bw,rgbsplit" &&
    loose.plan.cutaways?.map((item) => `${item.in.transitionId}/${item.out.transitionId}`).join(",") === "dissolve/slide_left,slide_up/dip_white"
);
const locked = applyDirectorAnswer({ ...baseDirect, keep: ["speed", "fx", "cutaways"], answer: full });
check("locked Speed / FX / B-roll lanes survive an answer that rewrites them", locked.plan.speed?.[0]?.id === "s_user" && locked.plan.effects?.length === 1 && locked.plan.cutaways?.[0]?.id === "c_user");

const library: MediaAsset[] = [
  { id: "lib1", kind: "video", source: "upload", label: "Server room racks", width: 1080, height: 1920, durationSec: 12 },
  { id: "lib2", kind: "image", source: "upload", label: "City skyline at night", width: 1080, height: 1920 },
];
check("library match: shared words win, nothing shared is no match", libraryMatch("a data center server rack", library)?.id === "lib1" && libraryMatch("puppies", library) === undefined);
let stockCalls = 0;
const resolved = await resolveDirectorMedia({
  cutaways: [
    { asset: "lib2", start: 1, end: 2 },
    { query: "rocket launch", kind: "video", start: 3, end: 4 },
    { query: "Rocket launch", kind: "video", start: 5, end: 6 },
    { query: "servers in a server room", start: 7, end: 8 },
    { query: "puppies", start: 9, end: 10 },
    { asset: "gone", start: 11, end: 12 },
  ],
  library,
  findStock: async (query) => {
    stockCalls++;
    if (query.toLowerCase().includes("rocket")) return { id: "stock_rocket", kind: "video", source: "pexels", label: query, width: 1080, height: 1920 };
    throw new Error("pexels answered 429");
  },
});
check(
  "stock queries resolve once per query, fall back to the library, and report what failed",
  resolved.cutaways.map((item) => item.asset ?? "-").join(",") === "lib2,stock_rocket,stock_rocket,lib1,-,-" &&
    stockCalls === 3 &&
    resolved.assets.length === 1 &&
    resolved.warnings.length === 2 &&
    resolved.warnings.some((warning) => warning.includes("puppies") && warning.includes("429"))
);
const noStock = await resolveDirectorMedia({ cutaways: [{ query: "rocket launch" }], library });
const noStockPlan = applyDirectorAnswer({ ...baseDirect, mediaIds: new Set(library.map((asset) => asset.id)), answer: { cutaways: noStock.cutaways } });
check(
  "with no stock and no match the cutaway is left out and the plan is still valid",
  noStock.warnings[0]?.includes("no stock search is configured") === true && noStockPlan.plan.cutaways === undefined && noStockPlan.plan.enabled
);

// Conversation turns: the sanitiser keeps the last six, field by field.
const turned = sanitizeCreatorPlan({
  enabled: true,
  director: { turns: Array.from({ length: 8 }, (_, i) => ({ notes: i % 2 ? `note ${i}` : "", summary: `did ${i}`, at: `t${i}`, junk: true })).concat([{ summary: "  " } as never]) },
});
check(
  "director turns: last six kept, blank summaries and stray fields dropped",
  turned.director?.turns?.length === 6 && turned.director.turns[0]!.summary === "did 2" && turned.director.turns[0]!.notes === undefined && turned.director.turns[1]!.notes === "note 3" && !("junk" in turned.director.turns[5]!)
);

const gazeTrack: ReframeTrack = {
  ...track,
  originSec: 0,
  keyframes: [
    { t: 0, cx: 960, cy: 540, width: 608, fx: 900, fyaw: 0 },
    { t: 5, cx: 960, cy: 540, width: 608, fx: 900, fyaw: -0.6 },
    { t: 7.5, cx: 960, cy: 540, width: 608, fx: 900, fyaw: 0.5 },
  ],
};
check("gaze summary is time-weighted over the trim", gazeSummary(gazeTrack, 0, 10) === "faces the camera 50% of the time, screen-left 25%, screen-right 25%");

const prompt = buildDirectorPrompt({
  duration: 40,
  trimStart: 100,
  peak: { at: 20, line: "the payoff" },
  words: [{ t: 0, word: "hello" }],
  lines: [{ t: 7.33, text: "California and he was like" }],
  cuts: [],
  pauses: [],
  genre: { label: "Business", summary: "advice" },
  styles: [],
  fonts: ["Anton"],
  sfx: [],
  effects: [{ id: "vhs", group: "texture", summary: "Tape.", variants: ["worn"] }],
  transitions: [{ id: "dissolve", summary: "Cross-fades." }],
  media: [{ id: "lib1", kind: "video", label: "Server room racks", width: 1080, height: 1920, durationSec: 12, line: "Slow push over racks of blinking servers." }],
  music: [{ id: "warm", label: "Warm pad", durationSec: 16, line: "A soft synth pad, unhurried.", bpm: 80, energy: 2, suits: ["under a calm story"] }],
  stock: false,
  assets: "library",
  wantsMusic: true,
  sense: {
    for: { startSec: 100, endSec: 140 },
    model: "m",
    at: "t0",
    overall: "A podcast studio, warm light.",
    shots: [{ start: 0, end: 40, framing: "medium close-up", note: "one shot", energy: 3 }],
    moments: [{ t: 12.5, what: "slaps the table", use: "punch in" }],
    broll: [{ t: 20, idea: "a rocket", query: "rocket launch" }],
    audio: "clean voice, no music",
    hook: "starts mid-sentence",
    payoff: "lands at 20 s",
  },
  lessons: [{ id: "l1", scope: "global", kind: "feedback", text: "Fewer camera moves.", weight: 9, at: "t0" }],
  current: stored,
  currentBeds: [{ id: "bed-1", assetId: "warm", gain: 0.2 }],
  keep: ["fx"],
  notes: "slow-mo the last line",
  turns: [{ notes: "VHS on the hook", summary: "Put VHS on the hook.", at: "t0" }],
});
check(
  "the brief lists effects, transitions, library media, the stored new lanes and earlier turns",
  prompt.includes("vhs (texture) — Tape. [variants: worn]") &&
    prompt.includes("dissolve — Cross-fades.") &&
    prompt.includes("\n7.33 California and he was like") &&
    prompt.includes("\n- Caption scenes: 2–4 scenes.") &&
    prompt.includes("\n- Titles (lane \"titles\"") &&
    prompt.includes("zoom_out (shrinks from big)") &&
    prompt.includes('lib1 — video "Server room racks" 1080x1920 12s') &&
    prompt.includes("speed slow 0.5× 20.00–21.00") &&
    prompt.includes('cutaway asset lib1 "Server room racks" 25.00–27.00') &&
    prompt.includes('1. creator: "VHS on the hook" → you: Put VHS on the hook.') &&
    prompt.includes("a library \"asset\" id only") &&
    prompt.includes("KEEP these lanes exactly as they are in the current plan (leave their keys out of your answer): fx.")
);
check(
  "the brief carries what the harness saw, the described catalogue, the taste lessons and the beds",
  prompt.includes("WHAT THE HARNESS SAW AND HEARD") &&
    prompt.includes("12.5 slaps the table → punch in") &&
    prompt.includes("Slow push over racks of blinking servers.") &&
    prompt.includes('warm — "Warm pad" 16s — A soft synth pad, unhurried. 80 BPM energy 2/5 suits: under a calm story') &&
    prompt.includes("- Fewer camera moves. (the creator said so)") &&
    prompt.includes("music bed warm level 0.2") &&
    prompt.includes('- Music (lane "music")') &&
    prompt.includes("You have WATCHED the clip")
);
const aiPrompt = buildDirectorPrompt({
  duration: 10, trimStart: 0, peak: { at: 5 }, words: [], cuts: [], pauses: [], genre: { label: "g", summary: "s" }, styles: [], fonts: [], sfx: [], music: [], effects: [], transitions: [], media: [],
  stock: true, assets: "both", wantsMusic: false, lessons: [], keep: [],
});
check(
  "assets 'both' offers stock and generation; no music means no music key",
  aiPrompt.includes('a stock "query"') && aiPrompt.includes('"generate": { "kind": "image|video", "prompt": "..." }') && aiPrompt.includes('leave the "music" key out')
);

// ---- music beds in the answer, on the output clock ----
const withMusic = applyDirectorAnswer({
  ...baseDirect,
  musicIds: new Set(["warm", "custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]),
  currentBeds: [{ id: "bed-user", assetId: "pulse", gain: 0.3 }, { id: "dir_bed_old", assetId: "night" }],
  answer: {
    music: [
      { asset: "warm", level: 0.25, dip: 0.7, in: 0, out: null },
      { asset: "custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", level: 0.4, in: 20, out: 30, offset: 12 },
      { asset: "nosuch", level: 0.2 },
    ],
  },
});
check(
  "beds: the creator's own stay, the Director's old ones go, unknown tracks are dropped",
  withMusic.beds.length === 3 && withMusic.beds[0]!.id === "bed-user" && withMusic.beds.every((bed) => bed.id !== "dir_bed_old") && !withMusic.beds.some((bed) => bed.assetId === "nosuch")
);
const secondBed = withMusic.beds[2]!;
check(
  "a bed's in/out land on the output clock with its level, dip and offset",
  withMusic.beds[1]!.gain === 0.25 && withMusic.beds[1]!.dip === 0.7 && withMusic.beds[1]!.inSec === undefined && withMusic.beds[1]!.outSec === undefined &&
    secondBed.inSec === 20 && secondBed.outSec === 30 && secondBed.offsetSec === 12 && secondBed.gain === 0.4 && secondBed.dip === 0.6,
  JSON.stringify(withMusic.beds)
);
const keptMusic = applyDirectorAnswer({ ...baseDirect, keep: ["music"], currentBeds: [{ id: "dir_bed_1", assetId: "warm" }], musicIds: new Set(["pulse"]), answer: { music: [{ asset: "pulse" }] } });
check("a locked music lane keeps its beds", keptMusic.beds.length === 1 && keptMusic.beds[0]!.assetId === "warm");

// ---- generated cutaways: a still stands in, a video is pending ----
const generatedStill: MediaAsset = { id: "gen-still", kind: "image", source: "ai", label: "✦ neon city", width: 768, height: 1376 };
const generated = await resolveDirectorMedia({
  cutaways: [
    { generate: { kind: "video", prompt: "a neon city at night, slow push" }, start: 5, end: 7 },
    { generate: { kind: "image", prompt: "a rocket on the pad" }, start: 8, end: 9 },
    { generate: { prompt: "x" } },
    { generate: { prompt: "y" } },
  ],
  library,
  generate: async (prompt, kind) => ({ asset: { ...generatedStill, id: `gen-${prompt.split(" ")[1] ?? "x"}` }, pendingVideo: kind === "video" }),
});
check(
  "generation: each request becomes a still, a video is marked pending, the pass is capped",
  generated.cutaways[0]!.asset === "gen-neon" && generated.cutaways[1]!.asset === "gen-rocket" && generated.pending.length === 1 && generated.pending[0]!.assetId === "gen-neon" &&
    generated.assets.length === 3 && generated.warnings.some((warning) => warning.includes("Only 3 pictures")),
  JSON.stringify({ c: generated.cutaways.map((c) => c.asset), p: generated.pending, w: generated.warnings })
);
const noGeneration = await resolveDirectorMedia({ cutaways: [{ generate: { kind: "image", prompt: "server room racks, blue light" } }], library });
check("a generate request without generation falls back to the library by its words", noGeneration.cutaways[0]!.asset === library[0]!.id);

const generatedMusic = await resolveDirectorMusic({
  music: [{ generate: { prompt: "lo-fi bed" }, level: 0.2 }, { generate: { prompt: "second" } }, { asset: "warm" }],
  musicIds: new Set(["warm"]),
  generate: async (prompt) => ({ id: `custom:${prompt}`, kind: "music", label: prompt, durationSec: 30 }),
});
check(
  "a generated bed becomes a track; only one per pass; catalogue beds pass through",
  generatedMusic.music.length === 2 && generatedMusic.music[0]!.asset === "custom:lo-fi bed" && generatedMusic.music[1]!.asset === "warm" && generatedMusic.warnings.length === 1
);

console.log("\nall director checks passed");
