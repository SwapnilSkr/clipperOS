import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { BehindTitle } from "@/api";
import {
  ASS_FONT_SIZE_MATCH,
  titleFontPx,
  wrapTitle,
  TITLE_DEFAULT_FONT,
  TITLE_LETTER_SPACING,
  type TitleFont,
} from "@/lib/titles";

// ============================================================
// TEXT PLACEMENT — drag the selected Text beat on the preview.
//
// A dashed box the size the text renders at (the same font size and wrap the
// burn uses), centred on the beat's resting place and turned by its tilt.
// Dragging moves the centre; near the frame's middle it snaps to the centre
// lines. Arrow keys nudge (Shift for bigger steps). The box shows even when
// the playhead is outside the beat, so it can be placed before it plays.
// ============================================================

const SNAP = 0.015;
const clamp = (value: number) => Math.round(Math.max(0.05, Math.min(0.95, value)) * 1000) / 1000;

let measureCtx: CanvasRenderingContext2D | null = null;

export function TextPlacement({
  title,
  frameWidth,
  frameHeight,
  fontFor,
  onMove,
}: {
  title: BehindTitle;
  frameWidth: number;
  frameHeight: number;
  fontFor: (family: string) => TitleFont;
  onMove: (position: { x: number; y: number }) => void;
}) {
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [guides, setGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const scale = frameHeight / 1920;

  const size = useMemo(() => {
    const px = titleFontPx(title);
    const lines = wrapTitle(title.uppercase ? title.text.toUpperCase() : title.text, px);
    const font = fontFor(title.fontFamily ?? TITLE_DEFAULT_FONT);
    measureCtx ??= document.createElement("canvas").getContext("2d");
    let widest = px * 2;
    if (measureCtx) {
      // Measured the way the painter draws it: the face's em, the burn's letter spacing, no kerning.
      measureCtx.font = `${font.weight} ${px * (font.emScale ?? 1)}px ${font.stack}`;
      measureCtx.fontKerning = "none";
      (measureCtx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${TITLE_LETTER_SPACING}px`;
      widest = Math.max(...lines.map((line) => measureCtx!.measureText(line).width), px);
    }
    return { width: widest * scale + 12, height: Math.max(1, lines.length) * px * ASS_FONT_SIZE_MATCH * scale + 8 };
  }, [title, fontFor, scale]);

  if (frameWidth <= 0 || frameHeight <= 0) return null;
  const cx = clamp(title.x) * frameWidth;
  const cy = clamp(title.y) * frameHeight;

  function place(clientX: number, clientY: number, offset: { dx: number; dy: number }) {
    const frame = boxRef.current?.parentElement?.getBoundingClientRect();
    if (!frame) return;
    let x = (clientX - offset.dx - frame.left) / frame.width;
    let y = (clientY - offset.dy - frame.top) / frame.height;
    const snapX = Math.abs(x - 0.5) < SNAP;
    const snapY = Math.abs(y - 0.5) < SNAP;
    if (snapX) x = 0.5;
    if (snapY) y = 0.5;
    setGuides({ x: snapX, y: snapY });
    onMove({ x: clamp(x), y: clamp(y) });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const frame = boxRef.current?.parentElement?.getBoundingClientRect();
    if (!frame) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    // Keep the grab point under the pointer instead of jumping the centre to it.
    setDrag({ dx: event.clientX - (frame.left + cx), dy: event.clientY - (frame.top + cy) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    onMove({ x: clamp(title.x + move[0]), y: clamp(title.y + move[1]) });
  }

  return (
    <>
      {drag && guides.x ? <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-accent/80" /> : null}
      {drag && guides.y ? <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-accent/80" /> : null}
      <div
        ref={boxRef}
        role="slider"
        tabIndex={0}
        aria-label={`Position of "${title.text}"`}
        aria-valuetext={`${Math.round(clamp(title.x) * 100)}% across, ${Math.round(clamp(title.y) * 100)}% down`}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) place(event.clientX, event.clientY, drag);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          setDrag(null);
          setGuides({ x: false, y: false });
        }}
        onKeyDown={onKeyDown}
        className="absolute cursor-move touch-none rounded-sm border-2 border-dashed border-accent outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={{
          left: cx,
          top: cy,
          width: size.width,
          height: size.height,
          transform: `translate(-50%, -50%) rotate(${title.rotation ?? 0}deg)`,
          background: drag ? "rgba(212, 255, 90, 0.08)" : undefined,
        }}
      >
        {!drag ? (
          <span className="text-micro pointer-events-none absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 font-semibold text-accent">
            Drag to move
          </span>
        ) : null}
      </div>
    </>
  );
}
