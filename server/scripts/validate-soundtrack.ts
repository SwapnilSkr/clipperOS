import {
  buildSoundtrackGraph,
  customAssetFileId,
  SHARED_AUDIO_OWNER,
  soundtrackNeedsMix,
  soundtrackSpansOutro,
} from "../src/services/soundtrack.service";

function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

check("empty soundtrack is a no-op", soundtrackNeedsMix(undefined) === false);
check("default voice gain is a no-op", soundtrackNeedsMix({ voiceGain: 1 }) === false);
check("voice duck is mixed", soundtrackNeedsMix({ voiceGain: 0.6 }) === true);
check("music bed is mixed", soundtrackNeedsMix({ music: { assetId: "warm" } }) === true);
check("a hit is mixed", soundtrackNeedsMix({ sfx: [{ id: "a", assetId: "hit", atSec: 1.2 }] }) === true);
check("music carries into the sting by default", soundtrackSpansOutro({ music: { assetId: "warm" } }, 8) === true);
check("music can stop at the last frame", soundtrackSpansOutro({ music: { assetId: "warm", carryIntoOutro: false } }, 8) === false);
check("a sting hit extends the mix", soundtrackSpansOutro({ sfx: [{ id: "a", assetId: "hit", atSec: 8.2 }] }, 8) === true);
check("shared audio lives beside leftover project folders", SHARED_AUDIO_OWNER === "shared");
check(
  "a custom upload keeps its uuid",
  customAssetFileId("custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") === "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
);

const voiceOnly = buildSoundtrackGraph({
  durationSec: 8,
  voiceGain: 0.8,
  voiceHasAudio: true,
  duck: true,
  musicGain: 0.22,
  hits: [],
});
check("voice-only graph copies the voice", voiceOnly.includes("[0:a]volume=0.800") && voiceOnly.includes("[outa]"));
check("voice is padded to the clip length", voiceOnly.includes("apad=whole_dur=8.000"));
check("voice-only does not invent a bed", !voiceOnly.includes("amix") && !voiceOnly.includes("sidechain"));

const ducked = buildSoundtrackGraph({
  durationSec: 12,
  voiceGain: 1,
  voiceHasAudio: true,
  duck: true,
  musicIndex: 1,
  musicGain: 0.22,
  hits: [{ index: 2, atSec: 1.5, gain: 0.9 }],
});
check("ducked music splits the voice", ducked.includes("asplit=2[voice][voicekey]"));
check("ducked music sidechains the bed", ducked.includes("sidechaincompress"));
check("hits are delayed in clip-local ms", ducked.includes("adelay=1500:all=1"));
check("final mix keeps original duration", ducked.includes("amix=inputs=3:duration=first"));

const noVoice = buildSoundtrackGraph({
  durationSec: 6,
  voiceGain: 1,
  voiceHasAudio: false,
  duck: true,
  musicIndex: 1,
  musicGain: 0.3,
  hits: [],
});
check("music without voice does not duck", noVoice.includes("[musicraw]anull[music]") && !noVoice.includes("sidechain"));
check("missing assets yield an empty graph", buildSoundtrackGraph({
  durationSec: 4,
  voiceGain: 1,
  voiceHasAudio: false,
  duck: true,
  musicGain: 0.22,
  hits: [],
}) === "");

const throughSting = buildSoundtrackGraph({
  durationSec: 10.4,
  voiceGain: 0.7,
  voiceHasAudio: true,
  duck: false,
  musicIndex: 1,
  musicGain: 0.22,
  voiceUntilSec: 8,
  hits: [{ index: 2, atSec: 8.2, gain: 0.9 }],
});
check("voice gain stops at the sting", throughSting.includes("atrim=0:8.000") && throughSting.includes("concat=n=2:v=0:a=1"));
check("a hit can land on the sting", throughSting.includes("adelay=8200:all=1"));

console.log("\nall soundtrack checks passed");
