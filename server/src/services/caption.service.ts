import {
  CAPTION_BASE_FONT,
  CAPTION_VERTICAL_FRAC,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  PEAK_BASE_FONT,
  PEAK_COLOR,
  type CaptionTextOverride,
  type TimelineCaption,
  type VttWordTiming,
} from "../types/clip.types";
import type { CaptionStyle } from "../config/caption-styles";
import { resolveCaptionFont } from "../config/caption-fonts";

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
export function buildTimelineCaptions(
  wordTimings: VttWordTiming[],
  clipStartSec: number,
  duration: number,
  peakLine?: string,
  peakSec?: number,
  chunkSize = DEFAULT_CHUNK_SIZE,
  textOverrides: CaptionTextOverride[] = [],
  peakEmphasis = true
): TimelineCaption[] {
  const inClip = wordTimings
    .map((w) => ({ t: w.t - clipStartSec, word: w.word }))
    // Only words actually inside the clip. A negative tolerance here pulled the
    // previous word into the first caption.
    .filter((w) => w.t >= -0.05 && w.t <= duration);
  const peakWindow = peakEmphasis ? resolvePeakWindow(inClip, duration, peakLine, peakSec) : null;
  const overrideByStart = new Map(
    textOverrides
      .filter((item) => !item.custom)
      .map((item) => [Math.round(item.startSec * 1000), item])
  );

  const size = Math.max(1, Math.round(chunkSize));
  const out: TimelineCaption[] = [];
  for (let i = 0; i < inClip.length; ) {
    const sourceStart = clipStartSec + Math.max(0, inClip[i]!.t);
    const edit = overrideByStart.get(Math.round(sourceStart * 1000));
    const take = edit?.hidden ? 1 : size;
    const group = inClip.slice(i, i + take);
    const start = Math.max(0, group[0]!.t);
    const next = inClip[i + take];
    const end = Math.min(duration, next ? next.t : start + 1.1);
    i += take;
    if (end <= start) continue;
    if (edit?.hidden) continue;
    const editedStart = Math.max(0, (edit?.displayStartSec ?? sourceStart) - clipStartSec);
    const editedEnd = Math.min(duration, (edit?.endSec ?? clipStartSec + end) - clipStartSec);
    const text = edit?.text ?? group.map((g) => g.word).join(" ");
    if (editedEnd <= editedStart || !text.trim()) continue;
    out.push({
      start: editedStart,
      end: editedEnd,
      text,
      emphasis:
        peakWindow !== null && editedEnd > peakWindow.start && editedStart < peakWindow.end,
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
  };
}

/**
 * Serialize captions to an ASS subtitle file.
 *
 * Two styles: the default caption, and a larger accent-coloured peak style used
 * for the emotional peak.
 */
export function renderAss(captions: TimelineCaption[], options: AssOptions = {}): string {
  const font = resolveCaptionFont(options.fontFamily);
  const scale = options.sizeScale ?? 1;
  const verticalFrac = options.verticalFrac ?? CAPTION_VERTICAL_FRAC;
  const horizontalFrac = options.horizontalFrac ?? 0.5;
  const textColor = options.textColor ?? "#FFFFFF";
  const background = options.background ?? "none";
  const animation = options.animation ?? "none";
  const peakColor = options.peakColor ?? PEAK_COLOR;
  const uppercase = options.uppercase ?? false;

  const captionSize = Math.round(CAPTION_BASE_FONT * scale);
  const peakSize = Math.round(PEAK_BASE_FONT * scale);
  const marginV = Math.round(verticalFrac * OUTPUT_HEIGHT);
  const positionX = Math.round(Math.max(0.05, Math.min(0.95, horizontalFrac)) * OUTPUT_WIDTH);
  const positionY = Math.round((1 - Math.max(0.05, Math.min(0.95, verticalFrac))) * OUTPUT_HEIGHT);
  const borderStyle = background === "box" ? 3 : 1;
  const outline = background === "box" ? 14 : 6;
  const shadow = background === "box" ? 0 : 3;
  const primary = assColor(textColor);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUTPUT_WIDTH}
PlayResY: ${OUTPUT_HEIGHT}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${font},${captionSize},${primary},${primary},&H00000000,&H9A000000,-1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,80,80,${marginV},1
Style: Peak,${font},${peakSize},${assColor(peakColor)},${assColor(peakColor)},&H00000000,&H9A000000,-1,0,0,0,100,100,0,0,${borderStyle},${background === "box" ? 16 : 7},${background === "box" ? 0 : 4},2,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const rows: string[] = [];

  for (const caption of captions) {
    const style = caption.emphasis ? "Peak" : "Cap";
    const text = uppercase ? caption.text.toUpperCase() : caption.text;
    const motion =
      animation === "pop"
        ? "\\fscx112\\fscy112\\t(0,140,\\fscx100\\fscy100)"
        : animation === "fade"
          ? "\\fad(100,70)"
          : "";
    const overrides = `\\an5\\pos(${positionX},${positionY})${motion}`;
    rows.push(
      `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},${style},,0,0,0,,{${overrides}}${escapeAssText(
        text
      )}`
    );
  }

  return `${header}${rows.join("\n")}\n`;
}
