import { Elysia } from "elysia";
import {
  deleteClip,
  dismissClip,
  downloadClip,
  getClip,
  getClipWords,
  mergeClips,
  previewClipReframe,
  renderClips,
  updateClip,
} from "../controllers";
import {
  ClipParams,
  ClipWordsQuery,
  MergeClipsBody,
  PreviewReframeBody,
  RenderClipsBody,
  UpdateClipBody,
} from "../types/guards";

export const clipRoutes = new Elysia({ prefix: "/api/clips" })
  .post("/render", renderClips, { body: RenderClipsBody })
  // Static path, declared alongside the param route exactly as /render is.
  .post("/merge", mergeClips, { body: MergeClipsBody })
  .get("/:id", getClip, { params: ClipParams })
  .get("/:id/words", getClipWords, { params: ClipParams, query: ClipWordsQuery })
  .get("/:id/download", downloadClip, { params: ClipParams })
  .patch("/:id", updateClip, { params: ClipParams, body: UpdateClipBody })
  .delete("/:id", deleteClip, { params: ClipParams })
  .post("/:id/dismiss", dismissClip, { params: ClipParams })
  .post("/:id/reframe/preview", previewClipReframe, {
    params: ClipParams,
    body: PreviewReframeBody,
  });
