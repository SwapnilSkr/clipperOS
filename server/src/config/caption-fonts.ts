import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CAPTION_FONT } from "../types/clip.types";

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
    stack: '"Inter Variable", Inter, system-ui, sans-serif',
    weight: 800,
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

/** Directory libass should scan, when the bundled faces are on disk. */
export function captionFontsDir(): string | undefined {
  const dir = resolve(import.meta.dir, "../../assets/caption-fonts");
  return existsSync(dir) ? dir : undefined;
}
