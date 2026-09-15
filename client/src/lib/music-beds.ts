import type { MusicBed, Soundtrack } from "@/api";

// ============================================================
// MUSIC BEDS — the burn's rules for a bed, in the browser.
//
// The server mixes each bed with FFmpeg (server soundtrack.service): it comes
// in at `inSec`, goes out at `outSec` (or the clip's / sting's end), plays the
// file from `offsetSec` looping past its end, fades by `bedFadeSec`, and dips
// under speech through a sidechain compressor whose `mix` is the bed's `dip`.
// The numbers here are the same, so the live preview, the timeline and the
// inspector agree with the export.
// ============================================================

export const MAX_MUSIC_BEDS = 8;
export const DEFAULT_BED_GAIN = 0.22;
export const DEFAULT_BED_DIP = 0.6;
/** What is left of a bed under speech at dip 1 (server DIP_FLOOR). */
export const DIP_FLOOR = 0.08;
/** The compressor's ballistics, in ms (server DIP_ATTACK_MS / DIP_RELEASE_MS). */
export const DIP_ATTACK_MS = 30;
export const DIP_RELEASE_MS = 280;

/** The bed's level under speech, as a factor of its own level. */
export function dipFactor(dip: number | undefined): number {
  return 1 - (1 - DIP_FLOOR) * Math.min(1, Math.max(0, dip ?? DEFAULT_BED_DIP));
}

/** The dip in dB, for the inspector's readout. */
export function dipDb(dip: number | undefined): number {
  return 20 * Math.log10(dipFactor(dip));
}

/** Where a bed stops on the output clock: its own out point, else the clip's end, or the sting's when it carries in. */
export function bedOutSec(bed: MusicBed, clipEndSec: number, outroSec: number): number {
  const carries = outroSec > 0 && bed.carryIntoOutro !== false;
  const end = carries ? clipEndSec + outroSec : clipEndSec;
  return bed.outSec != null ? Math.min(bed.outSec, end) : end;
}

/** A bed's fade, explicit or a sixth of its span (at most 1.2 s), never longer than half the span. */
export function bedFadeSec(explicit: number | undefined, spanSec: number): number {
  const fade = explicit != null ? explicit : Math.min(1.2, spanSec / 6);
  return Math.max(0, Math.min(fade, spanSec / 2));
}

/**
 * The bed's level at `t` on the output clock before any dip: its gain through
 * the fades, 0 outside its span.
 */
export function bedLevelAt(bed: MusicBed, t: number, clipEndSec: number, outroSec: number): number {
  const inSec = Math.max(0, bed.inSec ?? 0);
  const outSec = bedOutSec(bed, clipEndSec, outroSec);
  const span = outSec - inSec;
  if (span <= 0.05 || t < inSec || t >= outSec) return 0;
  const fadeIn = bedFadeSec(bed.fadeInSec, span);
  const fadeOut = bedFadeSec(bed.fadeOutSec, span);
  let level = 1;
  if (fadeIn > 0.005) level *= Math.min(1, (t - inSec) / fadeIn);
  if (fadeOut > 0.005) level *= Math.min(1, (outSec - t) / fadeOut);
  return Math.max(0, level) * (bed.gain ?? DEFAULT_BED_GAIN);
}

/** Where in the file the bed is at `t`: its offset plus the time since it came in, wrapped to the file. */
export function bedFileTimeAt(bed: MusicBed, t: number, fileDurationSec: number): number {
  const since = Math.max(0, t - Math.max(0, bed.inSec ?? 0));
  const file = Math.max(0.5, fileDurationSec);
  return ((bed.offsetSec ?? 0) + since) % file;
}

export interface SpeechSpan {
  start: number;
  end: number;
}

/**
 * Where the voice is, from word onsets: a word runs to the next onset when
 * that is close, else it is given a short tail. The burn keys its dip off the
 * voice itself; this is the preview's stand-in for it.
 */
export function speechSpans(onsets: number[], tailSec = 0.35, gapSec = 0.7): SpeechSpan[] {
  const sorted = [...onsets].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const spans: SpeechSpan[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    const next = sorted[i + 1];
    const end = next != null && next - start < gapSec ? next : start + tailSec;
    const last = spans[spans.length - 1];
    if (last && start <= last.end + 0.001) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  }
  return spans;
}

export function speaking(spans: SpeechSpan[], t: number): boolean {
  for (const span of spans) {
    if (t < span.start) return false;
    if (t < span.end) return true;
  }
  return false;
}

/** The beds that play at all — an id and a file. */
export function musicBeds(track: Soundtrack): MusicBed[] {
  return (track.beds ?? []).filter((bed) => bed.id && bed.assetId);
}

export function newBedId(): string {
  return `bed-${crypto.randomUUID().slice(0, 8)}`;
}
