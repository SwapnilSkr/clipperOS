import { useState } from "react";
import {
  Download,
  Languages,
  LayoutGrid,
  List,
  Merge,
  Recycle,
  Sparkles,
  Tag,
  Trash2,
  Undo2,
  Wand2,
} from "lucide-react";
import type { ClipPayload, GenreInfo, ProjectSummary } from "@/api";
import { ClipCard } from "./ClipCard";
import { ClipRow, staggerDelay } from "./ClipRow";
import { MenuItem, MoreMenu, Segmented, ctrl } from "./chrome";
import { cn, elapsedLabel, formatBytes } from "@/lib/utils";

export type Density = "list" | "grid";

interface ClipBoardProps {
  project: ProjectSummary;
  clips: ClipPayload[];
  genres: GenreInfo[];
  selectedIds: Set<string>;
  reframeMode: "center" | "smart";
  captions: boolean;
  density: Density;
  /** A dismiss waiting out its undo window. */
  pendingUndo: { clip: ClipPayload } | null;
  /** True while an S3 storage reconciliation is running. */
  cleaningStorage: boolean;
  onReframeMode: (mode: "center" | "smart") => void;
  onCaptions: (captions: boolean) => void;
  onDensity: (density: Density) => void;
  onRemine: (genreId: string) => void;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onRenderSelected: () => void;
  onRenderOne: (id: string) => void;
  onEdit: (id: string) => void;
  onMerge: () => void;
  onDeleteSelected: () => void;
  onCleanStorage: () => void;
  onDismiss: (clip: ClipPayload) => void;
  onUndoDismiss: () => void;
  onDownloadAll: () => void;
}

const REFRAME_OPTIONS = [
  { value: "smart" as const, label: "Smart" },
  { value: "center" as const, label: "Centre" },
];

