import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";
import { resolveGenreProfile } from "../config/genres";
import { ClipProject, type IClipProject } from "../models";
import type { CaptionCue, VttWordTiming } from "../types/clip.types";
import { getErrorMessage } from "../types";
import {
  captureCommand,
  ensureDir,
  fileExists,
  getFileSize,
  projectMediaDir,
  runCommand,
  withScratch,
} from "../utils";
import {
  extractAudioTrack,
  extractEmbeddedSubtitle,
  getVideoMetadata,
} from "./ffmpeg.service";
import { transcribeWithWhisper } from "./podcast-transcribe.service";
import { parseVtt, resolveWordTimings } from "./transcript.service";

const YT_DLP_BIN = resolve(import.meta.dir, "../../bin/yt-dlp");

/** Caption languages we accept. The old "en.*" wildcard also matched ~38
 *  auto-TRANSLATED tracks, which tripped HTTP 429 serially. */
const CAPTION_LANGS = "en-orig,en,en-US,en-GB";

/**
 * YouTube's extraction now needs a JavaScript runtime; without one yt-dlp warns
 * and then 403s when it fetches video data. This only affects MEDIA downloads —
 * caption fetching works either way, which is why ingest succeeds on a machine
 * where rendering fails.
 *
 * Defaults to `node`, which is near-universal. Set YT_DLP_JS_RUNTIME="" to omit.
 */
const JS_RUNTIME = process.env.YT_DLP_JS_RUNTIME ?? "node";

/** Common yt-dlp args: suppress the update nag and wire up the JS runtime. */
function ytDlpBaseArgs(): string[] {
  const args = ["--no-warnings"];
  if (JS_RUNTIME.trim()) args.push("--js-runtimes", JS_RUNTIME.trim());
  return args;
}

// ---------------------------------------------------------------------------
// URL / id handling
// ---------------------------------------------------------------------------

/** Accept a full YouTube URL or a bare 11-char id; return the video id. */
export function parseYoutubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.slice(1).split("/")[0];
      return id || null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const v = url.searchParams.get("v");
      if (v) return v;
      const parts = url.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((p) => ["shorts", "embed", "live", "v"].includes(p));
      if (marker >= 0 && parts[marker + 1]) return parts[marker + 1];
    }
    return null;
  } catch {
    return null;
  }
}

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// ---------------------------------------------------------------------------
// yt-dlp wrappers
// ---------------------------------------------------------------------------

export interface YoutubeMetadata {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSec?: number;
  thumbnailUrl?: string;
}

/** Read metadata without downloading media (`-J` dumps JSON only). */
export async function fetchYoutubeMetadata(videoId: string): Promise<YoutubeMetadata> {
  const stdout = await captureCommand(
    YT_DLP_BIN,
    ["-J", "--no-playlist", ...ytDlpBaseArgs(), watchUrl(videoId)],
    { label: "yt-dlp metadata" }
  );
  const info = JSON.parse(stdout) as {
    id?: string;
    title?: string;
    uploader?: string;
    channel?: string;
    duration?: number;
    thumbnail?: string;
  };
  return {
    videoId: info.id ?? videoId,
    title: info.title?.trim() || "Untitled video",
    channelTitle: info.uploader?.trim() || info.channel?.trim() || "YouTube",
    durationSec: typeof info.duration === "number" ? info.duration : undefined,
    thumbnailUrl: info.thumbnail,
  };
}

/**
 * Fetch the caption track only — no media. Returns WebVTT text when available.
 *
 * YouTube publishes MULTIPLE English tracks and they are not equivalent. On a
 * real video measured here:
 *
 *   captions.en-orig.vtt   113 KB   1921 inline <ts><c>word</c> tags
 *   captions.en.vtt         22 KB      0 inline tags
 *
 * The `en-orig` track is the native auto-caption with per-word onsets and the
 * full transcript; `en` is a derived, condensed variant. Preference order
 * therefore cannot be by filename alone — we read the candidates and take the
 * first that actually carries inline word tags, which is what powers both the
 * exact caption sync and the denser mining transcript. Without this we silently
 * lose forced alignment on every import.
 */
