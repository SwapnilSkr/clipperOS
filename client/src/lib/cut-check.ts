import type { CropKeyframe, ReframeTrack } from "@/api";
import { cropAtTime, holdCropUntilCuts } from "@/lib/reframe";

/** Matches the encoder's 1ms-early snap so rounding cannot miss the first new frame. */
const SNAP_EARLY_SEC = 0.001;
const GEOMETRY_FRACTION = 0.2;

export type SceneCutKind = "snap" | "hold";
export type SceneCutStatus = "ok" | "flash";

export interface SceneCutCheck {
  /** Absolute source time of the camera cut. */
  sourceSec: number;
  kind: SceneCutKind;
  status: SceneCutStatus;
  reason?: string;
  /** True when this cut was not in the previous check (new trim / new analysis). */
  added?: boolean;
}

/**
 * Scene cuts that fall inside the live trim. Times are on the source clock.
 */
export function sceneCutsInWindow(
  track: ReframeTrack | undefined,
  trimStart: number,
  trimEnd: number
): number[] {
  if (!track?.cuts?.length) return [];
  const origin = track.originSec ?? trimStart;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const rel of track.cuts) {
    const sourceSec = origin + rel;
    if (sourceSec <= trimStart + 0.08 || sourceSec >= trimEnd - 0.08) continue;
    const key = Math.round(sourceSec * 100);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sourceSec);
  }
  return out.sort((a, b) => a - b);
}

function neighbors(
  track: ReframeTrack,
  rel: number
): { hold: CropKeyframe; incoming: CropKeyframe | undefined } {
  const keyframes = holdCropUntilCuts(track).keyframes;
  const hold =
    [...keyframes].reverse().find((keyframe) => keyframe.t < rel - 1e-4) ?? keyframes[0]!;
  const incoming = keyframes.find((keyframe) => keyframe.t >= rel - 0.001);
  return { hold, incoming };
}

/**
 * Instant snap audit: does the preview crop and the encode clock both switch
 * on the first frame of the new shot? No decode required, so it can run on
 * every trim change and every newly analysed tail.
 */
export function checkSceneCuts(
  track: ReframeTrack | undefined,
  trimStart: number,
  trimEnd: number,
  sourceWidth: number,
  sourceHeight: number
): SceneCutCheck[] {
  if (!track) return [];
  const origin = track.originSec ?? trimStart;
  const cleaned = holdCropUntilCuts(track);
  return sceneCutsInWindow(cleaned, trimStart, trimEnd).map((sourceSec) => {
    const rel = sourceSec - origin;
    const { hold, incoming } = neighbors(cleaned, rel);
    const geometryJump =
      incoming != null && Math.abs(incoming.cx - hold.cx) > GEOMETRY_FRACTION * hold.width;
    if (!geometryJump) {
      return { sourceSec, kind: "hold", status: "ok" };
    }

    const preview = cropAtTime(cleaned, rel, sourceWidth, sourceHeight);
    const previewOk = Math.abs(preview.cx - incoming.cx) <= 12;

    const shiftedSnap = incoming.t + origin - trimStart;
    const encodeT = sourceSec - trimStart;
    const encodeOk = encodeT + 1e-6 >= shiftedSnap - SNAP_EARLY_SEC;

    if (previewOk && encodeOk) {
      return { sourceSec, kind: "snap", status: "ok" };
    }
    return {
      sourceSec,
      kind: "snap",
      status: "flash",
      reason: !previewOk
        ? "The 9:16 window still holds the old crop on the first frame of the new shot"
        : "The render clock would apply the old crop to the new shot",
    };
  });
}

export function markAddedCuts(current: SceneCutCheck[], previousSourceSecs: number[]): SceneCutCheck[] {
  if (previousSourceSecs.length === 0) return current;
  const known = new Set(previousSourceSecs.map((t) => Math.round(t * 100)));
  return current.map((item) =>
    known.has(Math.round(item.sourceSec * 100)) ? item : { ...item, added: true }
  );
}
