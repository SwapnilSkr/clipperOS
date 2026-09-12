/**
 * Synthetic verification of the speaker-tracking decision logic.
 *
 * Runs with no Python installed: the analyser only reports faces, and every
 * judgement (seats, cuts, hysteresis, keyframes) is pure TypeScript, so it can be
 * exercised against hand-built observations. This is the fast check to run after
 * touching any of that logic — the real analyser is only needed to produce the
 * observations, not to reason about them.
 *
 *   bun run reframe:validate
 */
import { buildTrack, alignCutTimes, holdCropUntilCuts, type AnalyzerFrame, type FaceObservation } from "../src/services/speaker-reframe.service";
import { collapseHoldKeyframes, coalesceKeyframes, cropChainForTrack, shiftTrackToWindow, stitchReframeTracks, windowSegments } from "../src/services/clip-render.service";
import type { ReframeTrack } from "../src/types/clip.types";

const FPS = 12;
const W = 640; // analysis width
const H = 360;
const SOURCE_W = 1920; // => analysisScale 3
const SOURCE_H = 1080;

const SEAT_A = 200; // analysis x
const SEAT_B = 440;

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function face(x: number, mouthEnergy: number): FaceObservation {
  return { trackId: x, x: x - 30, y: 80, w: 60, h: 70, mouthEnergy };
}

/** Per-seat mouth energy: a constant, or a function of the frame index. */
type Energy = number | ((i: number) => number);

/** Frames over `seconds`, with `cut` on the first frame of each new shot. */
function shot(
  from: number,
  to: number,
  spec: { a: Energy; b: Energy },
  cutAtStart = false
): AnalyzerFrame[] {
  const out: AnalyzerFrame[] = [];
  const value = (e: Energy, i: number) => (typeof e === "function" ? e(i) : e);
  for (let i = from; i < to; i++) {
    const faces: FaceObservation[] = [];
    const a = value(spec.a, i);
    const b = value(spec.b, i);
    if (a > 0) faces.push(face(SEAT_A, a));
    if (b > 0) faces.push(face(SEAT_B, b));
    out.push({ i, cut: cutAtStart && i === from, faces });
  }
  return out;
}

const flatRms = (n: number) => new Array<number>(n).fill(0.5);

/**
 * A syllabic speech envelope: bursts of ~0.33s with ~0.33s gaps. A FLAT envelope
 * would make the audio correlation term zero for everyone, which starves the
 * dual-active test of the signal it is supposed to detect.
 */
const speechRms = (n: number) => Array.from({ length: n }, (_, i) => (i % 8 < 4 ? 1 : 0));

function build(frames: AnalyzerFrame[], rms?: number[]): ReframeTrack {
  return buildTrack({
    frames,
    rms: rms ?? flatRms(frames.length),
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    analysisScale: SOURCE_W / W,
  }).track;
}

/** Largest single-step crop move — what separates a cut from a glide. */
function maxStep(track: ReframeTrack): number {
  let max = 0;
  for (let i = 1; i < track.keyframes.length; i++) {
    max = Math.max(max, Math.abs(track.keyframes[i]!.cx - track.keyframes[i - 1]!.cx));
  }
  return max;
}

