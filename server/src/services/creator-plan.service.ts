import {
  MAX_CAMERA_MOVES,
  MAX_CAMERA_ZOOM,
  MAX_CAPTION_SCENES,
  MAX_CUTAWAYS,
  MAX_DIRECTOR_ASKS,
  MAX_DIRECTOR_TURNS,
  MAX_EFFECT_SPANS,
  MAX_FOLLOW_ZOOM,
  MAX_PAUSE_CUTS,
  MAX_SPEED_RATE,
  MAX_SPEED_SPANS,
  MAX_TITLES,
  MAX_TRANSITION_SEC,
  MIN_CAMERA_ZOOM,
  MIN_SPEED_RATE,
  type BehindTitle,
  type CameraAnchor,
  type CameraMove,
  type CaptionOverrides,
  type CaptionScene,
  type CreatorPlan,
  type Cutaway,
  type EffectSpan,
  type PauseCut,
  type SpeedKind,
  type SpeedSpan,
  type TextEnter,
  type TextExit,
  type TextMotion,
} from "../types/clip.types";
import { resolveCaptionFont } from "../config/caption-fonts";
import { EFFECTS_BY_ID, isEffectId } from "../config/effects";
import { isTransitionId } from "../config/transitions";
import { TEXT_ENTERS, TEXT_EXITS, TEXT_MOTIONS } from "./text-motion";
import { cleanDirectorAsks } from "./director-asks";

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

function sanitizeSpeed(raw: unknown, index: number): SpeedSpan {
  if (typeof raw !== "object" || raw === null) throw new Error(`Speed span ${index + 1} is invalid`);
  const source = raw as Record<string, unknown>;
  const kind: SpeedKind = source.kind === "fast" || source.kind === "freeze" ? source.kind : "slow";
  const fallback = kind === "fast" ? 1.5 : kind === "freeze" ? 0 : 0.5;
  const raw_rate = source.rate === undefined ? fallback : clampNumber(source.rate, 0, MAX_SPEED_RATE, "speed rate");
  // The kind decides the side of 1 the rate sits on; a freeze has no rate.
  const rate =
    kind === "freeze"
      ? 0
      : kind === "fast"
        ? round3(Math.max(1.1, Math.min(MAX_SPEED_RATE, raw_rate)))
        : round3(Math.max(MIN_SPEED_RATE, Math.min(0.9, raw_rate)));
  const span: SpeedSpan = {
    id: idOf(source.id, `speed${index + 1}`),
    startSec: round3(clampNumber(source.startSec, 0, MAX_SEC, "speed startSec")),
    endSec: round3(clampNumber(source.endSec, 0, MAX_SEC, "speed endSec")),
    kind,
    rate,
  };
  if (source.smooth === true && kind === "slow") span.smooth = true;
  if (source.captions === true) span.captions = true;
  return span;
}

function sanitizeEffect(raw: unknown, index: number): EffectSpan {
  if (typeof raw !== "object" || raw === null) throw new Error(`Effect ${index + 1} is invalid`);
  const source = raw as Record<string, unknown>;
  if (!isEffectId(source.effectId)) throw new Error(`Unknown effect: ${String(source.effectId)}`);
  const span: EffectSpan = {
    id: idOf(source.id, `fx${index + 1}`),
    effectId: source.effectId,
    startSec: round3(clampNumber(source.startSec, 0, MAX_SEC, "effect startSec")),
    endSec: round3(clampNumber(source.endSec, 0, MAX_SEC, "effect endSec")),
    amount: round3(clampNumber(source.amount ?? 0.7, 0, 1, "effect amount")),
  };
  const variants = EFFECTS_BY_ID.get(source.effectId)?.variants;
  if (variants && typeof source.variant === "string" && variants.some((item) => item.id === source.variant)) {
    span.variant = source.variant;
  }
  return span;
}

const CUTAWAY_MOTIONS = new Set(["none", "in", "out", "left", "right", "up", "down"]);

function sanitizeEdge(raw: unknown, fallback: string): Cutaway["in"] {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const transitionId = isTransitionId(source.transitionId) ? source.transitionId : fallback;
  const sec = round3(clampNumber(source.sec ?? 0.3, 0, MAX_TRANSITION_SEC, "transition sec"));
  return { transitionId, sec: transitionId === "cut" ? 0 : sec };
}

