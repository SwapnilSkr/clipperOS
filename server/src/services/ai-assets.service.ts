import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { imageModel, musicModel, videoModel } from "../config/models";
import { Clip, GenerationJob, type GenerationKind, type IGenerationJob } from "../models";
import type { MediaAsset } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { ingestMediaFile, resolveMediaFile } from "./media-library.service";
import { awaitVideo, downloadVideo, fileDataUrl, generateImage, generateMusic, startVideo } from "./openrouter.service";
import { ingestCustomAudio, listCustomAudio, type AudioAsset } from "./soundtrack.service";
import { senseAudio, senseMedia } from "./sense.service";

// ============================================
// THE ASSET STUDIO — pictures, motion and music made to order.
//
// Everything is generated on OpenRouter and lands in the same libraries
// uploads and stock do, so a generated still is a cutaway like any other, a
// generated bed sits in the Sound desk's list, and both are reusable across
// projects. Each result is described by the harness on arrival (sense), so
// the Director can pick it later by what it is.
//
//   image  gemini-3.1-flash-image (default): a still at the clip's aspect.
//   video  minimax/hailuo-3-max (default): 5–15 s from a prompt, or from a
//          library still as its first frame — the "animate this" path that
//          turns an AI image into a motion asset.
//   music  google/lyria-3-pro-preview (default): a bed, instrumental unless
//          asked otherwise; ingested as a looping custom track.
//
// Jobs are rows in GenerationJob. Images and music run to completion inside
// the request that starts them (seconds); a video is submitted and polled
// in the background for up to `VIDEO_BUDGET_MS`. A job the Director started
// carries a `target` and fills the cutaway or bed in when it completes.
// ============================================

export const VIDEO_BUDGET_MS = 12 * 60 * 1000;
export const MAX_VIDEO_SEC = 15;
export const MIN_VIDEO_SEC = 5;

export interface GenerationRequest {
  kind: GenerationKind;
  prompt: string;
  /** "9:16" (default), "16:9", "1:1". */
  aspectRatio?: string;
  /** Video only, 5–15 s. */
  durationSec?: number;
  /** Video from a library still. */
  fromAssetId?: string;
  /** The library label; defaults to the prompt's first words. */
  label?: string;
  target?: { clipId: string; cutawayId?: string; bedId?: string };
}

export interface GenerationJobInfo {
  id: string;
  kind: GenerationKind;
  status: IGenerationJob["status"];
  prompt: string;
  model: string;
  aspectRatio?: string;
  durationSec?: number;
  fromAssetId?: string;
  assetId?: string;
  error?: string;
  cost?: number;
  target?: IGenerationJob["target"];
  createdAt: string;
  updatedAt: string;
}

export function jobInfo(doc: IGenerationJob): GenerationJobInfo {
  return {
    id: String(doc._id),
    kind: doc.kind,
    status: doc.status,
    prompt: doc.prompt,
    model: doc.modelId,
    ...(doc.aspectRatio ? { aspectRatio: doc.aspectRatio } : {}),
    ...(doc.durationSec ? { durationSec: doc.durationSec } : {}),
    ...(doc.fromAssetId ? { fromAssetId: doc.fromAssetId } : {}),
    ...(doc.assetId ? { assetId: doc.assetId } : {}),
    ...(doc.error ? { error: doc.error } : {}),
    ...(doc.cost != null ? { cost: doc.cost } : {}),
    ...(doc.target ? { target: doc.target } : {}),
    createdAt: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
    updatedAt: doc.updatedAt?.toISOString?.() ?? new Date().toISOString(),
  };
}

function labelFor(request: GenerationRequest): string {
  if (request.label?.trim()) return request.label.trim().slice(0, 80);
  const words = request.prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
  return `${request.kind === "music" ? "♪ " : "✦ "}${words}`.slice(0, 80);
}

function modelFor(kind: GenerationKind): string {
  return kind === "image" ? imageModel() : kind === "video" ? videoModel() : musicModel();
}

/** The prompt the generator gets: the request, framed for a vertical short. */
export function framePrompt(request: GenerationRequest): string {
  const prompt = request.prompt.trim();
  if (request.kind === "music") {
    // Beds sit under speech: no vocals unless the creator asked.
    const wantsVocals = /\b(vocal|vocals|sing|singer|lyrics|rap)\b/i.test(prompt);
    return `${wantsVocals ? "" : "Instrumental only, no vocals, no lyrics. "}${prompt}. Made to loop under spoken voice in a short-form video: a clear, steady groove, no big dynamic swells, clean start.`;
  }
  const aspect = request.aspectRatio ?? "9:16";
  const orientation = aspect === "9:16" ? "vertical 9:16" : aspect === "16:9" ? "widescreen 16:9" : aspect;
  if (request.kind === "image") return `${prompt}. ${orientation} composition, photographic, cinematic lighting, no text, no watermark, no logos.`;
  return `${prompt}. ${orientation}, cinematic, smooth camera, no text, no watermark, no logos.`;
}

