import { existsSync } from "node:fs";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";
import type { Soundtrack, SoundtrackHit } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { containedPath, ensureDir, fileExists, getFileSize, projectAudioDir } from "../utils/file.utils";
import { runCommand } from "../utils/process.utils";
import { getVideoMetadata, hasAudioStream } from "./ffmpeg.service";

export const MAX_SOUNDTRACK_HITS = 16;
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
];

const BUILTIN_IDS = new Set(BUILTIN.map((asset) => asset.id));

export function listBuiltinAudio(): AudioAsset[] {
  return BUILTIN.filter((asset) => existsSync(join(LIBRARY_DIR, `${asset.id}.m4a`)));
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
  originalName: string
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
  };
  await writeFile(
    join(dir, `${fileId}.json`),
    JSON.stringify({ id: asset.id, kind, name: asset.label, durationSec }, null, 2)
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

export function soundtrackNeedsMix(track: Soundtrack | undefined): boolean {
  if (!track) return false;
  if (track.voiceGain != null && Math.abs(track.voiceGain - 1) > 0.001) return true;
  if (track.music?.assetId) return true;
  return (track.sfx ?? []).length > 0;
}

/** Music or hits that should be mixed after the sting is joined. */
export function soundtrackSpansOutro(track: Soundtrack | undefined, clipDurationSec: number): boolean {
  if (!track) return false;
  if (track.music?.assetId && track.music.carryIntoOutro !== false) return true;
  return (track.sfx ?? []).some((hit) => (hit.atSec ?? 0) > clipDurationSec - 0.02);
}

export function buildSoundtrackGraph(input: {
  durationSec: number;
  voiceGain: number;
  voiceHasAudio: boolean;
  duck: boolean;
  musicIndex?: number;
  musicGain: number;
  hits: { index: number; atSec: number; gain: number }[];
  /** Apply voiceGain only up to this time; later audio (the sting) stays at unity. */
  voiceUntilSec?: number;
}): string {
  const duration = Math.max(0.05, input.durationSec);
  const graph: string[] = [];
  const mixParts: string[] = [];
  const duckMusic = input.musicIndex != null && input.duck && input.voiceHasAudio && input.voiceGain > 0.05;
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
    graph.push(duckMusic ? `[voicefull]asplit=2[voice][voicekey]` : `[voicefull]anull[voice]`);
    mixParts.push("[voice]");
  }

  if (input.musicIndex != null) {
    const fade = Math.min(1.2, duration / 6);
    const fadeOutStart = Math.max(0, duration - fade);
    graph.push(
      `[${input.musicIndex}:a]atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${fade.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fade.toFixed(2)},volume=${input.musicGain.toFixed(3)},apad=whole_dur=${duration.toFixed(3)}[musicraw]`
    );
    graph.push(
      duckMusic
        ? `[musicraw][voicekey]sidechaincompress=threshold=0.05:ratio=7:attack=30:release=280:level_sc=1[music]`
        : `[musicraw]anull[music]`
    );
    mixParts.push("[music]");
  }

  input.hits.forEach((hit, i) => {
    const delayMs = Math.max(0, Math.round(hit.atSec * 1000));
    graph.push(`[${hit.index}:a]adelay=${delayMs}:all=1,volume=${hit.gain.toFixed(3)}[sfx${i}]`);
    mixParts.push(`[sfx${i}]`);
  });

  if (mixParts.length === 0) return "";
  if (mixParts.length === 1) {
    graph.push(`${mixParts[0]}anull[outa]`);
  } else {
    graph.push(
      `${mixParts.join("")}amix=inputs=${mixParts.length}:duration=first:dropout_transition=0:normalize=0[outa]`
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
  const musicGain = clampGain(track.music?.gain, 0.22);
  const duck = track.music?.duck !== false;
  const hits = (track.sfx ?? []).slice(0, MAX_SOUNDTRACK_HITS);

  const inputs: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-i", videoPath];
  let nextIndex = 1;
  let musicIndex: number | undefined;
  if (track.music?.assetId) {
    const path = await resolveAssetPath(projectId, track.music.assetId);
    if (path) {
      musicIndex = nextIndex;
      inputs.push("-stream_loop", "-1", "-i", path);
      nextIndex += 1;
    }
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
    duck,
    musicIndex,
    musicGain,
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
