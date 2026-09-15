import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Plus } from "lucide-react";
import type { AudioAsset, CameraMove, CreatorPlan, SoundtrackHit } from "@/api";
import { laneFull, type BeatLane } from "@/lib/beat-plan";
import { outputToSource, sourceToOutput, type TimeWindow } from "@/lib/creator-timeline";
import { cn, timecode } from "@/lib/utils";
import { lastSfx, SfxPicker } from "./SfxPicker";

// ============================================================
// BEAT TIMELINE
//
// The creator desk's view of a clip: one lane per kind of beat, laid out on
// the SOURCE clock across the trim window. Cuts are drawn where they remove
// time, so a block's position never has to be re-derived when a cut toggles.
// SFX hits live on the OUTPUT clock (that is what the mix desk and the burn
// use), so they are converted for drawing and converted back on a drag.
//
// Deliberately not an NLE: select, drag to move, drag an edge to resize, "+"
// on a lane adds at the playhead, Delete removes. Everything else is an
// inspector field.
// ============================================================

export type { BeatLane };

export interface BeatSelection {
  lane: BeatLane;
  id: string;
}

interface Block {
  lane: BeatLane;
  id: string;
  startSec: number;
  endSec: number;
  label: string;
  /** A hit has no duration; drawn as a pin. */
  point?: boolean;
  muted?: boolean;
}

/**
 * A camera block's label: the zoom it reaches, "1.3→1×" when it starts
 * elsewhere (a zoom out reads as one), and "pan" for a framing that moves.
 */
function moveLabel(move: CameraMove): string {
  const zoom =
    move.zoomFrom !== undefined
      ? `${Number(move.zoomFrom.toFixed(2))}→${Number(move.zoom.toFixed(2))}×`
      : move.zoom !== 1
        ? `${Math.round((move.zoom - 1) * 100)}%`
        : "";
  return [move.kind, zoom, move.pan ? "pan" : ""].filter(Boolean).join(" ");
}

const LANES: { id: BeatLane; label: string; add: string }[] = [
  { id: "cuts", label: "Cuts", add: "Cut 0.4s here" },
  { id: "camera", label: "Camera", add: "Punch in here" },
  { id: "speed", label: "Speed", add: "Slow motion here" },
  { id: "fx", label: "FX", add: "Effect here" },
  { id: "cutaways", label: "B-roll", add: "Cutaway here" },
  { id: "captions", label: "Captions", add: "Caption scene here" },
  { id: "titles", label: "Titles", add: "Title here" },
  { id: "sfx", label: "SFX", add: "Sound here" },
];

const LANE_HEIGHT = 28;
const RULER_HEIGHT = 18;
const LABEL_WIDTH = 92;
const EDGE_PX = 7;
const MIN_SPAN_SEC = 0.1;

interface DragState {
  block: Block;
  mode: "move" | "start" | "end";
  originX: number;
  startSec: number;
  endSec: number;
}

export interface BeatTimelineProps {
  trimStart: number;
  trimEnd: number;
  plan: CreatorPlan;
  windows: TimeWindow[];
  sfx: SoundtrackHit[];
  sfxLabels: Map<string, string>;
  /** The one-shots on offer: the SFX lane's "+" picks one before placing it. */
  sfxAssets: AudioAsset[];
  /** Effect id → label, for the FX lane's blocks. */
  effectLabels: Map<string, string>;
  /** Media asset id → label, for the B-roll lane's blocks. */
  mediaLabels: Map<string, string>;
  /** Shot changes on the source clock, for the ruler. */
  sceneCuts: number[];
  peakSec: number;
  /** Source seconds. */
  playhead: number;
  selected: BeatSelection | null;
  onSelect: (selection: BeatSelection | null) => void;
  onSeek: (sourceSec: number) => void;
  /** A span moved or resized. `sfx` reports output seconds in `startSec`. */
  onSpanChange: (lane: BeatLane, id: string, span: { startSec: number; endSec: number }) => void;
  /** The lane's "+": a default beat at the playhead. */
  onAdd: (lane: BeatLane) => void;
  /** The SFX lane's "+", once a sound is chosen: that sound at the playhead. */
  onAddSfx: (assetId: string) => void;
  /** Delete / Backspace on a focused block. */
  onRemove: (lane: BeatLane, id: string) => void;
  /** An image or video dropped on the B-roll lane: upload it and place a cutaway at that time. */
  onDropMedia?: (file: File, sourceSec: number) => Promise<void>;
  /** Dimmed when the plan is off: the blocks are kept but do not render. */
  dimmed?: boolean;
}

