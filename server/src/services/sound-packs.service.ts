import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { config } from "../config";
import type { AssetSense } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { runCommand } from "../utils/process.utils";
import { ingestCustomAudio, listCustomAudio, type AudioAsset } from "./soundtrack.service";
import { senseLibrary } from "./sense.service";

// ============================================
// SOUND PACKS — free, CC0, no key: whole libraries installed in one click.
//
// Kenney (kenney.nl) publishes public-domain audio packs as plain zips.
// Installing one downloads it, unpacks it and ingests every sound into the
// shared audio library like an upload, marked `source: "pack"` with its
// pack name, so the pickers can keep them out of the way until searched
// for, and the harness describes them in the background so the Director
// can find one by what it sounds like. A pack is never installed twice;
// its sounds are keyed `kenney:<pack>/<file>`.
//
// The zip link on a pack's page carries a build hash that changes when
// Kenney updates the pack, so it is read from the page at install time,
// with the link seen on 2026-09-15 as the fallback.
// ============================================

export interface SoundPack {
  slug: string;
  label: string;
  /** What is in it, for the picker and the Director's brief. */
  covers: string;
  /** Roughly how many sounds. */
  count: number;
  /** Beds (jingles) or one-shots. */
  kind: "sfx" | "music";
  fallbackZip: string;
}

export const SOUND_PACKS: SoundPack[] = [
  {
    slug: "impact-sounds",
    label: "Impacts",
    covers: "glass, metal, wood, plates and tin breaking and hitting (light to heavy), punches, soft thuds, a bell, mining, footsteps on carpet, concrete, grass, snow and wood",
    count: 130,
    kind: "sfx",
    fallbackZip: "https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip",
  },
  {
    slug: "interface-sounds",
    label: "Interface",
    covers: "clicks, confirmations, errors, selects, switches, drops, bongs, glitches and question tones for UI moments",
    count: 100,
    kind: "sfx",
    fallbackZip: "https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip",
  },
  {
    slug: "ui-audio",
    label: "UI audio",
    covers: "rollovers, clicks, switches and toggles, from soft to hard",
    count: 50,
    kind: "sfx",
    fallbackZip: "https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip",
  },
  {
    slug: "digital-audio",
    label: "Digital",
    covers: "8-bit and synth blips, lasers, power-ups, explosions, phase and zaps",
    count: 60,
    kind: "sfx",
    fallbackZip: "https://kenney.nl/media/pages/assets/digital-audio/216eac4753-1677590265/kenney_digital-audio.zip",
  },
  {
    slug: "sci-fi-sounds",
    label: "Sci-fi",
    covers: "lasers, engines, computer noise, doors, force fields, alarms, thrusters and space impacts",
    count: 100,
    kind: "sfx",
    fallbackZip: "https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip",
  },
  {
    slug: "rpg-audio",
    label: "RPG",
    covers: "doors, chests, drawers, books, cloth, coins and drops, handles, knives and swords, footsteps",
    count: 50,
    kind: "sfx",
    fallbackZip: "https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip",
  },
  {
    slug: "casino-audio",
    label: "Casino",
    covers: "cards dealt and shuffled, chips stacked and dropped, dice rolled, slot machine spins and wins",
    count: 80,
    kind: "sfx",
    fallbackZip: "https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip",
  },
  {
    slug: "music-jingles",
    label: "Jingles",
    covers: "short stingers: wins, losses, level-ups, fanfares, in several styles",
    count: 65,
    kind: "sfx",
    fallbackZip: "https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip",
  },
];

export interface PackInstall {
  slug: string;
  status: "running" | "done" | "failed";
  done: number;
  total: number;
  error?: string;
  startedAt: string;
}

const installs = new Map<string, PackInstall>();

export function packInstalls(): PackInstall[] {
  return [...installs.values()];
}

/** Installed sounds per pack, from the library. */
export async function packCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const asset of await listCustomAudio()) {
    if (asset.source !== "pack" || !asset.pack) continue;
    counts[asset.pack] = (counts[asset.pack] ?? 0) + 1;
  }
  return counts;
}

