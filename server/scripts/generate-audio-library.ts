import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../src/config";
import { runCommand } from "../src/utils/process.utils";

/**
 * Rebuild the committed built-in music / SFX pads. These live in
 * `assets/audio/` (not ephemeral storage) so every install ships a mix desk.
 */
const OUT_DIR = resolve(import.meta.dir, "../assets/audio");

const PADS: { id: string; lavfi: string }[] = [
  {
    id: "warm",
    lavfi:
      "aevalsrc=0.16*sin(2*PI*196*t)+0.11*sin(2*PI*247*t)+0.07*sin(2*PI*294*t):d=16,aformat=channel_layouts=stereo",
  },
  {
    id: "pulse",
    lavfi:
      "aevalsrc=0.22*sin(2*PI*55*t)*(0.55+0.45*sin(2*PI*2*t)):d=16,aformat=channel_layouts=stereo",
  },
  {
    id: "night",
    lavfi: "anoisesrc=color=pink:d=16,lowpass=f=280,volume=0.4,aformat=channel_layouts=stereo",
  },
  {
    id: "drive",
    lavfi:
      "aevalsrc=0.18*sin(2*PI*73*t)+0.1*sin(2*PI*146*t)*(0.5+0.5*sin(2*PI*8*t)):d=16,aformat=channel_layouts=stereo",
  },
  {
    id: "whoosh",
    lavfi:
      "anoisesrc=color=white:d=0.55,highpass=f=500,lowpass=f=4500,afade=t=in:d=0.16,afade=t=out:st=0.22:d=0.33,volume=0.7,aformat=channel_layouts=stereo",
  },
  {
    id: "hit",
    lavfi: "aevalsrc=0.9*sin(2*PI*72*t)*exp(-14*t):d=0.22,aformat=channel_layouts=stereo",
  },
  {
    id: "pop",
    lavfi: "aevalsrc=0.55*sin(2*PI*980*t)*exp(-42*t):d=0.09,aformat=channel_layouts=stereo",
  },
  {
    id: "rise",
    lavfi:
      "aevalsrc=0.26*sin(2*PI*(180+420*t)*t):d=1.1,afade=t=in:d=0.05,afade=t=out:st=0.85:d=0.25,aformat=channel_layouts=stereo",
  },
  {
    id: "click",
    lavfi: "aevalsrc=0.45*sin(2*PI*2400*t)*exp(-90*t):d=0.04,aformat=channel_layouts=stereo",
  },
];

await mkdir(OUT_DIR, { recursive: true });

for (const pad of PADS) {
  const dest = join(OUT_DIR, `${pad.id}.m4a`);
  await runCommand(
    config.ffmpegPath,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      pad.lavfi,
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ar",
      "44100",
      "-movflags",
      "+faststart",
      dest,
    ],
    { label: `audio ${pad.id}` }
  );
  console.log(`wrote ${pad.id}.m4a`);
}

console.log(`audio library ready in ${OUT_DIR}`);
