import { Elysia, t } from "elysia";
import { join } from "node:path";
import { captionFontFile, captionFontMetrics, captionFontsDir, listCaptionFonts } from "../config/caption-fonts";
import { listCaptionStyles } from "../config/caption-styles";
import type { ApiContext } from "../types/api.types";
import { ok } from "../utils/response.utils";

/**
 * The available caption looks. Static, like /api/genres — the editor fetches
 * this so it never hardcodes a preset id, a label or a default.
 */
export function listCaptionStylesHandler() {
  return ok(
    listCaptionStyles().map((style) => ({
      id: style.id,
      label: style.label,
      summary: style.summary,
      chunkWords: style.chunkWords,
      sizeScale: style.sizeScale,
      verticalFrac: style.verticalFrac,
      horizontalFrac: style.horizontalFrac,
      textColor: style.textColor,
      background: style.background,
      animation: style.animation,
      peakColor: style.peakColor,
      fontFamily: style.fontFamily,
      uppercase: style.uppercase,
    }))
  );
}

export function listCaptionFontsHandler() {
  return ok(
    listCaptionFonts().map((font) => ({
      id: font.id,
      label: font.label,
      family: font.family,
      stack: font.stack,
      weight: font.weight,
      // The bundled face, for the preview to load: the burn's exact glyphs.
      ...(captionFontFile(font.family) ? { fileUrl: `/api/caption-styles/fonts/file/${captionFontFile(font.family)}` } : {}),
      // The preview's size correction for this face (see captionFontEmScale).
      ...(captionFontMetrics(font.family) ?? {}),
    }))
  );
}

/** GET /api/caption-styles/fonts/file/:name — a bundled caption face, by its listed file name only. */
function streamCaptionFont({ params, set }: ApiContext) {
  const dir = captionFontsDir();
  // Only names the listing hands out: never a path built from the request.
  const known = dir ? listCaptionFonts().map((font) => captionFontFile(font.family)).filter(Boolean) : [];
  if (!dir || !known.includes(params.name)) {
    set.status = 404;
    return "Font not found";
  }
  set.headers["content-type"] = params.name.endsWith(".otf") ? "font/otf" : params.name.endsWith(".woff2") ? "font/woff2" : "font/ttf";
  set.headers["cache-control"] = "public, max-age=604800";
  return Bun.file(join(dir, params.name));
}

export const captionStyleRoutes = new Elysia({ prefix: "/api/caption-styles" })
  .get("/fonts", listCaptionFontsHandler)
  .get("/fonts/file/:name", streamCaptionFont, { params: t.Object({ name: t.String({ maxLength: 80, pattern: "^[A-Za-z0-9._-]+$" }) }) })
  .get("/", listCaptionStylesHandler);
