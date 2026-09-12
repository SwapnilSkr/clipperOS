import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { resolveModels } from "../config/models";
import type { ReframeTrack } from "../types/clip.types";
import { runCommand, withScratch } from "../utils";
import { analyzeSpeakerReframe } from "./speaker-reframe.service";

// ============================================
// REFRAMING — turning a 16:9 source into 1080x1920.
//
// Two strategies:
//
//   center  A fixed centre crop. Deterministic, instant, and it NEVER fails.
//           Every error path lands here.
//
//   smart   One OpenRouter vision call over a few sampled frames asks WHERE the
//           subject is. The reference implementation did this with a Python
//           YuNet + audio-RMS active-speaker pipeline, which is the single
//           heaviest part of its render. A vision model answers the same
//           question ("which third of the frame is the speaker in?") for one
//           cheap call per clip with no native toolchain at all.
//
// This is best-effort by construction: any failure degrades to `center` rather
// than failing a render.
// ============================================

const TARGET_ASPECT = 9 / 16;
/** Frames sampled per clip for the vision pass. */
const SAMPLE_FRAMES = 4;
/** Sampled frame width — enough to locate a face, small enough to stay cheap. */
const SAMPLE_WIDTH = 480;

function cropWidthFor(sourceHeight: number, sourceWidth: number): number {
  return Math.min(sourceWidth, Math.round(sourceHeight * TARGET_ASPECT));
}

/** The fixed centre crop. Valid on its own terms: non-empty, t=0, source pixels. */
export function centerReframe(
  sourceWidth: number,
  sourceHeight: number,
  note = "Centre crop"
): ReframeTrack {
  const width = cropWidthFor(sourceHeight, sourceWidth);
  return {
    mode: "center",
    keyframes: [{ t: 0, cx: sourceWidth / 2, cy: sourceHeight / 2, width }],
    sourceWidth,
    sourceHeight,
    confidence: 0.3,
    provider: "center",
    note,
  };
}

export interface ReframeInput {
  videoPath: string;
  startSec: number;
  endSec: number;
  sourceWidth: number;
  sourceHeight: number;
  mode: "center" | "smart";
}

/**
 * Confidence at or below which a provider's framing is considered shaky enough
 * to try the next one. Also what the UI uses to say "check framing".
 */
const REFRAME_ESCALATION_CONFIDENCE = 0.4;

/**
 * Choose a framing strategy, cheapest-capable first:
 *
 *   1. LOCAL face + mouth-motion analysis — understands shot cuts and who is
 *      actually talking, and costs no API call. Requires the optional vision
 *      venv; returns null when it is unavailable.
 *   2. The VISION model — the original one-call approach. Still useful as a
 *      second opinion when the face analysis was not confident (a wide shot, many
 *      faces, a screen recording).
 *   3. A fixed centre crop, which never fails.
 *
 * A provider is not assumed to be better for being heavier: whichever track is
 * actually more confident wins.
 */
