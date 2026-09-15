/**
 *   bun run scripts/validate-text.ts
 *
 * Text beats: the motion schedule's algebra, then the burn measured against
 * it. Titles are rendered through FFmpeg's `ass` filter onto black at 100 fps
 * (one frame per ASS centisecond), and each sampled frame's ink is measured —
 * centroid, width and total brightness — against what `textPoseAt` says the
 * pose is at that instant: position within a few pixels, scale within a few
 * percent, opacity from brightness. The preview paints the same poses (the
 * client port is checked by client/scripts/validate-creator-parity.ts).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { sanitizeCreatorPlan } from "../src/services/creator-plan.service";
import { renderTitlesAss } from "../src/services/title.service";
import { cs, textPoseAt, textSchedule, wordAlphaAt, type TextPose } from "../src/services/text-motion";
import type { BehindTitle } from "../src/types/clip.types";
import { assVideoFilter } from "../src/utils/ffmpeg-path.utils";

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

const base: BehindTitle = {
  id: "t",
  text: "HELLO THERE",
  startSec: 1,
  endSec: 4,
  x: 0.5,
  y: 0.5,
  sizeScale: 1,
  color: "#ffffff",
  animation: "none",
  depth: "front",
  outline: 0,
};

// ---- the schedule ----
{
  const pop = textSchedule({ ...base, animation: "pop", exit: "slide_left", motion: "pulse" });
  check("every keyframe sits on the 10 ms grid", pop.keys.every((key) => near(key.t * 100, Math.round(key.t * 100), 1e-6)));
  check("keyframes are in order and span the life", pop.keys.every((key, i) => i === 0 || key.t > pop.keys[i - 1]!.t) && pop.keys[0]!.t === 0 && pop.keys.at(-1)!.t === pop.duration);
  check("pop starts clear and small, rests at full size", textPoseAt(pop, 0).alpha === 0 && textPoseAt(pop, 0).scale === 0.6 && textPoseAt(pop, pop.enterEnd).scale === 1);
  check("between keyframes every value is a straight line", (() => {
    for (let i = 0; i < pop.keys.length - 1; i++) {
      const a = pop.keys[i]!;
      const b = pop.keys[i + 1]!;
      const mid = textPoseAt(pop, (a.t + b.t) / 2);
      if (!near(mid.scale, (a.pose.scale + b.pose.scale) / 2, 1e-9) || !near(mid.dx, (a.pose.dx + b.pose.dx) / 2, 1e-9)) return false;
    }
    return true;
  })());
  check("the exit joins wherever the motion left off (no jump)", near(textPoseAt(pop, pop.exitStart - 1e-6).scale, textPoseAt(pop, pop.exitStart).scale, 1e-3));
  check("slide left exits clear, a full slide to the left", textPoseAt(pop, pop.duration).alpha === 0 && textPoseAt(pop, pop.duration).dx < -270);

  const short = textSchedule({ ...base, endSec: 1.3, animation: "zoom_out", exit: "zoom_in", enterSec: 2, exitSec: 2 });
  check("entrance + exit never take more than 90% of a short title", short.exitStart >= short.enterEnd && short.enterEnd + (short.duration - short.exitStart) <= short.duration * 0.9 + 0.011);

  const legacy = textSchedule({ ...base, animation: "fade" });
  check("a title saved before exits keeps its fade out", legacy.exit === "fade" && near(legacy.duration - legacy.exitStart, 0.16, 0.011));

  const words = textSchedule({ ...base, animation: "words", enterSec: 0.8 });
  check(
    "word by word: words arrive in order and are all in when the entrance ends",
    wordAlphaAt(words, 0, 0.05) > 0 && wordAlphaAt(words, 1, 0.05) === 0 && wordAlphaAt(words, 1, words.enterEnd) === 1 && words.breaks.includes(words.wordStarts[1]!)
  );

  const long = textSchedule({ ...base, endSec: 120, animation: "none", motion: "wiggle" });
  check("a long motion is capped in keyframes", long.keys.length <= 70, `${long.keys.length} keys`);
}

// ---- the sanitiser ----
{
  const plan = sanitizeCreatorPlan({
    enabled: true,
    version: 1,
    titles: [{ ...base, animation: "zoom_in", exit: "sink", motion: "float", enterSec: 9, rotation: -80, outline: 1, box: { color: "#FF0000" } }],
  });
  const title = plan.titles![0]!;
  check(
    "text fields are clamped and defaults left absent",
    title.exit === "sink" && title.motion === "float" && title.enterSec === 3 && title.rotation === -45 && title.outline === undefined && title.box?.color === "#ff0000" && title.box.opacity === 0.7
  );
  let threw = false;
  try {
    sanitizeCreatorPlan({ enabled: true, version: 1, titles: [{ ...base, exit: "explode" }] });
  } catch {
    threw = true;
  }
  check("an unknown exit is rejected", threw);
}

// ---- the burn, measured ----
const dir = await mkdtemp(join(tmpdir(), "text-"));
const W = 1080;
const H = 1920;

interface Ink {
  mass: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Ink centroid height of the left and right halves of the frame. */
  leftCy: number;
  rightCy: number;
}