async function downloadCaptions(videoId: string, outDir: string): Promise<string | undefined> {
  await ensureDir(outDir);
  try {
    await runCommand(
      YT_DLP_BIN,
      [
        "--write-auto-subs",
        "--write-subs",
        "--sub-langs", CAPTION_LANGS,
        "--convert-subs", "vtt",
        "--skip-download",
        "-o", join(outDir, "captions"),
        "--no-playlist",
        ...ytDlpBaseArgs(),
        watchUrl(videoId),
      ],
      { label: "yt-dlp captions" }
    );
  } catch {
    // yt-dlp exits non-zero if ANY requested language fails even when it already
    // wrote a usable English track. Fall through and look for the file.
  }

  const files = await readdir(outDir).catch(() => [] as string[]);
  const preferred = [
    "captions.en-orig.vtt",
    "captions.en.vtt",
    "captions.en-US.vtt",
    "captions.en-GB.vtt",
  ];
  // Preferred names first, then anything else ending in .vtt, deduped.
  const ordered = [
    ...preferred.filter((f) => files.includes(f)),
    ...files.filter((f) => f.endsWith(".vtt") && !preferred.includes(f)).sort(),
  ];
  if (ordered.length === 0) return undefined;

  let fallback: string | undefined;
  for (const file of ordered) {
    const content = await readFile(join(outDir, file), "utf-8").catch(() => undefined);
    if (!content?.trim()) continue;
    if (content.includes("<c>")) return content; // carries word onsets — best
    fallback ??= content;
  }
  return fallback;
}

/** Fetch + parse a YouTube transcript without touching media. Used by the
 *  validation script so the mining path can be exercised standalone. */
export async function fetchYoutubeTranscript(
  videoId: string
): Promise<{ vtt?: string; cues: CaptionCue[] }> {
  return withScratch(`transcript_${videoId}`, async (workDir) => {
    const vtt = await downloadCaptions(videoId, workDir);
    return { vtt, cues: vtt ? parseVtt(vtt) : [] };
  });
}

const YT_DLP_PROGRESS = /\[download\]\s+(\d+(?:\.\d+)?)%/;

export async function downloadVideo(
  videoId: string,
  outPath: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  await ensureDir(join(outPath, ".."));
  const report = (line: string) => {
    const match = line.match(YT_DLP_PROGRESS);
    if (!match || !onProgress) return;
    const percent = Number(match[1]);
    if (Number.isFinite(percent)) onProgress(Math.max(0, Math.min(99, percent)));
  };
  try {
    await runCommand(
      YT_DLP_BIN,
      [
        "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
        "--merge-output-format", "mp4",
        "-o", outPath,
        "--no-playlist",
        "--newline",
        "--progress",
        ...ytDlpBaseArgs(),
        watchUrl(videoId),
      ],
      {
        label: "yt-dlp video",
        onStdout: report,
        onStderr: report,
      }
    );
  } catch (error: unknown) {
    throw new Error(`${getErrorMessage(error)}${YT_DLP_HELP}`);
  }
  if (!(await fileExists(outPath))) {
    throw new Error("yt-dlp reported success but produced no video file");
  }
}

/** Appended to media-download failures. A stale yt-dlp is by far the most
 *  common cause — YouTube breaks extraction regularly. */
const YT_DLP_HELP =
  "\nHint: if this mentions HTTP 403, the bundled yt-dlp is likely stale. " +
  "Run `bun run ytdlp:update` in server/, or `bun run ytdlp:install` to refetch.";

async function downloadAudioOnly(videoId: string, outPath: string): Promise<void> {
  await ensureDir(join(outPath, ".."));
  try {
    await runCommand(
      YT_DLP_BIN,
      [
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "--extract-audio", "--audio-format", "m4a",
        "-o", outPath,
        "--no-playlist",
        ...ytDlpBaseArgs(),
        watchUrl(videoId),
      ],
      { label: "yt-dlp audio" }
    );
  } catch (error: unknown) {
    throw new Error(`${getErrorMessage(error)}${YT_DLP_HELP}`);
  }
  if (!(await fileExists(outPath))) throw new Error("Audio-only download produced no file");
}

// ---------------------------------------------------------------------------
// Project creation
// ---------------------------------------------------------------------------

