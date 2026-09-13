import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Music, Trash2, Upload, Volume2 } from "lucide-react";
import {
  api,
  builtinAudioUrl,
  projectAudioUrl,
  type AudioAsset,
  type Soundtrack,
  type SoundtrackHit,
} from "@/api";
import { cn, timecode } from "@/lib/utils";

export const MAX_SOUNDTRACK_HITS = 16;

export function soundtrackPayload(track: Soundtrack): Soundtrack {
  const hits = track.sfx ?? [];
  const hasMusic = Boolean(track.music?.assetId);
  const voice = track.voiceGain;
  if (!hasMusic && hits.length === 0 && (voice == null || Math.abs(voice - 1) < 0.001)) {
    return {};
  }
  return {
    ...(voice != null ? { voiceGain: voice } : {}),
    ...(hasMusic ? { music: track.music } : {}),
    ...(hits.length > 0 ? { sfx: hits } : {}),
  };
}

export function MixTimeline({
  soundtrack,
  localTime,
  durationSec,
  onSeekLocal,
}: {
  soundtrack: Soundtrack;
  localTime: number;
  durationSec: number;
  onSeekLocal: (sec: number) => void;
}) {
  const span = Math.max(0.1, durationSec);
  const playhead = Math.min(1, Math.max(0, localTime / span));
  return (
    <button
      type="button"
      aria-label="Sound timeline"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left) / Math.max(1, rect.width);
        onSeekLocal(Math.min(span, Math.max(0, x * span)));
      }}
      className="relative mt-1 h-7 w-full overflow-hidden rounded-md border border-border bg-panel-2"
    >
      {soundtrack.music?.assetId ? (
        <span className="absolute inset-y-1 start-0 end-0 rounded-sm bg-accent/20" />
      ) : null}
      {(soundtrack.sfx ?? []).map((hit) => (
        <span
          key={hit.id}
          className="absolute top-0.5 h-6 w-0.5 bg-accent-2"
          style={{ left: `${Math.min(99, Math.max(0, (hit.atSec / span) * 100))}%` }}
        />
      ))}
      <span
        className="absolute top-0 h-full w-0.5 bg-fg"
        style={{ left: `${playhead * 100}%` }}
      />
    </button>
  );
}

