import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { ensureDir } from "./file.utils";

// ============================================
// SCRATCH CUSTODY
//
// Every transient artefact a job produces — ASS subtitles, sample frames, a
// half-written render, a caption-less transcript — belongs inside one scratch
// directory that is removed wholesale when the job ends, however it ends. A
// per-file `rm` is one early return away from leaking; a directory is not.
// ============================================

/** Default age past which a processing/ entry is considered abandoned. */
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Create a uniquely-named scratch directory under `processing/`.
 *
 * The label is sanitised because it carries a clip or project id, and mkdtemp
 * appends its own random suffix so two concurrent jobs can never collide.
 */
export async function createScratchDir(label: string): Promise<string> {
  await ensureDir(config.processingPath);
  const safe = label.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 48) || "scratch";
  return mkdtemp(join(config.processingPath, `${safe}-`));
}

/** Run `fn` with a scratch directory that is always removed afterwards. */
export async function withScratch<T>(
  label: string,
  fn: (dir: string) => Promise<T>
): Promise<T> {
  const dir = await createScratchDir(label);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Remove abandoned `processing/` entries.
 *
 * The `finally` blocks are the primary guarantee, but a hard kill (OOM, SIGKILL,
 * a container eviction) skips them. This is the safety net: anything left in the
 * scratch root older than `maxAgeMs` is dead by definition, because no job holds
 * a scratch dir open for that long. Young entries are left strictly alone, so a
 * sweep can never race an in-flight render.
 */
export async function sweepProcessingDir(maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  const entries = await readdir(config.processingPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(config.processingPath, entry.name);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoff) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Raced with another sweep, or vanished — nothing to report.
    }
  }

  if (removed > 0) {
    console.log(`🧹 Swept ${removed} abandoned scratch entr${removed === 1 ? "y" : "ies"} from processing/`);
  }
  return removed;
}
