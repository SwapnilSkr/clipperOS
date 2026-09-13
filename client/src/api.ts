export type ProjectStatus = "pending" | "ingesting" | "mining" | "ready" | "failed";
export type ClipStatus = "available" | "rendering" | "rendered" | "failed" | "dismissed";
export type PeakKind = "line" | "moment";
/** `mined` candidate, or a clip the user built by merging others. */
export type ClipKind = "mined" | "merge";
export type ReframeMode = "center" | "smart";

export interface ScoringAxisInfo {
  id: string;
  label: string;
}

/** Per-clip caption overrides, layered on the chosen preset. */
export interface CaptionOverrides {
  chunkWords?: number;
  sizeScale?: number;
  verticalFrac?: number;
  /** Horizontal caption centre, 0 = left edge and 1 = right edge. */
  horizontalFrac?: number;
  textColor?: string;
  background?: "none" | "box";
  animation?: "none" | "pop" | "fade";
  peakColor?: string;
  /** When false, every caption uses the regular style — no larger/coloured peak line. */
  peakEmphasis?: boolean;
  fontFamily?: string;
  uppercase?: boolean;
}

export interface CaptionTextOverride {
  /** Stable source-time anchor for a generated cue; actual start for a custom cue. */
  startSec: number;
  id?: string;
  text?: string;
  displayStartSec?: number;
  endSec?: number;
  hidden?: boolean;
  custom?: boolean;
}

export interface VideoEffects {
  grade?: "natural" | "vibrant" | "warm" | "cool" | "cinematic";
  motion?: "none" | "hook_push" | "peak_punch";
  zoom?: number;
  sharpen?: number;
  vignette?: boolean;
  audio?: "natural" | "voice" | "loud";
}

export interface SoundtrackHit {
  id: string;
  assetId: string;
  atSec: number;
  gain?: number;
}

export interface Soundtrack {
  voiceGain?: number;
  music?: {
    assetId: string;
    gain?: number;
    duck?: boolean;
  };
  sfx?: SoundtrackHit[];
}

export interface AudioAsset {
  id: string;
  kind: "music" | "sfx";
  label: string;
  durationSec: number;
}

/**
 * A crop keyframe on the clip's timeline. Each holds until the next, so a shot
 * cut is two keyframes an instant apart (a jump) and a speaker handover inside
 * one shot is a series of small steps (a glide).
 */
export interface CropKeyframe {
  t: number;
  cx: number;
  cy: number;
  width: number;
}

/** The framing the renderer will use, so the preview can reproduce it exactly. */
export interface ReframeTrack {
  mode: "center" | "crop" | "resize";
  keyframes: CropKeyframe[];
  sourceWidth: number;
  sourceHeight: number;
  /** 0-1. Below 0.4 the framing is worth a second look. */
  confidence: number;
  provider: "center" | "vision" | "faces";
  note?: string;
  /** Shot-change times on the clip timeline. Crop snaps here; it does not pan. */
  cuts?: number[];
  /** Source timestamp of keyframe t=0. Independent of the live trim. */
  originSec?: number;
  /** Source timestamp of the last analysed frame (exclusive). */
  untilSec?: number;
}

/**
 * A rectangle over the SOURCE frame whose contents the renderer reconstructs,
 * for removing burned-in text, logos and watermarks. SOURCE pixels, absolute
 * SOURCE seconds, applied before the reframe crop.
 */
export interface CleanupRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  start: number;
  end: number;
}

export const MAX_CLEANUP_REGIONS = 8;

/**
 * The user's edits, as stored. Timestamps are absolute SOURCE seconds — the
 * same clock the renderer seeks on — so an edit means the same thing after any
 * number of re-renders.
 */
export interface ClipEdit {
  trimStartSec?: number;
  trimEndSec?: number;
  reframeMode?: ReframeMode;
  captionsOn?: boolean;
  captionStyleId?: string;
  captionOverrides?: CaptionOverrides;
  captionTextOverrides?: CaptionTextOverride[];
  editTemplateId?: string;
  videoEffects?: VideoEffects;
  soundtrack?: Soundtrack;
  /** Burned-in text / watermark regions to remove. Empty array clears them. */
  cleanup?: CleanupRegion[];
}

/** One ordered piece of a merge, in absolute source seconds. */
export interface ClipSegment {
  startSec: number;
  endSec: number;
  sourceClipId?: string;
  reframeMode?: ReframeMode;
  captionStyleId?: string;
  captionsOn?: boolean;
}

export interface CaptionFontInfo {
  id: string;
  label: string;
  family: string;
  stack: string;
  weight: number;
}

/** A caption look, served by GET /api/caption-styles — never hardcoded here. */
export interface CaptionStyleInfo {
  id: string;
  label: string;
  summary: string;
  chunkWords: number;
  sizeScale: number;
  verticalFrac: number;
  horizontalFrac: number;
  textColor: string;
  background: "none" | "box";
  animation: "none" | "pop" | "fade";
  peakColor: string;
  fontFamily: string;
  uppercase: boolean;
}

