import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ASS_FONT_SIZE_MATCH, CAPTION_FONT } from "../types/clip.types";

// ============================================
// CAPTION FONTS — the faces burned captions may use.
//
// `family` is the ASS Fontname AND the CSS font-family the preview must use,
// so what you see in the editor is what libass looks up. System faces (Arial,
// Impact, Georgia, …) resolve on macOS without a file. The Google faces are
// also dropped into `assets/caption-fonts/` so a Linux render host can find
// them via `fontsdir`.
// ============================================

export interface CaptionFont {
  id: string;
  label: string;
  /** Name written into the ASS Style line / CSS font-family. */
  family: string;
  /** Preview stack, including fallbacks the browser can actually paint. */
  stack: string;
  /** CSS weight the overlay uses. ASS styles already set Bold. */
  weight: number;
}

export const CAPTION_FONTS: CaptionFont[] = [
  {
    id: "arial",
    label: "Arial",
    family: "Arial",
    stack: "Arial, Helvetica, sans-serif",
    weight: 900,
  },
  {
    id: "inter",
    label: "Inter",
    family: "Inter",
    // The bundled Inter-Bold first: the UI's Inter Variable is a different
    // cut, and at 800 draws wider than the 700 file libass burns with.
    stack: 'Inter, "Inter Variable", system-ui, sans-serif',
    weight: 700,
  },
  {
    id: "helvetica",
    label: "Helvetica Neue",
    family: "Helvetica Neue",
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    weight: 700,
  },
  {
    id: "impact",
    label: "Impact",
    family: "Impact",
    stack: 'Impact, Haettenschweiler, "Arial Black", sans-serif',
    weight: 400,
  },
  {
    id: "arial-black",
    label: "Arial Black",
    family: "Arial Black",
    stack: '"Arial Black", "Arial Bold", Arial, sans-serif',
    weight: 900,
  },
  {
    id: "georgia",
    label: "Georgia",
    family: "Georgia",
    stack: 'Georgia, "Times New Roman", serif',
    weight: 700,
  },
  {
    id: "courier",
    label: "Courier New",
    family: "Courier New",
    stack: '"Courier New", Courier, monospace',
    weight: 700,
  },
  {
    id: "montserrat",
    label: "Montserrat",
    family: "Montserrat",
    stack: "Montserrat, Arial, sans-serif",
    weight: 800,
  },
  {
    id: "oswald",
    label: "Oswald",
    family: "Oswald",
    stack: "Oswald, Impact, sans-serif",
    weight: 700,
  },
  {
    id: "anton",
    label: "Anton",
    family: "Anton",
    stack: "Anton, Impact, sans-serif",
    weight: 400,
  },
  {
    id: "bebas",
    label: "Bebas Neue",
    family: "Bebas Neue",
    stack: '"Bebas Neue", Impact, sans-serif',
    weight: 400,
  },
  {
    id: "poppins",
    label: "Poppins",
    family: "Poppins",
    stack: "Poppins, Arial, sans-serif",
    weight: 800,
  },
  {
    id: "rubik",
    label: "Rubik",
    family: "Rubik",
    stack: "Rubik, Arial, sans-serif",
    weight: 800,
  },
  {
    id: "playfair",
    label: "Playfair Display",
    family: "Playfair Display",
    stack: '"Playfair Display", Georgia, serif',
    weight: 700,
  },
  {
    id: "space-grotesk",
    label: "Space Grotesk",
    family: "Space Grotesk",
    stack: '"Space Grotesk", Arial, sans-serif',
    weight: 700,
  },
];

export function listCaptionFonts(): CaptionFont[] {
  return CAPTION_FONTS;
}

/**
 * Map a stored family/id onto a known face. Unknown names fall back to Arial
 * so a stale tab cannot fail a render with a Fontname libass will not load.
 */
