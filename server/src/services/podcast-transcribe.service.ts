import { access } from "node:fs/promises";
import { config } from "../config";
import type { CaptionCue } from "../types/clip.types";
import { runWhisper } from "./forced-alignment.service";

// ============================================
// WHISPER TRANSCRIPTION FALLBACK
//
// Produces cues in the SAME shape as the YouTube caption path, so mining and
// everything downstream run unchanged. Each recognised word becomes one cue
// with an exact onset — the closest analog to YouTube's inline word timings,
// and the per-word precision peak location depends on.
//
// Best-effort: throws a clear, actionable error when the CLI/model is missing.
// The caller degrades gracefully (the project still imports, just captionless).
// ============================================

/** Below this a whisper "word" window is a spurious sliver, not real speech. */
const MIN_WORD_SEC = 0.001;

export async function transcribeWithWhisper(audioPath: string): Promise<CaptionCue[]> {
  try {
    await access(config.whisperModelPath);
  } catch {
    throw new Error(
      `Whisper model not found at ${config.whisperModelPath}. ` +
        `Run \`bun run whisper:install\`, then set WHISPER_ALIGNMENT_ENABLED=true.`
    );
  }

  const recognized = await runWhisper(audioPath);
  if (!recognized?.length) return [];

  const cues: CaptionCue[] = [];
  for (const { word, start, end } of recognized) {
    const text = word.trim();
    if (!text) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const startSec = Math.max(0, start);
    const endSec = Math.max(end, startSec + MIN_WORD_SEC);
    cues.push({ startSec, endSec, text });
  }

  cues.sort((a, b) => a.startSec - b.startSec);
  return cues;
}
