import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Clapperboard, Eye, Loader2, ThumbsDown, ThumbsUp, Undo2, X } from "lucide-react";
import type {
  ClipSense,
  DirectInput,
  DirectorAsk,
  DirectorAssetMode,
  DirectorEvent,
  DirectorLane,
  DirectorNotes,
  DirectorStep,
  DirectorTurn,
  RenderReview,
} from "@/api";
import { cn, timecode } from "@/lib/utils";
import { Panel } from "./editor-controls";

// ============================================================
// DIRECTOR PANEL — a conversation with the Director about this clip.
//
// Nothing here changes the plan directly: the editor flushes its draft, asks
// the server for a pass, then adopts the returned plan. Every note and what
// the Director did with it is kept as a turn; the server hands the
// conversation and the edit as it stands back to the model, so a note is a
// revision of the cut ("shorter", "undo that", "why that bed?"), not a
// reshuffle. A pass can be taken back from its turn. "Lock" chips are how a
// pass leaves a lane alone.
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

const LANE_LABELS = Object.fromEntries(LANES.map((lane) => [lane.id, lane.label])) as Record<DirectorLane, string>;

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
  /** "auto" cuts at once; "plan" proposes and asks first, then cuts on your answer. */
  mode: "auto" | "plan";
}

function readOptions(stock: boolean): Options {
  const fallback: Options = { assets: stock ? "stock" : "library", music: true, see: true, mode: "auto" };
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Options>;
    return {
      assets: parsed.assets && ASSET_MODES.some((mode) => mode.id === parsed.assets) ? parsed.assets : fallback.assets,
      music: parsed.music ?? true,
      see: parsed.see ?? true,
      mode: parsed.mode === "plan" ? "plan" : "auto",
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
  /** Runs a pass; `at` is the turn it added. */
  onDirect: (
    input: DirectInput,
    onEvent?: (event: DirectorEvent) => void
  ) => Promise<{ warnings: string[]; pending: string[]; questions?: string[]; planned?: boolean; followed?: string[]; at?: string }>;
  onFeedback: (verdict: "up" | "down", note?: string) => Promise<void>;
  /** Takes the last pass standing back. */
  onUndo: () => Promise<void>;
  onReview: () => Promise<void>;
  onSense: () => Promise<void>;
}

/** A pass as the panel watches it: each step, the thinking so far, and how far the answer has got. */
interface Activity {
  steps: DirectorStep[];
  thinking: string;
  writing: number;
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
  /** What was sent, shown in the conversation until the pass lands as a turn. */
  notes?: string;
  /** The turn the pass added, which it is then shown under. */
  forAt?: string;
}

export function DirectorPanel({ director, hasPlan, disabled, stock, sense, review, rendered, onDirect, onFeedback, onUndo, onReview, onSense }: DirectorPanelProps) {
  const [notes, setNotes] = useState("");
  const [keep, setKeep] = useState<DirectorLane[]>([]);
  const [options, setOptions] = useState<Options>(() => readOptions(stock));
  const [busy, setBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [watching, setWatching] = useState<"sense" | "review" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [verdict, setVerdict] = useState<"up" | "down" | null>(null);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [thanked, setThanked] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

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

  // Plans directed before turns existed only carry the last notes and summary.
  const turns: DirectorTurn[] = director?.turns?.length
    ? director.turns
    : director?.summary
      ? [{ notes: director.notes, summary: director.summary, at: director.generatedAt ?? "" }]
      : [];
  const latest = turns[turns.length - 1];
  // A proposal is waiting for an answer: the next run cuts unless the note asks
  // for another plan. A question asked in between is answered below it and
  // leaves it waiting.
  let proposalAt = turns.length - 1;
  while (proposalAt >= 0 && (turns[proposalAt]?.kind === "reply" || turns[proposalAt]?.kind === "undo")) proposalAt--;
  const proposal = turns[proposalAt]?.kind === "plan" ? turns[proposalAt] : undefined;
  const answering = Boolean(proposal);
  // The latest pass still standing can be taken back, once the edit before it was kept.
  let undoable: DirectorTurn | undefined;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if ((turn.kind && turn.kind !== "pass") || turn.undone) continue;
    if (turn.changed) undoable = turn;
    break;
  }
  // Picks for the waiting proposal's questions, kept per proposal; unpicked means the recommended option.
  const [chosen, setChosen] = useState<{ at: string; picks: Record<number, number> }>({ at: "", picks: {} });
  const picks = proposal && chosen.at === proposal.at ? chosen.picks : {};

  function pick(ask: number, option: number) {
    if (!proposal) return;
    setChosen({ at: proposal.at, picks: { ...picks, [ask]: option } });
  }

  // The clock on a running pass.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [busy]);

  // The newest turn and the note box come into view as the conversation grows:
  // the column that holds the panel scrolls, never the page.
  useEffect(() => {
    const el = end.current;
    let scroller = el?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!el || !scroller) return;
    const below = el.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
    if (below > 0) scroller.scrollTop += below;
  }, [turns.length, activity?.startedAt, activity?.steps.length, activity?.forAt]);

  function onEvent(event: DirectorEvent) {
    setActivity((prev) => {
      if (!prev) return prev;
      if (event.type === "thinking") return { ...prev, thinking: prev.thinking + event.text };
      if (event.type === "writing") return { ...prev, writing: event.chars };
      const { type: _type, ...step } = event;
      const steps = prev.steps.some((item) => item.id === step.id) ? prev.steps.map((item) => (item.id === step.id ? step : item)) : [...prev.steps, step];
      // Asked again: the answer starts over.
      const retry = step.id === "think" && step.state === "run" && step.detail;
      return { ...prev, steps, ...(retry ? { writing: 0, thinking: prev.thinking ? `${prev.thinking}\n\n` : "" } : {}) };
    });
  }

  async function run(planFirst: boolean) {
    const typed = notes.trim();
    // Every question with options is answered: the pick, or the recommended option.
    const answers = proposal
      ? (proposal.asks ?? []).flatMap((ask, index) => {
          const choice = ask.options?.[picks[index] ?? ask.recommended ?? 0]?.label;
          return choice ? [{ question: ask.question, choice }] : [];
        })
      : [];
    setBusy(true);
    setError(null);
    setWarnings([]);
    setPending([]);
    setThanked(null);
    setVerdict(null);
    setNow(Date.now());
    setActivity({
      steps: [],
      thinking: "",
      writing: 0,
      startedAt: Date.now(),
      notes: [typed, answers.length ? `Picked: ${answers.map((item) => item.choice).join(" · ")}` : ""].filter(Boolean).join(" — ") || undefined,
    });
    // The note moves into the conversation while the Director works on it.
    setNotes("");
    try {
      const result = await onDirect(
        {
          notes: typed || undefined,
          keep,
          assets: options.assets,
          music: options.music,
          see: options.see,
          plan: planFirst,
          ...(answers.length ? { answers } : {}),
        },
        onEvent
      );
      setWarnings(result.warnings);
      setPending(result.pending);
      setActivity((prev) => {
        if (!prev) return prev;
        // A switch decided after the note was read (the Director stopping to ask) joins the note's line.
        const extra = (result.followed ?? []).filter((line) => !prev.steps.some((step) => step.detail?.includes(line)));
        const steps = prev.steps.map((step) => ({
          ...step,
          state: step.state === "run" ? ("done" as const) : step.state,
          ...(step.id === "read" && extra.length ? { detail: [step.detail, ...extra].filter(Boolean).join(" · ") } : {}),
        }));
        return { ...prev, steps, endedAt: Date.now(), ...(result.at ? { forAt: result.at } : {}) };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActivity((prev) =>
        prev ? { ...prev, failed: true, endedAt: Date.now(), steps: prev.steps.map((step) => (step.state === "run" ? { ...step, state: "fail" as const } : step)) } : prev
      );
      // Back in the composer, ready to send again.
      setNotes((current) => current || typed);
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setUndoing(true);
    setError(null);
    setWarnings([]);
    setPending([]);
    setThanked(null);
    setVerdict(null);
    try {
      await onUndo();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUndoing(false);
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

  const planFirst = options.mode === "plan" && !answering;
  const locked = busy || undoing || disabled;
  // Thumbs are for a cut that stands; a proposal, an answer or an undo has nothing to judge.
  const judgeable = Boolean(latest) && !busy && (!latest!.kind || latest!.kind === "pass") && !latest!.undone;

  return (
    <Panel title="AI Director" icon={Clapperboard}>
      {turns.length > 0 || activity ? (
        <div className="space-y-3 pb-3">
          {turns.map((turn, index) => {
            const here = activity?.forAt === turn.at ? activity : null;
            return (
              <TurnView
                key={`${turn.at}-${index}`}
                turn={turn}
                model={director?.model}
                {...(turn === proposal ? { picks, onPick: pick } : {})}
                {...(turn === undoable ? { onUndo: () => void undo(), undoing, locked } : {})}
                activity={here ? <DirectorActivity activity={here} busy={false} now={now} /> : undefined}
              >
                {here ? <Notices warnings={warnings} pending={pending} /> : null}
              </TurnView>
            );
          })}
          {activity && !activity.forAt ? (
            <div className="space-y-1">
              <YouSaid notes={activity.notes} />
              <DirectorActivity activity={activity} busy={busy} now={now} />
            </div>
          ) : null}
          {judgeable ? (
            thanked ? (
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
            )
          ) : null}
        </div>
      ) : null}

      {/* The note box stays at the bottom of the column however long the conversation runs. */}
      <div className={cn("sticky bottom-0 z-10 -mx-3 bg-panel px-3 pb-2", (turns.length > 0 || activity) && "border-t border-border pt-2")}>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={2}
          maxLength={600}
          placeholder={
            answering
              ? "Answer its questions, change anything in the proposal — or just say go."
              : hasPlan
                ? "What should change? “Shorter B-roll”, “a darker bed”, “undo that”, “why that title?”"
                : "Notes (optional) — harder hook, a freeze on the punchline, B-roll of…"
          }
          aria-label="Notes for the Director"
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            // Enter sends a note; an empty composer needs ⌘↵, so a stray Enter never starts a whole pass.
            if (!notes.trim() && !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            if (!locked) void run(planFirst);
          }}
          className="text-ui w-full resize-y rounded-md border border-control bg-panel-2 px-2 py-2 outline-none focus:border-accent"
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={locked}
            onClick={() => void run(planFirst)}
            title="⌘↵"
            className="press text-ui inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Clapperboard className="size-4" aria-hidden="true" />
            )}
            {busy
              ? `${(activity && runningStep(activity.steps))?.label ?? "Starting"}…`
              : answering
                ? "Go ahead and cut"
                : planFirst
                  ? "Propose a cut"
                  : hasPlan
                    ? notes.trim()
                      ? "Send"
                      : "Redirect"
                    : "Direct this clip"}
          </button>
          {answering && !busy ? (
            <button
              type="button"
              disabled={locked}
              onClick={() => void run(true)}
              title="Ask it to rethink the proposal with your notes, without cutting yet"
              className="press text-ui inline-flex h-10 items-center justify-center rounded-lg border border-border px-3 font-semibold text-muted hover:border-control hover:text-fg disabled:opacity-50"
            >
              Rethink
            </button>
          ) : null}
        </div>
        {error ? <p className="text-meta mt-2 text-bad">{error}</p> : null}
      </div>
      <div ref={end} aria-hidden="true" />
      <p className="text-micro mt-1 text-muted">
        {hasPlan
          ? "Keep talking to it: it knows what it did and what you changed since. A note outranks these settings. Enter sends, Shift+Enter for a new line."
          : "Say it in your own words — a note outranks the B-roll, music and lock settings, and you can ask it anything about the editor."}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-micro mr-1 text-muted">Mode</span>
        {(
          [
            { id: "auto", label: "Auto", hint: "Reads the brief, watches the clip, cuts. One pass." },
            { id: "plan", label: "Plan first", hint: "Proposes the cut lane by lane and asks what it cannot decide; cuts on your answer." },
          ] as const
        ).map((mode) => (
          <button
            key={mode.id}
            type="button"
            aria-pressed={options.mode === mode.id}
            title={mode.hint}
            onClick={() => setOption("mode", mode.id)}
            className={cn(
              "press text-micro rounded-full border px-2 py-0.5 font-semibold",
              options.mode === mode.id ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:border-control"
            )}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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

/**
 * The Director at work: each step as it starts and lands, what it is thinking
 * (open while it runs, folded away once the pass is done), and a clock.
 */
function DirectorActivity({ activity, busy, now }: { activity: Activity; busy: boolean; now: number }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Follows the newest thinking unless the creator has scrolled back to read.
  const follow = useRef(true);
  const showThinking = open ?? busy;
  useEffect(() => {
    if (showThinking && follow.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [activity.thinking, showThinking]);
  // Each new pass starts open again.
  useEffect(() => {
    setOpen(null);
    follow.current = true;
  }, [activity.startedAt]);

  const seconds = Math.max(0, Math.round(((activity.endedAt ?? now) - activity.startedAt) / 1000));
  const running = runningStep(activity.steps);
  return (
    <div className="rounded-lg border border-border bg-panel-2/40 px-2.5 py-2" aria-live="polite">
      <div className="flex items-center gap-1.5">
        {busy ? (
          <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden="true" />
        ) : activity.failed ? (
          <X className="size-3.5 text-bad" aria-hidden="true" />
        ) : (
          <Check className="size-3.5 text-accent" aria-hidden="true" />
        )}
        <span className="text-meta font-semibold text-fg">{busy ? (running?.label ?? "Starting") : activity.failed ? "Stopped" : `Worked for ${seconds}s`}</span>
        {busy ? <span className="num text-micro ml-auto text-muted">{seconds}s</span> : null}
      </div>
      {activity.steps.length > 0 ? (
        <ol className="mt-1.5 space-y-1">
          {activity.steps.map((step) => {
            const writing = busy && step.id === "think" && step.state === "run" && activity.writing > 0;
            const detail = writing ? `writing the ${step.label === "Directing" ? "plan" : "proposal"} · ${(activity.writing / 1000).toFixed(1)}k characters` : step.detail;
            return (
              <li key={step.id} className="flex items-start gap-1.5">
                <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center">
                  {step.state === "run" ? (
                    <Loader2 className={cn("size-3 text-accent", busy && "animate-spin")} aria-hidden="true" />
                  ) : step.state === "fail" ? (
                    <X className="size-3 text-warn" aria-hidden="true" />
                  ) : (
                    <Check className="size-3 text-muted" aria-hidden="true" />
                  )}
                </span>
                <p className="text-micro min-w-0 leading-snug">
                  <span className={step.state === "run" ? "font-semibold text-fg" : "text-fg"}>{step.label}</span>
                  {detail ? <span className="text-muted"> — {detail}</span> : null}
                </p>
              </li>
            );
          })}
        </ol>
      ) : null}
      {activity.thinking ? (
        <div className="mt-1.5">
          <button type="button" onClick={() => setOpen(!showThinking)} className="press text-micro font-semibold text-muted hover:text-fg">
            {showThinking ? "Hide its thinking" : "Show its thinking"}
          </button>
          {showThinking ? (
            <div
              ref={box}
              onScroll={(event) => {
                const el = event.currentTarget;
                follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
              className="text-micro mt-1 max-h-48 overflow-y-auto whitespace-pre-line rounded-md border border-border bg-panel px-2 py-1.5 leading-relaxed text-muted"
            >
              {thinkingParts(activity.thinking.trim())}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The newest step still running (sourcing steps run side by side). */
function runningStep(steps: DirectorStep[]): DirectorStep | undefined {
  for (let index = steps.length - 1; index >= 0; index--) if (steps[index]!.state === "run") return steps[index];
  return undefined;
}

/** Gemini's thinking arrives as "**Heading**" then a paragraph; headings read as headings. */
function thinkingParts(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part, index) =>
    /^\*\*[^*\n]+\*\*$/.test(part) ? (
      <span key={index} className="mt-1.5 block font-semibold text-fg first:mt-0">
        {part.slice(2, -2)}
      </span>
    ) : (
      <span key={index}>{part.replace(/^\n+/, "")}</span>
    )
  );
}

function YouSaid({ notes }: { notes?: string }) {
  return (
    <p className="text-meta text-fg">
      <span className="text-micro mr-1.5 font-semibold uppercase tracking-wide text-muted">You</span>
      {notes ? `“${notes}”` : <span className="text-muted">No notes</span>}
    </p>
  );
}

/** What the last pass could not do, and what is still rendering for it. */
function Notices({ warnings, pending }: { warnings: string[]; pending: string[] }) {
  if (!warnings.length && !pending.length) return null;
  return (
    <ul className="space-y-1">
      {warnings.map((warning) => (
        <li key={warning} className="text-meta text-warn">
          {warning}
        </li>
      ))}
      {pending.map((item) => (
        <li key={item} className="text-meta text-muted">
          ⏳ {item}
        </li>
      ))}
    </ul>
  );
}

function TurnView({
  turn,
  model,
  picks,
  onPick,
  activity,
  onUndo,
  undoing,
  locked,
  children,
}: {
  turn: DirectorTurn;
  model?: string;
  /** The option picked per question; the recommended one until the creator changes it. */
  picks?: Record<number, number>;
  onPick?: (ask: number, option: number) => void;
  /** How the pass that made this turn went, between the note and the answer. */
  activity?: ReactNode;
  /** This is the pass that can be taken back. */
  onUndo?: () => void;
  undoing?: boolean;
  locked?: boolean;
  children?: ReactNode;
}) {
  const plan = turn.kind === "plan";
  // An undo from its own button has no note to show.
  const said = turn.kind === "undo" && !turn.notes ? null : <YouSaid notes={turn.notes} />;
  // Proposals from before options existed carry plain questions.
  const asks: DirectorAsk[] = turn.asks?.length ? turn.asks : (turn.questions ?? []).map((question) => ({ question }));
  if (plan && onPick) {
    return (
      <div className="space-y-1">
        {said}
        {activity}
        <p className="text-meta whitespace-pre-line leading-relaxed text-muted" title={model}>
          <span className="text-micro mr-1.5 font-semibold uppercase tracking-wide text-accent">Director proposes</span>
          {turn.summary}
        </p>
        {asks.length > 0 ? (
          <div className="space-y-2.5 rounded-md border border-accent/40 bg-accent/5 px-2 py-2">
            {asks.map((ask, index) => {
              const options = ask.options ?? [];
              const recommended = ask.recommended ?? 0;
              const chosen = picks?.[index] ?? recommended;
              const detail = options[chosen]?.detail;
              return (
                <div key={`${index}-${ask.question}`} className="space-y-1">
                  <p className="text-meta text-fg">
                    <span className="num mr-1 text-accent">{index + 1}.</span>
                    {ask.header ? (
                      <span className="text-micro mr-1.5 rounded bg-accent/15 px-1 py-0.5 font-semibold uppercase tracking-wide text-accent">{ask.header}</span>
                    ) : null}
                    {ask.question}
                  </p>
                  {options.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={ask.question}>
                      {options.map((option, optionIndex) => (
                        <button
                          key={option.label}
                          type="button"
                          role="radio"
                          aria-checked={chosen === optionIndex}
                          title={option.detail}
                          onClick={() => onPick(index, optionIndex)}
                          className={cn(
                            "press text-micro rounded-full border px-2 py-0.5 font-semibold",
                            chosen === optionIndex ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:border-control"
                          )}
                        >
                          {option.label}
                          {optionIndex === recommended ? <span className="ml-1 font-normal opacity-70">· recommended</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-micro text-muted">Answer in the note below.</p>
                  )}
                  {detail ? <p className="text-micro text-muted">{detail}</p> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        <p className="text-micro text-muted">
          Nothing is cut yet.{asks.some((ask) => ask.options?.length) ? " The recommended answers are picked — change any," : ""} add anything in your own words, and press Go ahead.
        </p>
        {children}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {said}
      {activity}
      <p className={cn("text-meta whitespace-pre-line leading-relaxed text-muted", turn.undone && "opacity-60")} title={model}>
        <span className="text-micro mr-1.5 font-semibold uppercase tracking-wide text-accent">
          {plan ? "Director proposed" : turn.kind === "reply" ? "Director answers" : "Director"}
        </span>
        {turn.undone ? <span className="text-micro mr-1.5 rounded bg-panel-2 px-1 py-0.5 font-semibold uppercase tracking-wide text-muted">Taken back</span> : null}
        {turn.summary}
      </p>
      {turn.changed && !turn.undone ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-micro mr-0.5 text-muted">{turn.changed.length ? "Changed" : "Changed nothing"}</span>
          {turn.changed.map((lane) => (
            <span key={lane} className="text-micro rounded-full border border-border px-1.5 py-px text-muted">
              {LANE_LABELS[lane] ?? lane}
            </span>
          ))}
          {onUndo ? (
            <button
              type="button"
              disabled={locked}
              onClick={onUndo}
              title="Put these lanes, hits and beds back as they were before this pass"
              className="press text-micro ml-auto inline-flex h-6 items-center gap-1 rounded-md border border-border px-1.5 font-semibold text-muted hover:border-control hover:text-fg disabled:opacity-50"
            >
              {undoing ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Undo2 className="size-3" aria-hidden="true" />}
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
