import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import type { CropKeyframe, ReframeMode, ReframeTrack } from "../types/clip.types";
import { getVideoMetadata } from "./ffmpeg.service";
import { getFileSize, runCommand, withScratch } from "../utils";

// ============================================
// SPEAKER-AWARE REFRAMING — local face + mouth-motion provider.
//
// A 16:9 podcast shot has to become 1080x1920, which means choosing, moment to
// moment, WHICH person to centre on. A single fixed crop puts the seam between
// two heads — and on a clip that cuts from a speaker to a screen recording, no
// single crop is right for even half of it.
//
// The known-good approach runs an active-speaker-detection model on GPU over
// every frame. This deliberately does not. Three ideas from that design are worth
// stealing and are implemented here:
//
//   1. Sample sparsely. Faces are detected at ~3fps; speakers do not swap 30
//      times a second, so per-frame detection buys nothing for 10x the cost.
//   2. Mouth-motion energy. For each tracked face, measure frame-to-frame pixel
//      difference at the mouth, on a finer ~12fps grid (syllables are ~4-5Hz —
//      3fps is too aliased to see mouth movement at all).
//   3. Correlate that against the audio RMS envelope. The face whose mouth moves
//      in time with the audio is the speaker.
//
// Everything judgemental lives HERE, in TypeScript, not in the Python helper: the
// helper only reports faces, so a GPU provider could replace it without touching
// any of the smoothing, hysteresis or keyframe decisions below.
//
// BEST-EFFORT BY CONSTRUCTION. Any failure — disabled, no OpenCV, malformed
// video, no faces — returns null so the caller falls back, and reframing is never
// the reason a render fails.
// ============================================

/** Vertical output aspect. Crop width is derived from source height at 9:16. */
const TARGET_ASPECT = 9 / 16;

/**
 * Mouth-difference sampling rate. Detection runs at a quarter of this (~3fps);
 * the finer grid exists only because mouth motion at 3fps is aliased noise.
 */
const ANALYSIS_FPS = 12;
const DETECT_EVERY = 4;

/**
 * Frames are analysed at this width. In a 1920-wide two-shot a seated face is
 * ~90–110px; 960 keeps YuNet well above its small-face floor (a 640px pass was
 * missing the far chair and falling through to a centre crop of the table).
 */
const ANALYSIS_WIDTH = 960;

/** The "30-frame rolling average" of the GPU design, in seconds so it survives a
 *  change of sample rate. ~1s rides out a misdetection while still feeling
 *  immediate on a real handover. */
const SMOOTHING_SEC = 1.0;
/** Pearson correlation window between mouth energy and audio RMS. */
const CORRELATION_SEC = 1.2;
/** Hysteresis: a challenger must beat the incumbent by this much for this long,
 *  so a listener's single nod or laugh cannot steal the frame. */
const SWITCH_MARGIN = 0.14;
const SWITCH_HOLD_SEC = 0.6;
/** Both seats counted as active above this smoothed score (diagnostics only).
 *  Cross-talk still crops the incumbent speaker — letterboxing a two-shot puts
 *  the 9:16 window on the furniture between the chairs. */
const DUAL_ACTIVE_SCORE = 0.34;
/** Below this face-presence fraction the footage is not a talking-head shot. */
const MIN_FACE_PRESENCE = 0.4;
/** Emit a new keyframe once the target drifts this far, in source pixels.
 *  Tight values chase detector noise and the rendered concat looks like shake. */
const KEYFRAME_MOVE_PX = 48;
/** EMA factor applied to the crop centre during an in-shot glide. */
const CENTRE_EMA = 0.22;
/**
 * Face centre must stay at least this fraction of the crop width away from each
 * vertical edge. The speaker stays centred in the 9:16 frame — look-room toward
 * a listener is a snap that reads as a scene break when the shot goes
 * CU ↔ two-shot.
 */
const FACE_INNER_PAD = 0.22;
/** Source-space move larger than this at a luma-cut is a real geometry change
 *  (close-up vs two-shot). Smaller flags are lighting/zoom: keep gliding. */
const SNAP_CUT_FRACTION = 0.2;

export interface FaceObservation {
  trackId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  mouthEnergy: number;
}

