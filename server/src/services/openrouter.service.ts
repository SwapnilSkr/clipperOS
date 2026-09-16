import { readFile } from "node:fs/promises";
import { config } from "../config";
import { getErrorMessage } from "../types";

// ============================================
// OPENROUTER, THE MULTIMODAL PARTS.
//
// The mining and Director text calls go through the AI SDK; this is the raw
// API for what it does not cover: a video or a sound as INPUT to a chat
// model, and images, music and video as OUTPUT.
//
//   chat(...)          text out; parts may be text, image_url, video_url,
//                      input_audio. A base64 mp4 routes to a provider that
//                      takes files (Google Vertex for Gemini).
//   generateImage(...) chat/completions with modalities ["image","text"]:
//                      the image comes back as a data: URL in the message.
//   generateMusic(...) chat/completions with modalities ["audio","text"],
//                      streamed: base64 audio arrives in delta.audio chunks.
//   startVideo/pollVideo/downloadVideo
//                      POST /api/v1/videos returns a job; poll it; fetch
//                      unsigned_urls[0] with the key.
//
// Everything here is documented at openrouter.ai/docs/guides/overview/multimodal.
// ============================================

const BASE = "https://openrouter.ai/api/v1";

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string; processing?: "agentic" | "static" } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  videoTokens?: number;
  audioTokens?: number;
  cost?: number;
}

