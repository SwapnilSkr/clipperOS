import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import type { MediaAsset } from "../types/clip.types";
import { findStockAsset, ingestMediaFile } from "./media-library.service";

// ============================================
// STOCK — Pexels and Pixabay behind one search.
//
// Both are free with a key. Search returns portrait-first candidates with a
// thumbnail; picking one downloads the best portrait file once into the
// media library, with the credit line each provider asks for.
// ============================================

export type StockSource = "pexels" | "pixabay";

export interface StockResult {
  source: StockSource;
  id: string;
  kind: "image" | "video";
  label: string;
  width: number;
  height: number;
  durationSec?: number;
  thumbUrl: string;
  attribution: string;
  sourceUrl: string;
  /** The file to download on pick; not sent to the client. */
  downloadUrl?: string;
}

interface StockProvider {
  source: StockSource;
  enabled: () => boolean;
  search: (query: string, kind: "image" | "video", perPage: number) => Promise<StockResult[]>;
}

const FETCH_TIMEOUT_MS = 12_000;
/** Pexels stills are fetched at this height. */
const PEXELS_IMAGE_PX = 1920;
/** Pixabay's `largeImageURL` long side without full API access. */
const PIXABAY_LARGE_PX = 1280;

/** At most HD either way up: 1080 on the short side, 1920 on the long. */
function fitsHd(file: { width: number; height: number }): boolean {
  return Math.min(file.width, file.height) <= 1080 && Math.max(file.width, file.height) <= 1920;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return (await response.json()) as T;
}

// ---- Pexels ----------------------------------------------------------------

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  alt?: string;
  photographer: string;
  src: { original: string; large2x: string; large: string; medium: string; portrait: string };
}
interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  url: string;
  duration: number;
  image: string;
  user: { name: string };
  video_files: { link: string; width: number; height: number; quality: string; file_type: string }[];
}

const pexels: StockProvider = {
  source: "pexels",
  enabled: () => Boolean(config.pexelsApiKey),
  async search(query, kind, perPage) {
    const headers = { Authorization: config.pexelsApiKey };
    const q = encodeURIComponent(query);
    if (kind === "image") {
      const data = await getJson<{ photos: PexelsPhoto[] }>(
        `https://api.pexels.com/v1/search?query=${q}&orientation=portrait&per_page=${perPage}`,
        headers
      );
      return data.photos.map((photo) => {
        // The original resized on Pexels' CDN to the burn's height: `large2x`
        // tops out near 1300 tall, soft in a 1920 frame; the original is many MB.
        const scale = Math.min(1, PEXELS_IMAGE_PX / photo.height);
        return {
          source: "pexels" as const,
          id: String(photo.id),
          kind: "image" as const,
          label: (photo.alt || query).slice(0, 80),
          width: Math.round(photo.width * scale),
          height: Math.round(photo.height * scale),
          thumbUrl: photo.src.medium,
          attribution: `Photo by ${photo.photographer} on Pexels`,
          sourceUrl: photo.url,
          downloadUrl: `${photo.src.original}?auto=compress&cs=tinysrgb&fit=max&h=${PEXELS_IMAGE_PX}`,
        };
      });
    }
    const data = await getJson<{ videos: PexelsVideo[] }>(
      `https://api.pexels.com/videos/search?query=${q}&orientation=portrait&per_page=${perPage}`,
      headers
    );
    return data.videos.map((video) => {
      // The tallest MP4 at HD or under (either way up): enough for a 9:16 burn,
      // quick to fetch. A landscape clip is cropped to cover, so it wants height.
      const files = video.video_files
        .filter((file) => file.file_type === "video/mp4" && file.width > 0)
        .sort((a, b) => b.height - a.height);
      const best = files.find(fitsHd) ?? files[files.length - 1];
      return {
        source: "pexels" as const,
        id: String(video.id),
        kind: "video" as const,
        label: query.slice(0, 80),
        width: best?.width ?? video.width,
        height: best?.height ?? video.height,
        durationSec: video.duration,
        thumbUrl: video.image,
        attribution: `Video by ${video.user.name} on Pexels`,
        sourceUrl: video.url,
        downloadUrl: best?.link,
      };
    });
  },
};

// ---- Pixabay ---------------------------------------------------------------

interface PixabayImage {
  id: number;
  pageURL: string;
  tags: string;
  user: string;
  imageWidth: number;
  imageHeight: number;
  previewURL: string;
  webformatURL: string;
  largeImageURL: string;
}
interface PixabayVideo {
  id: number;
  pageURL: string;
  tags: string;
  user: string;
  duration: number;
  videos: Record<string, { url: string; width: number; height: number; thumbnail?: string }>;
}

