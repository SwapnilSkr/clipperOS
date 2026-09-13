import { rm } from "node:fs/promises";
import { Clip, ClipProject, type IClip, type IClipProject } from "../models";
import type { ProjectOutro, ReframeTrack } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { resolveGenreProfile } from "../config/genres";
import { projectOutputDir } from "../utils";
import { deletePrefix } from "./s3.service";
import { detectGenre } from "./genre-detect.service";
import { mineMoments } from "./mining.service";
import { holdCropUntilCuts } from "./speaker-reframe.service";
import { overlaySharedOutroLibrary, pickProjectOutro } from "./outro.service";
import { generateProjectShareCopy } from "./share-copy.service";

// ---------------------------------------------------------------------------
// Mining orchestration + API serialization
// ---------------------------------------------------------------------------

/**
 * First sentence-ish unit of a transcript — shown on the board as the hook.
 *
 * Truncation lands on a word boundary. The card renders this verbatim, so a hard
 * character slice used to cut mid-word ("...taking care of your relat"), which
 * reads as broken data rather than a shortened sentence.
 */
function hookTextFor(transcript: string): string {
  const first = transcript.split(/(?<=[.?!])\s/)[0] ?? transcript;
  const clean = first.replace(/\s+/g, " ").trim();
  const LIMIT = 90;
  if (clean.length <= LIMIT) return clean;

  const clipped = clean.slice(0, LIMIT);
  const lastSpace = clipped.lastIndexOf(" ");
  // Only fall back to a hard cut if there is no usable break at all.
  const stem = lastSpace > LIMIT * 0.5 ? clipped.slice(0, lastSpace) : clipped;
  return `${stem.replace(/[,;:.\-–—]+$/, "")}…`;
}

/** A transcript slice for genre detection — long enough to hear the register. */
function transcriptSampleFor(captions: { text: string }[]): string {
  return captions
    .slice(0, 400)
    .map((c) => c.text)
    .join(" ");
}

async function setStage(
  projectId: string,
  patch: { stage?: string; progress?: number; miningChunksTotal?: number; miningChunksDone?: number }
): Promise<void> {
  await ClipProject.findByIdAndUpdate(projectId, { $set: patch });
}

/**
 * Drop every rendered artefact for a project — local output dir and the S3
 * `clips/` prefix. Best-effort: a failed cleanup must not fail a re-mine, since
 * the new clip set is what the caller actually cares about.
 */
async function clearRenderedOutput(doc: IClipProject): Promise<void> {
  const projectId = String(doc._id);
  await Promise.all([
    rm(projectOutputDir(projectId), { recursive: true, force: true }).catch(() => undefined),
    doc.storage === "s3" && doc.s3Prefix
      ? deletePrefix(`${doc.s3Prefix}clips/`).catch((error: unknown) => {
          console.warn(`⚠️  Could not clear rendered clips for ${projectId}: ${getErrorMessage(error)}`);
        })
      : Promise.resolve(),
  ]);
}

/**
 * Decide which genre profile this project mines with.
 *
 * An explicit `genreId` always wins. Otherwise detection runs once and is
 * recorded, so a re-mine doesn't pay for it again and the user can override it.
 */
export async function resolveProjectGenre(
  doc: IClipProject,
  explicitGenreId?: string
): Promise<{ genreId: string; autoDetected: boolean }> {
  if (explicitGenreId) {
    // Throws on an unknown id — a bad override should fail loudly, not silently
    // mine with the wrong rules.
    resolveGenreProfile(explicitGenreId);
    return { genreId: explicitGenreId, autoDetected: false };
  }

  if (doc.genreId && doc.genreAutoDetected === false) {
    // Already set deliberately (at creation, or by a previous explicit re-mine).
    return { genreId: doc.genreId, autoDetected: false };
  }

  await setStage(String(doc._id), { stage: "Choosing a clip style" });
  const detection = await detectGenre({
    title: doc.title,
    channelTitle: doc.channelTitle,
    transcriptSample: transcriptSampleFor(doc.captions ?? []),
  });

  if (detection.detected) {
    console.log(
      `🎭 Detected genre "${detection.genreId}"` +
        (detection.confidence !== undefined ? ` (${detection.confidence})` : "") +
        (detection.reason ? ` — ${detection.reason}` : "")
    );
  }
  return { genreId: detection.genreId, autoDetected: true };
}

/**
 * Stage 2: mine the transcript for ranked clip candidates and persist them.
 *
 * Replaces any previous clip set for the project, so this is safe to re-run —
 * and a re-mine with a different `genreId` is just another call.
 */
