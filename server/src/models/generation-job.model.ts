import { Schema, model, type Document } from "mongoose";

// ============================================
// GENERATION JOBS — the asset studio's queue.
//
// A still, a video or a music bed being made on OpenRouter. Images and
// music finish in seconds; a video is a remote job polled for minutes, so
// the row outlives the request that started it and the client polls here.
// A finished job names the library asset it produced; a job the Director
// started may also name the cutaway or bed it should fill in when done.
// ============================================

export type GenerationKind = "image" | "video" | "music" | "sfx";
export type GenerationStatus = "queued" | "running" | "done" | "failed";

export interface IGenerationJob extends Document {
  kind: GenerationKind;
  status: GenerationStatus;
  prompt: string;
  /** The OpenRouter model that made it (`model` is taken by mongoose's Document). */
  modelId: string;
  /** "9:16", "16:9", "1:1". */
  aspectRatio?: string;
  durationSec?: number;
  /** Video from a still: the library image it animates. */
  fromAssetId?: string;
  /** The provider's job id while a video renders remotely. */
  remoteId?: string;
  /** The produced asset: a media library id, or a `custom:` audio id. */
  assetId?: string;
  error?: string;
  cost?: number;
  /** Where the Director meant to use it. */
  target?: { clipId: string; cutawayId?: string; bedId?: string };
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IGenerationJob>(
  {
    kind: { type: String, enum: ["image", "video", "music", "sfx"], required: true },
    status: { type: String, enum: ["queued", "running", "done", "failed"], required: true, index: true },
    prompt: { type: String, required: true, maxlength: 2000 },
    modelId: { type: String, required: true },
    aspectRatio: { type: String },
    durationSec: { type: Number },
    fromAssetId: { type: String },
    remoteId: { type: String },
    assetId: { type: String },
    error: { type: String },
    cost: { type: Number },
    target: {
      type: new Schema({ clipId: { type: String, required: true }, cutawayId: { type: String }, bedId: { type: String } }, { _id: false }),
    },
  },
  { timestamps: true }
);

export const GenerationJob = model<IGenerationJob>("GenerationJob", schema);
