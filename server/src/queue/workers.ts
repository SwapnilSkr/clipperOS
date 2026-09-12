import { Worker, type Job } from "bullmq";
import "../config/ffmpeg-bootstrap";
import { config } from "../config";
import { Clip, ClipProject } from "../models";
import { getErrorMessage } from "../types";
import { renderClip } from "../services/clip-render.service";
import { ingestProject } from "../services/ingest.service";
import { mineProject } from "../services/project.service";
import { redisConnection } from "./connection";
import type { ClipRenderJobData, ProjectJobData } from "./queues";
import { enqueueMining } from "./queues";

let started = false;

/**
 * Start one BullMQ worker per stage. Each calls straight into a service
 * function that already writes status/progress to Mongo; BullMQ only adds
 * persistence, retry/backoff and concurrency control around them.
 */
export function startWorkers(): void {
  if (started) return;
  started = true;

  const base = {
    connection: redisConnection,
    lockDuration: 120_000,
    stalledInterval: 30_000,
    maxStalledCount: 5,
  };

  const ingestWorker = new Worker<ProjectJobData, void, "ingest">(
    "clip-ingest",
    async (job: Job<ProjectJobData, void, "ingest">) => {
      await ingestProject(job.data.projectId);
      // Chain to mining only after a transcript exists.
      await enqueueMining(job.data.projectId);
    },
    { ...base, concurrency: 2, lockDuration: 10 * 60 * 1000 }
  );

  const miningWorker = new Worker<ProjectJobData, void, "mine">(
    "clip-mining",
    async (job: Job<ProjectJobData, void, "mine">) => {
      await mineProject(job.data.projectId, job.data.genreId);
    },
    {
      ...base,
      concurrency: 2,
      // A full-episode LLM sweep is the long pole; the default lock would expire
      // mid-mine and redeliver, re-spending credits.
      lockDuration: 40 * 60 * 1000,
      lockRenewTime: 60 * 1000,
    }
  );

  const renderWorker = new Worker<ClipRenderJobData, void, "render">(
    "clip-render",
    async (job: Job<ClipRenderData, void, "render">) => {
      await renderClip(job.data.clipId, {
        reframeMode: job.data.reframeMode,
        captions: job.data.captions,
      });
    },
    {
      ...base,
      concurrency: config.queueConcurrency,
      // A multi-pass encode plus a lazy source download can outlive the default.
      lockDuration: 30 * 60 * 1000,
      lockRenewTime: 60 * 1000,
    }
  );

  // ---- failure bookkeeping: mark the entity once retries are exhausted ----

  const finalAttempt = (job: Job | undefined): boolean => {
    if (!job) return false;
    return job.attemptsMade >= (job.opts.attempts ?? 1);
  };

  ingestWorker.on("failed", async (job, error) => {
    if (!finalAttempt(job)) return;
    await ClipProject.findByIdAndUpdate(job!.data.projectId, {
      $set: { status: "failed", stage: "Failed", error: getErrorMessage(error) },
    }).catch(() => undefined);
  });

  miningWorker.on("failed", async (job, error) => {
    if (!finalAttempt(job)) return;
    await ClipProject.findByIdAndUpdate(job!.data.projectId, {
      $set: { status: "failed", stage: "Mining failed", error: getErrorMessage(error) },
    }).catch(() => undefined);
  });

  renderWorker.on("failed", async (job, error) => {
    if (!finalAttempt(job)) return;
    await Clip.findByIdAndUpdate(job!.data.clipId, {
      $set: { status: "failed", renderProgress: 0, renderError: getErrorMessage(error) },
    }).catch(() => undefined);
  });

  for (const [name, worker] of [
    ["ingest", ingestWorker],
    ["mining", miningWorker],
    ["render", renderWorker],
  ] as const) {
    worker.on("completed", (job) => console.log(`✅ [${name}] job ${job.id} completed`));
    worker.on("failed", (job, error) =>
      console.error(`❌ [${name}] job ${job?.id} failed: ${getErrorMessage(error)}`)
    );
  }

  console.log(
    `🛠️  Workers started — ingest, mining, render (render concurrency=${config.queueConcurrency})`
  );
}

type ClipRenderData = ClipRenderJobData;
