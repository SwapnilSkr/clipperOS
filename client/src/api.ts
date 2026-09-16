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
  /** `word` colours the spoken word inside each caption (karaoke). */
  highlight?: "none" | "word";
}

// ---- creator mode: the beat plan (mirrors server/src/types/clip.types.ts) ----

export interface PauseCut {
  id: string;
  startSec: number;
  endSec: number;
  enabled: boolean;
  source: "director" | "user";
}

export type SpeedKind = "slow" | "fast" | "freeze";

export interface SpeedSpan {
  id: string;
  startSec: number;
  endSec: number;
  kind: SpeedKind;
  rate: number;
  smooth?: boolean;
  captions?: boolean;
}

export type CutawayMotion = "none" | "in" | "out" | "left" | "right" | "up" | "down";

export interface Cutaway {
  id: string;
  startSec: number;
  endSec: number;
  assetId: string;
  fit: "cover" | "blur";
  motion: CutawayMotion;
  in: { transitionId: string; sec: number };
  out: { transitionId: string; sec: number };
  offsetSec?: number;
}

/** What a picture or a sound IS, as the harness described it (server AssetSense). */
export interface AssetSense {
  line: string;
  tags: string[];
  bpm?: number;
  energy?: number;
  suits?: string[];
  /** Pictures: 1–5, and what is wrong with it; a still under 3 is never placed by the Director. */
  quality?: number;
  flaws?: string[];
  model: string;
  at: string;
}

export interface MediaAsset {
  id: string;
  kind: "image" | "video";
  source: "upload" | "pexels" | "pixabay" | "ai";
  label: string;
  width: number;
  height: number;
  durationSec?: number;
  attribution?: string;
  sourceUrl?: string;
  /** Generated assets: what was asked for. */
  prompt?: string;
  model?: string;
  sense?: AssetSense;
}

export interface TransitionInfo {
  id: string;
  label: string;
  summary: string;
}

export interface StockResult {
  source: "pexels" | "pixabay";
  id: string;
  kind: "image" | "video";
  label: string;
  width: number;
  height: number;
  durationSec?: number;
  thumbUrl: string;
  attribution: string;
  sourceUrl: string;
}

export interface EffectSpan {
  id: string;
  effectId: string;
  startSec: number;
  endSec: number;
  amount: number;
  variant?: string;
}

export type EffectGroup = "colour" | "texture" | "motion" | "glitch" | "frame";
export type CssPreview = Partial<
  Record<"grayscale" | "sepia" | "saturate" | "contrast" | "brightness" | "invert" | "blur" | "hue-rotate", [number, number]>
>;
export type PreviewLayer =
  | "grain"
  | "scanlines"
  | "rgbsplit"
  | "flicker"
  | "strobe"
  | "bars"
  | "vignette"
  | "pixelate"
  | "shake"
  | "pulse"
  | "glitch"
  | "fadeblack"
  | "fadewhite"
  | "posterize";
export interface EffectInfo {
  id: string;
  label: string;
  group: EffectGroup;
  summary: string;
  variants?: { id: string; label: string }[];
  preview: { css?: CssPreview; layers?: PreviewLayer[] };
}

export type CameraMoveKind = "punch" | "push" | "pull" | "frame" | "hold";
export type CameraEase = "cut" | "out" | "in_out";
export type CameraAnchor = "face" | "center" | "look" | { x: number; y: number };

export interface CameraMove {
  id: string;
  kind: CameraMoveKind;
  startSec: number;
  endSec: number;
  zoom: number;
  zoomFrom?: number;
  pan?: { x: number; y: number };
  rampSec?: number;
  anchor: CameraAnchor;
  ease: CameraEase;
}

export type FollowResponse = "snappy" | "natural" | "smooth";
export type FollowAxis = "both" | "x" | "y";

export interface CameraFollow {
  enabled: boolean;
  tightness: number;
  zoom?: number;
  response?: FollowResponse;
  axis?: FollowAxis;
  lead?: number;
}