/** A clip's window plus the word onsets inside it, for local preview. */
export interface ClipWords {
  startSec: number;
  endSec: number;
  words: { t: number; word: string }[];
  segments?: ClipSegment[];
}

export interface ReconcileResult {
  orphans: string[];
  deleted: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
}

export interface ProjectSummary {
  id: string;
  sourceType: "youtube" | "upload";
  youtubeVideoId?: string;
  sourceUrl: string;
  title: string;
  channelTitle: string;
  thumbnailUrl?: string;
  durationSec?: number;
  status: ProjectStatus;
  stage: string;
  progress: number;
  error?: string;
  captionsAvailable: boolean;
  transcriptSource?: "youtube_captions" | "embedded_subs" | "whisper";
  mediaReady: boolean;
  mediaStatus: "absent" | "fetching" | "ready";
  mediaProgress?: number;
  mediaError?: string;
  clipCount: number;
  miningChunksTotal?: number;
  miningChunksDone?: number;
  /** Bytes held in S3/local output for this project's rendered clips. */
  storageBytes: number;
  /** Bytes held by the cached source video, if fetched. The biggest thing on disk. */
  mediaBytes?: number;
  /** Which editorial ruleset drove mining. */
  genreId: string;
  genreLabel: string;
  genreAutoDetected: boolean;
  /** Axis id + label for this genre, in display order. */
  scoringAxes: ScoringAxisInfo[];
  clipDuration: { min: number; target: number; max: number };
  timings?: { ingestMs?: number; miningMs?: number; totalMs?: number };
  createdAt: string;
}

export interface ClipPayload {
  id: string;
  projectId: string;
  rank: number;
  kind: ClipKind;
  /** User-set name. Merges always have one. */
  title?: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  transcript: string;
  peakSec: number;
  peakKind: PeakKind;
  /** Absent when the peak is a moment with no spoken line. */
  peakLine?: string;
  hookText: string;
  /** Axis id -> 0-10. Axis set comes from the project's genre. */
  scores: Record<string, number>;
  totalScore: number;
  rationale: string;
  suggestedThemes: string[];
  status: ClipStatus;
  renderProgress: number;
  outputUrl?: string;
  renderError?: string;
  reframeMode?: "center" | "crop" | "resize";
  reframeNote?: string;
  /**
   * The framing the renderer will use. Only set for a single-window clip; a merge
   * resolves one per part, so its preview falls back to a centre crop.
   */
  reframeTrack?: ReframeTrack;
  /** Persisted edits, so the editor reopens where the user left off. */
  edit?: ClipEdit;
  /** Ordered pieces of a merge. */
  segments?: ClipSegment[];
  /** Source clip ids a merge was built from. */
  mergedFrom?: string[];
  /** Size of the last render, in bytes. */
  outputBytes?: number;
  renderedAt?: string;
}

export interface ProjectDetail {
  project: ProjectSummary;
  clips: ClipPayload[];
}

export interface GenreInfo {
  id: string;
  label: string;
  summary: string;
  clipDuration: { min: number; target: number; max: number };
  captionsDefault: boolean;
  peakKind: PeakKind;
  scoringAxes: ScoringAxisInfo[];
  themes: string[];
}

const BASE = "/api";

class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: init?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError("API unavailable — is the server running on :8787?");
  }

  // The envelope is untrusted input, not a typed value. A 200 from a proxy, a
  // crashed handler, or any non-API route can return perfectly valid JSON that
  // is not an envelope at all. Declaring the type and then believing it let
  // `payload.data` be `undefined` while the caller was promised `T` — which is
  // how a stub response took the whole tree down. Require `success: true`
  // explicitly instead of only rejecting `success: false`.
  const payload = (await res.json().catch(() => null)) as unknown;

  const isEnvelope = (v: unknown): v is { success: boolean; data?: T; error?: string } =>
    typeof v === "object" && v !== null && typeof (v as { success?: unknown }).success === "boolean";

  if (!res.ok || !isEnvelope(payload) || payload.success !== true) {
    const message =
      isEnvelope(payload) && typeof payload.error === "string"
        ? payload.error
        : `Request failed (${res.status})`;
    throw new ApiError(message);
  }
  return payload.data as T;
}

