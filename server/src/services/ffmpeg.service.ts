import ffmpeg from "fluent-ffmpeg";
import "../config/ffmpeg-bootstrap";
import { config } from "../config";

export interface VideoMetadata {
  durationSec: number;
  width: number;
  height: number;
  frameRate: number;
}

function parseFrameRate(raw: string | undefined): number {
  if (!raw) return 30;
  const [num, den] = raw.split("/").map(Number);
  if (!Number.isFinite(num)) return 30;
  if (!den) return num;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 30;
}

/** Probe a media file's duration and first video stream dimensions. */
export function getVideoMetadata(filePath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) {
        reject(new Error(`Failed to probe ${filePath}: ${err.message}`));
        return;
      }
      const video = meta.streams.find((s) => s.codec_type === "video");
      const durationSec = meta.format?.duration ?? video?.duration ?? 0;
      resolve({
        durationSec: Number.isFinite(durationSec) ? Number(durationSec) : 0,
        width: video?.width ?? 1920,
        height: video?.height ?? 1080,
        frameRate: parseFrameRate(video?.r_frame_rate),
      });
    });
  });
}

/**
 * True when the file carries an audio stream.
 *
 * A merge concat has to know up front whether it can wire `[i:a]` into the
 * filtergraph — mapping a stream that does not exist is a hard ffmpeg failure.
 * On a probe error it reports `true` so the render fails loudly in ffmpeg rather
 * than silently producing an audio-less clip.
 */
export function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) {
        resolve(true);
        return;
      }
      resolve(meta.streams.some((s) => s.codec_type === "audio"));
    });
  });
}

/** Extract a compressed audio track without re-encoding (fast, lossless). */
export function extractAudioTrack(videoPath: string, audioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec("copy")
      .output(audioPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`Audio extract failed: ${err.message}`)))
      .run();
  });
}

/** Extract the first embedded subtitle stream as WebVTT. Rejects when none exists. */
export function extractEmbeddedSubtitle(videoPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions(["-map", "0:s:0", "-f", "webvtt"])
      .output(outPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`Subtitle extract failed: ${err.message}`)))
      .run();
  });
}

export function ffmpegPreset(): string {
  return config.ffmpegPreset;
}
