import { useState } from "react";
import { Clapperboard, Loader2 } from "lucide-react";
import type { DirectorLane, DirectorNotes, DirectorTurn } from "@/api";
import { cn } from "@/lib/utils";
import { Panel } from "./editor-controls";

// ============================================================
// DIRECTOR PANEL — the one-click plan, and a short conversation to redirect it.
//
// Nothing here changes the plan directly: the editor flushes its draft, asks
// the server for a pass, then adopts the returned plan. Each pass is kept as
// a turn (the note, and what the Director said it did), and the server hands
// the last few back to the model, so a note builds on the ones before it.
// "Lock" chips are how a pass leaves a lane alone.
// ============================================================

const LANES: { id: DirectorLane; label: string }[] = [
  { id: "cuts", label: "Cuts" },
  { id: "camera", label: "Camera" },
  { id: "speed", label: "Speed" },
  { id: "fx", label: "FX" },
  { id: "cutaways", label: "B-roll" },
  { id: "captions", label: "Captions" },
  { id: "titles", label: "Titles" },
  { id: "sfx", label: "SFX" },
];

export interface DirectorPanelProps {
  director?: DirectorNotes;
  /** True once a plan exists, so the button reads as a redirect. */
  hasPlan: boolean;
  disabled?: boolean;
  onDirect: (input: { notes?: string; keep: DirectorLane[] }) => Promise<{ warnings: string[] }>;
}

export function DirectorPanel({ director, hasPlan, disabled, onDirect }: DirectorPanelProps) {
  const [notes, setNotes] = useState("");
  const [keep, setKeep] = useState<DirectorLane[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  async function run() {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const result = await onDirect({ notes: notes.trim() || undefined, keep });
      setWarnings(result.warnings);
      // The note now lives in the conversation below.
      setNotes("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleKeep(lane: DirectorLane) {
    setKeep((prev) => (prev.includes(lane) ? prev.filter((item) => item !== lane) : [...prev, lane]));
  }

  // Plans directed before turns existed only carry the last notes and summary.
  const turns: DirectorTurn[] = director?.turns?.length
    ? director.turns
    : director?.summary
      ? [{ notes: director.notes, summary: director.summary, at: director.generatedAt ?? "" }]
      : [];
  const latest = turns[turns.length - 1];
  const earlier = turns.slice(0, -1);

  return (
    <Panel title="AI Director" icon={Clapperboard}>
      <textarea
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        rows={2}
        maxLength={600}
        placeholder={
          hasPlan
            ? "Slow-mo the last line, VHS on the hook, cut to a server room on “compute”…"
            : "Notes (optional) — harder hook, a freeze on the punchline, B-roll of…"
        }
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
      {warnings.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="text-meta text-warn">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
      {latest ? (
        <div className="mt-3 space-y-2 border-t border-border pt-2">
          {earlier.length > 0 ? (
            <details>
              <summary className="text-micro cursor-pointer text-muted hover:text-fg">
                Earlier passes ({earlier.length})
              </summary>
              <div className="mt-1.5 space-y-2">
                {earlier.map((turn, index) => (
                  <TurnView key={`${turn.at}-${index}`} turn={turn} compact />
                ))}
              </div>
            </details>
          ) : null}
          <TurnView turn={latest} model={director?.model} />
        </div>
      ) : null}
    </Panel>
  );
}

function TurnView({ turn, compact, model }: { turn: DirectorTurn; compact?: boolean; model?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-meta text-fg">
        <span className="text-micro mr-1.5 font-semibold uppercase tracking-wide text-muted">You</span>
        {turn.notes ? `“${turn.notes}”` : <span className="text-muted">No notes</span>}
      </p>
      <p className={cn("text-meta leading-relaxed text-muted", compact && "line-clamp-2")} title={model}>
        <span className="text-micro mr-1.5 font-semibold uppercase tracking-wide text-accent">Director</span>
        {turn.summary}
      </p>
    </div>
  );
}