/** Start a generation; images and music complete before this resolves, a video keeps running. */
export async function startGeneration(request: GenerationRequest): Promise<GenerationJobInfo> {
  if (!config.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not set — the studio needs a model");
  const prompt = request.prompt.trim().slice(0, 2000);
  if (!prompt) throw new Error("A prompt is needed");
  const model = modelFor(request.kind);
  const aspectRatio = request.aspectRatio && /^\d+:\d+$/.test(request.aspectRatio) ? request.aspectRatio : "9:16";
  const durationSec = request.kind === "video" ? Math.max(MIN_VIDEO_SEC, Math.min(MAX_VIDEO_SEC, Math.round(request.durationSec ?? 6))) : undefined;
  const job = await GenerationJob.create({
    kind: request.kind,
    status: "running",
    prompt,
    modelId: model,
    aspectRatio,
    ...(durationSec ? { durationSec } : {}),
    ...(request.fromAssetId ? { fromAssetId: request.fromAssetId } : {}),
    ...(request.target ? { target: request.target } : {}),
  });
  const framed = framePrompt({ ...request, prompt, aspectRatio });
  const label = labelFor({ ...request, prompt });
  try {
    if (request.kind === "image") {
      await runImage(job, framed, label);
    } else if (request.kind === "music") {
      await runMusic(job, framed, label);
    } else {
      // Submitted now, finished in the background.
      const firstFrame = request.fromAssetId ? await stillDataUrl(request.fromAssetId) : undefined;
      const remote = await startVideo({ model, prompt: framed, durationSec, resolution: "768p", aspectRatio, firstFrame, generateAudio: false });
      job.remoteId = remote.id;
      await job.save();
      void finishVideo(String(job._id), label).catch((error: unknown) => console.warn(`Video job ${job._id}: ${getErrorMessage(error)}`));
    }
  } catch (error: unknown) {
    job.status = "failed";
    job.error = getErrorMessage(error).slice(0, 500);
    await job.save();
  }
  return jobInfo(job);
}

async function stillDataUrl(assetId: string): Promise<string> {
  const file = await resolveMediaFile(assetId);
  if (!file || file.asset.kind !== "image") throw new Error("The still to animate is not in the library");
  return fileDataUrl(file.path, "image/jpeg");
}

async function runImage(job: IGenerationJob, prompt: string, label: string): Promise<void> {
  const result = await generateImage({ model: job.modelId, prompt, aspectRatio: job.aspectRatio });
  const ext = result.mime.includes("jpeg") ? "jpg" : result.mime.includes("webp") ? "webp" : "png";
  const tmp = join(config.processingPath, `gen-${job._id}.${ext}`);
  try {
    await writeFile(tmp, result.bytes);
    const asset = await ingestMediaFile({ sourcePath: tmp, originalName: `${label}.${ext}`, kind: "image", source: "ai", prompt: job.prompt, model: job.modelId });
    await finish(job, asset.id, result.cost);
    void describeMedia(asset);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function runMusic(job: IGenerationJob, prompt: string, label: string): Promise<void> {
  const result = await generateMusic({ model: job.modelId, prompt, format: "wav" });
  const tmp = join(config.processingPath, `gen-${job._id}.${result.format}`);
  try {
    await writeFile(tmp, result.bytes);
    const asset = await ingestCustomAudio("none", "music", tmp, `${label}.${result.format}`, { source: "ai", prompt: job.prompt, model: job.modelId });
    await finish(job, asset.id, result.cost);
    void describeAudio(asset);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Poll the remote video job to its end, then ingest and apply it. */
async function finishVideo(jobId: string, label: string): Promise<void> {
  const job = await GenerationJob.findById(jobId);
  if (!job?.remoteId) return;
  const remote = await awaitVideo(job.remoteId, VIDEO_BUDGET_MS);
  if (!remote) {
    job.status = "failed";
    job.error = "The video took too long to render";
    await job.save();
    return;
  }
  if (remote.status !== "completed" || !remote.urls?.[0]) {
    job.status = "failed";
    job.error = (remote.error ?? "The video model failed").slice(0, 500);
    await job.save();
    return;
  }
  const tmp = join(config.processingPath, `gen-${job._id}.mp4`);
  try {
    await writeFile(tmp, await downloadVideo(remote.urls[0]));
    const asset = await ingestMediaFile({ sourcePath: tmp, originalName: `${label}.mp4`, kind: "video", source: "ai", prompt: job.prompt, model: job.modelId });
    await finish(job, asset.id, remote.cost);
    void describeMedia(asset);
  } catch (error: unknown) {
    job.status = "failed";
    job.error = getErrorMessage(error).slice(0, 500);
    await job.save();
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function finish(job: IGenerationJob, assetId: string, cost: number | undefined): Promise<void> {
  job.status = "done";
  job.assetId = assetId;
  if (cost != null) job.cost = cost;
  await job.save();
  if (job.target) await applyToTarget(job.target, job.kind, assetId);
  console.log(`✦ Generated ${job.kind} ${assetId} (${job.modelId}${cost != null ? `, $${cost.toFixed(3)}` : ""}): ${job.prompt.slice(0, 80)}`);
}

/** A finished Director-started job swaps its asset into the cutaway or bed it was made for. */
async function applyToTarget(target: NonNullable<IGenerationJob["target"]>, kind: GenerationKind, assetId: string): Promise<void> {
  const clip = await Clip.findById(target.clipId);
  if (!clip?.edit) return;
  if (target.cutawayId && kind !== "music") {
    const cutaways = clip.edit.creator?.cutaways ?? [];
    const index = cutaways.findIndex((item) => item.id === target.cutawayId);
    if (index < 0) return;
    cutaways[index] = { ...cutaways[index]!, assetId };
    await Clip.updateOne({ _id: target.clipId }, { $set: { "edit.creator.cutaways": cutaways } });
  } else if (target.bedId && kind === "music") {
    const beds = clip.edit.soundtrack?.beds ?? [];
    const index = beds.findIndex((bed) => bed.id === target.bedId);
    if (index < 0) return;
    beds[index] = { ...beds[index]!, assetId };
    await Clip.updateOne({ _id: target.clipId }, { $set: { "edit.soundtrack.beds": beds } });
  }
}

function describeMedia(asset: MediaAsset): Promise<unknown> {
  return senseMedia(asset).catch((error: unknown) => console.warn(`Could not describe generated media: ${getErrorMessage(error)}`));
}

function describeAudio(asset: AudioAsset): Promise<unknown> {
  return senseAudio(asset).catch((error: unknown) => console.warn(`Could not describe generated music: ${getErrorMessage(error)}`));
}

export async function listGenerationJobs(limit = 40): Promise<GenerationJobInfo[]> {
  const docs = await GenerationJob.find({}).sort({ createdAt: -1 }).limit(limit);
  return docs.map(jobInfo);
}

export async function getGenerationJob(id: string): Promise<GenerationJobInfo | undefined> {
  const doc = await GenerationJob.findById(id).catch(() => null);
  return doc ? jobInfo(doc) : undefined;
}

/** Video jobs left "running" by a restart are polled again. */
export async function resumeGenerationJobs(): Promise<number> {
  const running = await GenerationJob.find({ kind: "video", status: "running", remoteId: { $exists: true } });
  for (const job of running) {
    void finishVideo(String(job._id), labelFor({ kind: "video", prompt: job.prompt })).catch(() => undefined);
  }
  return running.length;
}

/** A blocking image for the Director: made now, in the library. */
export async function generateImageNow(prompt: string, aspectRatio = "9:16", target?: GenerationRequest["target"]): Promise<MediaAsset | undefined> {
  const job = await startGeneration({ kind: "image", prompt, aspectRatio, target });
  if (job.status !== "done" || !job.assetId) throw new Error(job.error ?? "Image generation failed");
  const file = await resolveMediaFile(job.assetId);
  return file?.asset;
}

/** A blocking music bed for the Director: made now, in the library. */
export async function generateMusicNow(prompt: string, target?: GenerationRequest["target"]): Promise<AudioAsset> {
  const job = await startGeneration({ kind: "music", prompt, target });
  if (job.status !== "done" || !job.assetId) throw new Error(job.error ?? "Music generation failed");
  const asset = (await listCustomAudio()).find((item) => item.id === job.assetId);
  if (!asset) throw new Error("The generated bed did not land in the library");
  return asset;
}
