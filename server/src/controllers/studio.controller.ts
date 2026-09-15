import { getGenerationJob, listGenerationJobs, startGeneration } from "../services/ai-assets.service";
import { senseLibrary } from "../services/sense.service";
import { addLesson, deleteLesson, listLessons } from "../services/taste.service";
import type { ApiContext } from "../types/api.types";
import { getErrorMessage } from "../types";
import { fail, ok } from "../utils/response.utils";

type Ctx = ApiContext;

// ============================================
// STUDIO — generated assets, the harness's catalogue, the Director's memory.
// ============================================

/** POST /api/studio/generate — a still, a video or a bed, made on OpenRouter into the library. */
export async function generateAssetRoute({ body, set }: Ctx) {
  try {
    const input = body as { kind: "image" | "video" | "music"; prompt: string; aspectRatio?: string; durationSec?: number; fromAssetId?: string; label?: string };
    const job = await startGeneration(input);
    if (job.status === "failed") {
      set.status = 502;
      return fail(job.error ?? "Generation failed");
    }
    return ok(job);
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/studio/jobs — recent generations, newest first. */
export async function listGenerationJobsRoute() {
  return ok(await listGenerationJobs());
}

/** GET /api/studio/jobs/:id */
export async function getGenerationJobRoute({ params, set }: Ctx) {
  const job = await getGenerationJob(params.id);
  if (!job) {
    set.status = 404;
    return fail("Job not found");
  }
  return ok(job);
}

/** POST /api/studio/sense-library — describe every sound and picture not yet described. */
export async function senseLibraryRoute({ set }: Ctx) {
  try {
    const result = await senseLibrary(40);
    return ok({ described: result.described, failed: result.failed, audio: result.audio.length, media: result.media.length });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/studio/lessons — what the Director has learned. */
export async function listLessonsRoute() {
  return ok(await listLessons());
}

/** POST /api/studio/lessons — a rule the creator writes down directly. */
export async function addLessonRoute({ body, set }: Ctx) {
  try {
    const input = body as { text: string; scope?: string };
    return ok(await addLesson({ scope: input.scope?.trim() || "global", kind: "feedback", text: input.text, weight: 9 }));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** DELETE /api/studio/lessons/:id */
export async function deleteLessonRoute({ params }: Ctx) {
  await deleteLesson(params.id);
  return ok({ deleted: true });
}
