import type { CaptionFontInfo } from "@/api";

// ============================================================
// CAPTION FONT FACES — the burn's font files, loaded into the page.
//
// libass burns with the files in server/assets/caption-fonts. Without them
// the browser falls back down the CSS stack (Anton → Impact), and every
// caption and Text preview is drawn wider and taller than it renders. Each
// bundled face is registered under its family with its real weight — the
// weight the catalogue asks for — so neither side synthesises bold: the burn
// asks libass for Bold only on faces that have a bold weight.
// ============================================================

const registered = new Map<string, Promise<void>>();

/** The weight a bundled file carries, from its name (`Anton-Regular` → 400). */
function fileWeight(url: string): number {
  const name = url.split("/").pop()?.toLowerCase() ?? "";
  if (name.includes("extrabold")) return 800;
  if (name.includes("semibold")) return 600;
  if (name.includes("bold")) return 700;
  return 400;
}

/** Register every bundled caption face once; resolves when they have loaded (or failed quietly). */
export function loadCaptionFontFaces(fonts: CaptionFontInfo[]): Promise<void> {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return Promise.resolve();
  const jobs = fonts
    .filter((font) => font.fileUrl)
    .map((font) => {
      const existing = registered.get(font.family);
      if (existing) return existing;
      const url = font.fileUrl!;
      const job = new FontFace(font.family, `url(${url})`, { weight: String(fileWeight(url)) })
        .load()
        .then((face) => {
          document.fonts.add(face);
        })
        .catch(() => {
          // A face that fails to load leaves the stack's fallback: the preview still paints.
          registered.delete(font.family);
        });
      registered.set(font.family, job);
      return job;
    });
  return Promise.all(jobs).then(() => undefined);
}
