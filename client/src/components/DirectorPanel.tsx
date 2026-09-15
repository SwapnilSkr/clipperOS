import { useState } from "react";
import { Clapperboard, Eye, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import type { ClipSense, DirectInput, DirectorAssetMode, DirectorLane, DirectorNotes, DirectorTurn, RenderReview } from "@/api";
import { cn, timecode } from "@/lib/utils";
import { Panel } from "./editor-controls";

// ============================================================
// DIRECTOR PANEL — the one-click plan, and a short conversation to redirect it.
//
// Nothing here changes the plan directly: the editor flushes its draft, asks
// the server for a pass, then adopts the returned plan. Each pass is kept as
// a turn (the note, and what the Director said it did), and the server hands
// the last few back to the model, so a note builds on the ones before it.
// "Lock" chips are how a pass leaves a lane alone.
//
// The harness underneath watches the clip and listens to the library; the
// options here say where B-roll may come from (the library, stock, made to
// order, or both), whether it lays music, and whether it watches at all. A
// thumbs up or down on a pass is learned as a lesson for the next one; the
// review is the harness's own read of the last render.
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
  { id: "music", label: "Music" },
];

const ASSET_MODES: { id: DirectorAssetMode; label: string; hint: string; needsStock?: boolean }[] = [
  { id: "library", label: "Library", hint: "B-roll only from what is already in the media library" },
  { id: "stock", label: "Stock", hint: "Real footage and stills searched on Pexels / Pixabay", needsStock: true },
  { id: "ai", label: "AI", hint: "Pictures made to order: a still now, motion when it renders" },
  { id: "both", label: "Both", hint: "Stock for real-world shots, generated for stylised ones" },
];

const OPTIONS_KEY = "clipperos.director.options";

interface Options {
  assets: DirectorAssetMode;
  music: boolean;
  see: boolean;
}

function readOptions(stock: boolean): Options {
  const fallback: Options = { assets: stock ? "stock" : "library", music: true, see: true };
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Options>;
    return {
      assets: parsed.assets && ASSET_MODES.some((mode) => mode.id === parsed.assets) ? parsed.assets : fallback.assets,
      music: parsed.music ?? true,
      see: parsed.see ?? true,
    };
  } catch {
    return fallback;
  }
}

export interface DirectorPanelProps {
  director?: DirectorNotes;
  /** True once a plan exists, so the button reads as a redirect. */
  hasPlan: boolean;
  disabled?: boolean;
  /** A stock provider is configured on the server. */
  stock: boolean;
  /** What the harness saw and heard in the window, when it has watched. */
  sense?: ClipSense;
  /** The harness's critique of the last render it watched. */
  review?: RenderReview;
  /** The clip has a render the harness could watch. */
  rendered: boolean;
  onDirect: (input: DirectInput) => Promise<{ warnings: string[]; pending: string[] }>;
  onFeedback: (verdict: "up" | "down", note?: string) => Promise<void>;
  onReview: () => Promise<void>;
  onSense: () => Promise<void>;
}

