import type { AssetSense } from "../types/clip.types";
import type { AudioAsset } from "./soundtrack.service";

// ============================================
// SOUND SEARCH — the library itself, by name and by what the harness heard.
//
// Instant and free: the Studio's "My library" search and the pickers' filter
// use it over built-ins, uploads, generated hits and picks. The Director's
// own lookups go to Freesound (or Epidemic Sound) so a fresh recording is
// found for each sound the plan asks for.
// ============================================

const STOP = new Set(["the", "a", "an", "of", "and", "sound", "sfx", "effect", "noise", "hit", "with"]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !STOP.has(word));
}

/** Light stemming so "shatter" meets "shattering" and "glass" meets "glasses". */
function stem(word: string): string {
  return word.replace(/(ing|ers|er|es|s|ed)$/, "");
}

/**
 * The library sounds that match a query by name, pack, tags and the
 * harness's description — best first. Free and instant; the Director tries
 * this before any online source.
 */
export function searchLocalSounds(query: string, assets: AudioAsset[], options: { kind?: "sfx" | "music"; limit?: number } = {}): AudioAsset[] {
  const wanted = [...new Set(tokens(query).map(stem))];
  if (wanted.length === 0) return [];
  const scored = assets
    .filter((asset) => !options.kind || asset.kind === options.kind)
    .map((asset) => {
      const sense: AssetSense | undefined = asset.sense;
      const name = new Set(tokens(`${asset.label} ${asset.pack ?? ""}`).map(stem));
      const described = new Set(tokens(`${sense?.line ?? ""} ${(sense?.tags ?? []).join(" ")} ${(sense?.suits ?? []).join(" ")}`).map(stem));
      let score = 0;
      for (const word of wanted) {
        if (name.has(word)) score += 3;
        else if (described.has(word)) score += 2;
        else if ([...name, ...described].some((have) => have.startsWith(word) || word.startsWith(have))) score += 1;
      }
      // A sound the harness found flawed sinks below a clean one with the same words.
      if (sense?.quality !== undefined && sense.quality < 3) score -= 2;
      return { asset, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.asset.label.localeCompare(b.asset.label));
  return scored.slice(0, options.limit ?? 40).map((item) => item.asset);
}
