import { Film, Trash2, Youtube } from "lucide-react";
import type { ProjectSummary } from "@/api";
import { cn } from "@/lib/utils";

interface ProjectListProps {
  projects: ProjectSummary[];
  /** True until the first fetch settles, so we never show a false empty state. */
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRequestDelete: (project: ProjectSummary) => void;
}

const STATUS_TONE: Record<ProjectSummary["status"], string> = {
  pending: "text-muted",
  ingesting: "text-accent",
  mining: "text-accent",
  ready: "text-good",
  failed: "text-bad",
};

function statusLine(project: ProjectSummary): string {
  if (project.status === "ready") {
    return `${project.clipCount} clip${project.clipCount === 1 ? "" : "s"}`;
  }
  if (project.status === "failed") return "Failed";
  return project.stage;
}

export function ProjectList({
  projects,
  loading,
  selectedId,
  onSelect,
  onRequestDelete,
}: ProjectListProps) {
  // Skeleton, not "nothing here" — a returning user must never be told their
  // library is empty while the request is still in flight.
  if (loading) {
    return (
      <ul className="flex flex-col gap-1" aria-label="Loading projects">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-2 px-2 py-2" aria-hidden="true">
            <span className="h-11 w-14 shrink-0 animate-pulse-soft rounded bg-panel-2" />
            <span className="flex-1 space-y-2">
              <span className="block h-3 w-3/4 animate-pulse-soft rounded bg-panel-2" />
              <span className="block h-2.5 w-1/3 animate-pulse-soft rounded bg-panel-2" />
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (projects.length === 0) {
    return (
      <p className="text-meta px-3 py-6 text-center text-muted">
        Projects you clip collect here.
        <br />
        Paste a link above to start one.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {projects.map((project) => (
        <li key={project.id}>
          <div
            className={cn(
              "relative flex items-center gap-1 rounded-lg px-1 py-1 transition-colors",
              selectedId === project.id
                ? "bg-panel-2 before:absolute before:inset-y-1.5 before:start-0 before:w-0.5 before:rounded-full before:bg-accent"
                : "hover:bg-panel-2/70"
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(project.id)}
              aria-current={selectedId === project.id ? "true" : undefined}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-start"
            >
              {project.thumbnailUrl ? (
                <img
                  src={project.thumbnailUrl}
                  alt=""
                  className="h-11 w-14 shrink-0 rounded object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="flex h-11 w-14 shrink-0 items-center justify-center rounded bg-panel-2">
                  {project.sourceType === "youtube" ? (
                    <Youtube className="size-4 text-muted" aria-hidden="true" />
                  ) : (
                    <Film className="size-4 text-muted" aria-hidden="true" />
                  )}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="text-ui block truncate font-medium">{project.title}</span>
                <span className={cn("num text-meta block truncate", STATUS_TONE[project.status])}>
                  {statusLine(project)}
                </span>
              </span>
            </button>

            {/* Always visible. A destructive control revealed only on hover is
                unreachable by keyboard and invisible while focused. */}
            <button
              type="button"
              onClick={() => onRequestDelete(project)}
              className="press inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted/70 hover:bg-bad/10 hover:text-bad"
              aria-label={`Delete project ${project.title}`}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
