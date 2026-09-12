import { Elysia } from "elysia";
import { listCaptionFonts } from "../config/caption-fonts";
import { listCaptionStyles } from "../config/caption-styles";
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
    }))
  );
}

export const captionStyleRoutes = new Elysia({ prefix: "/api/caption-styles" })
  .get("/fonts", listCaptionFontsHandler)
  .get("/", listCaptionStylesHandler);
