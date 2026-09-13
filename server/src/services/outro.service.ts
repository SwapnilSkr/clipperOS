import { cp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels } from "../config/models";
import type {
  ClipOutro,
  OutroLineAnimation,
  OutroLineStyle,
  OutroMarkStyle,
  OutroPalette,
  OutroTemplateId,
  OutroTransitionId,
  ProjectOutro,
} from "../types/clip.types";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "../types/clip.types";
import { resolveCaptionFont, listCaptionFonts } from "../config/caption-fonts";
import { getErrorMessage } from "../types";
import { assColor } from "./caption.service";
import { ensureDir, fileExists, getFileSize, projectOutroDir } from "../utils/file.utils";
import { assVideoFilter } from "../utils/ffmpeg-path.utils";
import { runCommand } from "../utils/process.utils";
import { getVideoMetadata, hasAudioStream } from "./ffmpeg.service";
import { builtinAudioPath, resolveAssetPath } from "./soundtrack.service";

export const MAX_OUTRO_LOGO_BYTES = 6 * 1024 * 1024;
export const MIN_OUTRO_SEC = 1.8;
export const MAX_OUTRO_SEC = 3.2;
export const DEFAULT_OUTRO_SEC = 2.4;
export const CTA_BASE_FONT = 32;
export const HANDLE_BASE_FONT = 20;
export const MAX_SHARED_OUTROS = 24;
export const MAX_PROJECT_OUTROS = MAX_SHARED_OUTROS;
export const SHARED_OUTRO_OWNER = "shared";
export const LEGACY_OUTRO_ID = "main";
const LEGACY_STING_FILES = ["logo.png", "outro.mp4", "plate.png", "avatar.png", "line.ass"];

export const DEFAULT_MARK: Required<OutroMarkStyle> = { sizeScale: 1, x: 0.5, y: 0.46, circle: false };

export const DEFAULT_CTA_STYLE: Required<OutroLineStyle> = {
  fontFamily: "Helvetica Neue",
  sizeScale: 1,
  textColor: "#d4d8de",
  uppercase: true,
  spacing: 6,
  animation: "fade",
  x: 0.5,
  y: 0.66,
};

export const DEFAULT_HANDLE_STYLE: Required<OutroLineStyle> = {
  fontFamily: "Helvetica Neue",
  sizeScale: 1,
  textColor: "#d4d8de",
  uppercase: false,
  spacing: 7,
  animation: "fade",
  x: 0.5,
  y: 0.72,
};

const LINE_ANIMS = new Set<OutroLineAnimation>(["none", "pop", "fade"]);

export const OUTRO_TEMPLATES: { id: OutroTemplateId; label: string; summary: string }[] = [
  { id: "lockup", label: "Lockup", summary: "Ignite. Settle. Hold." },
  { id: "sting", label: "Sting", summary: "White hit, then the mark." },
  { id: "rise", label: "Rise", summary: "Lifts in. Holds dead." },
  { id: "card", label: "Plate", summary: "Lockup with a tracked line." },
];

export const OUTRO_TRANSITIONS: {
  id: OutroTransitionId;
  label: string;
  summary: string;
  xfade: string;
  durationSec: number;
}[] = [
  { id: "smash", label: "Smash", summary: "Hard cut onto the sting.", xfade: "cut", durationSec: 0 },
  { id: "punch", label: "Punch", summary: "Zoom the last frame, then dissolve onto the sting.", xfade: "fade", durationSec: 0.28 },
  { id: "whip", label: "Whip", summary: "A horizontal smear hides the join.", xfade: "hblur", durationSec: 0.32 },
  { id: "flash", label: "Flash", summary: "One white pulse, then the mark.", xfade: "fadewhite", durationSec: 0.25 },
  { id: "dip", label: "Dip", summary: "Fade through black.", xfade: "fadeblack", durationSec: 0.33 },
  { id: "blur", label: "Blur", summary: "Talk-safe dissolve.", xfade: "fade", durationSec: 0.38 },
  { id: "push", label: "Push", summary: "The sting slides in and covers the last frame.", xfade: "coverleft", durationSec: 0.36 },
];

const TEMPLATE_IDS = new Set(OUTRO_TEMPLATES.map((item) => item.id));
const TRANSITION_IDS = new Set(OUTRO_TRANSITIONS.map((item) => item.id));

export function isOutroTemplateId(value: string): value is OutroTemplateId {
  return TEMPLATE_IDS.has(value as OutroTemplateId);
}

export function isOutroTransitionId(value: string): value is OutroTransitionId {
  return TRANSITION_IDS.has(value as OutroTransitionId);
}

export function resolveTransition(id?: string) {
  return OUTRO_TRANSITIONS.find((item) => item.id === id) ?? OUTRO_TRANSITIONS[0]!;
}

/**
 * Picture join from the finished clip onto the sting. Smash is a concat.
 * Punch zooms the last held frame then dissolves — not ffmpeg's tunnel `zoomin`.
 * Crossfades start after the talk window (`offset`), on a cloned last frame,
 * so speech never runs under the sting the way the Source preview hard-cuts.
 */
export function joinVideoGraph(transitionId: string | undefined, trans: number, offset: number): string {
  const transition = resolveTransition(transitionId);
  if (trans <= 0 || transition.xfade === "cut") {
    return "[cn][on]concat=n=2:v=1:a=0[vout]";
  }
  const dur = trans.toFixed(3);
  const at = offset.toFixed(3);
  if (transition.id === "punch") {
    const zoom =
      `if(lt(t\\,${at})\\,0\\,min(1\\,(t-${at})/${dur}))`;
    return (
      `[cn]scale=w='trunc(iw*(1+0.12*${zoom})/2)*2':h='trunc(ih*(1+0.12*${zoom})/2)*2':eval=frame,` +
      `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(iw-ow)/2:(ih-oh)/2[cz];` +
      `[cz][on]xfade=transition=fade:duration=${dur}:offset=${at}[vout]`
    );
  }
  return `[cn][on]xfade=transition=${transition.xfade}:duration=${dur}:offset=${at}[vout]`;
}

export function newOutroId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function isOutroId(value: string): boolean {
  return /^[a-z0-9]{4,24}$/.test(value);
}

export function stingDir(projectId: string, outroId: string): string {
  return join(projectOutroDir(projectId), outroId);
}

export function logoPath(projectId: string, outroId: string): string {
  return join(stingDir(projectId, outroId), "logo.png");
}

export function outroPreviewPath(projectId: string, outroId: string): string {
  return join(stingDir(projectId, outroId), "outro.mp4");
}

function platePath(projectId: string, outroId: string): string {
  return join(stingDir(projectId, outroId), "plate.png");
}

export function stingIdOf(spec: ProjectOutro | undefined): string {
  return spec?.id && isOutroId(spec.id) ? spec.id : LEGACY_OUTRO_ID;
}