export interface CameraPlan {
  follow?: CameraFollow;
  moves: CameraMove[];
}

export interface CaptionScene {
  id: string;
  startSec: number;
  endSec: number;
  label?: string;
  styleId?: string;
  overrides?: CaptionOverrides;
}

/** How a Text beat arrives. "words" reveals it word by word. */
export type TextEnter =
  | "none"
  | "pop"
  | "fade"
  | "rise"
  | "zoom_in"
  | "zoom_out"
  | "slide_left"
  | "slide_right"
  | "slide_up"
  | "slide_down"
  | "drop"
  | "words";
export type TextExit = "none" | "fade" | "pop" | "zoom_in" | "zoom_out" | "slide_left" | "slide_right" | "slide_up" | "slide_down" | "sink";
export type TextMotion = "none" | "grow" | "shrink" | "pulse" | "wiggle" | "float";
export type TitleAnimation = TextEnter;

/** A Text beat: your own caption or title on screen, separate from the transcript captions. */
export interface BehindTitle {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  x: number;
  y: number;
  sizeScale: number;
  fontFamily?: string;
  color: string;
  uppercase?: boolean;
  animation: TitleAnimation;
  depth: "behind" | "front";
  exit?: TextExit;
  enterSec?: number;
  exitSec?: number;
  motion?: TextMotion;
  /** Degrees, clockwise. */
  rotation?: number;
  /** 0 none, 1 default, up to 2. */
  outline?: number;
  box?: { color: string; opacity: number };
}

/** One Director pass: what the creator asked, what the Director said it did. */
/** A question the Director asks before it cuts: 2–4 options (none for an open question), one recommended. */
export interface DirectorAsk {
  question: string;
  header?: string;
  options?: { label: string; detail?: string }[];
  recommended?: number;
}

export interface DirectorTurn {
  notes?: string;
  summary: string;
  at: string;
  /** A "plan" turn proposed and asked; a "reply" answered a question; an "undo" took a pass back. */
  kind?: "pass" | "plan" | "reply" | "undo";
  /** Pass turns: the lanes it changed — present when the pass can be taken back. */
  changed?: DirectorLane[];
  /** Pass turns: taken back since. */
  undone?: boolean;
  questions?: string[];
  asks?: DirectorAsk[];
}

export interface DirectorNotes {
  notes?: string;
  summary?: string;
  generatedAt?: string;
  model?: string;
  /** The last passes, oldest first. */
  turns?: DirectorTurn[];
}

export interface CreatorPlan {
  enabled: boolean;
  version: 1;
  cuts?: PauseCut[];
  camera?: CameraPlan;
  captionScenes?: CaptionScene[];
  titles?: BehindTitle[];
  speed?: SpeedSpan[];
  effects?: EffectSpan[];
  cutaways?: Cutaway[];
  director?: DirectorNotes;
}

export const MAX_PAUSE_CUTS = 40;
export const MAX_SPEED_SPANS = 12;
export const MAX_EFFECT_SPANS = 24;
export const MAX_CUTAWAYS = 8;
export const MAX_TRANSITION_SEC = 1.5;
export const MIN_SPEED_RATE = 0.2;
export const MAX_SPEED_RATE = 3;
export const MAX_CAMERA_MOVES = 24;
export const MAX_CAPTION_SCENES = 12;
export const MAX_TITLES = 6;
export const MAX_CAMERA_ZOOM = 1.5;
export const MIN_CAMERA_ZOOM = 0.75;
export const MAX_FOLLOW_ZOOM = 1.3;

export type DirectorLane = "cuts" | "camera" | "speed" | "fx" | "cutaways" | "captions" | "titles" | "sfx" | "music";
export type DirectorAssetMode = "library" | "stock" | "ai" | "both";

