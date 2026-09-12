import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { createScratchDir } from "../utils";

// ============================================
// Local whisper.cpp wrapper — the caption-less fallback.
//
// YouTube auto-captions are the primary transcript source (free, instant, and
// word-timed). Whisper only runs when a source has NO usable captions at all:
// a podcast upload with no subtitle track, or a video whose auto-captions
// YouTube never generated.
//
// Opt-in by design (WHISPER_ALIGNMENT_ENABLED): local dev gains no hidden
// 142 MB model download. `bun run whisper:install` fetches the CLI + model.
// ============================================

export interface RecognizedWord {
  word: string;
  start: number;
  end: number;
}

/**
 * Run whisper.cpp over `audioPath` and flatten its word-sized JSON segments.
 * THROWS when the binary/model is missing so callers can surface an actionable
 * message rather than an opaque spawn failure.
 */
export async function runWhisper(audioPath: string): Promise<RecognizedWord[] | null> {
  await Promise.all([access(audioPath), access(config.whisperModelPath)]);
  const root = await createScratchDir("whisper");
  const wavPath = join(root, "audio.wav");
  const outputBase = join(root, "transcript");

  try {
    // whisper.cpp is most portable with 16 kHz mono PCM.
    await runCommand(config.ffmpegPath, [
      "-y", "-v", "error", "-i", audioPath,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath,
    ]);
    await runCommand(config.whisperCliPath, [
      "-m", config.whisperModelPath,
      "-f", wavPath,
      "-l", "en",
      "-ml", "1", // one output segment per recognised word
      "-sow", // never split a word at a token boundary
      "-oj",
      "-of", outputBase,
      "-np",
    ]);
    return parseWhisperWords(JSON.parse(await readFile(`${outputBase}.json`, "utf8")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? "unknown"}: ${stderr.slice(-500)}`));
    });
  });
}

function parseWhisperWords(result: unknown): RecognizedWord[] | null {
  const record = result as { transcription?: unknown; words?: unknown } | null;
  if (!record) return null;

  const rawWords = Array.isArray(record.words)
    ? record.words
    : Array.isArray(record.transcription)
      ? (record.transcription as unknown[]).flatMap((seg) => {
          const s = seg as { words?: unknown; text?: unknown; timestamps?: unknown };
          return Array.isArray(s.words) ? s.words : s.text && s.timestamps ? [s] : [];
        })
      : [];

  const words: RecognizedWord[] = [];
  for (const entry of rawWords) {
    const w = entry as {
      word?: string;
      text?: string;
      start?: number | string;
      end?: number | string;
      offsets?: { from?: number; to?: number };
      timestamps?: { from?: string; to?: string };
    };
    const text = (w.word ?? w.text ?? "").toString().trim();
    if (!text) continue;
    const start = w.timestamps?.from !== undefined
      ? toTimestampSeconds(w.timestamps.from)
      : w.offsets?.from !== undefined
        ? Number(w.offsets.from) / 1000
        : toSeconds(w.start);
    const end = w.timestamps?.to !== undefined
      ? toTimestampSeconds(w.timestamps.to)
      : w.offsets?.to !== undefined
        ? Number(w.offsets.to) / 1000
        : toSeconds(w.end);
    if (start === undefined || end === undefined) continue;
    words.push({ word: text, start, end });
  }
  return words.length ? words : null;
}

function toSeconds(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : undefined;
}

function toTimestampSeconds(value: string): number | undefined {
  if (!/^\d\d:\d\d:\d\d[.,]\d+$/u.test(value)) return undefined;
  const [hours, minutes, seconds] = value.replace(",", ".").split(":");
  const n = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(n) ? n : undefined;
}
