import { directorModel } from "../config/models";
import { Clip, DirectorLessonModel, type IDirectorLesson } from "../models";
import type { CreatorPlan, DirectorLesson, RenderReview, SoundtrackHit } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { chat, jsonIn } from "./openrouter.service";
import { describeCurrentPlan } from "./director.service";
import { MAX_PROXY_SEC, proxyClip, reviewRender } from "./sense.service";

// ============================================
// TASTE — how the Director learns what this creator likes.
//
// Three signals become short, reusable lessons in plain English, stored
// with a scope (global or one project) and a weight:
//
//   edits     the plan the Director wrote vs the plan the creator exported.
//             What they removed, moved, toned down or added is the clearest
//             statement of taste there is. Read by a model into 1–3 lessons.
//   review    what the harness itself found wrong watching the render
//             (sense.reviewRender) — recurring issues become rules.
//   feedback  a thumbs up / down with a note on a pass. Outranks the rest.
//
// The Director's prompt carries the top lessons; when there are many, they
// are consolidated into fewer, sharper ones so the prompt stays short and
// the rules stay current.
// ============================================

export const MAX_LESSONS_IN_PROMPT = 18;
const CONSOLIDATE_ABOVE = 40;
const CONSOLIDATE_TO = 20;

function publicLesson(doc: IDirectorLesson): DirectorLesson {
  return {
    id: String(doc._id),
    scope: doc.scope,
    kind: doc.kind,
    text: doc.text,
    weight: doc.weight,
    ...(doc.clipId ? { clipId: doc.clipId } : {}),
    at: doc.at,
  };
}

/** Lessons that apply to a project: its own and the global ones, strongest and newest first. */
export async function lessonsFor(projectId: string | undefined, limit = MAX_LESSONS_IN_PROMPT): Promise<DirectorLesson[]> {
  const scopes = projectId ? ["global", projectId] : ["global"];
  const docs = await DirectorLessonModel.find({ scope: { $in: scopes } }).sort({ weight: -1, at: -1 }).limit(limit).lean();
  return docs.map((doc) => publicLesson(doc as IDirectorLesson));
}

export async function listLessons(): Promise<DirectorLesson[]> {
  const docs = await DirectorLessonModel.find({}).sort({ at: -1 }).limit(200).lean();
  return docs.map((doc) => publicLesson(doc as IDirectorLesson));
}

export async function deleteLesson(id: string): Promise<void> {
  await DirectorLessonModel.deleteOne({ _id: id });
}

export async function addLesson(input: Omit<DirectorLesson, "id" | "at"> & { at?: string }): Promise<DirectorLesson> {
  const text = input.text.trim().slice(0, 400);
  if (!text) throw new Error("A lesson needs some text");
  const doc = await DirectorLessonModel.create({
    scope: input.scope,
    kind: input.kind,
    text,
    weight: Math.max(0, Math.min(10, input.weight)),
    ...(input.clipId ? { clipId: input.clipId } : {}),
    at: input.at ?? new Date().toISOString(),
  });
  void consolidateIfCrowded().catch((error: unknown) => console.warn(`Lesson consolidation failed: ${getErrorMessage(error)}`));
  return publicLesson(doc);
}

/** The lessons block for the Director's prompt. */
export function describeLessons(lessons: DirectorLesson[]): string {
  if (lessons.length === 0) return "";
  return lessons.map((lesson) => `- ${lesson.text}${lesson.kind === "feedback" ? " (the creator said so)" : ""}`).join("\n");
}