// ---------------------------------------------------------------------------
// 1. A cut between two speakers must produce a JUMP, not a glide.
// ---------------------------------------------------------------------------
{
  const frames = [...shot(0, 36, { a: 1.0, b: 0.05 }), ...shot(36, 72, { a: 0.05, b: 1.0 }, true)];
  const track = build(frames);

  check("cut: mode is crop", track.mode === "crop", track.mode);
  check("cut: one discontinuous crop move", maxStep(track) > 500, `${maxStep(track)}px in one step`);
  let bigSteps = 0;
  for (let i = 1; i < track.keyframes.length; i++) {
    if (Math.abs(track.keyframes[i]!.cx - track.keyframes[i - 1]!.cx) > 400) bigSteps++;
  }
  check("cut: a single hard cut", bigSteps === 1, `${bigSteps} big steps`);
  let beforeCx = track.keyframes[0]!.cx;
  let afterCx = beforeCx;
  for (let i = 1; i < track.keyframes.length; i++) {
    if (Math.abs(track.keyframes[i]!.cx - track.keyframes[i - 1]!.cx) > 400) {
      beforeCx = track.keyframes[i - 1]!.cx;
      afterCx = track.keyframes[i]!.cx;
    }
  }
  check(
    "cut: crop actually moves to the other seat",
    Math.abs(afterCx - beforeCx) > 400,
    `cx ${beforeCx} -> ${afterCx} (seats are ~720 source px apart)`
  );

  const segments = windowSegments({ startSec: 100, endSec: 106, mode: "smart" }, track);
  check("cut: the window stays one piece (source cut is not a splice)", segments.length === 1, `${segments.length}`);
  check("cut: that piece covers the whole window", Math.abs(segments[0]!.endSec - segments[0]!.startSec - 6) < 0.01);
  const chain = cropChainForTrack(track);
  check("cut: crop expression snaps instead of splicing", chain.includes("if(lt(t"), chain.slice(0, 80));
}

// ---------------------------------------------------------------------------
// 2. A handover INSIDE one shot must glide (no discontinuous move).
// ---------------------------------------------------------------------------
{
  const frames = [...shot(0, 36, { a: 1.0, b: 0.05 }), ...shot(36, 72, { a: 0.05, b: 1.0 }, false)];
  const track = build(frames);
  // A glide CAN emit keyframes one frame apart — the EMA moves >10px per frame
  // while closing a large gap — so the discriminator is the step SIZE, not the
  // time between keyframes.
  const step = maxStep(track);
  check("handover: no discontinuous jump", step < 250, `largest step ${step}px`);
  check("handover: several small steps, i.e. a glide", track.keyframes.length >= 4, `${track.keyframes.length} keyframes`);
  check(
    "handover: render expression interpolates rather than snapping",
    cropChainForTrack(track).includes("+(t-"),
    cropChainForTrack(track).slice(0, 120)
  );
  const first = track.keyframes[0]!.cx;
  const last = track.keyframes[track.keyframes.length - 1]!.cx;
  check("handover: crop ends up on the new speaker", last - first > 400, `cx ${first} -> ${last}`);
}

// ---------------------------------------------------------------------------
// 3. Both talking throughout -> stay on a speaker, never the gap between seats.
// ---------------------------------------------------------------------------
{
  const syllabic: Energy = (i) => (i % 8 < 4 ? 1 : 0);
  const frames = shot(0, 72, { a: syllabic, b: syllabic });
  const track = build(frames, speechRms(frames.length));
  check("cross-talk: stays in crop (never letterbox the gap)", track.mode === "crop", track.mode);
  const cx = track.keyframes[0]!.cx;
  const seatA = SEAT_A * (SOURCE_W / W);
  const seatB = SEAT_B * (SOURCE_W / W);
  check(
    "cross-talk: crop is on a speaker, not the midpoint",
    Math.abs(cx - seatA) < 150 || Math.abs(cx - seatB) < 150,
    `cx ${cx} vs seats ${seatA.toFixed(0)}/${seatB.toFixed(0)}`
  );
  check(
    "cross-talk: crop is not the frame centre",
    Math.abs(cx - SOURCE_W / 2) > 200,
    `cx ${cx}`
  );
}

// ---------------------------------------------------------------------------
// 4. No faces (a screen recording) -> static centre crop.
// ---------------------------------------------------------------------------
{
  const track = build(shot(0, 72, { a: 0, b: 0 }));
  check("no faces: provider is centre", track.provider === "center", track.provider);
  check("no faces: mode is centre", track.mode === "center", track.mode);
  check(
    "no faces: cx is the frame centre",
    track.keyframes[0]!.cx === SOURCE_W / 2,
    String(track.keyframes[0]!.cx)
  );
}

