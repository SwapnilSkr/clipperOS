import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import type { MediaAsset } from "../types/clip.types";
import { containedPath, ensureDir, fileExists, getFileSize, runCommand } from "../utils";
import { getVideoMetadata } from "./ffmpeg.service";

// ============================================
// MEDIA LIBRARY — stills and videos for cutaways, shared across projects.
//
// One folder on disk, like the shared audio library: `<id>.<ext>` beside an
// `<id>.json` sidecar with the probed facts, and `<id>.thumb.jpg` for the
// picker. Uploads and stock picks land here the same way; a cutaway refers
// to an asset by id, so a stock item is downloaded once and rendered from
// disk like anything else.
// ============================================

export const MAX_MEDIA_ASSETS = 200;
export const MAX_MEDIA_BYTES = 120 * 1024 * 1024;
/** A video longer than this is trimmed on ingest: cutaways are seconds long. */
export const MAX_MEDIA_VIDEO_SEC = 60;

const THUMB_WIDTH = 240;

export function mediaLibraryDir(): string {
  return config.mediaLibraryPath;
}

function isAssetId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

interface Sidecar extends MediaAsset {
  ext: string;
  /** The provider's own id, so a stock item is downloaded once. */
  sourceId?: string;
}

async function readSidecar(id: string): Promise<Sidecar | undefined> {
  if (!isAssetId(id)) return undefined;
  const path = containedPath(mediaLibraryDir(), `${id}.json`);
  const raw = await readFile(path, "utf-8").catch(() => undefined);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Sidecar;
  } catch {
    return undefined;
  }
}

function publicAsset(sidecar: Sidecar): MediaAsset {
  const { ext: _ext, sourceId: _sourceId, ...asset } = sidecar;
  return asset;
}

export async function listMediaAssets(): Promise<MediaAsset[]> {
  const dir = mediaLibraryDir();
  await ensureDir(dir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const assets: { asset: MediaAsset; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sidecar = await readSidecar(name.slice(0, -".json".length));
    if (!sidecar) continue;
    const stat = await Bun.file(join(dir, name)).stat().catch(() => undefined);
    assets.push({ asset: publicAsset(sidecar), mtime: stat?.mtimeMs ?? 0 });
  }
  // Newest first: the thing just uploaded or picked is what the user wants.
  return assets.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.asset);
}

export async function getMediaAsset(id: string): Promise<MediaAsset | undefined> {
  const sidecar = await readSidecar(id);
  return sidecar ? publicAsset(sidecar) : undefined;
}

/** The file behind an asset, or undefined when the id is unknown or the file is gone. */
export async function resolveMediaFile(id: string): Promise<{ path: string; asset: MediaAsset } | undefined> {
  const sidecar = await readSidecar(id);
  if (!sidecar) return undefined;
  const path = containedPath(mediaLibraryDir(), `${id}.${sidecar.ext}`);
  if (!(await fileExists(path))) return undefined;
  return { path, asset: publicAsset(sidecar) };
}

export function mediaThumbPath(id: string): string {
  return containedPath(mediaLibraryDir(), `${id}.thumb.jpg`);
}

/** A stock item already in the library, by provider and provider id. */
export async function findStockAsset(source: "pexels" | "pixabay", sourceId: string): Promise<MediaAsset | undefined> {
  const dir = mediaLibraryDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sidecar = await readSidecar(name.slice(0, -".json".length));
    if (sidecar?.source === source && sidecar.sourceId === sourceId) return publicAsset(sidecar);
  }
  return undefined;
}

/**
 * Bring a file into the library: probed, normalised (stills → JPEG at most
 * 2160 tall; videos → H.264 without audio, capped in length), thumbnailed.
 */