export interface DirectInput {
  notes?: string;
  keep?: DirectorLane[];
  /** Where B-roll may come from: the library, stock, generated, or both. */
  assets?: DirectorAssetMode;
  /** Let the pass lay music beds (default true). */
  music?: boolean;
  /** Attach the clip so the model watches it (default true). */
  see?: boolean;
  /** Plan first: propose and ask, apply nothing; the next pass carries the answers. A note can switch it. */
  plan?: boolean;
  /** Options picked for the waiting proposal's questions. */
  answers?: { question: string; choice: string }[];
}

/** A stage of a Director pass, streamed while it works (server DirectorEvent). */
export type DirectorStepId = "read" | "undo" | "look" | "think" | "broll" | "sound" | "music" | "save";

export interface DirectorStep {
  id: DirectorStepId;
  state: "run" | "done" | "fail";
  label: string;
  detail?: string;
}

export type DirectorEvent =
  | ({ type: "step" } & DirectorStep)
  /** A piece of the model's thinking. */
  | { type: "thinking"; text: string }
  /** Characters of the answer written so far. */
  | { type: "writing"; chars: number };

export interface DirectClipResult {
  clip: ClipPayload;
  summary: string;
  model: string;
  warnings?: string[];
  pending?: string[];
  sense?: ClipSense;
  questions?: string[];
  asks?: DirectorAsk[];
  planned?: boolean;
  followed?: string[];
}

/** What the harness saw and heard in the clip window (server ClipSense). */
export interface ClipSense {
  for: { startSec: number; endSec: number };
  model: string;
  at: string;
  overall: string;
  shots: { start: number; end: number; framing: string; note: string; energy: number }[];
  moments: { t: number; what: string; use: string }[];
  broll: { t: number; idea: string; query: string }[];
  audio: string;
  hook: string;
  payoff: string;
}

/** The harness's critique of a rendered clip (server RenderReview). */
export interface RenderReview {
  revision: number;
  model: string;
  at: string;
  score: number;
  verdict: string;
  issues: { t?: number; what: string; fix: string }[];
  keep: string[];
}

export interface DirectorLesson {
  id: string;
  scope: string;
  kind: "edit" | "review" | "feedback";
  text: string;
  weight: number;
  clipId?: string;
  at: string;
}

export type GenerationKind = "image" | "video" | "music" | "sfx";
export interface GenerationJob {
  id: string;
  kind: GenerationKind;
  status: "queued" | "running" | "done" | "failed";
  prompt: string;
  model: string;
  aspectRatio?: string;
  durationSec?: number;
  fromAssetId?: string;
  assetId?: string;
  error?: string;
  cost?: number;
  target?: { clipId: string; cutawayId?: string; bedId?: string };
  createdAt: string;
  updatedAt: string;
}

export interface MatteInfo {
  ready: boolean;
  reason?: string;
  url?: string;
  originSec?: number;
  fps?: number;
  width?: number;
  height?: number;
}

export interface PauseCandidate extends PauseCut {
  savesSec: number;
}