function sanitizeCutaway(raw: unknown, index: number): Cutaway {
  if (typeof raw !== "object" || raw === null) throw new Error(`Cutaway ${index + 1} is invalid`);
  const source = raw as Record<string, unknown>;
  if (typeof source.assetId !== "string" || !source.assetId) throw new Error("A cutaway needs a media asset");
  const cutaway: Cutaway = {
    id: idOf(source.id, `cut${index + 1}`),
    startSec: round3(clampNumber(source.startSec, 0, MAX_SEC, "cutaway startSec")),
    endSec: round3(clampNumber(source.endSec, 0, MAX_SEC, "cutaway endSec")),
    assetId: source.assetId.slice(0, 64),
    fit: source.fit === "blur" ? "blur" : "cover",
    motion: typeof source.motion === "string" && CUTAWAY_MOTIONS.has(source.motion) ? (source.motion as Cutaway["motion"]) : "in",
    in: sanitizeEdge(source.in, "dissolve"),
    out: sanitizeEdge(source.out, "dissolve"),
  };
  if (source.offsetSec !== undefined && source.offsetSec !== null) {
    const offsetSec = round3(clampNumber(source.offsetSec, 0, MAX_SEC, "cutaway offsetSec"));
    if (offsetSec > 0) cutaway.offsetSec = offsetSec;
  }
  return cutaway;
}