// ---------------------------------------------------------------------------
// 5. A single seated speaker: confident, and framed on them.
// ---------------------------------------------------------------------------
{
  const track = build(shot(0, 72, { a: 1.0, b: 0 }));
  check("single speaker: confident enough to skip escalation", track.confidence > 0.4, track.confidence.toFixed(2));
  check("single speaker: provider is faces", track.provider === "faces", track.provider);
  check(
    "single speaker: crop centres on the only seat",
    Math.abs(track.keyframes[0]!.cx - SEAT_A * (SOURCE_W / W)) < 120,
    `cx ${track.keyframes[0]!.cx} vs seat ${SEAT_A * (SOURCE_W / W)}`
  );
  const segments = windowSegments({ startSec: 0, endSec: 6, mode: "smart" }, track);
  check("single speaker: one segment (no pointless concat)", segments.length === 1, `${segments.length}`);
}

// ---------------------------------------------------------------------------
// 6. A detector dropout mid-shot must not fall back to the frame centre.
// ---------------------------------------------------------------------------
{
  const frames = [
    ...shot(0, 24, { a: 1.0, b: 0.05 }),
    ...shot(24, 48, { a: 0, b: 0 }),
    ...shot(48, 72, { a: 1.0, b: 0.05 }),
  ];
  const track = build(frames);
  const seatA = SEAT_A * (SOURCE_W / W);
  const mid = track.keyframes.find((k) => k.t >= 24 / FPS && k.t <= 48 / FPS);
  const cx = mid?.cx ?? track.keyframes[Math.floor(track.keyframes.length / 2)]!.cx;
  check(
    "dropout: crop stays on the speaker through missing faces",
    Math.abs(cx - seatA) < 180,
    `cx ${cx} vs seat ${seatA}`
  );
  check("dropout: still a crop, not a centre fallback", track.mode === "crop", track.mode);
}

// ---------------------------------------------------------------------------
// 7. Close-up of A, cut to a two-shot where A is still talking: stay on A.
//    Never pan through the midpoint / the other chair.
// ---------------------------------------------------------------------------
{
  const frames = [
    ...shot(0, 36, { a: 1.0, b: 0 }),
    ...shot(36, 72, { a: 1.0, b: 0.08 }, true),
  ];
  const track = build(frames);
  const seatA = SEAT_A * (SOURCE_W / W);
  const after = track.keyframes.filter((k) => k.t >= 36 / FPS - 0.05);
  const last = after[after.length - 1] ?? track.keyframes[track.keyframes.length - 1]!;
  check(
    "cu→two-shot: stays on the same speaker",
    Math.abs(last.cx - seatA) < 150,
    `cx ${last.cx} vs seat ${seatA}`
  );
  check(
    "cu→two-shot: never the gap between chairs",
    after.every((k) => Math.abs(k.cx - SOURCE_W / 2) > 200),
    after.map((k) => k.cx).join(",")
  );
  check(
    "cu→two-shot: no discontinuous reframe",
    maxStep(track) < 250,
    `${maxStep(track)}px`
  );
  const cuSegments = windowSegments({ startSec: 0, endSec: 6, mode: "smart" }, track);
  check(
    "cu→two-shot: plays through as one piece",
    cuSegments.length === 1,
    `${cuSegments.length} segments`
  );
}

// ---------------------------------------------------------------------------
// 8. Coalescing must never collapse a cut.
// ---------------------------------------------------------------------------
{
  const keyframes = [];
  for (let i = 0; i < 400; i++) keyframes.push({ t: i / FPS, cx: 300 + i, cy: 540, width: 607 });
  // Insert a discontinuity: one step of ~600px, far beyond the EMA's per-frame move.
  const cutIndex = 120;
  const beforeCut = { t: (cutIndex - 1) / FPS, cx: 999, cy: 540, width: 607 };
  const afterCut = { t: cutIndex / FPS, cx: 1600, cy: 540, width: 607 };
  keyframes.splice(cutIndex, 1, beforeCut, afterCut);

  const coalesced = coalesceKeyframes(keyframes, 60);
  check("coalesce: caps the count", coalesced.length <= 62, `${coalesced.length} of ${keyframes.length}`);
  check(
    "coalesce: keeps both sides of the cut",
    coalesced.some((k) => k.t === beforeCut.t) && coalesced.some((k) => k.t === afterCut.t),
    `${coalesced.filter((k) => Math.abs(k.cx - 999) < 1 || Math.abs(k.cx - 1600) < 1).length} cut keyframes kept`
  );
}

