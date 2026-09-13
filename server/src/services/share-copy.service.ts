import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels } from "../config/models";
import { resolveGenreProfile } from "../config/genres";
import { Clip, ClipProject, type IClip } from "../models";
import { getErrorMessage, type ShareCopy } from "../types";

export type { ShareCopy };

const TITLE_MAX = 100;
const DESC_MAX = 900;
const DESC_MIN = 220;
const CONCURRENCY = 4;

const BANNED = [
  /you won'?t believe/i,
  /crazy (podcast )?moment/i,
  /gone wrong/i,
  /full interview/i,
  /must[- ]watch/i,
  /#shorts/i,
];

export function stripShowPrefix(title: string, channelTitle = ""): string {
  const show = channelTitle.trim();
  if (show && title.toLowerCase().startsWith(`${show.toLowerCase()}:`)) {
    return title.slice(show.length + 1).trim();
  }
  return title;
}

export function sanitizeShareTitle(raw: string, fallback: string, channelTitle = ""): string {
  let title = raw.replace(/#\w+/g, " ").replace(/\s+/g, " ").trim();
  title = title.replace(/^["“]|["”]$/g, "").trim();
  title = stripShowPrefix(title, channelTitle);
  if (!title || BANNED.some((rule) => rule.test(title))) title = fallback;
  if (title === title.toUpperCase() && /[A-Z]/.test(title)) {
    title = title
      .toLowerCase()
      .replace(/(^|\s)\S/g, (chunk) => chunk.toUpperCase());
  }
  if (title.length > TITLE_MAX) title = title.slice(0, TITLE_MAX).replace(/\s+\S*$/, "").trim();
  return title || fallback.slice(0, TITLE_MAX);
}

function cleanLine(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

function fitLead(text: string, max = 160): string {
  if (text.length <= max) return text;
  const sentence = text.slice(0, max).match(/^[\s\S]+?[.?!]/);
  if (sentence?.[0]) return sentence[0].trim();
  return text.slice(0, max).replace(/\s+\S*$/, "").trim();
}

function hashtagLine(tags: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = `#${raw.replace(/^#/, "").replace(/[^\p{L}\p{N}]/gu, "")}`;
    if (tag.length < 3 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= 5) break;
  }
  if (!out.some((tag) => tag.toLowerCase() === "#shorts")) out.push("#Shorts");
  return out.slice(0, 5).join(" ");
}

function transcriptSentences(transcript: string): string[] {
  return transcript
    .replace(/\s+/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((line) => line.replace(/^(and|um|uh|so|like)\s+/i, "").trim())
    .filter((line) => line.length > 28 && line.length < 220);
}

export function sanitizeShareDescription(
  raw: string,
  fallback: string,
  extras: { channelTitle?: string; transcript?: string; peakLine?: string; name?: string } = {}
): string {
  let text = raw.replace(/https?:\/\/\S+/gi, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) text = fallback;
  const tags = (text.match(/#\w+/g) ?? []).map((tag) => tag.slice(1));
  const prose = text
    .split(/\n+/)
    .map(cleanLine)
    .filter((line) => line && !/^#\w+(?:\s+#\w+)*$/.test(line) && !/full conversation on the channel/i.test(line));
  const lead =
    prose[0] || cleanLine(extras.peakLine || extras.transcript || fallback).slice(0, 110);
  let context = prose.slice(1).join(" ");
  if (lead.length + context.length < DESC_MIN) {
    const extra = transcriptSentences(extras.transcript || "")
      .filter((line) => !`${lead} ${context}`.toLowerCase().includes(line.slice(0, 24).toLowerCase()))
      .slice(0, 2)
      .join(" ");
    context = [context, extra].filter(Boolean).join(" ");
  }
  const show = (extras.channelTitle || "").trim();
  const credit = show
    ? `From ${show}. Full conversation on the channel.`
    : "Full conversation on the channel.";
  const nameTag = (extras.name || "").replace(/\s+/g, "");
  const packed = [
    fitLead(lead),
    context,
    credit,
    hashtagLine([...tags, nameTag, "podcastclips", "Shorts"]),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (packed.length > DESC_MAX) return packed.slice(0, DESC_MAX).replace(/\s+\S*$/, "").trim();
  return packed || fallback;
}

function speakerHint(input: { episodeTitle?: string; channelTitle?: string; transcript: string }): string {
  const episode = (input.episodeTitle || "").trim();
  const channel = (input.channelTitle || "").trim();
  const lead = episode.split(/\s+on\s+|\s+talks\s+|\s+explains\s+/i)[0]?.trim() ?? "";
  if (lead && lead.length < 48 && !/^the /i.test(lead)) return lead;
  return channel;
}

function fallbackCopy(clip: {
  title?: string;
  hookText?: string;
  peakLine?: string;
  transcript: string;
  channelTitle?: string;
  episodeTitle?: string;
}): ShareCopy {
  const name = speakerHint(clip);
  const hook = (clip.peakLine || clip.hookText || clip.transcript).replace(/\s+/g, " ").trim();
  const title = sanitizeShareTitle(
    name && hook ? `${name} on ${hook}` : hook,
    clip.title || clip.hookText || "Clip",
    clip.channelTitle
  );
  const lead = hook.slice(0, 110);
  const description = sanitizeShareDescription(
    `${lead}\n\n#podcastclips${name ? ` #${name.replace(/\s+/g, "")}` : ""}`,
    lead,
    { channelTitle: clip.channelTitle, transcript: clip.transcript, peakLine: clip.peakLine, name }
  );
  return { title, description, generatedAt: new Date().toISOString() };
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildPrompt(input: {
  channelTitle: string;
  episodeTitle?: string;
  genreLabel: string;
  transcript: string;
  peakLine?: string;
  hookText?: string;
}): string {
  return `You write YouTube Shorts paste-copy for a talking-head / podcast / interview clip.

JOB
- Title: searchable name + verb + specific payoff the clip actually pays off.
- Description: a unique paste-ready YouTube Shorts description for THIS clip only.
- Do not invent facts, admissions, numbers, or titles absent from the transcript.

RULES
- Title hard max 100 characters. Target 40-70. Front-load a searchable person or product in the first 40.
- Shape: Name + verb + payoff. Verbs: talks about, explains, admits, realizes, argues, walks through, on, vs.
- Use the guest/speaker people would search (from the episode title or transcript). Do not start with the show name and a colon.
- "Mark Zuckerberg explains…" beats "Sources Podcast: …" or "Sources Podcast discusses…".
- Sentence case or title case. No ALL CAPS. No hashtags in the title. No "you won't believe", "crazy moment", "full interview".
- Never write "this guy" if a name is available.

DESCRIPTION (this is the paste box under the title — write the whole thing)
- 280-700 characters. Unique to this clip. Do not reuse the title as the first line.
- Paragraph 1 (≤120 chars): who + the specific claim this clip pays off. Searchable nouns first.
- Paragraph 2: 2-3 sentences from the transcript in different words — the argument, example, or admission. Names and products stay verbatim.
- Paragraph 3: "From {show}. Full conversation on the channel." No URL. Shorts links are not clickable.
- Then 3-5 hashtags: person, topic, one format tag. Optional #Shorts. No #fyp or #viral.
- No emoji spam. No "watch till the end". No duplicate sentences.

SHOW: ${input.channelTitle || "Unknown"}
EPISODE: ${input.episodeTitle || ""}
GENRE: ${input.genreLabel || "interview"}
PEAK LINE: ${input.peakLine || ""}
HOOK: ${input.hookText || ""}
TRANSCRIPT:
${input.transcript.slice(0, 3500)}

Return only JSON: {"title":"...","description":"..."}`;
}

export async function generateShareCopy(input: {
  channelTitle: string;
  episodeTitle?: string;
  genreLabel: string;
  transcript: string;
  peakLine?: string;
  hookText?: string;
  title?: string;
}): Promise<ShareCopy> {
  const fallback = fallbackCopy(input);
  if (!config.openRouterApiKey || input.transcript.trim().length < 12) return fallback;
  try {
    const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });
    const { text } = await generateText({
      model: openrouter(resolveModels("cheap").llm),
      prompt: buildPrompt(input),
      temperature: 0.4,
      maxOutputTokens: 800,
    });
    const parsed = extractJson(text ?? "");
    const title = typeof parsed?.title === "string" ? parsed.title : "";
    const description = typeof parsed?.description === "string" ? parsed.description : "";
    return {
      title: sanitizeShareTitle(title, fallback.title, input.channelTitle),
      description: sanitizeShareDescription(description, fallback.description, {
        channelTitle: input.channelTitle,
        transcript: input.transcript,
        peakLine: input.peakLine,
        name: speakerHint(input),
      }),
      generatedAt: new Date().toISOString(),
    };
  } catch (error: unknown) {
    console.warn(`⚠️  Share copy failed: ${getErrorMessage(error)}`);
    return fallback;
  }
}

function shouldFillTitle(clip: IClip): boolean {
  return !clip.title || clip.title === clip.shareCopy?.title;
}

function projectCopyInput(project: {
  channelTitle?: string;
  title?: string;
  genreId?: string;
}) {
  let genreLabel = project.genreId || "";
  try {
    if (project.genreId) genreLabel = resolveGenreProfile(project.genreId).label;
  } catch {
    /* keep the raw id */
  }
  return {
    channelTitle: project.channelTitle || "",
    episodeTitle: project.title || "",
    genreLabel,
  };
}

async function writeCopy(clip: IClip, copy: ShareCopy, fillTitle: boolean): Promise<ShareCopy> {
  const $set: Record<string, unknown> = { shareCopy: copy };
  if (fillTitle && shouldFillTitle(clip)) $set.title = copy.title;
  await Clip.findByIdAndUpdate(clip._id, { $set });
  return copy;
}

export async function generateClipShareCopy(clipId: string, force = false): Promise<IClip> {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new Error("Clip not found");
  if (!force && clip.shareCopy?.title && clip.shareCopy.description) return clip;
  const project = await ClipProject.findById(clip.projectId).lean();
  const copy = await generateShareCopy({
    ...projectCopyInput(project ?? {}),
    transcript: clip.transcript,
    peakLine: clip.peakLine,
    hookText: clip.hookText,
    title: clip.title,
  });
  await writeCopy(clip, copy, true);
  const fresh = await Clip.findById(clipId);
  if (!fresh) throw new Error("Clip not found");
  return fresh;
}

export async function generateProjectShareCopy(
  projectId: string,
  options: { force?: boolean } = {}
): Promise<{ written: number; skipped: number }> {
  const project = await ClipProject.findById(projectId).lean();
  if (!project) throw new Error("Project not found");
  const clips = await Clip.find({ projectId, status: { $ne: "dismissed" } });
  let written = 0;
  let skipped = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, clips.length) }, async () => {
    while (cursor < clips.length) {
      const clip = clips[cursor]!;
      cursor += 1;
      if (!options.force && clip.shareCopy?.title) {
        skipped += 1;
        continue;
      }
      const copy = await generateShareCopy({
        ...projectCopyInput(project),
        transcript: clip.transcript,
        peakLine: clip.peakLine,
        hookText: clip.hookText,
        title: clip.title,
      });
      await writeCopy(clip, copy, true);
      written += 1;
    }
  });
  await Promise.all(workers);
  return { written, skipped };
}
