import { TRANSITIONS_BY_ID } from "../config/transitions";
import type { CreatorPlan, Cutaway, MediaAsset } from "../types/clip.types";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "../types/clip.types";
import { CUTAWAY_DRIFT } from "./creator-timeline";
import { resolveMediaFile } from "./media-library.service";

// ============================================
// CUTAWAYS — a stock shot over the picture, the voice running on.
//
// Each cutaway is one extra FFmpeg input, prepared into a 1080x1920 stream
// with alpha: fitted (cover or blurred fill), drifting (Ken Burns), and
// transitioned at both ends by `xfade` against a transparent stream — so
// every xfade look (wipe, slide, zoom, dip, dissolve) works on the alpha
// channel — then laid on the main picture with `overlay` for exactly its
// span. The main footage's clock and audio are never touched: the
// transitions take their time from the footage either side.
// ============================================

const num = (value: number) => Number(value.toFixed(4)).toString();

/** xfade's name for each transition id; `cut` has none. */
const XFADE: Record<string, string | undefined> = {
  dissolve: "fade",
  cut: undefined,
  dip_black: "fadeblack",
  dip_white: "fadewhite",
  slide_left: "slideleft",
  slide_right: "slideright",
  slide_up: "slideup",
  slide_down: "slidedown",
  wipe_right: "wiperight",
  wipe_left: "wipeleft",
  wipe_down: "wipedown",
  smooth_left: "smoothleft",
  circle_open: "circleopen",
  pixelize: "pixelize",
  zoom: "zoomin",
};

/** The cutaways that touch [startSec, endSec), with their assets resolved. */
export async function cutawaysInWindow(
  plan: CreatorPlan | undefined,
  startSec: number,
  endSec: number
): Promise<{ cutaway: Cutaway; asset: MediaAsset; path: string }[]> {
  if (!plan?.enabled || !plan.cutaways?.length) return [];
  const out: { cutaway: Cutaway; asset: MediaAsset; path: string }[] = [];
  for (const cutaway of plan.cutaways) {
    const from = cutaway.startSec - transitionSec(cutaway.in);
    const to = cutaway.endSec + transitionSec(cutaway.out);
    if (from >= endSec || to <= startSec) continue;
    const media = await resolveMediaFile(cutaway.assetId);
    // A missing file drops the cutaway rather than the render.
    if (!media) continue;
    out.push({ cutaway, asset: media.asset, path: media.path });
  }
  return out.sort((a, b) => a.cutaway.startSec - b.cutaway.startSec);
}

function transitionSec(edge: Cutaway["in"]): number {
  return XFADE[edge.transitionId] ? Math.max(0, edge.sec) : 0;
}

export interface PreparedCutaway {
  /** Extra `-i` arguments for this cutaway's media. */
  inputArgs: (length: number) => string[];
  /** Window-local seconds where the overlay begins (transition in included). */
  startSec: number;
  /** Seconds the overlay is on screen, transitions included. */
  lengthSec: number;
  /** Graph lines producing the labelled cutaway stream from input `n`. */
  lines: (inputIndex: number, label: string, fps: number) => string[];
  /** The overlay filter laying that stream on the picture. */
  overlay: string;
}

/**
 * Prepare one cutaway for a window: how much of it shows here, and the
 * graph that builds its stream. A cutaway straddling a window edge is
 * clipped to the window; the media plays from the right offset either way.
 */
