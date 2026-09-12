/**
 * Install the optional Whisper fallback used ONLY for sources with no captions.
 *
 *   bun run whisper:install
 *
 * Downloads the ggml base.en model (~142 MB) into storage/whisper/. The CLI
 * itself is a native binary; if it is missing this prints how to get it.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "../src/config";
import { fileExists } from "../src/utils";

const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

async function hasCli(): Promise<boolean> {
  try {
    const proc = Bun.spawn([config.whisperCliPath, "--help"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

const target = resolve(config.whisperModelPath);
console.log(`Whisper model target: ${target}`);

if (await fileExists(target)) {
  console.log("✅ Model already present — nothing to download.");
} else {
  await mkdir(dirname(target), { recursive: true });
  console.log(`⬇️  Downloading ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) {
    console.error(`❌ Download failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  await Bun.write(target, res);
  console.log("✅ Model downloaded.");
}

if (await hasCli()) {
  console.log(`✅ whisper CLI found at "${config.whisperCliPath}" — set WHISPER_ALIGNMENT_ENABLED=true to use it.`);
} else {
  console.warn(
    `⚠️  whisper CLI not found on PATH as "${config.whisperCliPath}".\n` +
      `    Install it with one of:\n` +
      `      brew install whisper-cpp            (macOS)\n` +
      `      build from https://github.com/ggerganov/whisper.cpp\n` +
      `    Then re-run this script, or point WHISPER_CLI_PATH at the binary.`
  );
}
