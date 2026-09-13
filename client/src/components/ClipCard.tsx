import { Check, Download, Loader2, Pencil, Sparkles, X } from "lucide-react";
import { clipDownloadUrl, type ClipPayload, type ScoringAxisInfo } from "@/api";
import { clipHeadline, ShareCopyButton } from "./ShareCopyButton";
import { cn, SCORE_TONE, scoreBand, timecode } from "@/lib/utils";

interface ClipCardProps {
  clip: ClipPayload;
  /** Axis id + label for the project's genre, in display order. */
  axes: ScoringAxisInfo[];
  selected: boolean;
  onToggle: (id: string) => void;
  onRender: (id: string) => void;
  onEdit: (id: string) => void;
  onDismiss: (id: string) => void;
  onClipUpdated?: (clip: ClipPayload) => void;
}

function ScoreRing({ score }: { score: number }) {
  const band = scoreBand(score);
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = Math.min(10, Math.max(0, score)) / 10;
  return (
    <div className="relative size-[4.75rem]" aria-hidden="true">
      <svg viewBox="0 0 88 88" className="size-[4.75rem] -rotate-90">
        <circle cx="44" cy="44" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="5" />
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          className={SCORE_TONE[band]}
        />
      </svg>
      <span className={cn("num absolute inset-0 flex items-center justify-center text-title font-black tracking-tight", SCORE_TONE[band])}>
        {score.toFixed(1)}
      </span>
    </div>
  );
}

/**
 * Poster view of a clip: a 9:16 frame, then the decision line and one action.
 */
export function ClipCard({
  clip,
  axes,
  selected,
  onToggle,
  onRender,
  onEdit,
  onDismiss,
  onClipUpdated,
}: ClipCardProps) {
  const rendering = clip.status === "rendering";
  const rendered = clip.status === "rendered" && Boolean(clip.outputUrl);

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-panel transition-colors",
        selected ? "border-accent/70" : "border-border hover:border-control"
      )}
    >
      <div className="bg-bg p-2 pb-0">
        <div className="phone-frame relative w-full">
          {rendered ? (
            <video
              src={clip.outputUrl}
              controls
              playsInline
              preload="metadata"
              aria-label={
                clip.peakLine ? `Rendered clip: ${clip.peakLine}` : `Rendered clip ${clip.rank}`
              }
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
              <ScoreRing score={clip.totalScore} />
              {rendering ? (
                <>
                  <div className="relative h-1 w-20 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="absolute inset-y-0 w-1/3 animate-sweep rounded-full bg-accent"
                      style={{ left: `${Math.max(0, clip.renderProgress - 10)}%` }}
                    />
                  </div>
                  <p className="text-meta text-muted">{clip.renderProgress}%</p>
                </>
              ) : (
                <p className="text-meta text-muted">Peak {timecode(clip.peakSec)}</p>
              )}
            </div>
          )}

          <div className="pointer-events-none absolute start-2 top-2 z-10 flex items-center gap-1">
            <span className="num text-micro rounded bg-black/70 px-1.5 py-0.5 font-bold">
              #{clip.rank}
            </span>
            {clip.kind === "merge" ? (
              <span className="text-micro rounded bg-black/70 px-1.5 py-0.5 font-semibold text-accent-2">
                Merged
              </span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => onDismiss(clip.id)}
            aria-label={`Remove clip ${clip.rank} from the board`}
            className="press absolute end-1 top-1 z-10 inline-flex size-9 items-center justify-center rounded-md text-white/70 hover:bg-bad/20 hover:text-white"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-2.5">
        <div>
          <p className="num text-micro font-medium text-muted">
            {timecode(clip.startSec)}–{timecode(clip.endSec)} · {clip.durationSec.toFixed(0)}s
          </p>
          <p className="text-ui mt-0.5 line-clamp-2 font-semibold">{clipHeadline(clip)}</p>
          {clip.peakLine ? (
            <p className="text-meta mt-1 line-clamp-2 text-accent-2">“{clip.peakLine}”</p>
          ) : null}
        </div>

        <p className="num text-micro flex gap-2 text-muted" aria-label="Scores">
          {axes.map((axis) => (
            <span key={axis.id} title={axis.label}>
              {axis.label}{" "}
              <span className="font-semibold text-fg/80">{clip.scores[axis.id] ?? "–"}</span>
            </span>
          ))}
        </p>

        {clip.renderError ? (
          <p className="text-meta rounded-md bg-bad/10 px-2 py-1 text-bad">{clip.renderError}</p>
        ) : null}

        <div className="mt-auto flex items-center gap-1 pt-1">
          <button
            type="button"
            onClick={() => onToggle(clip.id)}
            aria-pressed={selected}
            aria-label={
              selected ? `Deselect clip ${clip.rank}` : `Select clip ${clip.rank} for rendering`
            }
            className={cn(
              "press inline-flex size-9 shrink-0 items-center justify-center rounded-md border",
              selected
                ? "border-accent bg-accent/20 text-accent"
                : "border-control text-muted hover:border-accent"
            )}
          >
            <span className="motion-swap" aria-hidden="true">
              <Check className="size-3.5" data-shown={selected} />
              <span className="size-3 rounded-sm border border-current" data-shown={!selected} />
            </span>
          </button>

          {rendered ? (
            <a
              href={`${clipDownloadUrl(clip.id)}?download=1`}
              download
              className="press inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-fg"
              aria-label={`Download clip ${clip.rank}`}
            >
              <Download className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}

          <ShareCopyButton clip={clip} compact={false} onUpdated={onClipUpdated} />

          <button
            type="button"
            onClick={() => onEdit(clip.id)}
            className="press inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-fg"
            aria-label={`Edit clip ${clip.rank}`}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled={rendering}
            onClick={() => onRender(clip.id)}
            className="press text-ui inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-bg font-semibold hover:border-control disabled:opacity-50"
          >
            {rendering ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-3.5" aria-hidden="true" />
            )}
            {rendered ? "Again" : "Render"}
          </button>
        </div>
      </div>
    </article>
  );
}