/** A thumbs up or down on the latest pass, with an optional note. */
export async function recordFeedback(input: {
  clipId: string;
  verdict: "up" | "down";
  note?: string;
  scope?: "global" | "project";
}): Promise<DirectorLesson[]> {
  const clip = await Clip.findById(input.clipId).select("projectId edit rank").lean();
  if (!clip) throw new Error("Clip not found");
  const scope = input.scope === "project" ? String(clip.projectId) : "global";
  const note = input.note?.trim();
  const summary = clip.edit?.creator?.director?.summary ?? "";
  const lessons: DirectorLesson[] = [];
  if (note) {
    // The creator's own words are the lesson; a thumbs down says "avoid", up says "keep doing".
    const text = input.verdict === "down" ? `Avoid: ${note}` : `Keep doing: ${note}`;
    lessons.push(await addLesson({ scope, kind: "feedback", text, weight: input.verdict === "down" ? 9 : 8, clipId: input.clipId }));
    return lessons;
  }
  if (!summary) return lessons;
  // No note: the model turns the verdict on the pass's own summary into a lesson.
  const result = await chat({
    model: directorModel(),
    parts: [
      {
        type: "text",
        text: `A creator gave a thumbs ${input.verdict === "up" ? "UP" : "DOWN"} to this editing pass on their short-form clip, without a note. The pass said it did this:\n"${summary}"\n\nWrite ONE short lesson (max 30 words) an editor should carry into future clips for this creator: for a thumbs up, what to keep doing; for a thumbs down, what to stop or change. Return ONLY JSON: { "lesson": "..." }`,
      },
    ],
    reasoning: "low",
    maxTokens: 300,
    temperature: 0.3,
    label: "feedback lesson",
  });
  const parsed = jsonIn<{ lesson?: string }>(result.text);
  if (parsed?.lesson) {
    lessons.push(await addLesson({ scope, kind: "feedback", text: parsed.lesson, weight: input.verdict === "down" ? 7 : 6, clipId: input.clipId }));
  }
  return lessons;
}

/**
 * What the creator changed after the Director's pass, read as taste. Called
 * when a directed clip is rendered: the exported plan is the creator's
 * final word. Nothing is learned when they changed nothing.
 */
export async function learnFromEdits(input: {
  clipId: string;
  projectId: string;
  trimStart: number;
  directed: { plan: CreatorPlan | undefined; sfx: SoundtrackHit[] | undefined };
  exported: { plan: CreatorPlan | undefined; sfx: SoundtrackHit[] | undefined };
}): Promise<DirectorLesson[]> {
  const before = describeCurrentPlan(input.directed.plan, input.directed.sfx, input.trimStart);
  const after = describeCurrentPlan(input.exported.plan, input.exported.sfx, input.trimStart);
  if (!before || before === after) return [];
  const result = await chat({
    model: directorModel(),
    parts: [
      {
        type: "text",
        text: `An AI editor wrote a beat plan for a creator's vertical short. The creator then edited it by hand and exported. Compare the two and infer the creator's TASTE — not the specifics of this clip, but rules that would make the next plan closer to what they want. Only infer from what changed; if a change looks like a one-off (fixing a wrong time), skip it.

PLAN AS DIRECTED:
${before.slice(0, 5000)}

PLAN AS EXPORTED BY THE CREATOR:
${after.slice(0, 5000)}

Return ONLY JSON: { "lessons": ["max 25 words each, imperative, general: 'Fewer camera moves — at most one punch per 15 s.'"] } with 0–3 lessons. Return an empty list if nothing generalises.`,
      },
    ],
    reasoning: "low",
    maxTokens: 600,
    temperature: 0.3,
    label: "edit lessons",
  });
  const parsed = jsonIn<{ lessons?: unknown }>(result.text);
  const texts = Array.isArray(parsed?.lessons) ? (parsed!.lessons as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 8).slice(0, 3) : [];
  const lessons: DirectorLesson[] = [];
  for (const text of texts) lessons.push(await addLesson({ scope: input.projectId, kind: "edit", text, weight: 5, clipId: input.clipId }));
  return lessons;
}

/** A render review's recurring findings, kept as project lessons. */
export async function learnFromReview(clipId: string, projectId: string, review: RenderReview): Promise<DirectorLesson[]> {
  const lessons: DirectorLesson[] = [];
  // Only what hurt enough to fix: a low score's top issues become rules.
  if (review.score >= 8) return lessons;
  for (const issue of review.issues.slice(0, 2)) {
    if (!issue.fix) continue;
    lessons.push(await addLesson({ scope: projectId, kind: "review", text: `${issue.what} → ${issue.fix}`.slice(0, 400), weight: 4, clipId }));
  }
  return lessons;
}