const pixabay: StockProvider = {
  source: "pixabay",
  enabled: () => Boolean(config.pixabayApiKey),
  async search(query, kind, perPage) {
    const key = encodeURIComponent(config.pixabayApiKey);
    const q = encodeURIComponent(query);
    if (kind === "image") {
      const data = await getJson<{ hits: PixabayImage[] }>(
        `https://pixabay.com/api/?key=${key}&q=${q}&image_type=photo&orientation=vertical&per_page=${Math.max(3, perPage)}&safesearch=true`
      );
      return data.hits.map((hit) => {
        // The API serves `largeImageURL` at 1280 on the long side (bigger needs
        // full API access): report the size that is actually downloaded.
        const scale = Math.min(1, PIXABAY_LARGE_PX / Math.max(hit.imageWidth, hit.imageHeight));
        return {
          source: "pixabay" as const,
          id: String(hit.id),
          kind: "image" as const,
          label: (hit.tags || query).slice(0, 80),
          width: Math.round(hit.imageWidth * scale),
          height: Math.round(hit.imageHeight * scale),
          thumbUrl: hit.webformatURL,
          attribution: `Image by ${hit.user} on Pixabay`,
          sourceUrl: hit.pageURL,
          downloadUrl: hit.largeImageURL,
        };
      });
    }
    const data = await getJson<{ hits: PixabayVideo[] }>(
      `https://pixabay.com/api/videos/?key=${key}&q=${q}&per_page=${Math.max(3, perPage)}&safesearch=true`
    );
    return data.hits
      .map((hit): StockResult | undefined => {
        const sizes = Object.values(hit.videos).filter((file) => file.width > 0 && file.url);
        // Portrait files first, then the tallest that fits the burn.
        const portrait = sizes.filter((file) => file.height >= file.width);
        const pool = (portrait.length ? portrait : sizes).sort((a, b) => b.height - a.height);
        const best = pool.find(fitsHd) ?? pool[pool.length - 1];
        if (!best) return undefined;
        return {
          source: "pixabay" as const,
          id: String(hit.id),
          kind: "video" as const,
          label: (hit.tags || query).slice(0, 80),
          width: best.width,
          height: best.height,
          durationSec: hit.duration,
          thumbUrl: best.thumbnail ?? Object.values(hit.videos)[0]?.thumbnail ?? "",
          attribution: `Video by ${hit.user} on Pixabay`,
          sourceUrl: hit.pageURL,
          downloadUrl: best.url,
        };
      })
      .filter((result): result is StockResult => result !== undefined);
  },
};

const PROVIDERS: StockProvider[] = [pexels, pixabay];

/** The providers with a key configured. */
export function stockSources(): StockSource[] {
  return PROVIDERS.filter((provider) => provider.enabled()).map((provider) => provider.source);
}

/** Search every configured provider, interleaved so neither dominates the first row. */
export async function searchStock(query: string, kind: "image" | "video", limit = 24): Promise<StockResult[]> {
  const q = query.trim();
  if (!q) return [];
  const active = PROVIDERS.filter((provider) => provider.enabled());
  if (active.length === 0) throw new Error("No stock provider is configured: set PEXELS_API_KEY or PIXABAY_API_KEY");
  const perProvider = Math.ceil(limit / active.length);
  const batches = await Promise.all(
    active.map((provider) => provider.search(q, kind, perProvider).catch(() => [] as StockResult[]))
  );
  const merged: StockResult[] = [];
  for (let i = 0; merged.length < limit; i++) {
    let any = false;
    for (const batch of batches) {
      const item = batch[i];
      if (item) {
        merged.push(item);
        any = true;
      }
    }
    if (!any) break;
  }
  // Portrait first: a landscape frame is a compromise inside 9:16.
  return merged
    .slice(0, limit)
    .sort((a, b) => Number(b.height >= b.width) - Number(a.height >= a.width));
}

/** Download a search result into the media library (once), and return the asset. */
export async function pickStock(input: {
  source: StockSource;
  id: string;
  kind: "image" | "video";
  query: string;
}): Promise<MediaAsset> {
  const existing = await findStockAsset(input.source, input.id);
  if (existing) return existing;
  const provider = PROVIDERS.find((item) => item.source === input.source);
  if (!provider?.enabled()) throw new Error(`${input.source} is not configured`);
  // The pick only carries the id: re-run the search to get a fresh download URL.
  const results = await provider.search(input.query, input.kind, 40);
  const result = results.find((item) => item.id === input.id);
  if (!result?.downloadUrl) throw new Error("That item is no longer in the results; search again");
  return downloadStock(result, input.query);
}

/**
 * The first portrait result for a query, downloaded into the library: how
 * the Director turns "a server room" into a cutaway. Tries the kind asked
 * for, then the other one. Throws when nothing usable comes back.
 */
export async function stockForQuery(query: string, kind: "image" | "video"): Promise<MediaAsset> {
  for (const tryKind of kind === "video" ? (["video", "image"] as const) : (["image", "video"] as const)) {
    const results = (await searchStock(query, tryKind, 8)).filter((item) => item.downloadUrl);
    // Portrait and sharp enough to fill the frame first, then any portrait, then anything.
    const result =
      results.find((item) => item.height >= item.width && coverScale(item) >= 0.66) ??
      results.find((item) => item.height >= item.width) ??
      results[0];
    if (!result) continue;
    return (await findStockAsset(result.source, result.id)) ?? downloadStock(result, query);
  }
  throw new Error(`No stock found for "${query}"`);
}

/**
 * How sharp the item is once cropped to cover a 1080x1920 frame: 1 at or above
 * the frame's own pixels, 0.5 when it has to be blown up 2×. Cover scales by
 * max(1080/w, 1920/h), so this is min(1, w/1080, h/1920).
 */
export function coverScale(item: { width: number; height: number }): number {
  return Math.min(1, item.width / 1080, item.height / 1920);
}

async function downloadStock(result: StockResult, query: string): Promise<MediaAsset> {
  if (!result.downloadUrl) throw new Error("That item has no downloadable file");
  const tmp = join(config.processingPath, `stock-${crypto.randomUUID()}`);
  try {
    const response = await fetch(result.downloadUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    await Bun.write(tmp, await response.arrayBuffer());
    return await ingestMediaFile({
      sourcePath: tmp,
      originalName: `${result.label || query}.${result.kind === "image" ? "jpg" : "mp4"}`,
      kind: result.kind,
      source: result.source,
      attribution: result.attribution,
      sourceUrl: result.sourceUrl,
      sourceId: result.id,
    });
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** For the client: results without their download URLs. */
export function publicStockResult(result: StockResult): Omit<StockResult, "downloadUrl"> {
  const { downloadUrl: _downloadUrl, ...rest } = result;
  return rest;
}
