import {
  ASS_FONT_SIZE_MATCH,
  CAPTION_BASE_FONT,
  CAPTION_VERTICAL_FRAC,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  PEAK_BASE_FONT,
  PEAK_COLOR,
  type CaptionTextOverride,
  type CaptionWordOverride,
  type TimelineCaption,
  type VttWordTiming,
} from "../types/clip.types";
import type { CaptionStyle } from "../config/caption-styles";
import { resolveCaptionFont } from "../config/caption-fonts";
import { expandWordTimings } from "./transcript.service";

// ============================================
// CAPTIONS
//
// Imported speech gives us REAL word onsets — YouTube's inline caption tags, or
// Whisper's one-word-per-cue output — so captions need no estimation: we group
// the actual onsets and render them with libass.
//
// Captions are optional per genre. A talking-head clip is unwatchable muted
// without them; a football highlight or a live set usually reads better clean.
// The genre profile decides, and the renderer simply skips the burn.
// ============================================

const DEFAULT_CHUNK_SIZE = 3;
/** One clean frame after the last spoken word, before a hard outro cut. */
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

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Spread edited tokens across the onsets they were typed over. */
export function assignTokensToWords(
  targets: VttWordTiming[],
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
  words: VttWordTiming[],
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
  words: VttWordTiming[],
  wordOverrides: CaptionWordOverride[] = [],
  groupEdits: CaptionTextOverride[] = []
): VttWordTiming[] {
  const base = expandWordTimings(words);
  const patches = mergeWordPatches([
    ...compileGroupEditsToWords(base, groupEdits),
    ...wordOverrides,
  ]);
  const next: VttWordTiming[] = [];
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
  words: VttWordTiming[],
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

/**
 * Group real word onsets into caption chunks on the CLIP timeline.
 *
 * `peakSec` (source time) marks the peak window so the words landing on it get
 * the emphasis style. We resolve that window from the real word grid rather than
 * string-matching the peak text: chunks are a few words wide and start at
 * arbitrary offsets, so a prefix test against the peak's opening words almost
 * never lines up.
 *
 * `peakLine` is optional — a moment peak may have no words at all.
 */
/**
 * A caption scene as the grouper sees it: a source span with its own words
 * per caption. A word belongs to the scene its onset falls in; a group never
 * crosses a scene boundary, so each scene's look starts on a fresh caption.
 */
export interface CaptionSceneSpan {
  id: string;
  startSec: number;
  endSec: number;
  chunkWords: number;
}

export function sceneAt(scenes: CaptionSceneSpan[] | undefined, sourceSec: number): CaptionSceneSpan | undefined {
  return scenes?.find((scene) => sourceSec >= scene.startSec && sourceSec < scene.endSec);
}

export function buildTimelineCaptions(
  wordTimings: VttWordTiming[],
  clipStartSec: number,
  duration: number,
  peakLine?: string,
  peakSec?: number,
  chunkSize = DEFAULT_CHUNK_SIZE,
  textOverrides: CaptionTextOverride[] = [],
  peakEmphasis = true,
  wordOverrides: CaptionWordOverride[] = [],
  scenes?: CaptionSceneSpan[]
): TimelineCaption[] {
  const prepared = applyCaptionWords(wordTimings, wordOverrides, textOverrides);
  const inClip = prepared
    .map((w) => ({ t: w.t - clipStartSec, word: w.word }))
    // Only words actually inside the clip. A negative tolerance here pulled the
    // previous word into the first caption. The out-pad keeps the outro join clean.
    .filter((w) => w.t >= -0.05 && w.t < duration - AFTER_WORD_PAD_SEC);
  const peakWindow = peakEmphasis ? resolvePeakWindow(inClip, duration, peakLine, peakSec) : null;

  const baseSize = Math.max(1, Math.round(chunkSize));
  const out: TimelineCaption[] = [];
  for (let i = 0; i < inClip.length; ) {
    const scene = sceneAt(scenes, clipStartSec + inClip[i]!.t);
    const size = scene ? Math.max(1, Math.round(scene.chunkWords)) : baseSize;
    let take = 1;
    while (take < size && i + take < inClip.length) {
      if (sceneAt(scenes, clipStartSec + inClip[i + take]!.t)?.id !== scene?.id) break;
      take++;
    }
    const group = inClip.slice(i, i + take);
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
      words: group.map((item) => ({ t: Math.max(0, item.t), word: item.word })),
      ...(scene ? { sceneId: scene.id } : {}),
    });
  }

  for (const edit of textOverrides) {
    if (!edit.custom || edit.hidden || !edit.text?.trim()) continue;
    const absoluteEnd = edit.endSec ?? edit.startSec + 1.5;
    if (absoluteEnd <= clipStartSec || edit.startSec >= clipStartSec + duration) continue;
    const start = Math.max(0, edit.startSec - clipStartSec);
    const end = Math.min(duration - AFTER_WORD_PAD_SEC, absoluteEnd - clipStartSec);
    if (end <= start) continue;
    const scene = sceneAt(scenes, edit.startSec);
    out.push({
      start,
      end,
      text: edit.text,
      emphasis: peakWindow !== null && end > peakWindow.start && start < peakWindow.end,
      words: [],
      ...(scene ? { sceneId: scene.id } : {}),
    });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The peak's [start, end) window on the clip timeline.
 *
 * Prefers the miner's exact `peakSec`; falls back to locating the peak's opening
 * words in the word grid. Returns null when neither resolves, in which case
 * nothing is emphasised — better than emphasising the wrong line.
 */
function resolvePeakWindow(
  inClip: { t: number; word: string }[],
  duration: number,
  peakLine?: string,
  peakSec?: number
): { start: number; end: number } | null {
  const peakWords = peakLine ? normalizeWords(peakLine) : [];

  let startIdx = -1;
  if (peakSec !== undefined && Number.isFinite(peakSec)) {
    // First word at or after the peak onset.
    startIdx = inClip.findIndex((w) => w.t >= peakSec - 0.05);
  }
  if (startIdx < 0 && peakWords.length > 0) {
    // Fallback: match the peak's opening words against the grid.
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
      : // Last words of the clip: hold the emphasis briefly rather than to the end.
        Math.min(duration, start + 2.5);

  if (!(end > start)) return null;
  return { start, end };
}

// ---------------------------------------------------------------------------
// ASS serialization
// ---------------------------------------------------------------------------

/** ASS wants `H:MM:SS.cc`. */
function assTime(seconds: number): string {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  // Rounding can push cs to 100 — carry it instead of emitting an invalid stamp.
  const carry = cs >= 100 ? 1 : 0;
  return `${h}:${String(m).padStart(2, "0")}:${String(s + carry).padStart(2, "0")}.${String(
    cs >= 100 ? 0 : cs
  ).padStart(2, "0")}`;
}

/** `#rrggbb` -> ASS `&H00BBGGRR` (ASS stores colours as BGR). */
export function assColor(hex: string): string {
  const clean = hex.replace("#", "").trim();
  const r = clean.slice(0, 2) || "FF";
  const g = clean.slice(2, 4) || "FF";
  const b = clean.slice(4, 6) || "FF";
  return `&H00${b}${g}${r}`.toUpperCase();
}

/** Escape text for an ASS dialogue line (backslashes and override braces). */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

export interface AssOptions {
  fontFamily?: string;
  /** Multiplier applied to the base caption/peak font sizes. */
  sizeScale?: number;
  /** Caption baseline as a fraction of output height, up from the bottom. */
  verticalFrac?: number;
  horizontalFrac?: number;
  textColor?: string;
  background?: "none" | "box";
  animation?: "none" | "pop" | "fade";
  peakColor?: string;
  /** Render caption text in capitals. Applied to the text, not a font feature. */
  uppercase?: boolean;
  /** Colour the word being spoken inside each caption (karaoke). */
  highlight?: "none" | "word";
}

/** Project a CaptionStyle preset onto the ASS writer's options. */
export function assOptionsFromStyle(style: CaptionStyle): AssOptions {
  return {
    fontFamily: style.fontFamily,
    sizeScale: style.sizeScale,
    verticalFrac: style.verticalFrac,
    horizontalFrac: style.horizontalFrac,
    textColor: style.textColor,
    background: style.background,
    animation: style.animation,
    peakColor: style.peakColor,
    uppercase: style.uppercase,
    highlight: style.highlight,
  };
}

/** One look, resolved to the numbers the ASS header and each line need. */
interface ResolvedLook {
  capStyle: string;
  peakStyle: string;
  styleRows: string;
  positionX: number;
  positionY: number;
  motion: string;
  textColor: string;
  peakColor: string;
  uppercase: boolean;
  highlight: boolean;
}

function resolveLook(suffix: string, options: AssOptions): ResolvedLook {
  const font = resolveCaptionFont(options.fontFamily);
  const scale = options.sizeScale ?? 1;
  const verticalFrac = options.verticalFrac ?? CAPTION_VERTICAL_FRAC;
  const horizontalFrac = options.horizontalFrac ?? 0.5;
  const textColor = options.textColor ?? "#FFFFFF";
  const background = options.background ?? "none";
  const animation = options.animation ?? "none";
  const peakColor = options.peakColor ?? PEAK_COLOR;

  const captionSize = Math.round(CAPTION_BASE_FONT * scale * ASS_FONT_SIZE_MATCH);
  const peakSize = Math.round(PEAK_BASE_FONT * scale * ASS_FONT_SIZE_MATCH);
  const marginV = Math.round(verticalFrac * OUTPUT_HEIGHT);
  const borderStyle = background === "box" ? 3 : 1;
  const outline = background === "box" ? 14 : 6;
  const shadow = background === "box" ? 0 : 3;
  const primary = assColor(textColor);
  const capStyle = `Cap${suffix}`;
  const peakStyle = `Peak${suffix}`;
  return {
    capStyle,
    peakStyle,
    styleRows:
      `Style: ${capStyle},${font},${captionSize},${primary},${primary},&H00000000,&H9A000000,-1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,80,80,${marginV},1\n` +
      `Style: ${peakStyle},${font},${peakSize},${assColor(peakColor)},${assColor(peakColor)},&H00000000,&H9A000000,-1,0,0,0,100,100,0,0,${borderStyle},${background === "box" ? 16 : 7},${background === "box" ? 0 : 4},2,60,60,${marginV},1`,
    positionX: Math.round(Math.max(0.05, Math.min(0.95, horizontalFrac)) * OUTPUT_WIDTH),
    positionY: Math.round((1 - Math.max(0.05, Math.min(0.95, verticalFrac))) * OUTPUT_HEIGHT),
    motion:
      animation === "pop"
        ? "\\fscx112\\fscy112\\t(0,140,\\fscx100\\fscy100)"
        : animation === "fade"
          ? "\\fad(100,70)"
          : "",
    textColor,
    peakColor,
    uppercase: options.uppercase ?? false,
    highlight: options.highlight === "word",
  };
}

/** The `[Script Info]` block shared by every ASS this app writes. */
export function assScriptHeader(): string {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUTPUT_WIDTH}
PlayResY: ${OUTPUT_HEIGHT}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
`;
}

const STYLE_FORMAT =
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";
const EVENT_FORMAT = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

/**
 * Serialize captions to an ASS subtitle file.
 *
 * Two styles per look: the default caption, and a larger accent-coloured peak
 * style used for the emotional peak. Creator mode adds one look per caption
 * scene (`sceneOptions`, keyed by scene id); a caption uses its scene's look.
 *
 * `highlight: "word"` writes one Dialogue per spoken word, the active word in
 * the accent colour — the karaoke look — timed on the real onsets.
 */
export function renderAss(
  captions: TimelineCaption[],
  options: AssOptions = {},
  sceneOptions: Record<string, AssOptions> = {}
): string {
  const base = resolveLook("", options);
  const looks = new Map<string, ResolvedLook>();
  Object.entries(sceneOptions).forEach(([sceneId, sceneOption], index) => {
    looks.set(sceneId, resolveLook(String(index + 1), sceneOption));
  });

  const header = `${assScriptHeader()}
[V4+ Styles]
${STYLE_FORMAT}
${[base, ...looks.values()].map((look) => look.styleRows).join("\n")}

[Events]
${EVENT_FORMAT}
`;

  const rows: string[] = [];
  const dialogue = (start: number, end: number, style: string, tags: string, text: string) =>
    `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,{${tags}}${text}`;

  for (const caption of captions) {
    const look = (caption.sceneId && looks.get(caption.sceneId)) || base;
    const style = caption.emphasis ? look.peakStyle : look.capStyle;
    const position = `\\an5\\pos(${look.positionX},${look.positionY})`;
    const words = caption.words ?? [];
    const casing = (text: string) => (look.uppercase ? text.toUpperCase() : text);

    if (!look.highlight || words.length < 2) {
      rows.push(dialogue(caption.start, caption.end, style, `${position}${look.motion}`, escapeAssText(casing(caption.text))));
      continue;
    }

    // Karaoke: the line is re-emitted per word span with that word coloured.
    // Only the first span carries the entrance motion; re-popping every word
    // reads as jitter.
    // Inline colour overrides take `&HBBGGRR&` (no alpha byte).
    const inline = (hex: string) => `&H${assColor(hex).slice(4)}&`;
    const quiet = inline(caption.emphasis ? look.peakColor : look.textColor);
    const loud = inline(caption.emphasis ? look.textColor : look.peakColor);
    for (let i = 0; i < words.length; i++) {
      const spanStart = Math.max(caption.start, words[i]!.t);
      const spanEnd = i + 1 < words.length ? Math.max(spanStart, words[i + 1]!.t) : caption.end;
      if (spanEnd - spanStart < 0.02) continue;
      const text = words
        .map((word, index) => {
          const token = escapeAssText(casing(word.word));
          return index === i ? `{\\c${loud}}${token}{\\c${quiet}}` : token;
        })
        .join(" ");
      rows.push(dialogue(spanStart, spanEnd, style, `${position}${i === 0 ? look.motion : ""}`, text));
    }
  }

  return `${header}${rows.join("\n")}\n`;
}
