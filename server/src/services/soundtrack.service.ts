import { existsSync, readFileSync } from "node:fs";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";
import type { AssetSense, MusicBed, Soundtrack, SoundtrackHit } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { containedPath, ensureDir, fileExists, getFileSize, projectAudioDir } from "../utils/file.utils";
import { runCommand } from "../utils/process.utils";
import { getVideoMetadata, hasAudioStream } from "./ffmpeg.service";

export const MAX_SOUNDTRACK_HITS = 32;
export const MAX_MUSIC_BEDS = 8;
export const DEFAULT_BED_GAIN = 0.22;
export const DEFAULT_BED_DIP = 0.6;
/**
 * What is left of a bed under speech at dip 1: the sidechain compressor
 * below drives the wet path this far down on speech at a normal level and
 * `mix=dip` blends it with the dry bed, so under speech the bed sits at
 * `1 - (1 - DIP_FLOOR) * dip`. The live preview (client live-soundtrack)
 * dips by the same rule.
 */
export const DIP_FLOOR = 0.08;
/** The compressor's ballistics, in ms — the preview's envelope uses the same. */
export const DIP_ATTACK_MS = 30;
export const DIP_RELEASE_MS = 280;
export const MAX_CUSTOM_AUDIO = 24;
export const MAX_CUSTOM_AUDIO_BYTES = 8 * 1024 * 1024;
export const SHARED_AUDIO_OWNER = "shared";

export type AudioKind = "music" | "sfx";

export interface AudioAsset {
  id: string;
  kind: AudioKind;
  label: string;
  /** How long the file actually is. Music loops to the clip. */
  durationSec: number;
  /** Uploads are "upload"; the studio's are "ai" with their prompt; Freesound picks carry their credit. Built-ins carry neither. */
  source?: "upload" | "ai" | "freesound";
  prompt?: string;
  /** Credit line the licence asks for (CC-BY), and the sound's page. */
  attribution?: string;
  sourceUrl?: string;
  sourceId?: string;
  /** What it sounds like, as the harness heard it (sense.service). */
  sense?: AssetSense;
}

const LIBRARY_DIR = resolve(import.meta.dir, "../../assets/audio");

const BUILTIN: AudioAsset[] = [
  { id: "warm", kind: "music", label: "Warm pad", durationSec: 16 },
  { id: "pulse", kind: "music", label: "Pulse", durationSec: 16 },
  { id: "night", kind: "music", label: "Night", durationSec: 16 },
  { id: "drive", kind: "music", label: "Drive", durationSec: 16 },
  { id: "whoosh", kind: "sfx", label: "Whoosh", durationSec: 0.55 },
  { id: "hit", kind: "sfx", label: "Hit", durationSec: 0.22 },
  { id: "pop", kind: "sfx", label: "Pop", durationSec: 0.09 },
  { id: "rise", kind: "sfx", label: "Rise", durationSec: 1.1 },
  { id: "click", kind: "sfx", label: "Click", durationSec: 0.04 },
  { id: "swoosh", kind: "sfx", label: "Swoosh (soft)", durationSec: 0.7 },
  { id: "riser", kind: "sfx", label: "Riser", durationSec: 0.65 },
  { id: "boom", kind: "sfx", label: "Boom (sub)", durationSec: 0.9 },
  { id: "thud", kind: "sfx", label: "Thud", durationSec: 0.3 },
  { id: "shutter", kind: "sfx", label: "Shutter", durationSec: 0.16 },
  { id: "ding", kind: "sfx", label: "Ding", durationSec: 0.9 },
  { id: "tick", kind: "sfx", label: "Tick", durationSec: 0.06 },
];

const BUILTIN_IDS = new Set(BUILTIN.map((asset) => asset.id));

export function listBuiltinAudio(): AudioAsset[] {
  return BUILTIN.filter((asset) => existsSync(join(LIBRARY_DIR, `${asset.id}.m4a`))).map((asset) => {
    const path = builtinSensePath(asset.id);
    if (!existsSync(path)) return { ...asset };
    try {
      return { ...asset, sense: JSON.parse(readFileSync(path, "utf-8")) as AssetSense };
    } catch {
      return { ...asset };
    }
  });
}

