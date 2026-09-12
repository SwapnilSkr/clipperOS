import {
  CAPTION_FONT,
  CAPTION_SIZE_SCALE,
  CAPTION_VERTICAL_FRAC,
  PEAK_COLOR,
} from "../types/clip.types";
import type { CaptionOverrides } from "../types/clip.types";
import { resolveCaptionFont } from "./caption-fonts";

// ============================================
// CAPTION STYLES — the per-clip look of burned captions.
//
// Deliberately the same shape as config/genres.ts: a type, an open registry, a
// resolver and a list. Adding a look is one entry here, and the renderer reads
// whatever the registry declares rather than switching on an enum. The client
// fetches this list so it never hardcodes a preset or a label.
//
// `clean` reproduces the pre-editor constants EXACTLY. An unedited clip must
// keep rendering byte-for-byte as it did before styles existed, so every field
// below is sourced from the same constants the renderer used directly.
// ============================================

export interface CaptionStyle {
  id: string;
  label: string;
  /** One line, shown in the editor's picker. */
  summary: string;
  /** Words grouped into each caption. */
  chunkWords: number;
  /** Multiplier on the base caption/peak font sizes. */
  sizeScale: number;
  /** Caption baseline as a fraction of output height, up from the bottom. */
  verticalFrac: number;
  /** Horizontal caption centre as a fraction of output width. */
  horizontalFrac: number;
  textColor: string;
  background: "none" | "box";
  animation: "none" | "pop" | "fade";
  peakColor: string;
  fontFamily: string;
  uppercase: boolean;
}

const CLEAN: CaptionStyle = {
  id: "clean",
  label: "Clean",
  summary: "The default: three words at a time, accent peak.",
  chunkWords: 3,
  sizeScale: CAPTION_SIZE_SCALE,
  verticalFrac: CAPTION_VERTICAL_FRAC,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "none",
  animation: "none",
  peakColor: PEAK_COLOR,
  fontFamily: CAPTION_FONT,
  uppercase: false,
};

const BOLD_POP: CaptionStyle = {
  id: "bold_pop",
  label: "Bold pop",
  summary: "Big, uppercase, two words at a time. Reads at a glance on mute.",
  chunkWords: 2,
  sizeScale: 1.35,
  verticalFrac: 0.26,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "none",
  animation: "pop",
  peakColor: PEAK_COLOR,
  fontFamily: "Impact",
  uppercase: true,
};

const MINIMAL: CaptionStyle = {
  id: "minimal",
  label: "Minimal",
  summary: "Small and low, four words at a time. Stays out of the frame.",
  chunkWords: 4,
  sizeScale: 0.85,
  verticalFrac: 0.14,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "none",
  animation: "fade",
  peakColor: PEAK_COLOR,
  fontFamily: "Helvetica Neue",
  uppercase: false,
};

const PEAK_HEAVY: CaptionStyle = {
  id: "peak_heavy",
  label: "Peak heavy",
  summary: "Warm payoff colour with a large emphasis line.",
  chunkWords: 3,
  sizeScale: 1.15,
  verticalFrac: 0.22,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "box",
  animation: "pop",
  peakColor: "#FFC24B",
  fontFamily: "Montserrat",
  uppercase: false,
};

const KARAOKE: CaptionStyle = {
  id: "karaoke",
  label: "Karaoke",
  summary: "One word at a time, centred on the beat.",
  chunkWords: 1,
  sizeScale: 1.25,
  verticalFrac: 0.2,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "none",
  animation: "pop",
  peakColor: "#FF5CA8",
  fontFamily: "Bebas Neue",
  uppercase: true,
};

const CREATOR_HOOK: CaptionStyle = {
  id: "creator_hook",
  label: "Creator hook",
  summary: "Big two-word punches in the thumb-stopping centre zone.",
  chunkWords: 2,
  sizeScale: 1.5,
  verticalFrac: 0.48,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "none",
  animation: "pop",
  peakColor: "#FDE047",
  fontFamily: "Anton",
  uppercase: true,
};

const STORYTIME: CaptionStyle = {
  id: "storytime",
  label: "Storytime",
  summary: "Conversational four-word phrases with a soft readable card.",
  chunkWords: 4,
  sizeScale: 1.02,
  verticalFrac: 0.28,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "box",
  animation: "fade",
  peakColor: "#FB923C",
  fontFamily: "Georgia",
  uppercase: false,
};

const NEWSROOM: CaptionStyle = {
  id: "newsroom",
  label: "Newsroom",
  summary: "Calm lower-third treatment for authority and explainers.",
  chunkWords: 5,
  sizeScale: 0.9,
  verticalFrac: 0.18,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "box",
  animation: "fade",
  peakColor: "#38BDF8",
  fontFamily: "Playfair Display",
  uppercase: false,
};

const REACTION_POP: CaptionStyle = {
  id: "reaction_pop",
  label: "Reaction pop",
  summary: "Single-word impact beats for reactions and punchlines.",
  chunkWords: 1,
  sizeScale: 1.6,
  verticalFrac: 0.5,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "none",
  animation: "pop",
  peakColor: "#F472B6",
  fontFamily: "Oswald",
  uppercase: true,
};

const REGISTRY: Record<string, CaptionStyle> = {
  [CLEAN.id]: CLEAN,
  [BOLD_POP.id]: BOLD_POP,
  [MINIMAL.id]: MINIMAL,
  [PEAK_HEAVY.id]: PEAK_HEAVY,
  [KARAOKE.id]: KARAOKE,
  [CREATOR_HOOK.id]: CREATOR_HOOK,
  [STORYTIME.id]: STORYTIME,
  [NEWSROOM.id]: NEWSROOM,
  [REACTION_POP.id]: REACTION_POP,
};

export const DEFAULT_CAPTION_STYLE_ID = CLEAN.id;

export function listCaptionStyles(): CaptionStyle[] {
  return Object.values(REGISTRY);
}

export function isKnownCaptionStyle(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id);
}

/**
 * Resolve a preset by id. An unknown id falls back to the default rather than
 * throwing: the id arrives from a client that fetches the registry, so a stale
 * tab must not be able to fail a render.
 */
export function resolveCaptionStyle(id?: string | null): CaptionStyle {
  if (!id) return CLEAN;
  return REGISTRY[id] ?? CLEAN;
}

/** Layer per-clip overrides on top of a preset. */
export function resolveEffectiveCaptionStyle(
  style: CaptionStyle,
  overrides?: CaptionOverrides
): CaptionStyle {
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
    fontFamily: resolveCaptionFont(overrides.fontFamily ?? style.fontFamily),
    uppercase: overrides.uppercase ?? style.uppercase,
  };
}
