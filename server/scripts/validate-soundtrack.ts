/**
 *   bun run scripts/validate-soundtrack.ts
 *
 * The soundtrack mix: the graph's algebra (what is mixed, when the sting is
 * part of it, how the pre-`beds` single bed reads), then FFmpeg run on
 * synthetic inputs and measured — a second bed is silent before it comes in
 * and plays after; the dip under speech is what `dip` promises (the rule the
 * live preview mirrors); the offset into the file is where the bed starts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { runCommand } from "../src/utils/process.utils";
import {
  bedFadeSec,
  bedOutSec,
  buildSoundtrackGraph,
  customAssetFileId,
  DIP_FLOOR,
  listBuiltinAudio,
  mixSoundtrackOntoClip,
  musicBeds,
  SHARED_AUDIO_OWNER,
  soundtrackNeedsMix,
  soundtrackSpansOutro,
} from "../src/services/soundtrack.service";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

check("empty soundtrack is a no-op", soundtrackNeedsMix(undefined) === false);
check("default voice gain is a no-op", soundtrackNeedsMix({ voiceGain: 1 }) === false);
check("voice duck is mixed", soundtrackNeedsMix({ voiceGain: 0.6 }) === true);
check("a bed is mixed", soundtrackNeedsMix({ beds: [{ id: "b", assetId: "warm" }] }) === true);
check("the pre-beds single bed is mixed", soundtrackNeedsMix({ music: { assetId: "warm" } }) === true);
check("a hit is mixed", soundtrackNeedsMix({ sfx: [{ id: "a", assetId: "hit", atSec: 1.2 }] }) === true);

const legacy = musicBeds({ music: { assetId: "warm", gain: 0.3, duck: false, carryIntoOutro: false } });
check(
  "the single bed reads as beds[0] with its knobs",
  legacy.length === 1 && legacy[0]!.assetId === "warm" && legacy[0]!.gain === 0.3 && legacy[0]!.dip === 0 && legacy[0]!.carryIntoOutro === false
);
check("beds win over the single bed", musicBeds({ music: { assetId: "warm" }, beds: [] }).length === 0);

check("a bed carries into the sting by default", soundtrackSpansOutro({ beds: [{ id: "b", assetId: "warm" }] }, 8) === true);
check("a bed can stop at the last frame", soundtrackSpansOutro({ beds: [{ id: "b", assetId: "warm", carryIntoOutro: false }] }, 8) === false);
check("a bed that goes out inside the clip stays inside it", soundtrackSpansOutro({ beds: [{ id: "b", assetId: "warm", outSec: 5 }] }, 8) === false);
check("a sting hit extends the mix", soundtrackSpansOutro({ sfx: [{ id: "a", assetId: "hit", atSec: 8.2 }] }, 8) === true);
check("out point is clamped to the sting's end", bedOutSec({ id: "b", assetId: "warm", outSec: 30 }, 8, 3) === 11);
check("out point without carry is clamped to the clip", bedOutSec({ id: "b", assetId: "warm", outSec: 30, carryIntoOutro: false }, 8, 3) === 8);
check("auto fade is a sixth of the span, at most 1.2 s", bedFadeSec(undefined, 3) === 0.5 && bedFadeSec(undefined, 30) === 1.2);
check("an explicit fade never exceeds half the span", bedFadeSec(3, 2) === 1);
check("shared audio lives beside leftover project folders", SHARED_AUDIO_OWNER === "shared");
check(
  "a custom upload keeps its uuid",
  customAssetFileId("custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") === "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
);

const voiceOnly = buildSoundtrackGraph({ durationSec: 8, voiceGain: 0.8, voiceHasAudio: true, beds: [], hits: [] });
check("voice-only graph copies the voice", voiceOnly.includes("[0:a]volume=0.800") && voiceOnly.includes("[outa]"));
check("voice is padded to the clip length", voiceOnly.includes("apad=whole_dur=8.000"));
check("voice-only does not invent a bed", !voiceOnly.includes("amix") && !voiceOnly.includes("sidechain"));

const twoBeds = buildSoundtrackGraph({
  durationSec: 12,
  voiceGain: 1,
  voiceHasAudio: true,
  beds: [
    { index: 1, gain: 0.22, inSec: 0, outSec: 12, offsetSec: 0, dip: 0.6 },
    { index: 2, gain: 0.4, inSec: 4.5, outSec: 10, offsetSec: 30, fadeInSec: 0.1, fadeOutSec: 2, dip: 0 },
  ],
  hits: [{ index: 3, atSec: 1.5, gain: 0.9 }],
});
check("one voice key per ducked bed", twoBeds.includes("asplit=2[voice][voicekey0]"));
check("a ducked bed sidechains with its dip as the blend", twoBeds.includes("[bedraw0][voicekey0]sidechaincompress=") && twoBeds.includes("mix=0.600[bed0]"));
check("a bed with no dip is not ducked", twoBeds.includes("[bedraw1]anull[bed1]"));
check("a bed comes in at its in point", twoBeds.includes("adelay=4500:all=1"));
check("a bed starts at its offset in the file", twoBeds.includes("[2:a]atrim=30.000:35.500"));
check("explicit fades are used", twoBeds.includes("afade=t=in:d=0.100") && twoBeds.includes("afade=t=out:st=3.500:d=2.000"));
check("hits are delayed in clip-local ms", twoBeds.includes("adelay=1500:all=1"));
check("final mix keeps original duration", twoBeds.includes("amix=inputs=4:duration=first"));

const noVoice = buildSoundtrackGraph({
  durationSec: 6,
  voiceGain: 1,
  voiceHasAudio: false,
  beds: [{ index: 1, gain: 0.3, inSec: 0, outSec: 6, offsetSec: 0, dip: 0.6 }],
  hits: [],
});
check("music without voice does not duck", noVoice.includes("[bedraw0]anull[bed0]") && !noVoice.includes("sidechain"));
check("missing assets yield an empty graph", buildSoundtrackGraph({ durationSec: 4, voiceGain: 1, voiceHasAudio: false, beds: [], hits: [] }) === "");

const throughSting = buildSoundtrackGraph({
  durationSec: 10.4,
  voiceGain: 0.7,
  voiceHasAudio: true,
  beds: [{ index: 1, gain: 0.22, inSec: 0, outSec: 10.4, offsetSec: 0, dip: 0 }],
  voiceUntilSec: 8,
  hits: [{ index: 2, atSec: 8.2, gain: 0.9 }],
});
check("voice gain stops at the sting", throughSting.includes("atrim=0:8.000") && throughSting.includes("concat=n=2:v=0:a=1"));
check("a hit can land on the sting", throughSting.includes("adelay=8200:all=1"));

// ---- FFmpeg on synthetic inputs -------------------------------------------
// Voice: a 1 kHz tone at −20 dBFS rms from 4–7 s only. Bed 1: pink noise the
// whole way, dip 0.6. Bed 2: a 300 Hz tone from 8 s, no dip, starting 2 s into
// a file whose first 2 s are silent — so an offset that works is audible at
// once and a broken one gives silence.
const dir = await mkdtemp(join(tmpdir(), "soundtrack-validate-"));
try {
  const voice = join(dir, "voice.wav");
  const bed1 = join(dir, "bed1.wav");
  const bed2 = join(dir, "bed2.wav");
  const out = join(dir, "mix.wav");
  await runCommand(config.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=1000:d=12:r=44100,volume=1.1,volume='between(t,4,7)':eval=frame", voice], { label: "voice" });
  await runCommand(config.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.25:d=12:r=44100:s=7", bed1], { label: "bed1" });
  await runCommand(config.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=300:d=6:r=44100,volume='gte(t,2)':eval=frame", bed2], { label: "bed2" });

  const graph = buildSoundtrackGraph({
    durationSec: 12,
    voiceGain: 1,
    voiceHasAudio: true,
    beds: [
      { index: 1, gain: 1, inSec: 0, outSec: 12, offsetSec: 0, fadeInSec: 0, fadeOutSec: 0, dip: 0.6 },
      { index: 2, gain: 1, inSec: 8, outSec: 12, offsetSec: 2, fadeInSec: 0, fadeOutSec: 0, dip: 0 },
    ],
    hits: [],
  });
  await runCommand(
    config.ffmpegPath,
    ["-y", "-hide_banner", "-loglevel", "error", "-i", voice, "-stream_loop", "-1", "-i", bed1, "-stream_loop", "-1", "-i", bed2, "-filter_complex", graph, "-map", "[outa]", "-t", "12", out],
    { label: "mix" }
  );

  /** RMS in dB of one band of the mix over a window, via a band-pass so each source is read on its own. */
  async function rms(band: string, from: number, to: number): Promise<number> {
    let text = "";
    await runCommand(
      config.ffmpegPath,
      ["-hide_banner", "-i", out, "-af", `${band}atrim=${from}:${to},astats=measure_perchannel=none:measure_overall=RMS_level`, "-f", "null", "-"],
      { label: "astats", onStderr: (line) => (text += `${line}\n`) }
    );
    const match = text.match(/RMS level dB:\s*(-?[\d.]+|-inf)/g)?.pop()?.match(/(-?[\d.]+|-inf)/);
    return match ? (match[1] === "-inf" ? -120 : Number(match[1])) : Number.NaN;
  }
  // Pink noise well away from both tones (three poles: the 1 kHz voice must not read as bed).
  const noise = "highpass=f=4000,highpass=f=4000,highpass=f=4000,";
  const quiet = await rms(noise, 1, 3.5);
  const underSpeech = await rms(noise, 5, 6.8);
  const after = await rms(noise, 9, 11.5);
  const expectedDip = 20 * Math.log10(1 - (1 - DIP_FLOOR) * 0.6);
  check("bed plays at its level away from speech", Math.abs(quiet - after) < 1, `${quiet.toFixed(1)} vs ${after.toFixed(1)} dB`);
  check(
    "bed dips under speech by what dip=0.6 promises",
    Math.abs(underSpeech - quiet - expectedDip) < 1.5,
    `${(underSpeech - quiet).toFixed(1)} dB, rule says ${expectedDip.toFixed(1)}`
  );
  const tone = "bandpass=f=300:w=60,";
  const beforeIn = await rms(tone, 1, 7.5);
  const afterIn = await rms(tone, 8.2, 11.5);
  check("second bed is silent before it comes in", afterIn - beforeIn > 30, `${beforeIn.toFixed(1)} → ${afterIn.toFixed(1)} dB`);
  const justIn = await rms(tone, 8.05, 8.6);
  check("second bed starts at its offset (past the file's silent head)", afterIn - justIn < 2, `${justIn.toFixed(1)} vs ${afterIn.toFixed(1)} dB`);

  // ---- the real entry point, with the bundled library ----------------------
  // Two built-in beds and a hit onto a synthetic clip, through the same call
  // the renderer makes (inputs are looped, indexed and mapped there).
  const builtin = listBuiltinAudio();
  const bedFiles = builtin.filter((asset) => asset.kind === "music").slice(0, 2);
  const hitFile = builtin.find((asset) => asset.kind === "sfx");
  if (bedFiles.length === 2 && hitFile) {
    const clip = join(dir, "clip.mp4");
    await runCommand(
      config.ffmpegPath,
      ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=25:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6:r=44100", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", clip],
      { label: "clip" }
    );
    const mixed = await mixSoundtrackOntoClip(
      "none",
      clip,
      6,
      {
        beds: [
          { id: "a", assetId: bedFiles[0]!.id, gain: 0.3 },
          { id: "b", assetId: bedFiles[1]!.id, gain: 0.3, inSec: 2, outSec: 5, offsetSec: 4, dip: 0 },
        ],
        sfx: [{ id: "h", assetId: hitFile.id, atSec: 1, gain: 0.9 }],
      },
      dir
    );
    let probe = "";
    await runCommand(
      config.ffmpegPath,
      ["-hide_banner", "-i", mixed, "-af", "astats=measure_perchannel=none:measure_overall=RMS_level", "-f", "null", "-"],
      { label: "probe", onStderr: (line) => (probe += `${line}\n`) }
    );
    const level = Number(probe.match(/RMS level dB:\s*(-?[\d.]+)/g)?.pop()?.match(/(-?[\d.]+)/)?.[1] ?? Number.NaN);
    const stamp = probe.match(/Duration: (\d+):(\d+):([\d.]+)/);
    const length = stamp ? Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]) : Number.NaN;
    check("mixSoundtrackOntoClip mixes two library beds and a hit", mixed !== clip && Number.isFinite(level) && level > -40, `${level.toFixed(1)} dB`);
    check("the mixed clip keeps its length", Math.abs(length - 6) < 0.2, `${length.toFixed(2)} s`);
  } else {
    check("bundled audio library is present", false, "server/assets/audio is missing beds or hits");
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} soundtrack check(s) failed`);
  process.exit(1);
}
console.log("\nall soundtrack checks passed");
