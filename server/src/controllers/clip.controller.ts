import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Clip } from "../models";
import { serializeClip } from "../services/project.service";
import { enqueueRender } from "../queue/queues";
import { downloadFromUrl } from "../services/s3.service";
import {
  ClipBusyError,
  createMergeClip,
  deleteClip as deleteClipRecord,
  updateClipEdit,
  wordsForClip,
  type UpdateClipInput,
} from "../services/clip.service";
import type { ApiContext } from "../types/api.types";
import { getErrorMessage } from "../types";
import { fileExists, projectOutputDir, serveLocalVideo } from "../utils";
import { fail, ok } from "../utils/response.utils";
import { previewClipReframe as runPreviewClipReframe } from "../services/clip-render.service";
import { generateClipShareCopy } from "../services/share-copy.service";
import { cleanClipCaptions } from "../services/caption-clean.service";

type Ctx = ApiContext;

/** POST /api/clips/render — queue one render job per selected clip. */
export async function renderClips({ body, set }: Ctx) {
  const input = body as { clipIds: string[]; reframeMode?: "center" | "smart"; captions?: boolean };
  try {
    const clips = await Clip.find({ _id: { $in: input.clipIds } }).lean();
    if (clips.length === 0) {
      set.status = 404;
      return fail("No matching clips");
    }

    await Clip.updateMany(
      { _id: { $in: clips.map((c) => c._id) } },
      { $set: { status: "rendering", renderProgress: 0, renderError: null } }
    );

    await enqueueRender(
      clips.map((c) => ({
        clipId: String(c._id),
        reframeMode: input.reframeMode,
        captions: input.captions,
      }))
    );

    return ok({ enqueued: clips.length });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/clips/:id */
export async function getClip({ params, set }: Ctx) {
  try {
    const clip = await Clip.findById(params.id);
    if (!clip) {
      set.status = 404;
      return fail("Clip not found");
    }
    return ok(serializeClip(clip));
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/clips/:id/download — inline stream by default, attachment with ?download=1. */
export async function downloadClip({ params, request, set }: Ctx) {
  try {
    const clip = await Clip.findById(params.id);
    if (!clip) {
      set.status = 404;
      return fail("Clip not found");
    }
    if (clip.status !== "rendered") {
      set.status = 409;
      return fail("This clip has not finished rendering");
    }

    const wantsDownload = new URL(request.url).searchParams.get("download") === "1";
    const filename = `clip_${clip.rank}_${slug(clip.peakLine || clip.hookText)}.mp4`;

    // Remote (S3/CDN): redirect for inline playback — cheap and fast. For an
    // actual download, proxy the bytes so the Content-Disposition sticks
    // (a cross-origin redirect would drop it).
    if (clip.outputUrl && /^https?:\/\//i.test(clip.outputUrl)) {
      if (!wantsDownload) return Response.redirect(clip.outputUrl, 302);
      const bytes = await downloadFromUrl(clip.outputUrl);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const path = await findLocalRender(String(clip.projectId), params.id);
    if (!path) {
      set.status = 404;
      return fail("Rendered file is missing on disk");
    }

    // Returned as a `Bun.file`, not a Response, so the runtime applies the
    // client's Range and answers 206 — see utils/stream.utils.ts.
    return serveLocalVideo(
      set,
      path,
      wantsDownload ? { "content-disposition": `attachment; filename="${filename}"` } : {}
    );
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/clips/:id/dismiss — drop a candidate from the board. */
export async function dismissClip({ params, set }: Ctx) {
  try {
    const clip = await Clip.findByIdAndUpdate(params.id, { $set: { status: "dismissed" } });
    if (!clip) {
      set.status = 404;
      return fail("Clip not found");
    }
    return ok({ dismissed: true });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** PATCH /api/clips/:id — persist edits (window, framing, caption look, title). */
export async function updateClip({ params, body, set }: Ctx) {
  try {
    const clip = await updateClipEdit(params.id, body as UpdateClipInput);
    return ok(serializeClip(clip));
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    set.status = message === "Clip not found" ? 404 : 400;
    return fail(message);
  }
}

/**
 * DELETE /api/clips/:id — purge this clip's S3 object, local render and record.
 * Distinct from dismiss, which only hides a candidate and keeps its storage.
 */
export async function deleteClip({ params, set }: Ctx) {
  try {
    return ok(await deleteClipRecord(params.id));
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    set.status = error instanceof ClipBusyError ? 409 : message === "Clip not found" ? 404 : 500;
    return fail(message);
  }
}

/** POST /api/clips/merge — build a new merged clip; the sources are kept. */
export async function mergeClips({ body, set }: Ctx) {
  try {
    const input = body as { projectId: string; clipIds: string[]; title?: string };
    return ok(serializeClip(await createMergeClip(input)));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/clips/:id/words — word onsets inside the clip's window. */
export async function getClipWords({ params, query, set }: Ctx) {
  try {
    const raw = (query ?? {}) as { startSec?: string | number; endSec?: string | number };
    const startSec = raw.startSec != null ? Number(raw.startSec) : undefined;
    const endSec = raw.endSec != null ? Number(raw.endSec) : undefined;
    return ok(
      await wordsForClip(params.id, {
        startSec: Number.isFinite(startSec) ? startSec : undefined,
        endSec: Number.isFinite(endSec) ? endSec : undefined,
      })
    );
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    set.status = message === "Clip not found" ? 404 : 500;
    return fail(message);
  }
}

/** POST /api/clips/:id/captions/clean — fix fillers and ASR on the current window. */
export async function cleanClipCaptionsRoute({ params, body, set }: Ctx) {
  try {
    const input = (body ?? {}) as {
      startSec?: number;
      endSec?: number;
      chunkWords?: number;
      listen?: boolean;
    };
    return ok(await cleanClipCaptions(params.id, input));
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    set.status = message === "Clip not found" ? 404 : message.includes("no word") ? 409 : 500;
    return fail(message);
  }
}

/** POST /api/clips/:id/share-copy — write Shorts title + description from the transcript. */
export async function writeClipShareCopy({ params, body, set }: Ctx) {
  try {
    const force = Boolean((body as { force?: boolean } | undefined)?.force);
    return ok(serializeClip(await generateClipShareCopy(params.id, force)));
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    set.status = message === "Clip not found" ? 404 : 500;
    return fail(message);
  }
}

/** POST /api/clips/:id/reframe/preview — run speaker framing for the editor. */
export async function previewClipReframe({ params, body, set }: Ctx) {
  try {
    const input = (body ?? {}) as {
      startSec?: number;
      endSec?: number;
      mode?: "center" | "smart";
    };
    await runPreviewClipReframe({
      clipId: params.id,
      startSec: input.startSec,
      endSec: input.endSec,
      mode: input.mode,
    });
    const clip = await Clip.findById(params.id);
    if (!clip) {
      set.status = 404;
      return fail("Clip not found");
    }
    return ok(serializeClip(clip));
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    set.status = message === "Clip not found" ? 404 : 400;
    return fail(message);
  }
}

async function findLocalRender(projectId: string, clipId: string): Promise<string | null> {
  const dir = projectOutputDir(projectId);
  try {
    const files = await readdir(dir);
    const match = files.find((f) => f.includes(clipId) && f.endsWith(".mp4"));
    if (!match) return null;
    const path = join(dir, match);
    return (await fileExists(path)) ? path : null;
  } catch {
    return null;
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "clip"
  );
}