export interface PauseDetectResult {
  startSec: number;
  endSec: number;
  candidates: PauseCandidate[];
  listened: boolean;
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

/** A correction on one spoken onset. Words-per-caption only groups these. */
export interface CaptionWordOverride {
  t: number;
  word?: string;
  hidden?: boolean;
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

/**
 * One music bed: a file playing under the voice for a stretch of the clip's
 * output clock. Several can play at once. Levels are linear, 1 = the file as
 * it is. (Server: MusicBed in clip.types.)
 */
export interface MusicBed {
  id: string;
  assetId: string;
  /** Default 0.22. */
  gain?: number;
  /** Where on the clip's clock it comes in. Default 0. */
  inSec?: number;
  /** Where it goes out; omitted = the end of the clip (or of the sting when it carries in). */
  outSec?: number;
  /** Where in the file it starts playing; the file loops past its end. Default 0. */
  offsetSec?: number;
  /** Fade lengths; omitted = a sixth of the span, at most 1.2 s. */
  fadeInSec?: number;
  fadeOutSec?: number;
  /** How far it dips under speech: 0 = not at all, 1 = out of the way. Default 0.6. */
  dip?: number;
  /** Keep the bed playing through the sting. Default true. */
  carryIntoOutro?: boolean;
}

export interface Soundtrack {
  voiceGain?: number;
  beds?: MusicBed[];
  sfx?: SoundtrackHit[];
}

export type OutroTemplateId = "lockup" | "sting" | "rise" | "card";
export type OutroTransitionId = "smash" | "punch" | "whip" | "flash" | "dip" | "blur" | "push";

export type OutroLineAnimation = "none" | "pop" | "fade";

export interface OutroLineStyle {
  fontFamily?: string;
  sizeScale?: number;
  textColor?: string;
  uppercase?: boolean;
  spacing?: number;
  animation?: OutroLineAnimation;
  x?: number;
  y?: number;
}

export interface OutroMarkStyle {
  sizeScale?: number;
  x?: number;
  y?: number;
  /** When true, the mark sits in a circular avatar disc; the sting animates the whole disc. */
  circle?: boolean;
}

export interface OutroPalette {
  bg: string;
  ink: string;
  accent: string;
  glow: string;
}

export interface ProjectOutro {
  id: string;
  name?: string;
  ready: boolean;
  logoName?: string;
  palette?: OutroPalette;
  templateId?: OutroTemplateId;
  durationSec?: number;
  cta?: string;
  handle?: string;
  mark?: OutroMarkStyle;
  ctaStyle?: OutroLineStyle;
  handleStyle?: OutroLineStyle;
  sfxAssetId?: string;
  musicAssetId?: string;
  sfxGain?: number;
  musicGain?: number;
  previewBytes?: number;
  updatedAt?: string;
}

export interface ClipOutro {
  enabled?: boolean;
  transitionId?: OutroTransitionId;
  outroId?: string;
}

export interface OutroTemplateInfo {
  id: OutroTemplateId;
  label: string;
  summary: string;
}

export interface OutroTransitionInfo {
  id: OutroTransitionId;
  label: string;
  summary: string;
  durationSec: number;
}

export interface OutroPayload {
  spec: ProjectOutro | null;
  items: ProjectOutro[];
  defaultOutroId?: string;
  hasLogo: boolean;
  hasPreview: boolean;
  templates: OutroTemplateInfo[];
  transitions: OutroTransitionInfo[];
  fonts?: CaptionFontInfo[];
  maxOutros?: number;
  defaults?: {
    mark: Required<OutroMarkStyle>;
    ctaStyle: Required<OutroLineStyle>;
    handleStyle: Required<OutroLineStyle>;
  };
}

export interface AudioAsset {
  id: string;
  kind: "music" | "sfx";
  label: string;
  durationSec: number;
  source?: "upload" | "ai" | "freesound";
  prompt?: string;
  attribution?: string;
  sourceUrl?: string;
  sense?: AssetSense;
}

/** A Freesound search result (server FreesoundResult). */
export interface SoundResult {
  source: "freesound";
  kind: "sfx";
  id: string;
  name: string;
  durationSec: number;
  license: string;
  needsCredit: boolean;
  username: string;
  url: string;
  previewUrl: string;
  rating: number;
  ratings: number;
  tags: string[];
}

export type LibrarySoundResult = SoundResult;


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
  /** Tracked speaker face (centre + width, source px) when the analyser saw one. */
  fx?: number;
  fy?: number;
  fw?: number;
  fyaw?: number;
  /** Pins a creator-mode hold's plateau (never from the analyser). */
  held?: boolean;
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
  captionWordOverrides?: CaptionWordOverride[];
  editTemplateId?: string;
  videoEffects?: VideoEffects;
  soundtrack?: Soundtrack;
  /** How this clip joins the project sting. Absent means attach if a sting exists. */
  outro?: ClipOutro;
  /** Burned-in text / watermark regions to remove. Empty array clears them. */
  cleanup?: CleanupRegion[];
  /** Creator-mode beat plan. Absent or disabled leaves the render on the original path. */
  creator?: CreatorPlan;
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
  /** The bundled file the burn uses, when there is one. */
  fileUrl?: string;
  /** CSS px of em per output px of our font size, as libass draws this face. */
  emScale?: number;
  /** The baseline's place in a libass line box, from its top (0..1). */
  baseline?: number;
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
  highlight?: "none" | "word";
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
  /** Default sting, for older callers. Same as the default entry in `outros`. */
  outro?: ProjectOutro;
  /** Shared outro library. The same list on every project. */
  outros?: ProjectOutro[];
  defaultOutroId?: string;
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
  shareCopy?: { title: string; description: string; generatedAt: string };
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
  /** What the harness saw in the window, and its critique of the last render it watched. */
  sense?: ClipSense;
  review?: RenderReview;
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

