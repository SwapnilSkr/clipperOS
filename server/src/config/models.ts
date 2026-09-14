// ============================================
// OpenRouter model registry — the ONE place to swap models.
//
// Override precedence: per-field env var > tier default.
//   MODEL_TIER=cheap|value|premium
//   LLM_MODEL / VISION_MODEL override individual fields regardless of tier.
// ============================================

import { config } from "./index";

export type Tier = "cheap" | "value" | "premium";

export interface ModelSet {
  /** Transcript reasoning: what qualifies, peak location, scoring. */
  llm: string;
  /** Frame understanding for smart reframing. */
  vision: string;
}

const REGISTRY: Record<Tier, ModelSet> = {
  cheap: {
    // Latency is the selection criterion here, not price: mining a long episode
    // is ~11 parallel calls and the user is waiting on the clip board.
    // flash-lite measured ~0.6s per call vs ~3.5s for deepseek-v4-flash, and
    // both are fractions of a cent per episode.
    llm: "google/gemini-2.5-flash-lite",
    vision: "google/gemini-2.5-flash",
  },
  value: {
    llm: "google/gemini-2.5-flash",
    vision: "google/gemini-2.5-flash",
  },
  premium: {
    llm: "google/gemini-2.5-pro",
    vision: "google/gemini-2.5-pro",
  },
};

const ENV_TIER = (process.env.MODEL_TIER as Tier) || "cheap";

export function resolveModels(tier: Tier = ENV_TIER): ModelSet {
  const base = REGISTRY[tier] ?? REGISTRY.cheap;
  return {
    llm: config.llmModelOverride || base.llm,
    vision: config.visionModelOverride || base.vision,
  };
}

/**
 * The creator-mode Director writes a whole beat plan in one call, so it gets a
 * stronger model than the latency-driven mining default. `DIRECTOR_MODEL`
 * overrides it independently of `LLM_MODEL`.
 */
export function directorModel(): string {
  return process.env.DIRECTOR_MODEL?.trim() || REGISTRY.value.llm;
}