export function builtinAudioPath(id: string): string | undefined {
  if (!BUILTIN_IDS.has(id)) return undefined;
  const path = join(LIBRARY_DIR, `${id}.m4a`);
  return existsSync(path) ? path : undefined;
}

export function isCustomAssetId(id: string): boolean {
  return id.startsWith("custom:");
}

export function customAssetFileId(id: string): string | undefined {
  const rest = id.slice("custom:".length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rest)) return undefined;
  return rest;
}

export function sharedAudioDir(): string {
  return join(config.audioPath, SHARED_AUDIO_OWNER);
}

export async function resolveCustomAudioFile(
  fileId: string,
  hintProjectId?: string
): Promise<string | undefined> {
  if (!customAssetFileId(`custom:${fileId}`)) return undefined;
  const shared = containedPath(sharedAudioDir(), `${fileId}.m4a`);
  if (await fileExists(shared)) return shared;
  if (hintProjectId) {
    const local = containedPath(projectAudioDir(hintProjectId), `${fileId}.m4a`);
    if (await fileExists(local)) return local;
  }
  return undefined;
}

export async function resolveAssetPath(projectId: string, assetId: string): Promise<string | undefined> {
  const builtin = builtinAudioPath(assetId);
  if (builtin) return builtin;
  const fileId = customAssetFileId(assetId);
  if (!fileId) return undefined;
  return resolveCustomAudioFile(fileId, projectId);
}

interface CustomMeta {
  id: string;
  kind: AudioKind;
  name: string;
  durationSec: number;
  source?: "upload" | "ai" | "freesound";
  prompt?: string;
  attribution?: string;
  sourceUrl?: string;
  /** The provider's own id, so a Freesound pick is downloaded once. */
  sourceId?: string;
  sense?: AssetSense;
}

/** The library track that came from this provider item, if it was picked before. */
export async function findAudioBySource(source: "freesound", sourceId: string): Promise<AudioAsset | undefined> {
  return (await listCustomAudio()).find((asset) => asset.source === source && asset.sourceId === sourceId);
}

/** Built-ins have no sidecar of their own; their descriptions live here. */
function builtinSensePath(id: string): string {
  return join(config.audioPath, "sense", `${id}.json`);
}

async function builtinSense(id: string): Promise<AssetSense | undefined> {
  const raw = await readFile(builtinSensePath(id), "utf-8").catch(() => "");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AssetSense;
  } catch {
    return undefined;
  }
}

/** Store what the harness heard in a sound (built-in or custom). */
export async function updateAudioSense(assetId: string, sense: AssetSense): Promise<void> {
  const fileId = customAssetFileId(assetId);
  if (!fileId) {
    if (!BUILTIN_IDS.has(assetId)) throw new Error("Unknown audio file");
    await ensureDir(join(config.audioPath, "sense"));
    await writeFile(builtinSensePath(assetId), JSON.stringify(sense, null, 2));
    return;
  }
  await loadSharedAudioLibrary();
  const path = join(sharedAudioDir(), `${fileId}.json`);
  const raw = await readFile(path, "utf-8").catch(() => "");
  if (!raw) throw new Error("Unknown audio file");
  const meta = JSON.parse(raw) as CustomMeta;
  meta.sense = sense;
  await writeFile(path, JSON.stringify(meta, null, 2));
}

async function listAudioInDir(dir: string): Promise<AudioAsset[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: AudioAsset[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(join(dir, name), "utf-8").catch(() => "");
    try {
      const meta = JSON.parse(raw) as CustomMeta;
      if (!meta?.id || (meta.kind !== "music" && meta.kind !== "sfx")) continue;
      const fileId = customAssetFileId(meta.id);
      if (!fileId) continue;
      const file = join(dir, `${fileId}.m4a`);
      if (!(await fileExists(file))) continue;
      out.push({
        id: meta.id,
        kind: meta.kind,
        label: String(meta.name || "Upload").slice(0, 80),
        durationSec: Number(meta.durationSec) || 0,
        source: meta.source === "ai" || meta.source === "freesound" ? meta.source : "upload",
        ...(meta.prompt ? { prompt: meta.prompt } : {}),
        ...(meta.attribution ? { attribution: meta.attribution } : {}),
        ...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
        ...(meta.sourceId ? { sourceId: meta.sourceId } : {}),
        ...(meta.sense ? { sense: meta.sense } : {}),
      });
    } catch {
      // Skip a corrupt sidecar.
    }
  }
  return out;
}

