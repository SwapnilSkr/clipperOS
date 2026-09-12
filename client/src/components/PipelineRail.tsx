import { Check, Loader2 } from "lucide-react";
import type { ProjectSummary } from "@/api";
import { cn, elapsedLabel } from "@/lib/utils";

const STEPS = [
  { status: "ingesting", label: "Reading transcript" },
  { status: "mining", label: "Finding clips" },
  { status: "ready", label: "Clips ready" },
] as const;

/** Live pipeline progress for a project that is still being processed. */
export function PipelineRail({ project }: { project: ProjectSummary }) {
  const activeIndex = STEPS.findIndex((s) => s.status === project.status);
  const elapsedMs = Date.now() - new Date(project.createdAt).getTime();

  return (
    <div className="rounded-xl border border-border bg-panel p-4">
      {/* The wait is the product's longest moment. Announce the stage, the
          completion count and the percentage so it is not silent to a screen
          reader — and not a hung page for anyone else. */}
      <div role="status" aria-live="polite" className="mb-5 flex items-center gap-3">
        <Loader2 className="size-5 shrink-0 animate-spin text-accent" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-body font-semibold">{project.stage}</p>
          <p className="num text-meta text-muted">
            {project.title} · {elapsedLabel(elapsedMs)} elapsed
            {project.durationSec ? ` · source ${Math.round(project.durationSec / 60)} min` : ""}
          </p>
        </div>
        <span className="num text-lead ms-auto shrink-0 font-semibold text-accent">
          {project.progress}%
        </span>
      </div>

      <div
        className="mb-6 h-1.5 overflow-hidden rounded-full bg-panel-2"
        role="progressbar"
        aria-valuenow={project.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Clipping progress"
      >
        <div
          className="h-full origin-left rounded-full bg-accent transition-transform duration-500 ease-out-quart"
          style={{ transform: `scaleX(${Math.max(0.03, project.progress / 100)})` }}
        />
      </div>

      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((step, index) => {
          const done = activeIndex > index || project.status === "ready";
          const active = activeIndex === index;
          return (
            <li
              key={step.status}
              className={cn(
                "text-ui flex items-center gap-2 rounded-lg border px-3 py-2",
                done && "border-good/40 bg-good/10 text-good",
                active && !done && "border-accent/50 bg-accent/10 text-fg",
                !done && !active && "border-border bg-panel-2 text-muted"
              )}
            >
              {done ? (
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    active ? "animate-pulse-soft bg-accent" : "bg-muted/50"
                  )}
                />
              )}
              <span className="truncate">{step.label}</span>
              <span className="sr-only">
                {done ? "done" : active ? "in progress" : "waiting"}
              </span>
            </li>
          );
        })}
      </ol>

      {project.status === "mining" && project.miningChunksTotal ? (
        <p className="num text-meta mt-4 text-center text-muted">
          {project.miningChunksDone ?? 0} of {project.miningChunksTotal} transcript chunks mined in
          parallel
        </p>
      ) : null}
    </div>
  );
}