export function DirectorPanel({ director, hasPlan, disabled, stock, sense, review, rendered, onDirect, onFeedback, onReview, onSense }: DirectorPanelProps) {
  const [notes, setNotes] = useState("");
  const [keep, setKeep] = useState<DirectorLane[]>([]);
  const [options, setOptions] = useState<Options>(() => readOptions(stock));
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState<"sense" | "review" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<"up" | "down" | null>(null);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [thanked, setThanked] = useState<string | null>(null);

  function setOption<K extends keyof Options>(key: K, value: Options[K]) {
    setOptions((prev) => {
      const next = { ...prev, [key]: value };
      try {
        window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      } catch {
        // Private mode: the choice lasts the session.
      }
      return next;
    });
  }

  async function run() {
    setBusy(true);
    setError(null);
    setWarnings([]);
    setPending([]);
    setThanked(null);
    setVerdict(null);
    try {
      const result = await onDirect({ notes: notes.trim() || undefined, keep, assets: options.assets, music: options.music, see: options.see });
      setWarnings(result.warnings);
      setPending(result.pending);
      // The note now lives in the conversation below.
      setNotes("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendFeedback(choice: "up" | "down") {
    setError(null);
    try {
      await onFeedback(choice, feedbackNote.trim() || undefined);
      setThanked(choice === "up" ? "Noted — it will keep doing that." : "Noted — it will do that differently next time.");
      setVerdict(null);
      setFeedbackNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function watch(what: "sense" | "review") {
    setWatching(what);
    setError(null);
    try {
      if (what === "sense") await onSense();
      else await onReview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWatching(null);
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
            ? "Slow-mo the last line, VHS on the hook, a dragon on “dragon”, a darker bed…"
            : "Notes (optional) — harder hook, a freeze on the punchline, B-roll of…"
        }
        aria-label="Notes for the Director"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy && !disabled) void run();
        }}
        className="text-ui w-full resize-y rounded-md border border-control bg-panel-2 px-2 py-2 outline-none focus:border-accent"
      />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-micro mr-1 text-muted">B-roll</span>
        {ASSET_MODES.map((mode) => {
          const off = mode.needsStock && !stock;
          return (
            <button
              key={mode.id}
              type="button"
              disabled={off}
              aria-pressed={options.assets === mode.id}
              title={off ? "No stock provider is configured (PEXELS_API_KEY / PIXABAY_API_KEY)" : mode.hint}
              onClick={() => setOption("assets", mode.id)}
              className={cn(
                "press text-micro rounded-full border px-2 py-0.5 font-semibold",
                options.assets === mode.id ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:border-control",
                off && "opacity-40"
              )}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={options.see} onChange={(event) => setOption("see", event.target.checked)} className="size-3.5 accent-accent" />
          <span className="text-micro text-muted" title="The clip itself goes to the model, so beats land on what it sees (about half a cent per pass)">
            Watch the clip
          </span>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={options.music} onChange={(event) => setOption("music", event.target.checked)} className="size-3.5 accent-accent" />
          <span className="text-micro text-muted" title="Lay music beds from the library — chosen by how they sound — or made to order in AI / Both">
            Lay music
          </span>
        </label>
      </div>

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
        {busy ? (options.see ? "Watching and directing…" : "Directing…") : hasPlan ? "Redirect" : "Direct this clip"}
      </button>
      {busy && (options.assets === "ai" || options.assets === "both") ? (
        <p className="text-meta mt-1 text-muted">Made-to-order pictures and beds add 10–40 s each.</p>
      ) : null}
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
      {pending.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {pending.map((item) => (
            <li key={item} className="text-meta text-muted">
              ⏳ {item}
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
          {thanked ? (
            <p className="text-meta text-accent">{thanked}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-micro text-muted">This pass:</span>
              <button
                type="button"
                aria-pressed={verdict === "up"}
                onClick={() => setVerdict(verdict === "up" ? null : "up")}
                className={cn("press inline-flex size-8 items-center justify-center rounded-md border border-border text-muted hover:text-fg", verdict === "up" && "border-accent text-accent")}
                aria-label="Good pass"
              >
                <ThumbsUp className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-pressed={verdict === "down"}
                onClick={() => setVerdict(verdict === "down" ? null : "down")}
                className={cn("press inline-flex size-8 items-center justify-center rounded-md border border-border text-muted hover:text-fg", verdict === "down" && "border-bad text-bad")}
                aria-label="Bad pass"
              >
                <ThumbsDown className="size-3.5" aria-hidden="true" />
              </button>
              {verdict ? (
                <div className="flex w-full items-center gap-1.5">
                  <input
                    value={feedbackNote}
                    onChange={(event) => setFeedbackNote(event.target.value)}
                    maxLength={400}
                    placeholder={verdict === "up" ? "What worked? (optional)" : "What should it do differently? (optional)"}
                    aria-label="Feedback note"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void sendFeedback(verdict);
                    }}
                    className="text-ui h-9 min-w-0 flex-1 rounded-md border border-control bg-panel-2 px-2 outline-none focus:border-accent"
                  />
                  <button type="button" onClick={() => void sendFeedback(verdict)} className="press text-ui h-9 rounded-md border border-accent px-2 font-semibold text-accent">
                    Teach it
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      <details className="mt-3 rounded-lg border border-border bg-panel-2/40" open={Boolean(sense) && !latest}>
        <summary className="text-ui flex cursor-pointer items-center gap-1.5 px-3 py-2 font-semibold text-muted">
          <Eye className="size-3.5" aria-hidden="true" />
          What it saw
          {sense ? <span className="text-micro ml-auto font-normal">{sense.shots.length} shots · {sense.moments.length} moments</span> : null}
        </summary>
        <div className="border-t border-border px-3 pb-3">
          {sense ? (
            <div className="text-meta mt-2 space-y-1.5 text-muted">
              <p>
                <span className="font-semibold text-fg">Overall.</span> {sense.overall}
              </p>
              <p>
                <span className="font-semibold text-fg">Hook.</span> {sense.hook}
              </p>
              <p>
                <span className="font-semibold text-fg">Payoff.</span> {sense.payoff}
              </p>
              <p>
                <span className="font-semibold text-fg">Sound.</span> {sense.audio}
              </p>
              {sense.moments.length > 0 ? (
                <ul className="space-y-0.5">
                  {sense.moments.map((moment) => (
                    <li key={`${moment.t}-${moment.what}`}>
                      <span className="num text-fg">{timecode(moment.t)}</span> {moment.what} <span className="text-accent">→ {moment.use}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {sense.broll.length > 0 ? (
                <p>
                  <span className="font-semibold text-fg">B-roll it would cut to.</span>{" "}
                  {sense.broll.map((idea) => `${timecode(idea.t)} ${idea.idea}`).join(" · ")}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-meta mt-2 text-muted">It has not watched this window yet.</p>
          )}
          <button
            type="button"
            disabled={watching !== null || disabled}
            onClick={() => void watch("sense")}
            className="press text-micro mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 font-semibold text-muted hover:border-control hover:text-fg disabled:opacity-50"
          >
            {watching === "sense" ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Eye className="size-3" aria-hidden="true" />}
            {sense ? "Watch again" : "Watch the clip"}
          </button>
        </div>
      </details>

      <details className="mt-2 rounded-lg border border-border bg-panel-2/40">
        <summary className="text-ui flex cursor-pointer items-center gap-1.5 px-3 py-2 font-semibold text-muted">
          After the render
          {review ? (
            <span className={cn("text-micro ml-auto font-semibold", review.score >= 8 ? "text-accent" : review.score >= 6 ? "text-warn" : "text-bad")}>{review.score}/10</span>
          ) : null}
        </summary>
        <div className="border-t border-border px-3 pb-3">
          {review ? (
            <div className="text-meta mt-2 space-y-1.5 text-muted">
              <p>{review.verdict}</p>
              {review.issues.length > 0 ? (
                <ul className="space-y-0.5">
                  {review.issues.map((issue) => (
                    <li key={`${issue.t}-${issue.what}`}>
                      {issue.t != null ? <span className="num text-fg">{timecode(issue.t)} </span> : null}
                      {issue.what} <span className="text-accent">→ {issue.fix}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {review.keep.length > 0 ? <p>Keep: {review.keep.join(" · ")}</p> : null}
            </div>
          ) : (
            <p className="text-meta mt-2 text-muted">
              {rendered ? "The harness has not watched this render yet." : "Export the clip and the harness watches the result, scores it, and learns from what you changed."}
            </p>
          )}
          <button
            type="button"
            disabled={watching !== null || !rendered}
            onClick={() => void watch("review")}
            className="press text-micro mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 font-semibold text-muted hover:border-control hover:text-fg disabled:opacity-50"
          >
            {watching === "review" ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Eye className="size-3" aria-hidden="true" />}
            {review ? "Watch the render again" : "Watch the render"}
          </button>
        </div>
      </details>
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