// ---------------------------------------------------------------------------
// 9. The 1-frame hold before a snap must not become its own concat piece.
// ---------------------------------------------------------------------------
{
  const track: ReframeTrack = {
    mode: "crop",
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    confidence: 1,
    provider: "faces",
    keyframes: [
      { t: 0, cx: 400, cy: 540, width: 608 },
      { t: 2.0, cx: 410, cy: 540, width: 608 },
      { t: 2.917, cx: 410, cy: 540, width: 608 },
      { t: 3.0, cx: 1400, cy: 540, width: 608 },
      { t: 5.0, cx: 1410, cy: 540, width: 608 },
    ],
  };
  const collapsed = collapseHoldKeyframes(track.keyframes);
  check(
    "hold: duplicate crop before a snap is dropped",
    collapsed.length === 4 && collapsed[2]!.t === 3,
    collapsed.map((k) => `${k.t}:${k.cx}`).join(" ")
  );
  const segs = windowSegments({ startSec: 0, endSec: 6, mode: "smart" }, track);
  check("hold: still one continuous window", segs.length === 1, `${segs.length}`);
  check("hold: crop expression keeps the snap", cropChainForTrack(track).includes("if(lt(t"));
}

// ---------------------------------------------------------------------------
// 10. A 12fps cut bin must snap on the real first frame of the new shot.
// ---------------------------------------------------------------------------
{
  const aligned = alignCutTimes([3.1667, 23.25, 29.5833], [3.1279, 23.248, 29.5543]);
  check("align: first cut is the native frame, not the late bin", Math.abs(aligned[0]! - 3.1279) < 0.002, `${aligned[0]}`);
  check("align: later cuts stay on the native frame", Math.abs(aligned[2]! - 29.5543) < 0.002, `${aligned[2]}`);

  const frames = [...shot(0, 36, { a: 1.0, b: 0.05 }), ...shot(36, 72, { a: 0.05, b: 1.0 }, true)];
  const sceneT = 36 / FPS - 0.04;
  const track = buildTrack({
    frames,
    rms: flatRms(frames.length),
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    analysisScale: SOURCE_W / W,
    sceneCuts: [sceneT],
  }).track;
  const snap = track.keyframes.find((k, i) => i > 0 && Math.abs(k.cx - track.keyframes[i - 1]!.cx) > 400);
  check(
    "align: crop changes on the first frame of the new shot",
    !!snap && Math.abs(snap.t - sceneT) < 0.002,
    snap ? `t=${snap.t} scene=${sceneT}` : "no snap"
  );
}

// ---------------------------------------------------------------------------
// 11. Saving a tighter trim must not move the snap on the source clock.
// ---------------------------------------------------------------------------
{
  const track: ReframeTrack = {
    mode: "crop",
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    confidence: 1,
    provider: "faces",
    originSec: 100,
    untilSec: 140,
    cuts: [3.0945],
    keyframes: [
      { t: 0, cx: 1562, cy: 540, width: 608 },
      { t: 3.0945, cx: 1108, cy: 540, width: 608 },
    ],
  };
  const shifted = shiftTrackToWindow(track, 101);
  const snap = shifted.keyframes[1]!;
  check("trim: snap stays on the same source frame", Math.abs(snap.t - 2.0945) < 0.0001, `t=${snap.t}`);
  const chain = cropChainForTrack(track, 101);
  check("trim: encode expression trips 1ms before the rounded snap", chain.includes("2.0935"), chain.slice(0, 120));
}

