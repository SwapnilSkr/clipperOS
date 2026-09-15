import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { CameraMove, CreatorPlan, ReframeTrack } from "@/api";
import { cropBoxAt, followZoom, moveZoomAt, panSlack, resolveAnchor, type PanPx } from "@/lib/creator-timeline";
import { cropAtTime } from "@/lib/reframe";

// ============================================================
// FRAMING WIDGET — where the 9:16 window sits over the source, by hand.
//
// The whole source frame, as the player currently shows it, with the tracked
// crop drawn as a rectangle. Dragging the rectangle pans the move (−1..1 of
// the room either side of the track's own framing); the dot inside is the
// zoom anchor, draggable when the anchor is a point; the inner outline is
// what the move's full zoom keeps. Same maths as the burn: cropBoxAt,
// panSlack, resolveAnchor.
// ============================================================

export interface FramingWidgetProps {
  video: RefObject<HTMLVideoElement | null>;
  track: ReframeTrack | undefined;
  plan: CreatorPlan;
  move: CameraMove;
  /** Follow tightness across the frame and lead room, as the player applies them. */
  tightness: number;
  lead: number;
  /** The crop track's origin, so the move's midpoint maps onto keyframe time. */
  cropOrigin: number;
  onChange: (change: Partial<CameraMove>) => void;
}

type Drag = { kind: "pan" | "anchor"; startX: number; startY: number; pan: PanPx; anchor: { x: number; y: number } };

export function FramingWidget({ video, track, plan, move, tightness, lead, cropOrigin, onChange }: FramingWidgetProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const sourceWidth = track?.sourceWidth ?? video.current?.videoWidth ?? 16;
  const sourceHeight = track?.sourceHeight ?? video.current?.videoHeight ?? 9;
  const mid = (move.startSec + move.endSec) / 2;
  const geometry = track ?? { sourceWidth, sourceHeight };
  const slack = panSlack(geometry);
  const pan: PanPx = move.pan ?? { x: 0, y: 0 };
  const panPx: PanPx = { x: pan.x * slack.x, y: pan.y * slack.y };

  // The tracked crop at the move's midpoint, then the pan on top.
  const base = cropAtTime(track, mid - cropOrigin, sourceWidth, sourceHeight, tightness, { lead });
  const box = cropBoxAt({ ...base, t: 0 }, geometry, 0, 0, panPx);
  const anchor = resolveAnchor(move.anchor, track, mid, tightness, lead, panPx);
  const fullZoom = Math.max(1, moveZoomAt(move, 1) * followZoom(plan));
  const kept = {
    w: box.w / fullZoom,
    h: box.h / fullZoom,
  };
  const keptBox = {
    x: box.x + (box.w - kept.w) * anchor.x,
    y: box.y + (box.h - kept.h) * anchor.y,
    ...kept,
  };

  // Paint: the current source frame, the crop, the kept area, the anchor.
  useEffect(() => {
    const canvas = canvasRef.current;
    const source = video.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.clientWidth;
    const height = Math.round((width * sourceHeight) / sourceWidth);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const scale = width / sourceWidth;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, width, height);
    if (source && source.readyState >= 2) {
      try {
        ctx.drawImage(source, 0, 0, width, height);
      } catch {
        // A frame that is not decodable yet paints black; the next paint fixes it.
      }
    }
    // Dim everything outside the crop.
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, width, height);
    ctx.clearRect(box.x * scale, box.y * scale, box.w * scale, box.h * scale);
    if (source && source.readyState >= 2) {
      try {
        ctx.drawImage(
          source,
          box.x,
          box.y,
          box.w,
          box.h,
          box.x * scale,
          box.y * scale,
          box.w * scale,
          box.h * scale
        );
      } catch {
        // as above
      }
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeRect(box.x * scale + 0.75, box.y * scale + 0.75, box.w * scale - 1.5, box.h * scale - 1.5);
    if (fullZoom > 1.001) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "rgba(200,255,90,0.9)";
      ctx.strokeRect(keptBox.x * scale, keptBox.y * scale, keptBox.w * scale, keptBox.h * scale);
      ctx.setLineDash([]);
    }
    const ax = (box.x + box.w * anchor.x) * scale;
    const ay = (box.y + box.h * anchor.y) * scale;
    ctx.beginPath();
    ctx.arc(ax, ay, 5, 0, Math.PI * 2);
    ctx.fillStyle = typeof move.anchor === "object" ? "rgb(200,255,90)" : "rgba(255,255,255,0.85)";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.stroke();
  });

  // Repaint while the source plays or seeks, so the widget follows the playhead.
  const [, tick] = useState(0);
  useEffect(() => {
    const source = video.current;
    if (!source) return;
    const bump = () => tick((n) => n + 1);
    source.addEventListener("timeupdate", bump);
    source.addEventListener("seeked", bump);
    return () => {
      source.removeEventListener("timeupdate", bump);
      source.removeEventListener("seeked", bump);
    };
  }, [video]);

  function sourcePoint(event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = sourceWidth / rect.width;
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = sourcePoint(event);
    const anchorPx = { x: box.x + box.w * anchor.x, y: box.y + box.h * anchor.y };
    const grip = Math.max(12, sourceWidth / 60);
    const onAnchor = Math.hypot(point.x - anchorPx.x, point.y - anchorPx.y) <= grip;
    const inside = point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
    if (!onAnchor && !inside) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      kind: onAnchor ? "anchor" : "pan",
      startX: point.x,
      startY: point.y,
      pan,
      anchor: { x: anchor.x, y: anchor.y },
    });
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drag) return;
    const point = sourcePoint(event);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    if (drag.kind === "pan") {
      const next: PanPx = {
        x: slack.x > 0 ? Math.max(-1, Math.min(1, drag.pan.x + dx / slack.x)) : 0,
        y: slack.y > 0 ? Math.max(-1, Math.min(1, drag.pan.y + dy / slack.y)) : 0,
      };
      onChange({ pan: { x: round3(next.x), y: round3(next.y) } });
      return;
    }
    // The dot: a point anchor, in output fractions of the crop.
    onChange({
      anchor: {
        x: round3(Math.max(0, Math.min(1, drag.anchor.x + dx / box.w))),
        y: round3(Math.max(0, Math.min(1, drag.anchor.y + dy / box.h))),
      },
    });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  }

  return (
    <div className="mt-2">
      <canvas
        ref={canvasRef}
        className="w-full cursor-move rounded-md border border-border bg-black"
        style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}`, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-label="Framing: drag the window to pan, the dot to set the zoom point"
      />
      <div className="text-micro mt-1 flex items-center justify-between text-muted">
        <span>
          Drag the window to pan{slack.x > 0 ? "" : " (no room sideways)"} · drag the dot for the zoom point
        </span>
        {move.pan && (move.pan.x !== 0 || move.pan.y !== 0) ? (
          <button type="button" onClick={() => onChange({ pan: undefined })} className="press text-accent hover:underline">
            Reset pan
          </button>
        ) : null}
      </div>
    </div>
  );
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