export const api = {
  listProjects: () => request<ProjectSummary[]>("/projects?limit=50"),
  getProject: (id: string) => request<ProjectDetail>(`/projects/${id}`),
  deleteProject: (id: string) =>
    request<{ deleted: boolean; warning?: string }>(`/projects/${id}`, { method: "DELETE" }),

  listGenres: () => request<GenreInfo[]>("/genres"),

  createFromYoutube: (youtubeUrl: string, genreId?: string) =>
    request<ProjectSummary>("/projects", {
      method: "POST",
      body: JSON.stringify({ youtubeUrl, genreId: genreId || undefined }),
    }),

  uploadVideo: async (file: File): Promise<string> => {
    const form = new FormData();
    form.append("file", file);
    const { uploadId } = await request<{ uploadId: string }>("/uploads", {
      method: "POST",
      body: form,
    });
    return uploadId;
  },

  createFromUpload: (uploadId: string, title: string, genreId?: string) =>
    request<ProjectSummary>("/projects", {
      method: "POST",
      body: JSON.stringify({ uploadId, title, genreId: genreId || undefined }),
    }),

  /** Re-run mining, optionally under a different genre. No re-ingest. */
  remineProject: (id: string, genreId?: string) =>
    request<ProjectSummary>(`/projects/${id}/remine`, {
      method: "POST",
      body: JSON.stringify({ genreId: genreId || undefined }),
    }),

  renderClips: (
    clipIds: string[],
    reframeMode: "center" | "smart",
    captions?: boolean
  ) =>
    request<{ enqueued: number }>("/clips/render", {
      method: "POST",
      body: JSON.stringify({ clipIds, reframeMode, captions }),
    }),

  dismissClip: (id: string) =>
    request<{ dismissed: boolean }>(`/clips/${id}/dismiss`, { method: "POST" }),

  /** Persist edits without rendering — the editor can save freely. */
  updateClip: (id: string, patch: { title?: string; edit?: ClipEdit; segments?: ClipSegment[] }) =>
    request<ClipPayload>(`/clips/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  /** Purge a clip's S3 object, local render and record. Reclaims the bytes. */
  deleteClip: (id: string) =>
    request<{ deleted: boolean; freedBytes: number; warning?: string }>(`/clips/${id}`, {
      method: "DELETE",
    }),

  /** Build a merged clip. The source clips are left untouched. */
  mergeClips: (projectId: string, clipIds: string[], title?: string) =>
    request<ClipPayload>("/clips/merge", {
      method: "POST",
      body: JSON.stringify({ projectId, clipIds, title: title || undefined }),
    }),

  /** Word onsets inside a clip's window, for instant caption preview. */
  getClipWords: (id: string, range?: { startSec?: number; endSec?: number }) => {
    const params = new URLSearchParams();
    if (range?.startSec != null) params.set("startSec", String(range.startSec));
    if (range?.endSec != null) params.set("endSec", String(range.endSec));
    const query = params.toString();
    return request<ClipWords>(`/clips/${id}/words${query ? `?${query}` : ""}`);
  },

  /** The available caption looks. Served, not hardcoded. */
  listCaptionStyles: () => request<CaptionStyleInfo[]>("/caption-styles"),

  /** Faces burned captions may use. Served so the picker and the encoder agree. */
  listCaptionFonts: () => request<CaptionFontInfo[]>("/caption-styles/fonts"),

  listAudioLibrary: (projectId?: string) => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return request<{ builtin: AudioAsset[]; custom: AudioAsset[] }>(`/audio-library${query}`);
  },

  uploadProjectAudio: async (projectId: string, file: File, kind: "music" | "sfx") => {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    return request<AudioAsset>(`/projects/${projectId}/audio`, { method: "POST", body: form });
  },

  deleteProjectAudio: (projectId: string, fileId: string) =>
    request<{ deleted: boolean }>(`/projects/${projectId}/audio/${fileId}`, { method: "DELETE" }),

  /** Reclaim S3 objects no live clip owns. Dry run unless `dryRun` is false. */
  reconcileProject: (id: string, dryRun = true) =>
    request<ReconcileResult>(`/projects/${id}/reconcile?dryRun=${dryRun ? "1" : "0"}`, {
      method: "POST",
    }),

  /**
   * Start fetching the source video if it is not on this machine yet. Returns
   * immediately; the project poller reports `mediaStatus: "fetching"` and
   * `mediaProgress` until `mediaReady` is true.
   */
  ensureProjectMedia: (id: string) =>
    request<{ status: "ready" | "fetching" }>(`/projects/${id}/media/ensure`, { method: "POST" }),

  /**
   * Analyse speaker framing for the live trim so the editor's 9:16 crop matches
   * the next smart render instead of a silent centre crop.
   */
  previewClipReframe: (
    id: string,
    body?: { startSec?: number; endSec?: number; mode?: "center" | "smart" }
  ) =>
    request<ClipPayload>(`/clips/${id}/reframe/preview`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
};

export function clipDownloadUrl(clipId: string): string {
  return `${BASE}/clips/${clipId}/download`;
}

export function builtinAudioUrl(id: string): string {
  return `${BASE}/audio-library/${id}`;
}

export function projectAudioUrl(projectId: string, fileId: string): string {
  return `${BASE}/projects/${projectId}/audio/${fileId}`;
}
