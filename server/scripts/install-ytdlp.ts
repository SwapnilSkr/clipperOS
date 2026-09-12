/**
 * Fetch a fresh yt-dlp binary into bin/.(run if the bundled one is missing).
 *
 *   bun run ytdlp:install
 */
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileExists } from "../src/utils";
import { downloadVerifiedAsset } from "./verify-download";

const TARGET = resolve(import.meta.dir, "../bin/yt-dlp");

const PLATFORM_ASSETS: Record<string, string> = {
  darwin: "yt-dlp_macos",
  linux: "yt-dlp_linux",
  win32: "yt-dlp.exe",
};

const asset = PLATFORM_ASSETS[process.platform];
if (!asset) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

if (await fileExists(TARGET)) {
  console.log(`✅ yt-dlp already present at ${TARGET}`);
  process.exit(0);
}

await mkdir(dirname(TARGET), { recursive: true });
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
console.log(`⬇️  Downloading ${url}`);

let verified: "verified" | "unverified";
try {
  verified = await downloadVerifiedAsset(url, asset, TARGET);
} catch (error) {
  console.error(`❌ ${(error as Error).message}`);
  process.exit(1);
}
await chmod(TARGET, 0o755);
if (verified === "verified") {
  console.log("🔐 SHA-256 verified against yt-dlp SHA2-256SUMS");
} else {
  console.warn("⚠️  SHA-256 could not be verified (sums file unavailable); installed unverified");
}
console.log(`✅ Installed yt-dlp at ${TARGET}`);
