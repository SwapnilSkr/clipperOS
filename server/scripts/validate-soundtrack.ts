import {
  buildSoundtrackGraph,
  soundtrackNeedsMix,
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

const voiceOnly = buildSoundtrackGraph({
  durationSec: 8,
  voiceGain: 0.8,
  voiceHasAudio: true,
  duck: true,
  musicGain: 0.22,
  hits: [],
});
check("voice-only graph copies the voice", voiceOnly.includes("[0:a]volume=0.800") && voiceOnly.includes("[outa]"));
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

console.log("\nall soundtrack checks passed");
