import { Types } from "mongoose";
import { join } from "node:path";
import { Clip, ClipProject, type IClip } from "../models";
import { getErrorMessage } from "../types";
import type {
  CaptionOverrides,
  CaptionTextOverride,
  CaptionWordOverride,
  CleanupRegion,
  ClipEdit,
  ClipOutro,
  ClipSegment,
  MusicBed,
  Soundtrack,
  SoundtrackHit,
  VideoEffects,
  VttWordTiming,
} from "../types/clip.types";
import { mergeClipOutro, sanitizeClipOutro } from "./outro.service";
import { isEmptyCreatorPlan, plainCreatorPlan, sanitizeCreatorPlan } from "./creator-plan.service";
import { generateClipShareCopy } from "./share-copy.service";
import { MAX_CAPTION_WORD_OVERRIDES, MAX_CLEANUP_REGIONS } from "../types/clip.types";
import { MAX_MUSIC_BEDS, MAX_SOUNDTRACK_HITS, musicBeds } from "./soundtrack.service";
import { resolveCaptionFont } from "../config/caption-fonts";
import { deleteFile, getFileSize, listFiles, projectOutputDir } from "../utils";
import { buildWordTimeline } from "./mining.service";
import { expandWordTimings } from "./transcript.service";
import { deleteKey, getS3KeyFromUrl } from "./s3.service";

// ============================================
// CLIP EDITING & LIFECYCLE
//
// The board used to end at "rendered". This is what happens after: persisting
// an edit spec, building a merge, and tearing one clip down without touching
// anything that isn't its own.
// ============================================

const MAX_SEGMENTS = 20;
const MAX_TITLE_LENGTH = 200;

/** Recompute and store a project's live output size. Returns the new total. */
export async function recomputeProjectStorage(projectId: string): Promise<number> {
  const [row] = await Clip.aggregate<{ total: number }>([
    { $match: { projectId: new Types.ObjectId(projectId) } },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$outputBytes", 0] } } } },
  ]);
  const total = row?.total ?? 0;
  await ClipProject.updateOne({ _id: projectId }, { $set: { storageBytes: total } });
  return total;
}

/**
 * The stored edit as a PLAIN object, with unset fields omitted.
 *
 * `{ ...clip.edit }` is not a copy of the edit — on a hydrated document it
 * spreads Mongoose's own machinery (`$__`, `$isNew`, `_doc`) and the result does
 * not round-trip through the sub-schema cast: the nested `captionOverrides`
 * sub-path was silently dropped, so every caption-override control saved nothing
 * while still reporting success. Read the fields through `toObject()` instead.
 */
