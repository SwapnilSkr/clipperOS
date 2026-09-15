import { useEffect, useRef, type RefObject } from "react";
import { builtinAudioUrl, sharedAudioUrl, type Soundtrack, type SoundtrackHit } from "@/api";
import {
  bedFileTimeAt,
  bedLevelAt,
  bedOutSec,
  DIP_ATTACK_MS,
  DIP_RELEASE_MS,
  dipFactor,
  musicBeds,
  speaking,
  type SpeechSpan,
} from "@/lib/music-beds";

// ============================================================
// LIVE SOUNDTRACK — hear the mix while the source plays.
//
// The burn mixes voice, music beds and one-shot hits on the OUTPUT clock.
// This mirrors it in the browser for any desk that shows the source: voice
// level on the <video>, one looping <audio> per bed kept in step with the
// playhead (its in/out, offset, fades and level are the burn's rules in
// lib/music-beds; its dip under speech follows the transcript's words with
// the compressor's ballistics), and a one-shot fired as the playhead crosses
// each hit.
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

interface BedPlayer {
  el: HTMLAudioElement;
  /** The dip envelope, 1 = not dipped, moving toward the target at the compressor's pace. */
  env: number;
}

export function useLiveSoundtrack(input: {
  /** False mutes everything and leaves the video's own volume alone. */
  enabled: boolean;
  playing: boolean;
  /** Voice faded out for a slowed or frozen span; the beds and hits carry on. */
  voiceDucked?: boolean;
  /** Output-clock seconds. */
  localTime: number;
  /** Where the clip ends on that clock; a bed stops there unless it carries into the sting. */
  clipEndSec: number;
  outroSec: number;
  soundtrack: Soundtrack;
  /** Where the voice is on the output clock, for the beds' dip. */
  speech?: SpeechSpan[];
  videoRef: RefObject<HTMLVideoElement | null>;
}): void {
  const { enabled, playing, voiceDucked, localTime, clipEndSec, outroSec, soundtrack, speech, videoRef } = input;
  const players = useRef(new Map<string, BedPlayer>());
  const lastTick = useRef(performance.now());
  const lastLocal = useRef(localTime);
  /** Hits already played this pass, so a hit under a resting playhead fires once. */
  const fired = useRef(new Set<string>());

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = voiceDucked ? 0 : enabled ? Math.min(1, Math.max(0, soundtrack.voiceGain ?? 1)) : 1;
    return () => {
      video.volume = 1;
    };
  }, [enabled, voiceDucked, soundtrack.voiceGain, videoRef]);

  const beds = musicBeds(soundtrack);
  const voiceHeard = !voiceDucked && (soundtrack.voiceGain ?? 1) > 0.05 && localTime < clipEndSec;
  const talking = voiceHeard && speaking(speech ?? [], localTime);

  useEffect(() => {
    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0, (now - lastTick.current) / 1000));
    lastTick.current = now;
    const live = new Set<string>();
    for (const bed of beds) {
      live.add(bed.id);
      let player = players.current.get(bed.id);
      if (!player) {
        const el = new Audio();
        el.preload = "auto";
        el.loop = true;
        player = { el, env: 1 };
        players.current.set(bed.id, player);
      }
      const { el } = player;
      if (!enabled) {
        el.pause();
        continue;
      }
      const absolute = new URL(audioSrc(bed.assetId), window.location.href).href;
      if (el.src !== absolute) {
        el.src = absolute;
        el.load();
      }
      const inSec = Math.max(0, bed.inSec ?? 0);
      const outSec = bedOutSec(bed, clipEndSec, outroSec);
      const inSpan = localTime >= inSec && localTime < outSec;
      // The dip: toward the bed's floor while the voice is there, back to 1
      // after, at the compressor's attack and release.
      const target = talking ? dipFactor(bed.dip) : 1;
      const tau = (target < player.env ? DIP_ATTACK_MS : DIP_RELEASE_MS) / 1000;
      player.env += (target - player.env) * (1 - Math.exp(-dt / tau));
      el.volume = Math.min(1, bedLevelAt(bed, localTime, clipEndSec, outroSec) * player.env);
      if (playing && inSpan) {
        const fileTime = bedFileTimeAt(bed, localTime, el.duration || 16);
        if (Math.abs(el.currentTime - fileTime) > 0.4) el.currentTime = fileTime;
        void el.play().catch(() => undefined);
      } else {
        el.pause();
        player.env = 1;
      }
    }
    // A bed that was removed stops at once.
    for (const [id, player] of players.current) {
      if (!live.has(id)) {
        player.el.pause();
        player.el.removeAttribute("src");
        players.current.delete(id);
      }
    }
  }, [enabled, playing, localTime, clipEndSec, outroSec, beds, talking]);

  useEffect(() => {
    const map = players.current;
    return () => {
      for (const player of map.values()) player.el.pause();
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
