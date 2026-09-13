import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { ClipProject } from "../models";
import {
  MAX_OUTRO_LOGO_BYTES,
  MAX_SHARED_OUTROS,
  SHARED_OUTRO_OWNER,
  catalogPayload,
  defaultOutroSpec,
  encodeProjectOutro,
  extractLogoPalette,
  ingestOutroLogo,
  isOutroId,
  loadSharedOutroLibrary,
  logoPath,
  newOutroId,
  nextOutroName,
  outroPreviewPath,
  pickProjectOutro,
  promoteStingToShared,
  resolveLibraryDefault,
  resolveStingOwner,
  sanitizeProjectOutro,
  saveSharedOutroLibrary,
  stingDir,
  stingHasLogo,
  stingHasPreview,
  suggestOutroFromLogo,
} from "../services/outro.service";
import type { ProjectOutro } from "../types/clip.types";
import type { ApiContext } from "../types/api.types";
import { getErrorMessage } from "../types";
import { serveLocalVideo } from "../utils";
import { fail, ok } from "../utils/response.utils";

type Ctx = ApiContext;

async function saveLibrary(
  projectId: string,
  items: ProjectOutro[],
  defaultOutroId?: string
): Promise<{ items: ProjectOutro[]; defaultOutroId?: string }> {
  const saved = await saveSharedOutroLibrary(items, defaultOutroId);
  await ClipProject.findByIdAndUpdate(projectId, {
    $set: { defaultOutroId: saved.defaultOutroId },
    $unset: { outro: 1 },
  });
  return saved;
}

async function loadLibrary(projectId: string): Promise<{
  project: NonNullable<Awaited<ReturnType<typeof ClipProject.findById>>>;
  items: ProjectOutro[];
  defaultOutroId?: string;
} | null> {
  const project = await ClipProject.findById(projectId);
  if (!project) return null;
  const shared = await loadSharedOutroLibrary();
  return {
    project,
    items: shared.items,
    defaultOutroId: resolveLibraryDefault(shared.items, project.defaultOutroId, shared.defaultOutroId),
  };
}

async function outroPayload(
  projectId: string,
  items: ProjectOutro[],
  defaultOutroId: string | undefined,
  spec: ProjectOutro | null
) {
  const outroId = spec?.id;
  return {
    spec,
    items,
    defaultOutroId,
    hasLogo: outroId ? await stingHasLogo(outroId, projectId) : false,
    hasPreview: outroId ? await stingHasPreview(outroId, projectId) : false,
    ...catalogPayload(),
  };
}

async function persistSting(
  projectId: string,
  items: ProjectOutro[],
  defaultOutroId: string | undefined,
  spec: ProjectOutro
): Promise<ProjectOutro> {
  const encoded = await encodeProjectOutro(projectId, spec);
  const sampled = (await stingHasLogo(spec.id, projectId))
    ? await extractLogoPalette(logoPath(SHARED_OUTRO_OWNER, spec.id))
    : undefined;
  const next: ProjectOutro = {
    ...spec,
    palette: sampled
      ? { bg: "#07080a", ink: sampled.ink, accent: sampled.accent, glow: sampled.glow }
      : spec.palette,
    ready: true,
    previewBytes: encoded.bytes,
    updatedAt: new Date().toISOString(),
  };
  const nextItems = items.map((item) => (item.id === next.id ? next : item));
  if (!nextItems.some((item) => item.id === next.id)) nextItems.push(next);
  await saveLibrary(projectId, nextItems, defaultOutroId);
  return next;
}