  generateClipShareCopy: (id: string, force = false) =>
    request<ClipPayload>(`/clips/${id}/share-copy`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }),

  cleanClipCaptions: (
    id: string,
    body?: { startSec?: number; endSec?: number; chunkWords?: number; listen?: boolean }
  ) =>
    request<{
      overrides: CaptionTextOverride[];
      wordOverrides: CaptionWordOverride[];
      changed: number;
      listened: boolean;
    }>(
      `/clips/${id}/captions/clean`,
      { method: "POST", body: JSON.stringify(body ?? {}) }
    ),

  generateProjectShareCopy: (id: string, force = false) =>
    request<{ written: number; skipped: number }>(`/projects/${id}/share-copy`, {
      method: "POST",
      body: JSON.stringify({ force }),
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

  /** Dead-air candidates inside a window, for creator mode's cut lane. */
  getClipPauses: (id: string, range?: { startSec?: number; endSec?: number }) => {
    const params = new URLSearchParams();
    if (range?.startSec != null) params.set("startSec", String(range.startSec));
    if (range?.endSec != null) params.set("endSec", String(range.endSec));
    const query = params.toString();
    return request<PauseDetectResult>(`/clips/${id}/pauses${query ? `?${query}` : ""}`);
  },

  /**
   * One Director pass: writes a beat plan (SFX hits and music beds too) for
   * the clip. Streamed — each step, its thinking and how far the answer has
   * got arrive through `onEvent` while it works; the promise holds the result.
   */
  directClip: async (id: string, input: DirectInput = {}, onEvent?: (event: DirectorEvent) => void): Promise<DirectClipResult> => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/clips/${id}/direct/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(input),
      });
    } catch {
      throw new ApiError("API unavailable — is the server running on :8787?");
    }
    if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
      const payload = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
      throw new ApiError(
        typeof payload?.error === "string" ? payload.error : typeof payload?.message === "string" ? payload.message : `Request failed (${res.status})`
      );
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const data = buffer
          .slice(0, end)
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        if (!data) continue;
        let event: DirectorEvent | { type: "done"; data: DirectClipResult } | { type: "error"; message: string };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.type === "done") return event.data;
        if (event.type === "error") throw new ApiError(event.message);
        onEvent?.(event);
      }
    }
    throw new ApiError("The connection to the server dropped before the Director finished (a server restart does this). Run it again.");
  },
  /** The harness watches the clip window (again, with force). */
  senseClip: (id: string, force = false) => request<ClipSense>(`/clips/${id}/sense${force ? "?force=1" : ""}`, { method: "POST" }),
  /** The harness watches the last render and critiques it. */
  reviewClip: (id: string) => request<RenderReview>(`/clips/${id}/review`, { method: "POST" }),
  /** A thumbs up / down on the last pass, learned as a lesson. */
  directorFeedback: (id: string, input: { verdict: "up" | "down"; note?: string; scope?: "global" | "project" }) =>
    request<{ lessons: DirectorLesson[] }>(`/clips/${id}/director/feedback`, { method: "POST", body: JSON.stringify(input) }),
  /** Take back the Director's last pass standing: its lanes, hits and beds go back to how they were before it. */
  undoDirectorPass: (id: string) => request<{ clip: ClipPayload; summary: string }>(`/clips/${id}/director/undo`, { method: "POST" }),
  listLessons: () => request<DirectorLesson[]>("/studio/lessons"),
  addLesson: (input: { text: string; scope?: string }) => request<DirectorLesson>("/studio/lessons", { method: "POST", body: JSON.stringify(input) }),
  deleteLesson: (id: string) => request<{ deleted: boolean }>(`/studio/lessons/${id}`, { method: "DELETE" }),
  /** The studio: a still, a video or a bed made on OpenRouter into the library. */
  generateAsset: (input: { kind: GenerationKind; prompt: string; aspectRatio?: string; durationSec?: number; fromAssetId?: string; label?: string }) =>
    request<GenerationJob>("/studio/generate", { method: "POST", body: JSON.stringify(input) }),
  listGenerationJobs: () => request<GenerationJob[]>("/studio/jobs"),
  senseLibrary: () => request<{ described: number; failed: number; audio: number; media: number }>("/studio/sense-library", { method: "POST" }),
  studioSources: () => request<{ freesound: boolean; fal: boolean }>("/studio/sources"),
  searchLocalSounds: (q: string, kind?: "sfx" | "music") => request<AudioAsset[]>(`/studio/sounds/local?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}`),
  searchSounds: (q: string, maxSec = 8) => request<LibrarySoundResult[]>(`/studio/sounds/search?q=${encodeURIComponent(q)}&maxSec=${maxSec}`),
  pickSound: (result: LibrarySoundResult) => request<AudioAsset>("/studio/sounds/pick", { method: "POST", body: JSON.stringify({ ...result, kind: "sfx" }) }),

  /** Build (or confirm) the person matte behind-subject titles need in the preview. */
  buildClipMatte: (id: string) =>
    request<MatteInfo>(`/clips/${id}/matte`, { method: "POST" }),

  /** The effects pack: served, so the desk, the preview and the burn agree. */
  listEffects: () => request<EffectInfo[]>("/effects"),

  /** How a cutaway may arrive and leave. */
  listTransitions: () => request<TransitionInfo[]>("/transitions"),

  /** Stills and videos for cutaways, newest first, and which stock providers have a key. */
  listMediaLibrary: () => request<{ assets: MediaAsset[]; stock: ("pexels" | "pixabay")[] }>("/media-library"),

  uploadMedia: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<MediaAsset>("/media-library", { method: "POST", body: form });
  },

  deleteMedia: (id: string) => request<{ deleted: boolean }>(`/media-library/${id}`, { method: "DELETE" }),

  searchStock: (q: string, kind: "image" | "video") =>
    request<{ results: StockResult[]; sources: ("pexels" | "pixabay")[] }>(
      `/stock/search?q=${encodeURIComponent(q)}&kind=${kind}`
    ),

  pickStock: (input: { source: "pexels" | "pixabay"; id: string; kind: "image" | "video"; query: string }) =>
    request<MediaAsset>("/stock/pick", { method: "POST", body: JSON.stringify(input) }),

  /** Render [startSec, endSec] exactly, with the stored plan; the URL streams the file. */
  previewClipSpan: (id: string, startSec: number, endSec: number) =>
    request<{ key: string; durationSec: number; url: string }>(`/clips/${id}/preview-span`, {
      method: "POST",
      body: JSON.stringify({ startSec, endSec }),
    }),

  /** The available caption looks. Served, not hardcoded. */
  listCaptionStyles: () => request<CaptionStyleInfo[]>("/caption-styles"),

  /** Faces burned captions may use. Served so the picker and the encoder agree. */
  listCaptionFonts: () => request<CaptionFontInfo[]>("/caption-styles/fonts"),

  listAudioLibrary: (projectId?: string) => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return request<{ builtin: AudioAsset[]; custom: AudioAsset[]; maxCustom?: number }>(`/audio-library${query}`);
  },

  uploadProjectAudio: async (projectId: string, file: File, kind: "music" | "sfx") => {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    return request<AudioAsset>(`/projects/${projectId}/audio`, { method: "POST", body: form });
  },

  deleteProjectAudio: (projectId: string, fileId: string) =>
    request<{ deleted: boolean }>(`/projects/${projectId}/audio/${fileId}`, { method: "DELETE" }),

  getProjectOutros: (projectId: string) => request<OutroPayload>(`/projects/${projectId}/outros`),

  createProjectOutro: (projectId: string, name?: string) =>
    request<OutroPayload>(`/projects/${projectId}/outros`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    }),

  getProjectOutro: (projectId: string, outroId: string) =>
    request<OutroPayload>(`/projects/${projectId}/outros/${outroId}`),

  updateProjectOutro: (projectId: string, outroId: string, spec: Partial<ProjectOutro> & { makeDefault?: boolean }) =>
    request<OutroPayload>(`/projects/${projectId}/outros/${outroId}`, {
      method: "PATCH",
      body: JSON.stringify(spec),
    }),

  uploadOutroLogo: async (projectId: string, outroId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<OutroPayload>(`/projects/${projectId}/outros/${outroId}/logo`, { method: "POST", body: form });
  },

  rebuildOutroPreview: (projectId: string, outroId: string) =>
    request<OutroPayload>(`/projects/${projectId}/outros/${outroId}/preview`, { method: "POST" }),

  deleteProjectOutro: (projectId: string, outroId: string) =>
    request<OutroPayload>(`/projects/${projectId}/outros/${outroId}`, { method: "DELETE" }),

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

