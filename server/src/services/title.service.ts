import type { BehindTitle } from "../types/clip.types";
import { ASS_FONT_SIZE_MATCH, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "../types/clip.types";
import { captionFontBold, resolveCaptionFont } from "../config/caption-fonts";
import { assColor, assScriptHeader } from "./caption.service";
import { textPoseAt, textSchedule, wordAlphaAt, type TextPose, type TextSchedule } from "./text-motion";

// ============================================
// TITLES — free-placed Text beats (your own captions), written as their own ASS file.
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

/** Output-pixel number for an ASS tag. */
function px(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** ASS alpha byte (00 opaque … FF clear) for an opacity. */
function assAlpha(opacity: number): string {
  const byte = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255);
  return `&H${byte.toString(16).toUpperCase().padStart(2, "0")}&`;
}

/** Outline strength → ASS outline and shadow sizes at output scale. */
function strokeOf(title: BehindTitle): { outline: number; shadow: number } {
  const k = title.outline ?? 1;
  return { outline: Number((7 * k).toFixed(2)), shadow: k > 0 ? 4 : 0 };
}

/** The box's padding around each line, output pixels. */
export function titleBoxPad(title: BehindTitle): number {
  return Math.round(titleFontPx(title) * 0.16);
}

/**
 * The override tags that take a title from pose `a` to pose `b` over `durMs`:
 * `\pos` or `\move`, scale and rotation with one linear `\t`, and the fill /
 * outline-or-box / shadow alphas (never `\alpha`, which would flatten a box's
 * own opacity into the text's).
 */
function segmentTags(title: BehindTitle, a: TextPose, b: TextPose, durMs: number, x: number, y: number): string {
  const tags: string[] = ["\\an5"];
  const ax = x + a.dx;
  const ay = y + a.dy;
  const bx = x + b.dx;
  const by = y + b.dy;
  tags.push(Math.abs(ax - bx) < 0.01 && Math.abs(ay - by) < 0.01 ? `\\pos(${px(ax)},${px(ay)})` : `\\move(${px(ax)},${px(ay)},${px(bx)},${px(by)},0,${durMs})`);
  const base = title.rotation ?? 0;
  // ASS turns counter-clockwise for positive \frz; poses are clockwise.
  tags.push(`\\fscx${px(a.scale * 100)}\\fscy${px(a.scale * 100)}\\frz${px(-(base + a.rotation))}`);
  const boxOpacity = title.box ? title.box.opacity : 1;
  const alphas = (pose: TextPose) => `\\1a${assAlpha(pose.alpha)}\\3a${assAlpha(pose.alpha * boxOpacity)}\\4a${assAlpha(pose.alpha * 0.5)}`;
  tags.push(alphas(a));
  const changes: string[] = [];
  if (Math.abs(a.scale - b.scale) > 1e-4) changes.push(`\\fscx${px(b.scale * 100)}\\fscy${px(b.scale * 100)}`);
  if (Math.abs(a.rotation - b.rotation) > 1e-4) changes.push(`\\frz${px(-(base + b.rotation))}`);
  if (Math.abs(a.alpha - b.alpha) > 1e-4) changes.push(alphas(b));
  if (changes.length > 0 && durMs > 0) tags.push(`\\t(0,${durMs},${changes.join("")})`);
  return tags.join("");
}

/**
 * The text of one event: lines joined by `\N`, and for a word-by-word reveal,
 * each word with its own alpha ramp across the event (the line's own alpha is
 * constant while words are still arriving, so the product stays linear).
 */
function eventText(title: BehindTitle, lines: string[], schedule: TextSchedule, localA: number, localB: number, durMs: number, pose: TextPose): string {
  if (schedule.enter !== "words") return lines.map(escapeAssText).join("\\N");
  const boxOpacity = title.box ? title.box.opacity : 1;
  let index = 0;
  return lines
    .map((line) =>
      line
        .split(" ")
        .map((word) => {
          const from = wordAlphaAt(schedule, index, localA) * pose.alpha;
          const to = wordAlphaAt(schedule, index, localB) * pose.alpha;
          index++;
          const set = (o: number) => `\\1a${assAlpha(o)}\\3a${assAlpha(o * boxOpacity)}\\4a${assAlpha(o * 0.5)}`;
          const ramp = Math.abs(from - to) > 1e-4 && durMs > 0 ? `\\t(0,${durMs},${set(to)})` : "";
          return `{${set(from)}${ramp}}${escapeAssText(word)}`;
        })
        .join(" ")
    )
    .join("\\N");
}

/**
 * ASS for the titles active inside one window. Times are window-local.
 * Returns undefined when no title touches the window.
 *
 * Each title is written as one event per straight segment of its motion
 * schedule (text-motion.ts), clipped to the window, so a title that spans a
 * cut resumes mid-animation instead of replaying its entrance, and what the
 * burn draws at any frame is `textPoseAt` — the pose the preview paints.
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
    const stroke = strokeOf(title);
    // BorderStyle 3 draws an opaque box in the outline colour, `Outline` wide
    // around each line; its opacity rides the \3a tags.
    const boxed = Boolean(title.box);
    const outlineColour = variant === "mask" ? "&H00FFFFFF" : boxed ? assColor(title.box!.color) : "&H00000000";
    const back = variant === "mask" ? "&H00FFFFFF" : "&H00000000";
    const name = `Title${index + 1}`;
    const bold = captionFontBold(font);
    styles.push(
      boxed
        ? `Style: ${name},${font},${size},${colour},${colour},${outlineColour},${back},${bold},0,0,0,100,100,2,0,3,${titleBoxPad(title)},0,5,40,40,0,1`
        : `Style: ${name},${font},${size},${colour},${colour},${outlineColour},${back},${bold},0,0,0,100,100,2,0,1,${stroke.outline},${stroke.shadow},5,40,40,0,1`
    );
    const x = Math.round(Math.max(0.05, Math.min(0.95, title.x)) * OUTPUT_WIDTH);
    const y = Math.round(Math.max(0.05, Math.min(0.95, title.y)) * OUTPUT_HEIGHT);
    const lines = wrapTitle(title.uppercase ? title.text.toUpperCase() : title.text, titleFontPx(title));
    const schedule = textSchedule(title);
    // The title's life on its own clock, clipped to this window.
    const lifeFrom = Math.max(0, windowStartSec - title.startSec);
    const lifeTo = Math.min(schedule.duration, windowEndSec - title.startSec);
    if (lifeTo - lifeFrom <= 0.005) return;
    const bounds = [lifeFrom, ...schedule.breaks.filter((t) => t > lifeFrom + 0.005 && t < lifeTo - 0.005), lifeTo];
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i]!;
      const b = bounds[i + 1]!;
      // Window-local event times on the ASS clock; the transform length is the
      // event's own, so each ramp lands exactly on its event's end.
      const start = Math.round((title.startSec + a - windowStartSec) * 100) / 100;
      const end = Math.round((title.startSec + b - windowStartSec) * 100) / 100;
      if (end <= start) continue;
      const durMs = Math.round((end - start) * 1000);
      const poseA = textPoseAt(schedule, a);
      const poseB = textPoseAt(schedule, b);
      rows.push(
        `Dialogue: 0,${assTime(start)},${assTime(end)},${name},,0,0,0,,{${segmentTags(title, poseA, poseB, durMs, x, y)}}${eventText(title, lines, schedule, a, b, durMs, poseA)}`
      );
    }
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
