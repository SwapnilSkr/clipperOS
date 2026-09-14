import {
  MAX_CAMERA_MOVES,
  MAX_CAMERA_ZOOM,
  MAX_CAPTION_SCENES,
  MAX_FOLLOW_ZOOM,
  MAX_PAUSE_CUTS,
  MAX_TITLES,
  type BehindTitle,
  type CameraAnchor,
  type CameraMove,
  type CaptionOverrides,
  type CaptionScene,
  type CreatorPlan,
  type PauseCut,
} from "../types/clip.types";
import { resolveCaptionFont } from "../config/caption-fonts";

// ============================================
// CREATOR PLAN — sanitising and normalising the beat plan.
//
// The plan arrives from two writers: the editor (autosave) and the Director
// (an LLM). Both are untrusted here. Every span is clamped, ordered, and made
// non-overlapping so the renderer and the preview never have to arbitrate
// between two moves at one instant.
// ============================================

const MAX_SEC = 24 * 3600;

function clampNumber(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return Math.min(max, Math.max(min, n));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function idOf(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 64) : fallback;
}

function colorOf(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^#[0-9a-f]{6}$/i.test(raw.trim())) {
    throw new Error(`${label} must be a #rrggbb colour`);
  }
  return raw.trim().toLowerCase();
}

/**
 * Sort spans, drop empties, and clip each to start no earlier than the previous
 * one's end. Lanes are exclusive by design: one move, one scene, one title per
 * instant (titles excepted — two can coexist, they are only sorted).
 */
function orderSpans<T extends { startSec: number; endSec: number }>(
  items: T[],
  exclusive: boolean
): T[] {
  const sorted = [...items].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const out: T[] = [];
  for (const item of sorted) {
    const previous = out[out.length - 1];
    if (exclusive && previous && item.startSec < previous.endSec) {
      item.startSec = round3(previous.endSec);
    }
    if (item.endSec - item.startSec < 0.05) continue;
    out.push(item);
  }
  return out;
}

export function sanitizeCaptionOverrides(raw: unknown): CaptionOverrides {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid caption overrides");
  const source = raw as Record<string, unknown>;
  const out: CaptionOverrides = {};
  if (source.chunkWords !== undefined) out.chunkWords = clampNumber(source.chunkWords, 1, 12, "chunkWords");
  if (source.sizeScale !== undefined) out.sizeScale = clampNumber(source.sizeScale, 0.3, 3, "sizeScale");
  if (source.verticalFrac !== undefined) out.verticalFrac = clampNumber(source.verticalFrac, 0, 0.8, "verticalFrac");
  if (source.horizontalFrac !== undefined) {
    out.horizontalFrac = clampNumber(source.horizontalFrac, 0, 1, "horizontalFrac");
  }
  if (source.textColor !== undefined) out.textColor = colorOf(source.textColor, "textColor");
  if (source.background !== undefined) {
    if (source.background !== "none" && source.background !== "box") throw new Error("Unknown caption background");
    out.background = source.background;
  }
  if (source.animation !== undefined) {
    if (source.animation !== "none" && source.animation !== "pop" && source.animation !== "fade") {
      throw new Error("Unknown caption animation");
    }
    out.animation = source.animation;
  }
  if (source.peakColor !== undefined) out.peakColor = colorOf(source.peakColor, "peakColor");
  if (source.peakEmphasis !== undefined) out.peakEmphasis = Boolean(source.peakEmphasis);
  if (source.fontFamily !== undefined) {
    if (typeof source.fontFamily !== "string") throw new Error("fontFamily must be a string");
    out.fontFamily = resolveCaptionFont(source.fontFamily);
  }
  if (source.uppercase !== undefined) out.uppercase = Boolean(source.uppercase);
  if (source.highlight !== undefined) {
    if (source.highlight !== "none" && source.highlight !== "word") throw new Error("Unknown caption highlight");
    out.highlight = source.highlight;
  }
  return out;
}

function sanitizeCut(raw: unknown, index: number): PauseCut {
  if (typeof raw !== "object" || raw === null) throw new Error(`Pause cut ${index + 1} is invalid`);
  const source = raw as Record<string, unknown>;
  const startSec = round3(clampNumber(source.startSec, 0, MAX_SEC, "cut startSec"));
  const endSec = round3(clampNumber(source.endSec, 0, MAX_SEC, "cut endSec"));
  return {
    id: idOf(source.id, `cut${index + 1}`),
    startSec,
    endSec,
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    source: source.source === "user" ? "user" : "director",
  };
}

