import { useEffect, useRef, useState, type RefObject } from "react";
import type { EffectGroup, EffectInfo, EffectSpan, ReframeTrack } from "@/api";
import { cropBoxAt } from "@/lib/creator-timeline";
import { cssFilterFor, paintFxLayers } from "@/lib/fx-preview";
import { cropAtTime } from "@/lib/reframe";
import { cn } from "@/lib/utils";

// ============================================================
// EFFECT PICKER — the effects pack as live samples.
//
// One group at a time, each effect a small tile showing the clip's own
// current crop with the look applied — the same CSS filter and canvas layers
// the player's preview uses (lib/fx-preview.ts), animated on a timer so
// flicker, strobe and glitch read as what they are. rAF would freeze in a
// hidden pane; a timer does not. The summary of the chosen effect sits
// underneath so a name never has to be guessed at.
// ============================================================

const LAST_EFFECT_KEY = "clipperos.lastEffect";

export function lastEffect(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_EFFECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberEffect(effectId: string): void {
  try {
    window.localStorage.setItem(LAST_EFFECT_KEY, effectId);
  } catch {
    // Private mode: the default stays black & white.
  }
}

const GROUPS: { id: EffectGroup; label: string }[] = [
  { id: "colour", label: "Colour" },
  { id: "texture", label: "Texture" },
  { id: "motion", label: "Motion" },
  { id: "glitch", label: "Glitch" },
  { id: "frame", label: "Frame" },
];

/** Tile canvas size in pixels (drawn at 2× its CSS size); 3:4 keeps a face in frame. */
const TILE_W = 144;
const TILE_H = 192;
/** Seconds a sample loops over: a fade runs its whole course once per loop. */
const SAMPLE_LOOP_SEC = 1.6;
const TICK_MS = 90;

/** Where the tiles take their picture from: the player's source and its crop. */
export interface EffectSampleSource {
  video: RefObject<HTMLVideoElement | null>;
  track: ReframeTrack | undefined;
  cropOrigin: number;
  tightness: number;
  lead: number;
}

export function EffectPicker({
  effects,
  value,
  onPick,
  sample,
  amount = 0.8,
}: {
  effects: EffectInfo[];
  value: string;
  onPick: (effectId: string) => void;
  sample?: EffectSampleSource;
  /** The span's amount: each tile shows what picking it would give. */
  amount?: number;
}) {
  const current = effects.find((effect) => effect.id === value);
  const [group, setGroup] = useState<EffectGroup>(current?.group ?? "colour");
  // Follow the chosen effect when it changes from outside (another span selected).
  const currentGroup = current?.group;
  useEffect(() => {
    if (currentGroup) setGroup(currentGroup);
  }, [currentGroup]);

  const frameRef = useRef<HTMLCanvasElement | null>(null);
  const [tick, setTick] = useState(0);
  // Read through a ref: the desk hands a fresh object each render, and the
  // timer must not restart on every one.
  const sampleRef = useRef(sample);
  sampleRef.current = sample;

  // The shared picture: the current crop, re-captured a few times a second so
  // the tiles follow the playhead, and the clock the animated looks run on.
  useEffect(() => {
    if (!frameRef.current) {
      frameRef.current = document.createElement("canvas");
      frameRef.current.width = TILE_W;
      frameRef.current.height = TILE_H;
    }
    let sinceCapture = Infinity;
    const timer = window.setInterval(() => {
      sinceCapture += TICK_MS;
      if (sinceCapture >= 400) {
        sinceCapture = 0;
        captureSample(frameRef.current!, sampleRef.current);
      }
      setTick((n) => n + 1);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const members = effects.filter((effect) => effect.group === group);
  const t = ((tick * TICK_MS) / 1000) % SAMPLE_LOOP_SEC;

  return (
    <div>
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Effect groups">
        {GROUPS.filter((item) => effects.some((effect) => effect.group === item.id)).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === group}
            onClick={() => setGroup(item.id)}
            className={cn(
              "press text-micro rounded-full border px-2 py-0.5 font-semibold",
              item.id === group
                ? "border-accent bg-accent/15 text-accent"
                : "border-border text-muted hover:border-control hover:text-fg",
              current?.group === item.id && item.id !== group && "text-fg"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {members.map((effect) => (
          <button
            key={effect.id}
            type="button"
            aria-pressed={effect.id === value}
            title={effect.summary}
            onClick={() => onPick(effect.id)}
            className={cn(
              "press group overflow-hidden rounded-md border text-left",
              effect.id === value ? "border-accent ring-1 ring-accent" : "border-border hover:border-control"
            )}
          >
            <EffectTile effect={effect} frame={frameRef} amount={amount} t={t} tick={tick} />
            <span
              className={cn(
                "text-micro block truncate px-1 py-0.5 font-semibold",
                effect.id === value ? "bg-accent/15 text-accent" : "text-muted group-hover:text-fg"
              )}
            >
              {effect.label}
            </span>
          </button>
        ))}
      </div>
      {current ? <p className="text-meta mt-2 text-muted">{current.summary}</p> : null}
      {effects.length === 0 ? <p className="text-meta text-muted">Loading the effects pack…</p> : null}
    </div>
  );
}

function EffectTile({
  effect,
  frame,
  amount,
  t,
  tick,
}: {
  effect: EffectInfo;
  frame: RefObject<HTMLCanvasElement | null>;
  amount: number;
  t: number;
  tick: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const source = frame.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !source || !ctx) return;
    ctx.clearRect(0, 0, TILE_W, TILE_H);
    ctx.drawImage(source, 0, 0);
    const span: EffectSpan = { id: effect.id, effectId: effect.id, startSec: 0, endSec: SAMPLE_LOOP_SEC, amount };
    const active = [{ span, info: effect, amount }];
    // The CSS half goes on the element, as the player applies it to its canvas.
    canvas.style.filter = cssFilterFor(active);
    paintFxLayers(canvas, active, t, () => ({ a: 0, b: SAMPLE_LOOP_SEC }));
  }, [effect, frame, amount, t, tick]);
  return <canvas ref={canvasRef} width={TILE_W} height={TILE_H} className="block aspect-[3/4] w-full bg-panel-2" aria-hidden="true" />;
}

/**
 * Paint the player's current 9:16 crop, trimmed to 3:4 around the upper
 * middle (where a speaker's face sits), into the shared sample canvas. With
 * no decodable frame yet, a soft gradient stands in so colour looks still read.
 */
function captureSample(target: HTMLCanvasElement, sample: EffectSampleSource | undefined): void {
  const ctx = target.getContext("2d");
  if (!ctx) return;
  const video = sample?.video.current;
  if (!sample || !video || video.readyState < 2 || !video.videoWidth) {
    const gradient = ctx.createLinearGradient(0, 0, TILE_W, TILE_H);
    gradient.addColorStop(0, "#e2a15a");
    gradient.addColorStop(0.5, "#3f7fa6");
    gradient.addColorStop(1, "#1d2533");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, TILE_W, TILE_H);
    ctx.fillStyle = "rgba(255,236,210,0.85)";
    ctx.beginPath();
    ctx.arc(TILE_W / 2, TILE_H * 0.42, TILE_W * 0.18, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const sourceWidth = sample.track?.sourceWidth ?? video.videoWidth;
  const sourceHeight = sample.track?.sourceHeight ?? video.videoHeight;
  const geometry = sample.track ?? { sourceWidth, sourceHeight };
  const keyframe = cropAtTime(sample.track, video.currentTime - sample.cropOrigin, sourceWidth, sourceHeight, sample.tightness, {
    lead: sample.lead,
  });
  const box = cropBoxAt({ ...keyframe, t: 0 }, geometry);
  // The source may be a proxy smaller than the track's geometry: scale the box.
  const sx = video.videoWidth / sourceWidth;
  const sy = video.videoHeight / sourceHeight;
  const sub = { w: box.w, h: (box.w * TILE_H) / TILE_W };
  const top = Math.max(0, Math.min(box.h - sub.h, box.h * 0.4 - sub.h / 2));
  try {
    ctx.drawImage(video, box.x * sx, (box.y + top) * sy, sub.w * sx, sub.h * sy, 0, 0, TILE_W, TILE_H);
  } catch {
    // A frame that is not decodable yet keeps the previous picture.
  }
}
