import type { BehindTitle, TextEnter, TextExit, TextMotion } from "@/api";

// ============================================
// TEXT MOTION — how a Text beat moves, one schedule for the burn and the preview.
//
// Every animation is a list of keyframes joined by straight lines, on the
// title's own clock (0 = its start), with every keyframe time on a 10 ms grid.
// Straight lines are exactly what ASS can draw (`\t` without an accel, `\move`
// and alpha transforms are linear), so the renderer writes one event per
// span between keyframes and the curve it draws is the curve the preview
// evaluates here — no easing function approximated two different ways.
// An ease is spelled out as a few keyframes instead.
//
// A verbatim port of server/src/services/text-motion.ts; the parity script
// checks the two agree.
// ============================================

/** A pose relative to the text's resting place. */
export interface TextPose {
  /** 0..1 */
  alpha: number;
  /** Multiplier about the text's centre. */
  scale: number;
  /** Offsets in output pixels (1080×1920 space). */
  dx: number;
  dy: number;
  /** Degrees, clockwise, added to the text's own rotation. */
  rotation: number;
}

interface Key {
  /** 0..1 through the phase. */
  u: number;
  alpha?: number;
  scale?: number;
  dx?: number;
  dy?: number;
  rotation?: number;
}

const NEUTRAL: TextPose = { alpha: 1, scale: 1, dx: 0, dy: 0, rotation: 0 };

/** How far slides travel, output pixels. */
export const SLIDE_PX = 280;

/** Keyframes of each entrance, ending at rest. Missing fields hold their last value. */
const ENTER_KEYS: Record<Exclude<TextEnter, "words">, Key[]> = {
  none: [{ u: 0 }, { u: 1 }],
  fade: [
    { u: 0, alpha: 0 },
    { u: 1, alpha: 1 },
  ],
  pop: [
    { u: 0, alpha: 0, scale: 0.6 },
    { u: 0.2, alpha: 1, scale: 0.86 },
    { u: 0.6, alpha: 1, scale: 1.08 },
    { u: 1, alpha: 1, scale: 1 },
  ],
  rise: [
    { u: 0, alpha: 0, dy: 80 },
    { u: 0.3, alpha: 1, dy: 36 },
    { u: 0.65, alpha: 1, dy: 10 },
    { u: 1, alpha: 1, dy: 0 },
  ],
  zoom_in: [
    { u: 0, alpha: 0, scale: 0.3 },
    { u: 0.35, alpha: 1, scale: 0.8 },
    { u: 0.7, alpha: 1, scale: 0.96 },
    { u: 1, alpha: 1, scale: 1 },
  ],
  zoom_out: [
    { u: 0, alpha: 0, scale: 2.2 },
    { u: 0.35, alpha: 1, scale: 1.35 },
    { u: 0.7, alpha: 1, scale: 1.06 },
    { u: 1, alpha: 1, scale: 1 },
  ],
  slide_left: [
    { u: 0, alpha: 0, dx: SLIDE_PX },
    { u: 0.35, alpha: 1, dx: SLIDE_PX * 0.4 },
    { u: 0.7, alpha: 1, dx: SLIDE_PX * 0.09 },
    { u: 1, alpha: 1, dx: 0 },
  ],
  slide_right: [
    { u: 0, alpha: 0, dx: -SLIDE_PX },
    { u: 0.35, alpha: 1, dx: -SLIDE_PX * 0.4 },
    { u: 0.7, alpha: 1, dx: -SLIDE_PX * 0.09 },
    { u: 1, alpha: 1, dx: 0 },
  ],
  slide_up: [
    { u: 0, alpha: 0, dy: SLIDE_PX },
    { u: 0.35, alpha: 1, dy: SLIDE_PX * 0.4 },
    { u: 0.7, alpha: 1, dy: SLIDE_PX * 0.09 },
    { u: 1, alpha: 1, dy: 0 },
  ],
  slide_down: [
    { u: 0, alpha: 0, dy: -SLIDE_PX },
    { u: 0.35, alpha: 1, dy: -SLIDE_PX * 0.4 },
    { u: 0.7, alpha: 1, dy: -SLIDE_PX * 0.09 },
    { u: 1, alpha: 1, dy: 0 },
  ],
  drop: [
    { u: 0, alpha: 0, dy: -220 },
    { u: 0.25, alpha: 1, dy: -80 },
    { u: 0.5, alpha: 1, dy: 0 },
    { u: 0.72, alpha: 1, dy: -26 },
    { u: 1, alpha: 1, dy: 0 },
  ],
};

