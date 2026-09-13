import type { CaptionOverrides, CaptionStyleInfo, CaptionTextOverride } from "@/api";

// ============================================================
// CAPTION PREVIEW
//
// A faithful port of the server's grouping (services/caption.service.ts:
// buildTimelineCaptions + resolvePeakWindow). It exists so the editor can
// regroup and restyle captions on every keystroke with no network round-trip —
// the server is still the only thing that BURNS them, so the two must agree.
//
// If the grouping rule changes on the server, change it here too. The contract
// is the word onsets and the chunk size; everything else is presentation.
// ============================================================

export interface PreviewCaption {
  /** Seconds on the CLIP's timeline. */
  start: number;
  end: number;
  text: string;
  emphasis: boolean;
  /** Absolute source time used as the stable edit key. */
  sourceStartSec: number;
  /** Absolute displayed end time. */
  sourceEndSec: number;
  editId: string;
  custom: boolean;
}

export interface WordTiming {
  t: number;
  word: string;
}

/**
 * Mirrors server/src/types/clip.types.ts. The burned captions are laid out in
 * these units, so the preview has to use the same ones or it would misrepresent
 * what renders.
 */
export const OUTPUT_HEIGHT = 1920;
export const CAPTION_BASE_FONT = 70;
export const PEAK_BASE_FONT = 91;

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Group word onsets into caption chunks on the clip timeline.
 *
 * `peakSec` marks the peak so the words landing on it get the emphasis style.
 * The window is resolved from the real word grid rather than by string-matching
 * the peak text: chunks are a few words wide and start at arbitrary offsets, so
 * a prefix test against the peak's opening words almost never lines up.
 */
export function buildTimelineCaptions(
  wordTimings: WordTiming[],
  clipStartSec: number,
  duration: number,
  peakLine?: string,
  peakSec?: number,
  chunkSize = 3,
  textOverrides: CaptionTextOverride[] = [],
  peakEmphasis = true
): PreviewCaption[] {
  const inClip = wordTimings
    .map((w) => ({ t: w.t - clipStartSec, word: w.word }))
    .filter((w) => w.t >= -0.05 && w.t <= duration);
  const peakWindow = peakEmphasis ? resolvePeakWindow(inClip, duration, peakLine, peakSec) : null;
  const overrideByStart = new Map(
    textOverrides
      .filter((item) => !item.custom)
      .map((item) => [Math.round(item.startSec * 1000), item])
  );

  const size = Math.max(1, Math.round(chunkSize));
  const out: PreviewCaption[] = [];
  for (let i = 0; i < inClip.length; ) {
    const sourceStartSec = clipStartSec + Math.max(0, inClip[i]!.t);
    const edit = overrideByStart.get(Math.round(sourceStartSec * 1000));
    const take = edit?.hidden ? 1 : size;
    const group = inClip.slice(i, i + take);
    const start = Math.max(0, group[0]!.t);
    const next = inClip[i + take];
    const end = Math.min(duration, next ? next.t : start + 1.1);
    i += take;
    if (end <= start) continue;
    if (edit?.hidden) continue;
    const displayedSourceStart = edit?.displayStartSec ?? sourceStartSec;
    const displayedSourceEnd = edit?.endSec ?? clipStartSec + end;
    const displayedStart = Math.max(0, displayedSourceStart - clipStartSec);
    const displayedEnd = Math.min(duration, displayedSourceEnd - clipStartSec);
    const text = edit?.text ?? group.map((g) => g.word).join(" ");
    if (displayedEnd <= displayedStart || !text.trim()) continue;
    out.push({
      start: displayedStart,
      end: displayedEnd,
      text,
      emphasis:
        peakWindow !== null && displayedEnd > peakWindow.start && displayedStart < peakWindow.end,
      sourceStartSec,
      sourceEndSec: displayedSourceEnd,
      editId: `generated:${Math.round(sourceStartSec * 1000)}`,
      custom: false,
    });
  }

  for (const edit of textOverrides) {
    if (!edit.custom || edit.hidden || !edit.text?.trim()) continue;
    const absoluteEnd = edit.endSec ?? edit.startSec + 1.5;
    if (absoluteEnd <= clipStartSec || edit.startSec >= clipStartSec + duration) continue;
    const start = Math.max(0, edit.startSec - clipStartSec);
    const end = Math.min(duration, absoluteEnd - clipStartSec);
    if (end <= start) continue;
    out.push({
      start,
      end,
      text: edit.text,
      emphasis: peakWindow !== null && end > peakWindow.start && start < peakWindow.end,
      sourceStartSec: edit.startSec,
      sourceEndSec: absoluteEnd,
      editId: `custom:${edit.id ?? Math.round(edit.startSec * 1000)}`,
      custom: true,
    });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function resolvePeakWindow(
  inClip: { t: number; word: string }[],
  duration: number,
  peakLine?: string,
  peakSec?: number
): { start: number; end: number } | null {
  const peakWords = peakLine ? normalizeWords(peakLine) : [];

  let startIdx = -1;
  if (peakSec !== undefined && Number.isFinite(peakSec)) {
    startIdx = inClip.findIndex((w) => w.t >= peakSec - 0.05);
  }
  if (startIdx < 0 && peakWords.length > 0) {
    const probe = peakWords.slice(0, Math.min(4, peakWords.length));
    for (let i = 0; i + probe.length <= inClip.length; i++) {
      let ok = true;
      for (let j = 0; j < probe.length; j++) {
        if (normalizeWord(inClip[i + j].word) !== probe[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx < 0) return null;

  const start = Math.max(0, inClip[startIdx].t);
  const spanWords = Math.max(1, peakWords.length);
  const afterIdx = startIdx + spanWords;
  const end =
    afterIdx < inClip.length
      ? Math.min(duration, inClip[afterIdx].t)
      : Math.min(duration, start + 2.5);

  if (!(end > start)) return null;
  return { start, end };
}

/** The caption look actually in force: preset with the clip's overrides on top. */
export function effectiveCaptionStyle(
  style: CaptionStyleInfo,
  overrides?: CaptionOverrides
): CaptionStyleInfo {
  if (!overrides) return style;
  return {
    ...style,
    chunkWords: overrides.chunkWords ?? style.chunkWords,
    sizeScale: overrides.sizeScale ?? style.sizeScale,
    verticalFrac: overrides.verticalFrac ?? style.verticalFrac,
    horizontalFrac: overrides.horizontalFrac ?? style.horizontalFrac,
    textColor: overrides.textColor ?? style.textColor,
    background: overrides.background ?? style.background,
    animation: overrides.animation ?? style.animation,
    peakColor: overrides.peakColor ?? style.peakColor,
    fontFamily: overrides.fontFamily ?? style.fontFamily,
    uppercase: overrides.uppercase ?? style.uppercase,
  };
}

/** The caption on screen at `time` (clip-local seconds), if any. */
export function captionAt(captions: PreviewCaption[], time: number): PreviewCaption | null {
  for (const caption of captions) {
    if (time >= caption.start && time < caption.end) return caption;
  }
  return null;
}
