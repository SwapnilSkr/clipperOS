import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { Clip, ClipProject, type IClip } from "../models";
import type { BehindTitle, CreatorPlan } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { createScratchDir, ensureDir, fileExists, getFileSize, projectMediaDir } from "../utils";
import { runCommand } from "../utils/process.utils";
import { getVideoMetadata } from "./ffmpeg.service";
import { creatorPlanActive } from "./creator-plan.service";

// ============================================
// PERSON MATTE — the cutout that lets a title sit behind the speaker.
//
// A grayscale mask video in SOURCE space (scaled down to MATTE_WIDTH), one
// frame per source frame across the clip's trim window, white where a person
// is. Only the spans that carry a behind-title (padded a little) are actually
// matted; the rest is black and costs nothing.
//
// Cached next to the project's media, keyed to the window and the spans, and
// owned by the clip: deleted with it, and swept when the clip is gone. The
// renderer and the editor preview read the same file, so the cutout you see
// is the cutout that burns.
//
// BEST-EFFORT: any failure returns null and the title renders in front.
// ============================================

export const MATTE_VERSION = 1;
export const MATTE_WIDTH = 512;
/** Extra matte on either side of a title so an eased entrance is covered. */
const SPAN_PAD_SEC = 0.4;

export interface MatteSpan {
  startSec: number;
  endSec: number;
}

export interface ClipMatte {
  path: string;
  /** Source time of the matte's first frame. */
  originSec: number;
  fps: number;
  width: number;
  height: number;
}

/** True when the vision venv can run the matting network. */
export function matteAvailable(): boolean {
  return (
    config.visionReframeEnabled &&
    existsSync(config.visionPythonPath) &&
    existsSync(config.visionMatteScriptPath) &&
    existsSync(config.visionMatteModelPath)
  );
}

/** Source spans that need a person mask: every behind-title, padded and merged. */
export function matteSpansFor(plan: CreatorPlan | undefined, trimStart: number, trimEnd: number): MatteSpan[] {
  if (!creatorPlanActive(plan)) return [];
  const spans = (plan.titles ?? [])
    .filter((title: BehindTitle) => title.depth === "behind")
    .map((title) => ({
      startSec: Math.max(trimStart, title.startSec - SPAN_PAD_SEC),
      endSec: Math.min(trimEnd, title.endSec + SPAN_PAD_SEC),
    }))
    .filter((span) => span.endSec - span.startSec > 0.05)
    .sort((a, b) => a.startSec - b.startSec);
  const merged: MatteSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.startSec <= last.endSec + 1e-6) last.endSec = Math.max(last.endSec, span.endSec);
    else merged.push({ ...span });
  }
  return merged;
}

/** The cache key: which window and which spans the file covers. */
export function matteKey(trimStart: number, trimEnd: number, spans: MatteSpan[]): string {
  return `${trimStart.toFixed(3)}-${trimEnd.toFixed(3)}:${spans
    .map((span) => `${span.startSec.toFixed(2)}-${span.endSec.toFixed(2)}`)
    .join(",")}`;
}

function matteDir(projectId: string): string {
  return join(projectMediaDir(projectId), "matte");
}

function evenDown(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

const inflight = new Map<string, Promise<ClipMatte | null>>();

/**
 * The clip's matte for its current window and titles, building it when the
 * cached one does not cover them. Null when nothing needs a matte or the
 * stack is unavailable.
 */
export async function ensureClipMatte(clipId: string): Promise<ClipMatte | null> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");
  const trimStart = clip.edit?.trimStartSec ?? clip.startSec;
  const trimEnd = clip.edit?.trimEndSec ?? clip.endSec;
  const spans = matteSpansFor(clip.edit?.creator, trimStart, trimEnd);
  if (spans.length === 0 || !matteAvailable()) return null;

  const key = matteKey(trimStart, trimEnd, spans);
  const cached = clip.matte;
  if (
    cached &&
    cached.for.v === MATTE_VERSION &&
    cached.for.spans === key &&
    (await fileExists(cached.path))
  ) {
    const meta = await getVideoMetadata(cached.path).catch(() => null);
    if (meta) return { path: cached.path, originSec: trimStart, fps: meta.frameRate, width: meta.width, height: meta.height };
  }

  const running = inflight.get(clipId);
  if (running) return running;
  const task = buildClipMatte(clip, trimStart, trimEnd, spans, key).finally(() => inflight.delete(clipId));
  inflight.set(clipId, task);
  return task;
}

