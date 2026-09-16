import { useEffect, useMemo, useState } from "react";
import { Music, Search, Trash2, Upload, Volume2 } from "lucide-react";
import { api, type AudioAsset, type Soundtrack, type SoundtrackHit } from "@/api";
import { MAX_SOUNDTRACK_HITS } from "@/lib/beat-plan";
import { bedOutSec, musicBeds } from "@/lib/music-beds";
import { cn, timecode } from "@/lib/utils";
import { FreesoundSearch } from "./FreesoundSearch";
import { MusicBedsEditor } from "./MusicBeds";

export { MAX_SOUNDTRACK_HITS };

export function soundtrackPayload(track: Soundtrack): Soundtrack {
  const hits = track.sfx ?? [];
  const beds = musicBeds(track);
  const voice = track.voiceGain;
  if (beds.length === 0 && hits.length === 0 && (voice == null || Math.abs(voice - 1) < 0.001)) {
    return {};
  }
  return {
    ...(voice != null ? { voiceGain: voice } : {}),
    // Always sent, so clearing the last bed clears it on the server too.
    beds,
    ...(hits.length > 0 ? { sfx: hits } : {}),
  };
}

export function MixTimeline({
  soundtrack,
  localTime,
  durationSec,
  outroSec = 0,
  onSeekLocal,
}: {
  soundtrack: Soundtrack;
  localTime: number;
  durationSec: number;
  /** Sting length after the clip window. 0 hides that region. */
  outroSec?: number;
  onSeekLocal: (sec: number) => void;
}) {
  const clipSpan = Math.max(0.1, durationSec);
  const span = Math.max(0.1, clipSpan + Math.max(0, outroSec));
  const playhead = Math.min(1, Math.max(0, localTime / span));
  const clipPct = (clipSpan / span) * 100;
  const beds = musicBeds(soundtrack);
  // Each bed on its own lane, over the stretch it plays.
  const laneHeight = 20 / Math.max(1, beds.length);
  return (
    <button
      type="button"
      aria-label={outroSec > 0 ? "Clip and sting timeline" : "Sound timeline"}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left) / Math.max(1, rect.width);
        onSeekLocal(Math.min(span, Math.max(0, x * span)));
      }}
      className="relative mt-1 h-7 w-full overflow-hidden rounded-md border border-border bg-panel-2"
    >
      {beds.map((bed, index) => {
        const from = Math.min(span, Math.max(0, bed.inSec ?? 0));
        const to = Math.max(from, bedOutSec(bed, clipSpan, outroSec));
        return (
          <span
            key={bed.id}
            className="absolute rounded-sm bg-accent/25"
            style={{
              top: 4 + index * laneHeight,
              height: Math.max(2, laneHeight - 1),
              left: `${(from / span) * 100}%`,
              width: `${((to - from) / span) * 100}%`,
            }}
          />
        );
      })}
      {outroSec > 0 ? (
        <span
          className="absolute inset-y-1 rounded-sm bg-fg/10"
          style={{ left: `${clipPct}%`, right: 0 }}
        />
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
  outroSec = 0,
  live,
}: {
  projectId: string;
  soundtrack: Soundtrack;
  onChange: (next: Soundtrack) => void;
  localTime: number;
  /** Clip window, or clip + sting when a ready outro is attached. */
  durationSec: number;
  outroSec?: number;
  /** Whether the editor is playing the mix live (source preview). Playback itself is the editor's. */
  live: boolean;
}) {
  const [library, setLibrary] = useState<AudioAsset[]>([]);
  const [custom, setCustom] = useState<AudioAsset[]>([]);
  const [maxCustom, setMaxCustom] = useState(24);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadKind, setUploadKind] = useState<"music" | "sfx">("sfx");
  // Freesound search shows once the server says a key is configured.
  const [freesound, setFreesound] = useState<boolean | null>(null);

  function refreshLibrary() {
    void api
      .listAudioLibrary(projectId)
      .then((result) => {
        setLibrary(result.builtin);
        setCustom(result.custom);
        if (result.maxCustom) setMaxCustom(result.maxCustom);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    refreshLibrary();
  }, [projectId]);

  useEffect(() => {
    void api
      .studioSources()
      .then((sources) => setFreesound(sources.freesound))
      .catch(() => setFreesound(false));
  }, []);

  const musicTracks = useMemo(
    () => [...library, ...custom].filter((asset) => asset.kind === "music"),
    [library, custom]
  );
  const [sfxFilter, setSfxFilter] = useState("");
  const allSfx = useMemo(() => [...library, ...custom].filter((asset) => asset.kind === "sfx"), [library, custom]);
  // Past a glance's worth of chips, a filter over names and the harness's descriptions.
  const sfxTracks = useMemo(() => {
    const query = sfxFilter.trim().toLowerCase();
    if (!query) return allSfx;
    return allSfx.filter((asset) => `${asset.label} ${asset.sense?.line ?? ""} ${(asset.sense?.tags ?? []).join(" ")}`.toLowerCase().includes(query)).slice(0, 40);
  }, [allSfx, sfxFilter]);
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of [...library, ...custom]) map.set(asset.id, asset.label);
    return map;
  }, [library, custom]);

  const clipEnd = Math.max(0.1, durationSec - Math.max(0, outroSec));

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

  function setHitGain(id: string, gain: number) {
    onChange({ ...soundtrack, sfx: (soundtrack.sfx ?? []).map((hit) => (hit.id === id ? { ...hit, gain: round3(gain) } : hit)) });
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
        beds: musicBeds(soundtrack).filter((bed) => bed.assetId !== assetId),
        sfx: (soundtrack.sfx ?? []).filter((hit) => hit.assetId !== assetId),
      });
      refreshLibrary();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const hits = soundtrack.sfx ?? [];
  const voiceGain = soundtrack.voiceGain ?? 1;

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
      <div className="mt-1.5">
        <MusicBedsEditor
          soundtrack={soundtrack}
          onChange={onChange}
          assets={musicTracks}
          localTime={localTime}
          clipEndSec={clipEnd}
          outroSec={outroSec}
        />
      </div>

      <p className="eyebrow mt-4 text-muted">
        {outroSec > 0 ? "Hits at playhead — clip or sting" : "Hits at playhead"}
      </p>
      {allSfx.length > 24 ? (
        <input
          value={sfxFilter}
          onChange={(event) => setSfxFilter(event.target.value)}
          placeholder={`Search ${allSfx.length} sounds…`}
          aria-label="Search sound effects"
          className="text-ui mt-1.5 h-9 w-full rounded-md border border-control bg-panel-2 px-2 outline-none focus:border-accent"
        />
      ) : null}
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
        {sfxTracks.length === 0 && sfxFilter.trim() ? <span className="text-meta text-muted">Nothing matches.</span> : null}
      </div>
      {freesound !== null ? (
        <details className="mt-2 rounded-lg border border-border bg-panel-2/40">
          <summary className="text-ui flex cursor-pointer items-center gap-1.5 px-3 py-2 font-semibold text-muted">
            <Search className="size-3.5" aria-hidden="true" />
            Find a sound on Freesound
          </summary>
          <div className="border-t border-border px-3 pb-3 pt-2">
            {freesound ? (
              <>
                <p className="text-meta mb-2 text-muted">
                  Real recordings up to 8 s, CC0 or credit-kept. Take one into the shared library, then drop it at the playhead.
                </p>
                <FreesoundSearch
                  onTaken={() => refreshLibrary()}
                  onPlace={addHit}
                  placeDisabled={hits.length >= MAX_SOUNDTRACK_HITS}
                  placeLabel={hits.length >= MAX_SOUNDTRACK_HITS ? `${MAX_SOUNDTRACK_HITS} hits max` : "Drop at playhead"}
                />
              </>
            ) : (
              <p className="text-meta text-muted">Freesound needs FREESOUND_API_KEY in the server's .env (a free key from freesound.org/apiv2/apply), then a server restart.</p>
            )}
          </div>
        </details>
      ) : null}
      {hits.length === 0 ? (
        <p className="text-meta mt-2 text-muted">No hits yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {hits.map((hit) => (
            <li key={hit.id} className="rounded-lg border border-border bg-panel-2/50 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-ui min-w-0 flex-1 truncate">
                  {labels.get(hit.assetId) ?? hit.assetId}
                </span>
                <span className="num text-micro text-muted">
                  {outroSec > 0 && hit.atSec >= clipEnd - 0.02
                    ? `sting ${timecode(Math.max(0, hit.atSec - clipEnd))}`
                    : timecode(hit.atSec)}
                </span>
                <button
                  type="button"
                  onClick={() => removeHit(hit.id)}
                  aria-label={`Remove ${labels.get(hit.assetId) ?? "hit"}`}
                  className="press inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-bad/15 hover:text-bad"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <label className="flex items-center gap-2">
                <span className="text-micro w-8 shrink-0 text-muted">Level</span>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={hit.gain ?? 0.9}
                  aria-label={`${labels.get(hit.assetId) ?? "Hit"} level`}
                  onChange={(event) => setHitGain(hit.id, Number(event.target.value))}
                  className="accent-accent h-8 min-w-0 flex-1"
                />
                <span className="num text-micro w-9 text-right font-semibold">{Math.round((hit.gain ?? 0.9) * 100)}%</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <details className="mt-3 rounded-lg border border-border bg-panel-2/40">
        <summary className="text-ui cursor-pointer px-3 py-2 font-semibold text-muted">
          Shared library
        </summary>
        <div className="border-t border-border px-3 pb-3">
          <p className="text-meta mt-2 text-muted">
            Up to {maxCustom} files, 8 MB each. Every project can use these.
          </p>
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
                disabled={uploading || custom.length >= maxCustom}
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

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