/** GET /api/projects/:id/outros */
export async function listProjectOutros({ params, set }: Ctx) {
  try {
    const loaded = await loadLibrary(params.id);
    if (!loaded) {
      set.status = 404;
      return fail("Project not found");
    }
    const spec = pickProjectOutro(loaded.items, undefined, loaded.defaultOutroId) ?? null;
    return ok(await outroPayload(params.id, loaded.items, loaded.defaultOutroId, spec));
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/projects/:id/outros */
export async function createProjectOutro({ params, body, set }: Ctx) {
  try {
    const loaded = await loadLibrary(params.id);
    if (!loaded) {
      set.status = 404;
      return fail("Project not found");
    }
    if (loaded.items.length >= MAX_SHARED_OUTROS) {
      set.status = 400;
      return fail(`The outro library can hold ${MAX_SHARED_OUTROS} stings`);
    }
    const requested = typeof (body as { name?: string } | undefined)?.name === "string"
      ? String((body as { name?: string }).name).trim().slice(0, 40)
      : "";
    const spec = defaultOutroSpec(
      { bg: "#07080a", ink: "#f4f4f6", accent: "#c8d0d6", glow: "#1a2a10" },
      undefined,
      newOutroId(),
      requested || nextOutroName(loaded.items)
    );
    const items = [...loaded.items, spec];
    const defaultOutroId = loaded.defaultOutroId ?? spec.id;
    await saveLibrary(params.id, items, defaultOutroId);
    await promoteStingToShared(params.id, spec.id);
    return ok(await outroPayload(params.id, items, defaultOutroId, spec));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/projects/:id/outros/:outroId */
export async function getProjectOutro({ params, set }: Ctx) {
  try {
    const loaded = await loadLibrary(params.id);
    if (!loaded) {
      set.status = 404;
      return fail("Project not found");
    }
    const spec = pickProjectOutro(loaded.items, params.outroId, loaded.defaultOutroId) ?? null;
    if (params.outroId && spec?.id !== params.outroId) {
      set.status = 404;
      return fail("Outro not found");
    }
    return ok(await outroPayload(params.id, loaded.items, loaded.defaultOutroId, spec));
  } catch (error: unknown) {
    set.status = 500;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/projects/:id/outros/:outroId/logo */
export async function uploadOutroLogo({ params, request, set }: Ctx) {
  const tmp = join(config.processingPath, `outro-logo-${crypto.randomUUID()}`);
  try {
    const loaded = await loadLibrary(params.id);
    if (!loaded) {
      set.status = 404;
      return fail("Project not found");
    }
    if (!isOutroId(params.outroId)) {
      set.status = 400;
      return fail("Unknown outro");
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      set.status = 400;
      return fail("A multipart `file` field is required");
    }
    if (file.size > MAX_OUTRO_LOGO_BYTES) {
      set.status = 400;
      return fail("Logo is too large (6 MB max)");
    }
    await Bun.write(tmp, file);
    const sampled = await ingestOutroLogo(params.id, params.outroId, tmp, file.name);
    const suggestion = await suggestOutroFromLogo(sampled, sampled.lightMark);
    const current =
      loaded.items.find((item) => item.id === params.outroId) ??
      defaultOutroSpec(sampled, sampled.logoName, params.outroId, nextOutroName(loaded.items));
    const spec = sanitizeProjectOutro(
      {
        id: params.outroId,
        name: current.name || sampled.logoName,
        logoName: sampled.logoName,
        palette: sampled,
        templateId: current.templateId ?? suggestion.templateId,
        cta: current.cta || suggestion.cta,
        handle: current.handle,
        durationSec: current.durationSec,
        sfxAssetId: current.sfxAssetId ?? "hit",
        sfxGain: current.sfxGain,
        musicAssetId: current.musicAssetId,
        musicGain: current.musicGain,
      },
      current
    );
    const saved = await persistSting(params.id, loaded.items, loaded.defaultOutroId, spec);
    const items = loaded.items.some((item) => item.id === saved.id)
      ? loaded.items.map((item) => (item.id === saved.id ? saved : item))
      : [...loaded.items, saved];
    return ok(await outroPayload(params.id, items, loaded.defaultOutroId ?? saved.id, saved));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** PATCH /api/projects/:id/outros/:outroId */
export async function updateProjectOutro({ params, body, set }: Ctx) {
  try {
    const loaded = await loadLibrary(params.id);
    if (!loaded) {
      set.status = 404;
      return fail("Project not found");
    }
    const current = loaded.items.find((item) => item.id === params.outroId);
    if (!current) {
      set.status = 404;
      return fail("Outro not found");
    }
    const patch = (body ?? {}) as Partial<ProjectOutro> & { makeDefault?: boolean };
    const spec = sanitizeProjectOutro({ ...patch, id: params.outroId }, current);
    let defaultOutroId = loaded.defaultOutroId;
    if (patch.makeDefault === true) defaultOutroId = spec.id;
    if (!(await stingHasLogo(spec.id, params.id))) {
      const items = loaded.items.map((item) => (item.id === spec.id ? spec : item));
      await saveLibrary(params.id, items, defaultOutroId);
      return ok(await outroPayload(params.id, items, defaultOutroId, spec));
    }
    const saved = await persistSting(params.id, loaded.items, defaultOutroId, spec);
    const items = loaded.items.map((item) => (item.id === saved.id ? saved : item));
    return ok(await outroPayload(params.id, items, defaultOutroId, saved));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** POST /api/projects/:id/outros/:outroId/preview */
export async function rebuildOutroPreview({ params, set }: Ctx) {
  try {
    const loaded = await loadLibrary(params.id);
    if (!loaded) {
      set.status = 404;
      return fail("Project not found");
    }
    const current = loaded.items.find((item) => item.id === params.outroId);
    if (!current || !(await stingHasLogo(params.outroId, params.id))) {
      set.status = 400;
      return fail("Upload a logo first");
    }
    const saved = await persistSting(params.id, loaded.items, loaded.defaultOutroId, current);
    const items = loaded.items.map((item) => (item.id === saved.id ? saved : item));
    return ok(await outroPayload(params.id, items, loaded.defaultOutroId, saved));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/projects/:id/outros/:outroId/preview */
export async function streamOutroPreview({ params, set }: Ctx) {
  try {
    const loaded = await loadLibrary(params.id);
    if (!loaded) {
      set.status = 404;
      return fail("Project not found");
    }
    if (!loaded.items.some((item) => item.id === params.outroId)) {
      set.status = 404;
      return fail("Outro not found");
    }
    await promoteStingToShared(params.id, params.outroId);
    const owner = await resolveStingOwner(params.outroId, params.id);
    const path = outroPreviewPath(owner, params.outroId);
    if (!(await stingHasPreview(params.outroId, params.id))) {
      set.status = 404;
      return fail("Outro preview is not ready");
    }
    return serveLocalVideo(set, path);
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** GET /api/projects/:id/outros/:outroId/logo */
export async function streamOutroLogo({ params, set }: Ctx) {
  try {
    const loaded = await loadLibrary(params.id);
    if (!loaded) {
      set.status = 404;
      return fail("Project not found");
    }
    if (!loaded.items.some((item) => item.id === params.outroId)) {
      set.status = 404;
      return fail("Outro not found");
    }
    await promoteStingToShared(params.id, params.outroId);
    const owner = await resolveStingOwner(params.outroId, params.id);
    const path = logoPath(owner, params.outroId);
    if (!(await stingHasLogo(params.outroId, params.id))) {
      set.status = 404;
      return fail("No logo uploaded");
    }
    return serveLocalVideo(set, path, { "content-type": "image/png" });
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}

/** DELETE /api/projects/:id/outros/:outroId */
export async function deleteProjectOutro({ params, set }: Ctx) {
  try {
    const loaded = await loadLibrary(params.id);
    if (!loaded) {
      set.status = 404;
      return fail("Project not found");
    }
    if (!loaded.items.some((item) => item.id === params.outroId)) {
      set.status = 404;
      return fail("Outro not found");
    }
    await Promise.all([
      rm(stingDir(SHARED_OUTRO_OWNER, params.outroId), { recursive: true, force: true }).catch(() => undefined),
      rm(stingDir(params.id, params.outroId), { recursive: true, force: true }).catch(() => undefined),
    ]);
    const items = loaded.items.filter((item) => item.id !== params.outroId);
    const defaultOutroId =
      loaded.defaultOutroId === params.outroId ? items[0]?.id : loaded.defaultOutroId;
    await saveLibrary(params.id, items, defaultOutroId);
    const spec = pickProjectOutro(items, undefined, defaultOutroId) ?? null;
    return ok(await outroPayload(params.id, items, defaultOutroId, spec));
  } catch (error: unknown) {
    set.status = 400;
    return fail(getErrorMessage(error));
  }
}