async function buildClipMatte(
  clip: IClip,
  trimStart: number,
  trimEnd: number,
  spans: MatteSpan[],
  key: string
): Promise<ClipMatte | null> {
  const project = await ClipProject.findById(clip.projectId).select("mediaStatus mediaPath").lean();
  if (!project || project.mediaStatus !== "ready" || !project.mediaPath) return null;
  const mediaPath = project.mediaPath;
  const startedAt = Date.now();
  const scratch = await createScratchDir(`matte-${String(clip._id)}`);
  try {
    const meta = await getVideoMetadata(mediaPath);
    const fps = meta.frameRate > 0 ? meta.frameRate : 30;
    const width = MATTE_WIDTH;
    const height = evenDown((meta.height / meta.width) * width);
    const duration = Math.max(0.1, Math.min(trimEnd, meta.durationSec) - trimStart);
    const totalFrames = Math.max(1, Math.round(duration * fps));

    const jobSpans: { framesPath: string; startFrame: number; count: number }[] = [];
    for (const [index, span] of spans.entries()) {
      const startFrame = Math.max(0, Math.round((span.startSec - trimStart) * fps));
      const count = Math.min(totalFrames - startFrame, Math.max(1, Math.round((span.endSec - span.startSec) * fps)));
      if (count <= 0) continue;
      const framesPath = join(scratch, `span_${index}.rgb`);
      await runCommand(
        config.ffmpegPath,
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          (trimStart + startFrame / fps).toFixed(4),
          "-i",
          mediaPath,
          "-frames:v",
          String(count),
          "-vf",
          `fps=${fps},scale=${width}:${height}`,
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          framesPath,
        ],
        { label: "matte frames" }
      );
      jobSpans.push({ framesPath, startFrame, count });
    }

    const maskPath = join(scratch, "mask.gray");
    const result = await runMatte({
      width,
      height,
      totalFrames,
      outPath: maskPath,
      modelPath: config.visionMatteModelPath,
      spans: jobSpans,
    });
    if (!result.ok) throw new Error(result.error ?? "matting failed");

    const encoded = join(scratch, "matte.mp4");
    await runCommand(
      config.ffmpegPath,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-s",
        `${width}x${height}`,
        "-r",
        String(fps),
        "-i",
        maskPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "16",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        encoded,
      ],
      { label: "matte encode" }
    );

    const dir = matteDir(String(clip.projectId));
    await ensureDir(dir);
    const finalPath = join(dir, `${String(clip._id)}.mp4`);
    await rename(encoded, finalPath);
    const bytes = await getFileSize(finalPath);
    await Clip.updateOne(
      { _id: clip._id },
      { $set: { matte: { path: finalPath, for: { startSec: trimStart, endSec: trimEnd, v: MATTE_VERSION, spans: key }, bytes } } }
    );
    console.log(
      `🎭 Person matte for clip ${clip.rank}: ${result.matted} frame${result.matted === 1 ? "" : "s"} matted in ` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );
    return { path: finalPath, originSec: trimStart, fps, width, height };
  } catch (error: unknown) {
    console.warn(`⚠️  Person matte unavailable for clip ${String(clip._id)}: ${getErrorMessage(error)}`);
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface MatteResult {
  ok: boolean;
  error?: string;
  frames?: number;
  matted?: number;
}

function runMatte(job: {
  width: number;
  height: number;
  totalFrames: number;
  outPath: string;
  modelPath: string;
  spans: { framesPath: string; startFrame: number; count: number }[];
}): Promise<MatteResult> {
  return new Promise((resolve, reject) => {
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      child = Bun.spawn([config.visionPythonPath, config.visionMatteScriptPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error: unknown) {
      reject(new Error(`matte worker could not start: ${getErrorMessage(error)}`));
      return;
    }
    const stdout = Bun.readableStreamToText(child.stdout as ReadableStream<Uint8Array>);
    const stderr = Bun.readableStreamToText(child.stderr as ReadableStream<Uint8Array>);
    child.stdin.write(JSON.stringify(job));
    void child.stdin.end();
    child.exited
      .then(async (code) => {
        const [out, err] = await Promise.all([stdout, stderr]);
        if (code !== 0) {
          reject(new Error(`matte worker exited ${code}: ${err.slice(-400)}`));
          return;
        }
        try {
          resolve(JSON.parse(out) as MatteResult);
        } catch {
          reject(new Error(`matte worker produced unparseable output: ${out.slice(0, 200)}`));
        }
      })
      .catch(reject);
  });
}

/** Remove a clip's matte file (the record goes with the clip). */
export async function deleteClipMatte(clip: Pick<IClip, "matte">): Promise<void> {
  if (!clip.matte?.path) return;
  await rm(clip.matte.path, { force: true }).catch(() => undefined);
}
