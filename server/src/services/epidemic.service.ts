import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { USABLE_RECORDING } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { findAudioBySource, ingestCustomAudio, type AudioAsset } from "./soundtrack.service";
import { senseAudio } from "./sense.service";

// ============================================
// EPIDEMIC SOUND — the licensed library: 250k sound effects, 55k tracks.
//
// The Partner Content API (partner-content-api.epidemicsound.com, spec at
// /docs/spec.json) takes the partner key as a Bearer token for server-to-
// server use. Search returns ids and titles; a download call returns a
// signed MP3 URL (128 kbps normal, 320 kbps high) that expires, so a pick
// is downloaded at once into the shared audio library with its credit,
// keyed by the Epidemic id so it is fetched once. Usage is reported when a
// clip that carries Epidemic audio is exported (`reportEpidemicUsage`), as
// the API asks.
// ============================================

const BASE = "https://partner-content-api.epidemicsound.com/v0";

export interface EpidemicSfx {
  source: "epidemic";
  kind: "sfx";
  id: string;
  title: string;
  lengthSec: number;
}

export interface EpidemicTrack {
  source: "epidemic";
  kind: "music";
  id: string;
  title: string;
  artists: string[];
  bpm?: number;
  lengthSec: number;
  moods: string[];
  genres: string[];
  hasVocals: boolean;
  /** The partner tier only previews this one; a download may not be licensed. */
  previewOnly: boolean;
}

export function epidemicConfigured(): boolean {
  return Boolean(config.epidemicApiKey);
}

function headers(): Record<string, string> {
  if (!config.epidemicApiKey) throw new Error("EPIDEMIC_SOUND_API_KEY is not set");
  return { Authorization: `Bearer ${config.epidemicApiKey}`, "Content-Type": "application/json" };
}

