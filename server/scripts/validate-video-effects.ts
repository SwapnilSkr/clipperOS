import { audioEffectFilterChain, videoEffectFilterChain } from "../src/services/clip-render.service";
import type { VideoEffects } from "../src/types/clip.types";

function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

const looks: NonNullable<VideoEffects["grade"]>[] = ["natural", "vibrant", "warm", "cool", "cinematic"];
for (const grade of looks) {
  const chain = videoEffectFilterChain({ grade, sharpen: 0.4, vignette: true });
  check(`${grade} picture recipe is renderable`, grade === "natural" ? chain.includes("unsharp") : chain.includes("eq="));
}

const hook = videoEffectFilterChain({ motion: "hook_push", zoom: 1.08 });
check("hook push is smooth and time-based", hook.includes("1-t/0.45") && hook.includes("eval=frame"));

const peak = videoEffectFilterChain({ motion: "peak_punch", zoom: 1.09 }, 3.25);
check("peak punch follows the mined payoff", peak.includes("t-3.2500") && peak.includes("abs("));

check("voice processing has dynamics protection", audioEffectFilterChain({ audio: "voice" }).includes("alimiter"));
check("high-energy audio has dynamics protection", audioEffectFilterChain({ audio: "loud" }).includes("alimiter"));
check("natural audio remains untouched", audioEffectFilterChain({ audio: "natural" }) === "");

console.log("\nall overall-video effect checks passed");
