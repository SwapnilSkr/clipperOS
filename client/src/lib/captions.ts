import type {
  CaptionOverrides,
  CaptionStyleInfo,
  CaptionTextOverride,
  CaptionWordOverride,
} from "@/api";

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

export interface WordTiming {
  t: number;
  word: string;
}

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
  /** Absolute source onsets in this group. Empty for a custom cue. */
  words: WordTiming[];
}

/**
 * Mirrors server/src/types/clip.types.ts. The burned captions are laid out in
 * these units, so the preview has to use the same ones or it would misrepresent
 * what renders.
 */
export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;
export const CAPTION_BASE_FONT = 70;
export const PEAK_BASE_FONT = 91;

/** Split a phrase stored on one onset so words-per-caption can go to 1. */
export function expandWordTimings(words: WordTiming[]): WordTiming[] {
  const sorted = words
    .filter((item) => item && Number.isFinite(item.t) && item.word?.trim())
    .sort((a, b) => a.t - b.t);
  const out: WordTiming[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const tokens = sorted[i]!.word.trim().split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) {
      out.push({ t: sorted[i]!.t, word: tokens[0] ?? sorted[i]!.word });
      continue;
    }
    const nextT = sorted[i + 1]?.t;
    const span =
      nextT != null && nextT > sorted[i]!.t + 0.04
        ? nextT - sorted[i]!.t
        : Math.max(0.14 * tokens.length, 0.28);
    const step = span / tokens.length;
    for (let k = 0; k < tokens.length; k++) {
      out.push({ t: Math.round((sorted[i]!.t + step * k) * 1000) / 1000, word: tokens[k]! });
    }
  }
  return out;
}

const AFTER_WORD_PAD_SEC = 0.04;
const MIN_WORD_HOLD_SEC = 0.36;
const MAX_WORD_HOLD_SEC = 1.15;

function clipCaptionEnd(start: number, nextT: number | undefined, duration: number): number {
  const cap = Math.max(start + 0.04, duration - AFTER_WORD_PAD_SEC);
  const natural = nextT != null ? Math.min(nextT, start + MAX_WORD_HOLD_SEC) : start + MIN_WORD_HOLD_SEC;
  return Math.min(cap, natural);
}

function msKey(t: number): number {
  return Math.round(t * 1000);
}

function tokenizeCaption(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function alignKey(word: string): string {
  return normalizeWord(word) || word.toLowerCase();
}

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9']/g, "");
}

/** Spread edited tokens across the onsets they were typed over. */
export function assignTokensToWords(
  targets: WordTiming[],
  tokens: string[]
): CaptionWordOverride[] {
  if (targets.length === 0) return [];
  if (tokens.length === 0) return targets.map((word) => ({ t: word.t, hidden: true }));
  if (tokens.length <= targets.length) {
    return targets.map((word, i) =>
      i < tokens.length ? { t: word.t, word: tokens[i] } : { t: word.t, hidden: true }
    );
  }
  return targets.map((word, i) =>
    i < targets.length - 1
      ? { t: word.t, word: tokens[i] }
      : { t: word.t, word: tokens.slice(i).join(" ") }
  );
}

/** Turn older group-level subtitle edits into word patches. */
export function compileGroupEditsToWords(
  words: WordTiming[],
  groupEdits: CaptionTextOverride[]
): CaptionWordOverride[] {
  const out: CaptionWordOverride[] = [];
  for (const edit of groupEdits) {
    if (edit.custom) continue;
    const start = edit.startSec;
    const from = words.findIndex((word) => word.t >= start - 0.05);
    if (from < 0) continue;
    const spanned =
      edit.endSec != null && Number.isFinite(edit.endSec)
        ? words.filter((word) => word.t >= start - 0.02 && word.t < edit.endSec! - 0.001)
        : [];
    if (edit.hidden) {
      const hide = spanned.length > 0 ? spanned : words.slice(from, from + 1);
      for (const word of hide) out.push({ t: word.t, hidden: true });
      continue;
    }
    const tokens = tokenizeCaption(edit.text ?? "");
    if (tokens.length === 0) continue;
    const targets = spanned.length > 0 ? spanned : words.slice(from, from + tokens.length);
    out.push(...assignTokensToWords(targets, tokens));
  }
  return out;
}

function mergeWordPatches(patches: CaptionWordOverride[]): Map<number, CaptionWordOverride> {
  const map = new Map<number, CaptionWordOverride>();
  for (const item of patches) {
    if (!Number.isFinite(item.t)) continue;
    const key = msKey(item.t);
    const prev = map.get(key);
    map.set(key, prev ? { ...prev, ...item, t: item.t } : item);
  }
  return map;
}

/** Bind stored word/group edits onto the spoken onsets. */
export function applyCaptionWords(
  words: WordTiming[],
  wordOverrides: CaptionWordOverride[] = [],
  groupEdits: CaptionTextOverride[] = []
): WordTiming[] {
  const base = expandWordTimings(words);
  const patches = mergeWordPatches([
    ...compileGroupEditsToWords(base, groupEdits),
    ...wordOverrides,
  ]);
  const next: WordTiming[] = [];
  for (const word of base) {
    const edit = patches.get(msKey(word.t));
    if (edit?.hidden) continue;
    const text = edit?.word?.trim();
    next.push({ t: word.t, word: text || word.word });
  }
  return expandWordTimings(next);
}

