import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";
import { Clip, ClipProject } from "../models";
import { getErrorMessage } from "../types";
import { deleteKeys, isS3Configured, listObjects } from "./s3.service";

// ============================================
// STORAGE CUSTODY
//
// Nets under the primary lifecycle:
//
//   sweepOrphanedOutputs     local output/ directories whose project is gone.
//   sweepUnownedLocalOutputs local renders no clip.outputPath still points at.
//   sweepAbandonedUploads    uploads/ files no project still owns.
//   sweepMediaFragments      dead source dirs and yt-dlp leftovers.
//   reconcileProjectStorage  S3 objects under a project that no live clip owns.
//
// All are deliberately conservative. Reclaiming storage is worth nothing if it
// ever races a render or deletes a clip that is one keystroke from being
// re-rendered, so anything young or in-flight is left alone. A ready project's
// source.mp4 is never touched here — that cache is why a re-render does not
// re-download a 70-minute file.
// ============================================

/** An object written this recently may belong to a render we cannot see yet. */
const RECONCILE_MIN_AGE_MS = config.reconcileMinAgeMs;

/**
 * Age past which a file in a project's media directory is debris rather than a
 * download still in progress. A 1080p source can legitimately take a while, so
 * this is deliberately generous — the point is to catch a dead download, not to
 * race a slow one.
 */
const DEFAULT_FRAGMENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface OutputSweepResult {
  removedProjects: number;
  freedBytes: number;
}

/**
 * Remove `output/{projectId}` directories that no longer have a project.
 *
 * The project-delete path removes its own directory, so this only catches the
 * casualties: a delete that crashed midway, or a database that was reset under
 * the filesystem.
 */
export async function sweepOrphanedOutputs(): Promise<OutputSweepResult> {
  const entries = await readdir(config.outputPath, { withFileTypes: true }).catch(() => []);
  let removedProjects = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    // A directory name that is not an ObjectId cannot have a project row.
    if (!/^[0-9a-f]{24}$/.test(projectId)) continue;

    try {
      const exists = await ClipProject.exists({ _id: projectId });
      if (exists) continue;

      const dir = join(config.outputPath, projectId);
      freedBytes += await directorySize(dir);
      await rm(dir, { recursive: true, force: true });
      removedProjects++;
    } catch (error: unknown) {
      console.warn(`⚠️  Could not sweep orphaned output for ${projectId}: ${getErrorMessage(error)}`);
    }
  }

  if (removedProjects > 0) {
    console.log(
      `🧹 Swept ${removedProjects} orphaned output director${removedProjects === 1 ? "y" : "ies"} ` +
        `(freed ${Math.round(freedBytes / 1024)} KB)`
    );
  }
  return { removedProjects, freedBytes };
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      total += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size;
    } catch {
      // Vanished mid-walk.
    }
  }
  return total;
}

export interface MediaSweepResult {
  removedFragments: number;
  removedDirs: number;
  freedBytes: number;
}

/**
 * Reclaim abandoned source-media directories and download fragments.
 *
 * `media/<projectId>/` holds the cached source video, which is the largest thing
 * this app writes — hundreds of MB per project. Three things rot in there:
 *
 *   1. A directory whose project is gone (a delete that crashed midway).
 *   2. yt-dlp fragments from a download that was killed: `.part`, and one
 *      untitled file per selected format before the merge. On success yt-dlp
 *      removes them itself, so anything left is debris from a failure.
 *   3. A `source.mp4` belonging to a project whose status never reached "ready",
 *      which means the download died — the file cannot be trusted as a cache.
 *
 * A file that IS the live `mediaPath` of a ready project is never touched: that is
 * the cache a render would otherwise have to re-download. Anything younger than
 * `maxAgeMs` is skipped so an in-flight download is safe.
 */