export function clipDownloadUrl(
  clipId: string,
  options: { bust?: string; download?: boolean } = {}
): string {
  const params = new URLSearchParams();
  if (options.download) params.set("download", "1");
  if (options.bust) params.set("v", options.bust);
  const query = params.toString();
  return `${BASE}/clips/${clipId}/download${query ? `?${query}` : ""}`;
}

export function clipMatteUrl(clipId: string, bust: string): string {
  return `${BASE}/clips/${clipId}/matte?v=${encodeURIComponent(bust)}`;
}

export function mediaFileUrl(id: string): string {
  return `${BASE}/media-library/${id}/file`;
}

export function mediaThumbUrl(id: string): string {
  return `${BASE}/media-library/${id}/thumb`;
}

export function builtinAudioUrl(id: string): string {
  return `${BASE}/audio-library/${id}`;
}

export function projectAudioUrl(projectId: string, fileId: string): string {
  return `${BASE}/projects/${projectId}/audio/${fileId}`;
}

export function sharedAudioUrl(fileId: string): string {
  return `${BASE}/audio-library/custom/${fileId}`;
}

export function projectOutroPreviewUrl(projectId: string, outroId: string, bust?: string): string {
  const query = bust ? `?v=${encodeURIComponent(bust)}` : "";
  return `${BASE}/projects/${projectId}/outros/${outroId}/preview${query}`;
}

export function projectOutroLogoUrl(projectId: string, outroId: string, bust?: string): string {
  const query = bust ? `?v=${encodeURIComponent(bust)}` : "";
  return `${BASE}/projects/${projectId}/outros/${outroId}/logo${query}`;
}

export function pickProjectOutro(
  items: ProjectOutro[] | undefined,
  outroId?: string,
  defaultOutroId?: string
): ProjectOutro | undefined {
  const list = items ?? [];
  if (outroId) {
    const hit = list.find((item) => item.id === outroId);
    if (hit) return hit;
  }
  if (defaultOutroId) {
    const hit = list.find((item) => item.id === defaultOutroId);
    if (hit) return hit;
  }
  return list.find((item) => item.ready) ?? list[0];
}
