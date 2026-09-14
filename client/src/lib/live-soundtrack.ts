import { useEffect, useRef, type RefObject } from "react";
import { builtinAudioUrl, sharedAudioUrl, type Soundtrack, type SoundtrackHit } from "@/api";

// ============================================================
// LIVE SOUNDTRACK — hear the mix while the source plays.
//
// The burn mixes voice, a music bed and one-shot hits on the OUTPUT clock.
// This mirrors it in the browser for any desk that shows the source: voice
// level on the <video>, a looping bed kept in step with the playhead, and a
// one-shot fired as the playhead crosses each hit.
// ============================================================

export function audioSrc(assetId: string): string {
  if (assetId.startsWith("custom:")) return sharedAudioUrl(assetId.slice("custom:".length));
  return builtinAudioUrl(assetId);
}

export function playOneShot(hit: SoundtrackHit): void {
  const audio = new Audio(audioSrc(hit.assetId));
  audio.volume = Math.min(1, hit.gain ?? 0.9);
  void audio.play().catch(() => undefined);
}

export function useLiveSoundtrack(input: {
  /** False mutes everything and leaves the video's own volume alone. */
  enabled: boolean;
  playing: boolean;
  /** Output-clock seconds. */
  localTime: number;
  /** Where the clip ends on that clock; the bed stops there unless it carries into the sting. */
  clipEndSec: number;
  outroSec: number;
  soundtrack: Soundtrack;
  videoRef: RefObject<HTMLVideoElement | null>;
}): void {
  const { enabled, playing, localTime, clipEndSec, outroSec, soundtrack, videoRef } = input;
  const musicEl = useRef<HTMLAudioElement | null>(null);
  const lastLocal = useRef(localTime);
  /** Hits already played this pass, so a hit under a resting playhead fires once. */
  const fired = useRef(new Set<string>());

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = enabled ? Math.min(1, Math.max(0, soundtrack.voiceGain ?? 1)) : 1;
    return () => {
      video.volume = 1;
    };
  }, [enabled, soundtrack.voiceGain, videoRef]);

  const musicSrc = soundtrack.music?.assetId ? audioSrc(soundtrack.music.assetId) : undefined;
  const musicThroughOutro = outroSec > 0 && soundtrack.music?.carryIntoOutro !== false;
  const musicPlaying = playing && (localTime <= clipEndSec + 0.05 || musicThroughOutro);

  useEffect(() => {
    if (!musicEl.current) {
      const el = new Audio();
      el.preload = "auto";
      el.loop = true;
      musicEl.current = el;
    }
    const el = musicEl.current;
    if (!enabled || !musicSrc) {
      el.pause();
      return;
    }
    const absolute = new URL(musicSrc, window.location.href).href;
    if (el.src !== absolute) {
      el.src = absolute;
      el.load();
    }
    el.volume = Math.min(1, soundtrack.music?.gain ?? 0.22);
    const bed = Math.max(0.5, el.duration || 16);
    const target = localTime % bed;
    if (Math.abs(el.currentTime - target) > 0.4) el.currentTime = target;
    if (musicPlaying) void el.play().catch(() => undefined);
    else el.pause();
  }, [enabled, musicSrc, musicPlaying, localTime, soundtrack.music?.gain]);

  useEffect(() => {
    const el = musicEl.current;
    return () => {
      el?.pause();
    };
  }, []);

  useEffect(() => {
    if (!enabled || !playing) {
      lastLocal.current = localTime;
      fired.current.clear();
      return;
    }
    const prev = lastLocal.current;
    lastLocal.current = localTime;
    // A seek backwards starts a new pass.
    if (localTime < prev - 0.25) fired.current.clear();
    for (const hit of soundtrack.sfx ?? []) {
      if (prev <= hit.atSec && localTime >= hit.atSec && !fired.current.has(hit.id)) {
        fired.current.add(hit.id);
        playOneShot(hit);
      }
    }
  }, [enabled, playing, localTime, soundtrack.sfx]);
}