/** Keyframes of each exit, starting at rest. */
const EXIT_KEYS: Record<TextExit, Key[]> = {
  none: [{ u: 0 }, { u: 1 }],
  fade: [
    { u: 0, alpha: 1 },
    { u: 1, alpha: 0 },
  ],
  pop: [
    { u: 0, alpha: 1, scale: 1 },
    { u: 0.35, alpha: 1, scale: 1.08 },
    { u: 1, alpha: 0, scale: 0.5 },
  ],
  zoom_in: [
    { u: 0, alpha: 1, scale: 1 },
    { u: 0.4, alpha: 0.85, scale: 1.25 },
    { u: 1, alpha: 0, scale: 1.9 },
  ],
  zoom_out: [
    { u: 0, alpha: 1, scale: 1 },
    { u: 0.4, alpha: 0.85, scale: 0.8 },
    { u: 1, alpha: 0, scale: 0.3 },
  ],
  slide_left: [
    { u: 0, alpha: 1, dx: 0 },
    { u: 0.3, alpha: 1, dx: -SLIDE_PX * 0.09 },
    { u: 0.65, alpha: 1, dx: -SLIDE_PX * 0.4 },
    { u: 1, alpha: 0, dx: -SLIDE_PX },
  ],
  slide_right: [
    { u: 0, alpha: 1, dx: 0 },
    { u: 0.3, alpha: 1, dx: SLIDE_PX * 0.09 },
    { u: 0.65, alpha: 1, dx: SLIDE_PX * 0.4 },
    { u: 1, alpha: 0, dx: SLIDE_PX },
  ],
  slide_up: [
    { u: 0, alpha: 1, dy: 0 },
    { u: 0.3, alpha: 1, dy: -SLIDE_PX * 0.09 },
    { u: 0.65, alpha: 1, dy: -SLIDE_PX * 0.4 },
    { u: 1, alpha: 0, dy: -SLIDE_PX },
  ],
  slide_down: [
    { u: 0, alpha: 1, dy: 0 },
    { u: 0.3, alpha: 1, dy: SLIDE_PX * 0.09 },
    { u: 0.65, alpha: 1, dy: SLIDE_PX * 0.4 },
    { u: 1, alpha: 0, dy: SLIDE_PX },
  ],
  sink: [
    { u: 0, alpha: 1, dy: 0 },
    { u: 1, alpha: 0, dy: 90 },
  ],
};

/** Default lengths, seconds. */
export const ENTER_SEC: Record<TextEnter, number> = {
  none: 0,
  fade: 0.25,
  pop: 0.28,
  rise: 0.32,
  zoom_in: 0.35,
  zoom_out: 0.35,
  slide_left: 0.35,
  slide_right: 0.35,
  slide_up: 0.35,
  slide_down: 0.35,
  drop: 0.45,
  words: 0.6,
};

export const EXIT_SEC: Record<TextExit, number> = {
  none: 0,
  fade: 0.2,
  pop: 0.22,
  zoom_in: 0.3,
  zoom_out: 0.3,
  slide_left: 0.3,
  slide_right: 0.3,
  slide_up: 0.3,
  slide_down: 0.3,
  sink: 0.25,
};

/** A word revealed by "words" fades up over this long. */
export const WORD_FADE_SEC = 0.12;

/** Motions while on screen: amplitude and the half-period between keyframes. */
const MOTION: Record<Exclude<TextMotion, "none">, { half: number }> = {
  grow: { half: 0 },
  shrink: { half: 0 },
  pulse: { half: 0.45 },
  wiggle: { half: 0.25 },
  float: { half: 0.8 },
};
/** A hold never carries more keyframes than this; a long one widens its period. */
const MAX_MOTION_KEYS = 60;

export const TEXT_ENTERS: TextEnter[] = [
  "none",
  "pop",
  "fade",
  "rise",
  "zoom_in",
  "zoom_out",
  "slide_left",
  "slide_right",
  "slide_up",
  "slide_down",
  "drop",
  "words",
];
export const TEXT_EXITS: TextExit[] = ["none", "fade", "pop", "zoom_in", "zoom_out", "slide_left", "slide_right", "slide_up", "slide_down", "sink"];
export const TEXT_MOTIONS: TextMotion[] = ["none", "grow", "shrink", "pulse", "wiggle", "float"];

