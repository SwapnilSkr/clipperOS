import type { CaptionStyleInfo } from "@/api";
import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  CAPTION_BASE_FONT,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  PEAK_BASE_FONT,
  type PreviewCaption,
} from "@/lib/captions";
import { ASS_FONT_SIZE_MATCH, type TitleFont } from "@/lib/titles";

interface CaptionOverlayProps {
  caption: PreviewCaption | null;
  style: CaptionStyleInfo;
  /** The look's face: stack, weight, and how libass sizes and seats it. */
  font?: TitleFont;
  /** Height of the video frame in CSS pixels, used to scale the burn geometry. */
  frameHeight: number;
  frameWidth: number;
  positioning?: boolean;
  onPositionChange?: (horizontalFrac: number, verticalFrac: number) => void;
  /** With `style.highlight === "word"`: which word is being spoken. */
  spokenIndex?: number;
}

// The ASS style numbers the burn writes (server caption.service resolveLook),
// for the caption line and the larger peak line: outline and shadow widths in
// output pixels for BorderStyle 1, the box's padding for BorderStyle 3.
const CAP_STROKE = { outline: 6, shadow: 3, boxPad: 14 };
const PEAK_STROKE = { outline: 7, shadow: 4, boxPad: 16 };
/** BackColour &H9A000000: the shadow's alpha byte, as an opacity. */
const SHADOW_OPACITY = (255 - 0x9a) / 255;

let measureCanvas: HTMLCanvasElement | null = null;

/** Advance width of `text` in `cssFont`, as the browser will lay it out (no kerning: the burn does none). */
function measureLine(text: string, cssFont: string): number {
  if (typeof document === "undefined") return 0;
  measureCanvas ??= document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return 0;
  ctx.font = cssFont;
  ctx.fontKerning = "none";
  return ctx.measureText(text).width;
}

/** Bumps once the page's font faces finish loading, so measurements taken with a fallback face are redone. */
function useFontsLoaded(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    const bump = () => setTick((n) => n + 1);
    document.fonts.addEventListener("loadingdone", bump);
    return () => document.fonts.removeEventListener("loadingdone", bump);
  }, []);
  return tick;
}

/**
 * Captions drawn over the player, exactly as the burn draws them.
 *
 * Everything is laid out in the 1080×1920 output space of an SVG scaled to
 * the frame, with libass's own geometry: `\an5\pos` centres a stack of line
 * boxes ASS-size tall on the anchor; each face's em and baseline inside that
 * box come from its metrics (server caption-fonts); BorderStyle 1 is a
 * round-joined outline `Outline` wide with the shadow `Shadow` px down-right
 * at BackColour's alpha; BorderStyle 3 is an opaque box `Outline` around the
 * line's advance box. No kerning, as the ASS header sets none.
 *
 * Decorative: it mirrors text the video already carries, so it is hidden from
 * assistive tech rather than announced line by line.
 */
