// ============================================
// EFFECTS — the looks a creator can put on a span of the picture.
//
// Each effect is an FFmpeg filter fragment gated to its span with timeline
// `enable` (or an amplitude that is 0 outside it), so stacking is a plain
// concatenation in start order and frames outside the span are untouched.
// Every fragment is written for a 1080x1920 picture on the window's clock
// (`t` = seconds since the window's start) and is inserted AFTER the crop,
// camera and grade, BEFORE captions — looks apply to the picture, not the
// words.
//
// The live preview is an approximation: CSS filters where one maps, and
// canvas layers for what CSS cannot draw. `Render this span` is the truth.
// ============================================

export type EffectGroup = "colour" | "texture" | "motion" | "glitch" | "frame";

/** CSS filter functions the preview can lerp by amount: [at 0, at 1]. */
export type CssPreview = Partial<
  Record<"grayscale" | "sepia" | "saturate" | "contrast" | "brightness" | "invert" | "blur" | "hue-rotate", [number, number]>
>;

/** Canvas layers the preview paints on top of the crop, by amount and time. */
export type PreviewLayer =
  | "grain"
  | "scanlines"
  | "rgbsplit"
  | "flicker"
  | "strobe"
  | "bars"
  | "vignette"
  | "pixelate"
  | "shake"
  | "pulse"
  | "glitch"
  | "fadeblack"
  | "fadewhite"
  | "posterize";

export interface EffectVariant {
  id: string;
  label: string;
}

export interface EffectChainInput {
  /** 0..1 */
  A: number;
  /** Window-local span, seconds, already formatted. */
  a: string;
  b: string;
  /** `enable='between(t,a,b)'` for this span. */
  E: string;
  /** Unique label prefix for fragments that split the graph. */
  prefix: string;
  variant?: string;
}

export interface EffectDef {
  id: string;
  label: string;
  group: EffectGroup;
  summary: string;
  variants?: EffectVariant[];
  chain: (input: EffectChainInput) => string;
  preview: { css?: CssPreview; layers?: PreviewLayer[] };
}

/** What the client and the Director see: everything but the chain builder. */
export interface EffectInfo {
  id: string;
  label: string;
  group: EffectGroup;
  summary: string;
  variants?: EffectVariant[];
  preview: { css?: CssPreview; layers?: PreviewLayer[] };
}

const n = (value: number, digits = 3) => Number(value.toFixed(digits)).toString();
const lerp = (from: number, to: number, u: number) => from + (to - from) * u;

/** Identity → sepia colour matrix, by amount. */
function sepiaMixer(A: number): string {
  const m = [
    [0.393, 0.769, 0.189],
    [0.349, 0.686, 0.168],
    [0.272, 0.534, 0.131],
  ];
  const id = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const c = (r: number, col: number) => n(lerp(id[r]![col]!, m[r]![col]!, A));
  return `colorchannelmixer=rr=${c(0, 0)}:rg=${c(0, 1)}:rb=${c(0, 2)}:gr=${c(1, 0)}:gg=${c(1, 1)}:gb=${c(1, 2)}:br=${c(2, 0)}:bg=${c(2, 1)}:bb=${c(2, 2)}`;
}

/** Split, treat one branch, and lay it back only inside the span. */
function branch(prefix: string, treatment: string, merge: string): string {
  return `split[${prefix}a][${prefix}b];[${prefix}b]${treatment}[${prefix}s];[${prefix}a][${prefix}s]${merge}`;
}

/**
 * The same, gated by the span. Used for RGB-space filters (colour mixer,
 * curves, lut, rgbashift): put in the main path they make FFmpeg convert the
 * whole stream YUV→RGB→YUV, which nudges chroma outside the span too. On a
 * branch, frames outside the span are the input, bit for bit.
 */
function gated(prefix: string, a: string, b: string, treatment: string): string {
  return branch(prefix, treatment, `overlay=enable='between(t,${a},${b})'`);
}