function toPlainEdit(edit: IClip["edit"] | null | undefined): ClipEdit {
  if (!edit) return {};
  const candidate = edit as { toObject?: () => Record<string, unknown> };
  const source =
    typeof candidate.toObject === "function"
      ? candidate.toObject()
      : (edit as unknown as Record<string, unknown>);

  const out: ClipEdit = {};
  if (source.trimStartSec !== undefined) out.trimStartSec = Number(source.trimStartSec);
  if (source.trimEndSec !== undefined) out.trimEndSec = Number(source.trimEndSec);
  if (source.reframeMode === "center" || source.reframeMode === "smart") {
    out.reframeMode = source.reframeMode;
  }
  if (source.captionsOn !== undefined) out.captionsOn = Boolean(source.captionsOn);
  if (typeof source.captionStyleId === "string") out.captionStyleId = source.captionStyleId;
  if (typeof source.editTemplateId === "string") out.editTemplateId = source.editTemplateId;

  const videoEffects = source.videoEffects as Record<string, unknown> | null | undefined;
  if (videoEffects && typeof videoEffects === "object") {
    const clean: VideoEffects = {};
    if (["natural", "vibrant", "warm", "cool", "cinematic"].includes(String(videoEffects.grade))) {
      clean.grade = videoEffects.grade as VideoEffects["grade"];
    }
    if (["none", "hook_push", "peak_punch"].includes(String(videoEffects.motion))) {
      clean.motion = videoEffects.motion as VideoEffects["motion"];
    }
    if (videoEffects.zoom !== undefined) clean.zoom = Number(videoEffects.zoom);
    if (videoEffects.sharpen !== undefined) clean.sharpen = Number(videoEffects.sharpen);
    if (videoEffects.vignette !== undefined) clean.vignette = Boolean(videoEffects.vignette);
    if (["natural", "voice", "loud"].includes(String(videoEffects.audio))) {
      clean.audio = videoEffects.audio as VideoEffects["audio"];
    }
    if (Object.keys(clean).length > 0) out.videoEffects = clean;
  }

  const soundtrack = source.soundtrack as Record<string, unknown> | null | undefined;
  if (soundtrack && typeof soundtrack === "object") {
    const clean = plainSoundtrack(soundtrack);
    if (!isEmptySoundtrack(clean)) out.soundtrack = clean;
  }

  const outro = source.outro as Record<string, unknown> | null | undefined;
  if (outro && typeof outro === "object") {
    const clean = plainClipOutro(outro);
    if (!isEmptyClipOutro(clean)) out.outro = clean;
  }

  const captionTextOverrides = source.captionTextOverrides;
  if (Array.isArray(captionTextOverrides) && captionTextOverrides.length > 0) {
    out.captionTextOverrides = captionTextOverrides.map((item) => ({
      startSec: Number(item.startSec ?? 0),
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      ...(typeof item.text === "string" ? { text: item.text } : {}),
      ...(item.displayStartSec !== undefined ? { displayStartSec: Number(item.displayStartSec) } : {}),
      ...(item.endSec !== undefined ? { endSec: Number(item.endSec) } : {}),
      ...(item.hidden !== undefined ? { hidden: Boolean(item.hidden) } : {}),
      ...(item.custom !== undefined ? { custom: Boolean(item.custom) } : {}),
    }));
  }

  const captionWordOverrides = source.captionWordOverrides;
  if (Array.isArray(captionWordOverrides) && captionWordOverrides.length > 0) {
    out.captionWordOverrides = captionWordOverrides.map((item) => ({
      t: Number(item.t ?? 0),
      ...(typeof item.word === "string" ? { word: item.word } : {}),
      ...(item.hidden !== undefined ? { hidden: Boolean(item.hidden) } : {}),
    }));
  }

  const cleanup = source.cleanup;
  if (Array.isArray(cleanup) && cleanup.length > 0) {
    out.cleanup = cleanup.map((region) => ({
      id: String(region.id ?? ""),
      x: Number(region.x ?? 0),
      y: Number(region.y ?? 0),
      w: Number(region.w ?? 0),
      h: Number(region.h ?? 0),
      start: Number(region.start ?? 0),
      end: Number(region.end ?? 0),
    }));
  }

  const overrides = source.captionOverrides as Record<string, unknown> | null | undefined;
  if (overrides && typeof overrides === "object") {
    const clean: CaptionOverrides = {};
    if (overrides.chunkWords !== undefined) clean.chunkWords = Number(overrides.chunkWords);
    if (overrides.sizeScale !== undefined) clean.sizeScale = Number(overrides.sizeScale);
    if (overrides.verticalFrac !== undefined) clean.verticalFrac = Number(overrides.verticalFrac);
    if (overrides.horizontalFrac !== undefined) clean.horizontalFrac = Number(overrides.horizontalFrac);
    if (typeof overrides.textColor === "string") clean.textColor = overrides.textColor;
    if (overrides.background === "none" || overrides.background === "box") clean.background = overrides.background;
    if (overrides.animation === "none" || overrides.animation === "pop" || overrides.animation === "fade") {
      clean.animation = overrides.animation;
    }
    if (typeof overrides.peakColor === "string") clean.peakColor = overrides.peakColor;
    if (overrides.peakEmphasis !== undefined) clean.peakEmphasis = Boolean(overrides.peakEmphasis);
    if (typeof overrides.fontFamily === "string") clean.fontFamily = resolveCaptionFont(overrides.fontFamily);
    if (overrides.uppercase !== undefined) clean.uppercase = Boolean(overrides.uppercase);
    if (overrides.highlight === "none" || overrides.highlight === "word") clean.highlight = overrides.highlight;
    if (Object.keys(clean).length > 0) out.captionOverrides = clean;
  }

  const creator = plainCreatorPlan(source.creator);
  if (creator) out.creator = creator;
  return out;
}

export interface UpdateClipInput {
  title?: string;
  /**
   * The edit to persist. An omitted field keeps its stored value.
   *
   * `captionOverrides` is the exception, and it needs an explicit empty object
   * to reset: sending `{}` clears the override map, while omitting the key
   * leaves it untouched. Omitting cannot clear it — an absent field means "no
   * change" everywhere else in this object — so "reset to the preset" is
   * expressed as `captionOverrides: {}`.
   */
  edit?: ClipEdit;
  /** Full replacement segment list. Only valid on a merged clip. */
  segments?: ClipSegment[];
}

/**
 * Persist a clip's edits. Purely a metadata write — no render, no storage churn,
 * so an editor can save freely while the user keeps tweaking.
 */
