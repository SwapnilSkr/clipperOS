import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels } from "../config/models";
import { Clip, ClipProject } from "../models";
import type { CaptionTextOverride, CaptionWordOverride, VttWordTiming } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { fileExists, runCommand, createScratchDir } from "../utils";
import { buildTimelineCaptions, compileGroupEditsToWords } from "./caption.service";
import { expandWordTimings } from "./transcript.service";
import { updateClipEdit } from "./clip.service";

const FILLER = /^(um+|uh+|er+|ah+|hmm+|mm+|uh-huh|mhm)$/i;
const MAX_AUDIO_SEC = 48;

export interface CaptionCleanCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface CaptionCleanResult {
  overrides: CaptionTextOverride[];
  wordOverrides: CaptionWordOverride[];
  changed: number;
  listened: boolean;
}

export function isFillerToken(word: string): boolean {
  return FILLER.test(word.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ""));
}

export function stripCaptionFillers(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word && !isFillerToken(word))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function snapCleanCues(
  raw: Array<{ startSec?: unknown; text?: unknown; hidden?: unknown; endSec?: unknown }>,
  cues: CaptionCleanCue[]
): CaptionTextOverride[] {
  const byStart = new Map(cues.map((cue) => [Math.round(cue.startSec * 1000), cue]));
  const out: CaptionTextOverride[] = [];
  for (const item of raw) {
    const start = Number(item.startSec);
    if (!Number.isFinite(start)) continue;
    let cue = byStart.get(Math.round(start * 1000));
    if (!cue) {
      let best: CaptionCleanCue | undefined;
      let bestDelta = 0.12;
      for (const candidate of cues) {
        const delta = Math.abs(candidate.startSec - start);
        if (delta < bestDelta) {
          best = candidate;
          bestDelta = delta;
        }
      }
      cue = best;
    }
    if (!cue) continue;
    const hidden = Boolean(item.hidden);
    const text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const cleaned = hidden ? "" : stripCaptionFillers(text) || stripCaptionFillers(cue.text);
    if (!cleaned) {
      out.push({ startSec: round3(cue.startSec), endSec: round3(cue.endSec), hidden: true });
      continue;
    }
    const next: CaptionTextOverride = { startSec: round3(cue.startSec), text: cleaned };
    const endSec = Number(item.endSec);
    if (Number.isFinite(endSec) && endSec > cue.startSec + 0.15) next.endSec = round3(endSec);
    if (cleaned !== cue.text || next.endSec !== undefined) out.push(next);
  }
  return out;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildPrompt(input: {
  transcript: string;
  cues: CaptionCleanCue[];
  words: VttWordTiming[];
  listening: boolean;
}): string {
  const cues = input.cues
    .map(
      (cue, index) =>
        `[${index + 1}] ${cue.startSec.toFixed(2)}–${cue.endSec.toFixed(2)}  ${cue.text}`
    )
    .join("\n");
  const words = input.words
    .slice(0, 420)
    .map((word) => `${word.t.toFixed(2)} ${word.word}`)
    .join(" | ");
  return `You clean burned Shorts captions for ONE clip.

JOB
- Fix ASR / auto-caption mistakes using the word grid and transcript.
- Remove hesitation fillers: um, uh, er, ah, hmm, mm. Drop "like" / "you know" / "I mean" only when they are stalling, not meaning.
- Do not invent words, names, numbers, or claims that are not in the transcript or word grid.
- Keep startSec on the same spoken cue. Do not merge cues.
- Hide a cue only when it is entirely filler.
- Keep names and product terms verbatim.

${input.listening ? "You also have the clip audio. Prefer what you hear when the text and audio disagree." : "No audio attached — use the word grid and transcript only."}

CUES
${cues}

WORD GRID
${words}

TRANSCRIPT
${input.transcript.slice(0, 3500)}

Return only JSON: {"cues":[{"startSec":12.4,"text":"people should decide","hidden":false}]}`;
}

function localClean(cues: CaptionCleanCue[]): CaptionTextOverride[] {
  const out: CaptionTextOverride[] = [];
  for (const cue of cues) {
    const text = stripCaptionFillers(cue.text);
    if (!text) out.push({ startSec: round3(cue.startSec), hidden: true });
    else if (text !== cue.text) out.push({ startSec: round3(cue.startSec), text });
  }
  return out;
}

async function extractClipAudio(
  mediaPath: string,
  startSec: number,
  durationSec: number
): Promise<Buffer | null> {
  const dir = await createScratchDir("caption-listen");
  const dest = join(dir, "clip.mp3");
  try {
    await runCommand(
      config.ffmpegPath,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        startSec.toFixed(3),
        "-t",
        Math.min(MAX_AUDIO_SEC, Math.max(0.4, durationSec)).toFixed(3),
        "-i",
        mediaPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "32k",
        dest,
      ],
      { label: "caption listen" }
    );
    return await readFile(dest);
  } catch (error: unknown) {
    console.warn(`⚠️  Caption listen skipped: ${getErrorMessage(error)}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function askModel(
  prompt: string,
  audio: Buffer | null
): Promise<CaptionTextOverride[] | null> {
  if (!config.openRouterApiKey) return null;
  const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });
  const model = openrouter(resolveModels("cheap").llm);
  try {
    const content = audio
      ? [
          { type: "text" as const, text: prompt },
          { type: "file" as const, data: audio, mediaType: "audio/mpeg" },
        ]
      : prompt;
    const { text } = await generateText({
      model,
      ...(typeof content === "string" ? { prompt: content } : { messages: [{ role: "user", content }] }),
      temperature: 0.2,
      maxOutputTokens: 1200,
    });
    const parsed = extractJson(text ?? "");
    const cues = parsed?.cues;
    return Array.isArray(cues) ? (cues as CaptionTextOverride[]) : null;
  } catch (error: unknown) {
    if (audio) {
      console.warn(`⚠️  Caption listen failed, retrying text-only: ${getErrorMessage(error)}`);
      return askModel(prompt, null);
    }
    console.warn(`⚠️  Caption clean failed: ${getErrorMessage(error)}`);
    return null;
  }
}

function mergeWordOverrides(
  existing: CaptionWordOverride[] | undefined,
  cleaned: CaptionWordOverride[],
  windowStart: number,
  windowEnd: number
): CaptionWordOverride[] {
  const kept = (existing ?? []).filter((item) => item.t < windowStart - 0.05 || item.t > windowEnd + 0.05);
  const map = new Map<number, CaptionWordOverride>();
  for (const item of [...kept, ...cleaned]) {
    map.set(Math.round(item.t * 1000), item);
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

export async function cleanClipCaptions(
  clipId: string,
  input: { startSec?: number; endSec?: number; chunkWords?: number; listen?: boolean } = {}
): Promise<CaptionCleanResult> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");
  const project = await ClipProject.findById(clip.projectId);
  if (!project) throw new Error("Project not found");

  const startSec = Number.isFinite(input.startSec)
    ? Number(input.startSec)
    : (clip.edit?.trimStartSec ?? clip.startSec);
  const endSec = Number.isFinite(input.endSec)
    ? Number(input.endSec)
    : (clip.edit?.trimEndSec ?? clip.endSec);
  const duration = Math.max(0.2, endSec - startSec);

  const words: VttWordTiming[] = expandWordTimings(project.wordTimings ?? []).filter(
    (word) => word.t >= startSec - 0.05 && word.t <= endSec
  );
  if (words.length === 0) throw new Error("This clip has no word timings to clean");

  const styleChunk =
    input.chunkWords ??
    clip.edit?.captionOverrides?.chunkWords ??
    3;
  const raw = buildTimelineCaptions(
    words,
    startSec,
    duration,
    clip.peakLine,
    clip.peakSec,
    styleChunk,
    (clip.edit?.captionTextOverrides ?? []).filter((item) => item.custom),
    false,
    clip.edit?.captionWordOverrides ?? []
  );
  const cues: CaptionCleanCue[] = raw.map((cue) => ({
    startSec: startSec + cue.start,
    endSec: startSec + cue.end,
    text: cue.text,
  }));
  if (cues.length === 0) throw new Error("No captions in this window");

  let audio: Buffer | null = null;
  const wantListen = input.listen !== false;
  if (wantListen && project.mediaPath && (await fileExists(project.mediaPath))) {
    audio = await extractClipAudio(project.mediaPath, startSec, duration);
  }

  const prompt = buildPrompt({
    transcript: clip.transcript,
    cues,
    words,
    listening: Boolean(audio),
  });
  const modelCues = await askModel(prompt, audio);
  const cleaned = modelCues ? snapCleanCues(modelCues, cues) : localClean(cues);
  const wordOverrides = mergeWordOverrides(
    clip.edit?.captionWordOverrides,
    compileGroupEditsToWords(words, cleaned),
    startSec,
    endSec
  );
  const overrides = (clip.edit?.captionTextOverrides ?? []).filter((item) => item.custom);
  await updateClipEdit(clipId, { edit: { captionTextOverrides: overrides, captionWordOverrides: wordOverrides } });
  return { overrides, wordOverrides, changed: cleaned.length, listened: Boolean(audio) };
}
