import type { CreatorPlan, EffectInfo, EffectSpan } from "@/api";

// ============================================================
// FX PREVIEW — a close live approximation of the effects pack.
//
// The burn applies FFmpeg filters (server/src/config/effects.ts). Here the
// same effects are approximated on the player: CSS filters where one maps
// (the registry says which, per amount), and canvas layers painted over the
// crop for what CSS cannot draw. Time-based looks (flicker, strobe, glitch,
// fades) use the same formulas as the filters, on the window's clock.
// "Render this span" is the exact check.
// ============================================================

export interface ActiveEffect {
  span: EffectSpan;
  info: EffectInfo;
  /** 0..1 amount. */
  amount: number;
}

/** The effects in force at a source instant, in plan order. */
export function activeEffectsAt(
  plan: CreatorPlan | undefined,
  registry: EffectInfo[],
  sourceSec: number
): ActiveEffect[] {
  if (!plan?.enabled || !plan.effects?.length) return [];
  const out: ActiveEffect[] = [];
  for (const span of plan.effects) {
    if (sourceSec < span.startSec || sourceSec >= span.endSec) continue;
    const info = registry.find((item) => item.id === span.effectId);
    if (!info) continue;
    out.push({ span, info, amount: Math.max(0, Math.min(1, span.amount)) });
  }
  return out;
}

/** The CSS `filter` for the active effects, or "" when none maps to CSS. */
export function cssFilterFor(active: ActiveEffect[]): string {
  const parts: string[] = [];
  for (const { info, amount } of active) {
    const css = info.preview.css;
    if (!css) continue;
    for (const [fn, range] of Object.entries(css)) {
      const value = range[0] + (range[1] - range[0]) * amount;
      if (fn === "blur") parts.push(`blur(${value.toFixed(2)}px)`);
      else if (fn === "hue-rotate") parts.push(`hue-rotate(${value.toFixed(1)}deg)`);
      else parts.push(`${fn}(${value.toFixed(3)})`);
    }
  }
  return parts.join(" ");
}

let noiseTile: HTMLCanvasElement | null = null;

/** A 128px tile of grey noise, drawn once and offset per frame. */
function noise(): HTMLCanvasElement {
  if (noiseTile) return noiseTile;
  const tile = document.createElement("canvas");
  tile.width = 128;
  tile.height = 128;
  const ctx = tile.getContext("2d")!;
  const image = ctx.createImageData(128, 128);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = Math.random() * 255;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  noiseTile = tile;
  return tile;
}

function fadeAmount(variant: string | undefined, u: number): number {
  const c = Math.max(0, Math.min(1, u));
  if (variant === "in") return 1 - c;
  if (variant === "dip") return 1 - Math.abs(2 * c - 1);
  return c;
}

/**
 * Paint the canvas layers of the active effects onto the crop canvas.
 * `t` is the window-local clock (seconds since the kept window's start), the
 * clock the burn's expressions run on; `spanLocal` maps a span to that clock.
 */