/** Many lessons become fewer, sharper ones — the prompt stays short and the rules current. */
export async function consolidateIfCrowded(): Promise<number> {
  const scopes = await DirectorLessonModel.distinct("scope");
  let merged = 0;
  for (const scope of scopes) {
    const docs = await DirectorLessonModel.find({ scope }).sort({ at: 1 }).lean();
    if (docs.length <= CONSOLIDATE_ABOVE) continue;
    const listed = docs.map((doc, index) => `${index + 1}. [${doc.kind}, weight ${doc.weight}] ${doc.text}`).join("\n");
    const result = await chat({
      model: directorModel(),
      parts: [
        {
          type: "text",
          text: `These are lessons an AI video editor has collected about one creator's taste, oldest first. Merge duplicates, drop ones contradicted by later ones (later wins), and keep the rest as they are. Feedback the creator gave directly outranks inferred lessons. Return at most ${CONSOLIDATE_TO}, each max 30 words, with a weight 1–10.\n\n${listed}\n\nReturn ONLY JSON: { "lessons": [{ "text": "...", "weight": 7, "kind": "feedback|edit|review" }] }`,
        },
      ],
      reasoning: "low",
      maxTokens: 3000,
      temperature: 0.2,
      label: "consolidate lessons",
    });
    const parsed = jsonIn<{ lessons?: { text?: unknown; weight?: unknown; kind?: unknown }[] }>(result.text);
    const next = (parsed?.lessons ?? [])
      .filter((item) => typeof item.text === "string" && (item.text as string).trim())
      .slice(0, CONSOLIDATE_TO)
      .map((item) => ({
        scope,
        kind: item.kind === "feedback" || item.kind === "review" ? item.kind : "edit",
        text: (item.text as string).trim().slice(0, 400),
        weight: Math.max(1, Math.min(10, Number(item.weight) || 5)),
        at: new Date().toISOString(),
      }));
    if (next.length === 0) continue;
    await DirectorLessonModel.deleteMany({ scope });
    await DirectorLessonModel.insertMany(next);
    merged += docs.length - next.length;
  }
  return merged;
}

/** Learning is on unless DIRECTOR_LEARN=0. */
export function learningEnabled(): boolean {
  return process.env.DIRECTOR_LEARN?.trim() !== "0";
}

/**
 * A directed clip was rendered: the harness watches the result and reads
 * the creator's edits, in the background. The proxy is made before the
 * render's scratch folder goes, so this returns as soon as that is done.
 */
export async function learnFromRender(clipId: string, renderedPath: string): Promise<void> {
  if (!learningEnabled()) return;
  const clip = await Clip.findById(clipId).select("projectId edit directed startSec").lean();
  if (!clip?.directed?.plan) return;
  const proxy = await proxyClip(renderedPath, 0, MAX_PROXY_SEC);
  const projectId = String(clip.projectId);
  const trimStart = clip.edit?.trimStartSec ?? clip.startSec;
  void (async () => {
    try {
      const review = await reviewRender(clipId, proxy, { proxied: true });
      await learnFromReview(clipId, projectId, review);
    } catch (error: unknown) {
      console.warn(`Render review skipped: ${getErrorMessage(error)}`);
    }
    try {
      const lessons = await learnFromEdits({
        clipId,
        projectId,
        trimStart,
        directed: { plan: clip.directed!.plan, sfx: clip.directed!.sfx },
        exported: { plan: clip.edit?.creator, sfx: clip.edit?.soundtrack?.sfx },
      });
      if (lessons.length) console.log(`🧠 Learned from the creator's edits: ${lessons.map((lesson) => lesson.text).join(" | ")}`);
    } catch (error: unknown) {
      console.warn(`Edit lessons skipped: ${getErrorMessage(error)}`);
    }
  })();
}
