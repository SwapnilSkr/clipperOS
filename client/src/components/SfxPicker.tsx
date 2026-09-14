import { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import type { AudioAsset } from "@/api";
import { audioSrc } from "@/lib/live-soundtrack";
import { cn } from "@/lib/utils";

// ============================================================
// SFX PICKER — choose a one-shot by ear.
//
// A list, not a dropdown: every sound has a play button, so the choice is
// made by listening rather than by name. Used by the SFX lane's "+" (pick,
// then place at the playhead) and by the inspector (change a placed hit).
// ============================================================

const LAST_SFX_KEY = "clipperos.lastSfx";

/** The sound the user placed last, so the next "+" leads with it. */
export function lastSfx(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_SFX_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberSfx(assetId: string): void {
  try {
    window.localStorage.setItem(LAST_SFX_KEY, assetId);
  } catch {
    // Private mode: the default just stays the built-in.
  }
}

/** One audition at a time: starting a sound stops the one still ringing. */
let auditioning: HTMLAudioElement | null = null;

export function audition(assetId: string): HTMLAudioElement {
  auditioning?.pause();
  const audio = new Audio(audioSrc(assetId));
  audio.volume = 0.9;
  auditioning = audio;
  void audio.play().catch(() => undefined);
  return audio;
}

export function SfxPicker({
  assets,
  value,
  onPick,
  autoFocus,
}: {
  assets: AudioAsset[];
  /** The current choice, highlighted. */
  value?: string;
  onPick: (assetId: string) => void;
  autoFocus?: boolean;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const current = useRef<HTMLAudioElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const selectedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoFocus) firstRef.current?.focus({ preventScroll: true });
    return () => current.current?.pause();
  }, [autoFocus]);
  // Open on the current choice rather than the top of the list.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [value]);

  function toggle(assetId: string) {
    if (playing === assetId) {
      current.current?.pause();
      setPlaying(null);
      return;
    }
    const audio = audition(assetId);
    current.current = audio;
    setPlaying(assetId);
    audio.onended = () => setPlaying((prev) => (prev === assetId ? null : prev));
  }

  const custom = assets.filter((asset) => asset.id.startsWith("custom:"));
  const builtin = assets.filter((asset) => !asset.id.startsWith("custom:"));
  const groups: [string, AudioAsset[]][] = custom.length > 0 ? [["Yours", custom], ["Built in", builtin]] : [["", builtin]];
  let index = 0;

  return (
    <div className="max-h-64 overflow-y-auto pr-0.5" role="listbox" aria-label="Sound effects">
      {groups.map(([title, group]) => (
        <div key={title || "builtin"}>
          {title ? <p className="eyebrow mb-1 mt-2 text-muted first:mt-0">{title}</p> : null}
          {group.map((asset) => {
            const selected = asset.id === value;
            const first = index++ === 0;
            return (
              <div
                key={asset.id}
                ref={selected ? selectedRef : undefined}
                className={cn(
                  "flex items-center gap-1 rounded-md",
                  selected ? "bg-accent/15 text-accent" : "text-fg hover:bg-panel"
                )}
              >
                <button
                  type="button"
                  onClick={() => toggle(asset.id)}
                  aria-label={`${playing === asset.id ? "Stop" : "Play"} ${asset.label}`}
                  className="press inline-flex size-7 shrink-0 items-center justify-center rounded text-muted hover:text-fg"
                >
                  {playing === asset.id ? (
                    <Square className="size-3 fill-current" aria-hidden="true" />
                  ) : (
                    <Play className="size-3 fill-current" aria-hidden="true" />
                  )}
                </button>
                <button
                  ref={first ? firstRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => onPick(asset.id)}
                  onDoubleClick={() => toggle(asset.id)}
                  className="text-ui flex h-7 min-w-0 flex-1 items-center justify-between pr-2 text-left"
                >
                  <span className="truncate">{asset.label}</span>
                  <span className="text-micro ml-2 shrink-0 text-muted">{Math.max(0.1, asset.durationSec).toFixed(1)}s</span>
                </button>
              </div>
            );
          })}
        </div>
      ))}
      {assets.length === 0 ? <p className="text-meta text-muted">No sound effects yet.</p> : null}
    </div>
  );
}
