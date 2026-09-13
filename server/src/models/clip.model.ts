import { Schema, model, type Document, type Types } from "mongoose";
import type {
  ClipEdit,
  ClipKind,
  ClipSegment,
  PeakKind,
  ReframeMode,
  ReframeTrack,
  ScoreMap,
  ShareCopy,
} from "../types/clip.types";

export type ClipStatus = "available" | "rendering" | "rendered" | "failed" | "dismissed";

export interface IClip extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  /** 1-based position in the ranked board. */
  rank: number;

  /** `mined` candidate, or a user-built `merge` of source segments. */
  kind: ClipKind;
  /** User-set name. Used for merges, which have no mined hook to title them. */
  title?: string;

  startSec: number;
  endSec: number;
  durationSec: number;

  transcript: string;
  /** Absolute source time of the peak. Always set. */
  peakSec: number;
  peakKind: PeakKind;
  /** Verbatim peak line. Absent when the peak is a moment rather than a line. */
  peakLine?: string;
  /** First sentence of the transcript — shown on the board as the hook. */
  hookText: string;
  /** Generated Shorts title + description. Absent until written. */
  shareCopy?: ShareCopy;

  /**
   * Per-axis scores keyed by the genre profile's axis ids. Shape varies by
   * genre, so this is a free-form map rather than a fixed subdocument.
   */
  scores: ScoreMap;
  totalScore: number;
  rationale: string;
  suggestedThemes: string[];

  status: ClipStatus;
  renderProgress: number;
  outputUrl?: string;
  renderError?: string;
  /** Framing strategy actually used for the last render. */
  reframeMode?: ReframeMode;
  reframeNote?: string;
  /**
   * The last resolved reframe track, with the source span it was analysed on.
   * A tighter trim reuses this; only expanding past that span (or a mode change)
   * runs analysis again.
   */
  reframeTrack?: {
    track: ReframeTrack;
    for: { startSec: number; endSec: number; mode: string; v?: number };
  };

  /** The user's edit spec. Absent means "render the mined window as-is". */
  edit?: ClipEdit;
  /** Ordered pieces of a merge. Present only when `kind === "merge"`. */
  segments?: ClipSegment[];
  /** Which clips a merge was built from. Provenance only — sources are kept. */
  mergedFrom?: Types.ObjectId[];

  /** Exact S3 key of the last render. Absent in local mode. */
  outputKey?: string;
  /** Exact local path of the last render. Absent once uploaded to S3. */
  outputPath?: string;
  outputBytes?: number;
  renderedAt?: Date;
  /**
   * Incremented per render. A render stamps its own revision on every progress
   * write, so a superseded job cannot overwrite a newer render's state.
   */
  renderRevision: number;

  createdAt: Date;
  updatedAt: Date;
}

const captionOverridesSchema = new Schema(
  {
    chunkWords: { type: Number, min: 1, max: 12 },
    sizeScale: { type: Number, min: 0.3, max: 3 },
    verticalFrac: { type: Number, min: 0, max: 0.8 },
    horizontalFrac: { type: Number, min: 0, max: 1 },
    textColor: { type: String, trim: true },
    background: { type: String, enum: ["none", "box"] },
    animation: { type: String, enum: ["none", "pop", "fade"] },
    peakColor: { type: String, trim: true },
    peakEmphasis: { type: Boolean },
    fontFamily: { type: String, trim: true },
    uppercase: { type: Boolean },
  },
  { _id: false }
);

const captionTextOverrideSchema = new Schema(
  {
    startSec: { type: Number, required: true, min: 0 },
    id: { type: String, trim: true, maxlength: 64 },
    text: { type: String, maxlength: 160 },
    displayStartSec: { type: Number, min: 0 },
    endSec: { type: Number, min: 0 },
    hidden: { type: Boolean },
    custom: { type: Boolean },
  },
  { _id: false }
);

const captionWordOverrideSchema = new Schema(
  {
    t: { type: Number, required: true, min: 0 },
    word: { type: String, maxlength: 120 },
    hidden: { type: Boolean },
  },
  { _id: false }
);

const videoEffectsSchema = new Schema(
  {
    grade: { type: String, enum: ["natural", "vibrant", "warm", "cool", "cinematic"] },
    motion: { type: String, enum: ["none", "hook_push", "peak_punch"] },
    zoom: { type: Number, min: 1, max: 1.12 },
    sharpen: { type: Number, min: 0, max: 1 },
    vignette: { type: Boolean },
    audio: { type: String, enum: ["natural", "voice", "loud"] },
  },
  { _id: false }
);

const soundtrackHitSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    assetId: { type: String, required: true, trim: true },
    atSec: { type: Number, required: true, min: 0 },
    gain: { type: Number, min: 0, max: 1.5 },
  },
  { _id: false }
);