export async function updateClipEdit(clipId: string, input: UpdateClipInput): Promise<IClip> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");

  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};

  if (input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
    if (title) $set.title = title;
    else $unset.title = 1;
  }

  if (input.edit !== undefined) {
    const edit = sanitizeEdit(input.edit);
    const stored = toPlainEdit(clip.edit);
    const next = { ...stored, ...edit };
    if (edit.outro !== undefined && !isEmptyClipOutro(edit.outro)) {
      next.outro = mergeClipOutro(stored.outro, edit.outro);
    }
    // An explicitly empty array is a RESET, not "no change" — the same rule the
    // caption overrides follow, and the only way the editor can clear the regions.
    if (edit.cleanup !== undefined && edit.cleanup.length === 0) {
      delete next.cleanup;
    }
    // An explicitly empty override map is a RESET, not "no change" — that is the
    // only way the editor can return a clip to its preset.
    if (edit.captionOverrides !== undefined && Object.keys(edit.captionOverrides).length === 0) {
      delete next.captionOverrides;
    }
    if (edit.captionTextOverrides !== undefined && edit.captionTextOverrides.length === 0) {
      delete next.captionTextOverrides;
    }
    if (edit.captionWordOverrides !== undefined && edit.captionWordOverrides.length === 0) {
      delete next.captionWordOverrides;
    }
    if (edit.videoEffects !== undefined && Object.keys(edit.videoEffects).length === 0) {
      delete next.videoEffects;
    }
    if (edit.soundtrack !== undefined && isEmptySoundtrack(edit.soundtrack)) {
      delete next.soundtrack;
    }
    if (edit.outro !== undefined && isEmptyClipOutro(edit.outro)) {
      delete next.outro;
    }
    if (edit.creator !== undefined && isEmptyCreatorPlan(edit.creator)) {
      delete next.creator;
    }
    assertWindowValid(clip, next);
    if (Object.keys(next).length > 0) $set.edit = next;
    else $unset.edit = 1;
  }

  if (input.segments !== undefined) {
    if (clip.kind !== "merge") throw new Error("Segments can only be edited on a merged clip");
    const segments = sanitizeSegments(input.segments);
    if (segments.length === 0) throw new Error("A merge needs at least one segment");
    $set.segments = segments;
    $set.startSec = Math.min(...segments.map((s) => s.startSec));
    $set.endSec = Math.max(...segments.map((s) => s.endSec));
    $set.durationSec = segments.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
  }

  if (Object.keys($set).length === 0 && Object.keys($unset).length === 0) return clip;

  const updated = await Clip.findByIdAndUpdate(
    clipId,
    { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
    { returnDocument: "after" }
  );
  return updated ?? clip;
}

function clampNumber(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Expected a finite number");
  return Math.min(max, Math.max(min, n));
}

function sanitizeEdit(raw: ClipEdit): ClipEdit {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid edit payload");
  const edit: ClipEdit = {};

  if (raw.trimStartSec !== undefined) edit.trimStartSec = clampNumber(raw.trimStartSec, 0, 24 * 3600);
  if (raw.trimEndSec !== undefined) edit.trimEndSec = clampNumber(raw.trimEndSec, 0, 24 * 3600);

  if (raw.reframeMode !== undefined) {
    if (raw.reframeMode !== "center" && raw.reframeMode !== "smart") {
      throw new Error(`Unknown reframe mode "${String(raw.reframeMode)}"`);
    }
    edit.reframeMode = raw.reframeMode;
  }
  if (raw.captionsOn !== undefined) edit.captionsOn = Boolean(raw.captionsOn);
  if (raw.captionStyleId !== undefined) {
    if (typeof raw.captionStyleId !== "string") throw new Error("captionStyleId must be a string");
    edit.captionStyleId = raw.captionStyleId.trim().slice(0, 40);
  }
  if (raw.captionOverrides !== undefined) {
    edit.captionOverrides = sanitizeOverrides(raw.captionOverrides);
  }
  if (raw.captionTextOverrides !== undefined) {
    edit.captionTextOverrides = sanitizeCaptionTextOverrides(raw.captionTextOverrides);
  }
  if (raw.captionWordOverrides !== undefined) {
    edit.captionWordOverrides = sanitizeCaptionWordOverrides(raw.captionWordOverrides);
  }
  if (raw.editTemplateId !== undefined) {
    if (typeof raw.editTemplateId !== "string") throw new Error("editTemplateId must be a string");
    edit.editTemplateId = raw.editTemplateId.trim().slice(0, 40);
  }
  if (raw.videoEffects !== undefined) edit.videoEffects = sanitizeVideoEffects(raw.videoEffects);
  if (raw.soundtrack !== undefined) edit.soundtrack = sanitizeSoundtrack(raw.soundtrack);
  if (raw.outro !== undefined) edit.outro = sanitizeClipOutro(raw.outro);
  if (raw.cleanup !== undefined) {
    edit.cleanup = sanitizeCleanup(raw.cleanup);
  }
  if (raw.creator !== undefined) edit.creator = sanitizeCreatorPlan(raw.creator);
  return edit;
}