export async function ingestMediaFile(input: {
  sourcePath: string;
  originalName: string;
  kind: "image" | "video";
  source: MediaAsset["source"];
  attribution?: string;
  sourceUrl?: string;
  sourceId?: string;
}): Promise<MediaAsset> {
  const dir = mediaLibraryDir();
  await ensureDir(dir);
  const existing = await listMediaAssets();
  if (existing.length >= MAX_MEDIA_ASSETS) throw new Error(`The media library can hold ${MAX_MEDIA_ASSETS} items`);
  const size = await getFileSize(input.sourcePath);
  if (size > MAX_MEDIA_BYTES) throw new Error("File is too large (120 MB max)");

  const id = crypto.randomUUID();
  const ext = input.kind === "image" ? "jpg" : "mp4";
  const dest = join(dir, `${id}.${ext}`);
  try {
    if (input.kind === "image") {
      await runCommand(
        config.ffmpegPath,
        ["-y", "-hide_banner", "-loglevel", "error", "-i", input.sourcePath, "-frames:v", "1", "-vf", "scale='min(iw,3840)':'min(ih,2160)':force_original_aspect_ratio=decrease", "-q:v", "3", dest],
        { label: "image ingest" }
      );
    } else {
      await runCommand(
        config.ffmpegPath,
        [
          "-y", "-hide_banner", "-loglevel", "error",
          "-i", input.sourcePath,
          "-t", String(MAX_MEDIA_VIDEO_SEC),
          "-an",
          "-vf", "scale='min(iw,1920)':'min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
          dest,
        ],
        { label: "video ingest" }
      );
    }
    const meta = await getVideoMetadata(dest);
    await runCommand(
      config.ffmpegPath,
      ["-y", "-hide_banner", "-loglevel", "error", "-i", dest, "-frames:v", "1", "-vf", `scale=${THUMB_WIDTH}:-2`, "-q:v", "5", mediaThumbPath(id)],
      { label: "thumbnail" }
    ).catch(() => undefined);
    const sidecar: Sidecar = {
      id,
      ext,
      kind: input.kind,
      source: input.source,
      label: input.originalName.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || (input.kind === "image" ? "Still" : "Video"),
      width: meta.width,
      height: meta.height,
      ...(input.kind === "video" ? { durationSec: Math.round(meta.durationSec * 100) / 100 } : {}),
      ...(input.attribution ? { attribution: input.attribution } : {}),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(sidecar, null, 2));
    return publicAsset(sidecar);
  } catch (error) {
    await rm(dest, { force: true }).catch(() => undefined);
    await rm(mediaThumbPath(id), { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteMediaAsset(id: string): Promise<void> {
  const sidecar = await readSidecar(id);
  if (!sidecar) throw new Error("Unknown media asset");
  const dir = mediaLibraryDir();
  await Promise.all([
    rm(join(dir, `${id}.${sidecar.ext}`), { force: true }),
    rm(join(dir, `${id}.json`), { force: true }),
    rm(mediaThumbPath(id), { force: true }),
  ]);
}

/** A stock pick nobody placed is kept this long before the sweep may take it. */
export const STOCK_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Stock downloads no clip uses any more, once they are a day old: a
 * Director pass or a picker search can fetch a handful that never end up in
 * a plan. Uploads are the creator's own and are never swept; a stock item a
 * clip still references is kept however old it is. `referenced` is injected
 * so the rule can be exercised without a database.
 */
export async function sweepUnreferencedStock(
  input: { referenced?: () => Promise<Set<string>>; now?: number; maxAgeMs?: number } = {}
): Promise<string[]> {
  const referenced = input.referenced ?? (async () => {
    const { Clip } = await import("../models");
    const ids = (await Clip.distinct("edit.creator.cutaways.assetId")) as unknown[];
    return new Set(ids.filter((id): id is string => typeof id === "string"));
  });
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? STOCK_KEEP_MS;
  const stock: { id: string; addedAt: number }[] = [];
  for (const name of await readdir(mediaLibraryDir()).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const sidecar = await readSidecar(name.slice(0, -5));
    if (!sidecar || (sidecar.source !== "pexels" && sidecar.source !== "pixabay")) continue;
    const added = await stat(join(mediaLibraryDir(), name)).catch(() => undefined);
    if (added) stock.push({ id: sidecar.id, addedAt: added.mtimeMs });
  }
  const stale = stock.filter((item) => now - item.addedAt > maxAgeMs);
  if (stale.length === 0) return [];
  const inUse = await referenced();
  const removed: string[] = [];
  for (const item of stale) {
    if (inUse.has(item.id)) continue;
    await deleteMediaAsset(item.id).catch(() => undefined);
    removed.push(item.id);
  }
  if (removed.length > 0) {
    console.log(`🧹 Swept ${removed.length} unused stock download${removed.length === 1 ? "" : "s"}`);
  }
  return removed;
}

/** image/* or video/* by extension or MIME; undefined when neither. */
export function mediaKindOf(name: string, mime?: string): "image" | "video" | undefined {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic"].includes(ext)) return "image";
  if (["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext)) return "video";
  return undefined;
}
