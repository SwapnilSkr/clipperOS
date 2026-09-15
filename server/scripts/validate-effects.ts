/**
 *   bun run scripts/validate-effects.ts
 *
 * Every effect in the registry, at two amounts and in every variant, run
 * through FFmpeg on a synthetic picture: the chain must parse and run, and
 * the frames OUTSIDE the span must come out identical to the input (the
 * gate holds), while frames inside change. Then a stacked pair, and a chain
 * inside a full segment graph with a concat, the way the renderer emits it.
 */
import { EFFECTS } from "../src/config/effects";
import { effectsFilterChain } from "../src/services/effects.service";
import { config } from "../src/config";
import type { CreatorPlan } from "../src/types/clip.types";

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Run a chain over a moving test pattern and report the mean absolute
 * difference against the untouched pattern, before, inside and after the span.
 */
function probe(chain: string): { exit: number; before: number; inside: number; after: number; error: string } {
  // A pattern with motion and colour: FFmpeg's testsrc2 scaled to the output size.
  const source = "testsrc2=s=1080x1920:r=10:d=3";
  const graph = `${source},split[ref][in];[in]${chain}[fx];[ref][fx]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`;
  const proc = Bun.spawnSync([config.ffmpegPath, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", source, "-filter_complex", `[0:v]split[ref][in];[in]${chain}[fx];[ref][fx]blend=all_mode=difference,signalstats,metadata=print:file=-`, "-f", "null", "-"], { stderr: "pipe", stdout: "pipe" });
  void graph;
  const out = new TextDecoder().decode(proc.stdout);
  const error = new TextDecoder().decode(proc.stderr).trim();
  // Difference in all three planes: a look that only moves chroma (black &
  // white) leaves luma alone.
  const frames: { t: number; yavg: number }[] = [];
  let t = 0;
  let sum = 0;
  let planes = 0;
  for (const line of out.split("\n")) {
    const at = line.match(/pts_time:([\d.]+)/);
    if (at) {
      if (planes > 0) frames.push({ t, yavg: sum });
      t = Number(at[1]);
      sum = 0;
      planes = 0;
    }
    const y = line.match(/lavfi\.signalstats\.([YUV])AVG=([\d.]+)/);
    if (y) {
      sum += Number(y[2]);
      planes++;
    }
  }
  if (planes > 0) frames.push({ t, yavg: sum });
  const mean = (from: number, to: number) => {
    const inRange = frames.filter((frame) => frame.t >= from && frame.t < to);
    return inRange.length ? inRange.reduce((sum, frame) => sum + frame.yavg, 0) / inRange.length : NaN;
  };
  return { exit: proc.exitCode ?? 1, before: mean(0, 0.95), inside: mean(1.15, 1.85), after: mean(2.15, 3), error };
}

const span = { a: "1", b: "2", E: "enable='between(t,1,2)'" };

for (const effect of EFFECTS) {
  const variants = effect.variants?.map((variant) => variant.id) ?? [undefined];
  for (const variant of variants) {
    for (const A of [0.35, 1]) {
      const chain = effect.chain({ A, a: span.a, b: span.b, E: span.E, prefix: "t", variant });
      const result = probe(chain);
      const label = `${effect.id}${variant ? `/${variant}` : ""} @${A}`;
      check(`${label}: runs`, result.exit === 0, result.error.slice(0, 160));
      if (result.exit !== 0) continue;
      // Temporal effects (tmix, lagfun) hold a little state; a frame or two
      // after the span may still differ. Gate holds when the rest is exact.
      const gated = result.before < 0.05 && result.after < 0.05;
      check(`${label}: untouched outside the span`, gated, `before ${result.before.toFixed(2)} after ${result.after.toFixed(2)}`);
      check(`${label}: changes the picture inside it`, result.inside > 0.3, `inside ${result.inside.toFixed(2)}`);
    }
  }
}

// ---- stacking and the renderer's own assembly ----
{
  const plan: CreatorPlan = {
    enabled: true,
    version: 1,
    effects: [
      { id: "e1", effectId: "vhs", startSec: 101, endSec: 102.5, amount: 0.8 },
      { id: "e2", effectId: "bloom", startSec: 101.5, endSec: 102, amount: 1 },
      { id: "e3", effectId: "shake", startSec: 102.6, endSec: 102.9, amount: 0.6 },
      { id: "e4", effectId: "fadeblack", startSec: 102.5, endSec: 103, amount: 1, variant: "dip" },
    ],
  };
  const chain = effectsFilterChain(plan, 100, 103, "s0");
  check("stack: effects outside the window are left out, inside ones ordered by start", chain.startsWith("split[s0fx0a]") && chain.includes("blend=all_mode=screen") && chain.includes("split[s0fx3a]") && chain.includes("eq=brightness='-1*"));
  const result = probe(chain);
  check("stack: four effects with two graph branches run as one chain", result.exit === 0, result.error.slice(0, 200));
  check("stack: frames before every span are untouched", result.exit === 0 && result.before < 0.05, `before ${result.before.toFixed(2)}`);
  check("effects outside the window produce an empty chain", effectsFilterChain(plan, 110, 112, "s1") === "");
  check("a disabled plan produces no chain", effectsFilterChain({ ...plan, enabled: false }, 100, 103, "s0") === "");
}

console.log(failures === 0 ? "\nall effect checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
