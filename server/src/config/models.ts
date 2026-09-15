// ============================================
// OpenRouter model registry — the ONE place to swap models.
//
// Override precedence: per-field env var > tier default.
//   MODEL_TIER=cheap|value|premium
//   LLM_MODEL / VISION_MODEL override individual fields regardless of tier.
//
// The Director's harness has its own slots (DIRECTOR_MODEL, SENSE_MODEL,
// IMAGE_MODEL, VIDEO_MODEL, MUSIC_MODEL): a model that watches video and
// listens to audio, and the generators the asset studio calls.
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
 * The Director watches the clip and listens to the library, so it needs a
 * model with video and audio INPUT on OpenRouter. Gemini 3.8 Flash takes
 * text, image, video, file and audio (checked against /api/v1/models on
 * 2026-09-15: a base64 mp4 as a `video_url` part routes to Google Vertex and
 * costs ~55 video + 25 audio tokens per second). `DIRECTOR_MODEL` overrides it.
 */
export function directorModel(): string {
  return process.env.DIRECTOR_MODEL?.trim() || "google/gemini-3.8-flash";
}

/** Describing what a clip, a sound or a picture is — same family, cheap, multimodal. */
export function senseModel(): string {
  return process.env.SENSE_MODEL?.trim() || directorModel();
}

/** Stills for cutaways and motion assets (`modalities: ["image","text"]` on chat/completions). */
export function imageModel(): string {
  return process.env.IMAGE_MODEL?.trim() || "google/gemini-3.1-flash-image";
}

/** Video from a prompt or a still (`POST /api/v1/videos`, polled). */
export function videoModel(): string {
  return process.env.VIDEO_MODEL?.trim() || "minimax/hailuo-3-max";
}

/** Music beds (`modalities: ["audio","text"]`, streamed). */
export function musicModel(): string {
  return process.env.MUSIC_MODEL?.trim() || "google/lyria-3-pro-preview";
}