export function ClipBoard({
  project,
  clips,
  genres,
  selectedIds,
  reframeMode,
  captions,
  density,
  pendingUndo,
  cleaningStorage,
  onReframeMode,
  onCaptions,
  onDensity,
  onRemine,
  onToggle,
  onToggleAll,
  onRenderSelected,
  onRenderOne,
  onEdit,
  onMerge,
  onDeleteSelected,
  onCleanStorage,
  onDismiss,
  onUndoDismiss,
  onDownloadAll,
}: ClipBoardProps) {
  const renderedCount = clips.filter((c) => c.status === "rendered").length;
  const allSelected = clips.length > 0 && selectedIds.size === clips.length;
  const selectedCount = selectedIds.size;
  const genreSummary = genres.find((g) => g.id === project.genreId)?.summary;
  const [setupOpen, setSetupOpen] = useState(false);

  const sourceLabel =
    project.transcriptSource === "youtube_captions"
      ? "YouTube captions"
      : project.transcriptSource === "embedded_subs"
        ? "embedded subtitles"
        : project.transcriptSource === "whisper"
          ? "Whisper"
          : null;

  return (
    <div className="rounded-xl border border-border bg-panel">
      {/* Identity + quiet tools. Selection commands live on their own strip so
          disabled Merge/Delete never sit in the chrome looking like CTAs. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body font-semibold">
              {clips.length} clip{clips.length === 1 ? "" : "s"}
            </p>
            <label className="text-micro inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 font-semibold text-muted">
              <Tag className="size-3" aria-hidden="true" />
              <span className="sr-only">Re-cut as</span>
              <select
                value={project.genreId}
                onChange={(e) => {
                  if (e.target.value !== project.genreId) onRemine(e.target.value);
                }}
                className="max-w-[11rem] cursor-pointer appearance-none bg-transparent text-inherit outline-none"
              >
                {genres.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                    {g.id === project.genreId && project.genreAutoDetected ? " · auto" : ""}
                  </option>
                ))}
              </select>
            </label>
            {renderedCount > 0 ? (
              <span className="text-meta text-muted">{renderedCount} rendered</span>
            ) : null}
          </div>
          <p className="num text-meta mt-0.5 truncate text-muted">
            {project.clipDuration.min}–{project.clipDuration.max}s
            {sourceLabel ? ` · ${sourceLabel}` : ""}
            {project.timings?.totalMs ? ` · ${elapsedLabel(project.timings.totalMs)}` : ""}
            {project.storageBytes > 0 ? ` · ${formatBytes(project.storageBytes)}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-expanded={setupOpen}
            onClick={() => setSetupOpen((open) => !open)}
            className={cn(ctrl, "border border-border bg-panel-2 px-3 sm:hidden")}
          >
            Options
          </button>

          <div className={cn("flex flex-wrap items-center gap-1.5", setupOpen ? "flex" : "hidden sm:flex")}>
            <Segmented
              label="Framing"
              value={reframeMode}
              options={REFRAME_OPTIONS}
              onChange={onReframeMode}
            />

            <button
              type="button"
              aria-pressed={captions}
              title={captions ? "Captions on" : "Captions off"}
              onClick={() => onCaptions(!captions)}
              className={cn(
                ctrl,
                "w-11 border px-0 sm:w-8",
                captions
                  ? "border-border bg-panel-2 text-fg"
                  : "border-border bg-bg text-muted hover:text-fg"
              )}
            >
              <Languages className="size-3.5" aria-hidden="true" />
              <span className="sr-only">Captions {captions ? "on" : "off"}</span>
            </button>

            <Segmented
              label="Board layout"
              value={density}
              options={[
                { value: "list", label: "List view", icon: <List className="size-3.5" /> },
                { value: "grid", label: "Poster view", icon: <LayoutGrid className="size-3.5" /> },
              ]}
              onChange={onDensity}
            />
          </div>

          <MoreMenu label="More actions">
            <MenuItem onClick={onToggleAll}>{allSelected ? "Clear selection" : "Select all"}</MenuItem>
            {renderedCount > 0 ? (
              <MenuItem onClick={onDownloadAll}>
                <Download className="size-3.5" aria-hidden="true" />
                Download all rendered
              </MenuItem>
            ) : null}
            <MenuItem disabled={cleaningStorage} onClick={onCleanStorage}>
              <Recycle className={cn("size-3.5", cleaningStorage && "animate-spin")} aria-hidden="true" />
              {cleaningStorage ? "Cleaning storage…" : "Clean up storage"}
            </MenuItem>
          </MoreMenu>
        </div>
      </div>

      {selectedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel-2/60 px-3 py-1.5">
          <p className="text-meta me-1 font-medium">
            {selectedCount} selected
          </p>
          <button
            type="button"
            onClick={onRenderSelected}
            className={cn(ctrl, "btn-accent hidden px-3 font-semibold hover:opacity-90 lg:inline-flex")}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            Render
          </button>
          <button
            type="button"
            disabled={selectedCount < 2}
            onClick={onMerge}
            className={cn(
              ctrl,
              "border border-border bg-bg px-2.5 hover:border-control disabled:opacity-40"
            )}
          >
            <Merge className="size-3.5" aria-hidden="true" />
            Merge
          </button>
          <button
            type="button"
            onClick={onDeleteSelected}
            className={cn(
              ctrl,
              "border border-border bg-bg px-2.5 text-muted hover:border-bad hover:text-bad"
            )}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Delete
          </button>
          <button
            type="button"
            onClick={onToggleAll}
            className={cn(ctrl, "ms-auto px-2 text-muted hover:text-fg")}
          >
            {allSelected ? "Clear" : "Select all"}
          </button>
        </div>
      ) : null}

      <div role="status" aria-live="polite" className="empty:hidden">
        {pendingUndo ? (
          <div className="motion-reveal flex items-center gap-3 border-b border-border bg-panel-2 px-3 py-1.5 text-ui">
            <span className="min-w-0 flex-1 truncate">
              Clip {pendingUndo.clip.rank} removed.
            </span>
            <button
              type="button"
              onClick={onUndoDismiss}
              className={cn(ctrl, "border border-border px-2.5 font-semibold hover:border-control")}
            >
              <Undo2 className="size-3.5" aria-hidden="true" /> Undo
            </button>
          </div>
        ) : null}
      </div>

      {clips.length === 0 ? (
        <div className="flex flex-col items-center gap-3 p-10 text-center sm:p-14">
          <Wand2 className="size-7 text-muted" aria-hidden="true" />
          <div>
            <p className="text-body font-semibold">No qualifying clips</p>
            <p className="text-meta mx-auto mt-1.5 max-w-[52ch] text-muted">
              {genreSummary
                ? `${genreSummary} Switch style from the genre chip.`
                : "This style produced no qualifying clips."}
            </p>
          </div>
        </div>
      ) : density === "list" ? (
        <ul>
          {clips.map((clip, index) => (
            <ClipRow
              key={clip.id}
              clip={clip}
              axes={project.scoringAxes}
              selected={selectedIds.has(clip.id)}
              index={index}
              onToggle={onToggle}
              onRender={onRenderOne}
              onEdit={onEdit}
              onDismiss={() => onDismiss(clip)}
            />
          ))}
        </ul>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {clips.map((clip, index) => (
            <div
              key={clip.id}
              className="animate-rise"
              style={{ animationDelay: `${staggerDelay(index)}ms` }}
            >
              <ClipCard
                clip={clip}
                axes={project.scoringAxes}
                selected={selectedIds.has(clip.id)}
                onToggle={onToggle}
                onRender={onRenderOne}
                onEdit={onEdit}
                onDismiss={() => onDismiss(clip)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