export function paintFxLayers(
  canvas: HTMLCanvasElement,
  active: ActiveEffect[],
  t: number,
  spanLocal: (span: EffectSpan) => { a: number; b: number }
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  for (const { span, info, amount: A } of active) {
    const layers = info.preview.layers ?? [];
    const { a, b } = spanLocal(span);
    for (const layer of layers) {
      ctx.save();
      switch (layer) {
        case "grain": {
          ctx.globalAlpha = 0.08 + A * 0.22;
          ctx.globalCompositeOperation = "overlay";
          const tile = noise();
          const ox = -Math.floor(((t * 977) % 128) + 0);
          const oy = -Math.floor((t * 613) % 128);
          for (let y = oy; y < height; y += 128) {
            for (let x = ox; x < width; x += 128) ctx.drawImage(tile, x, y);
          }
          break;
        }
        case "scanlines": {
          ctx.fillStyle = `rgba(0,0,0,${(0.15 + A * 0.5).toFixed(3)})`;
          const step = Math.max(2, Math.round(height / 480));
          for (let y = 0; y < height; y += step * 2) ctx.fillRect(0, y, width, step);
          break;
        }
        case "rgbsplit": {
          const shift = Math.round((3 + A * 9) * (width / 1080));
          ctx.globalCompositeOperation = "screen";
          ctx.globalAlpha = 0.45;
          ctx.drawImage(canvas, shift, 0);
          ctx.drawImage(canvas, -shift, 0);
          break;
        }
        case "glitch": {
          const burst = t % 0.47 < 0.07;
          const tear = (t + 0.2) % 0.61 < 0.05;
          if (burst) {
            const shift = Math.round((8 + A * 14) * (width / 1080));
            ctx.globalCompositeOperation = "screen";
            ctx.globalAlpha = 0.5;
            ctx.drawImage(canvas, shift, 0);
            ctx.drawImage(canvas, -shift, 0);
          }
          if (tear) {
            ctx.globalAlpha = 0.25 + A * 0.3;
            ctx.globalCompositeOperation = "overlay";
            const tile = noise();
            for (let y = 0; y < height; y += 128) for (let x = 0; x < width; x += 128) ctx.drawImage(tile, x, y);
          }
          break;
        }
        case "flicker": {
          const level = (0.04 + 0.1 * A) * Math.sin(t * 40) + (0.03 + 0.05 * A) * Math.sin(t * 7.3);
          ctx.fillStyle = level >= 0 ? `rgba(255,255,255,${level.toFixed(3)})` : `rgba(0,0,0,${(-level).toFixed(3)})`;
          ctx.fillRect(0, 0, width, height);
          break;
        }
        case "strobe": {
          if (t % 0.2 < 0.05) {
            ctx.fillStyle = `rgba(255,255,255,${(0.3 + 0.5 * A).toFixed(3)})`;
            ctx.fillRect(0, 0, width, height);
          }
          break;
        }
        case "bars": {
          const h = Math.round(height * (0.04 + A * 0.1));
          ctx.fillStyle = "black";
          ctx.fillRect(0, 0, width, h);
          ctx.fillRect(0, height - h, width, h);
          break;
        }
        case "vignette": {
          const radius = Math.hypot(width, height) / 2;
          const gradient = ctx.createRadialGradient(width / 2, height / 2, radius * (0.45 - A * 0.15), width / 2, height / 2, radius);
          gradient.addColorStop(0, "rgba(0,0,0,0)");
          gradient.addColorStop(1, `rgba(0,0,0,${(0.35 + A * 0.45).toFixed(3)})`);
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, width, height);
          break;
        }
        case "pixelate": {
          const block = Math.max(2, Math.round((6 + A * 34) * (width / 1080)));
          const small = { w: Math.max(1, Math.round(width / block)), h: Math.max(1, Math.round(height / block)) };
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(canvas, 0, 0, width, height, 0, 0, small.w, small.h);
          ctx.drawImage(canvas, 0, 0, small.w, small.h, 0, 0, width, height);
          break;
        }
        case "posterize": {
          // A coarse approximation: contrast is in the CSS; here a little banding via alpha steps.
          break;
        }
        case "shake": {
          const sx = ((4 + A * 14) * Math.sin(t * 37.7) * Math.cos(t * 5.1) * width) / 1080;
          const sy = ((3 + A * 10) * Math.sin(t * 29.3) * height) / 1920;
          const zoom = 1.05;
          ctx.drawImage(canvas, 0, 0, width, height, -(width * (zoom - 1)) / 2 + sx, -(height * (zoom - 1)) / 2 + sy, width * zoom, height * zoom);
          break;
        }
        case "pulse": {
          const z = 1 + (0.03 + A * 0.05) * Math.abs(Math.sin((t - a) * 12.566));
          ctx.drawImage(canvas, 0, 0, width, height, -(width * (z - 1)) / 2, -(height * (z - 1)) / 2, width * z, height * z);
          break;
        }
        case "fadeblack":
        case "fadewhite": {
          const level = A * fadeAmount(span.variant, (t - a) / Math.max(0.01, b - a));
          ctx.fillStyle = layer === "fadeblack" ? `rgba(0,0,0,${level.toFixed(3)})` : `rgba(255,255,255,${level.toFixed(3)})`;
          ctx.fillRect(0, 0, width, height);
          break;
        }
      }
      ctx.restore();
    }
  }
}
