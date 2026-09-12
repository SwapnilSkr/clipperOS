import { Queue } from "bullmq";
import { redisConnection } from "./connection";

// ============================================
// Three queues, one per pipeline stage:
//
//   clip-ingest  fetch the transcript (captions or Whisper)   — fast, no media
//   clip-mining  LLM mine for ranked clip candidates          — the long pole
//   clip-render  one job per clip, on demand                  — CPU-bound
//
// Jobs are persisted in Redis, so a restart mid-pipeline redelivers rather than
// losing work.
// ============================================

const defaultJobOptions = {
  attempts: 2,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface ProjectJobData {
  projectId: string;
  /** Re-mine with a specific genre (overrides the stored one). */
  genreId?: string;
}

export interface ClipRenderJobData {
  clipId: string;
  reframeMode?: "center" | "smart";
  captions?: boolean;
}

export const clipIngestQueue = new Queue<ProjectJobData, void, "ingest">("clip-ingest", {
  connection: redisConnection,
  defaultJobOptions,
});

export const clipMiningQueue = new Queue<ProjectJobData, void, "mine">("clip-mining", {
  connection: redisConnection,
  defaultJobOptions,
});

export const clipRenderQueue = new Queue<ClipRenderJobData, void, "render">("clip-render", {
  connection: redisConnection,
  defaultJobOptions,
});

/** Re-queueing the same project is idempotent — the job id is the project id.
 *  NB: BullMQ rejects ":" in custom job ids, so separators are "-". */
export async function enqueueIngest(projectId: string): Promise<void> {
  await clipIngestQueue.add("ingest", { projectId }, { jobId: `ingest-${projectId}` });
}

export async function enqueueMining(projectId: string, genreId?: string): Promise<void> {
  // A re-mine (possibly with a different genre) must be its own job, so the id
  // carries a timestamp.
  const suffix = genreId ? `-${genreId}-${Date.now()}` : "";
  await clipMiningQueue.add("mine", { projectId, genreId }, { jobId: `mine-${projectId}${suffix}` });
}

export async function enqueueRender(
  clips: { clipId: string; reframeMode?: "center" | "smart"; captions?: boolean }[]
): Promise<void> {
  await Promise.all(
    clips.map((clip) =>
      clipRenderQueue.add("render", clip, {
        // A re-render must replace the previous job, not stack behind it.
        jobId: `render-${clip.clipId}-${Date.now()}`,
      })
    )
  );
}

/** Fail fast at boot with an actionable message when Redis is unreachable. */
export async function assertRedisReady(timeoutMs = 5000): Promise<void> {
  await Promise.race([
    clipIngestQueue.waitUntilReady(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Redis not reachable at ${process.env.REDIS_URL ?? "redis://localhost:6379"}. Start it with \`redis-server\`.`)),
        timeoutMs
      )
    ),
  ]);
}
