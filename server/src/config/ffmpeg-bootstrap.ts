import ffmpeg from "fluent-ffmpeg";
import { config } from "./index";

// Point fluent-ffmpeg at the configured binaries ONCE at process start, before
// any service imports it for its own use. Every direct `fluent-ffmpeg` importer
// then inherits these paths.
export function configureFfmpeg(): void {
  if (config.ffmpegPath) ffmpeg.setFfmpegPath(config.ffmpegPath);
  if (config.ffprobePath) ffmpeg.setFfprobePath(config.ffprobePath);
}

configureFfmpeg();