export async function promoteProjectAudioToShared(projectId: string): Promise<number> {
  const src = projectAudioDir(projectId);
  const dest = sharedAudioDir();
  await ensureDir(dest);
  const names = await readdir(src).catch(() => [] as string[]);
  let copied = 0;
  for (const name of names) {
    if (!name.endsWith(".m4a") && !name.endsWith(".json")) continue;
    const from = join(src, name);
    const to = join(dest, name);
    if ((await fileExists(from)) && !(await fileExists(to))) {
      await cp(from, to).catch(() => undefined);
      copied += 1;
    }
  }
  return copied;
}

let audioHydrated = false;
let audioHydrate: Promise<void> | null = null;

export async function loadSharedAudioLibrary(force = false): Promise<void> {
  if (audioHydrated && !force) return;
  if (audioHydrate && !force) return audioHydrate;
  audioHydrate = hydrateSharedAudioLibrary().finally(() => {
    audioHydrate = null;
  });
  return audioHydrate;
}

async function hydrateSharedAudioLibrary(): Promise<void> {
  const dest = sharedAudioDir();
  await ensureDir(dest);
  const flag = join(dest, ".imported");
  if (await fileExists(flag)) {
    audioHydrated = true;
    return;
  }
  const entries = await readdir(config.audioPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === SHARED_AUDIO_OWNER) continue;
    if (!/^[0-9a-f]{24}$/.test(entry.name)) continue;
    await promoteProjectAudioToShared(entry.name);
  }
  await writeFile(flag, new Date().toISOString());
  audioHydrated = true;
}

export async function listCustomAudio(_projectId?: string): Promise<AudioAsset[]> {
  await loadSharedAudioLibrary();
  return listAudioInDir(sharedAudioDir());
}

export async function ingestCustomAudio(
  _projectId: string,
  kind: AudioKind,
  sourcePath: string,
  originalName: string,
  origin: { source: "upload" | "ai" | "freesound"; prompt?: string; model?: string; attribution?: string; sourceUrl?: string; sourceId?: string } = { source: "upload" }
): Promise<AudioAsset> {
  await loadSharedAudioLibrary();
  const existing = await listAudioInDir(sharedAudioDir());
  if (existing.length >= MAX_CUSTOM_AUDIO) {
    throw new Error(`The audio library can hold ${MAX_CUSTOM_AUDIO} uploads`);
  }
  const size = await getFileSize(sourcePath);
  if (size > MAX_CUSTOM_AUDIO_BYTES) {
    throw new Error("Audio file is too large (8 MB max)");
  }

  const dir = sharedAudioDir();
  await ensureDir(dir);
  const fileId = crypto.randomUUID();
  const dest = join(dir, `${fileId}.m4a`);
  try {
    await runCommand(
      config.ffmpegPath,
      ["-y", "-hide_banner", "-loglevel", "error", "-i", sourcePath, "-vn", "-c:a", "aac", "-b:a", "128k", dest],
      { label: "audio ingest" }
    );
  } catch (error: unknown) {
    await rm(dest, { force: true }).catch(() => undefined);
    throw error;
  }
  const meta = await getVideoMetadata(dest).catch(() => null);
  const durationSec = meta?.durationSec && meta.durationSec > 0 ? meta.durationSec : 1;
  const asset: AudioAsset = {
    id: `custom:${fileId}`,
    kind,
    label: originalName.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "Upload",
    durationSec,
    source: origin.source,
    ...(origin.prompt ? { prompt: origin.prompt } : {}),
    ...(origin.attribution ? { attribution: origin.attribution } : {}),
    ...(origin.sourceUrl ? { sourceUrl: origin.sourceUrl } : {}),
    ...(origin.sourceId ? { sourceId: origin.sourceId } : {}),
  };
  await writeFile(
    join(dir, `${fileId}.json`),
    JSON.stringify(
      {
        id: asset.id,
        kind,
        name: asset.label,
        durationSec,
        source: origin.source,
        ...(origin.prompt ? { prompt: origin.prompt } : {}),
        ...(origin.model ? { model: origin.model } : {}),
        ...(origin.attribution ? { attribution: origin.attribution } : {}),
        ...(origin.sourceUrl ? { sourceUrl: origin.sourceUrl } : {}),
        ...(origin.sourceId ? { sourceId: origin.sourceId } : {}),
      },
      null,
      2
    )
  );
  return asset;
}