export interface AnalyzerFrame {
  i: number;
  cut: boolean;
  faces: FaceObservation[];
}

interface AnalyzerResult {
  ok: boolean;
  error?: string;
  frameCount?: number;
  frames?: AnalyzerFrame[];
}

export interface SpeakerReframeInput {
  videoPath: string;
  startSec: number;
  endSec: number;
  sourceWidth: number;
  sourceHeight: number;
}

/** Diagnostics that never reach the contract but make the CPU path debuggable. */
export interface SpeakerReframeDiagnostics {
  frameCount: number;
  facePresence: number;
  meanSpeakerCorrelation: number;
  meanListenerCorrelation: number;
  meanWinnerMargin: number;
  switches: number;
  cuts: number;
  /** Seconds into the span at which the tracked subject changed WITHOUT a shot
   *  cut — a genuine in-shot handover. The most useful number when judging
   *  whether speaker attribution is working. */
  switchTimes: number[];
  cutTimes: number[];
  analysisMs: number;
}

let degradationLogged = false;

function warnOnce(reason: string): void {
  if (degradationLogged) return;
  degradationLogged = true;
  console.warn(`⚠️  Speaker-aware reframing unavailable: ${reason}`);
}

/**
 * Analyse a span and return a keyframed crop track, or null when the vision
 * stack is off/unavailable so the caller can fall back.
 */
