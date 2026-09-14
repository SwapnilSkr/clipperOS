import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Plus, RotateCcw, Scissors, Sparkles, X } from "lucide-react";
import {
  api,
  clipDownloadUrl,
  pickProjectOutro,
  type CaptionFontInfo,
  type CaptionStyleInfo,
  type ClipPayload,
  type GenreInfo,
  type ProjectDetail,
  type ProjectSummary,
} from "@/api";
import { ClipBoard, type Density } from "@/components/ClipBoard";
import { ClipEditor, type ClipEditDraft } from "@/components/ClipEditor";
import { OutroBuilder } from "@/components/OutroBuilder";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PipelineRail } from "@/components/PipelineRail";
import { ProjectList } from "@/components/ProjectList";
import { SourceBar } from "@/components/SourceBar";
import { routes } from "@/routes";
import { formatBytes } from "@/lib/utils";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ACTIVE_STATUSES: ProjectSummary["status"][] = ["pending", "ingesting", "mining"];

/** How long a dismissed clip can be brought back before the write commits. */
const UNDO_WINDOW_MS = 6000;

/**
 * What the tool produces, shown instead of explained.
 *
 * An empty state that describes the pipeline teaches nothing; a stranger reads
 * this in two seconds and knows the product returns scored clips with a payoff
 * line. Values are a real mined example, not lorem.
 */
function OutputPreview() {
  return (
    <div className="w-full max-w-[200px] overflow-hidden rounded-xl border border-border bg-panel text-start">
      <div className="bg-bg p-2 pb-0">
        <div className="phone-frame relative flex flex-col items-center justify-center gap-2">
          <span className="num text-score font-black tracking-tight text-accent">8.3</span>
          <span className="num text-micro absolute start-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-bold">
            #1
          </span>
        </div>
      </div>
      <div className="space-y-1.5 p-2.5">
        <p className="num text-micro font-medium text-muted">11:30–12:14 · 42s</p>
        <p className="text-ui font-semibold leading-snug">
          like seeing your family or exercising
        </p>
        <p className="text-meta line-clamp-2 text-accent-2">
          “the effects of procrastination, they’re not contained”
        </p>
      </div>
    </div>
  );
}

/**
 * The two app-level banners: a failure and a success. Shared by the board and
 * the editor so a message raised while a clip is open is not invisible.
 */
