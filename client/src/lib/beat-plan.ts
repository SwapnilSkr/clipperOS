import {
  MAX_CAMERA_MOVES,
  MAX_CAMERA_ZOOM,
  MAX_CAPTION_SCENES,
  MAX_CUTAWAYS,
  MAX_EFFECT_SPANS,
  MAX_PAUSE_CUTS,
  MAX_SPEED_SPANS,
  MAX_TITLES,
  type BehindTitle,
  type CameraMove,
  type CaptionScene,
  type CreatorPlan,
  type Cutaway,
  type EffectSpan,
  type PauseCut,
  type SoundtrackHit,
  type SpeedSpan,
  type VideoEffects,
} from "@/api";
import { sourceToOutput, type TimeWindow } from "./creator-timeline";

// ============================================================
// BEAT PLAN EDITS — pure helpers shared by the timeline (add at a lane's "+",
// Delete on a focused block) and the desk (inspector). Nothing here touches
// React state; callers spread the result into their draft.
// ============================================================

export type BeatLane = "cuts" | "camera" | "speed" | "fx" | "cutaways" | "captions" | "titles" | "sfx";

export const MAX_SOUNDTRACK_HITS = 16;

/** The default sound a new SFX pin carries until the inspector changes it. */
export const DEFAULT_SFX = "whoosh";
export const DEFAULT_EFFECT = "bw";

export interface BeatContext {
  /** Playhead, source seconds. */
  at: number;
  trimStart: number;
  trimEnd: number;
  windows: TimeWindow[];
  /** The sound for a new SFX hit; the built-in whoosh when absent. */
  sfx?: string;
  /** The effect for a new FX span; black & white when absent. */
  effectId?: string;
  /** The media asset for a new cutaway (required for that lane). */
  assetId?: string;
  /** Words for a new Text beat (the transcript at the playhead); a placeholder when absent. */
  text?: string;
}

