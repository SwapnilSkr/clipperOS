// ============================================
// Shared contracts for the clipper pipeline.
//
// Genre-neutral by construction. Anything that differs between genres lives in
// a GenreProfile (config/genres.ts) and arrives here as data:
//   - scores is a keyed map, not a fixed set of axes
//   - suggestedThemes is an open string list, not a closed union
//   - the peak is a timestamp, with its text OPTIONAL (a sports play and a
//     music drop have no line to burn on screen)
// ============================================

/** One caption cue from a source transcript (YouTube auto-captions or Whisper). */
export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

/** A word with its exact spoken onset, recovered from inline caption tags. */
export interface VttWordTiming {
  /** Seconds from source-video start. */
  t: number;
  word: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Axis id -> 0-10. Which axes exist is decided per genre by the profile, so this
 * is a map rather than a fixed interface. `totalScore` is the comparable,
 * ranked value computed from it.
 */
export type ScoreMap = Record<string, number>;

// ---------------------------------------------------------------------------
// Peak
// ---------------------------------------------------------------------------

/** Paste-ready YouTube Shorts title + description for a clip. */
export interface ShareCopy {
  title: string;
  description: string;
  generatedAt: string;
}

export type PeakKind =
  /** The peak is a spoken line, burnable on screen. */
  | "line"
  /** The peak is a moment — a play, a drop, a reaction. May have no words. */
  | "moment";

// ---------------------------------------------------------------------------
// Moment mining
// ---------------------------------------------------------------------------

/** One mined clip candidate. Timestamps are seconds into the SOURCE video. */
export interface MomentCandidate {
  id: string;
  startSec: number;
  endSec: number;
  /** Verbatim transcript across [startSec, endSec]. */
  transcript: string;
  /**
   * Absolute source time of the peak — the emotional peak, the punchline, the
   * resolving play, the drop. ALWAYS set; this is what the caption emphasis and
   * (later) the music drop align to.
   */
  peakSec: number;
  /** What kind of peak this candidate has. */
  peakKind: PeakKind;
  /**
   * The peak line, VERBATIM, when one exists. Absent/empty for a `moment` peak
   * whose peak is visual or sonic rather than spoken.
   */
  peakLine?: string;
  /** Per-axis scores, keyed by the profile's axis ids. */
  scores: ScoreMap;
  /** Profile-weighted total, 0-10. Ranking key — highest first. */
  totalScore: number;
  /** One-line justification from the miner, shown in the review UI. */
  rationale: string;
  /** Suggested cutaway themes for this clip (open list, genre-provided). */
  suggestedThemes: string[];
}

// ---------------------------------------------------------------------------
// Reframing
// ---------------------------------------------------------------------------

export type ReframeMode =
  /** Fixed 9:16 center crop. Never fails. */
  | "center"
  /** Crop to a horizontally offset subject. */
  | "crop"
  /** Whole frame with a blurred pillarbox — used when two people are active. */
  | "resize";

export interface CropKeyframe {
  t: number;
  /** Center of the crop window, source pixels. */
  cx: number;
  cy: number;
  /** Crop window width in source pixels. Height derives at 9:16. */
  width: number;
  /**
   * The tracked speaker's face — centre and width in source pixels — when the
   * analyser saw one at this keyframe. A camera move anchored on the face zooms
   * toward this point, not the crop centre.
   */
  fx?: number;
  fy?: number;
  fw?: number;
}

export interface ReframeTrack {
  mode: ReframeMode;
  /**
   * Crop keyframes on the CLIP's timeline. Each entry holds until the next one,
   * so a shot cut becomes two keyframes an instant apart (a jump) while a
   * speaker handover inside one shot is emitted as a series of small steps (a
   * glide). A track with one keyframe is a fixed crop and renders in a single
   * pass; more than one renders as consecutive cropped segments.
   */
  keyframes: CropKeyframe[];
  sourceWidth: number;
  sourceHeight: number;
  /** 0-1. Below 0.4 the UI surfaces a "check framing" warning. */
  confidence: number;
  /** Which strategy produced this track (diagnostics). */
  provider: "center" | "vision" | "faces";
  note?: string;
  /**
   * Shot-change times on the CLIP timeline. The 9:16 crop snaps here so the
   * new shot is already framed — never panned into.
   */
  cuts?: number[];
  /**
   * Source timestamp of keyframe t=0. Trim/save must not change this — crop
   * times stay lined up with the picture regardless of the in/out points.
   */
  originSec?: number;
  /** Source timestamp of the last analysed frame (exclusive). */
  untilSec?: number;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * How a clip came to exist.
 *
 * `mined` is a candidate from the transcript sweep. `merge` is a clip the user
 * built by concatenating source segments — its provenance lives in `mergedFrom`
 * and its pieces in `segments`.
 */
export type ClipKind = "mined" | "merge";

/**
 * Per-clip caption styling overrides, layered on top of a CaptionStyle preset.
 * Every field is optional so an edit only records what the user actually
 * changed; the preset supplies the rest.
 */
export interface CaptionOverrides {
  /** Words grouped per caption. */
  chunkWords?: number;
  /** Multiplier on the preset's base font sizes. */
  sizeScale?: number;
  /** Caption baseline as a fraction of output height, up from the bottom. */
  verticalFrac?: number;
  /** Horizontal caption centre as a fraction of output width. */
  horizontalFrac?: number;
  textColor?: string;
  background?: "none" | "box";
  animation?: "none" | "pop" | "fade";
  peakColor?: string;
  /** When false, every caption uses the regular style — no larger/coloured peak line. */
  peakEmphasis?: boolean;
  fontFamily?: string;
  uppercase?: boolean;
  /**
   * `word` colours the word being spoken inside each caption (karaoke), using
   * `peakColor`. Absent/`none` keeps the whole caption one colour.
   */
  highlight?: "none" | "word";
}

/** A persisted edit to one generated cue, or a user-created cue. */
export interface CaptionTextOverride {
  /** Stable absolute source-time anchor for generated cues; actual start for custom cues. */
  startSec: number;
  id?: string;
  text?: string;
  /** Retimed start; `startSec` remains the stable generated-cue identity. */
  displayStartSec?: number;
  endSec?: number;
  hidden?: boolean;
  custom?: boolean;
}

/**
 * A correction on one spoken onset. Words-per-caption only groups these;
 * the text stays bound to the video timestamp.
 */
export interface CaptionWordOverride {
  t: number;
  word?: string;
  hidden?: boolean;
}

export const MAX_CAPTION_WORD_OVERRIDES = 800;

/** Whole-picture and soundtrack treatment applied after framing. */
export interface VideoEffects {
  grade?: "natural" | "vibrant" | "warm" | "cool" | "cinematic";
  motion?: "none" | "hook_push" | "peak_punch";
  /** Maximum digital punch-in. 1 is off; intentionally capped to protect quality. */
  zoom?: number;
  sharpen?: number;
  vignette?: boolean;
  audio?: "natural" | "voice" | "loud";
}

/** One hit placed on the clip timeline. `atSec` is clip-local (0 = in-point). */
export interface SoundtrackHit {
  id: string;
  assetId: string;
  atSec: number;
  gain?: number;
}

/**
 * Music bed + hits mixed under the voice. Built-in asset ids are names like
 * `warm`; uploads are `custom:<uuid>` from the shared library. Empty / omitted
 * means the source audio is left alone.
 */
export interface Soundtrack {
  voiceGain?: number;
  music?: {
    assetId: string;
    gain?: number;
    /** Duck the bed when the voice is present. Default true. */
    duck?: boolean;
    /** Keep the bed playing through the sting. Default true. */
    carryIntoOutro?: boolean;
  };
  sfx?: SoundtrackHit[];
}

export type OutroTemplateId = "lockup" | "sting" | "rise" | "card";
export type OutroTransitionId = "smash" | "punch" | "whip" | "flash" | "dip" | "blur" | "push";
export type OutroLineAnimation = "none" | "pop" | "fade";

/** Type on the sting — same knobs as burned captions, plus free placement. */
export interface OutroLineStyle {
  fontFamily?: string;
  /** Multiplier on the sting's base line size. */
  sizeScale?: number;
  textColor?: string;
  uppercase?: boolean;
  /** Extra letter-spacing, in ASS pixels. */
  spacing?: number;
  animation?: OutroLineAnimation;
  /** Horizontal centre of the line, 0 = left edge, 1 = right edge. */
  x?: number;
  /** Vertical centre of the line, 0 = top, 1 = bottom. */
  y?: number;
}

/** Logo size, centre, and optional circular avatar treatment. */
export interface OutroMarkStyle {
  sizeScale?: number;
  /** Horizontal centre of the mark, 0 = left edge, 1 = right edge. */
  x?: number;
  /** Vertical centre of the mark, 0 = top, 1 = bottom. */
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

/** One sting in the shared outro library. Any project can pick it. */
export interface ProjectOutro {
  id: string;
  /** Short label in the library and on the mix desk. */
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

// ---------------------------------------------------------------------------
// Creator mode — the beat plan
//
// Everything a human Shorts editor does PER SCENE rather than per clip: tighten
// dead air, punch in on a line, ride the speaker, change the caption look for
// the hook, put a title behind the subject, drop a whoosh on every move.
//
// Times are absolute SOURCE seconds, like the rest of the edit spec. Output
// time differs once pause cuts remove spans; `creator-timeline.ts` owns that
// mapping on both sides. An absent plan (or `enabled: false`) leaves the
// renderer on its original path, byte for byte.
// ---------------------------------------------------------------------------

/** A span of source time removed from the output (a pause, a false start). */
export interface PauseCut {
  id: string;
  startSec: number;
  endSec: number;
  /** Off keeps the candidate on the timeline without cutting it. */
  enabled: boolean;
  source: "director" | "user";
}

/**
 * The zoom curve inside [startSec, endSec]; 1 outside it.
 *
 *   punch  in to `zoom` at the start, hold, release at the end. `ease` sets the
 *          edges: `cut` is instant (a jump-cut zoom), the others ramp briefly.
 *   push   creep from 1 up to `zoom` across the span, with a short release at
 *          the end — a slow build into a line.
 *   pull   start AT `zoom` and settle back to 1 across the span — the classic
 *          opening push-in that relaxes as the hook lands.
 */
export type CameraMoveKind = "punch" | "push" | "pull";

export type CameraEase = "cut" | "out" | "in_out";

/** Where the digital zoom converges. Fractions are of the OUTPUT frame. */
export type CameraAnchor = "face" | "center" | { x: number; y: number };

export interface CameraMove {
  id: string;
  kind: CameraMoveKind;
  startSec: number;
  endSec: number;
  /** 1 is no zoom. Capped at 1.5 — beyond that a 1080p source visibly softens. */
  zoom: number;
  anchor: CameraAnchor;
  ease: CameraEase;
}

/** How quickly the follow camera answers the head: a nod, a lean, or only posture. */
export type FollowResponse = "snappy" | "natural" | "smooth";
/** Which way the camera follows. */
export type FollowAxis = "both" | "x" | "y";

export interface CameraFollow {
  enabled: boolean;
  /** 0 = today's seat-centred pan; 1 = the crop mirrors the face's motion. */
  tightness: number;
  /** A persistent punch-in that rides with the face. 1 = none. */
  zoom?: number;
  /** Default "natural". */
  response?: FollowResponse;
  /** Default "both". */
  axis?: FollowAxis;
}

export interface CameraPlan {
  follow?: CameraFollow;
  moves: CameraMove[];
}

/** A span with its own caption look, layered on the clip's preset. */
export interface CaptionScene {
  id: string;
  startSec: number;
  endSec: number;
  label?: string;
  styleId?: string;
  overrides?: CaptionOverrides;
}

export type TitleAnimation = "none" | "pop" | "fade" | "rise";

/** A free-placed title. `behind` renders it between the background and the speaker. */
export interface BehindTitle {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  /** Centre of the title, fractions of the output frame (0-1). */
  x: number;
  y: number;
  /** Multiplier on the base title size. */
  sizeScale: number;
  fontFamily?: string;
  color: string;
  uppercase?: boolean;
  animation: TitleAnimation;
  depth: "behind" | "front";
}

export interface DirectorNotes {
  /** What the user asked for on the last pass. */
  notes?: string;
  /** The Director's one-paragraph rationale for the current plan. */
  summary?: string;
  generatedAt?: string;
  model?: string;
}

export interface CreatorPlan {
  enabled: boolean;
  version: 1;
  cuts?: PauseCut[];
  camera?: CameraPlan;
  captionScenes?: CaptionScene[];
  titles?: BehindTitle[];
  director?: DirectorNotes;
}

export const MAX_PAUSE_CUTS = 40;
export const MAX_CAMERA_MOVES = 24;
export const MAX_CAPTION_SCENES = 12;
export const MAX_TITLES = 6;
/** Digital zoom ceiling. Above ~1.35 the UI warns about softness on 1080p. */
export const MAX_CAMERA_ZOOM = 1.5;
export const MAX_FOLLOW_ZOOM = 1.3;

/** Per-clip join onto a shared library sting. */
export interface ClipOutro {
  enabled?: boolean;
  transitionId?: OutroTransitionId;
  /** Which library sting to join. Absent means the project's default. */
  outroId?: string;
}

/**
 * The user's edits to a clip — a full spec, not a diff against a render.
 *
 * Timestamps are absolute SOURCE seconds so they survive re-renders and stay
 * meaningful next to the project's word onsets. When absent, the clip's mined
 * window is used, which is what keeps an unedited clip's render identical to
 * the pre-editor behaviour.
 */
export interface ClipEdit {
  trimStartSec?: number;
  trimEndSec?: number;
  reframeMode?: "center" | "smart";
  captionsOn?: boolean;
  /** Preset id from config/caption-styles.ts. Unknown ids fall back to default. */
  captionStyleId?: string;
  captionOverrides?: CaptionOverrides;
  /** User corrections to generated subtitle groups. Empty array clears them. */
  captionTextOverrides?: CaptionTextOverride[];
  /** Word-level transcript edits. Empty array clears them. */
  captionWordOverrides?: CaptionWordOverride[];
  /** The short-form recipe selected in the editor; effects remain explicit for stable renders. */
  editTemplateId?: string;
  videoEffects?: VideoEffects;
  soundtrack?: Soundtrack;
  /** How this clip joins a shared library outro. Absent means the project default. */
  outro?: ClipOutro;
  /** Burned-in text / watermark regions to reconstruct away, in source pixels. */
  cleanup?: CleanupRegion[];
  /** Creator-mode beat plan. Absent or disabled leaves the render on the original path. */
  creator?: CreatorPlan;
}

/** One ordered piece of a merge. Times are absolute SOURCE seconds. */
export interface ClipSegment {
  startSec: number;
  endSec: number;
  /** Which clip this piece came from (absent for a hand-built segment). */
  sourceClipId?: string;
  reframeMode?: "center" | "smart";
  captionStyleId?: string;
  captionsOn?: boolean;
}

// ---------------------------------------------------------------------------
// Cleanup (burned-in text / watermark removal)
// ---------------------------------------------------------------------------

/**
 * A rectangle over the SOURCE frame whose contents the renderer reconstructs
 * from the surrounding pixels, for removing burned-in captions, logos and
 * watermarks from imported footage.
 *
 * In SOURCE pixels, because the cleanup runs BEFORE the reframe crop. Times are
 * absolute SOURCE seconds — clipperOS never changes playback speed, so source and
 * output time are the same clock.
 */
export interface CleanupRegion {
  /** Stable handle for edit operations. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Active span in absolute source seconds. */
  start: number;
  end: number;
}

/** Bounds the work per render, and the size of the persisted edit spec. */
export const MAX_CLEANUP_REGIONS = 8;

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

export interface TimelineCaption {
  /** Seconds on the CLIP timeline. */
  start: number;
  end: number;
  text: string;
  /** The peak caption renders larger, in the accent colour. */
  emphasis: boolean;
  /** Spoken onsets inside this caption, clip-local. Empty for a custom cue. */
  words?: { t: number; word: string }[];
  /** Caption scene this line falls in (creator mode). Absent = the clip's look. */
  sceneId?: string;
}

export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;

/** Base caption/peak sizes the preview uses, in 1080×1920 pixels. */
export const CAPTION_BASE_FONT = 70;
export const PEAK_BASE_FONT = 91;
/**
 * libass Fontsize reads smaller than the same CSS px at weight 900, especially
 * after a 16:9→9:16 reframe. Applied only when writing ASS so the download
 * matches the editor overlay.
 */
export const ASS_FONT_SIZE_MATCH = 1.4;
export const CAPTION_SIZE_SCALE = 1;
/** Caption baseline as a fraction of output height, up from the bottom. */
export const CAPTION_VERTICAL_FRAC = 340 / OUTPUT_HEIGHT;
/** Peak accent colour. */
export const PEAK_COLOR = "#34d8ff";
/** Font used for burned captions. Must resolve via fontconfig. */
export const CAPTION_FONT = "Arial";