export function pickProjectOutro(
  items: ProjectOutro[] | undefined,
  outroId?: string,
  defaultOutroId?: string
): ProjectOutro | undefined {
  const list = items ?? [];
  if (outroId) {
    const hit = list.find((item) => item.id === outroId);
    if (hit) return hit;
  }
  if (defaultOutroId) {
    const hit = list.find((item) => item.id === defaultOutroId);
    if (hit) return hit;
  }
  return list.find((item) => item.ready) ?? list[0];
}

export function readOutroLibrary(raw: {
  outro?: unknown;
  outros?: unknown;
  defaultOutroId?: unknown;
}): { items: ProjectOutro[]; defaultOutroId?: string } {
  const list = Array.isArray(raw.outros) ? raw.outros : [];
  const items = list
    .map((row) => coerceProjectOutro(row))
    .filter((row): row is ProjectOutro => Boolean(row?.id));
  if (items.length > 0) {
    const defaultOutroId =
      typeof raw.defaultOutroId === "string" && items.some((item) => item.id === raw.defaultOutroId)
        ? raw.defaultOutroId
        : items[0]!.id;
    return { items, defaultOutroId };
  }
  const legacy = coerceProjectOutro(raw.outro);
  if (!legacy) return { items: [] };
  const item: ProjectOutro = {
    ...legacy,
    id: legacy.id && isOutroId(legacy.id) ? legacy.id : LEGACY_OUTRO_ID,
    name: legacy.name || legacy.logoName || "Outro",
  };
  return { items: [item], defaultOutroId: item.id };
}

export function preferOutro(a: ProjectOutro, b: ProjectOutro): ProjectOutro {
  if (a.ready !== b.ready) return a.ready ? a : b;
  const aAt = Date.parse(a.updatedAt ?? "") || 0;
  const bAt = Date.parse(b.updatedAt ?? "") || 0;
  return bAt > aAt ? b : a;
}

/** Fold leftover project libraries into one shared list, keyed by sting id. */
export function mergeOutroLibraries(...groups: ProjectOutro[][]): ProjectOutro[] {
  const map = new Map<string, ProjectOutro>();
  for (const group of groups) {
    for (const item of group) {
      if (!item?.id) continue;
      const prev = map.get(item.id);
      map.set(item.id, prev ? preferOutro(prev, item) : item);
    }
  }
  return [...map.values()];
}

export function resolveLibraryDefault(
  items: ProjectOutro[],
  projectDefaultId?: string,
  vaultDefaultId?: string
): string | undefined {
  if (projectDefaultId && items.some((item) => item.id === projectDefaultId)) return projectDefaultId;
  if (vaultDefaultId && items.some((item) => item.id === vaultDefaultId)) return vaultDefaultId;
  return items.find((item) => item.ready)?.id ?? items[0]?.id;
}

type OutroLibrary = { items: ProjectOutro[]; defaultOutroId?: string };

let vaultCache: OutroLibrary | null = null;
let vaultLoad: Promise<OutroLibrary> | null = null;

export function peekSharedOutroLibrary(): OutroLibrary {
  return vaultCache ?? { items: [] };
}

export function overlaySharedOutroLibrary(
  project: { outro?: unknown; outros?: unknown; defaultOutroId?: unknown },
  shared = peekSharedOutroLibrary()
): OutroLibrary {
  const local = readOutroLibrary(project);
  if (shared.items.length === 0) return local;
  return {
    items: shared.items,
    defaultOutroId: resolveLibraryDefault(
      shared.items,
      typeof project.defaultOutroId === "string" ? project.defaultOutroId : undefined,
      shared.defaultOutroId
    ),
  };
}

function rememberVault(library: OutroLibrary): OutroLibrary {
  vaultCache = library;
  return library;
}