/** Render `ass` over `seconds` of black at 100 fps and measure the ink of the listed frames. */
async function measure(ass: string, seconds: number, frames: number[]): Promise<Map<number, Ink>> {
  const assPath = join(dir, `t-${crypto.randomUUID()}.ass`);
  await writeFile(assPath, ass);
  const select = frames.map((n) => `eq(n\\,${n})`).join("+");
  const proc = Bun.spawnSync(
    [
      config.ffmpegPath, "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=100:d=${seconds}`,
      "-vf", `${assVideoFilter(assPath)},format=gray,select='${select}'`,
      "-fps_mode", "passthrough", "-f", "rawvideo", "-",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr).slice(0, 400));
  const bytes = new Uint8Array(proc.stdout);
  const out = new Map<number, Ink>();
  frames.forEach((n, k) => {
    const frame = bytes.subarray(k * W * H, (k + 1) * W * H);
    let mass = 0;
    let sx = 0;
    let sy = 0;
    let minX = W;
    let maxX = -1;
    let minY = H;
    let maxY = -1;
    let leftMass = 0;
    let leftY = 0;
    let rightMass = 0;
    let rightY = 0;
    for (let y = 0; y < H; y += 2) {
      const row = y * W;
      for (let x = 0; x < W; x += 2) {
        const v = frame[row + x]!;
        if (v < 8) continue;
        mass += v;
        sx += v * x;
        sy += v * y;
        if (v > 60) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        if (x < W / 2) {
          leftMass += v;
          leftY += v * y;
        } else {
          rightMass += v;
          rightY += v * y;
        }
      }
    }
    out.set(n, {
      mass,
      cx: mass ? sx / mass : NaN,
      cy: mass ? sy / mass : NaN,
      width: maxX >= minX ? maxX - minX : 0,
      height: maxY >= minY ? maxY - minY : 0,
      leftCy: leftMass ? leftY / leftMass : NaN,
      rightCy: rightMass ? rightY / rightMass : NaN,
    });
  });
  return out;
}