export async function deleteCustomAudio(projectId: string, assetId: string): Promise<void> {
  const fileId = customAssetFileId(assetId);
  if (!fileId) throw new Error("Unknown audio file");
  const dirs = [sharedAudioDir(), projectAudioDir(projectId)];
  await Promise.all(
    dirs.flatMap((dir) => [
      rm(join(dir, `${fileId}.m4a`), { force: true }),
      rm(join(dir, `${fileId}.json`), { force: true }),
    ])
  );
}

/** The clip's music beds: `beds`, or the single `music` bed clips carried before it. */
export function musicBeds(track: Soundtrack | undefined): MusicBed[] {
  if (!track) return [];
  if (track.beds) return track.beds.filter((bed) => bed.assetId);
  const legacy = track.music;
  if (!legacy?.assetId) return [];
  return [
    {
      id: "bed-1",
      assetId: legacy.assetId,
      ...(legacy.gain !== undefined ? { gain: legacy.gain } : {}),
      ...(legacy.duck === false ? { dip: 0 } : {}),
      ...(legacy.carryIntoOutro !== undefined ? { carryIntoOutro: legacy.carryIntoOutro } : {}),
    },
  ];
}

export function soundtrackNeedsMix(track: Soundtrack | undefined): boolean {
  if (!track) return false;
  if (track.voiceGain != null && Math.abs(track.voiceGain - 1) > 0.001) return true;
  if (musicBeds(track).length > 0) return true;
  return (track.sfx ?? []).length > 0;
}

/** Where a bed stops on the output clock: its own out point, else the clip's end, or the sting's when it carries in. */
export function bedOutSec(bed: MusicBed, clipDurationSec: number, outroSec: number): number {
  const carries = outroSec > 0 && bed.carryIntoOutro !== false;
  const end = carries ? clipDurationSec + outroSec : clipDurationSec;
  return bed.outSec != null ? Math.min(bed.outSec, end) : end;
}

/** Music or hits that should be mixed after the sting is joined. */
export function soundtrackSpansOutro(track: Soundtrack | undefined, clipDurationSec: number): boolean {
  if (!track) return false;
  if (musicBeds(track).some((bed) => bedOutSec(bed, clipDurationSec, 1) > clipDurationSec + 0.02)) return true;
  return (track.sfx ?? []).some((hit) => (hit.atSec ?? 0) > clipDurationSec - 0.02);
}

/** A bed's fade, explicit or a sixth of its span (at most 1.2 s), never longer than half the span. */
export function bedFadeSec(explicit: number | undefined, spanSec: number): number {
  const fade = explicit != null ? explicit : Math.min(1.2, spanSec / 6);
  return Math.max(0, Math.min(fade, spanSec / 2));
}

export interface GraphBed {
  index: number;
  gain: number;
  /** Output-clock span the bed plays for. */
  inSec: number;
  outSec: number;
  offsetSec: number;
  /** Omitted = the automatic fade (`bedFadeSec`). */
  fadeInSec?: number;
  fadeOutSec?: number;
  /** 0 = never ducked. */
  dip: number;
}