export async function saveSharedOutroLibrary(
  items: ProjectOutro[],
  defaultOutroId?: string
): Promise<OutroLibrary> {
  const { OutroVault, OUTRO_VAULT_ID } = await import("../models");
  const nextDefault = resolveLibraryDefault(items, defaultOutroId, defaultOutroId);
  await OutroVault.findByIdAndUpdate(
    OUTRO_VAULT_ID,
    {
      $set: {
        items,
        defaultOutroId: nextDefault,
        legacyImported: true,
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
  return rememberVault({ items, defaultOutroId: nextDefault });
}

export async function loadSharedOutroLibrary(force = false): Promise<OutroLibrary> {
  if (vaultCache && !force) return vaultCache;
  if (vaultLoad && !force) return vaultLoad;
  vaultLoad = hydrateSharedOutroLibrary().finally(() => {
    vaultLoad = null;
  });
  return vaultLoad;
}

async function hydrateSharedOutroLibrary(): Promise<OutroLibrary> {
  const { ClipProject, OutroVault, OUTRO_VAULT_ID } = await import("../models");
  const vault = await OutroVault.findById(OUTRO_VAULT_ID);
  const vaultItems = (vault?.items ?? [])
    .map((row) => coerceProjectOutro(row))
    .filter((row): row is ProjectOutro => Boolean(row?.id));
  if (vault?.legacyImported) {
    return rememberVault({
      items: vaultItems,
      defaultOutroId: resolveLibraryDefault(vaultItems, vault.defaultOutroId, vault.defaultOutroId),
    });
  }

  const projects = await ClipProject.find({}, { outro: 1, outros: 1, defaultOutroId: 1 }).lean();
  const imported = projects.map((doc) => readOutroLibrary(doc));
  const items = mergeOutroLibraries(vaultItems, ...imported.map((lib) => lib.items));
  const defaultOutroId = resolveLibraryDefault(
    items,
    vault?.defaultOutroId,
    imported.find((lib) => lib.defaultOutroId && items.some((item) => item.id === lib.defaultOutroId))
      ?.defaultOutroId
  );
  for (const project of projects) {
    for (const item of readOutroLibrary(project).items) {
      await promoteStingToShared(String(project._id), item.id);
    }
  }
  return saveSharedOutroLibrary(items, defaultOutroId);
}

export function nextOutroName(items: ProjectOutro[]): string {
  const used = new Set(items.map((item) => (item.name || "").trim().toLowerCase()));
  if (!used.has("outro")) return "Outro";
  for (let n = 2; n < 40; n += 1) {
    const label = `Outro ${n}`;
    if (!used.has(label.toLowerCase())) return label;
  }
  return "Outro";
}

export async function ensureStingDir(projectId: string, outroId: string): Promise<string> {
  const dest = stingDir(projectId, outroId);
  await ensureDir(dest);
  const root = projectOutroDir(projectId);
  for (const name of LEGACY_STING_FILES) {
    const from = join(root, name);
    const to = join(dest, name);
    if ((await fileExists(from)) && !(await fileExists(to))) {
      await rename(from, to).catch(() => undefined);
    }
  }
  return dest;
}

export async function promoteStingToShared(fromOwner: string, outroId: string): Promise<string> {
  const dest = await ensureStingDir(SHARED_OUTRO_OWNER, outroId);
  if (!fromOwner || fromOwner === SHARED_OUTRO_OWNER) return dest;
  await ensureStingDir(fromOwner, outroId);
  const src = stingDir(fromOwner, outroId);
  for (const name of LEGACY_STING_FILES) {
    const from = join(src, name);
    const to = join(dest, name);
    if ((await fileExists(from)) && !(await fileExists(to))) {
      await cp(from, to).catch(() => undefined);
    }
  }
  return dest;
}

export async function resolveStingOwner(outroId: string, hintProjectId?: string): Promise<string> {
  if (
    (await fileExists(logoPath(SHARED_OUTRO_OWNER, outroId))) ||
    (await fileExists(outroPreviewPath(SHARED_OUTRO_OWNER, outroId)))
  ) {
    return SHARED_OUTRO_OWNER;
  }
  if (
    hintProjectId &&
    ((await fileExists(logoPath(hintProjectId, outroId))) ||
      (await fileExists(outroPreviewPath(hintProjectId, outroId))))
  ) {
    return hintProjectId;
  }
  return SHARED_OUTRO_OWNER;
}

export async function stingHasLogo(outroId: string, hintProjectId?: string): Promise<boolean> {
  const owner = await resolveStingOwner(outroId, hintProjectId);
  return fileExists(logoPath(owner, outroId));
}

export async function stingHasPreview(outroId: string, hintProjectId?: string): Promise<boolean> {
  const owner = await resolveStingOwner(outroId, hintProjectId);
  return fileExists(outroPreviewPath(owner, outroId));
}

function asOutroRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { toObject?: () => Record<string, unknown> };
  if (typeof candidate.toObject === "function") return candidate.toObject();
  return value as Record<string, unknown>;
}

export function coerceProjectOutro(raw: unknown): ProjectOutro | undefined {
  const source = asOutroRecord(raw);
  if (!source) return undefined;
  const palette = asOutroRecord(source.palette);
  const mark = asOutroRecord(source.mark);
  const ctaStyle = asOutroRecord(source.ctaStyle);
  const handleStyle = asOutroRecord(source.handleStyle);
  const id = typeof source.id === "string" && isOutroId(source.id) ? source.id : "";
  return {
    id,
    name: typeof source.name === "string" ? source.name : undefined,
    ready: Boolean(source.ready),
    logoName: typeof source.logoName === "string" ? source.logoName : undefined,
    palette: palette
      ? {
          bg: String(palette.bg ?? "#07080a"),
          ink: String(palette.ink ?? "#f4f4f6"),
          accent: String(palette.accent ?? "#c8f542"),
          glow: String(palette.glow ?? "#1a2a10"),
        }
      : undefined,
    templateId: source.templateId as ProjectOutro["templateId"],
    durationSec: source.durationSec !== undefined ? Number(source.durationSec) : undefined,
    cta: typeof source.cta === "string" ? source.cta : undefined,
    handle: typeof source.handle === "string" ? source.handle : undefined,
    mark: mark
      ? {
          sizeScale: mark.sizeScale !== undefined ? Number(mark.sizeScale) : undefined,
          x: mark.x !== undefined ? Number(mark.x) : undefined,
          y: mark.y !== undefined ? Number(mark.y) : undefined,
          circle: mark.circle !== undefined ? Boolean(mark.circle) : undefined,
        }
      : undefined,
    ctaStyle: ctaStyle
      ? {
          fontFamily: typeof ctaStyle.fontFamily === "string" ? ctaStyle.fontFamily : undefined,
          sizeScale: ctaStyle.sizeScale !== undefined ? Number(ctaStyle.sizeScale) : undefined,
          textColor: typeof ctaStyle.textColor === "string" ? ctaStyle.textColor : undefined,
          uppercase: ctaStyle.uppercase !== undefined ? Boolean(ctaStyle.uppercase) : undefined,
          spacing: ctaStyle.spacing !== undefined ? Number(ctaStyle.spacing) : undefined,
          animation: isLineAnim(ctaStyle.animation) ? ctaStyle.animation : undefined,
          x: ctaStyle.x !== undefined ? Number(ctaStyle.x) : undefined,
          y: ctaStyle.y !== undefined ? Number(ctaStyle.y) : undefined,
        }
      : undefined,
    handleStyle: handleStyle
      ? {
          fontFamily: typeof handleStyle.fontFamily === "string" ? handleStyle.fontFamily : undefined,
          sizeScale: handleStyle.sizeScale !== undefined ? Number(handleStyle.sizeScale) : undefined,
          textColor: typeof handleStyle.textColor === "string" ? handleStyle.textColor : undefined,
          uppercase: handleStyle.uppercase !== undefined ? Boolean(handleStyle.uppercase) : undefined,
          spacing: handleStyle.spacing !== undefined ? Number(handleStyle.spacing) : undefined,
          animation: isLineAnim(handleStyle.animation) ? handleStyle.animation : undefined,
          x: handleStyle.x !== undefined ? Number(handleStyle.x) : undefined,
          y: handleStyle.y !== undefined ? Number(handleStyle.y) : undefined,
        }
      : undefined,
    sfxAssetId: typeof source.sfxAssetId === "string" ? source.sfxAssetId : undefined,
    musicAssetId: typeof source.musicAssetId === "string" ? source.musicAssetId : undefined,
    sfxGain: source.sfxGain !== undefined ? Number(source.sfxGain) : undefined,
    musicGain: source.musicGain !== undefined ? Number(source.musicGain) : undefined,
    previewBytes: source.previewBytes !== undefined ? Number(source.previewBytes) : undefined,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : undefined,
  };
}

async function sampleRgba(
  sourcePath: string,
  width: number
): Promise<{ buf: Buffer; width: number; height: number }> {
  const rawPath = join(projectOutroDir("tmp"), `plate-${crypto.randomUUID()}.rgba`);
  await ensureDir(projectOutroDir("tmp"));
  await runCommand(
    config.ffmpegPath,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-vf",
      `scale=${width}:-1:flags=area,format=rgba`,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      rawPath,
    ],
    { label: "logo bounds" }
  );
  const buf = await readFile(rawPath);
  await rm(rawPath, { force: true }).catch(() => undefined);
  const height = Math.max(1, Math.round(buf.length / 4 / width));
  return { buf, width, height };
}

function pixelAt(buf: Buffer, width: number, x: number, y: number) {
  const i = (y * width + x) * 4;
  return { r: buf[i] ?? 0, g: buf[i + 1] ?? 0, b: buf[i + 2] ?? 0, a: buf[i + 3] ?? 0 };
}

function evenDim(n: number): number {
  const rounded = Math.max(2, Math.round(n));
  return rounded - (rounded % 2);
}

/**
 * Tight lockup plate: crop to the mark, punch a baked-in studio field so a
 * neon logo is not a 16:9 postage stamp on the sting.
 *
 * Saturation alone cannot find the mark — a navy field is "saturated" because
 * its RGB channels are tiny and unequal. Use luma (and alpha) only.
 */
async function prepareLogoPlate(
  sourcePath: string,
  destPath: string
): Promise<{ wide: boolean; width: number; height: number }> {
  const meta = await getVideoMetadata(sourcePath);
  const sample = await sampleRgba(sourcePath, 320);
  const corners = [
    pixelAt(sample.buf, sample.width, 2, 2),
    pixelAt(sample.buf, sample.width, sample.width - 3, 2),
    pixelAt(sample.buf, sample.width, 2, sample.height - 3),
    pixelAt(sample.buf, sample.width, sample.width - 3, sample.height - 3),
  ];
  const cornerLuma = corners.reduce((sum, px) => sum + luma(px.r, px.g, px.b), 0) / 4;
  const field = {
    r: Math.round(corners.reduce((sum, px) => sum + px.r, 0) / 4),
    g: Math.round(corners.reduce((sum, px) => sum + px.g, 0) / 4),
    b: Math.round(corners.reduce((sum, px) => sum + px.b, 0) / 4),
  };
  const punchDark = cornerLuma < 0.16;
  const punchLight = cornerLuma > 0.84;

  let minX = sample.width;
  let minY = sample.height;
  let maxX = 0;
  let maxY = 0;
  let bright = 0;
  for (let y = 0; y < sample.height; y++) {
    for (let x = 0; x < sample.width; x++) {
      const px = pixelAt(sample.buf, sample.width, x, y);
      if (px.a < 40) continue;
      const level = luma(px.r, px.g, px.b);
      const isMark = punchDark
        ? level >= Math.max(0.12, cornerLuma + 0.1)
        : punchLight
          ? level <= cornerLuma - 0.12
          : true;
      if (!isMark) continue;
      bright += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const filters: string[] = [];
  if (bright > 12 && maxX > minX && maxY > minY) {
    const padX = Math.round((maxX - minX) * 0.08);
    const padY = Math.round((maxY - minY) * 0.08);
    const sx = meta.width / sample.width;
    const sy = meta.height / sample.height;
    const cropX = Math.max(0, Math.floor((minX - padX) * sx));
    const cropY = Math.max(0, Math.floor((minY - padY) * sy));
    const cropW = evenDim(Math.min(meta.width - cropX, Math.ceil((maxX - minX + 1 + padX * 2) * sx)));
    const cropH = evenDim(Math.min(meta.height - cropY, Math.ceil((maxY - minY + 1 + padY * 2) * sy)));
    if (cropW < meta.width * 0.92 || cropH < meta.height * 0.92) {
      filters.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);
    }
  }
  filters.push("format=rgba");
  if (punchDark || punchLight) {
    filters.push(`colorkey=0x${rgbToHex(field.r, field.g, field.b).slice(1)}:0.32:0.18`);
  }

  await runCommand(
    config.ffmpegPath,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-vf",
      filters.join(","),
      "-frames:v",
      "1",
      destPath,
    ],
    { label: "logo plate" }
  );
  const plate = await getVideoMetadata(destPath);
  return {
    wide: plate.width >= plate.height * 1.15,
    width: plate.width,
    height: plate.height,
  };
}

function fitMark(
  plateW: number,
  plateH: number,
  sizeScale = 1,
  circle = false
): { w: number; h: number } {
  const scale = Math.min(1.8, Math.max(0.35, sizeScale));
  if (circle) {
    const d = evenDim(Math.min(OUTPUT_WIDTH * 0.9, OUTPUT_HEIGHT * 0.55, OUTPUT_WIDTH * 0.52 * scale));
    return { w: Math.max(48, d), h: Math.max(48, d) };
  }
  const wide = plateW >= plateH * 1.15;
  let h = evenDim(OUTPUT_HEIGHT * (wide ? 0.32 : 0.24) * scale);
  let w = evenDim(h * (plateW / Math.max(1, plateH)));
  const maxW = evenDim(OUTPUT_WIDTH * 0.96);
  const maxH = evenDim(OUTPUT_HEIGHT * 0.72);
  if (w > maxW) {
    w = maxW;
    h = evenDim(w * (plateH / Math.max(1, plateW)));
  }
  if (h > maxH) {
    h = maxH;
    w = evenDim(h * (plateW / Math.max(1, plateH)));
  }
  return { w: Math.max(24, w), h: Math.max(24, h) };
}

/**
 * Sit the cropped mark inside a circular avatar disc. The sting bloom/settle
 * runs on this whole plate, so the ring moves with the logo.
 */
async function composeCirclePlate(
  sourcePath: string,
  destPath: string,
  diameter: number,
  accentHex: string
): Promise<void> {
  const size = evenDim(diameter);
  const inner = evenDim(size * 0.64);
  const ring = Math.max(3, Math.round(size * 0.018));
  const accent = parseHex(accentHex);
  const hypot = "hypot(X-W/2\\,Y-H/2)";
  const geq =
    `r='if(gt(${hypot}\\,W/2-1)\\,0\\,if(gt(${hypot}\\,W/2-${ring})\\,${accent.r}\\,10))':` +
    `g='if(gt(${hypot}\\,W/2-1)\\,0\\,if(gt(${hypot}\\,W/2-${ring})\\,${accent.g}\\,12))':` +
    `b='if(gt(${hypot}\\,W/2-1)\\,0\\,if(gt(${hypot}\\,W/2-${ring})\\,${accent.b}\\,14))':` +
    `a='if(gte(${hypot}\\,W/2)\\,0\\,if(gte(${hypot}\\,W/2-1.6)\\,255*(W/2-${hypot})/1.6\\,255))'`;
  await runCommand(
    config.ffmpegPath,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-f",
      "lavfi",
      "-i",
      `color=c=black@0:s=${size}x${size}:d=0.04:r=1,format=rgba`,
      "-filter_complex",
      `[1:v]geq=${geq}[disc];[0:v]format=rgba,scale=${inner}:${inner}:force_original_aspect_ratio=decrease:flags=lanczos[logo];[disc][logo]overlay=(W-w)/2:(H-h)/2:format=auto[out]`,
      "-map",
      "[out]",
      "-frames:v",
      "1",
      destPath,
    ],
    { label: "outro avatar" }
  );
}

