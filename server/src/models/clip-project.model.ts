import { Schema, model, type Document, type Types } from "mongoose";
import type { CaptionCue, VttWordTiming } from "../types/clip.types";

/** Where the source media came from. */
export type ClipProjectSourceType = "youtube" | "upload";

/** Coarse lifecycle. Detailed position lives in `stage`. */
export type ClipProjectStatus = "pending" | "ingesting" | "mining" | "ready" | "failed";

/** Whether the source video is available locally for rendering. */
export type MediaStatus = "absent" | "fetching" | "ready";

export interface IClipProject extends Document {
  _id: Types.ObjectId;
  sourceType: ClipProjectSourceType;

  /** YouTube only. */
  youtubeVideoId?: string;
  sourceUrl: string;
  /** Upload only — absolute path of the stored source file. */
  uploadPath?: string;

  title: string;
  channelTitle: string;
  thumbnailUrl?: string;
  durationSec?: number;

  /** Where rendered output lands. Seeded from OUTPUT_STORAGE at creation. */
  storage: "s3" | "local";
  s3Prefix?: string;

  status: ClipProjectStatus;
  /** Human-readable current step, e.g. "Mining chunk 4/11". */
  stage: string;
  progress: number;
  error?: string;

  /** Transcript. `captions` may be word-granular when Whisper produced it. */
  captions: CaptionCue[];
  /** Exact word onsets. Empty when the transcript carried none. */
  wordTimings: VttWordTiming[];
  /** True once any transcript exists; false means mining cannot run. */
  captionsAvailable: boolean;
  /** How the transcript was obtained. */
  transcriptSource?: "youtube_captions" | "embedded_subs" | "whisper";

  /** Source video availability for render. */
  mediaStatus: MediaStatus;
  /** 0–100 while `mediaStatus` is `fetching`. Unset once ready or absent. */
  mediaProgress?: number;
  /** Last media-fetch failure, shown in the editor until the next attempt. */
  mediaError?: string;
  /** Absolute local path to the source video once fetched. */
  mediaPath?: string;
  /**
   * Size of the cached source video, in bytes. Reported separately from
   * `storageBytes` (which counts rendered clips) because the source cache is the
   * single largest thing this app puts on disk — hundreds of MB per project — and
   * silently holding it is not something the operator can see otherwise.
   */
  mediaBytes?: number;

  clipCount: number;
  /** Mining fan-out progress (chunks completed / total). */
  miningChunksTotal?: number;
  miningChunksDone?: number;

  /**
   * Sum of the live clips' output sizes, in bytes. Denormalised because the
   * board poller asks for the project far more often than anything changes it —
   * an aggregate per poll would be pure waste.
   */
  storageBytes: number;

  /**
   * The genre profile that drove mining. Set explicitly at creation, or written
   * back by auto-detection. Determines what qualifies as a clip, how long it
   * should be, which axes score it, and whether captions are burned.
   */
  genreId: string;
  /** True when no genre was supplied and detection inferred it. */
  genreAutoDetected?: boolean;

  /** Wall-clock timings for the latency dashboard. */
  timings?: {
    ingestMs?: number;
    miningMs?: number;
    totalMs?: number;
  };

  createdAt: Date;
  updatedAt: Date;
}

const captionCueSchema = new Schema<CaptionCue>(
  {
    startSec: { type: Number, required: true },
    endSec: { type: Number, required: true },
    text: { type: String, required: true },
  },
  { _id: false }
);

const wordTimingSchema = new Schema<VttWordTiming>(
  {
    t: { type: Number, required: true },
    word: { type: String, required: true },
  },
  { _id: false }
);

const clipProjectSchema = new Schema<IClipProject>(
  {
    sourceType: { type: String, enum: ["youtube", "upload"], required: true },
    youtubeVideoId: { type: String, trim: true, index: true },
    sourceUrl: { type: String, required: true, trim: true },
    uploadPath: { type: String, trim: true },

    title: { type: String, required: true, trim: true },
    channelTitle: { type: String, required: true, trim: true },
    thumbnailUrl: { type: String, trim: true },
    durationSec: { type: Number, min: 0 },

    storage: { type: String, enum: ["s3", "local"], default: "s3" },
    s3Prefix: { type: String, trim: true },

    status: {
      type: String,
      enum: ["pending", "ingesting", "mining", "ready", "failed"],
      default: "pending",
      index: true,
    },
    stage: { type: String, default: "Queued" },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    error: { type: String },

    captions: { type: [captionCueSchema], default: [] },
    wordTimings: { type: [wordTimingSchema], default: [] },
    captionsAvailable: { type: Boolean, default: false },
    transcriptSource: {
      type: String,
      enum: ["youtube_captions", "embedded_subs", "whisper"],
    },

    mediaStatus: { type: String, enum: ["absent", "fetching", "ready"], default: "absent" },
    mediaProgress: { type: Number, min: 0, max: 100 },
    mediaError: { type: String },
    mediaPath: { type: String, trim: true },
    mediaBytes: { type: Number, min: 0 },

    clipCount: { type: Number, default: 0, min: 0 },
    miningChunksTotal: { type: Number, min: 0 },
    miningChunksDone: { type: Number, min: 0 },
    storageBytes: { type: Number, default: 0, min: 0 },

    genreId: { type: String, required: true, default: "motivation", index: true },
    genreAutoDetected: { type: Boolean },

    timings: {
      ingestMs: { type: Number },
      miningMs: { type: Number },
      totalMs: { type: Number },
    },
  },
  { timestamps: true }
);

clipProjectSchema.index({ createdAt: -1 });

export const ClipProject = model<IClipProject>("ClipProject", clipProjectSchema);
