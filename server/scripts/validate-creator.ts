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
  cropBoxAt,
  faceRestY,
  FOLLOW_MIN_ZOOM,
  FOLLOW_SIGMA_SEC,
  followAnchorOfKeyframe,
  followSigma,
  followTightnessX,
  followTightnessY,
  followZoom,
  headTravel,
  moveAmountAt,
  nextKeptTime,
  outputDuration,
  outputToSource,
  smoothedTrack,
  sourceToOutput,
  windowsFor,
} from "../src/services/creator-timeline";
import { pauseCandidates, parseSilenceLog, wordGaps } from "../src/services/pause-detect.service";
import type { CameraMove, ReframeTrack } from "../src/types/clip.types";

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
import { cameraExpressions, cameraFilterChain } from "../src/services/camera.service";
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
];
import type { CreatorPlan } from "../src/types/clip.types";
let worst = 0;
let evaluated = 0;
for (const cameraPlan of plans) {
  for (const window of [
    { startSec: 100, endSec: 104 },
    { startSec: 104.3, endSec: 109 },
  ]) {
    const expressions = cameraExpressions({ plan: cameraPlan, track: richTrack, windowStartSec: window.startSec, windowEndSec: window.endSec });
    for (let local = 0; local < window.endSec - window.startSec; local += 0.037) {
      const sourceSec = window.startSec + local;
      const numeric = cameraStateAt(cameraPlan, richTrack, sourceSec);
      // No expression means "nothing to apply in this window" — identity.
      const zoom = expressions ? evalExpr(expressions.zoom, local) : 1;
      const ax = expressions ? evalExpr(expressions.ax, local) : 0.5;
      const ay = expressions ? evalExpr(expressions.ay, local) : 0.5;
      const error = Math.max(Math.abs(zoom - numeric.zoom), Math.abs(ax - numeric.ax) * (numeric.zoom - 1), Math.abs(ay - numeric.ay) * (numeric.zoom - 1));
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

console.log("\nall director checks passed");