export interface CreateYoutubeProjectInput {
  youtubeUrl: string;
  /** Explicit genre; omit to let detection choose. */
  genreId?: string;
}

export interface CreateUploadProjectInput {
  uploadPath: string;
  title?: string;
  /** Explicit genre; omit to let detection choose. */
  genreId?: string;
}

/** Create (or return) a project for a YouTube source. No media is downloaded. */
export async function createYoutubeProject(
  input: CreateYoutubeProjectInput
): Promise<IClipProject> {
  const videoId = parseYoutubeVideoId(input.youtubeUrl);
  if (!videoId) throw new Error("Could not read a YouTube video id from that link");

  if (input.genreId) resolveGenreProfile(input.genreId); // throws on a bad id

  const existing = await ClipProject.findOne({ youtubeVideoId: videoId, sourceType: "youtube" });
  if (existing) {
    if (existing.status !== "failed") return existing;
    // Re-submitting a failed source retries it in place rather than creating a
    // duplicate project.
    existing.set({ status: "pending", stage: "Queued", progress: 0, error: undefined });
    await existing.save();
    return existing;
  }

  const meta = await fetchYoutubeMetadata(videoId);

  const doc = await ClipProject.create({
    sourceType: "youtube",
    youtubeVideoId: meta.videoId,
    sourceUrl: watchUrl(meta.videoId),
    title: meta.title,
    channelTitle: meta.channelTitle,
    thumbnailUrl: meta.thumbnailUrl,
    durationSec: meta.durationSec,
    storage: config.outputStorage,
    status: "pending",
    stage: "Queued",
    mediaStatus: "absent",
    ...genreFieldsFor(input.genreId),
  });

  doc.s3Prefix = `${config.s3Prefix}${String(doc._id)}/`;
  await doc.save();
  return doc;
}

/**
 * Genre seed fields for a new project.
 *
 * An explicit genre is marked as NOT auto-detected, which is what stops
 * `resolveProjectGenre` from overwriting it. Omitting it leaves the flag unset,
 * so detection runs once and writes the result back.
 */
function genreFieldsFor(genreId?: string): { genreId: string; genreAutoDetected?: boolean } {
  if (genreId) return { genreId, genreAutoDetected: false };
  return { genreId: resolveGenreProfile(undefined).id };
}

/** Create a project for an already-uploaded local file. Media is ready at once. */
export async function createUploadProject(
  input: CreateUploadProjectInput
): Promise<IClipProject> {
  if (!(await fileExists(input.uploadPath))) {
    throw new Error("Uploaded file not found on disk");
  }
  if (input.genreId) resolveGenreProfile(input.genreId); // throws on a bad id
  const meta = await getVideoMetadata(input.uploadPath);
  const uploadBytes = await getFileSize(input.uploadPath).catch(() => 0);

  const doc = await ClipProject.create({
    sourceType: "upload",
    sourceUrl: input.uploadPath,
    uploadPath: input.uploadPath,
    title: input.title?.trim() || "Uploaded video",
    channelTitle: "Local upload",
    durationSec: meta.durationSec,
    storage: config.outputStorage,
    status: "pending",
    stage: "Queued",
    mediaStatus: "ready",
    mediaPath: input.uploadPath,
    mediaBytes: uploadBytes,
    ...genreFieldsFor(input.genreId),
  });

  doc.s3Prefix = `${config.s3Prefix}${String(doc._id)}/`;
  await doc.save();
  return doc;
}

// ---------------------------------------------------------------------------
// Ingest (worker body)
// ---------------------------------------------------------------------------

const NO_TRANSCRIPT_MESSAGE =
  "No English captions are available for this video. Enable the local Whisper " +
  "fallback to transcribe it: `bun run whisper:install`, then set " +
  "WHISPER_ALIGNMENT_ENABLED=true and restart the server.";

async function update(
  projectId: string,
  patch: Partial<IClipProject> & { progress?: number; stage?: string }
): Promise<void> {
  await ClipProject.findByIdAndUpdate(projectId, { $set: patch });
}

/**
 * Stage 1 of the pipeline: obtain a transcript.
 *
 * For YouTube this is pure caption fetching — a few seconds and NO media
 * download, which is the central speed win over the reference pipeline.
 * Whisper only runs when a source has no usable captions at all.
 */