/** Smallest tick spacing that keeps labels at least ~64px apart. */
function tickStep(spanSec: number, widthPx: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60];
  const perSec = Math.max(1, widthPx) / spanSec;
  return steps.find((step) => step * perSec >= 64) ?? 60;
}

export function BeatTimeline({
  trimStart,
  trimEnd,
  plan,
  windows,
  sfx,
  sfxLabels,
  sfxAssets,
  effectLabels,
  mediaLabels,
  sceneCuts,
  peakSec,
  playhead,
  selected,
  onSelect,
  onSeek,
  onSpanChange,
  onAdd,
  onAddSfx,
  onRemove,
  onDropMedia,
  dimmed,
}: BeatTimelineProps) {
  // A file dragged over the B-roll lane: where it would land, and an upload in flight.
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [uploadingAt, setUploadingAt] = useState<number | null>(null);
  const spanSec = Math.max(0.1, trimEnd - trimStart);
  // The SFX "+" opens a picker instead of placing a default: which sound is
  // the whole decision, so it comes first.
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!picking) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setPicking(false);
        return;
      }
      if (!pickerRef.current?.contains(event.target as Node)) setPicking(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [picking]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pct = (sourceSec: number) => `${((sourceSec - trimStart) / spanSec) * 100}%`;
  const widthPct = (lengthSec: number) => `${(lengthSec / spanSec) * 100}%`;

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    for (const cut of plan.cuts ?? []) {
      out.push({
        lane: "cuts",
        id: cut.id,
        startSec: cut.startSec,
        endSec: cut.endSec,
        label: `−${(cut.endSec - cut.startSec).toFixed(1)}s`,
        muted: !cut.enabled,
      });
    }
    for (const move of plan.camera?.moves ?? []) {
      out.push({
        lane: "camera",
        id: move.id,
        startSec: move.startSec,
        endSec: move.endSec,
        label: moveLabel(move),
      });
    }
    for (const span of plan.speed ?? []) {
      out.push({
        lane: "speed",
        id: span.id,
        startSec: span.startSec,
        endSec: span.endSec,
        label: span.kind === "freeze" ? "Freeze" : `${span.rate}×`,
      });
    }
    for (const span of plan.effects ?? []) {
      out.push({
        lane: "fx",
        id: span.id,
        startSec: span.startSec,
        endSec: span.endSec,
        label: effectLabels.get(span.effectId) ?? span.effectId,
      });
    }
    for (const cutaway of plan.cutaways ?? []) {
      out.push({
        lane: "cutaways",
        id: cutaway.id,
        startSec: cutaway.startSec,
        endSec: cutaway.endSec,
        label: mediaLabels.get(cutaway.assetId) ?? "cutaway",
      });
    }
    for (const scene of plan.captionScenes ?? []) {
      out.push({
        lane: "captions",
        id: scene.id,
        startSec: scene.startSec,
        endSec: scene.endSec,
        label: scene.label ?? scene.styleId ?? "scene",
      });
    }
    for (const title of plan.titles ?? []) {
      out.push({
        lane: "titles",
        id: title.id,
        startSec: title.startSec,
        endSec: title.endSec,
        label: title.text,
      });
    }
    for (const hit of sfx) {
      const at = outputToSource(windows, hit.atSec);
      out.push({
        lane: "sfx",
        id: hit.id,
        startSec: at,
        endSec: at,
        label: sfxLabels.get(hit.assetId) ?? hit.assetId,
        point: true,
      });
    }
    return out;
  }, [plan, sfx, sfxLabels, effectLabels, mediaLabels, windows]);

  function secondsAt(clientX: number): number {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return trimStart;
    const u = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return trimStart + u * spanSec;
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>, block: Block) {
    event.stopPropagation();
    onSelect({ lane: block.lane, id: block.id });
    const rect = event.currentTarget.getBoundingClientRect();
    let mode: DragState["mode"] = "move";
    if (!block.point) {
      if (event.clientX - rect.left <= EDGE_PX) mode = "start";
      else if (rect.right - event.clientX <= EDGE_PX) mode = "end";
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      block,
      mode,
      originX: event.clientX,
      startSec: block.startSec,
      endSec: block.endSec,
    });
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const delta = ((event.clientX - drag.originX) / rect.width) * spanSec;
    let startSec = drag.startSec;
    let endSec = drag.endSec;
    const length = drag.endSec - drag.startSec;
    if (drag.mode === "move") {
      startSec = Math.max(trimStart, Math.min(trimEnd - length, drag.startSec + delta));
      endSec = startSec + length;
    } else if (drag.mode === "start") {
      startSec = Math.max(trimStart, Math.min(drag.endSec - MIN_SPAN_SEC, drag.startSec + delta));
    } else {
      endSec = Math.min(trimEnd, Math.max(drag.startSec + MIN_SPAN_SEC, drag.endSec + delta));
    }
    startSec = Math.round(startSec * 1000) / 1000;
    endSec = Math.round(endSec * 1000) / 1000;
    if (drag.block.lane === "sfx") {
      onSpanChange("sfx", drag.block.id, {
        startSec: Math.round(sourceToOutput(windows, startSec) * 1000) / 1000,
        endSec: startSec,
      });
    } else {
      onSpanChange(drag.block.lane, drag.block.id, { startSec, endSec });
    }
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  }

  const step = tickStep(spanSec, width);
  const ticks: number[] = [];
  for (let t = Math.ceil(trimStart / step) * step; t <= trimEnd; t += step) ticks.push(t);

  return (
    <div
      className={cn("relative w-full select-none rounded-lg border border-border bg-panel-2/60", dimmed && "opacity-50")}
    >
      <div className="flex">
        {/* lane labels, each with its "+" */}
        <div className="shrink-0 border-r border-border" style={{ width: LABEL_WIDTH }}>
          <div style={{ height: RULER_HEIGHT }} />
          {LANES.map((lane) => {
            const full = laneFull(lane.id, plan, sfx);
            const picker = lane.id === "sfx";
            return (
              <div
                key={lane.id}
                className="flex items-center justify-between pl-2 pr-1"
                style={{ height: LANE_HEIGHT }}
              >
                <span className="eyebrow text-muted" title={lane.id === "cutaways" && onDropMedia ? "Drop an image or video on this lane to add it" : undefined}>
                  {lane.label}
                </span>
                <button
                  type="button"
                  disabled={full}
                  onClick={() => (picker ? setPicking((open) => !open) : onAdd(lane.id))}
                  title={full ? "Lane is full" : `${lane.add} (${timecode(playhead)})`}
                  aria-label={lane.add}
                  aria-expanded={picker ? picking : undefined}
                  className={cn(
                    "press inline-flex size-5 items-center justify-center rounded text-muted hover:bg-panel hover:text-fg disabled:opacity-30",
                    picker && picking && "bg-panel text-fg"
                  )}
                >
                  <Plus className="size-3" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        {picking ? (
          <div
            ref={pickerRef}
            className="absolute z-20 w-64 rounded-lg border border-border bg-panel-2 p-2 shadow-lg"
            style={{ left: LABEL_WIDTH + 4, bottom: 4 }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <p className="text-micro mb-1.5 text-muted">Sound at {timecode(playhead)} — press play to hear it</p>
            <SfxPicker
              assets={sfxAssets}
              value={lastSfx()}
              autoFocus
              onPick={(assetId) => {
                setPicking(false);
                onAddSfx(assetId);
              }}
            />
          </div>
        ) : null}

        {/* lanes */}
        <div
          ref={containerRef}
          className="relative min-w-0 flex-1 overflow-hidden"
          onPointerDown={(event) => {
            onSelect(null);
            onSeek(secondsAt(event.clientX));
          }}
        >
          {/* ruler */}
          <div className="relative border-b border-border" style={{ height: RULER_HEIGHT }}>
            {ticks.map((tick) => (
              <span
                key={tick}
                className="num text-micro absolute top-0 -translate-x-1/2 text-muted"
                style={{ left: pct(tick) }}
              >
                {timecode(tick)}
              </span>
            ))}
            {sceneCuts.map((cut) => (
              <span
                key={`cut-${Math.round(cut * 1000)}`}
                className="absolute bottom-0 h-1.5 w-px bg-accent-2"
                style={{ left: pct(cut) }}
                title={`shot change ${timecode(cut)}`}
              />
            ))}
            {peakSec >= trimStart && peakSec <= trimEnd ? (
              <span
                className="absolute bottom-0 size-1.5 -translate-x-1/2 rounded-full bg-accent"
                style={{ left: pct(peakSec) }}
                title={`peak ${timecode(peakSec)}`}
              />
            ) : null}
          </div>

          {/* removed spans, drawn across every lane */}
          {(plan.cuts ?? [])
            .filter((cut) => cut.enabled)
            .map((cut) => (
              <div
                key={`shade-${cut.id}`}
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgba(255,80,80,0.12)_4px_8px)]"
                style={{
                  left: pct(cut.startSec),
                  width: widthPct(cut.endSec - cut.startSec),
                  top: RULER_HEIGHT,
                }}
              />
            ))}

          {LANES.map((lane, index) => (
            <div
              key={lane.id}
              className={cn(
                "relative border-b border-border/60",
                index === LANES.length - 1 && "border-b-0",
                lane.id === "cutaways" && dropAt !== null && "bg-sky-400/10"
              )}
              style={{ height: LANE_HEIGHT }}
              {...(lane.id === "cutaways" && onDropMedia
                ? {
                    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
                      if (!event.dataTransfer.types.includes("Files") || uploadingAt !== null) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                      setDropAt(secondsAt(event.clientX));
                    },
                    onDragLeave: () => setDropAt(null),
                    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
                      event.preventDefault();
                      setDropAt(null);
                      const file = event.dataTransfer.files[0];
                      if (!file || uploadingAt !== null) return;
                      const at = secondsAt(event.clientX);
                      setUploadingAt(at);
                      void onDropMedia(file, at).finally(() => setUploadingAt(null));
                    },
                  }
                : {})}
            >
              {lane.id === "cutaways" && (dropAt !== null || uploadingAt !== null) ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1 bottom-1 flex items-center whitespace-nowrap rounded-sm border border-dashed border-sky-400 bg-sky-400/20 px-1.5 text-micro font-semibold text-fg"
                  style={{ left: pct(uploadingAt ?? dropAt!) }}
                >
                  {uploadingAt !== null ? "Uploading…" : `Drop to place at ${timecode(dropAt!)}`}
                </div>
              ) : null}
              {blocks
                .filter((block) => block.lane === lane.id)
                .map((block) => {
                  const active = selected?.lane === block.lane && selected.id === block.id;
                  const width = block.point ? undefined : widthPct(block.endSec - block.startSec);
                  return (
                    <div
                      key={block.id}
                      role="button"
                      tabIndex={0}
                      onPointerDown={(event) => beginDrag(event, block)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelect({ lane: block.lane, id: block.id });
                        } else if (event.key === "Delete" || event.key === "Backspace") {
                          event.preventDefault();
                          onRemove(block.lane, block.id);
                        }
                      }}
                      className={cn(
                        "absolute top-1 bottom-1 flex items-center overflow-hidden rounded-sm border px-1.5 text-micro font-semibold outline-none",
                        block.point
                          ? "w-4 -translate-x-1/2 justify-center rounded-full"
                          : "cursor-grab active:cursor-grabbing",
                        laneTone(block.lane, block.muted),
                        active && "ring-2 ring-accent ring-offset-1 ring-offset-panel"
                      )}
                      style={{ left: pct(block.startSec), width }}
                      title={
                        block.point
                          ? `${block.label} · ${timecode(block.startSec)}`
                          : `${block.label} · ${timecode(block.startSec)}–${timecode(block.endSec)}`
                      }
                    >
                      {block.point ? "•" : <span className="truncate">{block.label}</span>}
                    </div>
                  );
                })}
            </div>
          ))}

          {/* playhead */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-fg"
            style={{
              left: pct(Math.max(trimStart, Math.min(trimEnd, playhead))),
            }}
          />
        </div>
      </div>
    </div>
  );
}

function laneTone(lane: BeatLane, muted?: boolean): string {
  if (muted) return "border-border bg-panel text-muted opacity-70";
  switch (lane) {
    case "cuts":
      return "border-bad/60 bg-bad/20 text-bad";
    case "camera":
      return "border-accent/60 bg-accent/20 text-fg";
    case "speed":
      return "border-fg/40 bg-fg/15 text-fg";
    case "fx":
      return "border-fuchsia-400/60 bg-fuchsia-400/20 text-fg";
    case "cutaways":
      return "border-sky-400/60 bg-sky-400/20 text-fg";
    case "captions":
      return "border-accent-2/60 bg-accent-2/20 text-fg";
    case "titles":
      return "border-warn/60 bg-warn/20 text-fg";
    case "sfx":
      return "border-good/60 bg-good/25 text-fg";
  }
}
