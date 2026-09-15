import { getGenerationJob, listGenerationJobs, startGeneration } from "../services/ai-assets.service";
import { senseLibrary } from "../services/sense.service";
import { addLesson, deleteLesson, listLessons } from "../services/taste.service";
import { freesoundConfigured, pickFreesound, searchFreesound, type FreesoundResult } from "../services/freesound.service";
import { epidemicConfigured, epidemicDownloadUrl, pickEpidemic, searchEpidemicSfx, searchEpidemicTracks, type EpidemicSfx, type EpidemicTrack } from "../services/epidemic.service";
import { searchLocalSounds } from "../services/sound-search.service";
import { listBuiltinAudio, listCustomAudio } from "../services/soundtrack.service";
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
    const input = body as { kind: "image" | "video" | "music" | "sfx"; prompt: string; aspectRatio?: string; durationSec?: number; fromAssetId?: string; label?: string };
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

/**
 * GET /api/studio/sounds/search?q=&source=&kind= — Epidemic Sound (SFX or
 * music) or Freesound (SFX, filtered to licences a published clip may carry).
 * Freesound results carry a preview URL; Epidemic ones get theirs on demand.
 */
export async function searchSoundsRoute({ query, set }: Ctx) {
  const input = query as { q: string; maxSec?: number; source?: "freesound" | "epidemic"; kind?: "sfx" | "music" };
  const source = input.source ?? (epidemicConfigured() ? "epidemic" : "freesound");
  try {
    if (source === "epidemic") {
      if (!epidemicConfigured()) {
        set.status = 400;
        return fail("EPIDEMIC_SOUND_API_KEY is not set");
      }
      const results = input.kind === "music" ? await searchEpidemicTracks(input.q, { limit: 15 }) : await searchEpidemicSfx(input.q, { limit: 15 });
      return ok(results.map((item) => ({ ...item, previewUrl: "" })));
    }
    if (!freesoundConfigured()) {
      set.status = 400;
      return fail("FREESOUND_API_KEY is not set — get a free key at freesound.org/apiv2/apply");
    }
    const results = await searchFreesound(input.q, { maxSec: input.maxSec ?? 8, pageSize: 15 });
    return ok(results.map((item) => ({ ...item, source: "freesound" as const, kind: "sfx" as const })));
  } catch (error: unknown) {
    set.status = 502;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/studio/sounds/preview?kind=&id= — a signed, expiring MP3 URL for an Epidemic Sound item. */
export async function previewSoundRoute({ query, set }: Ctx) {
  try {
    const input = query as { kind: "sfx" | "music"; id: string };
    return ok(await epidemicDownloadUrl(input.kind, input.id, "normal"));
  } catch (error: unknown) {
    set.status = 502;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/studio/sounds/pick-epidemic — bring an Epidemic Sound result into the shared library. */
export async function pickEpidemicRoute({ body, set }: Ctx) {
  try {
    const input = body as { kind: "sfx" | "music"; id: string; title: string; lengthSec: number; artists?: string[]; bpm?: number; moods?: string[]; genres?: string[]; hasVocals?: boolean; previewOnly?: boolean };
    const item: EpidemicSfx | EpidemicTrack =
      input.kind === "music"
        ? { source: "epidemic", kind: "music", id: input.id, title: input.title, lengthSec: input.lengthSec, artists: input.artists ?? [], bpm: input.bpm, moods: input.moods ?? [], genres: input.genres ?? [], hasVocals: Boolean(input.hasVocals), previewOnly: Boolean(input.previewOnly) }
        : { source: "epidemic", kind: "sfx", id: input.id, title: input.title, lengthSec: input.lengthSec };
    return ok(await pickEpidemic(item));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/studio/sounds/pick — bring a search result into the shared library. */
export async function pickSoundRoute({ body, set }: Ctx) {
  try {
    const input = body as FreesoundResult & { kind?: "sfx" | "music" };
    return ok(await pickFreesound(input, input.kind ?? "sfx"));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/studio/sources — which optional providers are configured, for the panel. */
export function studioSourcesRoute() {
  return ok({ freesound: freesoundConfigured(), epidemic: epidemicConfigured(), fal: Boolean(process.env.FAL_KEY?.trim()) });
}

/** GET /api/studio/sounds/local?q= — the library itself, built-ins and packs, by name and description. */
export async function searchLocalSoundsRoute({ query }: Ctx) {
  const input = query as { q: string; kind?: "sfx" | "music" };
  const assets = [...listBuiltinAudio(), ...(await listCustomAudio())];
  return ok(searchLocalSounds(input.q, assets, { kind: input.kind, limit: 40 }));
}