export function outroJoinDuration(clipSec: number, outroSec: number, _transSec = 0): number {
  return Math.max(0.2, clipSec + outroSec);
}

/** Hard-cut graph: clip window, then the sting file from frame zero. */
export function buildOutroJoinGraph(input: {
  clipSec: number;
  outroSec: number;
  clipHasAudio: boolean;
  outroHasAudio: boolean;
}): string[] {
  const size = `${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`;
  const fit = `fps=30,scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
  const stereo = "aformat=sample_fmts=fltp:channel_layouts=stereo,aresample=44100";
  const clip = Math.max(0.2, input.clipSec);
  const sting = Math.max(0.2, input.outroSec);
  return [
    // The clip file is already the talk window. Trimming it again dropped the
    // last syllables (AAC + fps) that the editor preview still played.
    `[0:v]setpts=PTS-STARTPTS,${fit}[v0]`,
    `[1:v]${fit},setpts=PTS-STARTPTS[v1]`,
    "[v0][v1]concat=n=2:v=1:a=0[vout]",
    input.clipHasAudio
      ? `[0:a]asetpts=PTS-STARTPTS,${stereo}[a0]`
      : `anullsrc=r=44100:cl=stereo,atrim=0:${clip.toFixed(3)},asetpts=PTS-STARTPTS[a0]`,
    input.outroHasAudio
      ? `[1:a]${stereo},asetpts=PTS-STARTPTS[a1]`
      : `anullsrc=r=44100:cl=stereo,atrim=0:${sting.toFixed(3)},asetpts=PTS-STARTPTS[a1]`,
    "[a0][a1]concat=n=2:v=0:a=1[outa]",
  ];
}

/** Encode both legs. Never stream-copy — copy concat silently drops the sting. */
export function outroJoinEncodeArgs(graph: string[], durationSec: number, dest: string): string[] {
  return [
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    config.ffmpegPreset,
    "-crf",
    String(config.ffmpegCrf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-t",
    durationSec.toFixed(3),
    "-movflags",
    "+faststart",
    dest,
  ];
}

function hex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function parseHex(value: string): { r: number; g: number; b: number } {
  const clean = value.replace("#", "").trim();
  return {
    r: parseInt(clean.slice(0, 2) || "00", 16) || 0,
    g: parseInt(clean.slice(2, 4) || "00", 16) || 0,
    b: parseInt(clean.slice(4, 6) || "00", 16) || 0,
  };
}

function hexOr(value: string | undefined, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value ?? "") ? (value as string).toLowerCase() : fallback;
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  return rgbToHex(pa.r + (pb.r - pa.r) * t, pa.g + (pb.g - pa.g) * t, pa.b + (pb.b - pa.b) * t);
}

function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function sat(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export async function extractLogoPalette(
  sourcePath: string
): Promise<OutroPalette & { lightMark: boolean }> {
  const rawPath = join(projectOutroDir("tmp"), `sample-${crypto.randomUUID()}.rgba`);
  await ensureDir(projectOutroDir("tmp"));
  await runCommand(
    config.ffmpegPath,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-vf",
      "scale=160:-1:flags=area,format=rgba",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      rawPath,
    ],
    { label: "logo sample" }
  );
  const buf = await readFile(rawPath);
  await rm(rawPath, { force: true }).catch(() => undefined);

  const opaque: { r: number; g: number; b: number }[] = [];
  for (let i = 0; i + 3 < buf.length; i += 4) {
    if (buf[i + 3]! < 40) continue;
    opaque.push({ r: buf[i]!, g: buf[i + 1]!, b: buf[i + 2]! });
  }
  if (opaque.length === 0) {
    return { bg: "#07080a", ink: "#f4f4f6", accent: "#c8f542", glow: "#1a2a10", lightMark: true };
  }

  let accent = opaque[0]!;
  let best = -1;
  let meanL = 0;
  let markCount = 0;
  for (const px of opaque) {
    const level = luma(px.r, px.g, px.b);
    meanL += level;
    if (level < 0.14) continue;
    markCount += 1;
    const score = sat(px.r, px.g, px.b) * (0.35 + level);
    if (score > best) {
      best = score;
      accent = px;
    }
  }
  if (markCount === 0) {
    accent = opaque.reduce((pick, px) => (luma(px.r, px.g, px.b) > luma(pick.r, pick.g, pick.b) ? px : pick), opaque[0]!);
  }
  meanL /= opaque.length;
  const accentHex = rgbToHex(accent.r, accent.g, accent.b);
  return {
    bg: "#07080a",
    ink: "#f4f4f6",
    accent: accentHex,
    glow: mixHex("#07080a", accentHex, 0.18),
    lightMark: meanL > 0.55,
  };
}

function assStamp(seconds: number): string {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  const carry = cs >= 100 ? 1 : 0;
  return `${h}:${String(m).padStart(2, "0")}:${String(s + carry).padStart(2, "0")}.${String(
    cs >= 100 ? 0 : cs
  ).padStart(2, "0")}`;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function clampNum(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFrac(value: number | undefined, fallback: number): number {
  return clampNum(value, 0.04, 0.96, fallback);
}

function isLineAnim(value: unknown): value is OutroLineAnimation {
  return typeof value === "string" && LINE_ANIMS.has(value as OutroLineAnimation);
}

function assMotion(animation: OutroLineAnimation): string {
  if (animation === "pop") return "\\fscx112\\fscy112\\t(0,160,\\fscx100\\fscy100)";
  if (animation === "fade") return "\\fad(280,0)";
  return "";
}

export function sanitizeMarkStyle(
  raw: Partial<OutroMarkStyle> | undefined,
  current?: OutroMarkStyle
): Required<OutroMarkStyle> {
  const merged = { ...DEFAULT_MARK, ...current, ...raw };
  return {
    sizeScale: clampNum(merged.sizeScale, 0.35, 1.8, DEFAULT_MARK.sizeScale),
    x: clampFrac(merged.x, DEFAULT_MARK.x),
    y: clampFrac(merged.y, DEFAULT_MARK.y),
    circle: Boolean(merged.circle),
  };
}

export function sanitizeLineStyle(
  raw: Partial<OutroLineStyle> | undefined,
  fallback: Required<OutroLineStyle>,
  current?: OutroLineStyle
): Required<OutroLineStyle> {
  const merged = { ...fallback, ...current, ...raw };
  return {
    fontFamily: resolveCaptionFont(merged.fontFamily),
    sizeScale: clampNum(merged.sizeScale, 0.5, 2.5, fallback.sizeScale),
    textColor: hexOr(merged.textColor, fallback.textColor),
    uppercase: Boolean(merged.uppercase),
    spacing: clampNum(merged.spacing, 0, 16, fallback.spacing),
    animation: isLineAnim(merged.animation) ? merged.animation : fallback.animation,
    x: clampFrac(merged.x, fallback.x),
    y: clampFrac(merged.y, fallback.y),
  };
}

async function writeOutroAss(
  destPath: string,
  spec: {
    duration: number;
    start: number;
    cta: string;
    handle: string;
    ctaStyle: Required<OutroLineStyle>;
    handleStyle: Required<OutroLineStyle>;
  }
): Promise<boolean> {
  const end = assStamp(spec.duration);
  const rows: string[] = [];
  if (spec.cta) {
    const text = spec.ctaStyle.uppercase ? spec.cta.trim().replace(/\s+/g, " ").toUpperCase() : spec.cta.trim();
    const x = Math.round(spec.ctaStyle.x * OUTPUT_WIDTH);
    const y = Math.round(spec.ctaStyle.y * OUTPUT_HEIGHT);
    rows.push(
      `Dialogue: 0,${assStamp(spec.start)},${end},Line,,0,0,0,,{${assMotion(spec.ctaStyle.animation)}\\an5\\pos(${x},${y})}${escapeAss(text)}`
    );
  }
  if (spec.handle) {
    const label = spec.handle.startsWith("@") ? spec.handle : `@${spec.handle}`;
    const text = spec.handleStyle.uppercase ? label.toUpperCase() : label;
    const start = spec.start + (spec.cta ? 0.16 : 0);
    const x = Math.round(spec.handleStyle.x * OUTPUT_WIDTH);
    const y = Math.round(spec.handleStyle.y * OUTPUT_HEIGHT);
    rows.push(
      `Dialogue: 0,${assStamp(start)},${end},Handle,,0,0,0,,{${assMotion(spec.handleStyle.animation)}\\an5\\pos(${x},${y})}${escapeAss(text)}`
    );
  }
  if (rows.length === 0) return false;
  const ctaSize = Math.round(CTA_BASE_FONT * spec.ctaStyle.sizeScale);
  const handleSize = Math.round(HANDLE_BASE_FONT * spec.handleStyle.sizeScale);
  await writeFile(
    destPath,
    `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUTPUT_WIDTH}
