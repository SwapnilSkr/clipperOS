import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Resolve storage-ish paths to absolute so a different cwd (PM2, docker,
 *  monorepo launch) still finds the same directories. */
function absPath(envValue: string | undefined, fallback: string): string {
  return resolve(envValue?.trim() || fallback);
}

export const config = {
  // ---- Server ----
  port: parseInt(process.env.PORT || "8787"),
  host: process.env.HOST || "localhost",
  nodeEnv: process.env.NODE_ENV || "development",

  // ---- Databases ----
  mongodbUri: process.env.MONGODB_URI || "mongodb://localhost:27017/clipperOS",
  /** Optional second URI tried when the primary refuses/fails (e.g. a local
   *  mongod that is not running, with an Atlas cluster as the escape hatch). */
  mongodbUriFallback: process.env.MONGODB_URI_FALLBACK?.trim() || "",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  queueConcurrency: Math.max(1, parseInt(process.env.QUEUE_CONCURRENCY || "3")),

  // ---- AI (OpenRouter) ----
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  /** Empty = fall through to the model registry (config/models.ts). */
  llmModelOverride: process.env.LLM_MODEL || "",
  visionModelOverride: process.env.VISION_MODEL || "",
  /**
   * Hard ceiling on mining output per chunk. Each chunk should need well under
   * 1k tokens for its JSON; the cap exists because some models otherwise ramble
   * (observed: 11k output tokens on a single 12-minute chunk, turning a 20s
   * mining pass into a 2-minute one).
   */
  llmMaxOutputTokens: Math.max(256, parseInt(process.env.LLM_MAX_OUTPUT_TOKENS || "2000")),

  // ---- Object storage ----
  awsRegion: process.env.AWS_REGION || "us-east-1",
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  s3Bucket: process.env.S3_BUCKET || "",
  cdnUrl: (process.env.CLOUDFRONT_URL || "").replace(/\/$/, ""),
  s3Prefix: (process.env.S3_PREFIX || "clipperOS/").replace(/^\/+/, ""),
  /** Where rendered clips land. `s3` requires the bucket above. */
  outputStorage: (process.env.OUTPUT_STORAGE === "local" ? "local" : "s3") as "s3" | "local",
  /**
   * How recent an S3 object must be to be spared by the storage reconciler.
   * Objects younger than this may belong to a render whose result has not been
   * persisted yet, so they are never treated as orphans.
   */
  reconcileMinAgeMs: Math.max(0, parseInt(process.env.RECONCILE_MIN_AGE_MS || "900000")),

  // ---- Local storage ----
  storagePath: absPath(process.env.STORAGE_PATH, "./storage"),
  processingPath: absPath(process.env.PROCESSING_PATH, "./storage/processing"),
  uploadsPath: absPath(process.env.UPLOADS_PATH, "./storage/uploads"),
  outputPath: absPath(process.env.OUTPUT_PATH, "./storage/output"),
  mediaPath: absPath(process.env.MEDIA_PATH, "./storage/media"),
  audioPath: absPath(process.env.AUDIO_PATH, "./storage/audio"),

  // ---- FFmpeg ----
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
  ffmpegPreset: process.env.FFMPEG_PRESET || "veryfast",
  ffmpegCrf: parseInt(process.env.FFMPEG_CRF || "20"),

  // ---- Whisper (captions-less sources only) ----
  whisperAlignmentEnabled: process.env.WHISPER_ALIGNMENT_ENABLED === "true",
  whisperCliPath: process.env.WHISPER_CLI_PATH || "whisper-cli",
  whisperModelPath: absPath(process.env.WHISPER_MODEL_PATH, "./storage/whisper/ggml-base.en.bin"),

  // ---- Vision (optional local OpenCV stack) ----
  //
  // Gates BOTH speaker-aware reframing and burned-in-text removal. Neither is
  // required: with this off, or with the venv missing, reframing degrades to a
  // centre crop and cleanup degrades to ffmpeg delogo. Run `bun run vision:install`
  // to create the venv, then set VISION_REFRAME_ENABLED=true.
  visionReframeEnabled: process.env.VISION_REFRAME_ENABLED === "true",
  visionPythonPath: absPath(process.env.VISION_PYTHON_PATH, "./storage/vision/venv/bin/python3"),
  visionScriptPath: absPath(process.env.VISION_SCRIPT_PATH, "./python/reframe_analyze.py"),
  visionCleanupScriptPath: absPath(
    process.env.VISION_CLEANUP_SCRIPT_PATH,
    "./python/cleanup_inpaint.py"
  ),
  visionFaceModelPath: absPath(
    process.env.VISION_FACE_MODEL_PATH,
    "./storage/vision/models/face_detection_yunet_2023mar.onnx"
  ),

  // ---- Limits ----
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || "4096"),

  // ---- Captions ----
  captionChunkWords: Math.max(1, parseInt(process.env.CAPTION_CHUNK_WORDS || "3")),
};

export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!config.openRouterApiKey) errors.push("OPENROUTER_API_KEY is required for clip mining");
  if (!config.mongodbUri) errors.push("MONGODB_URI is required");
  if (!config.redisUrl) errors.push("REDIS_URL is required");
  if (config.outputStorage === "s3" && !config.s3Bucket) {
    errors.push("OUTPUT_STORAGE=s3 requires S3_BUCKET (or set OUTPUT_STORAGE=local)");
  }
  // A warning, not an error: both vision features degrade to a non-vision path,
  // so a missing venv costs quality rather than correctness. Saying so at boot is
  // what stops "why is every clip a centre crop?" being a mystery later.
  if (config.visionReframeEnabled && !existsSync(config.visionPythonPath)) {
    errors.push(
      `VISION_REFRAME_ENABLED=true but no interpreter at ${config.visionPythonPath} — ` +
        `run \`bun run vision:install\`. Reframing will use a centre crop and cleanup delogo.`
    );
  }

  if (errors.length > 0) {
    console.warn("⚠️  Configuration warnings:");
    for (const e of errors) console.warn(`   - ${e}`);
  }
  return { valid: errors.length === 0, errors };
}