function sanitizeVideoEffects(raw: VideoEffects): VideoEffects {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid video effects");
  const out: VideoEffects = {};
  if (raw.grade !== undefined) {
    if (!["natural", "vibrant", "warm", "cool", "cinematic"].includes(raw.grade)) {
      throw new Error("Unknown colour grade");
    }
    out.grade = raw.grade;
  }
  if (raw.motion !== undefined) {
    if (!["none", "hook_push", "peak_punch"].includes(raw.motion)) throw new Error("Unknown motion effect");
    out.motion = raw.motion;
  }
  if (raw.zoom !== undefined) out.zoom = clampNumber(raw.zoom, 1, 1.12);
  if (raw.sharpen !== undefined) out.sharpen = clampNumber(raw.sharpen, 0, 1);
  if (raw.vignette !== undefined) out.vignette = Boolean(raw.vignette);
  if (raw.audio !== undefined) {
    if (!["natural", "voice", "loud"].includes(raw.audio)) throw new Error("Unknown audio treatment");
    out.audio = raw.audio;
  }
  return out;
}

function isEmptyClipOutro(attach: ClipOutro): boolean {
  return attach.enabled === undefined && attach.transitionId === undefined && attach.outroId === undefined;
}

function plainClipOutro(source: Record<string, unknown>): ClipOutro {
  const out: ClipOutro = {};
  if (source.enabled !== undefined) out.enabled = Boolean(source.enabled);
  if (typeof source.transitionId === "string") out.transitionId = source.transitionId as ClipOutro["transitionId"];
  if (typeof source.outroId === "string") out.outroId = source.outroId;
  return out;
}

function isEmptySoundtrack(track: Soundtrack): boolean {
  return (
    (track.voiceGain === undefined || Math.abs(track.voiceGain - 1) < 0.001) &&
    musicBeds(track).length === 0 &&
    !(track.sfx && track.sfx.length > 0)
  );
}

const BED_NUMBER_FIELDS = ["gain", "inSec", "outSec", "offsetSec", "fadeInSec", "fadeOutSec", "dip"] as const;

function plainBed(bed: Record<string, unknown>): MusicBed {
  const out: MusicBed = { id: String(bed.id ?? ""), assetId: String(bed.assetId ?? "") };
  for (const field of BED_NUMBER_FIELDS) {
    if (bed[field] !== undefined && bed[field] !== null) out[field] = Number(bed[field]);
  }
  if (bed.carryIntoOutro !== undefined && bed.carryIntoOutro !== null) out.carryIntoOutro = Boolean(bed.carryIntoOutro);
  return out;
}

/** A stored soundtrack as the client sees it: the pre-`beds` single bed becomes `beds[0]`. */
function plainSoundtrack(source: Record<string, unknown>): Soundtrack {
  const out: Soundtrack = {};
  if (source.voiceGain !== undefined) out.voiceGain = Number(source.voiceGain);
  const beds = Array.isArray(source.beds)
    ? source.beds.map((item) => plainBed(item as Record<string, unknown>)).filter((bed) => bed.id && bed.assetId)
    : musicBeds({ music: source.music as Soundtrack["music"] });
  if (beds.length > 0) out.beds = beds;
  if (Array.isArray(source.sfx) && source.sfx.length > 0) {
    out.sfx = source.sfx.map((item) => {
      const hit = item as Record<string, unknown>;
      return {
        id: String(hit.id ?? ""),
        assetId: String(hit.assetId ?? ""),
        atSec: Number(hit.atSec ?? 0),
        ...(hit.gain !== undefined ? { gain: Number(hit.gain) } : {}),
      };
    });
  }
  return out;
}

function sanitizeSoundtrack(raw: Soundtrack): Soundtrack {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid soundtrack");
  const out: Soundtrack = {};
  if (raw.voiceGain !== undefined) out.voiceGain = clampNumber(raw.voiceGain, 0, 1.5);
  // Beds are what is stored; a client still sending the single `music` bed gets it as beds[0].
  const beds = raw.beds !== undefined ? raw.beds : raw.music !== undefined ? musicBeds({ music: raw.music }) : undefined;
  if (beds !== undefined) {
    if (!Array.isArray(beds)) throw new Error("beds must be an array");
    if (beds.length > MAX_MUSIC_BEDS) throw new Error(`At most ${MAX_MUSIC_BEDS} music beds per clip`);
    out.beds = beds.map(sanitizeBed);
  }
  if (raw.sfx !== undefined) {
    if (!Array.isArray(raw.sfx)) throw new Error("sfx must be an array");
    if (raw.sfx.length > MAX_SOUNDTRACK_HITS) throw new Error(`At most ${MAX_SOUNDTRACK_HITS} sound effects per clip`);
    out.sfx = raw.sfx.map(sanitizeHit);
  }
  return out;
}

