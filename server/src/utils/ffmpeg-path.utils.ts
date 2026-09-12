import { resolve } from "node:path";

import { captionFontsDir } from "../config/caption-fonts";

/**
 * Escape a filesystem path for use inside an ffmpeg filtergraph option value
 * (e.g. `ass='…'`). Windows drive letters and backslashes must be escaped or
 * the filter parser treats `C:` as a protocol separator and the rest of the
 * path — plus any following filters — becomes a bogus output path.
 */
export function escapeFilterPath(p: string): string {
  return resolve(p)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Build an `ass=` video-filter fragment for a subtitle file. */
export function assVideoFilter(assPath: string, extras?: string): string {
  const fontsDir = captionFontsDir();
  const fonts = fontsDir ? `:fontsdir='${escapeFilterPath(fontsDir)}'` : "";
  const base = `ass='${escapeFilterPath(assPath)}'${fonts}`;
  return extras ? `${base},${extras}` : base;
}