function lcsAlign(a: string[], b: string[]): Array<{ oldIdx?: number; newIdx?: number }> {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const ops: Array<{ oldIdx?: number; newIdx?: number }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ newIdx: j - 1 });
      j--;
    } else {
      ops.push({ oldIdx: i - 1 });
      i--;
    }
  }
  return ops.reverse();
}

/**
 * Align an edited transcript to the existing word onsets. Extra words hang on
 * the previous timestamp and are spread until the next spoken word. Words typed
 * before the first onset stay on that first onset — they must not be appended
 * after it, or the first-word edit jumps later in the line.
 */
export function bindTranscriptToTimings(
  words: WordTiming[],
  transcript: string
): CaptionWordOverride[] {
  const oldWords = expandWordTimings(words).filter((word) => word.word.trim());
  const newTokens = tokenizeCaption(transcript);
  if (oldWords.length === 0) return [];
  if (newTokens.length === 0) return oldWords.map((word) => ({ t: word.t, hidden: true }));

  const ops = lcsAlign(oldWords.map((word) => alignKey(word.word)), newTokens.map(alignKey));
  const extras = new Map<number, { before: string[]; after: string[] }>();
  const out = new Map<number, CaptionWordOverride>();
  let lastKept = -1;

  for (const step of ops) {
    if (step.oldIdx != null && step.newIdx != null) {
      lastKept = step.oldIdx;
      const orig = oldWords[step.oldIdx]!;
      const next = newTokens[step.newIdx]!;
      if (orig.word !== next) out.set(msKey(orig.t), { t: orig.t, word: next });
    } else if (step.oldIdx != null) {
      const orig = oldWords[step.oldIdx]!;
      out.set(msKey(orig.t), { t: orig.t, hidden: true });
    } else if (step.newIdx != null) {
      const token = newTokens[step.newIdx]!;
      const attach = lastKept >= 0 ? lastKept : 0;
      const bucket = extras.get(attach) ?? { before: [], after: [] };
      if (lastKept >= 0) bucket.after.push(token);
      else bucket.before.push(token);
      extras.set(attach, bucket);
    }
  }

  for (const [oldIdx, extra] of extras) {
    const orig = oldWords[oldIdx]!;
    const key = msKey(orig.t);
    const existing = out.get(key);
    const nextWords = existing?.hidden
      ? [...extra.before, ...extra.after]
      : [...extra.before, existing?.word ?? orig.word, ...extra.after];
    if (nextWords.length === 0) continue;
    out.set(key, { t: orig.t, word: nextWords.join(" ") });
  }

  return [...out.values()].sort((a, b) => a.t - b.t);
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
  peakEmphasis = true,
  wordOverrides: CaptionWordOverride[] = []
): PreviewCaption[] {
  const prepared = applyCaptionWords(wordTimings, wordOverrides, textOverrides);
  const inClip = prepared
    .map((w) => ({ t: w.t - clipStartSec, word: w.word }))
    .filter((w) => w.t >= -0.05 && w.t < duration - AFTER_WORD_PAD_SEC);
  const peakWindow = peakEmphasis ? resolvePeakWindow(inClip, duration, peakLine, peakSec) : null;

  const size = Math.max(1, Math.round(chunkSize));
  const out: PreviewCaption[] = [];
  for (let i = 0; i < inClip.length; ) {
    const take = Math.min(size, inClip.length - i);
    const group = inClip.slice(i, i + take);
    const sourceStartSec = clipStartSec + Math.max(0, group[0]!.t);
    const start = Math.max(0, group[0]!.t);
    const next = inClip[i + take];
    const lastAbs = clipStartSec + group[group.length - 1]!.t;
    const following = next ? undefined : prepared.find((word) => word.t > lastAbs + 0.001);
    const nextT = next != null ? next.t : following != null ? following.t - clipStartSec : undefined;
    const end = clipCaptionEnd(start, nextT, duration);
    i += take;
    if (end <= start) continue;
    const text = group.map((g) => g.word).join(" ");
    if (!text.trim()) continue;
    out.push({
      start,
      end,
      text,
      emphasis: peakWindow !== null && end > peakWindow.start && start < peakWindow.end,
      sourceStartSec,
      sourceEndSec: clipStartSec + end,
      editId: `generated:${Math.round(sourceStartSec * 1000)}`,
      custom: false,
      words: group.map((item) => ({ t: clipStartSec + item.t, word: item.word })),
    });
  }

  for (const edit of textOverrides) {
    if (!edit.custom || edit.hidden || !edit.text?.trim()) continue;
    const absoluteEnd = edit.endSec ?? edit.startSec + 1.5;
    if (absoluteEnd <= clipStartSec || edit.startSec >= clipStartSec + duration) continue;
    const start = Math.max(0, edit.startSec - clipStartSec);
    const end = Math.min(duration - AFTER_WORD_PAD_SEC, absoluteEnd - clipStartSec);
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
      words: [],
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
