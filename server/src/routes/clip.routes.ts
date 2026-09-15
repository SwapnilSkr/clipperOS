import { Elysia } from "elysia";
import {
  deleteClip,
  dismissClip,
  downloadClip,
  getClip,
  getClipWords,
  getClipPauses,
  buildClipMatte,
  streamClipMatte,
  directClipRoute,
  directorFeedbackRoute,
  reviewClipRoute,
  senseClipRoute,
  mergeClips,
  previewClipReframe,
  previewClipSpan,
  streamClipSpanPreview,
  renderClips,
  updateClip,
  writeClipShareCopy,
  cleanClipCaptionsRoute,
} from "../controllers";
import {
  CleanCaptionsBody,
  ClipParams,
  ClipWordsQuery,
  PausesQuery,
  DirectClipBody,
  DirectorFeedbackBody,
  MergeClipsBody,
  PreviewReframeBody,
  PreviewSpanBody,
  ClipSpanPreviewParams,
  RenderClipsBody,
  ShareCopyBody,
  UpdateClipBody,
} from "../types/guards";

export const clipRoutes = new Elysia({ prefix: "/api/clips" })
  .post("/render", renderClips, { body: RenderClipsBody })
  // Static path, declared alongside the param route exactly as /render is.
  .post("/merge", mergeClips, { body: MergeClipsBody })
  .get("/:id", getClip, { params: ClipParams })
  .get("/:id/words", getClipWords, { params: ClipParams, query: ClipWordsQuery })
  .get("/:id/pauses", getClipPauses, { params: ClipParams, query: PausesQuery })
  .post("/:id/matte", buildClipMatte, { params: ClipParams })
  .get("/:id/matte", streamClipMatte, { params: ClipParams })
  .post("/:id/direct", directClipRoute, { params: ClipParams, body: DirectClipBody })
  .post("/:id/director/feedback", directorFeedbackRoute, { params: ClipParams, body: DirectorFeedbackBody })
  .post("/:id/sense", senseClipRoute, { params: ClipParams })
  .post("/:id/review", reviewClipRoute, { params: ClipParams })
  .get("/:id/download", downloadClip, { params: ClipParams })
  .patch("/:id", updateClip, { params: ClipParams, body: UpdateClipBody })
  .delete("/:id", deleteClip, { params: ClipParams })
  .post("/:id/dismiss", dismissClip, { params: ClipParams })
  .post("/:id/share-copy", writeClipShareCopy, { params: ClipParams, body: ShareCopyBody })
  .post("/:id/captions/clean", cleanClipCaptionsRoute, { params: ClipParams, body: CleanCaptionsBody })
  .post("/:id/reframe/preview", previewClipReframe, {
    params: ClipParams,
    body: PreviewReframeBody,
  })
  .post("/:id/preview-span", previewClipSpan, { params: ClipParams, body: PreviewSpanBody })
  .get("/:id/preview-span/:key", streamClipSpanPreview, { params: ClipSpanPreviewParams });
