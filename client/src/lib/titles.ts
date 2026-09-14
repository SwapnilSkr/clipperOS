import type { BehindTitle } from "@/api";

// ============================================================
// TITLES — the preview's port of server/src/services/title.service.ts.
//
// Sizes are in the 1080×1920 output space; the canvas scales them by its own
// height. Entrance animations are evaluated per paint from the title's start,
// matching the ASS tags the burn uses.
// ============================================================

export const TITLE_BASE_FONT = 118;
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

export interface TitleEntrance {
  /** 0-1 opacity. */
  alpha: number;
  /** Scale about the title's centre. */
  scale: number;
  /** Vertical offset in output pixels. */
  dy: number;
}

/** The entrance/exit state at `sourceSec`, mirroring the ASS `\t`/`\fad`/`\move` tags. */
export function titleEntranceAt(title: BehindTitle, sourceSec: number): TitleEntrance {
  const since = sourceSec - title.startSec;
  const until = title.endSec - sourceSec;
  const fade = (inMs: number, outMs: number) =>
    Math.max(0, Math.min(1, Math.min(since / (inMs / 1000), until / (outMs / 1000))));
  switch (title.animation) {
    case "pop": {
      const u = Math.max(0, Math.min(1, since / 0.17));
      return { alpha: fade(50, 110), scale: 0.78 + 0.22 * u, dy: 0 };
    }
    case "fade":
      return { alpha: fade(180, 160), scale: 1, dy: 0 };
    case "rise": {
      const u = Math.max(0, Math.min(1, since / 0.24));
      return { alpha: fade(110, 120), scale: 1, dy: 70 * (1 - u) };
    }
    default:
      return { alpha: 1, scale: 1, dy: 0 };
  }
}

/** Titles on screen at `sourceSec`. */
export function activeTitles(titles: BehindTitle[] | undefined, sourceSec: number): BehindTitle[] {
  return (titles ?? []).filter((title) => sourceSec >= title.startSec && sourceSec < title.endSec);
}