function headers(): Record<string, string> {
  if (!config.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return {
    Authorization: `Bearer ${config.openRouterApiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/SwapnilSkr/clipperOS",
    "X-Title": "clipperOS",
  };
}

async function failure(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string | unknown[] } };
    const inner = parsed.error?.message;
    if (typeof inner === "string") {
      message = inner;
      // A validation error is itself a JSON list of issues; its first message reads best.
      try {
        const issues = JSON.parse(inner) as { message?: string; path?: unknown[] }[];
        if (Array.isArray(issues) && issues[0]?.message) message = `${issues[0].message}${issues[0].path?.length ? ` at ${issues[0].path.join(".")}` : ""}`;
      } catch {
        // Plain text.
      }
    }
  } catch {
    // Not JSON: the raw body is the message.
  }
  return new Error(`${label}: HTTP ${response.status}${message ? ` — ${message.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
}

/** A local file as the data: URL a `video_url` / `image_url` part carries. */
export async function fileDataUrl(path: string, mime: string): Promise<string> {
  const bytes = await readFile(path);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** A local audio file as an `input_audio` part. */
export async function audioPart(path: string, format = "m4a"): Promise<ChatPart> {
  const bytes = await readFile(path);
  return { type: "input_audio", input_audio: { data: bytes.toString("base64"), format } };
}

export interface ChatInput {
  model: string;
  parts: ChatPart[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Gemini reasons before answering; "low" keeps a describe-this call quick. */
  reasoning?: "low" | "medium" | "high";
  /** Ask for a JSON object back (models that support response_format). */
  json?: boolean;
  timeoutMs?: number;
  label?: string;
}

function chatBody(input: ChatInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: [
      ...(input.system ? [{ role: "system", content: input.system }] : []),
      { role: "user", content: input.parts },
    ],
    max_tokens: input.maxTokens ?? 4000,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.reasoning ? { reasoning: { effort: input.reasoning } } : {}),
    ...(input.json ? { response_format: { type: "json_object" } } : {}),
  };
}

export async function chat(input: ChatInput): Promise<{ text: string; usage: ChatUsage; provider?: string }> {
  const body = chatBody(input);
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.timeoutMs ?? 240_000),
  });
  if (!response.ok) throw await failure(response, input.label ?? "OpenRouter chat");
  const data = (await response.json()) as {
    provider?: string;
    choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
      prompt_tokens_details?: { video_tokens?: number; audio_tokens?: number };
    };
  };
  const content = data.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
  return {
    text,
    provider: data.provider,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      videoTokens: data.usage?.prompt_tokens_details?.video_tokens,
      audioTokens: data.usage?.prompt_tokens_details?.audio_tokens,
      cost: data.usage?.cost,
    },
  };
}

export interface ChatStreamResult {
  text: string;
  /** The model's thinking as it summarised it (Gemini sends summaries, not raw thoughts). */
  reasoning: string;
  /** "stop", or "length" when max_tokens cut the answer off. */
  finishReason?: string;
  usage: ChatUsage & { reasoningTokens?: number };
  provider?: string;
}

/**
 * `chat`, streamed: reasoning and answer text arrive as deltas while the model
 * works. OpenRouter sends SSE lines (`data: {...}`), `: OPENROUTER PROCESSING`
 * comments while it waits, and an `error` object in a chunk when the provider
 * fails mid-answer.
 */
export async function chatStream(
  input: ChatInput & { onReasoning?: (delta: string) => void; onContent?: (delta: string) => void }
): Promise<ChatStreamResult> {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...chatBody(input), stream: true, usage: { include: true } }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 240_000),
  });
  if (!response.ok) throw await failure(response, input.label ?? "OpenRouter chat");
  if (!response.body) throw new Error(`${input.label ?? "OpenRouter chat"}: no stream came back`);
  let text = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let provider: string | undefined;
  const usage: ChatStreamResult["usage"] = { promptTokens: 0, completionTokens: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const take = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event: {
      provider?: string;
      error?: { message?: string };
      choices?: { delta?: { content?: string | null; reasoning?: string | null }; finish_reason?: string | null }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cost?: number;
        prompt_tokens_details?: { video_tokens?: number; audio_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.error) throw new Error(`${input.label ?? "OpenRouter chat"}: ${event.error.message ?? "the provider failed mid-answer"}`);
    if (event.provider) provider = event.provider;
    const choice = event.choices?.[0];
    if (choice?.delta?.reasoning) {
      reasoning += choice.delta.reasoning;
      input.onReasoning?.(choice.delta.reasoning);
    }
    if (choice?.delta?.content) {
      text += choice.delta.content;
      input.onContent?.(choice.delta.content);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (event.usage) {
      usage.promptTokens = event.usage.prompt_tokens ?? 0;
      usage.completionTokens = event.usage.completion_tokens ?? 0;
      usage.videoTokens = event.usage.prompt_tokens_details?.video_tokens;
      usage.audioTokens = event.usage.prompt_tokens_details?.audio_tokens;
      usage.reasoningTokens = event.usage.completion_tokens_details?.reasoning_tokens;
      usage.cost = event.usage.cost;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      take(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  take(buffer.trim());
  return { text, reasoning, finishReason, usage, provider };
}

/** The JSON object in a model's answer, fenced or bare. */
export function jsonIn<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * One image from a prompt (and optional reference stills). Returns the bytes
 * and their MIME type: the message carries `images[].image_url.url` as a
 * data: URL.
 */
export async function generateImage(input: {
  model: string;
  prompt: string;
  /** e.g. "9:16", "16:9", "1:1". Sent as the provider's aspect ratio hint. */
  aspectRatio?: string;
  references?: string[];
  timeoutMs?: number;
}): Promise<{ bytes: Buffer; mime: string; cost?: number }> {
  const parts: ChatPart[] = [{ type: "text", text: input.prompt }];
  for (const url of input.references ?? []) parts.push({ type: "image_url", image_url: { url } });
  const body: Record<string, unknown> = {
    model: input.model,
    messages: [{ role: "user", content: parts }],
    modalities: ["image", "text"],
    ...(input.aspectRatio ? { image_config: { aspect_ratio: input.aspectRatio } } : {}),
  };
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.timeoutMs ?? 180_000),
  });
  if (!response.ok) throw await failure(response, "Image generation");
  const data = (await response.json()) as {
    choices?: { message?: { content?: unknown; images?: { image_url?: { url?: string } }[] } }[];
    usage?: { cost?: number };
  };
  const message = data.choices?.[0]?.message;
  let url = message?.images?.[0]?.image_url?.url;
  if (!url && Array.isArray(message?.content)) {
    const part = (message.content as { type?: string; image_url?: { url?: string } }[]).find((item) => item.type === "image_url");
    url = part?.image_url?.url;
  }
  if (!url) throw new Error("The image model returned no image");
  const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (!match) {
    const fetched = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!fetched.ok) throw new Error(`Could not fetch the generated image (HTTP ${fetched.status})`);
    return { bytes: Buffer.from(await fetched.arrayBuffer()), mime: fetched.headers.get("content-type") ?? "image/png", cost: data.usage?.cost };
  }
  return { bytes: Buffer.from(match[2]!, "base64"), mime: match[1]!, cost: data.usage?.cost };
}

/**
 * Music from a prompt. The audio modality streams: each chunk's
 * `delta.audio.data` is base64 of the format asked for, concatenated in order.
 */
export async function generateMusic(input: {
  model: string;
  prompt: string;
  format?: "wav" | "mp3";
  timeoutMs?: number;
}): Promise<{ bytes: Buffer; format: string; cost?: number }> {
  const format = input.format ?? "wav";
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content: input.prompt }],
      modalities: ["audio", "text"],
      audio: { format },
      stream: true,
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 300_000),
  });
  if (!response.ok) throw await failure(response, "Music generation");
  if (!response.body) throw new Error("Music generation returned no stream");
  const chunks: string[] = [];
  let cost: number | undefined;
  let dataUrl: string | undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload) as {
          choices?: { delta?: { audio?: { data?: string }; content?: string | { type?: string; audio?: { data?: string }; text?: string }[] } }[];
          usage?: { cost?: number };
        };
        if (event.usage?.cost !== undefined) cost = event.usage.cost;
        const delta = event.choices?.[0]?.delta;
        if (delta?.audio?.data) chunks.push(delta.audio.data);
        if (Array.isArray(delta?.content)) {
          for (const part of delta.content) if (part.audio?.data) chunks.push(part.audio.data);
        } else if (typeof delta?.content === "string") {
          const match = /data:audio\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/.exec(delta.content);
          if (match) dataUrl = (dataUrl ?? "") + match[1];
        }
      } catch {
        // A keep-alive or a partial line; the next one carries on.
      }
    }
  }
  const base64 = chunks.length ? chunks.join("") : dataUrl;
  if (!base64) throw new Error("The music model returned no audio");
  return { bytes: Buffer.from(base64, "base64"), format, cost };
}

export interface VideoJob {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed" | string;
  urls?: string[];
  error?: string;
  cost?: number;
}

/** Submit a video generation; returns the job to poll. */
export async function startVideo(input: {
  model: string;
  prompt: string;
  durationSec?: number;
  resolution?: string;
  aspectRatio?: string;
  /** A still to animate: the first frame, as a data: URL or https URL. */
  firstFrame?: string;
  generateAudio?: boolean;
}): Promise<VideoJob> {
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    ...(input.durationSec ? { duration: Math.round(input.durationSec) } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    // The still to animate, in the chat API's image part shape plus which frame it is.
    ...(input.firstFrame ? { frame_images: [{ type: "image_url", image_url: { url: input.firstFrame }, frame_type: "first_frame" }] } : {}),
    ...(input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {}),
  };
  const response = await fetch(`${BASE}/videos`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw await failure(response, "Video generation");
  const data = (await response.json()) as { id?: string; status?: string; error?: { message?: string } };
  if (!data.id) throw new Error(`Video generation returned no job id${data.error?.message ? `: ${data.error.message}` : ""}`);
  return { id: data.id, status: data.status ?? "pending" };
}

export async function pollVideo(jobId: string): Promise<VideoJob> {
  const response = await fetch(`${BASE}/videos/${encodeURIComponent(jobId)}`, {
    headers: headers(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw await failure(response, "Video job");
  const data = (await response.json()) as {
    id?: string;
    status?: string;
    unsigned_urls?: string[];
    urls?: string[];
    error?: { message?: string } | string;
    usage?: { cost?: number };
  };
  return {
    id: data.id ?? jobId,
    status: data.status ?? "pending",
    urls: data.unsigned_urls ?? data.urls,
    error: typeof data.error === "string" ? data.error : data.error?.message,
    cost: data.usage?.cost,
  };
}

/** The finished video's bytes (the content URL needs the key). */
export async function downloadVideo(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${config.openRouterApiKey}` }, signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Could not download the generated video (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

/** Poll a job until it settles or the budget runs out; `null` when it is still running. */
export async function awaitVideo(jobId: string, budgetMs: number, everyMs = 8_000): Promise<VideoJob | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let job: VideoJob;
    try {
      job = await pollVideo(jobId);
    } catch (error: unknown) {
      throw new Error(`Video job ${jobId}: ${getErrorMessage(error)}`);
    }
    if (job.status === "completed" || job.status === "failed") return job;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
