import type { CaptionCue, VttWordTiming } from "../types/clip.types";

// ============================================
// TRANSCRIPT PARSING
//
// Primary source: YouTube auto-captions. They are free, instant, and — crucially
// — carry EXACT per-word onsets inside inline tags. That is forced alignment
// without a recognizer: no whisper run, no GPU, no cost.
//
// The parsing rules below are ported from the reference implementation, where
// they were tuned against a real 2h22m episode (9,382 cues) to undo YouTube's
// rolling-window duplication.
// ============================================

/** One word with its spoken offset, recovered from YouTube's inline caption tags. */
export interface VttWordTimingInternal extends VttWordTiming {}

/** Matches YouTube's inline word tags: `<00:00:02.399><c> see</c>`. */
const INLINE_WORD_RE = /<(\d{2}:\d{2}:\d{2}\.\d{3})><c>([^<]*)<\/c>/g;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

function stripTags(line: string): string {
  // Order matters: strip tags BEFORE decoding, or a decoded `&lt;` would look
  // like a tag to the stripper and swallow the text after it.
  return decodeEntities(line.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function vttTimestampToSec(raw: string): number {
  const parts = raw.trim().split(":");
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(raw) || 0;
}

/**
 * Parse a WebVTT track into a non-repeating cue list.
 *
 * YouTube auto-captions are a ROLLING WINDOW, not a clean cue list: one spoken
 * line is emitted up to three times (freshly tagged, a ~10ms hold repeat, and
 * as the untagged first line of the next cue). Parsing naively triples the
 * transcript, which triples LLM spend and — worse — makes mined clip
 * boundaries land on the wrong instance of a line.
 *
 * The disambiguating rule is that **only tagged text is new**. Manually
 * authored tracks carry no tags, so they fall back to consecutive-duplicate
 * suppression.
 */
export function parseVtt(content: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const blocks = content.replace(/\r\n/g, "\n").split("\n\n");
  let lastText = "";

  // Decide ONCE per track, not per cue: the ~10ms hold repeats carry no tags
  // themselves, so a per-cue test would let them through as fresh content.
  const trackIsTagged = content.includes("<c>");

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    const timingLine = lines.find((l) => l.includes("-->"));
    if (!timingLine) continue;
    const [startRaw, endRaw] = timingLine.split("-->").map((s) => s.trim());
    const startSec = vttTimestampToSec(startRaw);
    const endSec = vttTimestampToSec(endRaw.split(" ")[0]);

    const body = lines.slice(lines.indexOf(timingLine) + 1);
    const tagged = body.filter((l) => l.includes("<c>"));

    const text = trackIsTagged
      ? tagged.length
        ? stripTags(tagged.join(" "))
        : ""
      : stripTags(body.join(" "));

    if (!text || text === lastText) continue;
    cues.push({ startSec, endSec, text });
    lastText = text;
  }
  return cues;
}

/**
 * Recover exact per-word onsets from a YouTube auto-caption track.
 *
 * Returns [] for manually-authored or Whisper tracks, which carry no inline
 * tags. Callers must treat an empty result as "fall back", not as an error.
 */
export function parseVttWordTimings(content: string): VttWordTiming[] {
  const words: VttWordTiming[] = [];
  const normalized = content.replace(/\r\n/g, "\n");
  let lastT = -1;

  for (const [, ts, raw] of normalized.matchAll(INLINE_WORD_RE)) {
    const word = raw.trim();
    if (!word) continue;
    const t = vttTimestampToSec(ts);
    // Rolling captions replay already-tagged words; onsets are monotonic, so
    // anything not strictly advancing is a repeat of a word we already have.
    if (t <= lastT) continue;
    words.push({ t, word });
    lastT = t;
  }
  return words;
}

/**
 * YouTube / ASR sometimes puts a whole phrase in one onset (`"so I've always"`).
 * Words-per-caption is a count of tokens, so those have to be split or 1-word
 * mode still shows three words and edits keyed to the old phrase start miss.
 */
export function expandWordTimings(words: VttWordTiming[]): VttWordTiming[] {
  const sorted = words
    .filter((item) => item && Number.isFinite(item.t) && item.word?.trim())
    .sort((a, b) => a.t - b.t);
  const out: VttWordTiming[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const tokens = sorted[i]!.word.trim().split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) {
      out.push({ t: sorted[i]!.t, word: tokens[0] ?? sorted[i]!.word });
      continue;
    }
    const nextT = sorted[i + 1]?.t;
    const span =
      nextT != null && nextT > sorted[i]!.t + 0.04
        ? nextT - sorted[i]!.t
        : Math.max(0.14 * tokens.length, 0.28);
    const step = span / tokens.length;
    for (let k = 0; k < tokens.length; k++) {
      out.push({ t: Math.round((sorted[i]!.t + step * k) * 1000) / 1000, word: tokens[k]! });
    }
  }
  return out;
}

/**
 * Derive word timings when the transcript carries no inline tags but IS
 * word-granular — which is exactly what the Whisper fallback emits (one cue per
 * word, `-ml 1 -sow`). Returns [] when cues are sentence-sized, so the caller
 * falls back to estimating from cue spans.
 */
export function deriveWordTimingsFromCues(cues: CaptionCue[]): VttWordTiming[] {
  const out: VttWordTiming[] = [];
  for (const cue of cues) {
    const text = cue.text.trim();
    if (!text) continue;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length !== 1) return []; // not word-granular — caller falls back
    out.push({ t: cue.startSec, word: tokens[0] });
  }
  return out;
}

/**
 * Best-effort word timings for a transcript: inline tags when present, else
 * per-word cues (Whisper), else empty (captions estimated from cue spans).
 */
export function resolveWordTimings(vtt: string | undefined, cues: CaptionCue[]): VttWordTiming[] {
  if (vtt) {
    const tagged = expandWordTimings(parseVttWordTimings(vtt));
    if (tagged.length >= 3) return tagged;
  }
  const derived = expandWordTimings(deriveWordTimingsFromCues(cues));
  if (derived.length >= 3) return derived;
  return [];
}