export function CaptionOverlay({
  caption,
  style,
  font,
  frameHeight,
  frameWidth,
  positioning = false,
  onPositionChange,
  spokenIndex = -1,
}: CaptionOverlayProps) {
  const fontsLoaded = useFontsLoaded();
  const emphasis = Boolean(caption?.emphasis);
  const casing = (value: string) => (style.uppercase ? value.toUpperCase() : value);
  // The burn's numbers: a rounded ASS size is the line box, the em inside it
  // scaled by the face; the anchor clamped into the frame and rounded.
  const lineBox = Math.round((emphasis ? PEAK_BASE_FONT : CAPTION_BASE_FONT) * style.sizeScale * ASS_FONT_SIZE_MATCH);
  const em = (lineBox * (font?.emScale ?? 1)) / ASS_FONT_SIZE_MATCH;
  const baseline = font?.baseline ?? 0.8;
  const weight = font?.weight ?? 900;
  const stack = font?.stack ?? style.fontFamily;
  const anchorX = Math.round(Math.max(0.05, Math.min(0.95, style.horizontalFrac)) * OUTPUT_WIDTH);
  const anchorY = Math.round((1 - Math.max(0.05, Math.min(0.95, style.verticalFrac))) * OUTPUT_HEIGHT);
  const lines = useMemo(() => (caption ? casing(caption.text).split(/\r?\n/) : []), [caption, style.uppercase]);
  // Re-measured once the real faces load: before that a fallback face answers.
  const widths = useMemo(
    () => lines.map((line) => measureLine(line, `${weight} ${em}px ${stack}`)),
    [lines, weight, em, stack, fontsLoaded]
  );

  if (!caption || frameHeight <= 0) return null;

  const scale = frameHeight / OUTPUT_HEIGHT;
  const stroke = emphasis ? PEAK_STROKE : CAP_STROKE;
  const boxed = style.background === "box";
  const karaoke = style.highlight === "word" && caption.words.length > 1;
  // The burn colours the spoken word with the accent (or, on an accent-coloured
  // peak line, with the text colour) — mirror it exactly.
  const quiet = emphasis ? style.peakColor : style.textColor;
  const loud = emphasis ? style.textColor : style.peakColor;
  const blockTop = anchorY - (lines.length * lineBox) / 2;
  const widest = Math.max(0, ...widths);
  const pad = boxed ? stroke.boxPad : stroke.outline + stroke.shadow;
  const filterId = `caption-shadow-${emphasis ? "peak" : "cap"}`;

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!positioning || !onPositionChange) return;
    const frame = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!frame) return;
    const x = Math.max(0.05, Math.min(0.95, (event.clientX - frame.left) / frame.width));
    const vertical = Math.max(0.05, Math.min(0.95, 1 - (event.clientY - frame.top) / frame.height));
    onPositionChange(x, vertical);
  };

  return (
    <>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        width={frameWidth}
        height={frameHeight}
        viewBox={`0 0 ${OUTPUT_WIDTH} ${OUTPUT_HEIGHT}`}
        preserveAspectRatio="none"
        style={{ overflow: "visible" }}
      >
        {!boxed ? (
          <defs>
            <filter id={filterId} filterUnits="userSpaceOnUse" x={-OUTPUT_WIDTH} y={-OUTPUT_HEIGHT} width={OUTPUT_WIDTH * 3} height={OUTPUT_HEIGHT * 3}>
              <feDropShadow dx={stroke.shadow} dy={stroke.shadow} stdDeviation={0} floodColor="#000000" floodOpacity={SHADOW_OPACITY} />
            </filter>
          </defs>
        ) : null}
        <g
          key={`${caption.sourceStartSec}:${style.animation}`}
          className={`caption-${style.animation}`}
          style={{ transformBox: "view-box", transformOrigin: `${anchorX}px ${anchorY}px` }}
        >
          {boxed
            ? lines.map((line, index) => (
                <rect
                  key={`box-${index}-${line}`}
                  x={anchorX - widths[index]! / 2 - stroke.boxPad}
                  y={blockTop + index * lineBox - stroke.boxPad}
                  width={widths[index]! + stroke.boxPad * 2}
                  height={lineBox + stroke.boxPad * 2}
                  fill="#000000"
                />
              ))
            : null}
          <text
            fontFamily={stack}
            fontSize={em}
            fontWeight={weight}
            fill={quiet}
            textAnchor="middle"
            textRendering="geometricPrecision"
            stroke={boxed ? "none" : "#000000"}
            strokeWidth={boxed ? 0 : stroke.outline * 2}
            strokeLinejoin="round"
            filter={boxed ? undefined : `url(#${filterId})`}
            style={{ fontKerning: "none", paintOrder: "stroke fill", whiteSpace: "pre" }}
          >
            {lines.map((line, index) => {
              const y = blockTop + index * lineBox + lineBox * baseline;
              if (!karaoke) {
                return (
                  <tspan key={`line-${index}`} x={anchorX} y={y}>
                    {line}
                  </tspan>
                );
              }
              return (
                <tspan key={`line-${index}`} x={anchorX} y={y}>
                  {caption.words.map((word, wordIndex) => (
                    <tspan key={`${word.t}-${wordIndex}`} fill={wordIndex === spokenIndex ? loud : quiet}>
                      {wordIndex > 0 ? " " : ""}
                      {casing(word.word)}
                    </tspan>
                  ))}
                </tspan>
              );
            })}
          </text>
        </g>
      </svg>
      {positioning ? (
        <div
          role="presentation"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            move(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event);
          }}
          className="absolute cursor-move touch-none"
          style={{
            left: (anchorX - widest / 2 - pad) * scale,
            top: (blockTop - pad) * scale,
            width: (widest + pad * 2) * scale,
            height: (lines.length * lineBox + pad * 2) * scale,
          }}
        />
      ) : null}
    </>
  );
}