function sanitizeBed(raw: MusicBed): MusicBed {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid music bed");
  const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 80) : "";
  if (!id) throw new Error("Each music bed needs an id");
  const out: MusicBed = { id, assetId: sanitizeAssetId(raw.assetId) };
  if (raw.gain !== undefined) out.gain = clampNumber(raw.gain, 0, 1.5);
  if (raw.inSec !== undefined) out.inSec = clampNumber(raw.inSec, 0, 24 * 3600);
  if (raw.outSec !== undefined) out.outSec = clampNumber(raw.outSec, 0, 24 * 3600);
  if (raw.offsetSec !== undefined) out.offsetSec = clampNumber(raw.offsetSec, 0, 24 * 3600);
  if (raw.fadeInSec !== undefined) out.fadeInSec = clampNumber(raw.fadeInSec, 0, 10);
  if (raw.fadeOutSec !== undefined) out.fadeOutSec = clampNumber(raw.fadeOutSec, 0, 10);
  if (raw.dip !== undefined) out.dip = clampNumber(raw.dip, 0, 1);
  if (raw.carryIntoOutro !== undefined) out.carryIntoOutro = Boolean(raw.carryIntoOutro);
  if (out.outSec !== undefined && out.outSec <= (out.inSec ?? 0)) throw new Error("A music bed must go out after it comes in");
  return out;
}

function sanitizeHit(raw: SoundtrackHit): SoundtrackHit {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid sound effect");
  const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 80) : "";
  if (!id) throw new Error("Each sound effect needs an id");
  return {
    id,
    assetId: sanitizeAssetId(raw.assetId),
    atSec: clampNumber(raw.atSec, 0, 24 * 3600),
    ...(raw.gain !== undefined ? { gain: clampNumber(raw.gain, 0, 1.5) } : {}),
  };
}

