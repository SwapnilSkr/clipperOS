import { EFFECTS_BY_ID, type EffectChainInput } from "../config/effects";
import type { CreatorPlan, EffectSpan } from "../types/clip.types";

// ============================================
// EFFECTS — the filter chain for one window of the picture.
//
// Spans are on the source clock; a window sees the part of each span that
// falls inside it, written on the window's own clock. Effects stack in start
// order (then plan order), each gated to its span, so a frame outside every
// span passes through untouched.
// ============================================

const num = (value: number) => Number(value.toFixed(4)).toString();

/** The effect spans that touch [startSec, endSec), in the order they are applied. */
export function effectsInWindow(plan: CreatorPlan | undefined, startSec: number, endSec: number): EffectSpan[] {
  if (!plan?.enabled || !plan.effects?.length) return [];
  return plan.effects
    .filter((span) => EFFECTS_BY_ID.has(span.effectId) && span.startSec < endSec && span.endSec > startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

/**
 * The window's effects as one filter fragment (no leading comma), or "" when
 * nothing applies. `labelPrefix` keeps split/overlay labels unique per
 * segment of a concat graph.
 */
export function effectsFilterChain(
  plan: CreatorPlan | undefined,
  windowStartSec: number,
  windowEndSec: number,
  labelPrefix: string
): string {
  const spans = effectsInWindow(plan, windowStartSec, windowEndSec);
  const parts: string[] = [];
  spans.forEach((span, index) => {
    const effect = EFFECTS_BY_ID.get(span.effectId);
    if (!effect) return;
    const a = num(Math.max(0, span.startSec - windowStartSec));
    const b = num(Math.min(windowEndSec - windowStartSec, span.endSec - windowStartSec));
    const input: EffectChainInput = {
      A: Math.max(0, Math.min(1, span.amount)),
      a,
      b,
      E: `enable='between(t,${a},${b})'`,
      prefix: `${labelPrefix}fx${index}`,
      variant: span.variant,
    };
    parts.push(effect.chain(input));
  });
  return parts.join(",");
}