export async function ingestProject(projectId: string): Promise<void> {
  const doc = await ClipProject.findById(projectId);
  if (!doc) throw new Error(`Project not found: ${projectId}`);

  const startedAt = Date.now();
  await withScratch(`ingest_${projectId}`, async (workDir) => {
    try {
      await update(projectId, { status: "ingesting", stage: "Reading transcript", progress: 8, error: undefined });

      let vtt: string | undefined;
      let cues: CaptionCue[] = [];
      let transcriptSource: IClipProject["transcriptSource"];

      if (doc.sourceType === "youtube") {
        const videoId = doc.youtubeVideoId;
        if (!videoId) throw new Error("YouTube project has no video id");

        vtt = await downloadCaptions(videoId, workDir);
        if (vtt) cues = parseVtt(vtt);
        if (cues.length) transcriptSource = "youtube_captions";

        if (!cues.length) {
          await update(projectId, { stage: "Transcribing audio (Whisper)", progress: 18 });
          cues = await whisperFromYoutube(videoId, workDir);
          if (cues.length) transcriptSource = "whisper";
        }
      } else {
        const videoPath = doc.uploadPath;
        if (!videoPath) throw new Error("Upload project has no source file");

        const subPath = join(workDir, "embedded.vtt");
        await ensureDir(workDir);
        try {
          await extractEmbeddedSubtitle(videoPath, subPath);
          if (await fileExists(subPath)) {
            vtt = await readFile(subPath, "utf-8");
            cues = parseVtt(vtt);
            if (cues.length) transcriptSource = "embedded_subs";
          }
        } catch {
          // No embedded subtitle stream — fall through to Whisper.
        }

        if (!cues.length) {
          await update(projectId, { stage: "Transcribing audio (Whisper)", progress: 18 });
          if (!config.whisperAlignmentEnabled) throw new Error(NO_TRANSCRIPT_MESSAGE);
          const audioPath = join(workDir, "audio.m4a");
          await extractAudioTrack(videoPath, audioPath);
          cues = await transcribeWithWhisper(audioPath);
          if (cues.length) transcriptSource = "whisper";
        }
      }

      if (!cues.length) throw new Error(NO_TRANSCRIPT_MESSAGE);

      const wordTimings: VttWordTiming[] = resolveWordTimings(vtt, cues);

      await update(projectId, {
        captions: cues,
        wordTimings,
        captionsAvailable: true,
        transcriptSource,
        status: "mining",
        stage: "Mining for hooks",
        progress: 40,
        timings: { ...(doc.timings ?? {}), ingestMs: Date.now() - startedAt },
      });

      console.log(
        `📝 Transcript ready for ${projectId}: ${cues.length} cues, ` +
          `${wordTimings.length} word onsets, source=${transcriptSource} ` +
          `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
      );
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      await update(projectId, { status: "failed", stage: "Failed", error: message });
      throw error;
    }
  });
}

async function whisperFromYoutube(videoId: string, workDir: string): Promise<CaptionCue[]> {
  if (!config.whisperAlignmentEnabled) throw new Error(NO_TRANSCRIPT_MESSAGE);
  const audioPath = join(workDir, "audio.m4a");
  await downloadAudioOnly(videoId, audioPath);
  return transcribeWithWhisper(audioPath);
}

// ---------------------------------------------------------------------------
// Lazy media fetch (render time)
// ---------------------------------------------------------------------------

/**
 * Ensure the source video exists locally and return its path. Downloads it on
 * first render rather than during ingest — the reason the clip board appears
 * without waiting on a 1080p download.
 *
 * Render concurrency is > 1, so several jobs for the SAME project routinely hit
 * this at once. Without the in-flight map they each start their own download of
 * the same 1080p file. The first caller does the work; the rest await it.
 */
const mediaFetches = new Map<string, Promise<string>>();

export async function ensureProjectMedia(projectId: string): Promise<string> {
  const doc = await ClipProject.findById(projectId);
  if (!doc) throw new Error(`Project not found: ${projectId}`);

  // Already on disk — common path, no lock needed.
  if (doc.mediaPath && (await fileExists(doc.mediaPath))) return doc.mediaPath;
  if (doc.sourceType === "upload") {
    if (!doc.uploadPath || !(await fileExists(doc.uploadPath))) {
      throw new Error("The uploaded source file is no longer on disk");
    }
    const size = await getFileSize(doc.uploadPath).catch(() => 0);
    await update(projectId, { mediaStatus: "ready", mediaPath: doc.uploadPath, mediaBytes: size });
    return doc.uploadPath;
  }

  const inFlight = mediaFetches.get(projectId);
  if (inFlight) return inFlight;

  const task = fetchProjectMedia(projectId).finally(() => mediaFetches.delete(projectId));
  mediaFetches.set(projectId, task);
  return task;
}

/**
 * Remove everything in a project's media directory except `keepPath`.
 *
 * yt-dlp leaves real files behind when it is killed or fails: `.part` for an
 * in-flight stream, and one untitled fragment per selected format before the
 * merge (`source.f137.mp4` etc.). On success it cleans up after itself, so these
 * only appear on a failure — which is exactly when nobody is looking. A failed
 * download that leaves 250 MB of fragments behind, and a `mediaStatus` stuck on
 * "fetching", is how a cache quietly becomes a leak.
 */
export async function clearMediaFragments(projectId: string, keepPath?: string): Promise<number> {
  const dir = projectMediaDir(projectId);
  const entries = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of entries) {
    const path = join(dir, name);
    if (keepPath && path === keepPath) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}

async function fetchProjectMedia(projectId: string): Promise<string> {
  const doc = await ClipProject.findById(projectId);
  if (!doc) throw new Error(`Project not found: ${projectId}`);

  const videoId = doc.youtubeVideoId;
  if (!videoId) throw new Error("YouTube project has no video id");

  const dir = projectMediaDir(projectId);
  await ensureDir(dir);
  const mediaPath = join(dir, "source.mp4");

  if (!(await fileExists(mediaPath))) {
    await ClipProject.updateOne(
      { _id: projectId },
      {
        $set: { mediaStatus: "fetching", mediaProgress: 0 },
        $unset: { mediaPath: 1, mediaBytes: 1, mediaError: 1 },
      }
    );
    console.log(`⬇️  Fetching source media for ${projectId} (lazy, render-time)`);
    try {
      let lastWrite = 0;
      let lastPercent = -1;
      await downloadVideo(videoId, mediaPath, (percent) => {
        const rounded = Math.round(percent);
        const now = Date.now();
        if (rounded === lastPercent) return;
        if (now - lastWrite < 400 && rounded < 99) return;
        lastWrite = now;
        lastPercent = rounded;
        void ClipProject.updateOne({ _id: projectId }, { $set: { mediaProgress: rounded } });
      });
    } catch (error: unknown) {
      // The download failed. Drop its fragments and put the state back to
      // "absent" so the next attempt is a clean one — leaving "fetching" would
      // read as work in progress forever and hide the real error.
      const removed = await clearMediaFragments(projectId, mediaPath);
      await ClipProject.updateOne(
        { _id: projectId },
        {
          $set: { mediaStatus: "absent", mediaError: getErrorMessage(error).slice(0, 400) },
          $unset: { mediaPath: 1, mediaBytes: 1, mediaProgress: 1 },
        }
      );
      if (removed > 0) {
        console.warn(`⚠️  Cleared ${removed} fragment(s) from a failed media download for ${projectId}`);
      }
      throw error;
    }
  }

  const size = await getFileSize(mediaPath).catch(() => 0);
  // yt-dlp usually removes merge fragments itself; do it here too so a leftover
  // `.part` / `source.f137.mp4` does not sit for the six-hour sweep.
  const removed = await clearMediaFragments(projectId, mediaPath);
  if (removed > 0) {
    console.log(`🧹 Cleared ${removed} leftover fragment(s) after source fetch for ${projectId}`);
  }
  await ClipProject.updateOne(
    { _id: projectId },
    {
      $set: { mediaStatus: "ready", mediaPath, mediaBytes: size },
      $unset: { mediaProgress: 1, mediaError: 1 },
    }
  );
  return mediaPath;
}