function sanitizeAssetId(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Unknown audio file");
  const id = raw.trim();
  if (/^[a-z][a-z0-9_]{0,31}$/.test(id)) return id;
  if (/^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return id;
  throw new Error("Unknown audio file");
}

function sanitizeCleanup(raw: CleanupRegion[]): CleanupRegion[] {
  if (!Array.isArray(raw)) throw new Error("cleanup must be an array");
  if (raw.length > MAX_CLEANUP_REGIONS) {
    throw new Error(`At most ${MAX_CLEANUP_REGIONS} cleanup regions are allowed`);
  }
  return raw.map((region, index) => {
    if (typeof region !== "object" || region === null) {
      throw new Error(`Cleanup region ${index + 1} is not an object`);
    }
    const start = clampNumber(region.start, 0, 24 * 3600);
    const end = clampNumber(region.end, 0, 24 * 3600);
    if (end <= start) throw new Error(`Cleanup region ${index + 1} ends before it starts`);
    return {
      id: typeof region.id === "string" && region.id.trim() ? region.id.trim().slice(0, 64) : `r${index + 1}`,
      x: clampNumber(region.x, 0, 20000),
      y: clampNumber(region.y, 0, 20000),
      // A rect under 2px is a mis-drag, not a watermark.
      w: clampNumber(region.w, 2, 20000),
      h: clampNumber(region.h, 2, 20000),
      start,
      end,
    };
  });
}

function sanitizeOverrides(raw: CaptionOverrides): CaptionOverrides {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid caption overrides");
  const out: CaptionOverrides = {};
  if (raw.chunkWords !== undefined) out.chunkWords = clampNumber(raw.chunkWords, 1, 12);
  if (raw.sizeScale !== undefined) out.sizeScale = clampNumber(raw.sizeScale, 0.3, 3);
  if (raw.verticalFrac !== undefined) out.verticalFrac = clampNumber(raw.verticalFrac, 0, 0.8);
  if (raw.horizontalFrac !== undefined) out.horizontalFrac = clampNumber(raw.horizontalFrac, 0, 1);
  if (raw.textColor !== undefined) {
    if (typeof raw.textColor !== "string" || !/^#[0-9a-f]{6}$/i.test(raw.textColor.trim())) {
      throw new Error("textColor must be a #rrggbb colour");
    }
    out.textColor = raw.textColor.trim().toLowerCase();
  }
  if (raw.background !== undefined) {
    if (raw.background !== "none" && raw.background !== "box") throw new Error("Unknown caption background");
    out.background = raw.background;
  }
  if (raw.animation !== undefined) {
    if (raw.animation !== "none" && raw.animation !== "pop" && raw.animation !== "fade") {
      throw new Error("Unknown caption animation");
    }
    out.animation = raw.animation;
  }
  if (raw.peakColor !== undefined) {
    if (typeof raw.peakColor !== "string" || !/^#[0-9a-f]{6}$/i.test(raw.peakColor.trim())) {
      throw new Error("peakColor must be a #rrggbb colour");
    }
    out.peakColor = raw.peakColor.trim().toLowerCase();
  }
  if (raw.peakEmphasis !== undefined) out.peakEmphasis = Boolean(raw.peakEmphasis);
  if (raw.fontFamily !== undefined) {
    if (typeof raw.fontFamily !== "string") throw new Error("fontFamily must be a string");
    out.fontFamily = resolveCaptionFont(raw.fontFamily);
  }
  if (raw.uppercase !== undefined) out.uppercase = Boolean(raw.uppercase);
  if (raw.highlight !== undefined) {
    if (raw.highlight !== "none" && raw.highlight !== "word") throw new Error("Unknown caption highlight");
    out.highlight = raw.highlight;
  }
  return out;
}

function sanitizeCaptionWordOverrides(raw: CaptionWordOverride[]): CaptionWordOverride[] {
  if (!Array.isArray(raw)) throw new Error("captionWordOverrides must be an array");
  if (raw.length > MAX_CAPTION_WORD_OVERRIDES) {
    throw new Error(`At most ${MAX_CAPTION_WORD_OVERRIDES} word corrections are allowed`);
  }
  const unique = new Map<number, CaptionWordOverride>();
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) throw new Error(`Word correction ${index + 1} is invalid`);
    const t = Math.round(clampNumber(item.t, 0, 24 * 3600) * 1000) / 1000;
    const out: CaptionWordOverride = { t };
    if (item.word !== undefined) {
      if (typeof item.word !== "string") throw new Error(`Word correction ${index + 1} text is invalid`);
      out.word = item.word.replace(/\s+/g, " ").trim().slice(0, 120);
    }
    if (item.hidden !== undefined) out.hidden = Boolean(item.hidden);
    if (!out.word && !out.hidden) continue;
    unique.set(Math.round(t * 1000), out);
  }
  return [...unique.values()].sort((a, b) => a.t - b.t);
}

function sanitizeCaptionTextOverrides(raw: CaptionTextOverride[]): CaptionTextOverride[] {
  if (!Array.isArray(raw)) throw new Error("captionTextOverrides must be an array");
  if (raw.length > 240) throw new Error("At most 240 subtitle corrections are allowed");
  const unique = new Map<string, CaptionTextOverride>();
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) throw new Error(`Subtitle correction ${index + 1} is invalid`);
    const startSec = Math.round(clampNumber(item.startSec, 0, 24 * 3600) * 1000) / 1000;
    const custom = Boolean(item.custom);
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 64) : undefined;
    if (custom && !id) throw new Error(`Custom subtitle ${index + 1} needs an id`);
    const out: CaptionTextOverride = { startSec };
    if (id) out.id = id;
    if (item.text !== undefined) {
      if (typeof item.text !== "string") throw new Error(`Subtitle correction ${index + 1} text is invalid`);
      out.text = item.text.replace(/\s+/g, " ").trim().slice(0, 160);
    }
    if (item.displayStartSec !== undefined) {
      out.displayStartSec = Math.round(clampNumber(item.displayStartSec, 0, 24 * 3600) * 1000) / 1000;
    }
    if (item.endSec !== undefined) {
      out.endSec = Math.round(clampNumber(item.endSec, 0, 24 * 3600) * 1000) / 1000;
    }
    if (item.hidden !== undefined) out.hidden = Boolean(item.hidden);
    if (custom) out.custom = true;
    const actualStart = out.displayStartSec ?? out.startSec;
    if (out.endSec !== undefined && out.endSec <= actualStart) {
      throw new Error(`Subtitle section ${index + 1} must end after it starts`);
    }
    unique.set(custom ? `custom:${id}` : `generated:${Math.round(startSec * 1000)}`, out);
  }
  return [...unique.values()].sort(
    (a, b) => (a.displayStartSec ?? a.startSec) - (b.displayStartSec ?? b.startSec)
  );
}

