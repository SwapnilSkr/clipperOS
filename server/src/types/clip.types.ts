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
 * `warm`; uploads are `custom:<uuid>`. Empty / omitted means the source audio
 * is left alone.
 */
export interface Soundtrack {
  voiceGain?: number;
  music?: {
    assetId: string;
    gain?: number;
    /** Duck the bed when the voice is present. Default true. */
    duck?: boolean;
  };
  sfx?: SoundtrackHit[];
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
  /** The short-form recipe selected in the editor; effects remain explicit for stable renders. */
  editTemplateId?: string;
  videoEffects?: VideoEffects;
  soundtrack?: Soundtrack;
  /** Burned-in text / watermark regions to reconstruct away, in source pixels. */
  cleanup?: CleanupRegion[];
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
}

export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;

/** Base ASS font sizes, in output pixels, that `sizeScale` multiplies. */
export const CAPTION_BASE_FONT = 70;
export const PEAK_BASE_FONT = 91;
export const CAPTION_SIZE_SCALE = 1;
/** Caption baseline as a fraction of output height, up from the bottom. */
export const CAPTION_VERTICAL_FRAC = 340 / OUTPUT_HEIGHT;
/** Peak accent colour. */
export const PEAK_COLOR = "#34d8ff";
/** Font used for burned captions. Must resolve via fontconfig. */
export const CAPTION_FONT = "Arial";
