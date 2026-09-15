import type { BehindTitle } from "@/api";

// ============================================================
// TITLES — the preview's port of server/src/services/title.service.ts.
//
// Sizes are in the 1080×1920 output space; the canvas scales them by its own
// height. Motion comes from lib/text-motion.ts — the same schedule the burn
// writes as ASS — so what plays here is what renders.
// ============================================================

export const TITLE_BASE_FONT = 118;
/** ASS sizes are written as px × this; libass lines are exactly that tall (server ASS_FONT_SIZE_MATCH). */
export const ASS_FONT_SIZE_MATCH = 1.4;
/** The title style's ASS `Spacing`, output pixels between letters. */
export const TITLE_LETTER_SPACING = 2;

/** A face as the preview draws it: the stack, weight, and how libass sizes and seats it. */
export interface TitleFont {
  stack: string;
  weight: number;
  emScale?: number;
  baseline?: number;
}
export const TITLE_DEFAULT_FONT = "Anton";
const OUTPUT_WIDTH = 1080;
const TITLE_MAX_WIDTH_FRAC = 0.86;
const GLYPH_ADVANCE = 0.52;

export function titleFontPx(title: BehindTitle): number {
  return Math.round(TITLE_BASE_FONT * title.sizeScale);
}

/** Greedy word wrap to the title's width budget — the burn's rule. */
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

/** The box's padding around each line, output pixels — the burn's `Outline` in BorderStyle 3. */
export function titleBoxPad(title: BehindTitle): number {
  return Math.round(titleFontPx(title) * 0.16);
}

/** Titles on screen at `sourceSec`. */
export function activeTitles(titles: BehindTitle[] | undefined, sourceSec: number): BehindTitle[] {
  return (titles ?? []).filter((title) => sourceSec >= title.startSec && sourceSec < title.endSec);
}