function sanitizeSegments(raw: ClipSegment[]): ClipSegment[] {
  if (!Array.isArray(raw)) throw new Error("segments must be an array");
  if (raw.length > MAX_SEGMENTS) throw new Error(`A merge can hold at most ${MAX_SEGMENTS} segments`);

  return raw.map((segment, index) => {
    if (typeof segment !== "object" || segment === null) {
      throw new Error(`Segment ${index + 1} is not an object`);
    }
    const startSec = clampNumber(segment.startSec, 0, 24 * 3600);
    const endSec = clampNumber(segment.endSec, 0, 24 * 3600);
    if (endSec <= startSec) {
      throw new Error(`Segment ${index + 1} ends before it starts`);
    }
    const out: ClipSegment = { startSec, endSec };
    if (segment.sourceClipId !== undefined) {
      if (!/^[0-9a-f]{24}$/i.test(String(segment.sourceClipId))) {
        throw new Error(`Segment ${index + 1} has an invalid sourceClipId`);
      }
      out.sourceClipId = String(segment.sourceClipId);
    }
    if (segment.reframeMode !== undefined) {
      if (segment.reframeMode !== "center" && segment.reframeMode !== "smart") {
        throw new Error(`Segment ${index + 1} has an unknown reframe mode`);
      }
      out.reframeMode = segment.reframeMode;
    }
    if (segment.captionStyleId !== undefined) {
      out.captionStyleId = String(segment.captionStyleId).trim().slice(0, 40);
    }
    if (segment.captionsOn !== undefined) out.captionsOn = Boolean(segment.captionsOn);
    return out;
  });
}

/** The effective window is whatever the edit overrides, falling back to mined. */
function effectiveWindow(clip: IClip, edit: ClipEdit): { startSec: number; endSec: number } {
  return {
    startSec: edit.trimStartSec ?? clip.startSec,
    endSec: edit.trimEndSec ?? clip.endSec,
  };
}

function assertWindowValid(clip: IClip, edit: ClipEdit): void {
  const { startSec, endSec } = effectiveWindow(clip, edit);
  if (!(endSec > startSec)) {
    throw new Error(
      `The trim end (${endSec.toFixed(1)}s) must come after the trim start (${startSec.toFixed(1)}s)`
    );
  }
}

export interface CreateMergeInput {
  projectId: string;
  /** Source clip ids, in the order they should play. */
  clipIds: string[];
  title?: string;
}

/**
 * Build a merged clip from other clips' source windows.
 *
 * Non-destructive by design: the sources are untouched, and the merge stores its
 * own `segments` (absolute source times) plus provenance in `mergedFrom`, so it
 * keeps working even if a source is later deleted.
 */
export async function createMergeClip(input: CreateMergeInput): Promise<IClip> {
  const project = await ClipProject.findById(input.projectId);
  if (!project) throw new Error("Project not found");

  const sources = await Clip.find({ _id: { $in: input.clipIds }, projectId: project._id });
  // Preserve the caller's order — the selection order is the play order.
  const ordered: IClip[] = [];
  for (const id of input.clipIds) {
    const match = sources.find((clip) => String(clip._id) === id);
    if (match) ordered.push(match);
  }
  if (ordered.length < 2) throw new Error("Select at least two clips to merge");

  const segments: ClipSegment[] = ordered.map((clip) => ({
    startSec: clip.edit?.trimStartSec ?? clip.startSec,
    endSec: clip.edit?.trimEndSec ?? clip.endSec,
    sourceClipId: String(clip._id),
  }));

  // Display fields come from the strongest source so the merged clip sorts and
  // reads sensibly on the board; its real ordering key is `rank`.
  const strongest = ordered.reduce((best, clip) =>
    clip.totalScore > best.totalScore ? clip : best
  );
  const last = await Clip.findOne({ projectId: project._id }).sort({ rank: -1 }).select("rank").lean();
  const title = input.title?.trim().slice(0, MAX_TITLE_LENGTH) || `Merge of ${ordered.length} clips`;

  const created = await Clip.create({
    projectId: project._id,
    rank: (last?.rank ?? 0) + 1,
    kind: "merge",
    title,
    startSec: Math.min(...segments.map((s) => s.startSec)),
    endSec: Math.max(...segments.map((s) => s.endSec)),
    durationSec: segments.reduce((sum, s) => sum + (s.endSec - s.startSec), 0),
    transcript: ordered.map((c) => c.transcript).join("\n\n"),
    peakSec: strongest.peakSec,
    peakKind: strongest.peakKind,
    peakLine: strongest.peakLine,
    hookText: title,
    scores: strongest.scores,
    totalScore: strongest.totalScore,
    rationale: `Merged from ${ordered.length} clips.`,
    suggestedThemes: [...new Set(ordered.flatMap((c) => c.suggestedThemes ?? []))].slice(0, 6),
    segments,
    mergedFrom: ordered.map((c) => c._id),
    status: "available",
    renderProgress: 0,
  });

  // The source clips have no render for this new clip yet.
  await recomputeProjectStorage(String(project._id));
  return generateClipShareCopy(String(created._id), true);
}