export function MixPanel({
  projectId,
  soundtrack,
  onChange,
  localTime,
  durationSec,
  playing,
  live,
  videoRef,
}: {
  projectId: string;
  soundtrack: Soundtrack;
  onChange: (next: Soundtrack) => void;
  localTime: number;
  durationSec: number;
  playing: boolean;
  live: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [library, setLibrary] = useState<AudioAsset[]>([]);
  const [custom, setCustom] = useState<AudioAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadKind, setUploadKind] = useState<"music" | "sfx">("sfx");
  const musicEl = useRef<HTMLAudioElement>(null);
  const lastLocal = useRef(localTime);

  function refreshLibrary() {
    void api
      .listAudioLibrary(projectId)
      .then((result) => {
        setLibrary(result.builtin);
        setCustom(result.custom);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    refreshLibrary();
  }, [projectId]);

  const musicTracks = useMemo(
    () => [...library, ...custom].filter((asset) => asset.kind === "music"),
    [library, custom]
  );
  const sfxTracks = useMemo(
    () => [...library, ...custom].filter((asset) => asset.kind === "sfx"),
    [library, custom]
  );
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of [...library, ...custom]) map.set(asset.id, asset.label);
    return map;
  }, [library, custom]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = live ? Math.min(1, Math.max(0, soundtrack.voiceGain ?? 1)) : 1;
    return () => {
      video.volume = 1;
    };
  }, [live, soundtrack.voiceGain, videoRef]);

  const musicSrc = soundtrack.music?.assetId
    ? audioSrc(projectId, soundtrack.music.assetId)
    : undefined;

  useEffect(() => {
    const el = musicEl.current;
    if (!el) return;
    if (!live || !musicSrc) {
      el.pause();
      return;
    }
    el.volume = Math.min(1, soundtrack.music?.gain ?? 0.22);
    const bed = Math.max(0.5, el.duration || 16);
    const target = localTime % bed;
    if (Math.abs(el.currentTime - target) > 0.4) el.currentTime = target;
    if (playing) void el.play().catch(() => undefined);
    else el.pause();
  }, [live, musicSrc, playing, localTime, soundtrack.music?.gain]);

  useEffect(() => {
    if (!live || !playing) {
      lastLocal.current = localTime;
      return;
    }
    const prev = lastLocal.current;
    lastLocal.current = localTime;
    for (const hit of soundtrack.sfx ?? []) {
      if (prev <= hit.atSec && localTime >= hit.atSec) playOneShot(projectId, hit);
    }
  }, [live, playing, localTime, soundtrack.sfx, projectId]);

  function setMusic(assetId: string | null) {
    if (!assetId) {
      const next = { ...soundtrack };
      delete next.music;
      onChange(next);
      return;
    }
    onChange({
      ...soundtrack,
      music: {
        assetId,
        gain: soundtrack.music?.gain ?? 0.22,
        duck: soundtrack.music?.duck ?? true,
      },
    });
  }

  function addHit(assetId: string) {
    const existing = soundtrack.sfx ?? [];
    if (existing.length >= MAX_SOUNDTRACK_HITS) return;
    const hit: SoundtrackHit = {
      id: crypto.randomUUID(),
      assetId,
      atSec: round3(Math.max(0, Math.min(durationSec, localTime))),
      gain: 0.9,
    };
    onChange({ ...soundtrack, sfx: [...existing, hit].sort((a, b) => a.atSec - b.atSec) });
  }

  function removeHit(id: string) {
    onChange({ ...soundtrack, sfx: (soundtrack.sfx ?? []).filter((hit) => hit.id !== id) });
  }

  async function onUpload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await api.uploadProjectAudio(projectId, file, uploadKind);
      refreshLibrary();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function onDeleteCustom(assetId: string) {
    const fileId = assetId.startsWith("custom:") ? assetId.slice("custom:".length) : "";
    if (!fileId) return;
    setError(null);
    try {
      await api.deleteProjectAudio(projectId, fileId);
      onChange({
        ...soundtrack,
        music: soundtrack.music?.assetId === assetId ? undefined : soundtrack.music,
        sfx: (soundtrack.sfx ?? []).filter((hit) => hit.assetId !== assetId),
      });
      refreshLibrary();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const hits = soundtrack.sfx ?? [];
  const voiceGain = soundtrack.voiceGain ?? 1;
  const musicGain = soundtrack.music?.gain ?? 0.22;

  return (
    <section className="rounded-xl border border-border bg-panel p-3">
      <h3 className="eyebrow mb-1 flex items-center gap-1.5 text-muted">
        <Music className="size-3" aria-hidden="true" />
        Sound
      </h3>
      <p className="text-meta mb-3 text-muted">
        Keep the picture from Edit. Add a bed and hits here, then export.
      </p>
      {!live ? (
        <p className="text-meta mb-3 rounded-md bg-warn/10 px-2 py-1 text-warn">
          Switch the preview to Source to hear this mix.
        </p>
      ) : null}

      <audio ref={musicEl} src={musicSrc} preload="auto" loop hidden />

      <label className="block">
        <span className="text-ui flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-muted">
            <Volume2 className="size-3.5" aria-hidden="true" />
            Voice
          </span>
          <span className="num font-semibold">{Math.round(voiceGain * 100)}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.05}
          value={voiceGain}
          onChange={(event) => onChange({ ...soundtrack, voiceGain: Number(event.target.value) })}
          className="accent-accent mt-1 h-11 w-full"
        />
      </label>

      <p className="eyebrow mt-4 text-muted">Music</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Chip active={!soundtrack.music?.assetId} label="None" onClick={() => setMusic(null)} />
        {musicTracks.map((asset) => (
          <Chip
            key={asset.id}
            active={soundtrack.music?.assetId === asset.id}
            label={asset.label}
            onClick={() => setMusic(asset.id)}
          />
        ))}
      </div>
      {soundtrack.music?.assetId ? (
        <div className="mt-2">
          <label className="block">
            <span className="text-ui flex items-center justify-between">
              <span className="text-muted">Bed level</span>
              <span className="num font-semibold">{Math.round(musicGain * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={0.8}
              step={0.02}
              value={musicGain}
              onChange={(event) =>
                onChange({
                  ...soundtrack,
                  music: {
                    assetId: soundtrack.music!.assetId,
                    duck: soundtrack.music?.duck ?? true,
                    gain: Number(event.target.value),
                  },
                })
              }
              className="accent-accent mt-1 h-11 w-full"
            />
          </label>
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={soundtrack.music?.duck !== false}
              onChange={(event) =>
                onChange({
                  ...soundtrack,
                  music: {
                    assetId: soundtrack.music!.assetId,
                    gain: musicGain,
                    duck: event.target.checked,
                  },
                })
              }
              className="size-4 accent-accent"
            />
            <span className="text-ui text-muted">Dip under speech</span>
          </label>
        </div>
      ) : null}

      <p className="eyebrow mt-4 text-muted">Hits at playhead</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {sfxTracks.map((asset) => (
          <Chip
            key={asset.id}
            active={false}
            label={asset.label}
            disabled={hits.length >= MAX_SOUNDTRACK_HITS}
            onClick={() => addHit(asset.id)}
          />
        ))}
      </div>
      {hits.length === 0 ? (
        <p className="text-meta mt-2 text-muted">No hits yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {hits.map((hit) => (
            <li key={hit.id} className="flex items-center gap-2 rounded-lg border border-border bg-panel-2/50 px-2 py-1.5">
              <span className="text-ui min-w-0 flex-1 truncate">
                {labels.get(hit.assetId) ?? hit.assetId}
              </span>
              <span className="num text-micro text-muted">{timecode(hit.atSec)}</span>
              <button
                type="button"
                onClick={() => removeHit(hit.id)}
                aria-label={`Remove ${labels.get(hit.assetId) ?? "hit"}`}
                className="press inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-bad/15 hover:text-bad"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <details className="mt-3 rounded-lg border border-border bg-panel-2/40">
        <summary className="text-ui cursor-pointer px-3 py-2 font-semibold text-muted">
          Your files
        </summary>
        <div className="border-t border-border px-3 pb-3">
          <p className="text-meta mt-2 text-muted">Up to 8 files, 8 MB each. Stored with this project.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={uploadKind}
              onChange={(event) => setUploadKind(event.target.value as "music" | "sfx")}
              className="text-ui h-10 rounded-lg border border-control bg-panel px-2"
            >
              <option value="sfx">As hit</option>
              <option value="music">As music</option>
            </select>
            <label className="press text-ui inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-control px-3 font-medium hover:border-accent">
              <Upload className="size-3.5" aria-hidden="true" />
              {uploading ? "Adding…" : "Upload"}
              <input
                type="file"
                accept="audio/*,video/mp4"
                className="sr-only"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void onUpload(file);
                }}
              />
            </label>
          </div>
          {custom.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {custom.map((asset) => (
                <li key={asset.id} className="flex items-center gap-2">
                  <span className="text-ui min-w-0 flex-1 truncate">{asset.label}</span>
                  <span className="text-micro text-muted">{asset.kind}</span>
                  <button
                    type="button"
                    onClick={() => void onDeleteCustom(asset.id)}
                    className="text-micro font-semibold text-muted hover:text-bad"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>

      {error ? <p className="text-meta mt-2 text-bad">{error}</p> : null}
    </section>
  );
}

function Chip({
  active,
  label,
  disabled,
  onClick,
}: {
  active: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "press text-ui h-9 rounded-full border px-3 font-medium",
        active
          ? "border-accent bg-accent/10 text-fg"
          : "border-border text-muted hover:border-control hover:text-fg",
        disabled && "opacity-40"
      )}
    >
      {label}
    </button>
  );
}

function audioSrc(projectId: string, assetId: string): string {
  if (assetId.startsWith("custom:")) {
    return projectAudioUrl(projectId, assetId.slice("custom:".length));
  }
  return builtinAudioUrl(assetId);
}

function playOneShot(projectId: string, hit: SoundtrackHit): void {
  const src = audioSrc(projectId, hit.assetId);
  const audio = new Audio(src);
  audio.volume = Math.min(1, hit.gain ?? 0.9);
  void audio.play().catch(() => undefined);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
