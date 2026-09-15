import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { USABLE_RECORDING } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { findAudioBySource, ingestCustomAudio, type AudioAsset } from "./soundtrack.service";
import { senseAudio } from "./sense.service";

// ============================================
// FREESOUND — real recorded sound effects, free.
//
// freesound.org is a community library under Creative Commons. The API's
// text search (token auth, FREESOUND_API_KEY) returns matches with
// streamable previews; the HQ mp3 preview (128 kbps) is what a Short's mix
// (AAC 160k) can carry, and it needs no OAuth, so a pick is the preview
// ingested into the shared audio library like an upload, with its credit.
//
// The catalogue is uneven, so a pick is gated three ways: the search asks
// for rated sounds under a licence a published clip may use (CC0, or
// Attribution with the credit stored), the top results are tried in order,
// and each one the harness listens to must score as a usable recording.
// ============================================

export const FREESOUND_MAX_SEC = 8;
/** How many results a Director query may listen to before giving up. */
const TRY_RESULTS = 3;

export interface FreesoundResult {
  id: string;
  name: string;
  durationSec: number;
  license: string;
  /** "Creative Commons 0" needs no credit; "Attribution" does. */
  needsCredit: boolean;
  username: string;
  url: string;
  previewUrl: string;
  rating: number;
  ratings: number;
  tags: string[];
}

export function freesoundConfigured(): boolean {
  return Boolean(config.freesoundApiKey);
}

function headers(): Record<string, string> {
  if (!config.freesoundApiKey) throw new Error("FREESOUND_API_KEY is not set");
  return { Authorization: `Token ${config.freesoundApiKey}` };
}

/** Sounds a published clip may carry: CC0 outright, Attribution with a credit. */
const LICENSE_FILTER = 'license:("Creative Commons 0" OR "Attribution")';

export async function searchFreesound(query: string, options: { maxSec?: number; pageSize?: number; ratedOnly?: boolean } = {}): Promise<FreesoundResult[]> {
  const maxSec = Math.max(0.2, Math.min(60, options.maxSec ?? FREESOUND_MAX_SEC));
  const filters = [`duration:[0.05 TO ${maxSec}]`, LICENSE_FILTER, ...(options.ratedOnly ? ["avg_rating:[3.5 TO *]", "num_ratings:[2 TO *]"] : [])];
  const params = new URLSearchParams({
    query: query.trim().slice(0, 120),
    filter: filters.join(" "),
    fields: "id,name,tags,username,url,license,previews,avg_rating,num_ratings,duration",
    sort: options.ratedOnly ? "rating_desc" : "score",
    page_size: String(Math.max(1, Math.min(30, options.pageSize ?? 12))),
  });
  const response = await fetch(`https://freesound.org/apiv2/search/text/?${params.toString()}`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Freesound search: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ""}`);
  }
  const data = (await response.json()) as {
    results?: {
      id: number;
      name?: string;
      tags?: string[];
      username?: string;
      url?: string;
      license?: string;
      previews?: Record<string, string>;
      avg_rating?: number;
      num_ratings?: number;
      duration?: number;
    }[];
  };
  return (data.results ?? [])
    .filter((item) => item.previews?.["preview-hq-mp3"] || item.previews?.["preview-lq-mp3"])
    .map((item) => ({
      id: String(item.id),
      name: (item.name ?? "Sound").replace(/\.[a-z0-9]+$/i, "").slice(0, 80),
      durationSec: Number(item.duration ?? 0),
      license: item.license ?? "",
      needsCredit: !/creative commons 0|publicdomain|cc0/i.test(item.license ?? ""),
      username: item.username ?? "",
      url: item.url ?? "",
      previewUrl: item.previews!["preview-hq-mp3"] ?? item.previews!["preview-lq-mp3"]!,
      rating: Number(item.avg_rating ?? 0),
      ratings: Number(item.num_ratings ?? 0),
      tags: (item.tags ?? []).slice(0, 12),
    }));
}

/** Bring one search result into the shared library (once per Freesound id). */
export async function pickFreesound(result: FreesoundResult, kind: "sfx" | "music" = "sfx"): Promise<AudioAsset> {
  const existing = await findAudioBySource("freesound", result.id);
  if (existing) return existing;
  const tmp = join(config.processingPath, `freesound-${result.id}-${Date.now()}.mp3`);
  try {
    const response = await fetch(result.previewUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Could not download the sound (HTTP ${response.status})`);
    await Bun.write(tmp, await response.arrayBuffer());
    return await ingestCustomAudio("none", kind, tmp, `${result.name}.mp3`, {
      source: "freesound",
      sourceId: result.id,
      sourceUrl: result.url,
      attribution: result.needsCredit ? `"${result.name}" by ${result.username} (freesound.org, ${result.license})` : `"${result.name}" by ${result.username} (freesound.org, CC0)`,
    });
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * The Director's path: the best rated match the harness judges clean.
 * Rated results first; each candidate is picked, listened to, and kept
 * only if it scores as a usable recording — otherwise the next is tried.
 */
export async function sfxForQuery(query: string, options: { maxSec?: number } = {}): Promise<AudioAsset> {
  const rated = await searchFreesound(query, { maxSec: options.maxSec ?? 4, ratedOnly: true, pageSize: TRY_RESULTS });
  const any = rated.length >= TRY_RESULTS ? [] : await searchFreesound(query, { maxSec: options.maxSec ?? 4, pageSize: TRY_RESULTS });
  const candidates = [...rated, ...any.filter((item) => !rated.some((known) => known.id === item.id))].slice(0, TRY_RESULTS);
  if (candidates.length === 0) throw new Error(`Freesound has nothing usable for "${query}"`);
  const reasons: string[] = [];
  for (const candidate of candidates) {
    try {
      const asset = await pickFreesound(candidate);
      const sense = asset.sense ?? (await senseAudio(asset));
      if (sense) asset.sense = sense;
      if (!sense || sense.quality === undefined || sense.quality >= USABLE_RECORDING) return asset;
      reasons.push(`${candidate.name}: ${sense.flaws?.join(", ") || `quality ${sense.quality}/5`}`);
    } catch (error: unknown) {
      reasons.push(`${candidate.name}: ${getErrorMessage(error)}`);
    }
  }
  throw new Error(`no clean recording for "${query}" (${reasons.join("; ")})`);
}