PlayResY: ${OUTPUT_HEIGHT}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Line,${spec.ctaStyle.fontFamily},${ctaSize},${assColor(spec.ctaStyle.textColor)},&H00000000,&H00000000,&H00000000,-1,0,0,0,100,100,${spec.ctaStyle.spacing},0,1,0,0,5,0,0,0,1
Style: Handle,${spec.handleStyle.fontFamily},${handleSize},${assColor(spec.handleStyle.textColor)},&H00000000,&H00000000,&H00000000,-1,0,0,0,100,100,${spec.handleStyle.spacing},0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${rows.join("\n")}
`,
    "utf-8"
  );
  return true;
}

export function outroNeedsJoin(attach: ClipOutro | undefined, hasPreview: boolean): boolean {
  return hasPreview && attach?.enabled !== false;
}

export function catalogPayload() {
  return {
    templates: OUTRO_TEMPLATES,
    transitions: OUTRO_TRANSITIONS.map(({ id, label, summary, durationSec }) => ({
      id,
      label,
      summary,
      durationSec,
    })),
    fonts: listCaptionFonts().map((font) => ({
      id: font.id,
      label: font.label,
      family: font.family,
      stack: font.stack,
      weight: font.weight,
    })),
    defaults: {
      mark: DEFAULT_MARK,
      ctaStyle: DEFAULT_CTA_STYLE,
      handleStyle: DEFAULT_HANDLE_STYLE,
    },
    maxOutros: MAX_SHARED_OUTROS,
  };
}

export function defaultOutroSpec(
  palette: OutroPalette,
  logoName?: string,
  id?: string,
  name?: string
): ProjectOutro {
  return {
    id: id && isOutroId(id) ? id : newOutroId(),
    name: (name || logoName || "Outro").slice(0, 40),
    ready: false,
    logoName,
    palette,
    templateId: "lockup",
    durationSec: DEFAULT_OUTRO_SEC,
    cta: "",
    handle: "",
    mark: { ...DEFAULT_MARK },
    ctaStyle: { ...DEFAULT_CTA_STYLE },
    handleStyle: { ...DEFAULT_HANDLE_STYLE },
    sfxAssetId: "hit",
    sfxGain: 0.7,
  };
}

export async function suggestOutroFromLogo(
  palette: OutroPalette,
  lightMark: boolean
): Promise<{ templateId: OutroTemplateId; cta: string }> {
  const fallback = {
    templateId: (lightMark ? "lockup" : "sting") as OutroTemplateId,
    cta: "",
  };
  if (!config.openRouterApiKey) return fallback;
  try {
    const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });
    const { text } = await generateText({
      model: openrouter(resolveModels("cheap").llm),
      maxOutputTokens: 80,
      prompt:
        `Short-form 9:16 logo sting on studio black. No cards, boxes, or end-screens. ` +
        `Logo mark is ${lightMark ? "light" : "dark"}. ` +
        `Pick one template: lockup, sting, rise, card. ` +
        `CTA is empty (preferred), or a 2-4 word noun phrase. ` +
        `Never Follow, Subscribe, emoji, or smash that bell. ` +
        `JSON only: {"templateId":"...","cta":"..."}`,
    });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as { templateId?: string; cta?: string };
    const templateId = parsed.templateId ?? "";
    return {
      templateId: isOutroTemplateId(templateId) ? templateId : fallback.templateId,
      cta: (parsed.cta || fallback.cta).trim().slice(0, 42),
    };
  } catch {
    return fallback;
  }
}

export function sanitizeProjectOutro(raw: Partial<ProjectOutro>, current?: ProjectOutro): ProjectOutro {
  const base = current
    ? { ...current }
    : defaultOutroSpec(
        raw.palette ?? { bg: "#07080a", ink: "#f4f4f6", accent: "#c8f542", glow: "#1a2a10" },
        raw.logoName,
        raw.id,
        raw.name
      );
  if (raw.id && isOutroId(raw.id)) base.id = raw.id;
  else if (!base.id || !isOutroId(base.id)) base.id = current?.id && isOutroId(current.id) ? current.id : newOutroId();
  if (raw.name !== undefined) base.name = String(raw.name).trim().slice(0, 40) || base.name || "Outro";
  else if (!base.name) base.name = base.logoName || "Outro";
  if (raw.palette) {
    const next = { ...base.palette, ...raw.palette };
    base.palette = {
      bg: hexOr(next.bg, "#07080a"),
      ink: hexOr(next.ink, "#f4f4f6"),
      accent: hexOr(next.accent, "#c8f542"),
      glow: hexOr(next.glow, "#1a2a10"),
    };
  }
  if (raw.logoName !== undefined) base.logoName = String(raw.logoName).slice(0, 80);
  if (raw.templateId && isOutroTemplateId(raw.templateId)) base.templateId = raw.templateId;
  if (raw.durationSec !== undefined) {
    const n = Number(raw.durationSec);
    if (Number.isFinite(n)) base.durationSec = Math.min(MAX_OUTRO_SEC, Math.max(MIN_OUTRO_SEC, n));
  }
  if (raw.cta !== undefined) base.cta = String(raw.cta).trim().slice(0, 42);
  if (raw.handle !== undefined) base.handle = String(raw.handle).trim().replace(/^@/, "").slice(0, 32);
  base.mark = sanitizeMarkStyle(raw.mark, base.mark);
  base.ctaStyle = sanitizeLineStyle(raw.ctaStyle, DEFAULT_CTA_STYLE, base.ctaStyle);
  base.handleStyle = sanitizeLineStyle(raw.handleStyle, DEFAULT_HANDLE_STYLE, base.handleStyle);
  if (raw.sfxAssetId !== undefined) base.sfxAssetId = raw.sfxAssetId ? String(raw.sfxAssetId).slice(0, 80) : undefined;
  if (raw.musicAssetId !== undefined) {
    base.musicAssetId = raw.musicAssetId ? String(raw.musicAssetId).slice(0, 80) : undefined;
  }
  if (raw.sfxGain !== undefined) base.sfxGain = Math.min(1.5, Math.max(0, Number(raw.sfxGain) || 0));
  if (raw.musicGain !== undefined) base.musicGain = Math.min(1.5, Math.max(0, Number(raw.musicGain) || 0));
  return base;
}

export function sanitizeClipOutro(raw: ClipOutro): ClipOutro {
  const out: ClipOutro = {};
  if (raw.enabled !== undefined) out.enabled = Boolean(raw.enabled);
  if (raw.transitionId !== undefined) {
    if (!isOutroTransitionId(raw.transitionId)) throw new Error("Unknown outro transition");
    out.transitionId = raw.transitionId;
  }
  if (raw.outroId !== undefined) {
    const id = String(raw.outroId).trim();
    if (id && !isOutroId(id)) throw new Error("Unknown outro");
    out.outroId = id || undefined;
  }
  return out;
}

export async function ingestOutroLogo(
  projectId: string,
  outroId: string,
  sourcePath: string,
  originalName: string
): Promise<OutroPalette & { lightMark: boolean; logoName: string }> {
  const size = await getFileSize(sourcePath);
  if (size > MAX_OUTRO_LOGO_BYTES) throw new Error("Logo is too large (6 MB max)");
  await promoteStingToShared(projectId, outroId);
  const dest = logoPath(SHARED_OUTRO_OWNER, outroId);
  await runCommand(
    config.ffmpegPath,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-vf",
      "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease",
      "-frames:v",
      "1",
      dest,
    ],
    { label: "logo ingest" }
  );
  const sampled = await extractLogoPalette(dest);
  return {
    ...sampled,
    logoName: originalName.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "Logo",
  };
}

export async function encodeProjectOutro(
  projectId: string,
  spec: ProjectOutro
): Promise<{ bytes: number; durationSec: number }> {
  const outroId = stingIdOf(spec);
  const dir = await promoteStingToShared(projectId, outroId);
  const mark = logoPath(SHARED_OUTRO_OWNER, outroId);
  if (!(await fileExists(mark))) throw new Error("Upload a logo first");
  const dest = outroPreviewPath(SHARED_OUTRO_OWNER, outroId);
  const duration = spec.durationSec ?? DEFAULT_OUTRO_SEC;
  const template = spec.templateId && isOutroTemplateId(spec.templateId) ? spec.templateId : "lockup";
  const plate = platePath(SHARED_OUTRO_OWNER, outroId);
  const plateMeta = await prepareLogoPlate(mark, plate);
  const markStyle = sanitizeMarkStyle(spec.mark);
  const ctaStyle = sanitizeLineStyle(spec.ctaStyle, DEFAULT_CTA_STYLE);
  const handleStyle = sanitizeLineStyle(spec.handleStyle, DEFAULT_HANDLE_STYLE);
  const markSize = fitMark(plateMeta.width, plateMeta.height, markStyle.sizeScale, markStyle.circle);
  const cta = (spec.cta ?? "").trim();
  const handle = (spec.handle ?? "").trim().replace(/^@/, "");
  const visual = markStyle.circle ? join(dir, "avatar.png") : plate;
  if (markStyle.circle) {
    await composeCirclePlate(
      plate,
      visual,
      markSize.w,
      hexOr(spec.palette?.accent, "#c8d0d6")
    );
  }
  const pad = evenDim(Math.max(48, 80 * markStyle.sizeScale));
  const overlayX = Math.round(markStyle.x * OUTPUT_WIDTH - markSize.w / 2 - pad);
  const overlayYBase = Math.round(markStyle.y * OUTPUT_HEIGHT - markSize.h / 2 - pad);
  const risePx = template === "rise" ? 88 : 0;
  const overlayY = risePx
    ? `${overlayYBase}+${risePx}*pow(1-min(1\\,t/0.4)\\,3)`
    : String(overlayYBase);
  const settle =
    template === "rise"
      ? ""
      : `scale=w='trunc(iw*(1+0.08*pow(1-min(1\\,t/0.42)\\,3))/2)*2':h='trunc(ih*(1+0.08*pow(1-min(1\\,t/0.42)\\,3))/2)*2':eval=frame,`;
  const sharpIn = template === "sting" ? 0.02 : 0.05;
  const sharpDur = template === "sting" ? 0.08 : 0.22;
  const pulseOut = template === "sting" ? 0.1 : 0.14;
  const pulseDur = template === "sting" ? 0.28 : 0.4;
  const glowAlpha = template === "sting" ? 0.5 : 0.42;
  const lineStart = template === "sting" ? 0.72 : 0.88;
  const assPath = join(dir, "line.ass");
  const hasType = await writeOutroAss(assPath, {
    duration,
    start: lineStart,
    cta,
    handle,
    ctaStyle,
    handleStyle,
  });

  const inputs: string[] = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x050607:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:d=${duration.toFixed(3)}:r=30`,
    "-loop",
    "1",
    "-t",
    duration.toFixed(3),
    "-i",
    visual,
  ];
  let next = 2;
  let sfxIndex: number | undefined;
  let musicIndex: number | undefined;
  if (spec.sfxAssetId) {
    const path = (await resolveAssetPath(projectId, spec.sfxAssetId)) ?? builtinAudioPath(spec.sfxAssetId);
    if (path) {
      sfxIndex = next;
      inputs.push("-i", path);
      next += 1;
    }
  }
  if (spec.musicAssetId) {
    const path = await resolveAssetPath(projectId, spec.musicAssetId);
    if (path) {
      musicIndex = next;
      inputs.push("-stream_loop", "-1", "-t", duration.toFixed(3), "-i", path);
    }
  }

  const graph: string[] = [
    template === "sting"
      ? "[0:v]format=rgba,fade=t=in:st=0:d=0.06:color=white[field]"
      : "[0:v]format=rgba[field]",
    `[1:v]format=rgba,scale=${markSize.w}:${markSize.h}:flags=lanczos,pad=${markSize.w + pad * 2}:${markSize.h + pad * 2}:${pad}:${pad}:color=0x00000000,${settle}split=3[s][g][p]`,
    `[g]gblur=sigma=20:steps=2,colorchannelmixer=aa=${glowAlpha},fade=t=in:st=0:d=0.12:alpha=1[glow]`,
    `[p]gblur=sigma=9:steps=2,colorchannelmixer=rr=1.4:gg=1.35:bb=1.5:aa=0.85,fade=t=in:st=0:d=0.05:alpha=1,fade=t=out:st=${pulseOut}:d=${pulseDur}:alpha=1[pulse]`,
    `[s]unsharp=5:5:0.5:3:3:0,fade=t=in:st=${sharpIn}:d=${sharpDur}:alpha=1[sharp]`,
    `[field][glow]overlay=x=${overlayX}:y='${overlayY}':format=auto[t1]`,
    `[t1][pulse]overlay=x=${overlayX}:y='${overlayY}':format=auto[t2]`,
    `[t2][sharp]overlay=x=${overlayX}:y='${overlayY}':format=auto[branded]`,
  ];
  let video = "[branded]";
  if (hasType) {
    graph.push(`${video}${assVideoFilter(assPath)}[lettered]`);
    video = "[lettered]";
  }
  graph.push(`${video}format=yuv420p[vout]`);

  const mixParts: string[] = [];
  if (sfxIndex != null) {
    const gain = (spec.sfxGain ?? 0.7).toFixed(3);
    graph.push(
      `[${sfxIndex}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,aresample=44100,volume=${gain},afade=t=out:st=${Math.max(0, duration - 0.4).toFixed(2)}:d=0.4,apad=whole_dur=${duration.toFixed(3)}[sfx]`
    );
    mixParts.push("[sfx]");
  }
  if (musicIndex != null) {
    const gain = (spec.musicGain ?? 0.18).toFixed(3);
    graph.push(
      `[${musicIndex}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,aresample=44100,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain},afade=t=in:d=0.2,afade=t=out:st=${Math.max(0, duration - 0.45).toFixed(2)}:d=0.45,apad=whole_dur=${duration.toFixed(3)}[bed]`
    );
    mixParts.push("[bed]");
  }
  if (mixParts.length === 0) {
    graph.push(`anullsrc=r=44100:cl=stereo,atrim=0:${duration.toFixed(3)}[outa]`);
  } else if (mixParts.length === 1) {
    graph.push(`${mixParts[0]}anull[outa]`);
  } else {
    graph.push(
      `${mixParts.join("")}amix=inputs=${mixParts.length}:duration=first:dropout_transition=0:normalize=0[outa]`
    );
  }

  try {
    await runCommand(
      config.ffmpegPath,
      [
        ...inputs,
        "-filter_complex",
        graph.join(";"),
        "-map",
        "[vout]",
        "-map",
        "[outa]",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "16",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-t",
        duration.toFixed(3),
        "-movflags",
        "+faststart",
        dest,
      ],
      { label: "outro encode" }
    );
  } catch (error: unknown) {
    throw new Error(`Could not compose outro: ${getErrorMessage(error)}`);
  }
  return { bytes: await getFileSize(dest), durationSec: duration };
}