export interface DeleteClipResult {
  deleted: boolean;
  /** Bytes reclaimed from storage. */
  freedBytes: number;
  warning?: string;
}

/**
 * Thrown when a clip cannot be torn down yet. Distinct type so the HTTP layer
 * can answer 409 instead of inventing a message match.
 */
export class ClipBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipBusyError";
  }
}

/**
 * Delete one clip and everything it owns: its S3 object, its local render, its
 * document. Nothing else.
 *
 * Deletion is per-object, never per-prefix — a merged clip shares the project's
 * `clips/` prefix with every other clip, so a prefix delete here would take the
 * whole board with it.
 */
export async function deleteClip(clipId: string): Promise<DeleteClipResult> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");

  // A render in flight persists its outputKey only after uploading, so deleting
  // now would remove the record while the job keeps going and then uploads an
  // object nothing points at. Refuse until the board is settled.
  if (clip.status === "rendering") {
    throw new ClipBusyError("This clip is still rendering. Wait for it to finish, or dismiss it.");
  }

  const projectId = String(clip.projectId);
  let warning: string | undefined;
  let freedBytes = 0;

  // ---- S3 object (exact key only) ----
  // Falls back to the key parsed out of outputUrl: a clip rendered before
  // outputKey existed still points at an S3 object, and skipping it would leak
  // exactly the storage this is meant to reclaim.
  const objectKey = clip.outputKey ?? (clip.outputUrl ? getS3KeyFromUrl(clip.outputUrl) : null);
  if (objectKey) {
    try {
      await deleteKey(objectKey);
      freedBytes += clip.outputBytes ?? 0;
    } catch (error: unknown) {
      warning = `The S3 object could not be deleted: ${getErrorMessage(error)}`;
      console.error(`⚠️  S3 delete failed for clip ${clipId} (${objectKey}): ${getErrorMessage(error)}`);
    }
  }

  // ---- local render: the recorded path, plus any stale file for this clip ----
  const candidates = new Set<string>();
  if (clip.outputPath) candidates.add(clip.outputPath);
  const outDir = projectOutputDir(projectId);
  for (const name of await listFiles(outDir)) {
    if (name.includes(clipId) && name.endsWith(".mp4")) candidates.add(join(outDir, name));
  }
  for (const path of candidates) {
    freedBytes += await getFileSize(path).catch(() => 0);
    await deleteFile(path).catch(() => undefined);
  }

  // ---- the person matte cache, if creator mode built one ----
  if (clip.matte?.path) {
    freedBytes += await getFileSize(clip.matte.path).catch(() => 0);
    await deleteFile(clip.matte.path).catch(() => undefined);
  }

  await Clip.findByIdAndDelete(clipId);
  await recomputeProjectStorage(projectId);

  return { deleted: true, freedBytes, ...(warning ? { warning } : {}) };
}

export interface ClipWords {
  startSec: number;
  endSec: number;
  /** Word onsets inside the clip's window, absolute source time. */
  words: VttWordTiming[];
  segments?: ClipSegment[];
}

/**
 * A clip's window plus the word onsets inside it.
 *
 * This is what lets the editor group and restyle captions in the browser with no
 * round-trip per keystroke; the renderer burns the same grouping on the server.
 */
export async function wordsForClip(
  clipId: string,
  range?: { startSec?: number; endSec?: number }
): Promise<ClipWords> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");

  const project = await ClipProject.findById(clip.projectId).select("wordTimings captions").lean();
  const all: VttWordTiming[] = expandWordTimings(
    project?.wordTimings?.length
      ? project.wordTimings
      : buildWordTimeline(project?.captions ?? []).map((w) => ({ t: w.startSec, word: w.text }))
  );

  const startSec = Number.isFinite(range?.startSec)
    ? Number(range!.startSec)
    : (clip.edit?.trimStartSec ?? clip.startSec);
  const endSec = Number.isFinite(range?.endSec)
    ? Number(range!.endSec)
    : (clip.edit?.trimEndSec ?? clip.endSec);
  const words = all
    .filter((w) => Number.isFinite(w.t) && w.t >= startSec - 0.05 && w.t <= endSec)
    .sort((a, b) => a.t - b.t);

  return { startSec, endSec, words, segments: clip.segments };
}
