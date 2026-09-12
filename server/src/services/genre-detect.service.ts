import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels } from "../config/models";
import { DEFAULT_GENRE_ID, isKnownGenre, listGenreProfiles } from "../config/genres";
import { getErrorMessage } from "../types";

// ============================================
// GENRE DETECTION
//
// One cheap call decides which editorial rules to mine with. Without this, a
// stand-up set gets judged by "does it contain a hard truth" and returns nothing.
//
// Detection reads the title, the channel, and a slice of the transcript — the
// title alone is often enough ("Full Stand-Up Special" vs "The Science of
// Discipline"), and the transcript slice disambiguates the rest.
//
// Best-effort by construction: any failure falls back to the default genre
// rather than failing the project. A wrong genre is recoverable (re-mine with an
// explicit one); a failed import is not.
// ============================================

/** Characters of transcript to sample. Enough to hear the register, cheap to send. */
const SAMPLE_CHARS = 2000;

const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });

export interface GenreDetection {
  genreId: string;
  /** True when the model was actually consulted; false means the fallback ran. */
  detected: boolean;
  confidence?: number;
  reason?: string;
}

export interface DetectGenreInput {
  title: string;
  channelTitle?: string;
  /** Full transcript cues; only a slice is read. */
  transcriptSample: string;
}

/**
 * Infer the genre profile for a piece of content.
 *
 * Never throws — a detection failure is not a reason to fail an import.
 */
export async function detectGenre(input: DetectGenreInput): Promise<GenreDetection> {
  const profiles = listGenreProfiles();
  const sample = input.transcriptSample.slice(0, SAMPLE_CHARS).replace(/\s+/g, " ").trim();

  const catalog = profiles
    .map((p) => `- ${p.id}: ${p.label} — ${p.summary}`)
    .join("\n");

  const prompt = `You are choosing which editorial ruleset should be used to cut short-form clips from a video.

Pick EXACTLY ONE genre from this list:
${catalog}

Choose by what makes a GOOD CLIP in this content, not by surface topic words. A funny podcast is "comedy_talk" even if the episode discusses discipline; a keynote about teamwork is "motivation" even if it is delivered on a stage with a band.

TITLE: ${input.title}
CHANNEL: ${input.channelTitle || "(unknown)"}

TRANSCRIPT SAMPLE:
${sample || "(no transcript available — judge from the title alone)"}

OUTPUT JSON ONLY:
{"genre": "<one of the ids above>", "confidence": 0.0-1.0, "reason": "one short clause"}`;

  try {
    const { text } = await generateText({
      model: openrouter(resolveModels().llm),
      prompt,
      temperature: 0,
      maxOutputTokens: 200,
    });

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no JSON object in response");

    const parsed = JSON.parse(match[0]) as {
      genre?: string;
      confidence?: number;
      reason?: string;
    };

    const genreId = String(parsed.genre ?? "").trim();
    if (!isKnownGenre(genreId)) {
      throw new Error(`model returned an unknown genre: "${genreId}"`);
    }

    return {
      genreId,
      detected: true,
      confidence: Number.isFinite(Number(parsed.confidence))
        ? Math.max(0, Math.min(1, Number(parsed.confidence)))
        : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : undefined,
    };
  } catch (error: unknown) {
    console.warn(
      `⚠️  Genre detection failed, falling back to "${DEFAULT_GENRE_ID}". Cause: ${getErrorMessage(error)}`
    );
    return { genreId: DEFAULT_GENRE_ID, detected: false };
  }
}