export function resolveCaptionFont(name?: string | null): string {
  if (!name) return CAPTION_FONT;
  const needle = name.trim().toLowerCase();
  if (!needle) return CAPTION_FONT;
  const hit = CAPTION_FONTS.find(
    (font) => font.family.toLowerCase() === needle || font.id === needle
  );
  return hit?.family ?? CAPTION_FONT;
}

export function captionFontStack(family: string): string {
  const hit = CAPTION_FONTS.find((font) => font.family === family);
  return hit?.stack ?? family;
}

export function captionFontWeight(family: string): number {
  const hit = CAPTION_FONTS.find((font) => font.family === family);
  return hit?.weight ?? 900;
}

/**
 * The ASS Style `Bold` flag for a family: `-1` (bold) only when the face is
 * a bold weight — libass then picks the real bold face, or the bundled
 * ExtraBold, and draws it as is. A regular-weight face (Anton, Bebas Neue,
 * Impact) is asked for as regular: with `-1` libass would fake-bold it, ~10%
 * more ink than the browser draws at the preview's weight 400, and no CSS
 * can reproduce that emboldening exactly.
 */
export function captionFontBold(family: string): -1 | 0 {
  return captionFontWeight(family) >= 600 ? -1 : 0;
}

/** Directory libass should scan, when the bundled faces are on disk. */
export function captionFontsDir(): string | undefined {
  const dir = resolve(import.meta.dir, "../../assets/caption-fonts");
  return existsSync(dir) ? dir : undefined;
}

/**
 * The bundled file for a family, when one ships in `assets/caption-fonts/`
 * (`Anton` → `Anton-Regular.ttf`). The editor loads these so the preview
 * paints with the very file libass burns with, not a look-alike fallback.
 */
export function captionFontFile(family: string): string | undefined {
  const dir = captionFontsDir();
  if (!dir) return undefined;
  const key = family.replace(/\s+/g, "").toLowerCase();
  return readdirSync(dir).find((name) => /\.(ttf|otf|woff2?)$/i.test(name) && name.split("-")[0]!.toLowerCase() === key);
}

/**
 * The family name a bundled file carries inside (`name` id 1) — what libass,
 * fontconfig and CoreText match a Fontname against. It must equal the
 * catalogue's `family`, or the burn silently falls back to another face.
 */
export function captionFontFileFamily(family: string): string | undefined {
  const dir = captionFontsDir();
  const file = captionFontFile(family);
  if (!dir || !file) return undefined;
  try {
    const buf = readFileSync(join(dir, file));
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return nameOf(buf, view, 0, 1);
  } catch {
    return undefined;
  }
}

/** Where macOS keeps the system faces libass finds through CoreText. */
const SYSTEM_FONT_DIRS = ["/System/Library/Fonts/Supplemental", "/Library/Fonts", "/System/Library/Fonts"];

const metricsCache = new Map<string, { emScale: number; baseline: number } | undefined>();

/**
 * The file libass would read for a family: the bundled one, else the system
 * face — the Bold file when the family is asked for bold (`Arial Bold.ttf`),
 * or a collection (`HelveticaNeue.ttc`) whose faces are told apart by name.
 */
