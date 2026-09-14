import type { BehindTitle } from "../types/clip.types";
import { ASS_FONT_SIZE_MATCH, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "../types/clip.types";
import { resolveCaptionFont } from "../config/caption-fonts";
import { assColor, assScriptHeader } from "./caption.service";

// ============================================
// TITLES — free-placed hook text, written as its own ASS file.
//
// Separate from captions so the renderer can put it UNDER the speaker's
// cutout while captions stay on top. Sized in the same 1080×1920 units the
// caption overlay uses, so the editor's canvas title and the burn agree.
// ============================================

/** Base title size in output pixels, before `sizeScale`. */
export const TITLE_BASE_FONT = 118;
export const TITLE_DEFAULT_FONT = "Anton";
/** Titles wrap inside this share of the frame width. */
const TITLE_MAX_WIDTH_FRAC = 0.86;
/** Rough glyph advance as a share of font size for the wrap estimate. */
const GLYPH_ADVANCE = 0.52;

function assTime(seconds: number): string {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  const carry = cs >= 100 ? 1 : 0;
  return `${h}:${String(m).padStart(2, "0")}:${String(s + carry).padStart(2, "0")}.${String(
    cs >= 100 ? 0 : cs
  ).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

/** Greedy word wrap to the title's width budget; ASS WrapStyle 2 never wraps. */
export function wrapTitle(text: string, fontSizePx: number): string[] {
  const maxChars = Math.max(6, Math.floor((OUTPUT_WIDTH * TITLE_MAX_WIDTH_FRAC) / (fontSizePx * GLYPH_ADVANCE)));
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** The title's font size in output pixels (what the preview draws with). */
export function titleFontPx(title: BehindTitle): number {
  return Math.round(TITLE_BASE_FONT * title.sizeScale);
}

function entranceTags(title: BehindTitle, x: number, y: number): string {
  switch (title.animation) {
    case "pop":
      return `\\pos(${x},${y})\\fscx78\\fscy78\\t(0,170,\\fscx100\\fscy100)\\fad(50,110)`;
    case "fade":
      return `\\pos(${x},${y})\\fad(180,160)`;
    case "rise":
      return `\\move(${x},${y + 70},${x},${y},0,240)\\fad(110,120)`;
    default:
      return `\\pos(${x},${y})`;
  }
}

/**
 * ASS for the titles active inside one window. Times are window-local.
 * Returns undefined when no title touches the window.
 */
export function renderTitlesAss(
  titles: BehindTitle[],
  windowStartSec: number,
  windowEndSec: number,
  depth: "behind" | "front",
  /**
   * `mask` paints text, outline and shadow all white. libass never writes an
   * alpha channel, so a behind-title layer is built from two renders on
   * black — the colour and its white silhouette — merged with `alphamerge`.
   */
  variant: "colour" | "mask" = "colour"
): string | undefined {
  const active = titles.filter(
    (title) => title.depth === depth && title.startSec < windowEndSec && title.endSec > windowStartSec
  );
  if (active.length === 0) return undefined;

  const styles: string[] = [];
  const rows: string[] = [];
  active.forEach((title, index) => {
    const font = resolveCaptionFont(title.fontFamily ?? TITLE_DEFAULT_FONT);
    const size = Math.round(titleFontPx(title) * ASS_FONT_SIZE_MATCH);
    const colour = variant === "mask" ? "&H00FFFFFF" : assColor(title.color);
    const outline = variant === "mask" ? "&H00FFFFFF" : "&H00000000";
    const back = variant === "mask" ? "&H00FFFFFF" : "&H80000000";
    const name = `Title${index + 1}`;
    styles.push(
      `Style: ${name},${font},${size},${colour},${colour},${outline},${back},-1,0,0,0,100,100,2,0,1,7,4,5,40,40,0,1`
    );
    const x = Math.round(Math.max(0.05, Math.min(0.95, title.x)) * OUTPUT_WIDTH);
    const y = Math.round(Math.max(0.05, Math.min(0.95, title.y)) * OUTPUT_HEIGHT);
    const text = wrapTitle(title.uppercase ? title.text.toUpperCase() : title.text, titleFontPx(title))
      .map(escapeAssText)
      .join("\\N");
    const start = Math.max(0, title.startSec - windowStartSec);
    const end = Math.min(windowEndSec - windowStartSec, title.endSec - windowStartSec);
    if (end <= start) return;
    rows.push(`Dialogue: 0,${assTime(start)},${assTime(end)},${name},,0,0,0,,{\\an5${entranceTags(title, x, y)}}${text}`);
  });
  if (rows.length === 0) return undefined;

  return `${assScriptHeader()}
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join("\n")}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${rows.join("\n")}
`;
}
