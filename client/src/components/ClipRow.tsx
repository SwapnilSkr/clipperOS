import { Check, Download, Loader2, Pencil, Sparkles, X } from "lucide-react";
import { clipDownloadUrl, type ClipPayload, type ScoringAxisInfo } from "@/api";
import { clipHeadline, ShareCopyButton } from "./ShareCopyButton";
import { cn, SCORE_TONE, scoreBand, timecode } from "@/lib/utils";

interface ClipRowProps {
  clip: ClipPayload;
  axes: ScoringAxisInfo[];
  selected: boolean;
  /** Position in the board, used for the stagger delay. */
  index: number;
  onToggle: (id: string) => void;
  onRender: (id: string) => void;
  onEdit: (id: string) => void;
  onDismiss: (id: string) => void;
  onClipUpdated?: (clip: ClipPayload) => void;
}

/**
 * Stagger delay for a list arriving.
 *
 * 20ms per row with a small deterministic jitter: perfectly even steps read as
 * mechanical, and `Math.random()` would re-jitter on every render, which reads
 * as a glitch rather than as rhythm. Capped so a long board never spends a
 * second assembling itself.
 */
export function staggerDelay(index: number): number {
  const capped = Math.min(index, 12);
  return Math.max(0, capped * 20 + ((index * 37) % 11) - 5);
}

export function ClipRow({
  clip,
  axes,
  selected,
  index,
  onToggle,
  onRender,
  onEdit,
  onDismiss,
  onClipUpdated,
}: ClipRowProps) {
  const band = scoreBand(clip.totalScore);
  const rendering = clip.status === "rendering";
  const rendered = clip.status === "rendered" && Boolean(clip.outputUrl);
  const title = clipHeadline(clip);

  return (
    <li
      style={{ animationDelay: `${staggerDelay(index)}ms` }}
      className={cn(
        "group animate-rise flex items-start gap-3 border-b border-border/50 px-3 py-2.5 last:border-b-0",
        selected ? "bg-accent/[0.05]" : "hover:bg-panel-2/50"
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(clip.id)}
        aria-pressed={selected}
        aria-label={
          selected ? `Deselect clip ${clip.rank}` : `Select clip ${clip.rank} for rendering`
        }
        className={cn(
          "press mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-md border sm:size-8",
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

      <div className="flex w-12 shrink-0 flex-col items-start leading-none">
        <span className="num text-micro font-semibold text-muted">#{clip.rank}</span>
        <span className={cn("num text-title font-black tracking-tight", SCORE_TONE[band])}>
          {clip.totalScore.toFixed(1)}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-body truncate font-medium">{title}</p>
        {clip.peakLine ? (
          <p className="text-meta mt-0.5 truncate text-accent-2">“{clip.peakLine}”</p>
        ) : (
          <p className="text-meta mt-0.5 truncate italic text-muted">
            Peak {timecode(clip.peakSec)}
          </p>
        )}
        <p className="num text-micro mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-muted">
          <span>
            {timecode(clip.startSec)}–{timecode(clip.endSec)} · {clip.durationSec.toFixed(0)}s
          </span>
          {clip.kind === "merge" ? <span className="text-accent-2">Merged</span> : null}
          {axes.map((axis) => (
            <span key={axis.id} title={axis.label}>
              <span className="sr-only">{axis.label} </span>
              <span className="font-semibold text-fg/75">{clip.scores[axis.id] ?? "–"}</span>
            </span>
          ))}
        </p>
        {clip.renderError ? (
          <p className="text-meta mt-1 rounded-md bg-bad/10 px-2 py-1 text-bad">{clip.renderError}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {rendered ? (
          <a
            href={clipDownloadUrl(clip.id, { download: true, bust: clip.renderedAt })}
            download
            className="press inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-fg sm:size-8"
            aria-label={`Download clip ${clip.rank}`}
          >
            <Download className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}

        <ShareCopyButton clip={clip} onUpdated={onClipUpdated} />

        <button
          type="button"
          onClick={() => onEdit(clip.id)}
          className="press inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-fg sm:size-8"
          aria-label={`Edit clip ${clip.rank}`}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>

        <button
          type="button"
          disabled={rendering}
          onClick={() => onRender(clip.id)}
          aria-label={rendered ? `Re-render clip ${clip.rank}` : `Render clip ${clip.rank}`}
          className="press text-ui inline-flex h-11 items-center gap-1 rounded-md px-2 font-semibold text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50 sm:h-8"
        >
          {rendering ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-3.5" aria-hidden="true" />
          )}
          <span className="num hidden sm:inline">
            {rendering ? `${clip.renderProgress}%` : rendered ? "Again" : "Render"}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onDismiss(clip.id)}
          className="press inline-flex size-11 items-center justify-center rounded-md text-muted/50 hover:bg-bad/10 hover:text-bad sm:size-8"
          aria-label={`Remove clip ${clip.rank} from the board`}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
