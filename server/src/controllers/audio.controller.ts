import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { ClipProject } from "../models";
import {
  builtinAudioPath,
  customAssetFileId,
  deleteCustomAudio,
  ingestCustomAudio,
  listBuiltinAudio,
  listCustomAudio,
  MAX_CUSTOM_AUDIO_BYTES,
} from "../services/soundtrack.service";
import type { ApiContext } from "../types/api.types";
import { getErrorMessage } from "../types";
import { containedPath, fileExists, projectAudioDir, serveLocalVideo } from "../utils";
import { fail, ok } from "../utils/response.utils";

type Ctx = ApiContext;

/** GET /api/audio-library — built-in pads, plus this project's uploads when asked. */
export async function listAudioLibrary({ query, set }: Ctx) {
  const input = query as { projectId?: string };
  try {
    const builtin = listBuiltinAudio();
    const custom = input.projectId ? await listCustomAudio(input.projectId) : [];
    return ok({ builtin, custom });
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/audio-library/:id — stream a built-in pad with range support. */
export async function streamBuiltinAudio({ params, set }: Ctx) {
  const path = builtinAudioPath(params.id);
  if (!path) {
    set.status = 404;
    return fail("Unknown audio file");
  }
  return serveLocalVideo(set, path, { "content-type": "audio/mp4" });
}

/** GET /api/projects/:id/audio/:fileId — stream an uploaded pad. */
export async function streamProjectAudio({ params, set }: Ctx) {
  try {
    const project = await ClipProject.findById(params.id);
    if (!project) {
      set.status = 404;
      return fail("Project not found");
    }
    const path = containedPath(projectAudioDir(params.id), `${params.fileId}.m4a`);
    if (!(await fileExists(path))) {
      set.status = 404;
      return fail("Unknown audio file");
    }
    return serveLocalVideo(set, path, { "content-type": "audio/mp4" });
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/projects/:id/audio — ingest a custom music or SFX file. */
export async function uploadProjectAudio({ params, request, set }: Ctx) {
  const tmp = join(config.processingPath, `audio-in-${crypto.randomUUID()}`);
  try {
    const project = await ClipProject.findById(params.id);
    if (!project) {
      set.status = 404;
      return fail("Project not found");
    }
    const form = await request.formData();
    const file = form.get("file");
    const kindRaw = String(form.get("kind") ?? "sfx");
    if (kindRaw !== "music" && kindRaw !== "sfx") {
      set.status = 400;
      return fail("kind must be music or sfx");
    }
    if (!(file instanceof File)) {
      set.status = 400;
      return fail("A multipart `file` field is required");
    }
    if (file.size > MAX_CUSTOM_AUDIO_BYTES) {
      set.status = 400;
      return fail("Audio file is too large (8 MB max)");
    }
    await Bun.write(tmp, file);
    const asset = await ingestCustomAudio(params.id, kindRaw, tmp, file.name);
    return ok(asset);
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** DELETE /api/projects/:id/audio/:fileId */
export async function deleteProjectAudio({ params, set }: Ctx) {
  try {
    const project = await ClipProject.findById(params.id);
    if (!project) {
      set.status = 404;
      return fail("Project not found");
    }
    const assetId = `custom:${params.fileId}`;
    if (!customAssetFileId(assetId)) {
      set.status = 400;
      return fail("Unknown audio file");
    }
    await deleteCustomAudio(params.id, assetId);
    return ok({ deleted: true });
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}