function sanitizeAnchor(raw: unknown): CameraAnchor {
  if (raw === "face" || raw === "center" || raw === "look") return raw;
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
  if (kind !== "punch" && kind !== "push" && kind !== "pull" && kind !== "frame" && kind !== "hold") throw new Error("Unknown camera move");
  const ease = source.ease ?? "out";
  if (ease !== "cut" && ease !== "out" && ease !== "in_out") throw new Error("Unknown camera ease");
  const move: CameraMove = {
    id: idOf(source.id, `move${index + 1}`),
    kind,
    startSec: round3(clampNumber(source.startSec, 0, MAX_SEC, "move startSec")),
    endSec: round3(clampNumber(source.endSec, 0, MAX_SEC, "move endSec")),
    zoom: round3(clampNumber(source.zoom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM, "move zoom")),
    anchor: sanitizeAnchor(source.anchor ?? "face"),
    ease,
  };
  // Optional framing; a default is left absent so an untouched move round-trips.
  if (source.zoomFrom !== undefined && source.zoomFrom !== null) {
    const zoomFrom = round3(clampNumber(source.zoomFrom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM, "move zoomFrom"));
    if (Math.abs(zoomFrom - 1) >= 0.005) move.zoomFrom = zoomFrom;
  }
  if (source.pan !== undefined && source.pan !== null) {
    if (typeof source.pan !== "object") throw new Error("Invalid move pan");
    const pan = source.pan as Record<string, unknown>;
    const x = round3(clampNumber(pan.x ?? 0, -1, 1, "pan.x"));
    const y = round3(clampNumber(pan.y ?? 0, -1, 1, "pan.y"));
    if (x !== 0 || y !== 0) move.pan = { x, y };
  }
  if (source.rampSec !== undefined && source.rampSec !== null) {
    move.rampSec = round3(clampNumber(source.rampSec, 0, 10, "move rampSec"));
  }
  return move;
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
  if (typeof animation !== "string" || !(TEXT_ENTERS as string[]).includes(animation)) {
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
    animation: animation as TextEnter,
    depth: source.depth === "front" ? "front" : "behind",
  };
  if (typeof source.fontFamily === "string" && source.fontFamily.trim()) {
    out.fontFamily = resolveCaptionFont(source.fontFamily);
  }
  if (source.uppercase !== undefined) out.uppercase = Boolean(source.uppercase);
  // Motion and look; each left absent at its default so an old title round-trips.
  if (source.exit !== undefined && source.exit !== null) {
    if (typeof source.exit !== "string" || !(TEXT_EXITS as string[]).includes(source.exit)) throw new Error("Unknown title exit");
    out.exit = source.exit as TextExit;
  }
  if (source.enterSec !== undefined && source.enterSec !== null) out.enterSec = round3(clampNumber(source.enterSec, 0.05, 3, "title enterSec"));
  if (source.exitSec !== undefined && source.exitSec !== null) out.exitSec = round3(clampNumber(source.exitSec, 0.05, 3, "title exitSec"));
  if (source.motion !== undefined && source.motion !== null && source.motion !== "none") {
    if (typeof source.motion !== "string" || !(TEXT_MOTIONS as string[]).includes(source.motion)) throw new Error("Unknown title motion");
    out.motion = source.motion as TextMotion;
  }
  if (source.rotation !== undefined && source.rotation !== null) {
    const rotation = round3(clampNumber(source.rotation, -45, 45, "title rotation"));
    if (rotation !== 0) out.rotation = rotation;
  }
  if (source.outline !== undefined && source.outline !== null) {
    const outline = round3(clampNumber(source.outline, 0, 2, "title outline"));
    if (outline !== 1) out.outline = outline;
  }
  if (source.box !== undefined && source.box !== null) {
    if (typeof source.box !== "object") throw new Error("Invalid title box");
    const box = source.box as Record<string, unknown>;
    out.box = { color: colorOf(box.color ?? "#000000", "title box colour"), opacity: round3(clampNumber(box.opacity ?? 0.7, 0, 1, "title box opacity")) };
  }
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
    // A move that neither zooms nor pans does nothing; drop it. A hold is
    // the exception: stopping the camera is the whole point.
    const moves = orderSpans(movesRaw.map(sanitizeMove), true).filter(
      (move) => move.kind === "hold" || move.zoom !== (move.zoomFrom ?? 1) || (move.zoomFrom ?? 1) !== 1 || move.pan !== undefined
    );
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
      if (follow.lead !== undefined && follow.lead !== null) {
        const lead = round3(clampNumber(follow.lead, 0, 1, "follow lead"));
        if (lead > 0) out.follow.lead = lead;
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

  if (source.speed !== undefined) {
    if (!Array.isArray(source.speed)) throw new Error("speed must be an array");
    if (source.speed.length > MAX_SPEED_SPANS) throw new Error(`At most ${MAX_SPEED_SPANS} speed spans`);
    const speed = orderSpans(source.speed.map(sanitizeSpeed), true);
    if (speed.length > 0) plan.speed = speed;
  }

  if (source.effects !== undefined) {
    if (!Array.isArray(source.effects)) throw new Error("effects must be an array");
    if (source.effects.length > MAX_EFFECT_SPANS) throw new Error(`At most ${MAX_EFFECT_SPANS} effects`);
    // Effects may overlap (they stack); only the order is fixed.
    const effects = orderSpans(source.effects.map(sanitizeEffect), false);
    if (effects.length > 0) plan.effects = effects;
  }

  if (source.cutaways !== undefined) {
    if (!Array.isArray(source.cutaways)) throw new Error("cutaways must be an array");
    if (source.cutaways.length > MAX_CUTAWAYS) throw new Error(`At most ${MAX_CUTAWAYS} cutaways`);
    // One picture at a time: cutaways never overlap.
    const cutaways = orderSpans(source.cutaways.map(sanitizeCutaway), true);
    if (cutaways.length > 0) plan.cutaways = cutaways;
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
    if (Array.isArray(director.turns)) {
      // Field by field: a mongoose subdocument spread copies its internals.
      const turns = director.turns
        .filter((turn): turn is Record<string, unknown> => typeof turn === "object" && turn !== null)
        .filter((turn) => typeof turn.summary === "string" && turn.summary.trim())
        .map((turn) => ({
          ...(typeof turn.notes === "string" && turn.notes.trim() ? { notes: turn.notes.trim().slice(0, 600) } : {}),
          summary: String(turn.summary).trim().slice(0, 1200),
          at: typeof turn.at === "string" ? turn.at.slice(0, 40) : "",
          ...(turn.kind === "plan" || turn.kind === "reply" || turn.kind === "undo" ? { kind: turn.kind as "plan" | "reply" | "undo" } : {}),
          ...(!turn.kind || turn.kind === "pass"
            ? {
                ...(Array.isArray(turn.changed)
                  ? { changed: (turn.changed as unknown[]).filter((lane): lane is string => typeof lane === "string" && lane.length > 0).map((lane) => lane.slice(0, 24)).slice(0, 9) }
                  : {}),
                ...(turn.undone === true ? { undone: true } : {}),
              }
            : {}),
          ...(turn.kind === "plan" && Array.isArray(turn.questions)
            ? { questions: (turn.questions as unknown[]).filter((q): q is string => typeof q === "string" && q.trim().length > 0).map((q) => q.trim().slice(0, 300)).slice(0, MAX_DIRECTOR_ASKS) }
            : {}),
          // A copy first: a stored turn's asks are mongoose subdocuments.
          ...(turn.kind === "plan" && Array.isArray(turn.asks) && turn.asks.length ? { asks: cleanDirectorAsks(JSON.parse(JSON.stringify(turn.asks))) } : {}),
        }))
        .slice(-MAX_DIRECTOR_TURNS);
      if (turns.length > 0) out.turns = turns;
    }
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
    !plan.speed?.length &&
    !plan.effects?.length &&
    !plan.cutaways?.length &&
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
