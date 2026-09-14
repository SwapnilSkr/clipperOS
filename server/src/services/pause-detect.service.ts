import { config } from "../config";
import { Clip, ClipProject } from "../models";
import type { PauseCut, VttWordTiming } from "../types/clip.types";
import { runCommand } from "../utils/process.utils";
import { buildWordTimeline } from "./mining.service";
import { expandWordTimings } from "./transcript.service";

// ============================================
// PAUSE DETECTION — the dead air a Shorts editor would cut.
//
// Word timings carry ONSETS only (no word ends), so a gap between onsets is
// not proof of silence: one long word looks like a gap. The audio track breaks
// the tie — ffmpeg's `silencedetect` finds the spans that are actually quiet,
// and a candidate is the intersection of "no word starts here" and "nothing is
// audible here". A gap with speech in it (a drawn-out word, a laugh) is kept.
//
// Nothing here is applied. Candidates come back disabled-by-default for the
// user (or the Director) to accept.
// ============================================

/** A gap between spoken onsets shorter than this is normal cadence. */
const MIN_GAP_SEC = 0.55;
/** Silence must be at least this long to count. */
const MIN_SILENCE_SEC = 0.38;
/** Keep a little of the pause so the cut breathes rather than clips a syllable. */
const HEAD_PAD_SEC = 0.08;
const TAIL_PAD_SEC = 0.12;
/** silencedetect threshold, relative to full scale. Speech peaks sit far above. */
const SILENCE_DB = -32;

export interface PauseCandidate extends PauseCut {
  /** Seconds the cut would save. */
  savesSec: number;
}

export interface PauseDetectResult {
  startSec: number;
  endSec: number;
  candidates: PauseCandidate[];
  /** Whether the audio was consulted. Without media the word grid alone decides. */
  listened: boolean;
}

interface Span {
  startSec: number;
  endSec: number;
}

/** Parse `silencedetect` stderr into absolute spans. */
export function parseSilenceLog(lines: string[], offsetSec: number): Span[] {
  const out: Span[] = [];
  let openStart: number | null = null;
  for (const line of lines) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      openStart = Number(start[1]) + offsetSec;
      continue;
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end && openStart !== null) {
      out.push({ startSec: openStart, endSec: Number(end[1]) + offsetSec });
      openStart = null;
    }
  }
  return out;
}

/** Gaps between consecutive onsets inside the window that exceed MIN_GAP_SEC. */
export function wordGaps(words: VttWordTiming[], startSec: number, endSec: number): Span[] {
  const onsets = words
    .map((word) => word.t)
    .filter((t) => t >= startSec - 0.05 && t <= endSec)
    .sort((a, b) => a - b);
  const gaps: Span[] = [];
  let previous = startSec;
  for (const t of onsets) {
    if (t - previous >= MIN_GAP_SEC) gaps.push({ startSec: previous, endSec: t });
    previous = t;
  }
  if (endSec - previous >= MIN_GAP_SEC) gaps.push({ startSec: previous, endSec });
  return gaps;
}

/**
 * Intersect onset gaps with silent spans and pad the result inward. When there
 * is no silence information the gap itself is trusted, shortened by a generous
 * allowance for the word that opens it.
 */
export function pauseCandidates(
  gaps: Span[],
  silences: Span[] | null,
  startSec: number,
  endSec: number
): PauseCandidate[] {
  const out: PauseCandidate[] = [];
  let index = 0;
  for (const gap of gaps) {
    const spans: Span[] = [];
    if (silences === null) {
      // The last word before the gap is still being spoken for a while; leave
      // room for it rather than clipping its tail.
      spans.push({ startSec: gap.startSec + 0.32, endSec: gap.endSec });
    } else {
      for (const silence of silences) {
        const from = Math.max(gap.startSec, silence.startSec);
        const to = Math.min(gap.endSec, silence.endSec);
        if (to - from >= MIN_SILENCE_SEC) spans.push({ startSec: from, endSec: to });
      }
    }
    for (const span of spans) {
      const cutStart = Math.max(startSec, span.startSec + HEAD_PAD_SEC);
      const cutEnd = Math.min(endSec, span.endSec - TAIL_PAD_SEC);
      if (cutEnd - cutStart < MIN_SILENCE_SEC - HEAD_PAD_SEC - TAIL_PAD_SEC) continue;
      index += 1;
      out.push({
        id: `pause${index}`,
        startSec: round3(cutStart),
        endSec: round3(cutEnd),
        enabled: false,
        source: "director",
        savesSec: round3(cutEnd - cutStart),
      });
    }
  }
  return out;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Run silencedetect over one window of the source. */
async function detectSilence(mediaPath: string, startSec: number, endSec: number): Promise<Span[]> {
  const lines: string[] = [];
  await runCommand(
    config.ffmpegPath,
    [
      "-hide_banner",
      "-nostats",
      "-ss",
      startSec.toFixed(3),
      "-t",
      Math.max(0.1, endSec - startSec).toFixed(3),
      "-i",
      mediaPath,
      "-vn",
      "-af",
      `silencedetect=noise=${SILENCE_DB}dB:d=${MIN_SILENCE_SEC}`,
      "-f",
      "null",
      "-",
    ],
    { label: "silencedetect", onStderr: (line) => lines.push(line) }
  );
  return parseSilenceLog(lines, startSec);
}

export async function detectClipPauses(
  clipId: string,
  range?: { startSec?: number; endSec?: number }
): Promise<PauseDetectResult> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");
  const project = await ClipProject.findById(clip.projectId)
    .select("wordTimings captions mediaStatus mediaPath")
    .lean();
  if (!project) throw new Error("Project not found");

  const startSec = Number.isFinite(range?.startSec) ? Number(range!.startSec) : clip.edit?.trimStartSec ?? clip.startSec;
  const endSec = Number.isFinite(range?.endSec) ? Number(range!.endSec) : clip.edit?.trimEndSec ?? clip.endSec;
  if (!(endSec - startSec > 0.5)) throw new Error("The window is too short to look for pauses");

  const words = expandWordTimings(
    project.wordTimings?.length
      ? project.wordTimings
      : buildWordTimeline(project.captions ?? []).map((w) => ({ t: w.startSec, word: w.text }))
  );
  const gaps = wordGaps(words, startSec, endSec);

  let silences: Span[] | null = null;
  const canListen = project.mediaStatus === "ready" && Boolean(project.mediaPath) && gaps.length > 0;
  if (canListen) {
    try {
      silences = await detectSilence(project.mediaPath!, startSec, endSec);
    } catch {
      silences = null;
    }
  }

  return {
    startSec,
    endSec,
    candidates: pauseCandidates(gaps, silences, startSec, endSec),
    listened: silences !== null,
  };
}
