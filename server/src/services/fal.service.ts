import { config } from "../config";

// ============================================
// FAL — sound effects, which OpenRouter does not make.
//
// OpenRouter's only audio-output models are music (Lyria) and speech, so
// one-shot effects come from fal.ai's queue API instead: a whoosh, a hit,
// a riser from a prompt at a set length. Stable Audio 3 Small SFX is about
// two cents an effect; ElevenLabs' SFX model through fal is $0.002 a second.
// One key (FAL_KEY), pay as you go. `SFX_MODEL` picks the model.
//
//   POST https://queue.fal.run/<model>          → { request_id, status_url, response_url }
//   GET  status_url                             → { status: IN_QUEUE|IN_PROGRESS|COMPLETED }
//   GET  response_url                           → { audio: { url } }
// ============================================

export function falConfigured(): boolean {
  return Boolean(config.falKey);
}

function headers(): Record<string, string> {
  if (!config.falKey) throw new Error("FAL_KEY is not set — sound effects need fal.ai");
  return { Authorization: `Key ${config.falKey}`, "Content-Type": "application/json" };
}

async function failure(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  let message = body;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: string } };
    if (typeof parsed.detail === "string") message = parsed.detail;
    else if (Array.isArray(parsed.detail)) message = JSON.stringify(parsed.detail);
    else if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // Plain text.
  }
  return new Error(`${label}: HTTP ${response.status}${message ? ` — ${message.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
}

/**
 * Audio from a prompt on a fal model, waited for. The input keys are Stable
 * Audio's (`prompt`, `duration`, `negative_prompt`, `output_format`);
 * ElevenLabs' SFX endpoint on fal takes `text` and `duration_seconds`, so
 * both are sent — a model ignores what it does not know.
 */
export async function falGenerateAudio(input: {
  model: string;
  prompt: string;
  durationSec: number;
  negativePrompt?: string;
  timeoutMs?: number;
}): Promise<{ bytes: Buffer; contentType: string }> {
  const body = {
    prompt: input.prompt,
    text: input.prompt,
    duration: input.durationSec,
    duration_seconds: input.durationSec,
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    output_format: "wav",
  };
  const submitted = await fetch(`https://queue.fal.run/${input.model}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!submitted.ok) throw await failure(submitted, "Sound effect generation");
  const job = (await submitted.json()) as { request_id?: string; status_url?: string; response_url?: string };
  if (!job.status_url || !job.response_url) throw new Error("fal returned no job to poll");

  const deadline = Date.now() + (input.timeoutMs ?? 180_000);
  for (;;) {
    const status = await fetch(job.status_url, { headers: headers(), signal: AbortSignal.timeout(30_000) });
    if (!status.ok) throw await failure(status, "Sound effect job");
    const state = (await status.json()) as { status?: string; error?: string };
    if (state.status === "COMPLETED") break;
    if (state.status === "FAILED" || state.error) throw new Error(`Sound effect job failed${state.error ? `: ${state.error}` : ""}`);
    if (Date.now() > deadline) throw new Error("The sound effect took too long");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const result = await fetch(job.response_url, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  if (!result.ok) throw await failure(result, "Sound effect result");
  const data = (await result.json()) as { audio?: { url?: string; content_type?: string }; audio_file?: { url?: string; content_type?: string } };
  const file = data.audio ?? data.audio_file;
  if (!file?.url) throw new Error("The sound effect model returned no audio");
  const download = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
  if (!download.ok) throw new Error(`Could not download the sound effect (HTTP ${download.status})`);
  return { bytes: Buffer.from(await download.arrayBuffer()), contentType: file.content_type ?? download.headers.get("content-type") ?? "audio/wav" };
}