export async function mineProject(projectId: string, genreId?: string): Promise<number> {
  const doc = await ClipProject.findById(projectId);
  if (!doc) throw new Error(`Project not found: ${projectId}`);
  if (!doc.captions?.length) {
    throw new Error("This project has no transcript to mine");
  }

  const startedAt = Date.now();

  try {
    const genre = await resolveProjectGenre(doc, genreId);
    await ClipProject.findByIdAndUpdate(projectId, {
      $set: { genreId: genre.genreId, genreAutoDetected: genre.autoDetected },
    });

    await setStage(projectId, { stage: "Mining for clips", progress: 45 });

    const result = await mineMoments({
      captions: doc.captions,
      genreId: genre.genreId,
      targetCount: 12,
      onProgress: (done, total) => {
        // Best-effort progress write, but never a bare `void`: a rejected promise
        // here is an unhandled rejection, and nothing in the process listens for
        // one — so a transient Mongo blip could take the worker down silently.
        void setStage(projectId, {
          stage: total > 1 ? `Mining chunk ${done}/${total}` : "Finding the clips",
          progress: 45 + Math.round((done / Math.max(1, total)) * 50),
          miningChunksTotal: total,
          miningChunksDone: done,
        }).catch((error: unknown) => {
          console.warn(`⚠️  Progress write failed for ${projectId}: ${getErrorMessage(error)}`);
        });
      },
    });

    await Clip.deleteMany({ projectId });

    // Re-mining replaces the whole clip set, so any already-rendered output now
    // refers to clips that no longer exist. Renders are keyed by rank
    // (clips/1.mp4), so a smaller new set would otherwise leave orphaned higher
    // ranks behind in S3 and on disk forever.
    await clearRenderedOutput(doc);

    const clips = await Clip.insertMany(
      result.candidates.map((candidate, index) => ({
        projectId,
        rank: index + 1,
        startSec: candidate.startSec,
        endSec: candidate.endSec,
        durationSec: Math.round((candidate.endSec - candidate.startSec) * 1000) / 1000,
        transcript: candidate.transcript,
        peakSec: candidate.peakSec,
        peakKind: candidate.peakKind,
        peakLine: candidate.peakLine,
        hookText: hookTextFor(candidate.transcript),
        scores: candidate.scores,
        totalScore: candidate.totalScore,
        rationale: candidate.rationale,
        suggestedThemes: candidate.suggestedThemes,
        status: "available",
        renderProgress: 0,
      }))
    );

    if (clips.length > 0) {
      await ClipProject.findByIdAndUpdate(projectId, {
        $set: { stage: "Writing post copy", progress: 96 },
      }).catch(() => undefined);
      await generateProjectShareCopy(projectId, { force: true });
    }

    const miningMs = Date.now() - startedAt;
    const ingestMs = doc.timings?.ingestMs ?? 0;
    await ClipProject.findByIdAndUpdate(projectId, {
      $set: {
        status: "ready",
        stage: clips.length ? "Ready" : "No qualifying clips found",
        progress: 100,
        error: undefined,
        clipCount: clips.length,
        miningChunksTotal: result.chunks,
        miningChunksDone: result.chunks,
        // Every render was just purged with the old clip set.
        storageBytes: 0,
        timings: { ingestMs, miningMs, totalMs: ingestMs + miningMs },
      },
    });

    console.log(
      `✅ Project ${projectId} ready (${genre.genreId}): ${clips.length} clips ` +
        `(mining ${(miningMs / 1000).toFixed(1)}s, total ${((ingestMs + miningMs) / 1000).toFixed(1)}s)`
    );
    return clips.length;
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    await ClipProject.findByIdAndUpdate(projectId, {
      $set: { status: "failed", stage: "Mining failed", error: message },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  sourceType: IClipProject["sourceType"];
  youtubeVideoId?: string;
  sourceUrl: string;
  title: string;
  channelTitle: string;
  thumbnailUrl?: string;
  durationSec?: number;
  status: IClipProject["status"];
  stage: string;
  progress: number;
  error?: string;
  captionsAvailable: boolean;
  transcriptSource?: IClipProject["transcriptSource"];
  /** True only until the first render pulls the source video down. */
  mediaReady: boolean;
  /** Coarse source-video lifecycle. The editor uses this to show download progress. */
  mediaStatus: IClipProject["mediaStatus"];
  /** 0–100 while the source is downloading. */
  mediaProgress?: number;
  /** Last source-download failure, if any. */
  mediaError?: string;
  clipCount: number;
  miningChunksTotal?: number;
  miningChunksDone?: number;
  /** Bytes held in S3/local output for this project's rendered clips. */
  storageBytes: number;
  /**
   * Bytes held by the cached source video, if it has been fetched. Reported
   * apart from `storageBytes` because it is the largest thing on disk per project
   * and the operator should be able to see it accumulating.
   */
  mediaBytes?: number;
  /** Which editorial ruleset drove mining. */
  genreId: string;
  /** Human label for the genre, so the UI needn't carry a lookup table. */
  genreLabel: string;
  genreAutoDetected: boolean;
  /** Scoring axes for this genre, in display order — drives the clip cards. */
  scoringAxes: { id: string; label: string }[];
  /** Clip length band for this genre, seconds. */
  clipDuration: { min: number; target: number; max: number };
  timings?: IClipProject["timings"];
  createdAt: string;
  /** Default sting from the shared library. */
  outro?: ProjectOutro;
  /** Shared outro library. The same list on every project. */
  outros?: ProjectOutro[];
  defaultOutroId?: string;
}

export function serializeProject(doc: IClipProject): ProjectSummary {
  // A project always has a genre, but be defensive: a legacy row written before
  // this field existed must still serialize.
  const profile = resolveGenreProfile(doc.genreId);
  const library = overlaySharedOutroLibrary(doc);
  return {
    id: String(doc._id),
    sourceType: doc.sourceType,
    youtubeVideoId: doc.youtubeVideoId,
    sourceUrl: doc.sourceUrl,
    title: doc.title,
    channelTitle: doc.channelTitle,
    thumbnailUrl: doc.thumbnailUrl,
    durationSec: doc.durationSec,
    status: doc.status,
    stage: doc.stage,
    progress: doc.progress,
    error: doc.error,
    captionsAvailable: doc.captionsAvailable,
    transcriptSource: doc.transcriptSource,
    mediaReady: doc.mediaStatus === "ready" && Boolean(doc.mediaPath),
    mediaStatus: doc.mediaStatus ?? "absent",
    mediaProgress: doc.mediaProgress,
    mediaError: doc.mediaError,
    clipCount: doc.clipCount,
    miningChunksTotal: doc.miningChunksTotal,
    miningChunksDone: doc.miningChunksDone,
    storageBytes: doc.storageBytes ?? 0,
    mediaBytes: doc.mediaBytes,
    genreId: profile.id,
    genreLabel: profile.label,
    genreAutoDetected: doc.genreAutoDetected === true,
    scoringAxes: profile.scoringAxes.map((a) => ({ id: a.id, label: a.label })),
    clipDuration: profile.clipDuration,
    timings: doc.timings,
    createdAt: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
    outro: pickProjectOutro(library.items, undefined, library.defaultOutroId),
    outros: library.items,
    defaultOutroId: library.defaultOutroId,
  };
}

export interface ClipPayload {
  id: string;
  projectId: string;
  rank: number;
  /** `mined` candidate or a user-built `merge`. Legacy rows serialize as `mined`. */
  kind: "mined" | "merge";
  title?: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  transcript: string;
  peakSec: number;
  peakKind: IClip["peakKind"];
  /** Absent for a "moment" peak that isn't a spoken line. */
  peakLine?: string;
  hookText: string;
  shareCopy?: { title: string; description: string; generatedAt: string };
  /** Axis id -> 0-10. The axis set is the project's genre. */
  scores: Record<string, number>;
  totalScore: number;
  rationale: string;
  suggestedThemes: string[];
  status: IClip["status"];
  renderProgress: number;
  outputUrl?: string;
  renderError?: string;
  reframeMode?: IClip["reframeMode"];
  reframeNote?: string;
  /** The user's edit spec, echoed back so the editor opens where it left off. */
  edit?: IClip["edit"];
  segments?: IClip["segments"];
  mergedFrom?: string[];
  /**
   * The resolved reframe track, so the editor can reproduce the crop exactly
   * instead of letterboxing the source. Only set for a single-window clip, where
   * one track describes the whole output; a merge would need one per part.
   */
  reframeTrack?: ReframeTrack;
  /** Size of the last render, in bytes. */
  outputBytes?: number;
  renderedAt?: string;
}

export function serializeClip(doc: IClip): ClipPayload {
  return {
    id: String(doc._id),
    projectId: String(doc.projectId),
    rank: doc.rank,
    kind: doc.kind === "merge" ? "merge" : "mined",
    title: doc.title || undefined,
    startSec: doc.startSec,
    endSec: doc.endSec,
    durationSec: doc.durationSec,
    transcript: doc.transcript,
    peakSec: doc.peakSec,
    peakKind: doc.peakKind,
    peakLine: doc.peakLine || undefined,
    hookText: doc.hookText,
    shareCopy:
      doc.shareCopy?.title && doc.shareCopy.description
        ? {
            title: doc.shareCopy.title,
            description: doc.shareCopy.description,
            generatedAt: doc.shareCopy.generatedAt,
          }
        : undefined,
    scores: (doc.scores ?? {}) as Record<string, number>,
    totalScore: doc.totalScore,
    rationale: doc.rationale,
    suggestedThemes: doc.suggestedThemes ?? [],
    status: doc.status,
    renderProgress: doc.renderProgress,
    outputUrl: doc.outputUrl,
    renderError: doc.renderError,
    reframeMode: doc.reframeMode,
    reframeNote: doc.reframeNote,
    // Serialize subdocuments into plain objects field by field. Spreading a
    // Mongoose subdocument does NOT produce a plain object — it copies the
    // internal `$__` / `_doc` / `$__parent` machinery, so the client would
    // receive `{$__parent: …, $isNew: …}` instead of the edit it saved. Explicit
    // picking is also what makes hydrated (getClip) and lean (getProject) reads
    // serialize identically.
    edit: doc.edit
      ? {
          trimStartSec: doc.edit.trimStartSec,
          trimEndSec: doc.edit.trimEndSec,
          reframeMode: doc.edit.reframeMode,
          captionsOn: doc.edit.captionsOn,
          captionStyleId: doc.edit.captionStyleId,
          editTemplateId: doc.edit.editTemplateId,
          videoEffects: doc.edit.videoEffects
            ? {
                grade: doc.edit.videoEffects.grade,
                motion: doc.edit.videoEffects.motion,
                zoom: doc.edit.videoEffects.zoom,
                sharpen: doc.edit.videoEffects.sharpen,
                vignette: doc.edit.videoEffects.vignette,
                audio: doc.edit.videoEffects.audio,
              }
            : undefined,
          soundtrack: doc.edit.soundtrack
            ? {
                voiceGain: doc.edit.soundtrack.voiceGain,
                music: doc.edit.soundtrack.music
                  ? {
                      assetId: doc.edit.soundtrack.music.assetId,
                      gain: doc.edit.soundtrack.music.gain,
                      duck: doc.edit.soundtrack.music.duck,
                      carryIntoOutro: doc.edit.soundtrack.music.carryIntoOutro,
                    }
                  : undefined,
                sfx: doc.edit.soundtrack.sfx?.map((hit) => ({
                  id: hit.id,
                  assetId: hit.assetId,
                  atSec: hit.atSec,
                  gain: hit.gain,
                })),
              }
            : undefined,
          outro: doc.edit.outro
            ? {
                enabled: doc.edit.outro.enabled,
                transitionId: doc.edit.outro.transitionId,
                outroId: doc.edit.outro.outroId,
              }
            : undefined,
          captionOverrides: doc.edit.captionOverrides
            ? {
                chunkWords: doc.edit.captionOverrides.chunkWords,
                sizeScale: doc.edit.captionOverrides.sizeScale,
                verticalFrac: doc.edit.captionOverrides.verticalFrac,
                horizontalFrac: doc.edit.captionOverrides.horizontalFrac,
                textColor: doc.edit.captionOverrides.textColor,
                background: doc.edit.captionOverrides.background,
                animation: doc.edit.captionOverrides.animation,
                peakColor: doc.edit.captionOverrides.peakColor,
                peakEmphasis: doc.edit.captionOverrides.peakEmphasis,
                fontFamily: doc.edit.captionOverrides.fontFamily,
                uppercase: doc.edit.captionOverrides.uppercase,
              }
            : undefined,
          captionTextOverrides: doc.edit.captionTextOverrides?.map((item) => ({
            startSec: item.startSec,
            text: item.text,
            id: item.id,
            displayStartSec: item.displayStartSec,
            endSec: item.endSec,
            hidden: item.hidden,
            custom: item.custom,
          })),
          captionWordOverrides: doc.edit.captionWordOverrides?.map((item) => ({
            t: item.t,
            word: item.word,
            hidden: item.hidden,
          })),
          cleanup: doc.edit.cleanup?.map((region) => ({
            id: String(region.id),
            x: region.x,
            y: region.y,
            w: region.w,
            h: region.h,
            start: region.start,
            end: region.end,
          })),
        }
      : undefined,
    segments: doc.segments?.map((segment) => ({
      startSec: segment.startSec,
      endSec: segment.endSec,
      sourceClipId: segment.sourceClipId ? String(segment.sourceClipId) : undefined,
      reframeMode: segment.reframeMode,
      captionStyleId: segment.captionStyleId,
      captionsOn: segment.captionsOn,
    })),
    mergedFrom: doc.mergedFrom?.map((id) => String(id)),
    // Only a single-window clip has one track describing the whole output; a merge
    // resolves one per part, so its preview falls back to a centre crop rather
    // than showing a framing that only applies to the first segment.
    reframeTrack: doc.kind === "merge" ? undefined : doc.reframeTrack?.track
      ? holdCropUntilCuts(doc.reframeTrack.track)
      : undefined,
    outputBytes: doc.outputBytes,
    renderedAt: doc.renderedAt?.toISOString?.() ?? undefined,
  };
}
