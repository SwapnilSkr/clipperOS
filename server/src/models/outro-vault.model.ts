import { Schema, model } from "mongoose";
import type { ProjectOutro } from "../types/clip.types";

/** Singleton workspace library. Every project picks from these stings. */
export const OUTRO_VAULT_ID = "workspace";

export interface IOutroVault {
  _id: string;
  items: ProjectOutro[];
  defaultOutroId?: string;
  /** Set after one-time import of leftover per-project stings. */
  legacyImported?: boolean;
  updatedAt: Date;
}

const stingSchema = new Schema<ProjectOutro>(
  {
    id: { type: String, trim: true, maxlength: 24 },
    name: { type: String, trim: true, maxlength: 40 },
    ready: { type: Boolean, default: false },
    logoName: { type: String, trim: true, maxlength: 80 },
    palette: {
      type: new Schema(
        {
          bg: { type: String, trim: true },
          ink: { type: String, trim: true },
          accent: { type: String, trim: true },
          glow: { type: String, trim: true },
        },
        { _id: false }
      ),
    },
    templateId: { type: String, enum: ["lockup", "sting", "rise", "card"] },
    durationSec: { type: Number, min: 1.8, max: 3.2 },
    cta: { type: String, trim: true, maxlength: 42 },
    handle: { type: String, trim: true, maxlength: 32 },
    mark: {
      type: new Schema(
        {
          sizeScale: { type: Number, min: 0.35, max: 1.8 },
          x: { type: Number, min: 0, max: 1 },
          y: { type: Number, min: 0, max: 1 },
          circle: { type: Boolean },
        },
        { _id: false }
      ),
    },
    ctaStyle: {
      type: new Schema(
        {
          fontFamily: { type: String, trim: true, maxlength: 60 },
          sizeScale: { type: Number, min: 0.5, max: 2.5 },
          textColor: { type: String, trim: true },
          uppercase: { type: Boolean },
          spacing: { type: Number, min: 0, max: 16 },
          animation: { type: String, enum: ["none", "pop", "fade"] },
          x: { type: Number, min: 0, max: 1 },
          y: { type: Number, min: 0, max: 1 },
        },
        { _id: false }
      ),
    },
    handleStyle: {
      type: new Schema(
        {
          fontFamily: { type: String, trim: true, maxlength: 60 },
          sizeScale: { type: Number, min: 0.5, max: 2.5 },
          textColor: { type: String, trim: true },
          uppercase: { type: Boolean },
          spacing: { type: Number, min: 0, max: 16 },
          animation: { type: String, enum: ["none", "pop", "fade"] },
          x: { type: Number, min: 0, max: 1 },
          y: { type: Number, min: 0, max: 1 },
        },
        { _id: false }
      ),
    },
    sfxAssetId: { type: String, trim: true, maxlength: 80 },
    musicAssetId: { type: String, trim: true, maxlength: 80 },
    sfxGain: { type: Number, min: 0, max: 1.5 },
    musicGain: { type: Number, min: 0, max: 1.5 },
    previewBytes: { type: Number, min: 0 },
    updatedAt: { type: String, trim: true },
  },
  { _id: false }
);

const outroVaultSchema = new Schema<IOutroVault>(
  {
    _id: { type: String },
    items: { type: [stingSchema], default: [] },
    defaultOutroId: { type: String, trim: true, maxlength: 24 },
    legacyImported: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const OutroVault = model<IOutroVault>("OutroVault", outroVaultSchema);
