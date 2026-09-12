import type { CaptionStyleInfo } from "@/api";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  CAPTION_BASE_FONT,
  OUTPUT_HEIGHT,
  PEAK_BASE_FONT,
  type PreviewCaption,
} from "@/lib/captions";

interface CaptionOverlayProps {
  caption: PreviewCaption | null;
  style: CaptionStyleInfo;
  fontStack: string;
  fontWeight: number;
  /** Height of the video frame in CSS pixels, used to scale the burn geometry. */
  frameHeight: number;
  frameWidth: number;
  positioning?: boolean;
  onPositionChange?: (horizontalFrac: number, verticalFrac: number) => void;
}

/**
 * Captions drawn over the player, sized like the burned ones.
 *
 * The burn happens at 1080x1920, so every measurement is a fraction of the
 * frame: font sizes scale by `frameHeight / OUTPUT_HEIGHT` and the baseline sits
 * `verticalFrac` of the frame height up from the bottom. That keeps the preview
 * honest at any player size — a "big" caption has to look big here too, or the
 * control lies about what renders.
 *
 * Decorative: it mirrors text the video already carries, so it is hidden from
 * assistive tech rather than announced line by line.
 */
export function CaptionOverlay({
  caption,
  style,
  fontStack,
  fontWeight,
  frameHeight,
  frameWidth,
  positioning = false,
  onPositionChange,
}: CaptionOverlayProps) {
  if (!caption || frameHeight <= 0) return null;

  const scale = frameHeight / OUTPUT_HEIGHT;
  const base = (caption.emphasis ? PEAK_BASE_FONT : CAPTION_BASE_FONT) * style.sizeScale;
  const fontSize = Math.max(8, base * scale);
  const text = style.uppercase ? caption.text.toUpperCase() : caption.text;

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!positioning || !onPositionChange) return;
    const frame = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!frame) return;
    const x = Math.max(0.05, Math.min(0.95, (event.clientX - frame.left) / frame.width));
    const vertical = Math.max(0.05, Math.min(0.95, 1 - (event.clientY - frame.top) / frame.height));
    onPositionChange(x, vertical);
  };

  return (
    <div
      aria-hidden={!positioning}
      onPointerDown={(event) => {
        if (!positioning) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event);
      }}
      onPointerMove={(event) => {
        if (positioning && event.currentTarget.hasPointerCapture(event.pointerId)) move(event);
      }}
      className={positioning ? "absolute flex cursor-move justify-center touch-none" : "pointer-events-none absolute flex justify-center"}
      style={{
        left: style.horizontalFrac * frameWidth,
        bottom: style.verticalFrac * frameHeight,
        width: "90%",
        transform: "translate(-50%, 50%)",
        containerType: "inline-size",
      }}
    >
      <span
        key={`${caption.sourceStartSec}:${style.animation}`}
        className={`text-center leading-tight caption-${style.animation}`}
        style={{
          fontSize,
          fontFamily: fontStack,
          fontWeight,
          color: caption.emphasis ? style.peakColor : style.textColor,
          background: style.background === "box" ? "rgba(0,0,0,0.68)" : undefined,
          borderRadius: style.background === "box" ? Math.max(4, fontSize * 0.18) : undefined,
          padding: style.background === "box" ? `${fontSize * 0.12}px ${fontSize * 0.28}px` : undefined,
          // Stands in for the ASS outline + shadow. Without it, white text on a
          // bright frame is unreadable and the preview would oversell legibility.
          textShadow:
            "0 0 3px rgba(0,0,0,0.95), 0 2px 6px rgba(0,0,0,0.85), 0 0 1px rgba(0,0,0,1)",
          WebkitTextStroke: `${Math.max(1, fontSize * 0.045)}px rgba(0,0,0,0.75)`,
          paintOrder: "stroke fill",
        }}
      >
        {text}
      </span>
    </div>
  );
}
