import { join } from "node:path";
import { config } from "../config";
import type { CleanupRegion } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { runCommand } from "../utils";
import { hasAudioStream } from "./ffmpeg.service";

// ============================================
// CLEANUP — removing burned-in text, logos and watermarks.
//
// Two paths, best first:
//
//   1. INPAINT (preferred). python/cleanup_inpaint.py detects the actual glyph
//      strokes inside each rect and fills only those pixels (OpenCV Telea), so
//      the real background between and around the letters is kept. It writes a
//      lossless FFV1 intermediate that the render then encodes from.
//   2. DELOGO (fallback). ffmpeg's `delogo` interpolates a rect's border pixels
//      inward. Cheap and dependency-free, but it leaves faint stripes and a ghost
//      of the text on anything larger than a small logo.
//
// Region rects are in SOURCE pixels and run BEFORE the reframe crop, so a crop
// change never invalidates them.
// ============================================

/** Cap on rect coords, mirroring delogo's own requirement that the box be inside. */
function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

interface CleanupInpaintResult {
  ok: boolean;
  error?: string;
  frames?: number;
  inpainted?: number;
}

/**
 * Spawn the Python OpenCV pass. Resolves with its JSON verdict; a spawn or parse
 * failure REJECTS so the caller can fall back to delogo. Never swallows.
 */
function runCleanupInpaint(job: unknown): Promise<CleanupInpaintResult> {
  return new Promise((resolve, reject) => {
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      child = Bun.spawn([config.visionPythonPath, config.visionCleanupScriptPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error: unknown) {
      reject(
        new Error(
          `cleanup inpaint could not start (${config.visionPythonPath}): ${getErrorMessage(error)}`
        )
      );
      return;
    }

    // Drain both pipes before writing, or a chatty stderr fills its buffer and
    // deadlocks the child.
    const stdout = Bun.readableStreamToText(child.stdout as ReadableStream<Uint8Array>);
    const stderr = Bun.readableStreamToText(child.stderr as ReadableStream<Uint8Array>);

    child.stdin.write(JSON.stringify(job));
    void child.stdin.end();

    child.exited
      .then(async (code) => {
        const [out, err] = await Promise.all([stdout, stderr]);
        if (code !== 0) {
          reject(new Error(`cleanup inpaint exited ${code}: ${err.slice(-400)}`));
          return;
        }
        try {
          resolve(JSON.parse(out) as CleanupInpaintResult);
        } catch {
          reject(new Error(`cleanup inpaint gave unparseable output: ${out.slice(0, 200)}`));
        }
      })
      .catch((error: unknown) => reject(error));
  });
}

/** Regions that are worth acting on at all. */
export function activeCleanupRegions(clip: { edit?: { cleanup?: CleanupRegion[] } }): CleanupRegion[] {
  return (clip.edit?.cleanup ?? []).filter(
    (region) => region.end > region.start && region.w > 1 && region.h > 1
  );
}

/**
 * The delogo fallback: one time-gated delogo per region, on the SOURCE frame
 * before the crop.
 *
 * `segmentStartSec` is where the segment begins in the source, because an ffmpeg
 * filter's `t` runs from the start of the segment it is applied to, not from the
 * start of the file. Enable windows are therefore rebased, and clamped to the
 * segment so a region outside it costs nothing.
 */
export function cleanupDelogoChain(
  regions: CleanupRegion[],
  sourceWidth: number,
  sourceHeight: number,
  segmentStartSec: number,
  segmentDuration: number
): string {
  return regions
    .filter(
      (region) =>
        region.end > segmentStartSec &&
        region.start < segmentStartSec + segmentDuration &&
        region.w > 1 &&
        region.h > 1
    )
    .map((region) => {
      const x = clampInt(region.x, 1, sourceWidth - 4);
      const y = clampInt(region.y, 1, sourceHeight - 4);
      const w = clampInt(region.w, 2, sourceWidth - x - 2);
      const h = clampInt(region.h, 2, sourceHeight - y - 2);
      const from = Math.max(0, region.start - segmentStartSec);
      const to = Math.min(segmentDuration, region.end - segmentStartSec);
      return `delogo=x=${x}:y=${y}:w=${w}:h=${h}:enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'`;
    })
    .join(",");
}

export interface InpaintPrepassInput {
  mediaPath: string;
  /** Absolute source seconds of the span the intermediate must cover. */
  spanStartSec: number;
  spanDurationSec: number;
  regions: CleanupRegion[];
  sourceWidth: number;
  sourceHeight: number;
  /** The render's scratch dir, so the intermediate is cleaned up with everything else. */
  scratchDir: string;
}

/**
 * Produce a cleaned intermediate for the whole render span, or undefined.
 *
 * Returns undefined (never throws) whenever the vision stack is unavailable or
 * the pass reports a problem, so the caller can fall back to delogo. A cleanup
 * failure must not fail a render.
 */
export async function inpaintCleanupPrepass(
  input: InpaintPrepassInput
): Promise<string | undefined> {
  if (!config.visionReframeEnabled) return undefined;
  if (input.regions.length === 0) return undefined;

  const cleanedPath = join(input.scratchDir, "cleaned.mkv");
  const withAudioPath = join(input.scratchDir, "cleaned-av.mkv");

  try {
    const result = await runCleanupInpaint({
      input: input.mediaPath,
      output: cleanedPath,
      ss: input.spanStartSec,
      duration: input.spanDurationSec,
      // The helper expects SEGMENT-relative times.
      regions: input.regions.map((region) => ({
        x: clampInt(region.x, 0, input.sourceWidth - 2),
        y: clampInt(region.y, 0, input.sourceHeight - 2),
        w: clampInt(region.w, 2, input.sourceWidth),
        h: clampInt(region.h, 2, input.sourceHeight),
        start: Math.max(0, region.start - input.spanStartSec),
        end: Math.min(input.spanDurationSec, region.end - input.spanStartSec),
      })),
    });

    if (!result.ok) {
      console.warn(`⚠️  Cleanup inpaint degraded to delogo: ${result.error ?? "unknown error"}`);
      return undefined;
    }

    // The helper writes VIDEO ONLY (lossless FFV1), so borrow the audio back from
    // the original window. Without this the cleaned render would be silent.
    const sourceHasAudio = await hasAudioStream(input.mediaPath);
    if (!sourceHasAudio) return cleanedPath;

    await runCommand(
      config.ffmpegPath,
      [
        "-y", "-v", "error",
        "-i", cleanedPath,
        "-ss", String(input.spanStartSec),
        "-t", String(input.spanDurationSec),
        "-i", input.mediaPath,
        "-map", "0:v:0",
        "-map", "1:a:0?",
        "-c", "copy",
        withAudioPath,
      ],
      { label: "cleanup audio remux" }
    );
    console.log(
      `🧽 Cleanup inpaint: ${result.inpainted ?? 0} region-frame(s) over ${result.frames ?? 0} frames`
    );
    return withAudioPath;
  } catch (error: unknown) {
    console.warn(`⚠️  Cleanup inpaint unavailable, using delogo: ${getErrorMessage(error)}`);
    return undefined;
  }
}
