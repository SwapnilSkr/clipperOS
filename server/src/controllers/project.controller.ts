import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { listGenreProfiles, resolveGenreProfile } from "../config/genres";
import { Clip, ClipProject } from "../models";
import type { ClipProjectStatus } from "../models";
import { deletePrefix } from "../services/s3.service";
import { reconcileProjectStorage } from "../services/storage-custody.service";
import {
  createUploadProject,
  createYoutubeProject,
  ensureProjectMedia,
} from "../services/ingest.service";
import { loadSharedOutroLibrary } from "../services/outro.service";
import { serializeClip, serializeProject } from "../services/project.service";
import { generateProjectShareCopy } from "../services/share-copy.service";
import type { ApiContext } from "../types/api.types";
import { getErrorMessage } from "../types";
import { enqueueIngest, enqueueMining } from "../queue/queues";
import {
  containedPath,
  ensureDir,
  fileExists,
  isContained,
  projectAudioDir,
  projectMediaDir,
  projectOutputDir,
  projectOutroDir,
  serveLocalVideo,
} from "../utils";
import { fail, ok } from "../utils/response.utils";

type Ctx = ApiContext;

/** POST /api/projects — create from a YouTube link or an uploaded file, then ingest. */
export async function createProject({ body, set }: Ctx) {
  const input = body as { youtubeUrl?: string; uploadId?: string; title?: string; genreId?: string };
  try {
    let project;
    if (input.youtubeUrl) {
      project = await createYoutubeProject({ youtubeUrl: input.youtubeUrl, genreId: input.genreId });
    } else if (input.uploadId) {
      project = await createUploadProject({
        // containedPath refuses anything that escapes the uploads directory, so a
        // traversal attempt fails here even if it ever got past the body guard.
        uploadPath: containedPath(config.uploadsPath, input.uploadId),
        title: input.title,
        genreId: input.genreId,
      });
    } else {
      set.status = 400;
      return fail("Provide either youtubeUrl or uploadId");
    }

    // Only kick off ingest when there is work to do — re-posting a ready project
    // returns it untouched.
    if (project.status === "pending") {
      await enqueueIngest(String(project._id));
    }
    await loadSharedOutroLibrary();
    return ok(serializeProject(project));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/**
 * GET /api/genres — the available editorial rulesets, so the client can offer a
 * picker without hardcoding ids or labels.
 */
export function listGenres({ set }: Ctx) {
  try {
    return ok(
      listGenreProfiles().map((p) => ({
        id: p.id,
        label: p.label,
        summary: p.summary,
        clipDuration: p.clipDuration,
        captionsDefault: p.captionsDefault,
        peakKind: p.peakKind,
        scoringAxes: p.scoringAxes.map((a) => ({ id: a.id, label: a.label })),
        themes: p.themes,
      }))
    );
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/**
 * POST /api/projects/:id/remine — re-run mining, optionally under a different
 * genre. The transcript is already stored, so this costs one mining pass and no
 * re-ingest.
 */
export async function remineProject({ params, body, set }: Ctx) {
  const input = (body ?? {}) as { genreId?: string };
  try {
    const project = await ClipProject.findById(params.id);
    if (!project) {
      set.status = 404;
      return fail("Project not found");
    }
    if (!project.captionsAvailable) {
      set.status = 409;
      return fail("This project has no transcript to re-mine");
    }
    if (input.genreId) resolveGenreProfile(input.genreId); // throws on a bad id

    await ClipProject.findByIdAndUpdate(params.id, {
      $set: {
        status: "mining",
        stage: "Re-mining",
        progress: 40,
        error: undefined,
        // An explicit genre must be marked deliberate, or detection would
        // overwrite it on the next pass.
        ...(input.genreId ? { genreId: input.genreId, genreAutoDetected: false } : {}),
      },
    });
    await enqueueMining(params.id, input.genreId);

    const refreshed = await ClipProject.findById(params.id);
    return ok(serializeProject(refreshed!));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/projects/:id/share-copy — write Shorts paste-copy for clips that lack it. */
export async function writeProjectShareCopy({ params, body, set }: Ctx) {
  try {
    const force = Boolean((body as { force?: boolean } | undefined)?.force);
    return ok(await generateProjectShareCopy(params.id, { force }));
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    set.status = message === "Project not found" ? 404 : 500;
    return fail(message);
  }
}

/** GET /api/projects — newest first. */
export async function listProjects({ query, set }: Ctx) {
  try {
    const q = query as { limit?: string; status?: string };
    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? "50") || 50));
    const filter = q.status ? { status: q.status as ClipProjectStatus } : {};
    await loadSharedOutroLibrary();
    const docs = await ClipProject.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return ok(docs.map(serializeProject));
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/projects/:id — the project plus its ranked clips (the poller). */
export async function getProject({ params, set }: Ctx) {
  try {
    const project = await ClipProject.findById(params.id);
    if (!project) {
      set.status = 404;
      return fail("Project not found");
    }
    await loadSharedOutroLibrary();
    const clips = await Clip.find({ projectId: project._id, status: { $ne: "dismissed" } })
      .sort({ rank: 1 })
      .lean();
    return ok({ project: serializeProject(project), clips: clips.map(serializeClip) });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** Stream the locally-stored source video (uploaded sources / already-fetched media). */
export async function streamProjectMedia({ params, set }: Ctx) {
  try {
    const project = await ClipProject.findById(params.id);
    if (!project) {
      set.status = 404;
      return fail("Project not found");
    }
    const path = project.mediaPath ?? project.uploadPath;
    if (!path || !(await fileExists(path))) {
      set.status = 404;
      return fail("Source media is not available locally");
    }
    // A `Bun.file` body, so range requests work: the editor seeks this video to
    // reach a clip's window, and a multi-hundred-MB 200 response never plays.
    return serveLocalVideo(set, path);
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/**
 * POST /api/projects/:id/media/ensure — start fetching the source if it is not
 * local yet, so a never-rendered project can still be edited.
 *
 * Returns immediately: the download runs in the background under the render
 * pipeline's in-flight lock, and the project poller reports `mediaReady` when it
 * lands. The editor needs the source on disk to preview trims against.
 */
export async function ensureProjectMediaRoute({ params, set }: Ctx) {
  try {
    const project = await ClipProject.findById(params.id);
    if (!project) {
      set.status = 404;
      return fail("Project not found");
    }
    if (project.mediaStatus === "ready" && project.mediaPath) {
      return ok({ status: "ready" });
    }

    // Mark fetching before returning so the next poll is not still "absent"
    // with a silent download behind the Prepare source button.
    if (project.mediaStatus !== "fetching") {
      await ClipProject.updateOne(
        { _id: project._id },
        {
          $set: { mediaStatus: "fetching", mediaProgress: 0 },
          $unset: { mediaError: 1 },
        }
      );
    }

    // Fire and forget: the caller polls the project, exactly like a render.
    void ensureProjectMedia(String(project._id)).catch((error: unknown) => {
      console.error(
        `⚠️  Could not prepare source media for ${String(project._id)}: ${getErrorMessage(error)}`
      );
    });
    return ok({ status: "fetching" });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** DELETE /api/projects/:id — purge clips, local media, rendered output, S3 objects. */
export async function deleteProject({ params, set }: Ctx) {
  try {
    const project = await ClipProject.findById(params.id);
    if (!project) {
      set.status = 404;
      return fail("Project not found");
    }

    await Clip.deleteMany({ projectId: project._id });
    await Promise.all([
      rm(projectMediaDir(String(project._id)), { recursive: true, force: true }).catch(() => undefined),
      rm(projectOutputDir(String(project._id)), { recursive: true, force: true }).catch(() => undefined),
      rm(projectAudioDir(String(project._id)), { recursive: true, force: true }).catch(() => undefined),
      rm(projectOutroDir(String(project._id)), { recursive: true, force: true }).catch(() => undefined),
    ]);
    let s3Warning: string | undefined;
    if (project.storage === "s3" && project.s3Prefix) {
      const purge = await deletePrefix(project.s3Prefix).catch((error: unknown) => {
        console.error(`⚠️  S3 purge failed for ${project.s3Prefix}: ${getErrorMessage(error)}`);
        return null;
      });
      if (purge?.failed) {
        s3Warning = `${purge.failed} of ${purge.requested} S3 object(s) could not be deleted`;
      }
    }
    if (project.sourceType === "upload" && project.uploadPath) {
      // Only remove a path inside the uploads directory. A row written before the
      // uploadId guard existed could hold a traversal path, and rm() would have
      // happily followed it out of storage.
      if (isContained(config.uploadsPath, project.uploadPath)) {
        await rm(project.uploadPath, { force: true }).catch(() => undefined);
      } else {
        console.warn(`⚠️  Refusing to delete non-upload path: ${project.uploadPath}`);
      }
    }

    await ClipProject.findByIdAndDelete(project._id);
    return ok({ deleted: true, ...(s3Warning ? { warning: s3Warning } : {}) });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/**
 * POST /api/projects/:id/reconcile — reclaim S3 objects under this project that
 * no live clip owns. Dry run unless `?dryRun=0`, so the default is a report.
 */
export async function reconcileProject({ params, query, set }: Ctx) {
  try {
    const dryRun = (query as { dryRun?: string }).dryRun !== "0";
    const result = await reconcileProjectStorage(params.id, { dryRun });
    return ok(result);
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    set.status = message === "Project not found" ? 404 : 500;
    return fail(message);
  }
}

/** POST /api/uploads — store a file and return an id usable by POST /api/projects. */
export async function uploadFile({ request, set }: ApiContext) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      set.status = 400;
      return fail("A multipart `file` field is required");
    }

    // Sanitised so the id we mint always satisfies the UPLOAD_ID guard on
    // POST /api/projects — otherwise a filename with an exotic extension would
    // hand back an uploadId that the very next request rejects.
    const ext = ((file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4")
      .slice(0, 6);
    const uploadId = `${crypto.randomUUID()}.${ext}`;
    await ensureDir(config.uploadsPath);
    await Bun.write(join(config.uploadsPath, uploadId), file);

    return ok({ uploadId, filename: file.name, sizeBytes: file.size });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}
