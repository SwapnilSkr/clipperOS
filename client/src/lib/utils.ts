import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has to be told about our type scale.
 *
 * `text-*` is ambiguous in Tailwind: it is both the font-size namespace and the
 * text-colour namespace. tailwind-merge only knows the default sizes, so it read
 * `text-ui` / `text-meta` / `text-body` as *colours* and silently deleted them
 * whenever a real colour followed in the same call:
 *
 *   cn("text-ui ...", active ? "bg-accent text-white" : "text-muted")
 *   →  "... font-medium bg-accent text-white"     // text-ui dropped, 16px
 *
 * The result was buttons and status labels rendering at the browser default 16px
 * while the CSS looked correct. Declaring the scale here keeps conf('font-size')
 * and conf('text-color') distinct, which is what makes cn() safe for custom sizes.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "micro",
            "meta",
            "ui",
            "body",
            "lead",
            "title",
            "head",
            "score-sm",
            "score",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** `754.2` -> `12:34`. */
export function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** `92` -> `1:32`. */
export function duration(seconds: number): string {
  return timecode(seconds);
}

/** `1536000` -> `1.5 MB`. For storage that a user is deciding to reclaim. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

export function elapsedLabel(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Strong ≥ 7, Promising ≥ 5, otherwise Risky. */
export function scoreBand(score: number): "strong" | "promising" | "risky" {
  if (score >= 7) return "strong";
  if (score >= 5) return "promising";
  return "risky";
}

export const BAND_STYLES: Record<ReturnType<typeof scoreBand>, string> = {
  strong: "bg-accent/15 text-accent border-accent/40",
  promising: "bg-warn/15 text-warn border-warn/40",
  risky: "bg-bad/15 text-bad border-bad/40",
};

/** Colour the score itself so a "Strong" badge is unnecessary. */
export const SCORE_TONE: Record<ReturnType<typeof scoreBand>, string> = {
  strong: "text-accent",
  promising: "text-warn",
  risky: "text-bad",
};

export const BAND_LABEL: Record<ReturnType<typeof scoreBand>, string> = {
  strong: "Strong",
  promising: "Promising",
  risky: "Risky",
};
