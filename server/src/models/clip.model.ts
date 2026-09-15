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
  /**
   * Cached person matte (a grayscale mask video in source space) for
   * behind-subject titles. Built on demand, keyed to the analysed span, and
   * removed with the clip.
   */
  matte?: {
    path: string;
    for: { startSec: number; endSec: number; v: number; spans?: string };
    bytes?: number;
  };
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
    highlight: { type: String, enum: ["none", "word"] },
  },
  { _id: false }
);

// ---- creator mode: the beat plan ----
const speedSpanSchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    startSec: { type: Number, required: true, min: 0 },
    endSec: { type: Number, required: true, min: 0 },
    kind: { type: String, enum: ["slow", "fast", "freeze"], required: true },
    rate: { type: Number, required: true, min: 0, max: 3 },
    smooth: { type: Boolean },
    captions: { type: Boolean },
  },
  { _id: false }
);

const effectSpanSchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    effectId: { type: String, required: true, trim: true, maxlength: 40 },
    startSec: { type: Number, required: true, min: 0 },
    endSec: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0, max: 1 },
    variant: { type: String, trim: true, maxlength: 20 },
  },
  { _id: false }
);

const cutawayEdgeSchema = new Schema(
  { transitionId: { type: String, required: true, maxlength: 24 }, sec: { type: Number, required: true, min: 0, max: 1.5 } },
  { _id: false }
);
const cutawaySchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    startSec: { type: Number, required: true, min: 0 },
    endSec: { type: Number, required: true, min: 0 },
    assetId: { type: String, required: true, maxlength: 64 },
    fit: { type: String, enum: ["cover", "blur"], required: true },
    motion: { type: String, enum: ["none", "in", "out", "left", "right", "up", "down"], required: true },
    in: { type: cutawayEdgeSchema, required: true },
    out: { type: cutawayEdgeSchema, required: true },
    offsetSec: { type: Number, min: 0 },
  },
  { _id: false }
);

const pauseCutSchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    startSec: { type: Number, required: true, min: 0 },
    endSec: { type: Number, required: true, min: 0 },
    enabled: { type: Boolean, required: true },
    source: { type: String, enum: ["director", "user"], required: true },
  },
  { _id: false }
);

const cameraMoveSchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    kind: { type: String, enum: ["punch", "push", "pull", "frame", "hold"], required: true },
    startSec: { type: Number, required: true, min: 0 },
    endSec: { type: Number, required: true, min: 0 },
    zoom: { type: Number, required: true, min: 0.75, max: 1.5 },
    zoomFrom: { type: Number, min: 0.75, max: 1.5 },
    pan: { type: new Schema({ x: { type: Number, required: true }, y: { type: Number, required: true } }, { _id: false }) },
    rampSec: { type: Number, min: 0, max: 10 },
    // "face" | "center" | "look" | { x, y } — a union, so Mixed.
    anchor: { type: Schema.Types.Mixed, required: true },
    ease: { type: String, enum: ["cut", "out", "in_out"], required: true },
  },
  { _id: false }
);

const captionSceneSchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    startSec: { type: Number, required: true, min: 0 },
    endSec: { type: Number, required: true, min: 0 },
    label: { type: String, trim: true, maxlength: 40 },
    styleId: { type: String, trim: true, maxlength: 40 },
    overrides: { type: captionOverridesSchema },
  },
  { _id: false }
);

const behindTitleSchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    text: { type: String, required: true, maxlength: 120 },
    startSec: { type: Number, required: true, min: 0 },
    endSec: { type: Number, required: true, min: 0 },
    x: { type: Number, required: true, min: 0, max: 1 },
    y: { type: Number, required: true, min: 0, max: 1 },
    sizeScale: { type: Number, required: true, min: 0.3, max: 4 },
    fontFamily: { type: String, trim: true },
    color: { type: String, required: true, trim: true },
    uppercase: { type: Boolean },
    animation: { type: String, enum: ["none", "pop", "fade", "rise", "zoom_in", "zoom_out", "slide_left", "slide_right", "slide_up", "slide_down", "drop", "words"], required: true },
    depth: { type: String, enum: ["behind", "front"], required: true },
    exit: { type: String, enum: ["none", "fade", "pop", "zoom_in", "zoom_out", "slide_left", "slide_right", "slide_up", "slide_down", "sink"] },
    enterSec: { type: Number, min: 0.05, max: 3 },
    exitSec: { type: Number, min: 0.05, max: 3 },
    motion: { type: String, enum: ["none", "grow", "shrink", "pulse", "wiggle", "float"] },
    rotation: { type: Number, min: -45, max: 45 },
    outline: { type: Number, min: 0, max: 2 },
    box: {
      type: new Schema({ color: { type: String, trim: true }, opacity: { type: Number, min: 0, max: 1 } }, { _id: false }),
    },
  },
  { _id: false }
);

const creatorPlanSchema = new Schema(
  {
    enabled: { type: Boolean, required: true },
    version: { type: Number, required: true },
    cuts: { type: [pauseCutSchema], default: undefined },
    camera: {
      type: new Schema(
        {
          follow: {
            type: new Schema(
              {
                enabled: { type: Boolean, required: true },
                tightness: { type: Number, required: true, min: 0, max: 1 },
                zoom: { type: Number, min: 1, max: 1.3 },
                response: { type: String, enum: ["snappy", "natural", "smooth"] },
                axis: { type: String, enum: ["both", "x", "y"] },
                lead: { type: Number, min: 0, max: 1 },
              },
              { _id: false }
            ),
          },
          moves: { type: [cameraMoveSchema], default: [] },
        },
        { _id: false }
      ),
    },
    captionScenes: { type: [captionSceneSchema], default: undefined },
    titles: { type: [behindTitleSchema], default: undefined },
    speed: { type: [speedSpanSchema], default: undefined },
    effects: { type: [effectSpanSchema], default: undefined },
    cutaways: { type: [cutawaySchema], default: undefined },
    director: {
      type: new Schema(
        {
          notes: { type: String, maxlength: 600 },
          summary: { type: String, maxlength: 1200 },
          generatedAt: { type: String },
          model: { type: String, maxlength: 80 },
          turns: {
            type: [
              new Schema(
                {
                  notes: { type: String, maxlength: 600 },
                  summary: { type: String, maxlength: 1200 },
                  at: { type: String, maxlength: 40 },
                },
                { _id: false }
              ),
            ],
            default: undefined,
          },
        },
        { _id: false }
      ),
    },
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

const musicBedSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    assetId: { type: String, required: true, trim: true },
    gain: { type: Number, min: 0, max: 1.5 },
    inSec: { type: Number, min: 0 },
    outSec: { type: Number, min: 0 },
    offsetSec: { type: Number, min: 0 },
    fadeInSec: { type: Number, min: 0, max: 10 },
    fadeOutSec: { type: Number, min: 0, max: 10 },
    dip: { type: Number, min: 0, max: 1 },
    carryIntoOutro: { type: Boolean },
  },
  { _id: false }
);

const soundtrackSchema = new Schema(
  {
    voiceGain: { type: Number, min: 0, max: 1.5 },
    beds: { type: [musicBedSchema], default: undefined },
    // Kept so clips saved before `beds` still load; the service reads it as one bed.
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
    creator: { type: creatorPlanSchema },
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
    matte: {
      type: new Schema(
        {
          path: { type: String, required: true },
          for: {
            type: new Schema(
              {
                startSec: { type: Number, required: true },
                endSec: { type: Number, required: true },
                v: { type: Number, required: true },
                spans: { type: String, maxlength: 400 },
              },
              { _id: false }
            ),
            required: true,
          },
          bytes: { type: Number, min: 0 },
        },
        { _id: false }
      ),
    },

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
