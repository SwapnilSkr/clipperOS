import { Schema, model, type Document } from "mongoose";
import type { DirectorLesson } from "../types/clip.types";

// ============================================
// DIRECTOR LESSONS — the harness's taste memory.
//
// One document per thing learned: from the creator's edits after a pass,
// from a render the harness reviewed, or from a thumbs up / down with a
// note. Global lessons apply everywhere; project-scoped ones to that
// project's clips. taste.service reads and consolidates them.
// ============================================

export interface IDirectorLesson extends Document, Omit<DirectorLesson, "id"> {}

const schema = new Schema<IDirectorLesson>(
  {
    scope: { type: String, required: true, index: true },
    kind: { type: String, enum: ["edit", "review", "feedback"], required: true },
    text: { type: String, required: true, trim: true, maxlength: 400 },
    weight: { type: Number, required: true, min: 0, max: 10 },
    clipId: { type: String },
    at: { type: String, required: true },
  },
  { timestamps: false }
);

export const DirectorLessonModel = model<IDirectorLesson>("DirectorLesson", schema);