/** Round to the ASS clock (centiseconds). */
export function cs(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** The exit a title uses: its own, or for a title saved before exits existed, the fade its entrance implied. */
export function exitOf(title: Pick<BehindTitle, "animation" | "exit">): TextExit {
  if (title.exit) return title.exit;
  return title.animation === "none" ? "none" : "fade";
}

/** Legacy exit lengths (the old `\fad` out-times), so an old title keeps its timing. */
function legacyExitSec(title: Pick<BehindTitle, "animation">): number {
  return title.animation === "pop" ? 0.11 : title.animation === "fade" ? 0.16 : title.animation === "rise" ? 0.12 : EXIT_SEC.fade;
}

export interface TextSchedule {
  duration: number;
  enter: TextEnter;
  exit: TextExit;
  motion: TextMotion;
  /** Phase boundaries on the title's clock, centiseconds-exact. */
  enterEnd: number;
  exitStart: number;
  /** Word count, for "words". */
  words: number;
  /** When each word starts to appear, for "words". */
  wordStarts: number[];
  /** How long each word takes to fade up. */
  wordFade: number;
  /** Keyframes of the whole life, in order: time and pose. */
  keys: { t: number; pose: TextPose }[];
  /** Every time a straight segment begins or ends — the renderer's event boundaries. */
  breaks: number[];
}

/** Evaluate a phase's keyframe list at u (0..1), linear between keys. */
function keyPose(keys: Key[], u: number): TextPose {
  const fields: (keyof TextPose)[] = ["alpha", "scale", "dx", "dy", "rotation"];
  const out = { ...NEUTRAL };
  for (const field of fields) {
    const known = keys.filter((key) => key[field] !== undefined);
    if (known.length === 0) continue;
    if (u <= known[0]!.u) {
      out[field] = known[0]![field]!;
      continue;
    }
    let value = known[known.length - 1]![field]!;
    for (let i = 0; i < known.length - 1; i++) {
      const a = known[i]!;
      const b = known[i + 1]!;
      if (u >= a.u && u <= b.u) {
        value = lerp(a[field]!, b[field]!, b.u === a.u ? 1 : (u - a.u) / (b.u - a.u));
        break;
      }
    }
    out[field] = value;
  }
  return out;
}

/** The motion's contribution at `h` seconds into a hold of `length`: scale, dy and rotation. */
function motionAt(motion: TextMotion, h: number, length: number, half: number): Pick<TextPose, "scale" | "dy" | "rotation"> {
  const tri = (period: number) => {
    // 0 → 1 → 0 → -1 → 0 over one period, linear between quarter points.
    const q = period / 4;
    const x = ((h % period) + period) % period;
    if (x < q) return x / q;
    if (x < 2 * q) return 1 - (x - q) / q;
    if (x < 3 * q) return -(x - 2 * q) / q;
    return -1 + (x - 3 * q) / q;
  };
  switch (motion) {
    case "grow":
      return { scale: 1 + 0.12 * (length > 0 ? h / length : 0), dy: 0, rotation: 0 };
    case "shrink":
      return { scale: 1 - 0.1 * (length > 0 ? h / length : 0), dy: 0, rotation: 0 };
    case "pulse":
      return { scale: 1 + 0.07 * Math.abs(tri(half * 4)), dy: 0, rotation: 0 };
    case "wiggle":
      return { scale: 1, dy: 0, rotation: 3 * tri(half * 4) };
    case "float":
      return { scale: 1, dy: -14 * Math.abs(tri(half * 4)), rotation: 0 };
    default:
      return { scale: 1, dy: 0, rotation: 0 };
  }
}

/**
 * The schedule of one title: phase lengths clamped to its duration, every
 * keyframe on the 10 ms grid, and the pose at each keyframe. Between two
 * keyframes every value is a straight line — see `textPoseAt`.
 */
export function textSchedule(title: Pick<BehindTitle, "startSec" | "endSec" | "animation" | "exit" | "enterSec" | "exitSec" | "motion" | "text">): TextSchedule {
  const duration = cs(Math.max(0.02, title.endSec - title.startSec));
  const enter: TextEnter = title.animation;
  const exit = exitOf(title);
  const motion: TextMotion = title.motion ?? "none";
  // Lengths: the title's own, else the kind's default; entrance and exit
  // together never take more than 90% of the title.
  let enterLen = enter === "none" ? 0 : Math.max(0.05, title.enterSec ?? ENTER_SEC[enter]);
  let exitLen = exit === "none" ? 0 : Math.max(0.05, title.exitSec ?? (title.exit ? EXIT_SEC[exit] : legacyExitSec(title)));
  const budget = duration * 0.9;
  if (enterLen + exitLen > budget) {
    const k = budget / (enterLen + exitLen);
    enterLen *= k;
    exitLen *= k;
  }
  const enterEnd = cs(enterLen);
  const exitStart = cs(Math.max(enterEnd, duration - exitLen));

  const words = Math.max(1, (title.text ?? "").split(/\s+/).filter(Boolean).length);
  const wordStarts: number[] = [];
  const wordFade = Math.min(WORD_FADE_SEC, enterEnd);
  if (enter === "words") {
    // Spread so the last word is fully in exactly when the entrance ends: a
    // word's fade never overlaps the exit's, so every alpha stays a straight line.
    for (let i = 0; i < words; i++) wordStarts.push(cs(words === 1 ? 0 : ((enterEnd - wordFade) * i) / (words - 1)));
  }

  const keys: { t: number; pose: TextPose }[] = [];
  const push = (t: number, pose: TextPose) => {
    const time = cs(Math.max(0, Math.min(duration, t)));
    const last = keys[keys.length - 1];
    if (last && Math.abs(last.t - time) < 0.005) last.pose = pose;
    else keys.push({ t: time, pose });
  };

  // Entrance (the "words" reveal is per word; the line itself rests).
  if (enter !== "words" && enter !== "none" && enterEnd > 0) {
    for (const key of ENTER_KEYS[enter]) push(key.u * enterEnd, keyPose(ENTER_KEYS[enter], key.u));
  } else {
    push(0, NEUTRAL);
  }
  push(enterEnd, NEUTRAL);

  // Hold, with its motion.
  const holdLength = Math.max(0, exitStart - enterEnd);
  let motionEnd = NEUTRAL;
  if (motion !== "none" && holdLength > 0) {
    let half = MOTION[motion].half;
    const steps: number[] = [];
    if (half === 0) {
      steps.push(holdLength);
    } else {
      // Quarter-period keyframes: a triangle wave is straight between them.
      half = Math.max(half, holdLength / MAX_MOTION_KEYS * 2);
      const quarter = half / 2;
      for (let h = quarter; h < holdLength - 0.005; h += quarter) steps.push(h);
      steps.push(holdLength);
    }
    for (const h of steps) {
      const m = motionAt(motion, h, holdLength, half);
      push(enterEnd + h, { alpha: 1, scale: m.scale, dx: 0, dy: m.dy, rotation: m.rotation });
    }
    // The pose the exit starts from: whatever the motion was doing at its end,
    // evaluated on the keyframe grid so the exit joins without a jump.
    motionEnd = keys[keys.length - 1]!.pose;
  }
  push(exitStart, motionEnd);

  // Exit, on top of where the motion left the text.
  if (exit !== "none" && duration > exitStart) {
    for (const key of EXIT_KEYS[exit]) {
      const pose = keyPose(EXIT_KEYS[exit], key.u);
      push(exitStart + key.u * (duration - exitStart), {
        alpha: pose.alpha * motionEnd.alpha,
        scale: pose.scale * motionEnd.scale,
        dx: pose.dx + motionEnd.dx,
        dy: pose.dy + motionEnd.dy,
        rotation: pose.rotation + motionEnd.rotation,
      });
    }
  }
  push(duration, keys[keys.length - 1]!.pose);

  const breaks = [...new Set([...keys.map((key) => key.t), ...wordStarts, ...wordStarts.map((t) => cs(Math.min(enterEnd, t + wordFade)))])]
    .filter((t) => t >= 0 && t <= duration)
    .sort((a, b) => a - b);
  return { duration, enter, exit, motion, enterEnd, exitStart, words, wordStarts, wordFade, keys, breaks };
}

/** The pose at `t` seconds into the title (clamped to its life), linear between keyframes. */
export function textPoseAt(schedule: TextSchedule, t: number): TextPose {
  const time = Math.max(0, Math.min(schedule.duration, t));
  const keys = schedule.keys;
  if (time <= keys[0]!.t) return keys[0]!.pose;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (time >= a.t && time <= b.t) {
      const u = b.t - a.t <= 0 ? 1 : (time - a.t) / (b.t - a.t);
      return {
        alpha: lerp(a.pose.alpha, b.pose.alpha, u),
        scale: lerp(a.pose.scale, b.pose.scale, u),
        dx: lerp(a.pose.dx, b.pose.dx, u),
        dy: lerp(a.pose.dy, b.pose.dy, u),
        rotation: lerp(a.pose.rotation, b.pose.rotation, u),
      };
    }
  }
  return keys[keys.length - 1]!.pose;
}

/** For "words": how visible word `index` is at `t` (0..1); 1 for every other entrance. */
export function wordAlphaAt(schedule: TextSchedule, index: number, t: number): number {
  if (schedule.enter !== "words") return 1;
  const start = schedule.wordStarts[index] ?? 0;
  const end = cs(Math.min(schedule.enterEnd, start + schedule.wordFade));
  if (t <= start) return 0;
  if (t >= end || end <= start) return 1;
  return (t - start) / (end - start);
}
