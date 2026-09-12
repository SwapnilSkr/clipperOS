/**
 * Update the bundled yt-dlp to the latest release.
 *
 *   bun run ytdlp:update
 *
 * Run this when media downloads start failing with HTTP 403 — YouTube changes
 * its extraction frequently and a stale yt-dlp is the usual cause.
 */
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { fileExists, runCommand } from "../src/utils";
import { downloadVerifiedAsset } from "./verify-download";

const TARGET = resolve(import.meta.dir, "../bin/yt-dlp");

if (await fileExists(TARGET)) {
  try {
    await runCommand(TARGET, ["--update"], { label: "yt-dlp self-update" });
    await chmod(TARGET, 0o755);
    console.log("✅ yt-dlp updated in place.");
    process.exit(0);
  } catch (error) {
    console.warn(`Self-update failed (${(error as Error).message}); fetching a fresh binary…`);
  }
}

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
console.log(`✅ Installed a fresh yt-dlp at ${TARGET}`);