async function get<T>(path: string, params: Record<string, string | number | undefined>, label: string): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
  const response = await fetch(`${BASE}${path}?${query.toString()}`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label}: HTTP ${response.status}${body ? ` — ${body.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  }
  return (await response.json()) as T;
}

export async function searchEpidemicSfx(term: string, options: { limit?: number } = {}): Promise<EpidemicSfx[]> {
  const data = await get<{ soundEffects?: { id: string; title?: string; length?: number }[] }>(
    "/sound-effects/search",
    { term: term.trim().slice(0, 120), limit: Math.max(1, Math.min(60, options.limit ?? 15)), sort: "best-match" },
    "Epidemic Sound SFX search"
  );
  return (data.soundEffects ?? []).map((item) => ({ source: "epidemic", kind: "sfx", id: item.id, title: (item.title ?? "Sound effect").slice(0, 120), lengthSec: Number(item.length ?? 0) }));
}

export async function searchEpidemicTracks(
  term: string,
  options: { limit?: number; bpmMin?: number; bpmMax?: number; instrumental?: boolean } = {}
): Promise<EpidemicTrack[]> {
  const data = await get<{
    tracks?: {
      id: string;
      title?: string;
      mainArtists?: string[];
      bpm?: number;
      length?: number;
      moods?: { name?: string }[];
      genres?: { name?: string }[];
      hasVocals?: boolean;
      isPreviewOnly?: boolean;
    }[];
  }>(
    "/tracks/search",
    {
      term: term.trim().slice(0, 120),
      limit: Math.max(1, Math.min(60, options.limit ?? 15)),
      bpmMin: options.bpmMin,
      bpmMax: options.bpmMax,
      vocalType: options.instrumental ? "NONE" : undefined,
      sort: "Relevance",
    },
    "Epidemic Sound track search"
  );
  return (data.tracks ?? []).map((item) => ({
    source: "epidemic",
    kind: "music",
    id: item.id,
    title: (item.title ?? "Track").slice(0, 120),
    artists: (item.mainArtists ?? []).slice(0, 3),
    ...(item.bpm ? { bpm: Number(item.bpm) } : {}),
    lengthSec: Number(item.length ?? 0),
    moods: (item.moods ?? []).map((mood) => mood.name ?? "").filter(Boolean).slice(0, 4),
    genres: (item.genres ?? []).map((genre) => genre.name ?? "").filter(Boolean).slice(0, 3),
    hasVocals: Boolean(item.hasVocals),
    previewOnly: Boolean(item.isPreviewOnly),
  }));
}

/** A signed MP3 URL for a sound or a track (normal quality expires in 24 h). */
export async function epidemicDownloadUrl(kind: "sfx" | "music", id: string, quality: "normal" | "high" = "normal"): Promise<{ url: string; expires: string }> {
  return get<{ url: string; expires: string }>(`/${kind === "sfx" ? "sound-effects" : "tracks"}/${encodeURIComponent(id)}/download`, { format: "mp3", quality }, "Epidemic Sound download");
}

/** Bring one search result into the shared library (once per Epidemic id). */
export async function pickEpidemic(item: EpidemicSfx | EpidemicTrack): Promise<AudioAsset> {
  const existing = await findAudioBySource("epidemic", item.id);
  if (existing) return existing;
  // High quality for a bed that runs under the whole clip; normal is plenty for a hit.
  const { url } = await epidemicDownloadUrl(item.kind, item.id, item.kind === "music" ? "high" : "normal");
  const tmp = join(config.processingPath, `epidemic-${item.id}-${Date.now()}.mp3`);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Could not download from Epidemic Sound (HTTP ${response.status})`);
    await Bun.write(tmp, await response.arrayBuffer());
    const credit = item.kind === "music" ? `"${item.title}" by ${(item as EpidemicTrack).artists.join(", ") || "Epidemic Sound"} (Epidemic Sound)` : `"${item.title}" (Epidemic Sound)`;
    return await ingestCustomAudio("none", item.kind, tmp, `${item.title}.mp3`, {
      source: "epidemic",
      sourceId: item.id,
      attribution: credit,
      sourceUrl: `https://www.epidemicsound.com/${item.kind === "music" ? "track" : "sound-effects/track"}/${item.id}/`,
    });
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** The Director's path for a hit: the best matches, listened to, the first clean one kept. */
export async function epidemicSfxForQuery(query: string, options: { maxSec?: number } = {}): Promise<AudioAsset> {
  const results = (await searchEpidemicSfx(query, { limit: 8 })).filter((item) => item.lengthSec <= (options.maxSec ?? 6)).slice(0, 3);
  if (results.length === 0) throw new Error(`Epidemic Sound has nothing short enough for "${query}"`);
  const reasons: string[] = [];
  for (const result of results) {
    try {
      const asset = await pickEpidemic(result);
      const sense = asset.sense ?? (await senseAudio(asset));
      if (!sense || sense.quality === undefined || sense.quality >= USABLE_RECORDING) return asset;
      reasons.push(`${result.title}: ${sense.flaws?.join(", ") || `quality ${sense.quality}/5`}`);
    } catch (error: unknown) {
      reasons.push(`${result.title}: ${getErrorMessage(error)}`);
    }
  }
  throw new Error(`no clean sound for "${query}" (${reasons.join("; ")})`);
}

/** The Director's path for a bed: the first instrumental match the partner tier may download. */
export async function epidemicTrackForQuery(query: string, options: { bpmMin?: number; bpmMax?: number } = {}): Promise<AudioAsset> {
  const results = await searchEpidemicTracks(query, { limit: 10, instrumental: true, bpmMin: options.bpmMin, bpmMax: options.bpmMax });
  const usable = results.filter((track) => !track.previewOnly);
  const candidates = (usable.length ? usable : results).slice(0, 3);
  if (candidates.length === 0) throw new Error(`Epidemic Sound has no track for "${query}"`);
  const reasons: string[] = [];
  for (const track of candidates) {
    try {
      const asset = await pickEpidemic(track);
      void senseAudio(asset).catch(() => undefined);
      return asset;
    } catch (error: unknown) {
      reasons.push(`${track.title}: ${getErrorMessage(error)}`);
    }
  }
  throw new Error(`no track for "${query}" (${reasons.join("; ")})`);
}

/** Tell Epidemic Sound which of its tracks and sounds a clip was exported with. */
export async function reportEpidemicUsage(trackIds: string[], platform: "LOCAL" | "YOUTUBE" | "OTHER" = "LOCAL"): Promise<void> {
  const ids = [...new Set(trackIds)].filter(Boolean);
  if (ids.length === 0 || !epidemicConfigured()) return;
  const response = await fetch(`${BASE}/usage`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ eventType: "EXPORTED", platform, trackIds: ids }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Epidemic Sound usage report: HTTP ${response.status}`);
}
