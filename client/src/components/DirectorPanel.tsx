import { useState } from "react";
import { Clapperboard, Loader2 } from "lucide-react";
import type { DirectorLane, DirectorNotes } from "@/api";
import { cn } from "@/lib/utils";
import { Panel } from "./editor-controls";

// ============================================================
// DIRECTOR PANEL — the one-click plan, and the notes to redirect it.
//
// Nothing here changes the plan directly: the editor flushes its draft, asks
// the server for a pass, then adopts the returned plan. "Keep" locks are how
// a second pass iterates instead of reshuffling.
// ============================================================

const LANES: { id: DirectorLane; label: string }[] = [
  { id: "cuts", label: "Cuts" },
  { id: "camera", label: "Camera" },
  { id: "captions", label: "Captions" },
  { id: "titles", label: "Titles" },
  { id: "sfx", label: "SFX" },
];

export interface DirectorPanelProps {
  director?: DirectorNotes;
  /** True once a plan exists, so the button reads as a redirect. */
  hasPlan: boolean;
  disabled?: boolean;
  onDirect: (input: { notes?: string; keep: DirectorLane[] }) => Promise<void>;
}

export function DirectorPanel({ director, hasPlan, disabled, onDirect }: DirectorPanelProps) {
  const [notes, setNotes] = useState(director?.notes ?? "");
  const [keep, setKeep] = useState<DirectorLane[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await onDirect({ notes: notes.trim() || undefined, keep });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleKeep(lane: DirectorLane) {
    setKeep((prev) => (prev.includes(lane) ? prev.filter((item) => item !== lane) : [...prev, lane]));
  }

  return (
    <Panel title="AI Director" icon={Clapperboard}>
      <textarea
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        rows={2}
        maxLength={600}
        placeholder={hasPlan ? "Notes — harder hook, fewer zooms, calmer captions…" : "Notes (optional)"}
        aria-label="Notes for the Director"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy && !disabled) void run();
        }}
        className="text-ui w-full resize-y rounded-md border border-control bg-panel-2 px-2 py-2 outline-none focus:border-accent"
      />
      {hasPlan ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-micro mr-1 text-muted">Lock</span>
          {LANES.map((lane) => (
            <button
              key={lane.id}
              type="button"
              aria-pressed={keep.includes(lane.id)}
              onClick={() => toggleKeep(lane.id)}
              className={cn(
                "press text-micro rounded-full border px-2 py-0.5 font-semibold",
                keep.includes(lane.id)
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border text-muted hover:border-control"
              )}
            >
              {lane.label}
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        disabled={busy || disabled}
        onClick={() => void run()}
        title="⌘↵"
        className="press text-ui mt-2 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Clapperboard className="size-4" aria-hidden="true" />
        )}
        {busy ? "Directing…" : hasPlan ? "Redirect" : "Direct this clip"}
      </button>
      {error ? <p className="text-meta mt-2 text-bad">{error}</p> : null}
      {director?.summary ? (
        <details className="mt-2">
          <summary className="text-micro cursor-pointer text-muted hover:text-fg">Why the Director chose this</summary>
          <p className="text-meta mt-1.5 leading-relaxed text-muted" title={director.model}>
            {director.summary}
          </p>
        </details>
      ) : null}
    </Panel>
  );
}
