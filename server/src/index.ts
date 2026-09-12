import { Elysia } from "elysia";
import { existsSync } from "node:fs";
import { cors } from "@elysiajs/cors";
import "./config/ffmpeg-bootstrap";
import { config, validateConfig } from "./config";
import { connectDatabase } from "./db";
import { captionStyleRoutes, clipRoutes, genreRoutes, projectRoutes, uploadRoutes } from "./routes";
import { assertRedisReady } from "./queue/queues";
import { startWorkers } from "./queue/workers";
import {
  sweepAbandonedUploads,
  sweepMediaFragments,
  sweepOrphanedOutputs,
  sweepUnownedLocalOutputs,
} from "./services/storage-custody.service";
import { initializeStorage, sweepProcessingDir } from "./utils";
import { getErrorMessage } from "./types";

/** How often abandoned scratch and orphaned output are reclaimed. */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Reclaim what the per-job cleanup could not: scratch left by a hard kill,
 * output whose project is gone, unowned local renders, and abandoned uploads.
 * Best-effort and never fatal — a failed sweep must not take down a server
 * that is otherwise serving requests.
 */
function runCustodySweep(label: string): void {
  void Promise.all([
    sweepProcessingDir(),
    sweepOrphanedOutputs(),
    sweepUnownedLocalOutputs(),
    sweepAbandonedUploads(),
    // Source caches are the biggest thing on disk, and a killed download leaves
    // fragments plus a status stuck on "fetching".
    sweepMediaFragments(),
  ]).catch((error: unknown) => {
    console.error(`⚠️  Storage sweep (${label}) failed: ${getErrorMessage(error)}`);
  });
}

/**
 * CORS. `origin: true` reflected ANY origin, against an API that has no auth at
 * all — so any page the user happened to visit could drive the local server.
 *
 * The dev origins and the LAN are legitimate clients (Vite runs with --host, so
 * a phone on the same network is expected). A public internet origin is not.
 * Set CORS_ORIGINS to a comma-separated list to add explicit extras.
 */
const PRIVATE_ORIGIN_HOST =
  /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

function isAllowedOrigin(origin: string | null): boolean {
  // No Origin header at all: same-origin, curl, or server-to-server.
  if (!origin) return true;
  const extra = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    return PRIVATE_ORIGIN_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const app = new Elysia({
  serve: { maxRequestBodySize: config.maxFileSizeMB * 1024 * 1024 },
})
  .use(
    cors({
      origin: (request: Request) => isAllowedOrigin(request.headers.get("origin")),
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  )

  .onError(({ error, code, set, request }) => {
    // A rejected request is the client's fault, not the server's. Mapping every
    // failure to 500 made a malformed id look like a crash, and returned the
    // driver's internal message alongside it.
    const status =
      code === "NOT_FOUND"
        ? 404
        : code === "VALIDATION" || code === "PARSE"
          ? 400
          : 500;
    set.status = status;

    // Elysia throws a compile-time NotFoundError for any unmatched path
    // (browsers asking for /favicon.ico, stray probes). Dumping that stack
    // looks like the process crashed. Keep the JSON envelope; skip the log.
    if (code !== "NOT_FOUND") {
      const where = request ? `${request.method} ${new URL(request.url).pathname}` : "";
      console.error(`Error [${code}]${where ? ` ${where}` : ""}:`, error);
    }

    return { success: false, error: getErrorMessage(error) };
  })

  // Browsers hit this when someone opens the API URL from the startup banner.
  .get("/favicon.ico", () => new Response(null, { status: 204 }))

  .get("/health", () => ({
    status: "ok",
    ts: new Date().toISOString(),
    uptime: process.uptime(),
  }))

  .get("/", () => ({
    name: "clipperOS API",
    version: "1.0.0",
    endpoints: {
      createProject: "POST /api/projects",
      upload: "POST /api/uploads",
      projects: "GET /api/projects",
      project: "GET /api/projects/:id",
      remine: "POST /api/projects/:id/remine",
      deleteProject: "DELETE /api/projects/:id",
      media: "GET /api/projects/:id/media",
      genres: "GET /api/genres",
      captionStyles: "GET /api/caption-styles",
      captionFonts: "GET /api/caption-styles/fonts",
      render: "POST /api/clips/render",
      merge: "POST /api/clips/merge",
      clip: "GET /api/clips/:id",
      words: "GET /api/clips/:id/words",
      updateClip: "PATCH /api/clips/:id",
      deleteClip: "DELETE /api/clips/:id",
      download: "GET /api/clips/:id/download",
      dismiss: "POST /api/clips/:id/dismiss",
      reconcile: "POST /api/projects/:id/reconcile",
    },
  }))

  .use(projectRoutes)
  .use(clipRoutes)
  .use(uploadRoutes)
  .use(genreRoutes)
  .use(captionStyleRoutes);

// Nothing in this process listens for a rejected promise, so a stray one from a
// background worker surfaces only as a default warning from the runtime, if at
// all. Name it and keep going rather than let it vanish.
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Unhandled promise rejection:", reason);
});

async function initialize(): Promise<void> {
  console.log("🚀 Starting clipperOS…");
  validateConfig();
  // Say which framing/cleanup path is live. Otherwise "why is every clip a centre
  // crop?" is only answerable by reading .env and the venv by hand.
  console.log(
    config.visionReframeEnabled && existsSync(config.visionPythonPath)
      ? "👁️  Vision ready — speaker tracking + watermark inpainting"
      : "👁️  Vision stack off — centre crop + delogo fallback (see VISION_REFRAME_ENABLED)"
  );
  await connectDatabase();
  await initializeStorage();
  // Reclaim anything a previous process was killed in the middle of leaving.
  runCustodySweep("boot");
  await assertRedisReady();
  console.log("🧵 Redis ready");
}

initialize()
  .then(() => {
    app.listen(config.port);
    startWorkers();
    // Non-blocking, and unref'd so it never holds the process open on its own.
    setInterval(() => runCustodySweep("interval"), SWEEP_INTERVAL_MS).unref?.();
    console.log(`
╔══════════════════════════════════════════════════╗
║  ✂️  clipperOS API                                ║
╠══════════════════════════════════════════════════╣
║  http://${config.host}:${config.port}                            ║
║  Paste a YouTube link or upload a file,           ║
║  get a ranked board of clips in under a minute.   ║
╚══════════════════════════════════════════════════╝
`);
  })
  .catch((error) => {
    console.error("Failed to start server:", getErrorMessage(error));
    process.exit(1);
  });

export type App = typeof app;