export async function resolveReframe(input: ReframeInput): Promise<ReframeTrack> {
  if (input.mode === "center") {
    return centerReframe(input.sourceWidth, input.sourceHeight);
  }

  // Step 1: local analysis. It never throws; null means "not available".
  const local = await analyzeSpeakerReframe({
    videoPath: input.videoPath,
    startSec: input.startSec,
    endSec: input.endSec,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
  }).catch(() => null);

  if (local && local.track.confidence > REFRAME_ESCALATION_CONFIDENCE) {
    return local.track;
  }

  // Step 2: the vision model, as a second opinion.
  try {
    const vision = await visionReframe(input);
    if (local && local.track.confidence >= vision.confidence) return local.track;
    return vision;
  } catch (error: unknown) {
    if (local) return local.track;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Smart reframe unavailable, using centre crop. Cause: ${reason}`);
    return centerReframe(
      input.sourceWidth,
      input.sourceHeight,
      `Centre crop (${reason.slice(0, 120)})`
    );
  }
}

// ---------------------------------------------------------------------------
// Vision pass
// ---------------------------------------------------------------------------

interface VisionVerdict {
  /** Horizontal centre of the speaker, 0 = left edge, 1 = right edge. */
  centerFrac: number;
  /** True when the frame holds two roughly-equal subjects — crop would cut one. */
  twoShot: boolean;
  confidence: number;
  note?: string;
}

async function visionReframe(input: ReframeInput): Promise<ReframeTrack> {
  return withScratch("reframe-vision", async (dir) => {
    const frames = await extractSampleFrames(input, dir);
    if (frames.length === 0) throw new Error("no frames sampled");
    const verdict = await askVision(frames);
    if (!verdict) throw new Error("vision model returned no usable verdict");

    const width = cropWidthFor(input.sourceHeight, input.sourceWidth);
    const half = width / 2;
    const cx = Math.max(
      half,
      Math.min(input.sourceWidth - half, verdict.centerFrac * input.sourceWidth)
    );

    return {
      mode: "crop",
      keyframes: [{ t: 0, cx: Math.round(cx), cy: input.sourceHeight / 2, width }],
      sourceWidth: input.sourceWidth,
      sourceHeight: input.sourceHeight,
      confidence: verdict.confidence,
      provider: "vision",
      note: verdict.note ?? (verdict.twoShot ? "Close two-shot — cropped to the speaker" : "Subject-tracked crop"),
    };
  });
}

/** Extract `SAMPLE_FRAMES` evenly spaced stills across the clip, scaled down. */
async function extractSampleFrames(input: ReframeInput, dir: string): Promise<string[]> {
  const duration = Math.max(0.5, input.endSec - input.startSec);
  const fps = Math.min(SAMPLE_FRAMES / duration, 2);
  const pattern = join(dir, "frame_%02d.jpg");

  await runCommand(
    config.ffmpegPath,
    [
      "-y", "-v", "error",
      "-ss", String(input.startSec),
      "-t", String(duration),
      "-i", input.videoPath,
      "-vf", `fps=${fps},scale=${SAMPLE_WIDTH}:-2`,
      "-frames:v", String(SAMPLE_FRAMES),
      pattern,
    ],
    { label: "reframe frame sampling" }
  );

  const files: string[] = [];
  for (let i = 1; i <= SAMPLE_FRAMES; i++) {
    const path = join(dir, `frame_${String(i).padStart(2, "0")}.jpg`);
    try {
      await readFile(path);
      files.push(path);
    } catch {
      break;
    }
  }
  return files;
}

const VISION_PROMPT = `You are framing a 16:9 video for a vertical 9:16 short.

Look at these frames, sampled across one continuous clip of the same scene.

The 9:16 crop is a NARROW vertical strip — about one third of the 16:9 width. Putting it in the middle of an interview two-shot shows the table between the chairs and cuts both people.

Answer:
1. Where is the SPEAKER (the person whose mouth is moving / who is talking) located horizontally? Give centerFrac as the centre of THEIR face: 0.0 = far left edge, 0.5 = dead centre, 1.0 = far right edge. Never return the midpoint between two people.
2. Set twoShot true ONLY if both people sit close enough that a single 9:16 strip can show both faces fully. A typical interview with a gap between seats is twoShot false — crop the speaker.
3. How confident are you? 0-1.

If there is no clear person (e.g. a wide shot, a screen recording, b-roll), set centerFrac to 0.5 and confidence low.

JSON ONLY:
{"centerFrac": 0.5, "twoShot": false, "confidence": 0.8, "note": "short reason"}`;

async function askVision(framePaths: string[]): Promise<VisionVerdict | null> {
  const model = resolveModels().vision;
  const images = await Promise.all(
    framePaths.map(async (p) => ({
      type: "image_url" as const,
      image_url: { url: `data:image/jpeg;base64,${(await readFile(p)).toString("base64")}` },
    }))
  );

  const res = await fetch(`${config.openRouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: VISION_PROMPT }, ...images],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`vision request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const payload = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) return null;

  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as Partial<VisionVerdict>;
    const centerFrac = Number(parsed.centerFrac);
    if (!Number.isFinite(centerFrac)) return null;
    return {
      centerFrac: Math.max(0, Math.min(1, centerFrac)),
      twoShot: parsed.twoShot === true,
      confidence: Number.isFinite(Number(parsed.confidence))
        ? Math.max(0, Math.min(1, Number(parsed.confidence)))
        : 0.5,
      note: typeof parsed.note === "string" ? parsed.note.slice(0, 160) : undefined,
    };
  } catch {
    return null;
  }
}