export function buildSoundtrackGraph(input: {
  durationSec: number;
  voiceGain: number;
  voiceHasAudio: boolean;
  beds: GraphBed[];
  hits: { index: number; atSec: number; gain: number }[];
  /** Apply voiceGain only up to this time; later audio (the sting) stays at unity. */
  voiceUntilSec?: number;
}): string {
  const duration = Math.max(0.05, input.durationSec);
  const graph: string[] = [];
  const mixParts: string[] = [];
  const beds = input.beds.filter((bed) => bed.outSec - bed.inSec > 0.05 && bed.inSec < duration - 0.02);
  const duckedBeds = input.voiceHasAudio && input.voiceGain > 0.05 ? beds.filter((bed) => bed.dip > 0.001) : [];
  const voiceUntil = input.voiceUntilSec;
  const splitVoice =
    input.voiceHasAudio &&
    voiceUntil != null &&
    voiceUntil < duration - 0.05 &&
    Math.abs(input.voiceGain - 1) > 0.001;

  if (input.voiceHasAudio) {
    if (splitVoice) {
      const cut = Math.max(0.05, voiceUntil!);
      graph.push(`[0:a]asplit=2[pre][postsrc]`);
      graph.push(
        `[pre]atrim=0:${cut.toFixed(3)},asetpts=PTS-STARTPTS,volume=${input.voiceGain.toFixed(3)}[v1]`
      );
      graph.push(`[postsrc]atrim=${cut.toFixed(3)}:${duration.toFixed(3)},asetpts=PTS-STARTPTS[v2]`);
      graph.push(`[v1][v2]concat=n=2:v=0:a=1,apad=whole_dur=${duration.toFixed(3)}[voicefull]`);
    } else {
      graph.push(
        `[0:a]volume=${input.voiceGain.toFixed(3)},apad=whole_dur=${duration.toFixed(3)}[voicefull]`
      );
    }
    // One key copy per ducked bed: a filter output feeds one input.
    const keys = duckedBeds.map((_, i) => `[voicekey${i}]`).join("");
    graph.push(
      duckedBeds.length > 0 ? `[voicefull]asplit=${duckedBeds.length + 1}[voice]${keys}` : `[voicefull]anull[voice]`
    );
    mixParts.push("[voice]");
  }

  beds.forEach((bed, i) => {
    const inSec = Math.max(0, bed.inSec);
    const outSec = Math.min(duration, bed.outSec);
    const span = outSec - inSec;
    const fadeIn = bedFadeSec(bed.fadeInSec, span);
    const fadeOut = bedFadeSec(bed.fadeOutSec, span);
    const offset = Math.max(0, bed.offsetSec);
    // The file loops (its input is -stream_loop -1), so the offset can pass its end.
    const chain = [
      `atrim=${offset.toFixed(3)}:${(offset + span).toFixed(3)}`,
      `asetpts=PTS-STARTPTS`,
      fadeIn > 0.005 ? `afade=t=in:d=${fadeIn.toFixed(3)}` : "",
      fadeOut > 0.005 ? `afade=t=out:st=${Math.max(0, span - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}` : "",
      `volume=${bed.gain.toFixed(3)}`,
      inSec > 0.0005 ? `adelay=${Math.round(inSec * 1000)}:all=1` : "",
      `apad=whole_dur=${duration.toFixed(3)}`,
    ]
      .filter(Boolean)
      .join(",");
    graph.push(`[${bed.index}:a]${chain}[bedraw${i}]`);
    const keyIndex = duckedBeds.indexOf(bed);
    graph.push(
      keyIndex >= 0
        ? // Near-limiting on the speech (threshold −32 dB on a +9.5 dB key) takes
          // the wet path ~21 dB down; `mix` blends it with the dry bed so the dip
          // under speech is the bed's own `dip`, not the voice's level.
          `[bedraw${i}][voicekey${keyIndex}]sidechaincompress=threshold=0.025:ratio=20:attack=${DIP_ATTACK_MS}:release=${DIP_RELEASE_MS}:knee=1:level_sc=3:mix=${bed.dip.toFixed(3)}[bed${i}]`
        : `[bedraw${i}]anull[bed${i}]`
    );
    mixParts.push(`[bed${i}]`);
  });

  input.hits.forEach((hit, i) => {
    const delayMs = Math.max(0, Math.round(hit.atSec * 1000));
    graph.push(`[${hit.index}:a]adelay=${delayMs}:all=1,volume=${hit.gain.toFixed(3)}[sfx${i}]`);
    mixParts.push(`[sfx${i}]`);
  });

  if (mixParts.length === 0) return "";
  if (mixParts.length === 1) {
    graph.push(`${mixParts[0]}anull[outa]`);
  } else {
    // Hits are cut hot (−1 dBTP) so they read over a loud voice, and stacked
    // beds add up; the sum can exceed full scale, so a brick-wall limiter
    // catches those transients. `level=false` keeps it from re-levelling a
    // quiet mix.
    const limit = input.hits.length > 0 || beds.length > 1 ? ",alimiter=limit=0.95:attack=2:release=60:level=false" : "";
    graph.push(
      `${mixParts.join("")}amix=inputs=${mixParts.length}:duration=first:dropout_transition=0:normalize=0${limit}[outa]`
    );
  }
  return graph.join(";");
}