function sanitizeAnchor(raw: unknown): CameraAnchor {
  if (raw === "face" || raw === "center") return raw;
  if (typeof raw === "object" && raw !== null) {
    const point = raw as Record<string, unknown>;
    return {
      x: round3(clampNumber(point.x, 0, 1, "anchor.x")),
      y: round3(clampNumber(point.y, 0, 1, "anchor.y")),
    };
  }
  throw new Error("Unknown camera anchor");
}

function sanitizeMove(raw: unknown, index: number): CameraMove {
  if (typeof raw !== "object" || raw === null) throw new Error(`Camera move ${index + 1} is invalid`);
  const source = raw as Record<string, unknown>;
  const kind = source.kind;
  if (kind !== "punch" && kind !== "push" && kind !== "pull") throw new Error("Unknown camera move");
  const ease = source.ease ?? "out";
  if (ease !== "cut" && ease !== "out" && ease !== "in_out") throw new Error("Unknown camera ease");
  return {
    id: idOf(source.id, `move${index + 1}`),
    kind,
    startSec: round3(clampNumber(source.startSec, 0, MAX_SEC, "move startSec")),
    endSec: round3(clampNumber(source.endSec, 0, MAX_SEC, "move endSec")),
    zoom: round3(clampNumber(source.zoom, 1, MAX_CAMERA_ZOOM, "move zoom")),
    anchor: sanitizeAnchor(source.anchor ?? "face"),
    ease,
  };
}

function sanitizeScene(raw: unknown, index: number): CaptionScene {
  if (typeof raw !== "object" || raw === null) throw new Error(`Caption scene ${index + 1} is invalid`);
  const source = raw as Record<string, unknown>;
  const out: CaptionScene = {
    id: idOf(source.id, `scene${index + 1}`),
    startSec: round3(clampNumber(source.startSec, 0, MAX_SEC, "scene startSec")),
    endSec: round3(clampNumber(source.endSec, 0, MAX_SEC, "scene endSec")),
  };
  if (typeof source.label === "string" && source.label.trim()) out.label = source.label.trim().slice(0, 40);
  if (typeof source.styleId === "string" && source.styleId.trim()) out.styleId = source.styleId.trim().slice(0, 40);
  if (source.overrides !== undefined) {
    const overrides = sanitizeCaptionOverrides(source.overrides);
    if (Object.keys(overrides).length > 0) out.overrides = overrides;
  }
  return out;
}

function sanitizeTitle(raw: unknown, index: number): BehindTitle {
  if (typeof raw !== "object" || raw === null) throw new Error(`Title ${index + 1} is invalid`);
  const source = raw as Record<string, unknown>;
  const text = typeof source.text === "string" ? source.text.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (!text) throw new Error(`Title ${index + 1} has no text`);
  const animation = source.animation ?? "pop";
  if (animation !== "none" && animation !== "pop" && animation !== "fade" && animation !== "rise") {
    throw new Error("Unknown title animation");
  }
  const out: BehindTitle = {
    id: idOf(source.id, `title${index + 1}`),
    text,
    startSec: round3(clampNumber(source.startSec, 0, MAX_SEC, "title startSec")),
    endSec: round3(clampNumber(source.endSec, 0, MAX_SEC, "title endSec")),
    x: round3(clampNumber(source.x ?? 0.5, 0, 1, "title x")),
    y: round3(clampNumber(source.y ?? 0.3, 0, 1, "title y")),
    sizeScale: round3(clampNumber(source.sizeScale ?? 1, 0.3, 4, "title size")),
    color: colorOf(source.color ?? "#ffffff", "title colour"),
    animation,
    depth: source.depth === "front" ? "front" : "behind",
  };
  if (typeof source.fontFamily === "string" && source.fontFamily.trim()) {
    out.fontFamily = resolveCaptionFont(source.fontFamily);
  }
  if (source.uppercase !== undefined) out.uppercase = Boolean(source.uppercase);
  return out;
}

