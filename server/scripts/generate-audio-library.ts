import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../src/config";
import { runCommand } from "../src/utils/process.utils";

/**
 * Rebuild the committed built-in music / SFX pads. These live in
 * `assets/audio/` (not ephemeral storage) so every install ships a mix desk.
 */
const OUT_DIR = resolve(import.meta.dir, "../assets/audio");

/**
 * One-shots are normalised to this true peak so a hit reads over a loud voice
 * at the desk's default gain; beds keep their own quiet level (mixed at ~0.22).
 */
const ONE_SHOT_PEAK_DB = -1;

const PADS: { id: string; lavfi: string; oneShot?: boolean }[] = [
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
    oneShot: true,
    lavfi:
      "anoisesrc=color=white:d=0.55:seed=3,highpass=f=500,lowpass=f=4500,afade=t=in:d=0.16,afade=t=out:st=0.22:d=0.33,aformat=channel_layouts=stereo",
  },
  {
    id: "hit",
    oneShot: true,
    lavfi: "aevalsrc=0.9*sin(2*PI*72*t)*exp(-14*t):d=0.22,aformat=channel_layouts=stereo",
  },
  {
    id: "pop",
    oneShot: true,
    lavfi: "aevalsrc=0.55*sin(2*PI*980*t)*exp(-42*t):d=0.09,aformat=channel_layouts=stereo",
  },
  {
    id: "rise",
    oneShot: true,
    lavfi:
      "aevalsrc=0.26*sin(2*PI*(180+420*t)*t):d=1.1,afade=t=in:d=0.05,afade=t=out:st=0.85:d=0.25,aformat=channel_layouts=stereo",
  },
  {
    id: "click",
    oneShot: true,
    lavfi: "aevalsrc=0.45*sin(2*PI*2400*t)*exp(-90*t):d=0.04,aformat=channel_layouts=stereo",
  },
  // ---- creator-mode one-shots: the sounds an editor drops on a beat ----
  {
    // A softer, longer swoosh for camera moves and title entrances.
    id: "swoosh",
    oneShot: true,
    lavfi:
      "anoisesrc=color=brown:d=0.7:seed=7,highpass=f=300,lowpass=f=2600,afade=t=in:d=0.22,afade=t=out:st=0.34:d=0.36,volume=1.6,aformat=channel_layouts=stereo",
  },
  {
    // A short riser into a payoff line.
    id: "riser",
    oneShot: true,
    lavfi:
      "aevalsrc=0.28*sin(2*PI*(160+1100*t*t)*t)+0.1*(2*random(0)-1)*t:d=0.65,afade=t=in:d=0.06,afade=t=out:st=0.58:d=0.07,volume=1.1,aformat=channel_layouts=stereo",
  },
  {
    // A sub drop for the peak.
    id: "boom",
    oneShot: true,
    lavfi: "aevalsrc=0.95*sin(2*PI*(54-22*t)*t)*exp(-3.4*t):d=0.9,aformat=channel_layouts=stereo",
  },
  {
    // A punch impact: low thump with a noise transient.
    id: "thud",
    oneShot: true,
    lavfi:
      "aevalsrc=0.9*sin(2*PI*92*t)*exp(-18*t)+0.4*(2*random(0)-1)*exp(-60*t):d=0.3,lowpass=f=1400,aformat=channel_layouts=stereo",
  },
  {
    // A camera shutter: two clicks.
    id: "shutter",
    oneShot: true,
    lavfi:
      "aevalsrc='0.6*sin(2*PI*1800*t)*exp(-120*t)+0.5*sin(2*PI*900*(t-0.06))*exp(-90*(t-0.06))*gt(t,0.06)':d=0.16,aformat=channel_layouts=stereo",
  },
  {
    // A bright ding for a caption or fact landing.
    id: "ding",
    oneShot: true,
    lavfi:
      "aevalsrc=0.5*sin(2*PI*1568*t)*exp(-4*t)+0.25*sin(2*PI*3136*t)*exp(-6*t):d=0.9,aformat=channel_layouts=stereo",
  },
  {
    // A glitch tick for a jump cut.
    id: "tick",
    oneShot: true,
    lavfi: "aevalsrc=0.5*(2*random(0)-1)*exp(-70*t):d=0.06,highpass=f=2000,aformat=channel_layouts=stereo",
  },
];

/** The synthesised signal's peak in dBFS, so the encode can place it. */
async function peakDb(lavfi: string): Promise<number> {
  let peak: number | undefined;
  await runCommand(
    config.ffmpegPath,
    ["-hide_banner", "-f", "lavfi", "-i", lavfi, "-af", "volumedetect", "-f", "null", "-"],
    {
      label: "audio peak",
      onStderr: (line) => {
        const match = /max_volume:\s*(-?[\d.]+) dB/.exec(line);
        if (match) peak = Number(match[1]);
      },
    }
  );
  if (peak == null) throw new Error("volumedetect reported no peak");
  return peak;
}

await mkdir(OUT_DIR, { recursive: true });

// `bun run scripts/generate-audio-library.ts whoosh boom` rebuilds only those.
const only = new Set(process.argv.slice(2));

for (const pad of PADS) {
  if (only.size > 0 && !only.has(pad.id)) continue;
  const dest = join(OUT_DIR, `${pad.id}.m4a`);
  const filters: string[] = [];
  if (pad.oneShot) {
    const gainDb = ONE_SHOT_PEAK_DB - (await peakDb(pad.lavfi));
    filters.push(`volume=${gainDb.toFixed(2)}dB`);
  }
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
      ...(filters.length > 0 ? ["-af", filters.join(",")] : []),
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
  console.log(`wrote ${pad.id}.m4a${pad.oneShot ? ` (peak ${ONE_SHOT_PEAK_DB} dB)` : ""}`);
}

console.log(`audio library ready in ${OUT_DIR}`);