export async function sweepMediaFragments(maxAgeMs = DEFAULT_FRAGMENT_MAX_AGE_MS): Promise<MediaSweepResult> {
  const cutoff = Date.now() - maxAgeMs;
  const result: MediaSweepResult = { removedFragments: 0, removedDirs: 0, freedBytes: 0 };

  const entries = await readdir(config.mediaPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    // Stray files at the media root are never anything but debris: every real
    // source lives in its project's own directory.
    if (!entry.isDirectory()) {
      const path = join(config.mediaPath, entry.name);
      try {
        const info = await stat(path);
        if (info.mtimeMs >= cutoff) continue;
        result.freedBytes += info.size;
        await rm(path, { force: true });
        result.removedFragments++;
      } catch {
        // Vanished mid-walk.
      }
      continue;
    }

    const projectId = entry.name;
    const dir = join(config.mediaPath, projectId);

    if (!/^[0-9a-f]{24}$/.test(projectId)) continue;

    try {
      const project = await ClipProject.findById(projectId).select("mediaStatus mediaPath").lean();
      if (!project) {
        result.freedBytes += await directorySize(dir);
        await rm(dir, { recursive: true, force: true });
        result.removedDirs++;
        continue;
      }

      // Only a ready project has a source we can trust as a cache.
      const live = project.mediaStatus === "ready" ? project.mediaPath : undefined;
      const files = await readdir(dir).catch(() => [] as string[]);
      let removedSource = false;
      for (const name of files) {
        const path = join(dir, name);
        if (live && path === live) continue;
        // Person mattes are a cache owned by clips, not download debris.
        if (name === "matte") {
          const swept = await sweepMatteDir(path);
          result.removedFragments += swept.removed;
          result.freedBytes += swept.freedBytes;
          continue;
        }
        try {
          const info = await stat(path);
          if (info.mtimeMs >= cutoff) continue;
          result.freedBytes += info.size;
          await rm(path, { recursive: true, force: true });
          result.removedFragments++;
          if (path.endsWith("source.mp4")) removedSource = true;
        } catch {
          // Vanished mid-walk.
        }
      }

      // A dead download left the status lying; put it back so the next attempt
      // starts cleanly instead of skipping a source that is no longer there.
      if (removedSource && project.mediaStatus !== "ready") {
        await ClipProject.updateOne(
          { _id: projectId },
          {
            $set: { mediaStatus: "absent" },
            $unset: { mediaPath: 1, mediaBytes: 1, mediaProgress: 1 },
          }
        );
      }
    } catch (error: unknown) {
      console.warn(`⚠️  Could not sweep media for ${projectId}: ${getErrorMessage(error)}`);
    }
  }

  if (result.removedFragments > 0 || result.removedDirs > 0) {
    console.log(
      `🧹 Swept ${result.removedFragments} media fragment(s) and ${result.removedDirs} orphaned ` +
        `media director${result.removedDirs === 1 ? "y" : "ies"} (freed ${Math.round(result.freedBytes / 1024)} KB)`
    );
  }
  return result;
}

/**
 * A project's `matte/` directory holds one mask video per clip that asked for
 * one. A file survives only while a clip still records it as its matte.
 */
async function sweepMatteDir(dir: string): Promise<{ removed: number; freedBytes: number }> {
  const out = { removed: 0, freedBytes: 0 };
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const name of files) {
    const path = join(dir, name);
    const clipId = name.replace(/\.mp4$/, "");
    const owner = /^[0-9a-f]{24}$/.test(clipId)
      ? await Clip.findById(clipId).select("matte").lean()
      : null;
    if (owner?.matte?.path === path) continue;
    try {
      const info = await stat(path);
      out.freedBytes += info.size;
      await rm(path, { force: true });
      out.removed++;
    } catch {
      // Vanished mid-walk.
    }
  }
  return out;
}

export interface ReconcileResult {
  /** Keys no live clip owns. */
  orphans: string[];
  /** Keys actually deleted (0 in dry-run). */
  deleted: number;
  failed: number;
  /** Objects left alone because they are too recent to judge. */
  skipped: number;
  dryRun: boolean;
}

/**
 * Find S3 objects under a project's `clips/` prefix that no live clip owns.
 *
 * This is the only place that can reclaim a leak: an object whose database row
 * was deleted but whose S3 delete failed, or a legacy rank-keyed render retired
 * by the key change. `dryRun` defaults to true so the automatic caller can only
 * report, and an explicit user action is what actually deletes.
 */
export async function reconcileProjectStorage(
  projectId: string,
  options: { dryRun?: boolean } = {}
): Promise<ReconcileResult> {
  const dryRun = options.dryRun ?? true;
  const empty: ReconcileResult = { orphans: [], deleted: 0, failed: 0, skipped: 0, dryRun };

  const project = await ClipProject.findById(projectId);
  if (!project) throw new Error("Project not found");
  if (project.storage !== "s3" || !project.s3Prefix || !isS3Configured()) return empty;

  const clips = await Clip.find({ projectId: project._id })
    .select("outputKey status")
    .lean();

  // A render in flight persists its outputKey only after the upload completes,
  // so its object would look orphaned. Do nothing until the board is settled.
  if (clips.some((c) => c.status === "rendering")) {
    console.log(`🧹 Reconcile skipped for ${projectId}: a render is in flight`);
    return empty;
  }

  const live = new Set(clips.map((c) => c.outputKey).filter((k): k is string => Boolean(k)));
  const prefix = `${project.s3Prefix}clips/`;
  const objects = await listObjects(prefix);
  const cutoff = Date.now() - RECONCILE_MIN_AGE_MS;

  const orphans: string[] = [];
  let skipped = 0;
  for (const object of objects) {
    if (live.has(object.key)) continue;
    if (object.lastModified && object.lastModified.getTime() > cutoff) {
      skipped++;
      continue;
    }
    orphans.push(object.key);
  }

  if (dryRun || orphans.length === 0) {
    if (orphans.length > 0) {
      console.log(
        `🧹 Reconcile (dry run) ${projectId}: ${orphans.length} orphaned object(s), ` +
          `${skipped} too recent to judge`
      );
    }
    return { orphans, deleted: 0, failed: 0, skipped, dryRun };
  }

  const result = await deleteKeys(orphans);
  console.log(
    `🧹 Reconcile ${projectId}: deleted ${result.requested - result.failed}/${result.requested} orphaned object(s)`
  );
  return { orphans, deleted: result.requested - result.failed, failed: result.failed, skipped, dryRun };
}