function ErrorNotice({
  error,
  notice,
  onDismissError,
  onDismissNotice,
}: {
  error: string | null;
  notice: string | null;
  onDismissError: () => void;
  onDismissNotice: () => void;
}) {
  return (
    <>
      {error ? (
        <div
          role="alert"
          className="motion-reveal text-ui flex items-start gap-2 rounded-xl border border-bad/40 bg-bad/10 p-3 text-bad"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="flex-1">{error}</p>
          <button
            type="button"
            onClick={onDismissError}
            className="press inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-bad/20"
            aria-label="Dismiss error"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {notice ? (
        <div
          role="status"
          className="motion-reveal text-ui flex items-start gap-2 rounded-xl border border-good/40 bg-good/10 p-3 text-good"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="flex-1">{notice}</p>
          <button
            type="button"
            onClick={onDismissNotice}
            className="press inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-good/20"
            aria-label="Dismiss message"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * Placeholder while a clip URL resolves. Rendered by the route itself, so a
 * refresh on a clip link lands here for the moment the project takes to load
 * rather than on a blank page.
 */
function EditorLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4 p-4 lg:p-6">
      <span className="sr-only">Loading the editor</span>
      <div className="h-11 w-64 max-w-full animate-pulse-soft rounded-lg bg-panel-2" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="mx-auto aspect-[9/16] w-full max-w-[340px] animate-pulse-soft rounded-xl bg-panel" />
        <div className="flex flex-col gap-3">
          <div className="h-24 animate-pulse-soft rounded-xl bg-panel" />
          <div className="h-32 animate-pulse-soft rounded-xl bg-panel" />
        </div>
      </div>
    </div>
  );
}

/** A clip URL that resolves to nothing — deleted, or a typo. */
function ClipNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <AlertTriangle className="size-8 text-muted" aria-hidden="true" />
      <div>
        <p className="text-body font-semibold">This clip isn’t available</p>
        <p className="text-meta mx-auto mt-2 max-w-[46ch] text-muted">
          It may have been deleted, or the project it belongs to could not be loaded.
        </p>
      </div>
      <button
        type="button"
        onClick={onBack}
        className="press text-ui inline-flex h-11 items-center gap-1.5 rounded-lg border border-control px-4 font-medium hover:border-accent"
      >
        Back to the board
      </button>
    </div>
  );
}

export default function App() {
  // All three routes render the same studio shell; the params decide what the
  // main column shows. Keeping one component means the projects list and the
  // polling state survive navigation between a board and one of its clips.
  return (
    <Routes>
      <Route path={routes.root} element={<Studio />} />
      <Route path="/projects/:projectId" element={<Studio />} />
      <Route path="/projects/:projectId/outro" element={<Studio />} />
      <Route path="/projects/:projectId/outro/:outroId" element={<Studio />} />
      <Route path="/projects/:projectId/clips/:clipId" element={<Studio />} />
      {/* An unknown URL is a typo, not a blank page. */}
      <Route path="*" element={<Navigate to={routes.root} replace />} />
    </Routes>
  );
}

export function Studio() {
  const { projectId, clipId, outroId } = useParams<{ projectId?: string; clipId?: string; outroId?: string }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // The URL is the source of truth for what is selected — that is what makes a
  // refresh land in the same place. There is no local "selected project" state.
  const selectedId = projectId ?? null;
  const editingClipId = clipId ?? null;
  const outroRoute = Boolean(selectedId && location.pathname.includes("/outro"));
  const returnClipId = searchParams.get("returnClip") || undefined;

  const selectProject = useCallback(
    (id: string | null) => {
      navigate(id ? routes.project(id) : routes.root);
    },
    [navigate]
  );

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [genres, setGenres] = useState<GenreInfo[]>([]);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set());
  const [reframeMode, setReframeMode] = useState<"center" | "smart">("smart");
  /** "" = let detection choose. */
  const [genreChoice, setGenreChoice] = useState("");
  const [captions, setCaptions] = useState(true);
  const [density, setDensity] = useState<Density>("list");
  const [busy, setBusy] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Create-project failures belong next to the field, not in a global banner. */
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ---- clip editing ----
  const [captionStyles, setCaptionStyles] = useState<CaptionStyleInfo[]>([]);
  const [captionFonts, setCaptionFonts] = useState<CaptionFontInfo[]>([]);
  /** A pending hard delete: one clip from the editor, or the board selection. */
  const [deleteRequest, setDeleteRequest] = useState<{
    ids: string[];
    label: string;
    bytes: number;
  } | null>(null);
  const [deletingClips, setDeletingClips] = useState(false);
  const [cleaningStorage, setCleaningStorage] = useState(false);
  /** Success feedback (bytes reclaimed), which is not an error. */
  const [notice, setNotice] = useState<string | null>(null);
  const [writingCopy, setWritingCopy] = useState(false);

  // Optimistic dismissal with an undo window.
  const [hiddenClipIds, setHiddenClipIds] = useState<Set<string>>(new Set());
  const [pendingUndo, setPendingUndo] = useState<{ clip: ClipPayload } | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    api
      .listGenres()
      .then(setGenres)
      .catch((err) => setError(messageOf(err)));
  }, []);

  useEffect(() => {
    void Promise.all([
      api.listCaptionStyles().then(setCaptionStyles),
      api.listCaptionFonts().then(setCaptionFonts),
    ]).catch((err) => setError(messageOf(err)));
  }, []);

  // Poll the selected project while it is processing, and more slowly otherwise
  // so render progress on individual clips stays live.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const next = await api.getProject(selectedId);
        if (cancelled) return;
        setDetail(next);
        setProjects((prev) => prev.map((p) => (p.id === next.project.id ? next.project : p)));
        setSelectedClipIds((prev) => {
          const live = new Set(next.clips.map((c) => c.id));
          return new Set([...prev].filter((id) => live.has(id)));
        });
        const active =
          ACTIVE_STATUSES.includes(next.project.status) ||
          next.project.mediaStatus === "fetching" ||
          next.clips.some((c) => c.status === "rendering");
        timer = window.setTimeout(tick, active ? 800 : 4000);
      } catch (err) {
        if (!cancelled) {
          setError(messageOf(err));
          timer = window.setTimeout(tick, 4000);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [selectedId]);

  // Captions are a genre property, so keep the toggle in sync with whichever
  // style the project was mined under.
  const projectGenreId = detail?.project.genreId;
  useEffect(() => {
    if (!projectGenreId) return;
    const genre = genres.find((g) => g.id === projectGenreId);
    if (genre) setCaptions(genre.captionsDefault);
  }, [projectGenreId, genres]);

  // Arriving at a different project (or leaving one) resets per-project UI.
  // The editor is no longer part of this: it is its own route, so navigating
  // into a clip does not clear the board behind it.
  useEffect(() => {
    setIntakeOpen(!selectedId);
    setHiddenClipIds(new Set());
    window.clearTimeout(undoTimer.current);
    setPendingUndo(null);
    setDeleteRequest(null);
    setNotice(null);
  }, [selectedId]);

  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  async function startProject(run: () => Promise<ProjectSummary>) {
    setBusy(true);
    setSourceError(null);
    try {
      const project = await run();
      // Navigate to the new project's own URL rather than setting local state.
      selectProject(project.id);
      setSelectedClipIds(new Set());
      await refreshProjects();
    } catch (err) {
      // Keep the typed URL and report it on the field itself.
      setSourceError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const handleYoutube = (url: string) =>
    startProject(() => api.createFromYoutube(url, genreChoice || undefined));

  const handleUpload = (file: File) =>
    startProject(async () => {
      const uploadId = await api.uploadVideo(file);
      return api.createFromUpload(
        uploadId,
        file.name.replace(/\.[^.]+$/, ""),
        genreChoice || undefined
      );
    });

  function patchClip(clip: ClipPayload) {
    setDetail((prev) =>
      prev
        ? { ...prev, clips: prev.clips.map((item) => (item.id === clip.id ? { ...item, ...clip } : item)) }
        : prev
    );
  }

  async function handleWriteCopy(force: boolean) {
    if (!selectedId) return;
    setWritingCopy(true);
    setError(null);
    try {
      const result = await api.generateProjectShareCopy(selectedId, force);
      setDetail(await api.getProject(selectedId));
      setNotice(
        result.written === 0
          ? "Post copy is already written."
          : `Wrote post copy for ${result.written} clip${result.written === 1 ? "" : "s"}.`
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setWritingCopy(false);
    }
  }

  /** Re-mine under a different genre. Cheap: the transcript is already stored. */
  async function handleRemine(genreId: string) {
    if (!selectedId) return;
    setError(null);
    setSelectedClipIds(new Set());
    try {
      const project = await api.remineProject(selectedId, genreId);
      setDetail((prev) => (prev ? { ...prev, project } : prev));
    } catch (err) {
      setError(messageOf(err));
    }
  }

  function openMixFor(ids: string[]) {
    if (!selectedId || ids.length === 0) return;
    setSelectedClipIds(new Set());
    navigate(routes.clipMix(selectedId, ids[0]!));
  }

  // ---- clip editing -------------------------------------------------------

  /** Persist an edit spec. No render — saving is free and instant. */
  async function saveClipDraft(clipId: string, draft: ClipEditDraft) {
    const updated = await api.updateClip(clipId, {
      title: draft.title,
      edit: draft.edit,
      segments: draft.segments,
    });
    setDetail((prev) =>
      prev ? { ...prev, clips: prev.clips.map((c) => (c.id === updated.id ? updated : c)) } : prev
    );
  }

  async function renderClipDraft(clipId: string, draft: ClipEditDraft) {
    await saveClipDraft(clipId, draft);
    const skipOutro = draft.edit.outro?.enabled === false;
    if (!skipOutro && selectedId) {
      const chosen = pickProjectOutro(
        detail?.project.outros,
        draft.edit.outro?.outroId,
        detail?.project.defaultOutroId
      );
      if (!chosen?.ready) {
        navigate(routes.outro(selectedId, clipId, chosen?.id));
        setNotice("Finish the outro, then we send you back to export.");
        return;
      }
    }
    await api.renderClips(
      [clipId],
      draft.edit.reframeMode ?? reframeMode,
      draft.edit.captionsOn
    );
  }

  async function returnToClipWithOutro(clipId: string) {
    if (!selectedId) return;
    if (outroId) {
      try {
        const updated = await api.updateClip(clipId, {
          edit: { outro: { enabled: true, outroId } },
        });
        setDetail((prev) =>
          prev ? { ...prev, clips: prev.clips.map((clip) => (clip.id === updated.id ? updated : clip)) } : prev
        );
      } catch (err) {
        setError(messageOf(err));
      }
    }
    navigate(routes.clipMix(selectedId, clipId));
  }

  async function skipOutroAndReturn(clipId: string) {
    if (!selectedId) return;
    try {
      await api.updateClip(clipId, { edit: { outro: { enabled: false } } });
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              clips: prev.clips.map((clip) =>
                clip.id === clipId
                  ? { ...clip, edit: { ...clip.edit, outro: { enabled: false } } }
                  : clip
              ),
            }
          : prev
      );
      navigate(routes.clipMix(selectedId, clipId));
      setNotice("This export will skip the outro.");
    } catch (err) {
      setError(messageOf(err));
    }
  }

  /** Merge the board selection into a new clip. Sources are left alone. */
  async function handleMerge(ids: string[]) {
    if (!selectedId || ids.length < 2) return;
    setError(null);
    setNotice(null);
    try {
      const merged = await api.mergeClips(selectedId, ids);
      setDetail(await api.getProject(selectedId));
      setSelectedClipIds(new Set());
      // Open the merge in the editor so its parts can be arranged immediately.
      navigate(routes.clip(selectedId, merged.id));
      setNotice(`Merged ${ids.length} clips — sources are untouched.`);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function confirmDeleteClips() {
    if (!deleteRequest || !selectedId) return;
    const { ids } = deleteRequest;
    setDeletingClips(true);
    try {
      // Per-clip, not all-or-nothing: one clip still rendering must not strand
      // the deletions that already succeeded without telling the user.
      const removed: string[] = [];
      let freed = 0;
      let warning: string | undefined;
      const failures: string[] = [];
      for (const id of ids) {
        try {
          const result = await api.deleteClip(id);
          freed += result.freedBytes;
          warning ??= result.warning;
          removed.push(id);
        } catch (err) {
          failures.push(messageOf(err));
        }
      }

      setDeleteRequest(null);
      // If the clip that was open is gone, leave the editor before its route
      // starts pointing at something that no longer exists.
      if (editingClipId && removed.includes(editingClipId) && selectedId) {
        navigate(routes.project(selectedId), { replace: true });
      }
      setHiddenClipIds((prev) => {
        const next = new Set(prev);
        for (const id of removed) next.delete(id);
        return next;
      });
      setSelectedClipIds((prev) => {
        const next = new Set(prev);
        for (const id of removed) next.delete(id);
        return next;
      });
      setDetail(await api.getProject(selectedId));
      await refreshProjects();

      if (failures.length > 0) {
        setError(
          `${failures.length} clip${failures.length === 1 ? "" : "s"} could not be deleted: ${failures[0]}`
        );
      }
      if (removed.length > 0) {
        setNotice(
          warning ??
            `Deleted ${removed.length} clip${removed.length === 1 ? "" : "s"} — ${formatBytes(freed)} reclaimed.`
        );
      }
    } catch (err) {
      setError(messageOf(err));
      setDeleteRequest(null);
    } finally {
      setDeletingClips(false);
    }
  }

  /** Reclaim S3 objects no live clip owns. */
  async function handleCleanStorage() {
    if (!selectedId) return;
    setCleaningStorage(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.reconcileProject(selectedId, false);
      if (result.deleted > 0) {
        setNotice(`Reclaimed ${result.deleted} orphaned object${result.deleted === 1 ? "" : "s"}.`);
      } else if (result.orphans.length > 0) {
        setNotice(
          `${result.orphans.length} object${result.orphans.length === 1 ? " is" : "s are"} too recent to reclaim safely — try again later.`
        );
      } else {
        setNotice("Storage is clean — nothing orphaned.");
      }
      await refreshProjects();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setCleaningStorage(false);
    }
  }

  /** Hide now, write later — a mis-tap is recoverable for a few seconds. */
  function handleDismiss(clip: ClipPayload) {
    setHiddenClipIds((prev) => new Set(prev).add(clip.id));
    setPendingUndo({ clip });
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => void commitDismiss(clip.id), UNDO_WINDOW_MS);
  }

  async function commitDismiss(clipId: string) {
    setPendingUndo(null);
    try {
      await api.dismissClip(clipId);
      if (selectedId) {
        setDetail(await api.getProject(selectedId));
        setHiddenClipIds((prev) => {
          const next = new Set(prev);
          next.delete(clipId);
          return next;
        });
      }
    } catch (err) {
      // Put it back if the write failed, rather than lying about it.
      setHiddenClipIds((prev) => {
        const next = new Set(prev);
        next.delete(clipId);
        return next;
      });
      setError(messageOf(err));
    }
  }

  function undoDismiss() {
    window.clearTimeout(undoTimer.current);
    if (pendingUndo) {
      setHiddenClipIds((prev) => {
        const next = new Set(prev);
        next.delete(pendingUndo.clip.id);
        return next;
      });
    }
    setPendingUndo(null);
  }

  /**
   * Recovery for a failed project. Re-posting the same source resets the stored
   * project in place and re-enqueues ingest, so this costs no re-typing.
   */
  async function retryProject(target: ProjectSummary) {
    setError(null);
    try {
      const project =
        target.sourceType === "youtube"
          ? await api.createFromYoutube(target.sourceUrl, target.genreId)
          : target;
      selectProject(project.id);
      await refreshProjects();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function confirmDeleteProject() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.deleteProject(confirmDelete.id);
      if (selectedId === confirmDelete.id) {
        // Replace, not push: the deleted project must not be a Back destination.
        navigate(routes.root, { replace: true });
        setDetail(null);
      }
      setConfirmDelete(null);
      await refreshProjects();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setDeleting(false);
    }
  }

  function downloadAll(clips: ClipPayload[]) {
    clips
      .filter((c) => c.status === "rendered")
      .forEach((clip, index) => {
        window.setTimeout(() => {
          const anchor = document.createElement("a");
          anchor.href = clipDownloadUrl(clip.id, { download: true, bust: clip.renderedAt });
          anchor.download = `clip_${clip.rank}.mp4`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        }, index * 400);
      });
  }

  // Derive the header from the project list so switching projects never shows
  // the previous one's title, and gate the board on the detail actually
  // belonging to the project that is selected.
  const project = detail?.project ?? projects.find((p) => p.id === selectedId);
  const detailMatches = Boolean(detail && selectedId && detail.project.id === selectedId);
  const showRail = project && ACTIVE_STATUSES.includes(project.status);
  const loadingClips = Boolean(selectedId && !detailMatches && !showRail);
  const visibleClips = (detailMatches && detail ? detail.clips : []).filter(
    (c) => !hiddenClipIds.has(c.id)
  );
  const processing = Boolean(project && ACTIVE_STATUSES.includes(project.status));
  const editingClipRoute = Boolean(selectedId && editingClipId && !outroRoute);
  // The clip under edit, kept live by the poller so render progress shows in the
  // editor without the editor reaching for its own copy of the data.
  const editingClip =
    editingClipRoute && detailMatches && detail
      ? (detail.clips.find((c) => c.id === editingClipId) ?? null)
      : null;
  /**
   * True once the poller has resolved this URL's project, so the editor route
   * can tell "still loading" from "this clip is not here". A failed load also
   * counts as resolved — otherwise a bad project id would spin forever.
   */
  const editingClipLoaded = detailMatches || (!loadingClips && Boolean(error));
  const defaultCaptionsOn = project
    ? (genres.find((g) => g.id === project.genreId)?.captionsDefault ?? true)
    : true;

  return (
    <div className="safe-x flex h-full">
      {/* ---- sidebar ---- */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border bg-panel/60 lg:flex">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Scissors className="size-4 text-accent" aria-hidden="true" />
          <div>
            <p className="text-ui font-bold leading-none">clipperOS</p>
            <p className="text-micro mt-1 text-muted">Clip factory</p>
          </div>
        </div>
        <nav aria-label="Projects" className="studio-scroll flex-1 overflow-y-auto p-2">
          <p className="eyebrow px-2 py-2 text-muted">
            Projects
          </p>
          <ProjectList
            projects={projects}
            loading={projectsLoading}
            selectedId={selectedId}
            onSelect={selectProject}
            onRequestDelete={setConfirmDelete}
          />
        </nav>
      </aside>

      {/* ---- main ---- */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-panel/80 px-4 py-2 backdrop-blur lg:flex-nowrap lg:px-5">
          {/* min-w-0 is what lets `truncate` actually shrink inside a flex row;
              without it the title holds its full width and pushes the switcher
              past the viewport edge on a phone. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Scissors className="size-4 shrink-0 text-accent lg:hidden" aria-hidden="true" />
            <h1 className="text-body truncate font-semibold" title={project?.title}>
              {project ? project.title : "clipperOS"}
            </h1>
            {project ? (
              <span className="text-micro hidden shrink-0 text-muted sm:inline">
                {project.status}
              </span>
            ) : null}
          </div>

          {project ? (
            <button
              type="button"
              onClick={() => navigate(routes.outro(project.id))}
              aria-current={outroRoute ? "page" : undefined}
              className={`press text-ui inline-flex h-11 shrink-0 items-center rounded-md border px-2.5 font-medium sm:h-8 ${
                outroRoute ? "border-accent bg-accent/10" : "border-border hover:border-control"
              }`}
            >
              Outro
            </button>
          ) : null}

          {project ? (
            <button
              type="button"
              onClick={() => setIntakeOpen((open) => !open)}
              aria-expanded={intakeOpen}
              className="press text-ui inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 font-medium hover:border-control sm:h-8"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              New
            </button>
          ) : null}

          {/* mobile project switcher — labelled, since its options are titles */}
          <label className="shrink-0 lg:hidden">
            <span className="sr-only">Select project</span>
            <select
              className="text-ui h-11 w-[38vw] max-w-[220px] rounded-md border border-border bg-panel-2 px-2"
              value={selectedId ?? ""}
              onChange={(e) => selectProject(e.target.value || null)}
            >
              <option value="">No project selected</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title.slice(0, 40)}
                </option>
              ))}
            </select>
          </label>
        </header>

        {/* The editor is a page, not a layer: it takes the whole content column
            so a refresh on a clip URL renders that clip's editor directly. */}
        {outroRoute ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {project && selectedId ? (
              <OutroBuilder
                projectId={selectedId}
                outroId={outroId}
                projectTitle={project.title}
                spec={pickProjectOutro(project.outros, outroId, project.defaultOutroId) ?? project.outro}
                returnClipId={returnClipId}
                onLibraryChange={(library) =>
                  setDetail((prev) =>
                    prev
                      ? {
                          ...prev,
                          project: {
                            ...prev.project,
                            outros: library.items,
                            defaultOutroId: library.defaultOutroId,
                            outro: pickProjectOutro(library.items, undefined, library.defaultOutroId),
                          },
                        }
                      : prev
                  )
                }
                onSelectOutro={(id) => navigate(routes.outro(selectedId, returnClipId, id))}
                onBack={() => navigate(routes.project(selectedId))}
                onReturnToClip={(id) => void returnToClipWithOutro(id)}
                onSkipExport={(id) => void skipOutroAndReturn(id)}
              />
            ) : (
              <EditorLoading />
            )}
            <div className="px-3 pb-3 lg:px-5">
              <ErrorNotice
                error={error}
                notice={notice}
                onDismissError={() => setError(null)}
                onDismissNotice={() => setNotice(null)}
              />
            </div>
          </div>
        ) : editingClipRoute ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {editingClip && project ? (
              <ClipEditor
                key={editingClip.id}
                clip={editingClip}
                project={project}
                styles={captionStyles}
                fonts={captionFonts}
                defaultCaptionsOn={defaultCaptionsOn}
                rendering={editingClip.status === "rendering"}
                onSave={(draft) => saveClipDraft(editingClip.id, draft)}
                onRender={(draft) => renderClipDraft(editingClip.id, draft)}
                onRequestDelete={() =>
                  setDeleteRequest({
                    ids: [editingClip.id],
                    label: `clip #${editingClip.rank}`,
                    bytes: editingClip.outputBytes ?? 0,
                  })
                }
                onOpenOutro={(id) =>
                  selectedId ? navigate(routes.outro(selectedId, editingClip.id, id)) : undefined
                }
                onBack={() => navigate(routes.clipParent(editingClip.projectId))}
                onClipUpdated={patchClip}
              />
            ) : editingClipLoaded ? (
              <ClipNotFound
                onBack={() =>
                  selectedId ? navigate(routes.project(selectedId)) : navigate(routes.root)
                }
              />
            ) : (
              <EditorLoading />
            )}
            {/* The global banner lives in both branches: a failure that lands
                while the editor is open must not be invisible. */}
            <div className="px-3 pb-3 lg:px-5">
              <ErrorNotice
                error={error}
                notice={notice}
                onDismissError={() => setError(null)}
                onDismissNotice={() => setNotice(null)}
              />
            </div>
          </div>
        ) : (
        <div className="studio-scroll flex-1 overflow-y-auto p-4 lg:p-6">
          <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5">
            {intakeOpen || !project ? (
              <div className="motion-reveal">
                <SourceBar
                  busy={busy}
                  genres={genres}
                  genreChoice={genreChoice}
                  error={sourceError}
                  onGenreChoice={setGenreChoice}
                  onClearError={() => setSourceError(null)}
                  onYoutube={handleYoutube}
                  onUpload={handleUpload}
                />
              </div>
            ) : null}

            <ErrorNotice
              error={error}
              notice={notice}
              onDismissError={() => setError(null)}
              onDismissNotice={() => setNotice(null)}
            />

            {!project ? (
              <div className="studio-glow flex flex-col items-center gap-6 rounded-xl border border-border bg-panel p-6 lg:flex-row lg:gap-10 lg:p-10">
                <div className="min-w-0 flex-1">
                  <h2 className="text-head font-semibold tracking-tight">
                    Turn any long video into a clip board
                  </h2>
                  <p className="text-body mt-2 max-w-[62ch] text-muted">
                    Paste a YouTube link or drop a file. clipperOS reads the transcript, works out
                    what kind of content it is, and cuts it into clips that hold up in that genre.
                  </p>
                  <ul className="text-body mt-4 space-y-1.5 text-muted">
                    <li>Word-accurate captions, no download needed to mine</li>
                    <li>Every candidate scored and ranked, with its payoff located</li>
                    <li>Render the strong ones as vertical clips</li>
                  </ul>
                </div>
                {/* The artifact, not a diagram of the pipeline. */}
                <div className="flex shrink-0 justify-center">
                  <OutputPreview />
                </div>
              </div>
            ) : null}

            {project && project.status === "failed" ? (
              <div role="alert" className="rounded-xl border border-bad/40 bg-bad/10 p-6">
                <div className="flex items-center gap-2 text-bad">
                  <AlertTriangle className="size-5" aria-hidden="true" />
                  <p className="font-semibold">This project failed</p>
                </div>
                <p className="text-body mt-2 text-bad/90">{project.error}</p>
                {/* A failure with no way forward is a dead end. Re-posting the
                    same source re-runs ingest on the stored project. */}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void retryProject(project)}
                    className="press text-ui inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-4 font-semibold text-accent-fg hover:opacity-90"
                  >
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Try again
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(project)}
                    className="press text-ui inline-flex h-11 items-center gap-2 rounded-lg border border-control px-4 font-medium hover:border-bad hover:text-bad"
                  >
                    Delete project
                  </button>
                </div>
              </div>
            ) : null}

            {showRail ? <PipelineRail project={project} /> : null}

            {/* Switching projects must not flash the previous project's clips or
                an empty board. Say what is happening instead. */}
            {loadingClips ? (
              <div role="status" aria-live="polite" className="flex flex-col gap-3">
                <span className="sr-only">Loading clips</span>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    aria-hidden="true"
                    className="flex animate-pulse-soft items-center gap-4 rounded-xl border border-border bg-panel p-4"
                  >
                    <span className="size-11 shrink-0 rounded-lg bg-panel-2" />
                    <span className="flex-1 space-y-2">
                      <span className="block h-3 w-2/5 rounded bg-panel-2" />
                      <span className="block h-3 w-3/5 rounded bg-panel-2" />
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {project && project.status === "ready" && detailMatches && detail ? (
              <div aria-busy={processing}>
                <ClipBoard
                  project={project}
                  clips={visibleClips}
                  genres={genres}
                  selectedIds={selectedClipIds}
                  reframeMode={reframeMode}
                  captions={captions}
                  density={density}
                  pendingUndo={pendingUndo}
                  cleaningStorage={cleaningStorage}
                  onReframeMode={setReframeMode}
                  onCaptions={setCaptions}
                  onDensity={setDensity}
                  onRemine={(genreId) => void handleRemine(genreId)}
                  onToggle={(id) =>
                    setSelectedClipIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onToggleAll={() =>
                    setSelectedClipIds((prev) =>
                      prev.size === visibleClips.length
                        ? new Set()
                        : new Set(visibleClips.map((c) => c.id))
                    )
                  }
                  onRenderSelected={() => openMixFor([...selectedClipIds])}
                  onRenderOne={(id) => openMixFor([id])}
                  onEdit={(id) =>
                    selectedId ? navigate(routes.clip(selectedId, id)) : undefined
                  }
                  onMerge={() => void handleMerge([...selectedClipIds])}
                  onDeleteSelected={() => {
                    const targets = visibleClips.filter((c) => selectedClipIds.has(c.id));
                    if (targets.length === 0) return;
                    setDeleteRequest({
                      ids: targets.map((c) => c.id),
                      label: `${targets.length} clip${targets.length === 1 ? "" : "s"}`,
                      bytes: targets.reduce((sum, c) => sum + (c.outputBytes ?? 0), 0),
                    });
                  }}
                  onCleanStorage={() => void handleCleanStorage()}
                  onDismiss={handleDismiss}
                  onUndoDismiss={undoDismiss}
                  onDownloadAll={() => downloadAll(visibleClips)}
                  onWriteCopy={(force) => void handleWriteCopy(force)}
                  writingCopy={writingCopy}
                  onClipUpdated={patchClip}
                />
              </div>
            ) : null}
          </div>
        </div>
        )}

        {/* Thumb-zone primary action. The board's own toolbar sits at the top of
            the panel, which is out of reach one-handed on a phone. Padded for
            the home indicator / gesture bar via .safe-b. The editor has its own
            footer, so this stays off that route. */}
        {!editingClipRoute && !outroRoute && project && selectedClipIds.size > 0 ? (
          <div className="safe-b sticky bottom-0 z-10 border-t border-border bg-panel/95 px-3 pt-3 backdrop-blur lg:hidden">
            <button
              type="button"
              onClick={() => openMixFor([...selectedClipIds])}
              className="press text-ui inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent font-semibold text-accent-fg hover:opacity-90"
            >
              <Sparkles className="size-4" aria-hidden="true" />
              Render selected ({selectedClipIds.size})
            </button>
          </div>
        ) : null}
      </main>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.title ?? "this project"}?`}
        body={`This removes ${confirmDelete?.clipCount ?? 0} clip${
          confirmDelete?.clipCount === 1 ? "" : "s"
        }, the downloaded source media, and any rendered output. It cannot be undone.`}
        confirmLabel="Delete project"
        destructive
        busy={deleting}
        onConfirm={() => void confirmDeleteProject()}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmDialog
        open={deleteRequest !== null}
        title={`Delete ${deleteRequest?.label ?? "this clip"}?`}
        body={`This permanently removes the rendered file from storage${
          deleteRequest?.bytes ? ` (${formatBytes(deleteRequest.bytes)})` : ""
        } and its record. ${
          editingClip?.kind === "merge" ? "Its source clips are kept." : ""
        } It cannot be undone.`}
        confirmLabel="Delete"
        destructive
        busy={deletingClips}
        onConfirm={() => void confirmDeleteClips()}
        onCancel={() => setDeleteRequest(null)}
      />
    </div>
  );
}
