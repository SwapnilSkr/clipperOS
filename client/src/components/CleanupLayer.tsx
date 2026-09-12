import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import type { CleanupRegion } from "@/api";
import { frameToSource, sourceToFrame, type CropTransform } from "@/lib/reframe";
import { cn } from "@/lib/utils";

/** A rect smaller than this (in source px) is a mis-drag, not a watermark. */
const MIN_SIZE_PX = 8;

interface CleanupLayerProps {
  regions: CleanupRegion[];
  transform: CropTransform;
  /** Visible frame size in CSS px. */
  frameWidth: number;
  frameHeight: number;
  /** False in "fit" mode: you can see the rects but not draw new ones. */
  editable: boolean;
  onAdd: (rect: { x: number; y: number; w: number; h: number }) => void;
  onChange: (id: string, patch: Partial<CleanupRegion>) => void;
  onRemove: (id: string) => void;
}

type Drag =
  | { kind: "draw"; startX: number; startY: number }
  | { kind: "move"; id: string; grabX: number; grabY: number; origin: { x: number; y: number } }
  | {
      kind: "resize";
      id: string;
      origin: { x: number; y: number; w: number; h: number };
      startX: number;
      startY: number;
    };

/**
 * The draw/move/resize layer for cleanup regions.
 *
 * Everything is stored in SOURCE pixels and converted for display, because the
 * rects have to survive the reframe crop and any change to it. The layer works in
 * whichever mode is showing: "crop" shows part of the source, "fit" shows all of
 * it, and both map correctly because the transform comes from `reframe.ts`.
 */
export function CleanupLayer({
  regions,
  transform,
  frameWidth,
  frameHeight,
  editable,
  onAdd,
  onChange,
  onRemove,
}: CleanupLayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draftRect, setDraftRect] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null
  );

  /** Pointer position in frame-local CSS pixels. */
  function framePoint(event: ReactPointerEvent): { x: number; y: number } {
    const box = hostRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!editable) return;
    // Only a press on the background starts a new rect; presses on an existing
    // rect are handled by that rect's own handler.
    if (event.target !== hostRef.current) return;
    const point = framePoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ kind: "draw", startX: point.x, startY: point.y });
    setDraftRect({ x: point.x, y: point.y, w: 0, h: 0 });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const point = framePoint(event);

    if (drag.kind === "draw") {
      setDraftRect({
        x: Math.min(drag.startX, point.x),
        y: Math.min(drag.startY, point.y),
        w: Math.abs(point.x - drag.startX),
        h: Math.abs(point.y - drag.startY),
      });
      return;
    }

    if (drag.kind === "move") {
      // Move in SOURCE pixels so the rect stays put on the footage, not on screen.
      const from = frameToSource(transform, drag.grabX, drag.grabY);
      const to = frameToSource(transform, point.x, point.y);
      onChange(drag.id, {
        x: Math.max(0, Math.round(drag.origin.x + (to.x - from.x))),
        y: Math.max(0, Math.round(drag.origin.y + (to.y - from.y))),
      });
      return;
    }

    const from = frameToSource(transform, drag.startX, drag.startY);
    const to = frameToSource(transform, point.x, point.y);
    onChange(drag.id, {
      w: Math.max(MIN_SIZE_PX, Math.round(drag.origin.w + (to.x - from.x))),
      h: Math.max(MIN_SIZE_PX, Math.round(drag.origin.h + (to.y - from.y))),
    });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag?.kind === "draw" && draftRect) {
      // Convert the on-screen drag back into source pixels before committing.
      const topLeft = frameToSource(transform, draftRect.x, draftRect.y);
      const bottomRight = frameToSource(transform, draftRect.x + draftRect.w, draftRect.y + draftRect.h);
      const w = Math.round(bottomRight.x - topLeft.x);
      const h = Math.round(bottomRight.y - topLeft.y);
      if (w >= MIN_SIZE_PX && h >= MIN_SIZE_PX) {
        onAdd({ x: Math.round(topLeft.x), y: Math.round(topLeft.y), w, h });
      }
    }
    setDrag(null);
    setDraftRect(null);
  }

  return (
    <div
      ref={hostRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={cn(
        "absolute inset-0 touch-none",
        editable ? "cursor-crosshair" : "cursor-default"
      )}
    >
      {regions.map((region) => {
        const topLeft = sourceToFrame(transform, region.x, region.y);
        const bottomRight = sourceToFrame(transform, region.x + region.w, region.y + region.h);
        const style = {
          left: topLeft.x,
          top: topLeft.y,
          width: bottomRight.x - topLeft.x,
          height: bottomRight.y - topLeft.y,
        };

        return (
          <div
            key={region.id}
            style={style}
            onPointerDown={(event) => {
              if (!editable) return;
              event.stopPropagation();
              const point = framePoint(event);
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag({
                kind: "move",
                id: region.id,
                grabX: point.x,
                grabY: point.y,
                origin: { x: region.x, y: region.y },
              });
            }}
            className="absolute rounded-sm border-2 border-warn/80 bg-warn/10"
          >
            <span className="eyebrow absolute -top-4 start-0 rounded bg-warn px-1 text-black">
              clean
            </span>
            {editable ? (
              <>
                <button
                  type="button"
                  aria-label="Remove cleanup region"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onRemove(region.id)}
                  className="absolute -end-3 -top-3 inline-flex size-6 items-center justify-center rounded-full bg-warn text-black"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
                <span
                  aria-hidden="true"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    const point = framePoint(event);
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDrag({
                      kind: "resize",
                      id: region.id,
                      origin: { x: region.x, y: region.y, w: region.w, h: region.h },
                      startX: point.x,
                      startY: point.y,
                    });
                  }}
                  className="absolute -bottom-1.5 -end-1.5 size-3 cursor-nwse-resize rounded-sm bg-warn"
                />
              </>
            ) : null}
          </div>
        );
      })}

      {draftRect && draftRect.w > 1 && draftRect.h > 1 ? (
        <div
          style={{ left: draftRect.x, top: draftRect.y, width: draftRect.w, height: draftRect.h }}
          className="pointer-events-none absolute rounded-sm border-2 border-warn bg-warn/20"
        />
      ) : null}

      {editable && regions.length === 0 && !drag ? (
        <p className="text-meta pointer-events-none absolute inset-x-0 bottom-2 px-3 text-center text-white/70">
          Drag over a watermark or burned-in caption to remove it
        </p>
      ) : null}
      <span className="sr-only" style={{ width: frameWidth, height: frameHeight }} />
    </div>
  );
}