export interface UploadSweepResult {
  removed: number;
  freedBytes: number;
}

/**
 * Remove files in `uploads/` that no project still points at.
 *
 * POST /api/uploads writes a file, then POST /api/projects claims it. A file
 * that is never claimed — or whose project was deleted without the upload
 * unlink succeeding — sits there forever otherwise. Live `uploadPath` /
 * `mediaPath` values are never touched: for an upload project those ARE the
 * source.
 */
export async function sweepAbandonedUploads(
  maxAgeMs = DEFAULT_FRAGMENT_MAX_AGE_MS
): Promise<UploadSweepResult> {
  const cutoff = Date.now() - maxAgeMs;
  const result: UploadSweepResult = { removed: 0, freedBytes: 0 };

  const owned = await ClipProject.find({
    $or: [{ uploadPath: { $type: "string" } }, { mediaPath: { $type: "string" } }],
  })
    .select("uploadPath mediaPath")
    .lean();
  const keep = new Set<string>();
  for (const project of owned) {
    if (project.uploadPath) keep.add(resolve(project.uploadPath));
    if (project.mediaPath) keep.add(resolve(project.mediaPath));
  }

  const entries = await readdir(config.uploadsPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(config.uploadsPath, entry.name);
    if (keep.has(resolve(path))) continue;
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoff) continue;
      result.freedBytes += entry.isDirectory() ? await directorySize(path) : info.size;
      await rm(path, { recursive: true, force: true });
      result.removed++;
    } catch {
      // Vanished mid-walk.
    }
  }

  if (result.removed > 0) {
    console.log(
      `🧹 Swept ${result.removed} abandoned upload(s) (freed ${Math.round(result.freedBytes / 1024)} KB)`
    );
  }
  return result;
}

export interface LocalOutputSweepResult {
  removedFiles: number;
  removedDirs: number;
  freedBytes: number;
}

/**
 * Remove local render files that no clip still records as `outputPath`.
 *
 * S3 delivery does not keep a local copy, but a previous local-mode render (or
 * an S3 fallback) can leave mp4s behind after the clip's pointer moves to the
 * CDN. Young files are skipped: a just-moved artefact is unowned for the few
 * milliseconds before `persistOutput` writes the path.
 */
export async function sweepUnownedLocalOutputs(
  maxAgeMs = config.reconcileMinAgeMs
): Promise<LocalOutputSweepResult> {
  const cutoff = Date.now() - maxAgeMs;
  const result: LocalOutputSweepResult = { removedFiles: 0, removedDirs: 0, freedBytes: 0 };

  const entries = await readdir(config.outputPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    if (!/^[0-9a-f]{24}$/.test(projectId)) continue;

    const exists = await ClipProject.exists({ _id: projectId });
    if (!exists) continue;

    const dir = join(config.outputPath, projectId);
    const clips = await Clip.find({ projectId }).select("outputPath").lean();
    const live = new Set(
      clips.map((clip) => clip.outputPath).filter((path): path is string => Boolean(path)).map((path) => resolve(path))
    );

    const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      const path = join(dir, file.name);
      if (live.has(resolve(path))) continue;
      try {
        const info = await stat(path);
        if (info.mtimeMs >= cutoff) continue;
        result.freedBytes += file.isDirectory() ? await directorySize(path) : info.size;
        await rm(path, { recursive: true, force: true });
        result.removedFiles++;
      } catch {
        // Vanished mid-walk.
      }
    }

    const leftover = await readdir(dir).catch(() => ["still-there"]);
    if (leftover.length === 0) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      result.removedDirs++;
    }
  }

  if (result.removedFiles > 0 || result.removedDirs > 0) {
    console.log(
      `🧹 Swept ${result.removedFiles} unowned local render(s) and ${result.removedDirs} empty ` +
        `output director${result.removedDirs === 1 ? "y" : "ies"} (freed ${Math.round(result.freedBytes / 1024)} KB)`
    );
  }
  return result;
}