function fontFilePath(family: string): string | undefined {
  const dir = captionFontsDir();
  const bundled = captionFontFile(family);
  if (dir && bundled) return join(dir, bundled);
  const names = captionFontBold(family) ? [`${family} Bold.ttf`, `${family}.ttf`] : [`${family}.ttf`];
  names.push(`${family.replace(/\s+/g, "")}.ttc`);
  for (const systemDir of SYSTEM_FONT_DIRS) {
    for (const name of names) {
      const candidate = join(systemDir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** A `name` table string (Windows UTF-16 or Mac Roman record) of the face whose table directory starts at `at`. */
function nameOf(buf: Buffer, view: DataView, at: number, nameId: number): string | undefined {
  const numTables = view.getUint16(at + 4);
  for (let i = 0; i < numTables; i++) {
    const rec = at + 12 + i * 16;
    if (String.fromCharCode(buf[rec]!, buf[rec + 1]!, buf[rec + 2]!, buf[rec + 3]!) !== "name") continue;
    const table = view.getUint32(rec + 8);
    const count = view.getUint16(table + 2);
    const strings = table + view.getUint16(table + 4);
    for (let n = 0; n < count; n++) {
      const entry = table + 6 + n * 12;
      const platform = view.getUint16(entry);
      if ((platform !== 3 && platform !== 1) || view.getUint16(entry + 6) !== nameId) continue;
      const length = view.getUint16(entry + 8);
      const offset = strings + view.getUint16(entry + 10);
      let text = "";
      if (platform === 3) for (let c = 0; c < length; c += 2) text += String.fromCharCode(view.getUint16(offset + c));
      else for (let c = 0; c < length; c++) text += String.fromCharCode(buf[offset + c]!);
      return text;
    }
  }
  return undefined;
}

/** `head` + `OS/2` of the face at `at`: units per em and the Windows ascent / descent. */
function faceMetrics(buf: Buffer, view: DataView, at: number): { unitsPerEm: number; winAscent: number; winDescent: number } | undefined {
  const numTables = view.getUint16(at + 4);
  const tables: Record<string, number> = {};
  for (let i = 0; i < numTables; i++) {
    const rec = at + 12 + i * 16;
    tables[String.fromCharCode(buf[rec]!, buf[rec + 1]!, buf[rec + 2]!, buf[rec + 3]!)] = view.getUint32(rec + 8);
  }
  if (tables.head === undefined || tables["OS/2"] === undefined) return undefined;
  return {
    unitsPerEm: view.getUint16(tables.head + 18),
    winAscent: view.getUint16(tables["OS/2"] + 74),
    winDescent: view.getUint16(tables["OS/2"] + 76),
  };
}

/**
 * How many CSS pixels of em the burn draws per output pixel of our font size.
 *
 * We write ASS sizes as `px × ASS_FONT_SIZE_MATCH`, and libass sizes a face so
 * its Windows ascent + descent (OS/2 usWinAscent + usWinDescent) spans that
 * size — so the em it actually draws is size × unitsPerEm / (winAscent +
 * winDescent). A canvas or CSS font size IS the em, so the preview multiplies
 * its size by this to draw the same glyphs at the same size. Undefined when
 * the face's file cannot be read (the preview keeps its old 1:1 guess).
 */
export function captionFontEmScale(family: string): number | undefined {
  return captionFontMetrics(family)?.emScale;
}

/**
 * The face's size correction (above) and where its baseline sits in a libass
 * line box: winAscent / (winAscent + winDescent), from the top.
 */
export function captionFontMetrics(family: string): { emScale: number; baseline: number } | undefined {
  if (metricsCache.has(family)) return metricsCache.get(family);
  let metrics: { emScale: number; baseline: number } | undefined;
  const path = fontFilePath(family);
  if (path) {
    try {
      const buf = readFileSync(path);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const tag = String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!);
      let face = 0;
      if (tag === "ttcf") {
        // A collection: the face libass gets is the family's bold or regular
        // member by name; failing a match, the first face.
        const wanted = (captionFontBold(family) ? `${family} Bold` : family).toLowerCase();
        const count = view.getUint32(8);
        const offsets = Array.from({ length: count }, (_, i) => view.getUint32(12 + i * 4));
        face = offsets.find((at) => nameOf(buf, view, at, 4)?.toLowerCase() === wanted) ?? offsets[0]!;
      }
      const m = faceMetrics(buf, view, face);
      const winSpan = m ? m.winAscent + m.winDescent : 0;
      if (m && m.unitsPerEm > 0 && winSpan > 0) {
        metrics = {
          emScale: Math.round(((ASS_FONT_SIZE_MATCH * m.unitsPerEm) / winSpan) * 10000) / 10000,
          baseline: Math.round((m.winAscent / winSpan) * 10000) / 10000,
        };
      }
    } catch {
      metrics = undefined;
    }
  }
  metricsCache.set(family, metrics);
  return metrics;
}