/**
 * Mix music and hits onto an already-encoded clip. Video is copied. Returns the
 * path to use for delivery — the original when there is nothing to mix.
 */
export async function mixSoundtrackOntoClip(
  projectId: string,
  videoPath: string,
  durationSec: number,
  soundtrack: Soundtrack | undefined,
  scratchDir: string,
  options?: { voiceUntilSec?: number }
): Promise<string> {
  if (!soundtrackNeedsMix(soundtrack)) return videoPath;
  const track = soundtrack!;
  const mixedPath = join(scratchDir, "mixed.mp4");
  const voiceGain = clampGain(track.voiceGain, 1);
  const hits = (track.sfx ?? []).slice(0, MAX_SOUNDTRACK_HITS);
  const clipEnd = options?.voiceUntilSec ?? durationSec;
  const outroSec = Math.max(0, durationSec - clipEnd);

  const inputs: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-i", videoPath];
  let nextIndex = 1;
  const beds: GraphBed[] = [];
  for (const bed of musicBeds(track).slice(0, MAX_MUSIC_BEDS)) {
    const path = await resolveAssetPath(projectId, bed.assetId);
    if (!path) continue;
    beds.push({
      index: nextIndex,
      gain: clampGain(bed.gain, DEFAULT_BED_GAIN),
      inSec: Math.max(0, bed.inSec ?? 0),
      outSec: bedOutSec(bed, clipEnd, outroSec),
      offsetSec: Math.max(0, bed.offsetSec ?? 0),
      fadeInSec: bed.fadeInSec,
      fadeOutSec: bed.fadeOutSec,
      dip: Math.min(1, Math.max(0, bed.dip ?? DEFAULT_BED_DIP)),
    });
    inputs.push("-stream_loop", "-1", "-i", path);
    nextIndex += 1;
  }
  const hitInputs: { index: number; hit: SoundtrackHit }[] = [];
  for (const hit of hits) {
    const path = await resolveAssetPath(projectId, hit.assetId);
    if (!path) continue;
    hitInputs.push({ index: nextIndex, hit });
    inputs.push("-i", path);
    nextIndex += 1;
  }

  const voiceHasAudio = await hasAudioStream(videoPath);
  const graph = buildSoundtrackGraph({
    durationSec,
    voiceGain,
    voiceHasAudio,
    beds,
    voiceUntilSec: options?.voiceUntilSec,
    hits: hitInputs.map(({ index, hit }) => ({
      index,
      atSec: hit.atSec ?? 0,
      gain: clampGain(hit.gain, 0.9),
    })),
  });
  if (!graph) return videoPath;

  try {
    await runCommand(
      config.ffmpegPath,
      [
        ...inputs,
        "-filter_complex",
        graph,
        "-map",
        "0:v:0",
        "-map",
        "[outa]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-t",
        durationSec.toFixed(3),
        "-movflags",
        "+faststart",
        mixedPath,
      ],
      { label: "soundtrack mix" }
    );
  } catch (error: unknown) {
    throw new Error(`Could not mix soundtrack: ${getErrorMessage(error)}`);
  }
  return mixedPath;
}

export async function sweepOrphanedAudio(): Promise<number> {
  const { ClipProject } = await import("../models");
  const entries = await readdir(config.audioPath, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === SHARED_AUDIO_OWNER) continue;
    if (!/^[0-9a-f]{24}$/.test(entry.name)) continue;
    const exists = await ClipProject.exists({ _id: entry.name });
    if (exists) continue;
    await rm(join(config.audioPath, entry.name), { recursive: true, force: true }).catch(() => undefined);
    removed++;
  }
  if (removed > 0) {
    console.log(`🧹 Swept ${removed} orphaned audio director${removed === 1 ? "y" : "ies"}`);
  }
  return removed;
}

function clampGain(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(1.5, Math.max(0, value));
}
