/**
 *   bun run scripts/validate-cutaways.ts
 *
 * A still and a video cutaway over a synthetic picture, assembled the way the
 * renderer assembles a segment (extra inputs, xfade-on-alpha transitions,
 * one overlay each), run through FFmpeg: the output keeps the picture's
 * length and frame count, frames outside every cutaway are the picture
 * itself, frames inside are the media, and the transition edges land where
 * the plan says. Then the preview's timing maths against the same plan.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { CUTAWAY_TRANSITIONS } from "../src/config/transitions";
import { prepareCutaway } from "../src/services/cutaway.service";
import { cutawayAt, cutawaySpan } from "../src/services/creator-timeline";
import type { Cutaway, MediaAsset } from "../src/types/clip.types";

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

const dir = await mkdtemp(join(tmpdir(), "cutaways-"));
const still = join(dir, "still.jpg");
const video = join(dir, "video.mp4");
const out = join(dir, "out.mp4");
const ff = (args: string[]) => Bun.spawnSync([config.ffmpegPath, "-hide_banner", "-loglevel", "error", "-y", ...args], { stderr: "pipe", stdout: "pipe" });

// Media: a flat green still, a flat blue video. The picture: flat grey.
ff(["-f", "lavfi", "-i", "color=c=0x00c000:s=1600x900:d=1", "-frames:v", "1", still]);
ff(["-f", "lavfi", "-i", "color=c=0x0000c0:s=1280x720:r=25:d=6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video]);

const stillAsset: MediaAsset = { id: "a", kind: "image", source: "upload", label: "still", width: 1600, height: 900 };
const videoAsset: MediaAsset = { id: "b", kind: "video", source: "upload", label: "video", width: 1280, height: 720, durationSec: 6 };
const cutaways: Cutaway[] = [
  { id: "c1", startSec: 101, endSec: 102.5, assetId: "a", fit: "cover", motion: "in", in: { transitionId: "dissolve", sec: 0.4 }, out: { transitionId: "wipe_right", sec: 0.4 } },
  { id: "c2", startSec: 104, endSec: 105, assetId: "b", fit: "blur", motion: "left", in: { transitionId: "slide_left", sec: 0.3 }, out: { transitionId: "cut", sec: 0.3 }, offsetSec: 1 },
];
const window = { startSec: 100, endSec: 107 };
const fps = 25;

const prepared = [prepareCutaway(cutaways[0]!, stillAsset, still, window.startSec, window.endSec)!, prepareCutaway(cutaways[1]!, videoAsset, video, window.startSec, window.endSec)!];
check("both cutaways prepare for the window", prepared.every(Boolean));
check("a `cut` edge adds no time", near(prepared[1]!.lengthSec, 1.3) && near(prepared[1]!.startSec, 3.7));
check("the still's span includes both transitions", near(prepared[0]!.startSec, 0.6) && near(prepared[0]!.lengthSec, 2.3));

// Assemble like segmentVideoGraph: picture from lavfi as input 0, media as 1 and 2.
const args = ["-f", "lavfi", "-i", `color=c=0x808080:s=1080x1920:r=${fps}:d=7`];
const inputs: number[] = [];
prepared.forEach((item, k) => {
  args.push(...item.inputArgs(item.lengthSec));
  inputs.push(k + 1);
});
const lines: string[] = ["[0:v]null[pic]"];
let current = "pic";
prepared.forEach((item, k) => {
  const label = `cw${k}`;
  lines.push(...item.lines(inputs[k]!, label, fps));
  lines.push(`[${current}][${label}]${item.overlay}[${label}p]`);
  current = `${label}p`;
});
lines.push(`[${current}]format=yuv420p[v]`);
const proc = ff([...args, "-filter_complex", lines.join(";"), "-map", "[v]", "-t", "7", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", out]);
check("ffmpeg runs the cutaway graph", proc.exitCode === 0, new TextDecoder().decode(proc.stderr).slice(0, 300));

if (proc.exitCode === 0) {
  const probe = Bun.spawnSync([config.ffmpegPath.replace(/ffmpeg$/, "ffprobe"), "-v", "error", "-select_streams", "v", "-count_frames", "-show_entries", "stream=nb_read_frames,duration", "-of", "csv=p=0", out], { stdout: "pipe" });
  const fields = new TextDecoder().decode(probe.stdout).trim().split(",").map(Number);
  const duration = fields.find((value) => !Number.isInteger(value)) ?? fields[0]!;
  const frames = fields.find((value) => Number.isInteger(value) && value > 20) ?? 0;
  check("the picture keeps its length and frame count", near(duration, 7, 0.05) && frames === 175, `${frames} frames, ${duration}s`);

  // Mean colour of a frame at an instant: grey untouched, green still, blue video.
  const rgbAt = (t: number): [number, number, number] => {
    const p = Bun.spawnSync([config.ffmpegPath, "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe" });
    const bytes = new Uint8Array(p.stdout);
    return [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0];
  };
  const grey = (c: [number, number, number]) => Math.abs(c[0] - 128) < 8 && Math.abs(c[1] - 128) < 8 && Math.abs(c[2] - 128) < 8;
  check("before the first cutaway the picture is untouched", grey(rgbAt(0.3)), rgbAt(0.3).join(","));
  const mid = rgbAt(1.8);
  check("inside the still cutaway the frame is the still", mid[1] > 150 && mid[0] < 60, mid.join(","));
  const half = rgbAt(0.8);
  check("halfway through the dissolve the frame is a blend", half[1] > 128 && half[1] < 190 && half[0] > 40 && half[0] < 120, half.join(","));
  check("between cutaways the picture is untouched", grey(rgbAt(3.2)), rgbAt(3.2).join(","));
  const inVideo = rgbAt(4.5);
  check("inside the video cutaway the frame is the video (blur fit: mostly blue)", inVideo[2] > 120 && inVideo[0] < 80, inVideo.join(","));
  check("after the hard cut out the picture is untouched", grey(rgbAt(5.2)), rgbAt(5.2).join(","));
}

// ---- every transition, in and out, over a grey picture ----
// A light cutaway (240) over grey (130): the frame's mean luma must travel
// between the two without dipping below the picture — the failure mode when
// xfade mixes toward a transparent BLACK stream. Dips are meant to.
{
  const light = join(dir, "light.png");
  ff(["-f", "lavfi", "-i", "color=c=0xf0f0f0:s=1080x1920:d=1", "-frames:v", "1", light]);
  const lightAsset: MediaAsset = { id: "l", kind: "image", source: "upload", label: "light", width: 1080, height: 1920 };
  const lumaAt = (file: string, t: number) =>
    new Uint8Array(Bun.spawnSync([config.ffmpegPath, "-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { stdout: "pipe" }).stdout)[0] ?? 0;
  for (const transition of CUTAWAY_TRANSITIONS) {
    if (transition.id === "cut") continue;
    const edge = { transitionId: transition.id, sec: 0.8 };
    const item = prepareCutaway({ id: "t", startSec: 1, endSec: 1.6, assetId: "l", fit: "cover", motion: "none", in: edge, out: edge }, lightAsset, light, 0, 3)!;
    const file = join(dir, `t-${transition.id}.mp4`);
    const graph = ["[0:v]null[pic]", ...item.lines(1, "cw", fps), `[pic][cw]${item.overlay}[o]`, "[o]format=yuv420p[v]"].join(";");
    const run = ff(["-f", "lavfi", "-i", `color=c=0x808080:s=1080x1920:r=${fps}:d=3`, ...item.inputArgs(item.lengthSec), "-filter_complex", graph, "-map", "[v]", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", file]);
    if (run.exitCode !== 0) {
      check(`transition ${transition.id}: runs`, false, new TextDecoder().decode(run.stderr).slice(0, 200));
      continue;
    }
    const during = [0.3, 0.45, 0.6, 0.75, 0.9, 1.7, 1.85, 2.0, 2.15, 2.3].map((t) => lumaAt(file, t));
    const full = lumaAt(file, 1.3);
    const after = lumaAt(file, 2.7);
    const dip = transition.kind === "dip";
    check(
      `transition ${transition.id}: in and out, ${dip ? "through its colour" : "no dip below the picture"}`,
      full > 225 && after < 140 && (dip ? during.some((l) => l < 60 || l > 250) : Math.min(...during) >= 122),
      during.join(",")
    );
  }
}

// ---- the preview's timing maths ----
{
  const plan = { enabled: true, version: 1 as const, cutaways };
  const span = cutawaySpan(cutaways[0]!);
  check("cutawaySpan adds the transitions either side", near(span.startSec, 100.6) && near(span.endSec, 102.9));
  const during = cutawayAt(plan, 100.8)!;
  check("cutawayAt: halfway through the transition in", during.cutaway.id === "c1" && near(during.inU, 0.5) && during.outU === 0);
  const later = cutawayAt(plan, 102.7)!;
  check("cutawayAt: halfway through the transition out", near(later.outU, 0.5) && later.inU === 1);
  check("cutawayAt: progress runs 0→1 over the whole appearance", near(cutawayAt(plan, 100.6)!.progress, 0) && near(cutawayAt(plan, 102.89)!.progress, 2.29 / 2.3, 0.01));
  check("cutawayAt: media clock carries the offset", near(cutawayAt(plan, 104.2)!.mediaSec, 1 + 0.5));
  check("cutawayAt: nothing between cutaways", cutawayAt(plan, 103.3) === undefined);
}

// ---- the stock sweep: only old, unused downloads go ----
{
  const { sweepUnreferencedStock, STOCK_KEEP_MS } = await import("../src/services/media-library.service");
  const { utimes, writeFile, mkdir, readdir } = await import("node:fs/promises");
  const library = join(dir, "library");
  await mkdir(library, { recursive: true });
  const saved = config.mediaLibraryPath;
  config.mediaLibraryPath = library;
  const ids = {
    upload: "00000000-0000-4000-8000-000000000001",
    usedStock: "00000000-0000-4000-8000-000000000002",
    oldStock: "00000000-0000-4000-8000-000000000003",
    newStock: "00000000-0000-4000-8000-000000000004",
  };
  const now = Date.now();
  const old = new Date(now - STOCK_KEEP_MS - 60_000);
  for (const [name, id] of Object.entries(ids)) {
    const source = name === "upload" ? "upload" : name === "usedStock" ? "pexels" : "pixabay";
    await writeFile(join(library, `${id}.jpg`), "x");
    await writeFile(join(library, `${id}.json`), JSON.stringify({ id, ext: "jpg", kind: "image", source, label: name, width: 1, height: 1 }));
    if (name !== "newStock") await utimes(join(library, `${id}.json`), old, old);
  }
  const removed = await sweepUnreferencedStock({ referenced: async () => new Set([ids.usedStock]), now });
  const left = (await readdir(library)).sort();
  config.mediaLibraryPath = saved;
  check(
    "stock sweep removes only a day-old download no clip uses; uploads, used and fresh picks stay",
    removed.join(",") === ids.oldStock && !left.some((name) => name.startsWith(ids.oldStock)) && left.length === 6,
    left.join(" ")
  );
}

await rm(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nall cutaway checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