const soundtrackSchema = new Schema(
  {
    voiceGain: { type: Number, min: 0, max: 1.5 },
    music: {
      type: new Schema(
        {
          assetId: { type: String, trim: true },
          gain: { type: Number, min: 0, max: 1.5 },
          duck: { type: Boolean },
          carryIntoOutro: { type: Boolean },
        },
        { _id: false }
      ),
    },
    sfx: { type: [soundtrackHitSchema], default: undefined },
  },
  { _id: false }
);

const cleanupRegionSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    x: { type: Number, required: true, min: 0 },
    y: { type: Number, required: true, min: 0 },
    w: { type: Number, required: true, min: 1 },
    h: { type: Number, required: true, min: 1 },
    start: { type: Number, required: true, min: 0 },
    end: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const clipEditSchema = new Schema(
  {
    trimStartSec: { type: Number, min: 0 },
    trimEndSec: { type: Number, min: 0 },
    reframeMode: { type: String, enum: ["center", "smart"] },
    captionsOn: { type: Boolean },
    captionStyleId: { type: String, trim: true },
    captionOverrides: { type: captionOverridesSchema },
    captionTextOverrides: { type: [captionTextOverrideSchema], default: undefined },
    captionWordOverrides: { type: [captionWordOverrideSchema], default: undefined },
    editTemplateId: { type: String, trim: true, maxlength: 40 },
    videoEffects: { type: videoEffectsSchema },
    soundtrack: { type: soundtrackSchema },
    outro: {
      type: new Schema(
        {
          enabled: { type: Boolean },
          transitionId: {
            type: String,
            enum: ["smash", "punch", "whip", "flash", "dip", "blur", "push"],
          },
          outroId: { type: String, trim: true, maxlength: 24 },
        },
        { _id: false }
      ),
    },
    // Omitting this here silently drops every region on write — the whole feature
    // no-ops with no error anywhere.
    cleanup: { type: [cleanupRegionSchema], default: undefined },
  },
  { _id: false }
);

const clipSegmentSchema = new Schema(
  {
    startSec: { type: Number, required: true, min: 0 },
    endSec: { type: Number, required: true, min: 0 },
    sourceClipId: { type: Schema.Types.ObjectId, ref: "Clip" },
    reframeMode: { type: String, enum: ["center", "smart"] },
    captionStyleId: { type: String, trim: true },
    captionsOn: { type: Boolean },
  },
  { _id: false }
);

const clipSchema = new Schema<IClip>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "ClipProject", required: true, index: true },
    rank: { type: Number, required: true, min: 1 },

    kind: { type: String, enum: ["mined", "merge"], default: "mined" },
    title: { type: String, trim: true },

    startSec: { type: Number, required: true, min: 0 },
    endSec: { type: Number, required: true, min: 0 },
    durationSec: { type: Number, required: true, min: 0 },

    transcript: { type: String, required: true },
    peakSec: { type: Number, required: true, min: 0 },
    peakKind: { type: String, enum: ["line", "moment"], required: true },
    peakLine: { type: String },
    hookText: { type: String, default: "" },
    shareCopy: {
      type: new Schema(
        {
          title: { type: String, default: "" },
          description: { type: String, default: "" },
          generatedAt: { type: String, default: "" },
        },
        { _id: false }
      ),
      default: undefined,
    },

    // Mixed because the axis set is per-genre. The miner is the only writer, and
    // it only ever writes the axes the profile declares.
    scores: { type: Schema.Types.Mixed, required: true },
    totalScore: { type: Number, required: true, index: true },
    rationale: { type: String, default: "" },
    suggestedThemes: { type: [String], default: [] },

    status: {
      type: String,
      enum: ["available", "rendering", "rendered", "failed", "dismissed"],
      default: "available",
      index: true,
    },
    renderProgress: { type: Number, default: 0, min: 0, max: 100 },
    outputUrl: { type: String, trim: true },
    renderError: { type: String },
    reframeMode: { type: String, enum: ["center", "crop", "resize"] },
    reframeNote: { type: String, trim: true },
    // Free-form: a track is keyframe geometry, not a fixed shape.
    reframeTrack: { type: Schema.Types.Mixed },

    edit: { type: clipEditSchema },
    segments: { type: [clipSegmentSchema], default: undefined },
    mergedFrom: { type: [{ type: Schema.Types.ObjectId, ref: "Clip" }], default: undefined },

    outputKey: { type: String, trim: true },
    outputPath: { type: String, trim: true },
    outputBytes: { type: Number, min: 0 },
    renderedAt: { type: Date },
    renderRevision: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

clipSchema.index({ projectId: 1, rank: 1 });
clipSchema.index({ projectId: 1, kind: 1, rank: 1 });

export const Clip = model<IClip>("Clip", clipSchema);