export interface BeatState {
  plan: CreatorPlan;
  sfx: SoundtrackHit[];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function laneFull(lane: BeatLane, plan: CreatorPlan, sfx: SoundtrackHit[]): boolean {
  switch (lane) {
    case "cuts":
      return (plan.cuts?.length ?? 0) >= MAX_PAUSE_CUTS;
    case "camera":
      return (plan.camera?.moves.length ?? 0) >= MAX_CAMERA_MOVES;
    case "speed":
      return (plan.speed?.length ?? 0) >= MAX_SPEED_SPANS;
    case "fx":
      return (plan.effects?.length ?? 0) >= MAX_EFFECT_SPANS;
    case "cutaways":
      return (plan.cutaways?.length ?? 0) >= MAX_CUTAWAYS;
    case "captions":
      return (plan.captionScenes?.length ?? 0) >= MAX_CAPTION_SCENES;
    case "titles":
      return (plan.titles?.length ?? 0) >= MAX_TITLES;
    case "sfx":
      return sfx.length >= MAX_SOUNDTRACK_HITS;
  }
}

/** A new default beat at the playhead; null when the lane is full. */
export function addBeat(lane: BeatLane, state: BeatState, ctx: BeatContext): (BeatState & { id: string }) | null {
  if (laneFull(lane, state.plan, state.sfx)) return null;
  const { plan, sfx } = state;
  const at = round3(Math.max(ctx.trimStart, Math.min(ctx.trimEnd, ctx.at)));
  const until = (length: number) => round3(Math.min(ctx.trimEnd, at + length));

  switch (lane) {
    case "cuts": {
      const cut: PauseCut = {
        id: newId("cut"),
        startSec: at,
        endSec: until(0.4),
        enabled: true,
        source: "user",
      };
      return {
        plan: { ...plan, cuts: [...(plan.cuts ?? []), cut] },
        sfx,
        id: cut.id,
      };
    }
    case "camera": {
      const move: CameraMove = {
        id: newId("move"),
        kind: "punch",
        startSec: at,
        endSec: until(1.2),
        zoom: 1.18,
        anchor: "face",
        ease: "cut",
      };
      return {
        plan: {
          ...plan,
          camera: {
            ...plan.camera,
            moves: [...(plan.camera?.moves ?? []), move],
          },
        },
        sfx,
        id: move.id,
      };
    }
    case "speed": {
      // Half speed for a second: the classic slow-motion beat.
      const span: SpeedSpan = { id: newId("speed"), startSec: at, endSec: until(1), kind: "slow", rate: 0.5 };
      return { plan: { ...plan, speed: [...(plan.speed ?? []), span] }, sfx, id: span.id };
    }
    case "fx": {
      const span: EffectSpan = {
        id: newId("fx"),
        effectId: ctx.effectId ?? DEFAULT_EFFECT,
        startSec: at,
        endSec: until(2),
        amount: 0.7,
      };
      return { plan: { ...plan, effects: [...(plan.effects ?? []), span] }, sfx, id: span.id };
    }
    case "cutaways": {
      if (!ctx.assetId) return null;
      // Two seconds of B-roll with a soft dissolve either side, drifting in.
      const cutaway: Cutaway = {
        id: newId("cut"),
        startSec: at,
        endSec: until(2),
        assetId: ctx.assetId,
        fit: "cover",
        motion: "in",
        in: { transitionId: "dissolve", sec: 0.3 },
        out: { transitionId: "dissolve", sec: 0.3 },
      };
      return { plan: { ...plan, cutaways: [...(plan.cutaways ?? []), cutaway] }, sfx, id: cutaway.id };
    }
    case "captions": {
      const scenes = plan.captionScenes ?? [];
      const scene: CaptionScene = {
        id: newId("scene"),
        startSec: at,
        endSec: until(3),
        label: scenes.length === 0 && at <= ctx.trimStart + 0.05 ? "hook" : `scene ${scenes.length + 1}`,
        styleId: "creator_hook",
      };
      return {
        plan: { ...plan, captionScenes: [...scenes, scene] },
        sfx,
        id: scene.id,
      };
    }
    case "titles": {
      const title: BehindTitle = {
        id: newId("title"),
        text: (ctx.text?.trim() || "YOUR TEXT").slice(0, 120),
        startSec: at,
        endSec: until(2.2),
        x: 0.5,
        y: 0.3,
        sizeScale: 1,
        color: "#ffffff",
        uppercase: true,
        animation: "pop",
        exit: "fade",
        // In front: it shows at once, no person matte needed; "Behind speaker" is one click.
        depth: "front",
      };
      return {
        plan: { ...plan, titles: [...(plan.titles ?? []), title] },
        sfx,
        id: title.id,
      };
    }
    case "sfx": {
      const hit: SoundtrackHit = {
        id: newId("hit"),
        assetId: ctx.sfx ?? DEFAULT_SFX,
        atSec: round3(sourceToOutput(ctx.windows, at)),
        gain: 0.9,
      };
      return { plan, sfx: [...sfx, hit], id: hit.id };
    }
  }
}

export function removeBeat(lane: BeatLane, id: string, state: BeatState): BeatState {
  const { plan, sfx } = state;
  switch (lane) {
    case "cuts":
      return {
        plan: {
          ...plan,
          cuts: (plan.cuts ?? []).filter((cut) => cut.id !== id),
        },
        sfx,
      };
    case "camera":
      return {
        plan: {
          ...plan,
          camera: {
            ...plan.camera,
            moves: (plan.camera?.moves ?? []).filter((move) => move.id !== id),
          },
        },
        sfx,
      };
    case "speed":
      return { plan: { ...plan, speed: (plan.speed ?? []).filter((span) => span.id !== id) }, sfx };
    case "fx":
      return { plan: { ...plan, effects: (plan.effects ?? []).filter((span) => span.id !== id) }, sfx };
    case "cutaways":
      return { plan: { ...plan, cutaways: (plan.cutaways ?? []).filter((item) => item.id !== id) }, sfx };
    case "captions":
      return {
        plan: {
          ...plan,
          captionScenes: (plan.captionScenes ?? []).filter((scene) => scene.id !== id),
        },
        sfx,
      };
    case "titles":
      return {
        plan: {
          ...plan,
          titles: (plan.titles ?? []).filter((title) => title.id !== id),
        },
        sfx,
      };
    case "sfx":
      return { plan, sfx: sfx.filter((hit) => hit.id !== id) };
  }
}

/**
 * Switch the plan on. The first time, the Edit desk's clip-wide motion becomes
 * a camera move so nothing the user set is lost.
 */
export function enablePlan(
  plan: CreatorPlan,
  effects: VideoEffects,
  trimStart: number,
  trimEnd: number,
  peakSec: number
): CreatorPlan {
  if (plan.enabled) return plan;
  if (!plan.camera && effects.motion && effects.motion !== "none") {
    const move = legacyMotionAsMove(effects, trimStart, trimEnd, peakSec);
    return { ...plan, enabled: true, camera: { moves: move ? [move] : [] } };
  }
  return { ...plan, enabled: true };
}

/** The clip-wide motion as a move, so switching creator mode on loses nothing. */
function legacyMotionAsMove(
  effects: VideoEffects,
  trimStart: number,
  trimEnd: number,
  peakSec: number
): CameraMove | null {
  const zoom = Math.min(MAX_CAMERA_ZOOM, Math.max(1, effects.zoom ?? 1.06));
  if (zoom <= 1.001) return null;
  if (effects.motion === "hook_push") {
    return {
      id: newId("move"),
      kind: "pull",
      startSec: round3(trimStart),
      endSec: round3(Math.min(trimEnd, trimStart + 0.45)),
      zoom,
      anchor: "face",
      ease: "out",
    };
  }
  if (effects.motion === "peak_punch" && peakSec > trimStart && peakSec < trimEnd) {
    return {
      id: newId("move"),
      kind: "punch",
      startSec: round3(Math.max(trimStart, peakSec - 0.38)),
      endSec: round3(Math.min(trimEnd, peakSec + 0.38)),
      zoom,
      anchor: "face",
      ease: "out",
    };
  }
  return null;
}