export function prepareCutaway(
  cutaway: Cutaway,
  asset: MediaAsset,
  path: string,
  windowStartSec: number,
  windowEndSec: number
): PreparedCutaway | undefined {
  const tIn = transitionSec(cutaway.in);
  const tOut = transitionSec(cutaway.out);
  const fullStart = cutaway.startSec - tIn;
  const fullEnd = cutaway.endSec + tOut;
  const from = Math.max(fullStart, windowStartSec);
  const to = Math.min(fullEnd, windowEndSec);
  const length = to - from;
  if (length < 0.05) return undefined;
  const skip = from - fullStart;
  const startSec = from - windowStartSec;
  const fullLength = fullEnd - fullStart;
  const inName = XFADE[cutaway.in.transitionId];
  const outName = XFADE[cutaway.out.transitionId];
  const offset = (cutaway.offsetSec ?? 0) + skip;

  return {
    startSec,
    lengthSec: length,
    inputArgs: (len) =>
      asset.kind === "image"
        ? ["-loop", "1", "-framerate", "30", "-t", num(len + 1), "-i", path]
        : ["-stream_loop", "-1", "-i", path],
    lines: (n, label, fps) => {
      const lines: string[] = [];
      const ken = kenBurnsChain(cutaway.motion, fullLength, skip);
      const fit = fitChain(cutaway.fit, label);
      // The media on its own clock from 0, fitted, drifting, with alpha.
      const trim =
        asset.kind === "image"
          ? `trim=duration=${num(length)}`
          : `trim=start=${num(offset)}:duration=${num(length)}`;
      lines.push(`[${n}:v]${trim},setpts=PTS-STARTPTS,fps=${num(fps)},${fit}${ken ? `,${ken}` : ""},format=yuva420p[${label}m]`);
      let current = `${label}m`;
      // A dissolve is an alpha fade on the stream itself. Every other xfade
      // runs against an invisible stream, and xfade mixes colour as well as
      // alpha — so that stream is the cutaway's own frames with alpha 0
      // (against transparent BLACK, a pixelize or an iris dips darker midway).
      // Dips are the exception: passing through the colour is the point.
      const invisible = (name: string, from: string, start: number, d: number, out: string) =>
        name === "fadeblack" || name === "fadewhite"
          ? [`color=black@0.0:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:r=${num(fps)}:d=${num(d)},format=yuva420p[${out}]`]
          : [`[${from}]trim=start=${num(start)}:duration=${num(d)},setpts=PTS-STARTPTS,lut=a=0[${out}]`];
      // Transition in, only if this window holds the cutaway's start.
      if (inName && tIn > 0 && skip < tIn - 1e-3) {
        const d = Math.min(tIn - skip, length);
        if (inName === "fade") {
          lines.push(`[${current}]fade=t=in:st=0:d=${num(d)}:alpha=1[${label}i]`);
        } else {
          const dip = inName === "fadeblack" || inName === "fadewhite";
          if (!dip) lines.push(`[${current}]split[${label}ia][${label}ib]`);
          lines.push(
            ...invisible(inName, `${label}ib`, 0, d, `${label}ti`),
            `[${label}ti][${dip ? current : `${label}ia`}]xfade=transition=${inName}:duration=${num(d)}:offset=0[${label}i]`
          );
        }
        current = `${label}i`;
      }
      // Transition out, only if this window holds the cutaway's end.
      if (outName && tOut > 0 && to > fullEnd - tOut + 1e-3) {
        const d = Math.min(tOut, length);
        if (outName === "fade") {
          lines.push(`[${current}]fade=t=out:st=${num(length - d)}:d=${num(d)}:alpha=1[${label}o]`);
        } else {
          const dip = outName === "fadeblack" || outName === "fadewhite";
          if (!dip) lines.push(`[${current}]split[${label}oa][${label}ob]`);
          lines.push(
            ...invisible(outName, `${label}ob`, length - d, d, `${label}to`),
            `[${dip ? current : `${label}oa`}][${label}to]xfade=transition=${outName}:duration=${num(d)}:offset=${num(length - d)}[${label}o]`
          );
        }
        current = `${label}o`;
      }
      lines.push(`[${current}]setpts=PTS+${num(startSec)}/TB[${label}]`);
      return lines;
    },
    overlay: `overlay=x=0:y=0:eof_action=pass:enable='between(t,${num(startSec)},${num(startSec + length)})'`,
  };
}

/**
 * Scale the media to the frame: cover it, or sit whole over a blurred fill.
 * The blur fit splits the graph mid-chain (a chain may end in labels and a
 * later chain pick them up), so it still reads as one fragment to the caller.
 */
function fitChain(fit: Cutaway["fit"], label: string): string {
  const cover = `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`;
  if (fit === "cover") return cover;
  return `split[${label}bg][${label}fg];[${label}bg]${cover},gblur=sigma=40[${label}bgb];[${label}fg]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease[${label}fgs];[${label}bgb][${label}fgs]overlay=x=(W-w)/2:y=(H-h)/2`;
}

/**
 * Ken Burns over the cutaway's full length, on the stream's own clock
 * (which starts `skip` seconds into it when a window edge clipped the start).
 * Zooms restate the scaled size in the crop — `crop` keeps first-frame iw/ih.
 */
function kenBurnsChain(motion: Cutaway["motion"], fullLength: number, skip: number): string {
  if (motion === "none") return "";
  const p = `clip((t+${num(skip)})/${num(Math.max(0.1, fullLength))},0,1)`;
  const grow = 1 + CUTAWAY_DRIFT;
  if (motion === "in" || motion === "out") {
    const z = motion === "in" ? `(1+${num(CUTAWAY_DRIFT)}*${p})` : `(${num(grow)}-${num(CUTAWAY_DRIFT)}*${p})`;
    const w = `trunc(${OUTPUT_WIDTH}*${z}/2)*2`;
    const h = `trunc(${OUTPUT_HEIGHT}*${z}/2)*2`;
    return `scale=w='${w}':h='${h}':eval=frame,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='(${w}-${OUTPUT_WIDTH})/2':y='(${h}-${OUTPUT_HEIGHT})/2'`;
  }
  const w = Math.trunc((OUTPUT_WIDTH * grow) / 2) * 2;
  const h = Math.trunc((OUTPUT_HEIGHT * grow) / 2) * 2;
  const dx = w - OUTPUT_WIDTH;
  const dy = h - OUTPUT_HEIGHT;
  const x =
    motion === "left" ? `${dx}*${p}` : motion === "right" ? `${dx}*(1-${p})` : `${dx / 2}`;
  const y =
    motion === "up" ? `${dy}*${p}` : motion === "down" ? `${dy}*(1-${p})` : `${dy / 2}`;
  return `scale=${w}:${h},crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='${x}':y='${y}'`;
}

export { TRANSITIONS_BY_ID };