export const EFFECTS: EffectDef[] = [
  // ---- colour ----
  {
    id: "bw",
    label: "Black & white",
    group: "colour",
    summary: "Drains the colour.",
    chain: ({ A, E }) => `hue=s=${n(1 - A)}:${E}`,
    preview: { css: { grayscale: [0, 1] } },
  },
  {
    id: "sepia",
    label: "Sepia",
    group: "colour",
    summary: "Old photograph brown.",
    chain: ({ A, a, b, prefix }) => gated(prefix, a, b, sepiaMixer(A)),
    preview: { css: { sepia: [0, 1] } },
  },
  {
    id: "duotone",
    label: "Duotone",
    group: "colour",
    summary: "Teal shadows, orange highlights.",
    chain: ({ A, a, b, prefix }) =>
      gated(prefix, a, b, `hue=s=${n(1 - A)},colorbalance=rs=${n(-0.4 * A)}:bs=${n(0.4 * A)}:rh=${n(0.45 * A)}:bh=${n(-0.35 * A)}`),
    preview: { css: { grayscale: [0, 0.7], sepia: [0, 0.5], contrast: [1, 1.1] } },
  },
  {
    id: "warm",
    label: "Warm wash",
    group: "colour",
    summary: "Golden-hour tint.",
    chain: ({ A, a, b, prefix }) => gated(prefix, a, b, `colorbalance=rm=${n(0.18 * A)}:bm=${n(-0.14 * A)}:rh=${n(0.1 * A)}`),
    preview: { css: { sepia: [0, 0.3], saturate: [1, 1.1] } },
  },
  {
    id: "cool",
    label: "Cool wash",
    group: "colour",
    summary: "Steely blue tint.",
    chain: ({ A, a, b, prefix }) => gated(prefix, a, b, `colorbalance=rm=${n(-0.14 * A)}:bm=${n(0.18 * A)}:bs=${n(0.1 * A)}`),
    preview: { css: { "hue-rotate": [0, -12], saturate: [1, 0.95] } },
  },
  {
    id: "crushed",
    label: "Crushed blacks",
    group: "colour",
    summary: "Deep shadows, punchy contrast.",
    chain: ({ A, a, b, prefix }) =>
      gated(prefix, a, b, `curves=all='0/0 0.22/${n(0.22 - 0.16 * A)} 0.5/0.5 0.8/${n(0.8 + 0.06 * A)} 1/1'`),
    preview: { css: { contrast: [1, 1.3] } },
  },
  {
    id: "bleach",
    label: "Bleach bypass",
    group: "colour",
    summary: "Desaturated, hard contrast — the war-film look.",
    chain: ({ A, E }) => `hue=s=${n(1 - 0.6 * A)}:${E},eq=contrast=${n(1 + 0.4 * A)}:${E}`,
    preview: { css: { saturate: [1, 0.4], contrast: [1, 1.4] } },
  },
  {
    id: "invert",
    label: "Invert",
    group: "colour",
    summary: "Negative.",
    chain: ({ A, a, b, prefix }) =>
      gated(
        prefix,
        a,
        b,
        `lutrgb=r='(1-${n(A)})*val+${n(A)}*(255-val)':g='(1-${n(A)})*val+${n(A)}*(255-val)':b='(1-${n(A)})*val+${n(A)}*(255-val)'`
      ),
    preview: { css: { invert: [0, 1] } },
  },
  {
    id: "posterize",
    label: "Posterize",
    group: "colour",
    summary: "Flat bands of colour.",
    chain: ({ A, a, b, prefix }) => {
      const step = Math.round(16 + A * 48);
      return gated(prefix, a, b, `lutrgb=r='round(val/${step})*${step}':g='round(val/${step})*${step}':b='round(val/${step})*${step}'`);
    },
    preview: { css: { contrast: [1, 1.15] }, layers: ["posterize"] },
  },
  {
    id: "thermal",
    label: "Thermal",
    group: "colour",
    summary: "Heat-map false colour.",
    chain: ({ A, E }) => `pseudocolor=preset=turbo:opacity=${n(A)}:${E}`,
    preview: { css: { saturate: [1, 2.2], contrast: [1, 1.3], "hue-rotate": [0, -50] } },
  },

  // ---- texture ----
  {
    id: "grain",
    label: "Film grain",
    group: "texture",
    summary: "Fine moving grain.",
    chain: ({ A, E }) => `noise=alls=${Math.round(6 + A * 44)}:allf=t+u:${E}`,
    preview: { layers: ["grain"] },
  },
  {
    id: "vhs",
    label: "VHS",
    group: "texture",
    summary: "Tape softness, colour bleed, scanlines.",
    chain: ({ A, a, b, prefix }) =>
      gated(
        prefix,
        a,
        b,
        `rgbashift=rh=${Math.round(2 + A * 4)}:bh=${-Math.round(2 + A * 4)},noise=alls=${Math.round(4 + A * 16)}:allf=t,gblur=sigma=${n(0.3 + A * 1)},drawgrid=w=iw:h=3:t=1:c=black@${n(0.12 + A * 0.2)},eq=saturation=${n(1 - 0.25 * A)}:contrast=${n(1 + 0.08 * A)}`
      ),
    preview: { css: { blur: [0, 1], saturate: [1, 0.75] }, layers: ["rgbsplit", "grain", "scanlines"] },
  },
  {
    id: "scanlines",
    label: "Scanlines",
    group: "texture",
    summary: "CRT lines.",
    chain: ({ A, E }) => `drawgrid=w=iw:h=4:t=1:c=black@${n(0.15 + A * 0.5)}:${E}`,
    preview: { layers: ["scanlines"] },
  },
  {
    id: "oldfilm",
    label: "Old film",
    group: "texture",
    summary: "Sepia, grain, flicker, dark corners.",
    chain: ({ A, a, b, prefix }) =>
      gated(
        prefix,
        a,
        b,
        `${sepiaMixer(0.7 * A)},noise=alls=${Math.round(8 + A * 26)}:allf=t,eq=brightness='${n(0.05 * A)}*sin(t*31)+${n(0.03 * A)}*sin(t*7.7)':eval=frame,vignette=angle=${n(Math.PI / 5 + A * 0.5)}`
      ),
    preview: { css: { sepia: [0, 0.7], contrast: [1, 1.1] }, layers: ["grain", "flicker", "vignette"] },
  },
  {
    id: "pixelate",
    label: "Pixelate",
    group: "texture",
    summary: "Blocky mosaic.",
    chain: ({ A, E }) => {
      const block = Math.round(6 + A * 34);
      return `pixelize=w=${block}:h=${block}:${E}`;
    },
    preview: { layers: ["pixelate"] },
  },
  {
    id: "nightvision",
    label: "Night vision",
    group: "texture",
    summary: "Green scope with noise.",
    chain: ({ A, a, b, prefix }) =>
      gated(
        prefix,
        a,
        b,
        `hue=s=${n(1 - A)},colorbalance=gm=${n(0.6 * A)}:gs=${n(0.3 * A)}:rm=${n(-0.3 * A)}:bm=${n(-0.3 * A)},noise=alls=${Math.round(6 + A * 18)}:allf=t,vignette=angle=${n(Math.PI / 5 + A * 0.55)}`
      ),
    preview: {
      css: { grayscale: [0, 1], sepia: [0, 1], "hue-rotate": [0, 70], saturate: [1, 3], brightness: [1, 1.1] },
      layers: ["grain", "vignette"],
    },
  },

  // ---- motion ----
  {
    id: "motionblur",
    label: "Motion blur",
    group: "motion",
    summary: "Smears movement across frames.",
    // On a branch: tmix keeps mixing its buffer while disabled, so it is
    // never in the main path.
    chain: ({ A, a, b, prefix }) =>
      branch(prefix, `tmix=frames=${Math.round(2 + A * 5)}`, `overlay=enable='between(t,${a},${b})'`),
    preview: { css: { blur: [0, 1.5] } },
  },
  {
    id: "echo",
    label: "Echo trails",
    group: "motion",
    summary: "Movement leaves ghosts behind.",
    chain: ({ A, a, b, prefix }) =>
      branch(prefix, `lagfun=decay=${n(0.72 + 0.26 * A)}`, `overlay=enable='between(t,${a},${b})'`),
    preview: { css: { blur: [0, 1], brightness: [1, 1.05] } },
  },
  {
    id: "shake",
    label: "Handheld shake",
    group: "motion",
    summary: "Nervous camera.",
    chain: ({ A, a, b, prefix }) => {
      const sx = n(4 + A * 14);
      const sy = n(3 + A * 10);
      return branch(
        prefix,
        `scale=w=1134:h=2016:flags=bicubic,crop=1080:1920:x='27+${sx}*sin(t*37.7)*cos(t*5.1)':y='48+${sy}*sin(t*29.3)'`,
        `overlay=enable='between(t,${a},${b})'`
      );
    },
    preview: { layers: ["shake"] },
  },
  {
    id: "pulse",
    label: "Zoom pulse",
    group: "motion",
    summary: "Beats in and out twice a second.",
    chain: ({ A, a, b }) => {
      const z = `(1+${n(0.03 + A * 0.05)}*abs(sin((t-${a})*12.566))*between(t,${a},${b}))`;
      const w = `trunc(1080*${z}/2)*2`;
      const h = `trunc(1920*${z}/2)*2`;
      return `scale=w='${w}':h='${h}':eval=frame,crop=1080:1920:x='(${w}-1080)/2':y='(${h}-1920)/2'`;
    },
    preview: { layers: ["pulse"] },
  },

  // ---- glitch ----
  {
    id: "rgbsplit",
    label: "RGB split",
    group: "glitch",
    summary: "Colour channels pulled apart.",
    chain: ({ A, a, b, prefix }) => gated(prefix, a, b, `rgbashift=rh=${Math.round(3 + A * 9)}:bh=${-Math.round(3 + A * 9)}`),
    preview: { layers: ["rgbsplit"] },
  },
  {
    id: "glitch",
    label: "Glitch bursts",
    group: "glitch",
    summary: "Short digital tears every half second.",
    chain: ({ A, a, b, prefix }) =>
      gated(
        prefix,
        a,
        b,
        `rgbashift=rh=${Math.round(8 + A * 14)}:bv=${Math.round(2 + A * 6)}:enable='lt(mod(t,0.47),0.07)',noise=alls=${Math.round(20 + A * 30)}:allf=t+p:enable='lt(mod(t+0.2,0.61),0.05)'`
      ),
    preview: { layers: ["glitch"] },
  },
  {
    id: "brokentv",
    label: "Broken TV",
    group: "glitch",
    summary: "Static, flicker, colour dropping out.",
    chain: ({ A, a, b, prefix }) =>
      gated(
        prefix,
        a,
        b,
        `noise=alls=${Math.round(15 + A * 25)}:allf=t+u,hue=s=${n(1 - 0.8 * A)},drawgrid=w=iw:h=3:t=1:c=black@${n(0.15 + A * 0.25)},eq=brightness='${n(0.12 * A)}*sin(t*45)*sin(t*13)':eval=frame,rgbashift=rh=${Math.round(6 + A * 8)}:bh=${-Math.round(6 + A * 8)}:enable='lt(mod(t,0.33),0.05)'`
      ),
    preview: { css: { grayscale: [0, 0.8] }, layers: ["grain", "scanlines", "flicker", "glitch"] },
  },
  {
    id: "strobe",
    label: "Strobe",
    group: "glitch",
    summary: "White flashes five times a second.",
    chain: ({ A, E }) => `eq=brightness='if(lt(mod(t,0.2),0.05),${n(0.3 + 0.5 * A)},0)':eval=frame:${E}`,
    preview: { layers: ["strobe"] },
  },
  {
    id: "flicker",
    label: "Flicker",
    group: "glitch",
    summary: "Unsteady light.",
    chain: ({ A, E }) => `eq=brightness='${n(0.04 + 0.1 * A)}*sin(t*40)+${n(0.03 + 0.05 * A)}*sin(t*7.3)':eval=frame:${E}`,
    preview: { layers: ["flicker"] },
  },

  // ---- frame ----
  {
    id: "bars",
    label: "Cinematic bars",
    group: "frame",
    summary: "Letterbox top and bottom.",
    chain: ({ A, E }) => {
      const h = Math.max(2, Math.round(1920 * (0.04 + A * 0.1)));
      return `drawbox=x=0:y=0:w=iw:h=${h}:c=black:t=fill:${E},drawbox=x=0:y=ih-${h}:w=iw:h=${h}:c=black:t=fill:${E}`;
    },
    preview: { layers: ["bars"] },
  },
  {
    id: "vignette",
    label: "Vignette",
    group: "frame",
    summary: "Dark corners.",
    chain: ({ A, E }) => `vignette=angle=${n(Math.PI / 5 + A * 0.75)}:${E}`,
    preview: { layers: ["vignette"] },
  },
  {
    id: "bloom",
    label: "Bloom",
    group: "frame",
    summary: "Highlights glow.",
    chain: ({ A, a, b, prefix }) =>
      branch(prefix, `gblur=sigma=${n(8 + A * 16)}`, `blend=all_mode=screen:all_opacity=${n(0.25 + A * 0.5)}:enable='between(t,${a},${b})'`),
    preview: { css: { brightness: [1, 1.12], contrast: [1, 0.92] } },
  },
  {
    id: "dream",
    label: "Soft dream",
    group: "frame",
    summary: "Hazy, lifted, gentle.",
    chain: ({ A, a, b, prefix, E }) =>
      `${branch(prefix, `gblur=sigma=${n(6 + A * 12)}`, `blend=all_mode=average:all_opacity=${n(0.3 + A * 0.6)}:enable='between(t,${a},${b})'`)},eq=brightness=${n(0.03 + 0.05 * A)}:${E}`,
    preview: { css: { blur: [0, 1.2], brightness: [1, 1.08], contrast: [1, 0.92] } },
  },
  {
    id: "fadeblack",
    label: "Fade to black",
    group: "frame",
    summary: "Out, in, or a dip through black.",
    variants: [
      { id: "out", label: "Out" },
      { id: "in", label: "In" },
      { id: "dip", label: "Dip" },
    ],
    chain: ({ A, a, b, E, variant }) => `eq=brightness='-${n(A)}*${fadeCurve(variant, a, b)}':eval=frame:${E}`,
    preview: { layers: ["fadeblack"] },
  },
  {
    id: "fadewhite",
    label: "Fade to white",
    group: "frame",
    summary: "Out, in, or a flash through white.",
    variants: [
      { id: "out", label: "Out" },
      { id: "in", label: "In" },
      { id: "dip", label: "Dip" },
    ],
    chain: ({ A, a, b, E, variant }) => `eq=brightness='${n(A)}*${fadeCurve(variant, a, b)}':eval=frame:${E}`,
    preview: { layers: ["fadewhite"] },
  },
];

/** 0→1 over the span (out), 1→0 (in), or 0→1→0 (dip). */
export function fadeCurve(variant: string | undefined, a: string, b: string): string {
  const u = `clip((t-${a})/(${b}-${a}),0,1)`;
  if (variant === "in") return `(1-${u})`;
  if (variant === "dip") return `(1-abs(2*${u}-1))`;
  return u;
}

/** The same curve for the preview, in plain numbers. */
export function fadeAmount(variant: string | undefined, u: number): number {
  const c = Math.max(0, Math.min(1, u));
  if (variant === "in") return 1 - c;
  if (variant === "dip") return 1 - Math.abs(2 * c - 1);
  return c;
}

export const EFFECTS_BY_ID = new Map(EFFECTS.map((effect) => [effect.id, effect]));

export function effectInfo(): EffectInfo[] {
  return EFFECTS.map(({ id, label, group, summary, variants, preview }) => ({ id, label, group, summary, variants, preview }));
}

export function isEffectId(value: unknown): value is string {
  return typeof value === "string" && EFFECTS_BY_ID.has(value);
}