export async function appendOutroToClip(
  projectId: string,
  clipPath: string,
  clipDurationSec: number,
  attach: ClipOutro | undefined,
  scratchDir: string,
  sting?: ProjectOutro
): Promise<{ path: string; durationSec: number }> {
  const outroId =
    sting?.id && isOutroId(sting.id)
      ? sting.id
      : attach?.outroId && isOutroId(attach.outroId)
        ? attach.outroId
        : LEGACY_OUTRO_ID;
  await promoteStingToShared(projectId, outroId);
  const owner = await resolveStingOwner(outroId, projectId);
  const preview = outroPreviewPath(owner, outroId);
  const hasPreview = await fileExists(preview);
  if (!outroNeedsJoin(attach, hasPreview)) {
    return { path: clipPath, durationSec: clipDurationSec };
  }
  const clipMeta = await getVideoMetadata(clipPath).catch(() => null);
  const probedClip = clipMeta?.durationSec ?? 0;
  const clipSec = probedClip > 0.2 ? probedClip : clipDurationSec;
  const outroMeta = await getVideoMetadata(preview);
  const outroSec = outroMeta.durationSec > 0.4 ? outroMeta.durationSec : DEFAULT_OUTRO_SEC;
  const mixedPath = join(scratchDir, "with-outro.mp4");
  const expected = outroJoinDuration(clipSec, outroSec);
  const clipHasAudio = await hasAudioStream(clipPath);
  const outroHasAudio = await hasAudioStream(preview);
  const graph = buildOutroJoinGraph({
    clipSec,
    outroSec,
    clipHasAudio,
    outroHasAudio,
  });
  const args = outroJoinEncodeArgs(graph, expected, mixedPath);

  try {
    await runCommand(
      config.ffmpegPath,
      ["-y", "-hide_banner", "-loglevel", "error", "-i", clipPath, "-i", preview, ...args],
      { label: "outro join" }
    );
  } catch (error: unknown) {
    throw new Error(`Could not join outro: ${getErrorMessage(error)}`);
  }

  const written = await getVideoMetadata(mixedPath).catch(() => null);
  if (!written || written.durationSec < clipSec + outroSec * 0.85) {
    throw new Error(
      `Outro did not land on the file (${written?.durationSec?.toFixed(1) ?? "0"}s, ` +
        `expected ${expected.toFixed(1)}s).`
    );
  }
  console.log(`🎬 Joined sting ${outroSec.toFixed(1)}s after ${clipSec.toFixed(1)}s clip`);
  return { path: mixedPath, durationSec: written.durationSec };
}

export async function sweepOrphanedOutros(): Promise<number> {
  const { ClipProject } = await import("../models");
  const entries = await readdir(config.outroPath, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "tmp") {
      await rm(join(config.outroPath, entry.name), { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    if (entry.name === SHARED_OUTRO_OWNER) continue;
    if (!/^[0-9a-f]{24}$/.test(entry.name)) continue;
    const exists = await ClipProject.exists({ _id: entry.name });
    if (exists) continue;
    await rm(join(config.outroPath, entry.name), { recursive: true, force: true }).catch(() => undefined);
    removed++;
  }
  if (removed > 0) {
    console.log(`🧹 Swept ${removed} orphaned outro director${removed === 1 ? "y" : "ies"}`);
  }
  return removed;
}