export async function analyzeSpeakerReframe(
  input: SpeakerReframeInput
): Promise<{ track: ReframeTrack; diagnostics: SpeakerReframeDiagnostics } | null> {
  if (!config.visionReframeEnabled) return null;

  const duration = input.endSec - input.startSec;
  if (!(duration > 0) || !Number.isFinite(duration)) return null;

  const startedAt = Date.now();
  try {
    const meta = await getVideoMetadata(input.videoPath);
    const sourceWidth = meta.width || input.sourceWidth;
    const sourceHeight = meta.height || input.sourceHeight;

    return await withScratch("reframe", async (dir) => {
      const analysisHeight = evenScale(sourceHeight, ANALYSIS_WIDTH / sourceWidth);
      const framesPath = join(dir, "frames.gray");
      const audioPath = join(dir, "audio.pcm");

      const [analysis, sceneCuts] = await Promise.all([
        (async () => {
          await Promise.all([
            extractGrayFrames(input, framesPath, analysisHeight),
            extractAudio(input, audioPath),
          ]);
          return runAnalyzer({
            framesPath,
            width: ANALYSIS_WIDTH,
            height: analysisHeight,
            detectEvery: DETECT_EVERY,
            modelPath: config.visionFaceModelPath,
          });
        })(),
        detectSceneCuts(input.videoPath, input.startSec, duration),
      ]);
      if (!analysis.ok || !analysis.frames?.length) {
        warnOnce(analysis.error || "analyzer returned no frames");
        return null;
      }

      const rms = await audioRmsEnvelope(audioPath, analysis.frames.length);
      const built = buildTrack({
        frames: analysis.frames,
        rms,
        sourceWidth,
        sourceHeight,
        analysisScale: sourceWidth / ANALYSIS_WIDTH,
        sceneCuts,
      });

      return {
        track: built.track,
        diagnostics: { ...built.diagnostics, analysisMs: Date.now() - startedAt },
      };
    });
  } catch (error: unknown) {
    warnOnce(error instanceof Error ? error.message : String(error));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Decision logic. Deliberately separated from both FFmpeg and OpenCV so it can
// be exercised against synthetic observations.
// ---------------------------------------------------------------------------

/** Fixed centre crop, valid on its own terms (non-empty, t=0, source pixels). */
export function staticCentreTrack(
  sourceWidth: number,
  sourceHeight: number,
  confidence = 0.2,
  note?: string
): ReframeTrack {
  const width = cropWidthFor(sourceHeight, sourceWidth);
  return {
    mode: "center",
    keyframes: [{ t: 0, cx: sourceWidth / 2, cy: sourceHeight / 2, width }],
    sourceWidth,
    sourceHeight,
    confidence,
    provider: "center",
    note,
  };
}

function cropWidthFor(sourceHeight: number, sourceWidth: number): number {
  return Math.min(sourceWidth, Math.round(sourceHeight * TARGET_ASPECT));
}

/**
 * Snap each 12fps luma-cut onto the nearest native-fps scene change. The coarse
 * bin is often one frame late, which is enough for the new shot to play through
 * the old 9:16 window (back of a head / the table) before the crop catches up.
 */
export function alignCutTimes(coarse: number[], scene: number[]): number[] {
  const windowSec = 1 / ANALYSIS_FPS + 0.04;
  return coarse.map((t) => {
    let best = t;
    let bestDist = windowSec;
    for (const s of scene) {
      const d = Math.abs(s - t);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return Math.round(best * 10000) / 10000;
  });
}

/** One 12fps bin plus a little slack: enough to catch a late luma flag. */
const PRE_CUT_HOLD_SEC = 1 / ANALYSIS_FPS + 0.02;

/**
 * Native scene cuts the 12fps luma pass missed still split shots. The bin is
 * the first sample at or after the native PTS — the start of the new picture.
 */
function markNativeCutsOnFrames(frames: AnalyzerFrame[], sceneCuts: number[]): AnalyzerFrame[] {
  if (sceneCuts.length === 0) return frames;
  const out = frames.map((frame) => ({ ...frame }));
  for (const t of sceneCuts) {
    const i = Math.max(1, Math.min(out.length - 1, Math.ceil(t * ANALYSIS_FPS)));
    if (!out[i]) continue;
    out[i] = { ...out[i]!, cut: true };
  }
  return out;
}

/**
 * Drop crop keyframes in the 12fps bin leading into a camera cut. The decoder
 * has already shown the new faces there, so an EMA toward the incoming shot
 * applies the next crop to the outgoing picture — the remaining flash.
 */
export function holdCropUntilCuts(track: ReframeTrack): ReframeTrack {
  if (!track.cuts?.length || track.keyframes.length < 2) return track;
  const keyframes = track.keyframes.filter((keyframe) => {
    if (keyframe.t <= 1e-6) return true;
    return !track.cuts!.some((cut) => keyframe.t >= cut - PRE_CUT_HOLD_SEC && keyframe.t < cut - 1e-4);
  });
  if (keyframes.length === track.keyframes.length) return track;
  return { ...track, keyframes };
}

export function buildTrack(args: {
  frames: AnalyzerFrame[];
  rms: number[];
  sourceWidth: number;
  sourceHeight: number;
  analysisScale: number;
  /** Native-fps scene times, clip-relative. Optional so unit tests stay synthetic. */
  sceneCuts?: number[];
}): { track: ReframeTrack; diagnostics: Omit<SpeakerReframeDiagnostics, "analysisMs"> } {
  const { rms, sourceWidth, sourceHeight, analysisScale, sceneCuts } = args;
  const frames = markNativeCutsOnFrames(args.frames, sceneCuts ?? []);
  const n = frames.length;
  const cropWidth = cropWidthFor(sourceHeight, sourceWidth);
  const half = cropWidth / 2;

  const framesWithFace = frames.filter((f) => f.faces.length > 0).length;
  const facePresence = framesWithFace / n;
  const cuts = frames.filter((f) => f.cut).length;

  const emptyDiagnostics = {
    frameCount: n,
    facePresence,
    meanSpeakerCorrelation: 0,
    meanListenerCorrelation: 0,
    meanWinnerMargin: 0,
    switches: 0,
    switchTimes: [],
    cutTimes: [],
    cuts,
  };

  if (facePresence < MIN_FACE_PRESENCE) {
    return { track: staticCentreTrack(sourceWidth, sourceHeight, 0.25), diagnostics: emptyDiagnostics };
  }

  // Split the span into continuous SHOTS. Everything below is per-shot, because
  // a cut invalidates both identity and geometry: the same screen position is a
  // different person, and the framing itself has changed.
  const shots: { from: number; to: number }[] = [];
  let shotStart = 0;
  for (let i = 1; i < n; i++) {
    if (frames[i]!.cut) {
      shots.push({ from: shotStart, to: i });
      shotStart = i;
    }
  }
  shots.push({ from: shotStart, to: n });

  const smoothingWindow = Math.max(1, Math.round(SMOOTHING_SEC * ANALYSIS_FPS));
  const correlationWindow = Math.max(3, Math.round(CORRELATION_SEC * ANALYSIS_FPS));
  const holdFrames = Math.max(1, Math.round(SWITCH_HOLD_SEC * ANALYSIS_FPS));

  const chosenCx = new Array<number | null>(n).fill(null);
  const switchTimes: number[] = [];
  const coarseCuts = frames.map((f, i) => (f.cut ? i / ANALYSIS_FPS : -1)).filter((t) => t >= 0);
  const cutTimes = alignCutTimes(coarseCuts, sceneCuts ?? []);
  const snapAtCut = new Map<number, number>();
  let aligned = 0;
  for (let i = 0; i < n; i++) {
    if (!frames[i]!.cut) continue;
    snapAtCut.set(i, cutTimes[aligned] ?? i / ANALYSIS_FPS);
    aligned++;
  }

  let marginSum = 0;
  let marginCount = 0;
  let dualActiveFrames = 0;
  let speakerCorrSum = 0;
  let listenerCorrSum = 0;
  let corrCount = 0;
  let carrySpeakerX: number | null = null;

  for (const shot of shots) {
    const length = shot.to - shot.from;

    const centres: number[] = [];
    for (let i = shot.from; i < shot.to; i++) {
      for (const face of frames[i]!.faces) centres.push(face.x + face.w / 2);
    }
    if (centres.length === 0) continue;

    if (length < 2) {
      const faces = frames[shot.from]!.faces;
      const speaker = faces[0];
      if (speaker) {
        const speakerX = (speaker.x + speaker.w / 2) * analysisScale;
        chosenCx[shot.from] = composeCx({
          speakerX,
          speakerW: speaker.w * analysisScale,
          cropWidth,
          sourceWidth,
        });
        carrySpeakerX = speakerX;
      }
      continue;
    }

    centres.sort((a, b) => a - b);

    // SEATS, not tracks. The Python side hands back frame-to-frame track ids, but
    // a detector that drops a face for a beat or two retires a track and
    // re-creates it under a NEW id. Keying decisions on those ids means every
    // dropout bypasses the hysteresis and re-picks from scratch — which is
    // exactly how a crop ends up drifting through the gap between two people.
    //
    // Subjects are seated and the camera is locked within a shot, so horizontal
    // POSITION is the stable identity. Cluster face centres into seats once per
    // shot and decide between seats instead.
    const seatGap = 0.1 * ANALYSIS_WIDTH;
    const seatCentres: number[] = [];
    let bucket: number[] = [centres[0]!];
    for (let i = 1; i < centres.length; i++) {
      if (centres[i]! - centres[i - 1]! > seatGap) {
        seatCentres.push(mean(bucket));
        bucket = [];
      }
      bucket.push(centres[i]!);
    }
    seatCentres.push(mean(bucket));

    const seatCount = seatCentres.length;
    const assignGate = 0.12 * ANALYSIS_WIDTH;
    const energy = seatCentres.map(() => new Array<number>(length).fill(0));
    const present = seatCentres.map(() => new Array<boolean>(length).fill(false));
    const seatX = seatCentres.map((c) => new Array<number>(length).fill(c));
    const typicalFace = 0.1 * ANALYSIS_WIDTH;
    const seatW = seatCentres.map(() => new Array<number>(length).fill(typicalFace));

    for (let i = shot.from; i < shot.to; i++) {
      const local = i - shot.from;
      for (const face of frames[i]!.faces) {
        const centre = face.x + face.w / 2;
        let seat = -1;
        let best = assignGate;
        for (let s = 0; s < seatCount; s++) {
          const distance = Math.abs(centre - seatCentres[s]!);
          if (distance < best) {
            best = distance;
            seat = s;
          }
        }
        if (seat < 0) continue;
        // Keep the loudest mouth signal when two boxes land on one seat.
        energy[seat]![local] = Math.max(energy[seat]![local]!, face.mouthEnergy);
        present[seat]![local] = true;
        seatX[seat]![local] = centre;
        seatW[seat]![local] = face.w;
      }
      // Carry the last observed position forward so a dropout does not move the
      // crop; the seat is still there even when the detector blinks.
      for (let s = 0; s < seatCount; s++) {
        if (!present[s]![local] && local > 0) {
          seatX[s]![local] = seatX[s]![local - 1]!;
          seatW[s]![local] = seatW[s]![local - 1]!;
        }
      }
    }

    const shotRms = rms.slice(shot.from, shot.to);
    const correlation: number[][] = [];
    const raw: number[][] = [];
    for (let s = 0; s < seatCount; s++) {
      const smoothedEnergy = rollingMean(energy[s]!, smoothingWindow);
      const corr = new Array<number>(length).fill(0);
      for (let i = 0; i < length; i++) {
        corr[i] = Math.max(0, windowedPearson(energy[s]!, shotRms, i, correlationWindow));
      }
      correlation.push(corr);
      raw.push(smoothedEnergy);
    }

    // score = share of the shot's total mouth motion, modulated by how well that
    // motion tracks the audio. Relative share is the robust term (a listener's
    // face is genuinely still); correlation disambiguates when both move.
    const scored = seatCentres.map(() => new Array<number>(length).fill(0));
    for (let i = 0; i < length; i++) {
      let total = 0;
      for (let s = 0; s < seatCount; s++) total += raw[s]![i]!;
      for (let s = 0; s < seatCount; s++) {
        const share = total > 1e-6 ? raw[s]![i]! / total : 1 / seatCount;
        scored[s]![i] = share * (0.35 + 0.65 * correlation[s]![i]!);
      }
    }
    const smoothed = scored.map((series) => rollingMean(series, smoothingWindow));

    // Seed with the SAME person we were already on, so a cut from a close-up
    // to a two-shot (or back) does not flash the other chair. Talking is only
    // the tie-break when the previous face sits between two new seats.
    let current = pickOpeningSeat({
      seatCentres,
      smoothed,
      analysisScale,
      carrySpeakerX,
    });

    let challenger = -1;
    let challengeFrames = 0;
    for (let i = 0; i < length; i++) {
      if (seatCount > 1) {
        const ranked = seatCentres
          .map((_, s) => ({ s, value: smoothed[s]![i]! }))
          .sort((a, b) => b.value - a.value);
        const best = ranked[0]!;
        marginSum += best.value - ranked[1]!.value;
        marginCount++;
        if (best.value >= DUAL_ACTIVE_SCORE && ranked[1]!.value >= DUAL_ACTIVE_SCORE) {
          dualActiveFrames++;
        }
        speakerCorrSum += correlation[best.s]![i]!;
        listenerCorrSum += correlation[ranked[1]!.s]![i]!;
        corrCount++;

        if (best.s !== current && best.value - smoothed[current]![i]! > SWITCH_MARGIN) {
          if (challenger === best.s) challengeFrames++;
          else {
            challenger = best.s;
            challengeFrames = 1;
          }
          if (challengeFrames >= holdFrames) {
            current = best.s;
            challenger = -1;
            challengeFrames = 0;
            switchTimes.push((shot.from + i) / ANALYSIS_FPS);
          }
        } else {
          challenger = -1;
          challengeFrames = 0;
        }
      }
      chosenCx[shot.from + i] = composeCx({
        speakerX: seatCentres[current]! * analysisScale,
        speakerW: seatW[current]![i]! * analysisScale,
        cropWidth,
        sourceWidth,
      });
    }
    carrySpeakerX = seatCentres[current]! * analysisScale;
  }

  const mode: ReframeMode = "crop";

  const diagnostics = {
    frameCount: n,
    facePresence,
    meanSpeakerCorrelation: corrCount ? speakerCorrSum / corrCount : 0,
    meanListenerCorrelation: corrCount ? listenerCorrSum / corrCount : 0,
    meanWinnerMargin: marginCount ? marginSum / marginCount : 0,
    switches: switchTimes.length,
    switchTimes,
    cutTimes,
    cuts,
  };

  // Confidence is a genuine self-assessment, not a constant: it degrades when
  // faces are often missing, and when the subjects were barely separable.
  const confidence = clamp(0.25 + 0.45 * facePresence + 0.6 * Math.min(diagnostics.meanWinnerMargin, 0.5), 0, 1);

  const keyframes: CropKeyframe[] = [];
  const cy = sourceHeight / 2;
  let smoothCx: number | null = null;
  let lastEmitted = -Infinity;
  let lastKnownCx = sourceWidth / 2;
  for (const value of chosenCx) {
    if (value !== null) {
      lastKnownCx = value;
      break;
    }
  }

  for (let i = 0; i < n; i++) {
    const target = chosenCx[i];
    if (target !== null) lastKnownCx = target;
    const targetCx = clamp(lastKnownCx, half, sourceWidth - half);
    const t = i / ANALYSIS_FPS;

    // A shot CUT and a speaker SWITCH want opposite treatments:
    //
    //   • A real geometry change (close-up ↔ two-shot, reverse angle) must
    //     SNAP onto the speaker. Gliding would pan across the table between
    //     the chairs — the flash the editor is trying to avoid.
    //   • A luma spike that is NOT a geometry change (lighting, a mild zoom)
    //     must keep gliding. Snapping those is the one-frame jitter.
    //   • Within a continuous shot a switch still GLIDES.
    if (frames[i]!.cut && smoothCx !== null) {
      if (Math.abs(targetCx - smoothCx) > SNAP_CUT_FRACTION * cropWidth) {
        // The native scene timestamp is the PTS of the first frame in the new
        // shot. Change the crop on that exact frame. Pre-rolling by one frame
        // briefly applies the incoming crop to the outgoing shot, which reads
        // as a bright/dark flash at the edit.
        const snapAt = Math.max(0, snapAtCut.get(i) ?? t);
        while (keyframes.length > 0 && keyframes[keyframes.length - 1]!.t >= snapAt - PRE_CUT_HOLD_SEC) {
          keyframes.pop();
        }
        smoothCx = targetCx;
        keyframes.push({ t: snapAt, cx: Math.round(smoothCx), cy, width: cropWidth });
        lastEmitted = smoothCx;
        continue;
      }
    }

    if (smoothCx === null) smoothCx = targetCx;
    else smoothCx += (targetCx - smoothCx) * CENTRE_EMA;

    if (i === 0 || Math.abs(smoothCx - lastEmitted) >= KEYFRAME_MOVE_PX) {
      keyframes.push({ t, cx: Math.round(smoothCx), cy, width: cropWidth });
      lastEmitted = smoothCx;
    }
  }

  if (keyframes.length === 0 || keyframes[0]!.t !== 0) {
    keyframes.unshift({ t: 0, cx: Math.round(lastKnownCx), cy, width: cropWidth });
  }

  return {
    track: holdCropUntilCuts({
      mode,
      keyframes,
      sourceWidth,
      sourceHeight,
      confidence,
      provider: "faces",
      note: `${diagnostics.switches} speaker handover${diagnostics.switches === 1 ? "" : "s"}, ${diagnostics.cuts} cut${diagnostics.cuts === 1 ? "" : "s"}${dualActiveFrames > n * 0.35 ? " — both speaking, stayed with the active seat" : ""}`,
      cuts: cutTimes,
    }),
    diagnostics,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function rollingMean(series: number[], window: number): number[] {
  const out = new Array<number>(series.length).fill(0);
  const half = Math.floor(window / 2);
  let sum = 0;
  const queue: number[] = [];
  for (let i = 0; i < series.length + half; i++) {
    if (i < series.length) {
      sum += series[i]!;
      queue.push(series[i]!);
    }
    if (queue.length > window) sum -= queue.shift()!;
    const centre = i - half;
    if (centre >= 0 && centre < series.length) out[centre] = sum / queue.length;
  }
  return out;
}

/** Pearson correlation of two series over a window centred on `index`. */
function windowedPearson(a: number[], b: number[], index: number, window: number): number {
  const half = Math.floor(window / 2);
  const from = Math.max(0, index - half);
  const to = Math.min(a.length, index + half + 1);
  const count = to - from;
  if (count < 3) return 0;

  let sumA = 0;
  let sumB = 0;
  for (let i = from; i < to; i++) {
    sumA += a[i]!;
    sumB += b[i] ?? 0;
  }
  const meanA = sumA / count;
  const meanB = sumB / count;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = from; i < to; i++) {
    const da = a[i]! - meanA;
    const db = (b[i] ?? 0) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  return denom > 1e-9 ? cov / denom : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function evenScale(value: number, scale: number): number {
  const scaled = Math.round(value * scale);
  return scaled % 2 === 0 ? scaled : scaled + 1;
}

/**
 * Who owns the opening of a shot. Prefer the seat that continues the previous
 * speaker so a close-up → two-shot cut does not land on the listener.
 */
function pickOpeningSeat(args: {
  seatCentres: number[];
  smoothed: number[][];
  analysisScale: number;
  carrySpeakerX: number | null;
}): number {
  const { seatCentres, smoothed, analysisScale, carrySpeakerX } = args;
  const seatCount = seatCentres.length;
  if (seatCount <= 1) return 0;

  const byTalking = (): number => {
    let current = 0;
    let best = -Infinity;
    const seedTo = Math.min(smoothed[0]!.length, ANALYSIS_FPS);
    for (let s = 0; s < seatCount; s++) {
      let sum = 0;
      for (let i = 0; i < seedTo; i++) sum += smoothed[s]![i]!;
      if (sum > best) {
        best = sum;
        current = s;
      }
    }
    return current;
  };

  if (carrySpeakerX === null) return byTalking();

  const ranked = seatCentres
    .map((centre, s) => ({ s, distance: Math.abs(centre * analysisScale - carrySpeakerX) }))
    .sort((a, b) => a.distance - b.distance);
  const nearest = ranked[0]!.s;
  const talker = byTalking();
  if (talker === nearest) return nearest;

  const seedTo = Math.min(smoothed[0]!.length, ANALYSIS_FPS);
  const spoken = (seat: number) => {
    let sum = 0;
    for (let i = 0; i < seedTo; i++) sum += smoothed[seat]![i]!;
    return sum;
  };
  // Reverse angle / the other chair owns this shot: snap to them. Holding the
  // previous speaker would pan across the gap once hysteresis gave up.
  if (spoken(talker) > spoken(nearest) + SWITCH_MARGIN * seedTo) {
    return talker;
  }
  return nearest;
}

/**
 * Place the 9:16 window on the speaker's face. A two-shot whose seats are
 * farther apart than the crop is NEVER centred on the gap — that is the
 * coffee-table crop. The speaker stays in the same place in the output when
 * the source cuts CU ↔ two-shot, so the cut reads as a zoom around them
 * rather than a reframe onto the other chair.
 */
function composeCx(args: {
  speakerX: number;
  speakerW: number;
  cropWidth: number;
  sourceWidth: number;
}): number {
  const { speakerX, speakerW, cropWidth, sourceWidth } = args;
  const half = cropWidth / 2;
  const innerPad = Math.max(speakerW * 0.55, cropWidth * FACE_INNER_PAD);

  let cx = clamp(speakerX, half, sourceWidth - half);
  const minCx = speakerX + innerPad - half;
  const maxCx = speakerX - innerPad + half;
  if (minCx <= maxCx) cx = clamp(cx, minCx, maxCx);
  else cx = speakerX;
  return clamp(cx, half, sourceWidth - half);
}

// ---------------------------------------------------------------------------
// Native tooling. FFmpeg extraction stays on this side of the boundary so the
// Python helper needs nothing but the OpenCV wheel.
// ---------------------------------------------------------------------------

/**
 * Native-fps scene times, clip-relative. 12fps luma flags the cut a bin late;
 * this is the first frame of the new shot, which is when the crop must already
 * be on the speaker.
 */
async function detectSceneCuts(videoPath: string, startSec: number, duration: number): Promise<number[]> {
  const times: number[] = [];
  const pts = /pts_time:([0-9.]+)/;
  const preroll = Math.min(2, Math.max(0, startSec));
  const endSec = startSec + duration;
  try {
    await runCommand(
      config.ffmpegPath,
      [
        "-hide_banner",
        "-an",
        "-ss", String(startSec - preroll),
        "-copyts",
        "-i", videoPath,
        "-to", String(endSec),
        "-vf", "scale=320:180,select='gt(scene,0.15)',showinfo",
        "-f", "null",
        "-",
      ],
      {
        label: "scene cuts",
        onStderr: (line) => {
          const match = pts.exec(line);
          if (match) times.push(Number(match[1]));
        },
      }
    );
  } catch {
    return [];
  }
  return times
    .map((t) => (t >= startSec - 1 ? t - startSec : t))
    .filter((t) => Number.isFinite(t) && t > 0.05 && t < duration - 0.04);
}

/**
 * One contiguous 8-bit grayscale buffer for the span. Raw video avoids writing
 * hundreds of JPEGs and lets the analyzer read the whole thing in one pass.
 */
async function extractGrayFrames(
  input: SpeakerReframeInput,
  outputPath: string,
  analysisHeight: number
): Promise<void> {
  await runCommand(
    config.ffmpegPath,
    [
      "-y", "-v", "error",
      "-ss", String(input.startSec),
      "-t", String(input.endSec - input.startSec),
      "-i", input.videoPath,
      "-an",
      "-vf", `fps=${ANALYSIS_FPS},scale=${ANALYSIS_WIDTH}:${analysisHeight}`,
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      outputPath,
    ],
    { label: "reframe frame extraction" }
  );
  const size = await getFileSize(outputPath);
  if (size < ANALYSIS_WIDTH * analysisHeight * 2) {
    throw new Error("frame extraction produced fewer than two frames");
  }
}

async function extractAudio(input: SpeakerReframeInput, outputPath: string): Promise<void> {
  await runCommand(
    config.ffmpegPath,
    [
      "-y", "-v", "error",
      "-ss", String(input.startSec),
      "-t", String(input.endSec - input.startSec),
      "-i", input.videoPath,
      "-vn",
      "-ar", "16000", "-ac", "1",
      "-f", "s16le",
      outputPath,
    ],
    { label: "reframe audio extraction" }
  );
}

async function fileSize(path: string): Promise<number> {
  return getFileSize(path);
}

/** Bin 16 kHz mono PCM into one RMS value per analysis frame. */
export async function audioRmsEnvelope(audioPath: string, frameCount: number): Promise<number[]> {
  const buffer = await readFile(audioPath).catch(() => null);
  const out = new Array<number>(frameCount).fill(0);
  if (!buffer || buffer.length < 2) return out;

  const samples = Math.floor(buffer.length / 2);
  const perFrame = Math.max(1, Math.floor(samples / frameCount));
  let peak = 0;
  for (let i = 0; i < frameCount; i++) {
    const from = i * perFrame;
    const to = Math.min(samples, from + perFrame);
    let sum = 0;
    for (let s = from; s < to; s++) {
      const value = buffer.readInt16LE(s * 2) / 32768;
      sum += value * value;
    }
    const rms = to > from ? Math.sqrt(sum / (to - from)) : 0;
    out[i] = rms;
    if (rms > peak) peak = rms;
  }
  // Normalise so the envelope is comparable regardless of source loudness.
  if (peak > 0) for (let i = 0; i < frameCount; i++) out[i]! /= peak;
  return out;
}

function runAnalyzer(job: {
  framesPath: string;
  width: number;
  height: number;
  detectEvery: number;
  modelPath: string;
}): Promise<AnalyzerResult> {
  return new Promise((resolve, reject) => {
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      child = Bun.spawn([config.visionPythonPath, config.visionScriptPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error: unknown) {
      // A missing interpreter throws here rather than exiting non-zero.
      reject(
        new Error(
          `vision analyzer could not start (${config.visionPythonPath}): ${
            error instanceof Error ? error.message : String(error)
          }. Run \`bun run vision:install\`.`
        )
      );
      return;
    }

    // Start draining both pipes before writing, or a verbose stderr would fill
    // its buffer and deadlock the child.
    const stdout = Bun.readableStreamToText(child.stdout as ReadableStream<Uint8Array>);
    const stderr = Bun.readableStreamToText(child.stderr as ReadableStream<Uint8Array>);

    // The helper reads one JSON job to EOF, so the write must be terminated.
    child.stdin.write(JSON.stringify(job));
    void child.stdin.end();

    child.exited
      .then(async (code) => {
        const [out, err] = await Promise.all([stdout, stderr]);
        if (code !== 0) {
          reject(new Error(`vision analyzer exited ${code}: ${err.slice(-400)}`));
          return;
        }
        try {
          resolve(JSON.parse(out) as AnalyzerResult);
        } catch {
          reject(new Error(`vision analyzer produced unparseable output: ${out.slice(0, 200)}`));
        }
      })
      .catch((error: unknown) => reject(error));
  });
}
