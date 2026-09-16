import { MAX_DIRECTOR_ASKS, type DirectorAsk } from "../types/clip.types";

// ============================================
// QUESTIONS WITH OPTIONS — how the Director asks before it cuts: a short
// header, the question, 2–4 options (each saying what it does to the cut)
// and the one it recommends, so the creator answers with a click and the
// recommended answers are already picked. The same cleaner reads a model's
// proposal and a stored turn, so a loose answer ("Hype (Recommended)", bare
// strings, an old list of plain questions) lands in one shape.
// ============================================

export const MAX_ASK_OPTIONS = 4;

export const PROPOSAL_FORMAT =
  "6–10 short lines, one per lane you would touch, each saying WHAT you would do and WHERE (clip-relative seconds or the words) and why — cuts, camera, captions, title, SFX, music, B-roll, effects, speed. Concrete, an editor's voice, no hedging. Where a question is still open, say what you would do with the recommended answer.";

export const ASK_FORMAT = `up to ${MAX_DIRECTOR_ASKS} questions, and only ones whose answer changes the cut and that you genuinely cannot settle from the brief, the notes or the lessons (a tone call, which of two directions, how hard to push, whether to use a specific asset) — none when the brief settles it. Each is { "header": "1–2 words", "question": "one clear question ending in ?", "options": [{ "label": "1–5 words", "detail": "what choosing it does to the cut, one short sentence" }], "recommended": 0 }: 2–4 distinct, mutually exclusive options with the one you recommend FIRST (so "recommended": 0). The creator clicks one or answers in their own words.`;

const RECOMMENDED_TAG = /\s*[([]\s*recommended\s*[)\]]\s*$/i;

function record(value: unknown, key: string): Record<string, unknown> {
  if (typeof value === "string") return { [key]: value };
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function cleanDirectorAsks(raw: unknown): DirectorAsk[] {
  if (!Array.isArray(raw)) return [];
  const asks: DirectorAsk[] = [];
  for (const item of raw) {
    if (asks.length >= MAX_DIRECTOR_ASKS) break;
    const source = record(item, "question");
    const question = typeof source.question === "string" ? source.question.trim().slice(0, 300) : "";
    if (!question) continue;
    let tagged: number | undefined;
    const options: DirectorAsk["options"] = [];
    for (const entry of Array.isArray(source.options) ? source.options : []) {
      if (options.length >= MAX_ASK_OPTIONS) break;
      const option = record(entry, "label");
      const written = typeof option.label === "string" ? option.label.trim() : "";
      const label = written.replace(RECOMMENDED_TAG, "").trim().slice(0, 80);
      if (!label || options.some((known) => known.label.toLowerCase() === label.toLowerCase())) continue;
      if (tagged === undefined && RECOMMENDED_TAG.test(written)) tagged = options.length;
      const detail = typeof option.detail === "string" ? option.detail.trim().slice(0, 200) : "";
      options.push({ label, ...(detail ? { detail } : {}) });
    }
    const header = typeof source.header === "string" ? source.header.trim().slice(0, 24) : "";
    const ask: DirectorAsk = { question, ...(header ? { header } : {}), options: [] };
    // A single option is no choice: it stays an open question.
    if (options.length >= 2) {
      const index = Number(source.recommended);
      ask.options = options;
      ask.recommended = source.recommended != null && Number.isInteger(index) && index >= 0 && index < options.length ? index : (tagged ?? 0);
    }
    asks.push(ask);
  }
  return asks;
}