try {
  const cases: { label: string; title: BehindTitle }[] = [
    { label: "pop in, pulse, slide out left", title: { ...base, animation: "pop", motion: "pulse", exit: "slide_left" } },
    { label: "zoom out in, grow, zoom in out", title: { ...base, animation: "zoom_out", motion: "grow", exit: "zoom_in" } },
    { label: "slide up in, float, sink out", title: { ...base, animation: "slide_up", motion: "float", exit: "sink", sizeScale: 1.4 } },
    { label: "drop in, fade out, off-centre", title: { ...base, animation: "drop", exit: "fade", x: 0.3, y: 0.28 } },
  ];
  for (const { label, title } of cases) {
    const schedule = textSchedule(title);
    const ass = renderTitlesAss([title], 0, 5, "front")!;
    // Rest frame (mid-hold, before any motion has moved far) and samples through the life.
    const restT = cs(schedule.enterEnd + 0.01);
    const localTimes = [...new Set([0.03, 0.08, schedule.enterEnd * 0.5, restT, (schedule.enterEnd + schedule.exitStart) / 2, schedule.exitStart + (schedule.duration - schedule.exitStart) * 0.4, schedule.duration - 0.04].map(cs))].filter(
      (t) => t > 0 && t < schedule.duration
    );
    const frames = localTimes.map((t) => Math.round((title.startSec + t) * 100));
    const ink = await measure(ass, 5, frames);
    const rest = ink.get(Math.round((title.startSec + restT) * 100))!;
    const restPose = textPoseAt(schedule, restT);
    const anchorX = Math.round(Math.max(0.05, Math.min(0.95, title.x)) * W);
    const anchorY = Math.round(Math.max(0.05, Math.min(0.95, title.y)) * H);
    let worstPos = 0;
    let worstScale = 0;
    let worstAlpha = 0;
    const detail: string[] = [];
    for (const t of localTimes) {
      const got = ink.get(Math.round((title.startSec + t) * 100))!;
      const pose: TextPose = textPoseAt(schedule, t);
      if (pose.alpha < 0.15 || got.mass === 0) continue;
      // Scale is about the anchor; the ink centroid scales with it.
      const k = pose.scale / restPose.scale;
      const expectX = anchorX + (rest.cx - anchorX - restPose.dx) * k + pose.dx;
      const expectY = anchorY + (rest.cy - anchorY - restPose.dy) * k + pose.dy;
      const pos = Math.hypot(got.cx - expectX, got.cy - expectY);
      // Width only on clearly visible frames: faint ink falls under the threshold.
      const scale = rest.width > 0 && pose.alpha >= 0.6 && got.width > 0 ? Math.abs(got.width / rest.width - k) / k : 0;
      const alpha = Math.abs(got.mass / (rest.mass * k * k) - pose.alpha / restPose.alpha);
      worstPos = Math.max(worstPos, pos);
      worstScale = Math.max(worstScale, scale);
      worstAlpha = Math.max(worstAlpha, alpha);
      detail.push(`t${t.toFixed(2)}:a${pose.alpha.toFixed(2)}/s${pose.scale.toFixed(2)}`);
    }
    check(
      `burn follows the schedule: ${label}`,
      worstPos <= 4 && worstScale <= 0.05 && worstAlpha <= 0.08,
      `position ≤${worstPos.toFixed(1)}px, scale ≤${(worstScale * 100).toFixed(1)}%, opacity ≤${(worstAlpha * 100).toFixed(1)}% over ${detail.length} frames`
    );
  }

  // Rotation: the ink's horizontal spread narrows as the text turns.
  {
    const flat = { ...base, animation: "none" as const, exit: "none" as const };
    const turned = { ...flat, rotation: 30 };
    const a = (await measure(renderTitlesAss([flat], 0, 5, "front")!, 5, [200])).get(200)!;
    const b = (await measure(renderTitlesAss([turned], 0, 5, "front")!, 5, [200])).get(200)!;
    // A wide line turned 30° gets much taller about the same centre, and turns
    // clockwise: its right half sits lower than its left.
    check(
      "rotation turns the text clockwise about its centre",
      b.height > a.height * 1.8 && near(b.cx, a.cx, 6) && near(b.cy, a.cy, 6) && b.rightCy > b.leftCy + 40 && near(a.rightCy, a.leftCy, 12),
      `${a.height}→${b.height}px tall, right half ${Math.round(b.rightCy - b.leftCy)}px lower`
    );
  }

  // A title spanning a cut: the second window resumes mid-life, not from its entrance.
  {
    const title: BehindTitle = { ...base, animation: "zoom_in", motion: "grow", exit: "fade" };
    const whole = await measure(renderTitlesAss([title], 0, 5, "front")!, 5, [230]);
    const tail = await measure(renderTitlesAss([title], 2.2, 5, "front")!, 2.8, [10]);
    const a = whole.get(230)!;
    const b = tail.get(10)!;
    check("a window that starts mid-title picks up its pose (no replayed entrance)", near(a.width, b.width, 4) && Math.abs(a.mass / b.mass - 1) < 0.03, `${a.width} vs ${b.width}px`);
  }

  // Word by word: ink grows as words arrive, and is complete once they are all in.
  {
    const title: BehindTitle = { ...base, text: "ONE TWO THREE FOUR", animation: "words", enterSec: 0.8, exit: "none" };
    const schedule = textSchedule(title);
    const frames = [0.02, 0.3, 0.55, schedule.enterEnd + 0.05].map((t) => Math.round((title.startSec + t) * 100));
    const ink = await measure(renderTitlesAss([title], 0, 5, "front")!, 5, frames);
    const masses = frames.map((n) => ink.get(n)!.mass);
    check("word by word: the ink grows as words arrive", masses[0]! < masses[1]! && masses[1]! < masses[2]! && masses[2]! < masses[3]!, masses.map((m) => Math.round(m / 1000)).join(" < "));
    const full = await measure(renderTitlesAss([{ ...title, animation: "none" }], 0, 5, "front")!, 5, [frames[3]!]);
    check("word by word: all in, the line is exactly the plain line", Math.abs(masses[3]! / full.get(frames[3]!)!.mass - 1) < 0.01);
  }

  // A box: the padded background shows at its opacity, and the mask variant is the same shape in white.
  {
    const boxed: BehindTitle = { ...base, animation: "fade", exit: "fade", box: { color: "#ffffff", opacity: 0.5 } };
    const withBox = (await measure(renderTitlesAss([boxed], 0, 5, "front")!, 5, [250])).get(250)!;
    const plain = (await measure(renderTitlesAss([{ ...boxed, box: undefined }], 0, 5, "front")!, 5, [250])).get(250)!;
    check("a box paints behind the text, wider than the ink", withBox.mass > plain.mass * 2 && withBox.width > plain.width, `${plain.width}→${withBox.width}px`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall text checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