/** Validate and normalise a plan. Throws on a malformed payload. */
export function sanitizeCreatorPlan(raw: unknown): CreatorPlan {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid creator plan");
  const source = raw as Record<string, unknown>;
  const plan: CreatorPlan = { enabled: Boolean(source.enabled), version: 1 };

  if (source.cuts !== undefined) {
    if (!Array.isArray(source.cuts)) throw new Error("cuts must be an array");
    if (source.cuts.length > MAX_PAUSE_CUTS) throw new Error(`At most ${MAX_PAUSE_CUTS} pause cuts`);
    const cuts = orderSpans(source.cuts.map(sanitizeCut), false);
    if (cuts.length > 0) plan.cuts = cuts;
  }

  if (source.camera !== undefined) {
    if (typeof source.camera !== "object" || source.camera === null) throw new Error("Invalid camera plan");
    const camera = source.camera as Record<string, unknown>;
    const movesRaw = camera.moves ?? [];
    if (!Array.isArray(movesRaw)) throw new Error("camera.moves must be an array");
    if (movesRaw.length > MAX_CAMERA_MOVES) throw new Error(`At most ${MAX_CAMERA_MOVES} camera moves`);
    const moves = orderSpans(movesRaw.map(sanitizeMove), true).filter((move) => move.zoom > 1);
    const out: NonNullable<CreatorPlan["camera"]> = { moves };
    if (camera.follow !== undefined && camera.follow !== null) {
      if (typeof camera.follow !== "object") throw new Error("Invalid follow settings");
      const follow = camera.follow as Record<string, unknown>;
      out.follow = {
        enabled: Boolean(follow.enabled),
        tightness: round3(clampNumber(follow.tightness ?? 0.6, 0, 1, "follow tightness")),
      };
      if (follow.zoom !== undefined) {
        const zoom = round3(clampNumber(follow.zoom, 1, MAX_FOLLOW_ZOOM, "follow zoom"));
        if (zoom > 1) out.follow.zoom = zoom;
      }
      // Defaults are left absent so an untouched follow round-trips unchanged.
      if (follow.response !== undefined && follow.response !== "natural") {
        if (follow.response !== "snappy" && follow.response !== "smooth") throw new Error("Invalid follow response");
        out.follow.response = follow.response;
      }
      if (follow.axis !== undefined && follow.axis !== "both") {
        if (follow.axis !== "x" && follow.axis !== "y") throw new Error("Invalid follow axis");
        out.follow.axis = follow.axis;
      }
    }
    if (out.moves.length > 0 || out.follow) plan.camera = out;
  }

  if (source.captionScenes !== undefined) {
    if (!Array.isArray(source.captionScenes)) throw new Error("captionScenes must be an array");
    if (source.captionScenes.length > MAX_CAPTION_SCENES) throw new Error(`At most ${MAX_CAPTION_SCENES} caption scenes`);
    const scenes = orderSpans(source.captionScenes.map(sanitizeScene), true);
    if (scenes.length > 0) plan.captionScenes = scenes;
  }

  if (source.titles !== undefined) {
    if (!Array.isArray(source.titles)) throw new Error("titles must be an array");
    if (source.titles.length > MAX_TITLES) throw new Error(`At most ${MAX_TITLES} titles`);
    const titles = orderSpans(source.titles.map(sanitizeTitle), false);
    if (titles.length > 0) plan.titles = titles;
  }

  if (source.director !== undefined && source.director !== null) {
    if (typeof source.director !== "object") throw new Error("Invalid director notes");
    const director = source.director as Record<string, unknown>;
    const out: NonNullable<CreatorPlan["director"]> = {};
    if (typeof director.notes === "string" && director.notes.trim()) out.notes = director.notes.trim().slice(0, 600);
    if (typeof director.summary === "string" && director.summary.trim()) {
      out.summary = director.summary.trim().slice(0, 1200);
    }
    if (typeof director.generatedAt === "string") out.generatedAt = director.generatedAt.slice(0, 40);
    if (typeof director.model === "string") out.model = director.model.slice(0, 80);
    if (Object.keys(out).length > 0) plan.director = out;
  }

  return plan;
}

/** A plan with nothing in it and creator mode off is the same as no plan. */
export function isEmptyCreatorPlan(plan: CreatorPlan | undefined): boolean {
  if (!plan) return true;
  return (
    !plan.enabled &&
    !plan.cuts?.length &&
    !plan.camera &&
    !plan.captionScenes?.length &&
    !plan.titles?.length &&
    !plan.director
  );
}

/**
 * Read a stored plan back into a plain object. Mongoose sub-documents carry
 * their own machinery; going through the sanitiser is the cheapest way to get
 * a clean, typed copy (the stored value already passed it once).
 */
export function plainCreatorPlan(source: unknown): CreatorPlan | undefined {
  if (!source || typeof source !== "object") return undefined;
  const candidate = source as { toObject?: () => unknown };
  const raw = typeof candidate.toObject === "function" ? candidate.toObject() : source;
  try {
    const plan = sanitizeCreatorPlan(raw);
    return isEmptyCreatorPlan(plan) ? undefined : plan;
  } catch {
    return undefined;
  }
}

/** True when the plan changes what the renderer does. */
export function creatorPlanActive(plan: CreatorPlan | undefined): plan is CreatorPlan {
  return Boolean(plan?.enabled);
}