/** The pack's current zip link, read from its page (the hash changes on updates). */
async function packZipUrl(pack: SoundPack): Promise<string> {
  try {
    const page = await fetch(`https://kenney.nl/assets/${pack.slug}`, { signal: AbortSignal.timeout(20_000) });
    if (page.ok) {
      const html = await page.text();
      const match = /(https?:\/\/kenney\.nl)?(\/media\/pages\/assets\/[^"']+\.zip)/i.exec(html);
      if (match) return `https://kenney.nl${match[2]}`;
    }
  } catch {
    // The page is down or changed shape: the last link seen still works until the pack is rebuilt.
  }
  return pack.fallbackZip;
}

/** "impactGlass_heavy_000" → "Impact glass heavy 000". */
function humanise(file: string): string {
  return basename(file, extname(file))
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
    .slice(0, 80);
}

async function audioFilesIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await audioFilesIn(path)));
    else if (/\.(ogg|wav|mp3|m4a|flac)$/i.test(entry.name)) out.push(path);
  }
  return out.sort();
}

/** Start installing a pack; returns at once, progress in `packInstalls()`. */
export function installSoundPack(slug: string): PackInstall {
  const pack = SOUND_PACKS.find((item) => item.slug === slug);
  if (!pack) throw new Error("Unknown sound pack");
  const running = installs.get(slug);
  if (running?.status === "running") return running;
  const install: PackInstall = { slug, status: "running", done: 0, total: pack.count, startedAt: new Date().toISOString() };
  installs.set(slug, install);
  void (async () => {
    const scratch = await mkdtemp(join(tmpdir(), `pack-${slug}-`));
    try {
      const zip = join(scratch, "pack.zip");
      const response = await fetch(await packZipUrl(pack), { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Could not download the pack (HTTP ${response.status})`);
      await Bun.write(zip, await response.arrayBuffer());
      if ((await stat(zip)).size > 200 * 1024 * 1024) throw new Error("The pack is larger than expected");
      const unpacked = join(scratch, "unpacked");
      await runCommand("unzip", ["-q", "-o", zip, "-d", unpacked], { label: "unzip pack" });
      const files = await audioFilesIn(unpacked);
      install.total = files.length;
      const have = new Set((await listCustomAudio()).filter((asset) => asset.source === "pack").map((asset) => asset.sourceId));
      for (const file of files) {
        const sourceId = `kenney:${slug}/${basename(file)}`;
        if (!have.has(sourceId)) {
          try {
            await ingestCustomAudio("none", pack.kind, file, `${humanise(file)}${extname(file)}`, {
              source: "pack",
              pack: slug,
              sourceId,
              attribution: "Kenney (kenney.nl), CC0",
              sourceUrl: `https://kenney.nl/assets/${slug}`,
            });
          } catch (error: unknown) {
            console.warn(`Pack ${slug}: skipped ${basename(file)}: ${getErrorMessage(error)}`);
          }
        }
        install.done++;
      }
      install.status = "done";
      console.log(`📦 Installed sound pack ${slug}: ${install.done} sounds`);
      // Descriptions come in the background, a few at a time.
      void describePackInBackground(files.length);
    } catch (error: unknown) {
      install.status = "failed";
      install.error = getErrorMessage(error).slice(0, 300);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
  return install;
}

let describing: Promise<void> | null = null;

/** The harness listens to the new sounds in batches until all are described. */
function describePackInBackground(count: number): Promise<void> {
  if (describing) return describing;
  describing = (async () => {
    try {
      for (let left = count; left > 0; ) {
        const result = await senseLibrary(24);
        if (result.described === 0) break;
        left -= result.described;
      }
    } catch (error: unknown) {
      console.warn(`Pack descriptions stopped: ${getErrorMessage(error)}`);
    } finally {
      describing = null;
    }
  })();
  return describing;
}

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