{
  const track: ReframeTrack = {
    mode: "crop",
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    confidence: 1,
    provider: "faces",
    originSec: 1055.83,
    untilSec: 1196.1,
    cuts: [41.4996],
    keyframes: [
      { t: 29.5543, cx: 1090, cy: 540, width: 608 },
      { t: 41.4996, cx: 1562, cy: 540, width: 608 },
    ],
  };
  const chain = cropChainForTrack(track, 1057.13);
  check(
    "cut: 18:17 snap is 1ms early of 40.1996 so the first two-shot frame is not cropped as a CU",
    chain.includes("40.1986"),
    chain.slice(0, 140)
  );
}

// ---------------------------------------------------------------------------
// 12. A glide in the 12fps bin before a camera cut must not reach the encoder.
// ---------------------------------------------------------------------------
{
  const dirty: ReframeTrack = {
    mode: "crop",
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    confidence: 1,
    provider: "faces",
    originSec: 1055.83,
    untilSec: 1187.5,
    cuts: [85.7438],
    keyframes: [
      { t: 85.4167, cx: 1565, cy: 540, width: 608 },
      { t: 85.6667, cx: 1289, cy: 540, width: 608 },
      { t: 85.7438, cx: 1104, cy: 540, width: 608 },
    ],
  };
  const cleaned = holdCropUntilCuts(dirty);
  check(
    "cut: pre-roll glide toward the next shot is dropped",
    !cleaned.keyframes.some((keyframe) => Math.abs(keyframe.t - 85.6667) < 0.001),
    cleaned.keyframes.map((k) => k.t).join(",")
  );
  check(
    "cut: snap itself is kept",
    cleaned.keyframes.some((keyframe) => Math.abs(keyframe.t - 85.7438) < 0.001 && Math.abs(keyframe.cx - 1104) < 1)
  );
}

{
  const frames = [...shot(0, 36, { a: 1.0, b: 0.05 }), ...shot(36, 72, { a: 0.05, b: 1.0 })];
  const sceneT = 3.0;
  const track = buildTrack({
    frames,
    rms: flatRms(frames.length),
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    analysisScale: SOURCE_W / W,
    sceneCuts: [sceneT],
  }).track;
  const snap = track.keyframes.find((k, i) => i > 0 && Math.abs(k.cx - track.keyframes[i - 1]!.cx) > 400);
  check(
    "cut: a native scene cut still snaps when 12fps luma misses it",
    !!snap && Math.abs(snap.t - sceneT) < 0.02,
    snap ? `t=${snap.t}` : "no snap"
  );
}

// ---------------------------------------------------------------------------
// 13. Extending the out-point stitches a tail; it does not move earlier snaps.
// ---------------------------------------------------------------------------
{
  const head: ReframeTrack = {
    mode: "crop",
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    confidence: 1,
    provider: "faces",
    originSec: 100,
    untilSec: 140,
    cuts: [3.0945],
    keyframes: [
      { t: 0, cx: 1562, cy: 540, width: 608 },
      { t: 3.0945, cx: 1108, cy: 540, width: 608 },
    ],
  };
  const tail: ReframeTrack = {
    mode: "crop",
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    confidence: 1,
    provider: "faces",
    originSec: 139,
    untilSec: 155,
    cuts: [4.2],
    keyframes: [
      { t: 0, cx: 1108, cy: 540, width: 608 },
      { t: 4.2, cx: 1562, cy: 540, width: 608 },
    ],
  };
  const merged = stitchReframeTracks(head, tail);
  check("extend: origin stays on the original analysis", Math.abs((merged.originSec ?? 0) - 100) < 0.001);
  check("extend: until covers the new tail", Math.abs((merged.untilSec ?? 0) - 155) < 0.001);
  check(
    "extend: original snap is untouched",
    merged.keyframes.some((keyframe) => Math.abs(keyframe.t - 3.0945) < 0.0001 && Math.abs(keyframe.cx - 1108) < 1)
  );
  check(
    "extend: new cut is on the original clock",
    (merged.cuts ?? []).some((cut) => Math.abs(cut - 43.2) < 0.001),
    (merged.cuts ?? []).join(",")
  );
}

console.log(failures === 0 ? "\nall tracking-logic checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
