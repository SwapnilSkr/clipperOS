import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { transitionInfo } from "../config/transitions";
import {
  deleteMediaAsset,
  ingestMediaFile,
  listMediaAssets,
  MAX_MEDIA_BYTES,
  mediaKindOf,
  mediaThumbPath,
  resolveMediaFile,
} from "../services/media-library.service";
import { pickStock, publicStockResult, searchStock, stockSources } from "../services/stock.service";
import type { ApiContext } from "../types/api.types";
import { getErrorMessage } from "../types";
import { fileExists, serveLocalVideo } from "../utils";
import { fail, ok } from "../utils/response.utils";

type Ctx = ApiContext;

/** GET /api/media-library */
export async function listMediaLibrary({ set }: Ctx) {
  try {
    return ok({ assets: await listMediaAssets(), stock: stockSources() });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/media-library — multipart `file` (image or video). */
export async function uploadMedia({ request, set }: Ctx) {
  const tmp = join(config.processingPath, `media-in-${crypto.randomUUID()}`);
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      set.status = 400;
      return fail("A multipart `file` field is required");
    }
    const kind = mediaKindOf(file.name, file.type);
    if (!kind) {
      set.status = 400;
      return fail("Upload an image or a video");
    }
    if (file.size > MAX_MEDIA_BYTES) {
      set.status = 400;
      return fail("File is too large (120 MB max)");
    }
    await Bun.write(tmp, file);
    return ok(await ingestMediaFile({ sourcePath: tmp, originalName: file.name, kind, source: "upload" }));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** GET /api/media-library/:id/file — the asset itself (range-served for video). */
export async function streamMedia({ params, set }: Ctx) {
  try {
    const media = await resolveMediaFile(params.id);
    if (!media) {
      set.status = 404;
      return fail("Media not found");
    }
    if (media.asset.kind === "image") {
      set.headers["content-type"] = "image/jpeg";
      set.headers["cache-control"] = "private, max-age=86400";
      return Bun.file(media.path);
    }
    return serveLocalVideo(set, media.path, { "cache-control": "private, max-age=86400" });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/media-library/:id/thumb */
export async function streamMediaThumb({ params, set }: Ctx) {
  try {
    const path = mediaThumbPath(params.id);
    if (!(await fileExists(path))) {
      set.status = 404;
      return fail("No thumbnail");
    }
    set.headers["content-type"] = "image/jpeg";
    set.headers["cache-control"] = "private, max-age=86400";
    return Bun.file(path);
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** DELETE /api/media-library/:id */
export async function deleteMedia({ params, set }: Ctx) {
  try {
    await deleteMediaAsset(params.id);
    return ok({ deleted: true });
  } catch (error: unknown) {
    set.status = 404;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/stock/search?q=&kind= */
export async function searchStockRoute({ query, set }: Ctx & { query: { q: string; kind?: "image" | "video" } }) {
  try {
    const results = await searchStock(query.q, query.kind ?? "video");
    return ok({ results: results.map(publicStockResult), sources: stockSources() });
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/stock/pick — download a result into the library. */
export async function pickStockRoute({ body, set }: Ctx) {
  try {
    const input = body as { source: "pexels" | "pixabay"; id: string; kind: "image" | "video"; query: string };
    return ok(await pickStock(input));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/transitions — how a cutaway may arrive and leave. */
export function listTransitions() {
  return ok(transitionInfo());
}
