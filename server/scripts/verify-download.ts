/**
 * Verify a downloaded yt-dlp binary against the release's published
 * SHA2-256SUMS.
 *
 * Honest about the limit: the sums file comes from the SAME release as the
 * binary, so this defends against transit corruption, truncation and a
 * man-in-the-middle rewriting the payload, not against a compromised upstream
 * release. It replaces running whatever bytes happened to arrive, which is
 * strictly worse than no check at all being absent.
 *
 * Returns true when the digest matched, false when verification was impossible
 * (offline, missing sums, unknown asset) so callers can warn rather than fail.
 * Throws only on a definite mismatch.
 */
import { createHash } from "node:crypto";

const SUMS_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";

export async function verifyYtDlpAsset(bytes: Uint8Array, asset: string): Promise<boolean> {
  let sums: string;
  try {
    const res = await fetch(SUMS_URL, { redirect: "follow" });
    if (!res.ok) return false;
    sums = await res.text();
  } catch {
    return false;
  }

  // Lines look like: `<sha256>  yt-dlp_macos` (two spaces, occasionally a `*`).
  const line = sums
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.endsWith(` ${asset}`) || value.endsWith(` *${asset}`));
  const expected = line?.split(/\s+/)[0]?.toLowerCase();
  if (!expected) return false;

  const actual = createHash("sha256").update(bytes).digest("hex").toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Refusing to install.`
    );
  }
  return true;
}

/** Download, verify, then write — never write first and check afterwards. */
export async function downloadVerifiedAsset(
  url: string,
  asset: string,
  target: string
): Promise<"verified" | "unverified"> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const status = (await verifyYtDlpAsset(bytes, asset)) ? "verified" : "unverified";
  await Bun.write(target, bytes);
  return status;
}
