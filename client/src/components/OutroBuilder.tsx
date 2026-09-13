import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, Loader2, Plus, Sparkles, Upload } from "lucide-react";
import {
  api,
  pickProjectOutro,
  projectOutroLogoUrl,
  projectOutroPreviewUrl,
  type AudioAsset,
  type CaptionFontInfo,
  type ClipOutro,
  type OutroLineAnimation,
  type OutroLineStyle,
  type OutroMarkStyle,
  type OutroPayload,
  type OutroTemplateId,
  type ProjectOutro,
} from "@/api";
import { cn } from "@/lib/utils";

const DURATIONS = [1.8, 2.4, 3.2] as const;
const CTA_BASE_FONT = 32;
const HANDLE_BASE_FONT = 20;

const FALLBACK_MARK: Required<OutroMarkStyle> = { sizeScale: 1, x: 0.5, y: 0.46, circle: false };
const FALLBACK_CTA: Required<OutroLineStyle> = {
  fontFamily: "Helvetica Neue",
  sizeScale: 1,
  textColor: "#d4d8de",
  uppercase: true,
  spacing: 6,
  animation: "fade",
  x: 0.5,
  y: 0.66,
};
const FALLBACK_HANDLE: Required<OutroLineStyle> = {
  fontFamily: "Helvetica Neue",
  sizeScale: 1,
  textColor: "#d4d8de",
  uppercase: false,
  spacing: 7,
  animation: "fade",
  x: 0.5,
  y: 0.72,
};

const FALLBACK_TEMPLATES: { id: OutroTemplateId; label: string; summary: string }[] = [
  { id: "lockup", label: "Lockup", summary: "Ignite. Settle. Hold." },
  { id: "sting", label: "Sting", summary: "White hit, then the mark." },
  { id: "rise", label: "Rise", summary: "Lifts in. Holds dead." },
  { id: "card", label: "Plate", summary: "Lockup with a tracked line." },
];

type PlaceTarget = "mark" | "cta" | "handle";

function mergeMark(raw?: OutroMarkStyle): Required<OutroMarkStyle> {
  return { ...FALLBACK_MARK, ...raw };
}

function mergeLine(raw: OutroLineStyle | undefined, fallback: Required<OutroLineStyle>): Required<OutroLineStyle> {
  return { ...fallback, ...raw };
}

function clampFrac(value: number): number {
  return Math.min(0.96, Math.max(0.04, value));
}

export function OutroAttachCard({
  items,
  defaultOutroId,
  attach,
  onChange,
  onEdit,
}: {
  items: ProjectOutro[];
  defaultOutroId?: string;
  attach: ClipOutro;
  onChange: (next: ClipOutro) => void;
  onEdit: (outroId?: string) => void;
}) {
  const enabled = attach.enabled !== false;
  const selected = pickProjectOutro(items, attach.outroId, defaultOutroId);
  const selectValue = !enabled ? "skip" : selected?.id ?? "";
  return (
    <section className="rounded-xl border border-border bg-panel p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="eyebrow text-muted">Outro</h3>
        <button
          type="button"
          onClick={() => onEdit(enabled ? selected?.id : undefined)}
          className="press text-ui h-8 rounded-md px-2 font-medium text-muted hover:text-fg"
        >
          {items.length > 0 ? "Edit" : "Build"}
        </button>
      </div>
      <label className="mt-2 block">
        <span className="sr-only">Which sting</span>
        <select
          value={selectValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "skip") onChange({ ...attach, enabled: false });
            else onChange({ ...attach, enabled: true, outroId: value });
          }}
          className="text-ui mt-1 h-11 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent"
        >
          <option value="skip">None — skip on export</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name || item.logoName || "Outro"}
              {item.ready ? "" : " (draft)"}
            </option>
          ))}
        </select>
      </label>
      {enabled && selected ? (
        <p className="text-meta mt-2 text-muted">
          {selected.ready
            ? "Last frame, then this sting. The list is shared across projects."
            : "Finish this sting before export."}
        </p>
      ) : (
        <p className="text-meta mt-2 text-muted">Export stops on the last frame. The list is shared across projects.</p>
      )}
    </section>
  );
}

export function OutroBuilder({
  projectId,
  outroId,
  projectTitle,
  spec,
  returnClipId,
  onLibraryChange,
  onSelectOutro,
  onBack,
  onReturnToClip,
  onSkipExport,
}: {
  projectId: string;
  outroId?: string;
  projectTitle: string;
  spec?: ProjectOutro;
  returnClipId?: string;
  onLibraryChange: (library: { items: ProjectOutro[]; defaultOutroId?: string }) => void;
  onSelectOutro: (outroId: string) => void;
  onBack: () => void;
  onReturnToClip: (clipId: string) => void;
  onSkipExport: (clipId: string) => void;
}) {
  const [payload, setPayload] = useState<OutroPayload | null>(null);
  const [templateId, setTemplateId] = useState<OutroTemplateId>(spec?.templateId ?? "lockup");
  const [durationSec, setDurationSec] = useState(spec?.durationSec ?? 2.4);
  const [cta, setCta] = useState(spec?.cta ?? "");
  const [handle, setHandle] = useState(spec?.handle ?? "");
  const [name, setName] = useState(spec?.name || spec?.logoName || "Outro");
  const [mark, setMark] = useState<Required<OutroMarkStyle>>(mergeMark(spec?.mark));
  const [ctaStyle, setCtaStyle] = useState<Required<OutroLineStyle>>(mergeLine(spec?.ctaStyle, FALLBACK_CTA));
  const [handleStyle, setHandleStyle] = useState<Required<OutroLineStyle>>(
    mergeLine(spec?.handleStyle, FALLBACK_HANDLE)
  );
  const [sfxAssetId, setSfxAssetId] = useState(spec?.sfxAssetId ?? "hit");
  const [musicAssetId, setMusicAssetId] = useState(spec?.musicAssetId ?? "");
  const [sfxGain, setSfxGain] = useState(spec?.sfxGain ?? 0.7);
  const [busy, setBusy] = useState<"logo" | "save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState<PlaceTarget | null>(null);
  const [audio, setAudio] = useState<{ builtin: AudioAsset[]; custom: AudioAsset[] }>({
    builtin: [],
    custom: [],
  });
  const [fonts, setFonts] = useState<CaptionFontInfo[]>([]);
  const skipSave = useRef(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const specChangeRef = useRef(onLibraryChange);
  specChangeRef.current = onLibraryChange;
  const selectRef = useRef(onSelectOutro);
  selectRef.current = onSelectOutro;

  const live = payload?.spec ?? spec;
  const items = payload?.items ?? (spec ? [spec] : []);
  const activeId = outroId ?? live?.id;
  const hasLogo = payload?.hasLogo ?? Boolean(spec?.logoName);
  const hasPreview = payload?.hasPreview ?? Boolean(spec?.ready);
  const templates = payload?.templates?.length ? payload.templates : FALLBACK_TEMPLATES;
  const maxOutros = payload?.maxOutros ?? 24;
  const fontChoices = payload?.fonts?.length ? payload.fonts : fonts;
  const palette = live?.palette;

  const specPatch = useCallback(
    () => ({
      name,
      templateId,
      durationSec,
      cta,
      handle,
      mark,
      ctaStyle,
      handleStyle,
      sfxAssetId,
      musicAssetId: musicAssetId || "",
      sfxGain,
    }),
    [name, templateId, durationSec, cta, handle, mark, ctaStyle, handleStyle, sfxAssetId, musicAssetId, sfxGain]
  );

  const applyPayload = useCallback((next: OutroPayload) => {
    setPayload(next);
    specChangeRef.current({ items: next.items ?? [], defaultOutroId: next.defaultOutroId });
    const ctaFallback = next.defaults?.ctaStyle ?? FALLBACK_CTA;
    const handleFallback = next.defaults?.handleStyle ?? FALLBACK_HANDLE;
    const markFallback = next.defaults?.mark ?? FALLBACK_MARK;
    if (next.spec) {
      setName(next.spec.name || next.spec.logoName || "Outro");
      setTemplateId(next.spec.templateId ?? "lockup");
      setDurationSec(next.spec.durationSec ?? 2.4);
      setCta(next.spec.cta ?? "");
      setHandle(next.spec.handle ?? "");
      setMark({ ...markFallback, ...next.spec.mark });
      setCtaStyle({ ...ctaFallback, ...next.spec.ctaStyle });
      setHandleStyle({ ...handleFallback, ...next.spec.handleStyle });
      setSfxAssetId(next.spec.sfxAssetId ?? "hit");
      setMusicAssetId(next.spec.musicAssetId ?? "");
      setSfxGain(next.spec.sfxGain ?? 0.7);
    }
    skipSave.current = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [outro, library, catalog] = await Promise.all([
          outroId ? api.getProjectOutro(projectId, outroId) : api.getProjectOutros(projectId),
          api.listAudioLibrary(projectId),
          api.listCaptionFonts().catch(() => [] as CaptionFontInfo[]),
        ]);
        if (cancelled) return;
        applyPayload(outro);
        setAudio(library);
        setFonts(outro.fonts?.length ? outro.fonts : catalog);
        if (!outroId && outro.spec?.id) selectRef.current(outro.spec.id);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, outroId, applyPayload]);

  useEffect(() => {
    skipSave.current = true;
  }, [outroId]);

  useEffect(() => {
    if (!activeId) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        setBusy("save");
        setError(null);
        try {
          const next = await api.updateProjectOutro(projectId, activeId, specPatch());
          setPayload(next);
          specChangeRef.current({ items: next.items ?? [], defaultOutroId: next.defaultOutroId });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(null);
        }
      })();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [projectId, activeId, specPatch]);

  async function onLogo(file: File | undefined) {
    if (!file) return;
    setBusy("logo");
    setError(null);
    try {
      let id = activeId;
      if (!id) {
        const created = await api.createProjectOutro(projectId);
        id = created.spec?.id;
        if (!id) throw new Error("Could not create an outro");
      }
      applyPayload(await api.uploadOutroLogo(projectId, id, file));
      if (!activeId) selectRef.current(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function persistNow(): Promise<boolean> {
    if (!hasLogo || !activeId) return false;
    setBusy("save");
    setError(null);
    try {
      const next = await api.updateProjectOutro(projectId, activeId, specPatch());
      applyPayload(next);
      return Boolean(next.spec?.ready);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function finishAndReturn() {
    if (!returnClipId) {
      onBack();
      return;
    }
    const ready = await persistNow();
    if (ready) onReturnToClip(returnClipId);
  }

  async function addSting() {
    setBusy("save");
    setError(null);
    try {
      const next = await api.createProjectOutro(projectId);
      applyPayload(next);
      if (next.spec?.id) onSelectOutro(next.spec.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearSting() {
    if (!activeId) return;
    setBusy("clear");
    setError(null);
    try {
      const next = await api.deleteProjectOutro(projectId, activeId);
      applyPayload(next);
      if (next.spec?.id) onSelectOutro(next.spec.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function movePlaced(event: ReactPointerEvent<HTMLDivElement>) {
    if (!placing) return;
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame || frame.width < 8 || frame.height < 8) return;
    const x = clampFrac((event.clientX - frame.left) / frame.width);
    const y = clampFrac((event.clientY - frame.top) / frame.height);
    if (placing === "mark") setMark((prev) => ({ ...prev, x, y }));
    if (placing === "cta") setCtaStyle((prev) => ({ ...prev, x, y }));
    if (placing === "handle") setHandleStyle((prev) => ({ ...prev, x, y }));
  }

  const sfxTracks = [...audio.builtin, ...audio.custom].filter((asset) => asset.kind === "sfx");
  const musicTracks = [...audio.builtin, ...audio.custom].filter((asset) => asset.kind === "music");
  const composing = busy === "save" || busy === "logo";
  const previewSrc = hasPreview && activeId
    ? projectOutroPreviewUrl(projectId, activeId, live?.updatedAt ?? "1")
    : undefined;
  const logoSrc = hasLogo && activeId ? projectOutroLogoUrl(projectId, activeId, live?.updatedAt ?? "1") : undefined;

  useEffect(() => {
    if (placing === "cta" && !cta.trim()) setPlacing(null);
    if (placing === "handle" && !handle.trim()) setPlacing(null);
  }, [placing, cta, handle]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !previewSrc) return;
    el.muted = false;
    void el.play().catch(() => {
      el.muted = true;
      void el.play().catch(() => undefined);
    });
  }, [previewSrc]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 lg:px-5">
        <button
          type="button"
          onClick={onBack}
          className="press text-ui inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 font-medium hover:border-control sm:h-8"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Board
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="min-w-0">
            <p className="text-body truncate font-semibold">Outro library</p>
            <p className="text-meta truncate text-muted">Shared across projects{projectTitle ? ` · ${projectTitle}` : ""}</p>
          </div>
          {items.length > 0 ? (
            <select
              value={activeId ?? ""}
              onChange={(event) => onSelectOutro(event.target.value)}
              className="text-ui ms-auto h-9 max-w-[11rem] shrink-0 rounded-md border border-border bg-panel px-2 outline-none focus:border-accent"
              aria-label="Which sting"
            >
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.logoName || "Outro"}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            disabled={busy !== null || items.length >= maxOutros}
            onClick={() => void addSting()}
            className="press text-ui inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-border px-2.5 font-medium hover:border-control disabled:opacity-40"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            New
          </button>
        </div>
        {composing ? (
          <span className="text-meta flex items-center gap-1.5 text-muted">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Composing…
          </span>
        ) : live?.ready ? (
          <span className="text-meta text-good">Ready</span>
        ) : null}
      </header>

      {returnClipId ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-2 lg:px-5">
          <Sparkles className="size-3.5 text-accent" aria-hidden="true" />
          <p className="text-ui min-w-0 flex-1 text-muted">Export waits on this sting.</p>
          <button
            type="button"
            onClick={() => onSkipExport(returnClipId)}
            className="press text-ui h-9 rounded-md px-2 font-medium text-muted hover:text-fg"
          >
            Skip this export
          </button>
        </div>
      ) : null}

      <div className="studio-scroll grid min-h-0 flex-1 gap-4 overflow-y-auto p-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden lg:p-5">
        <section className="flex h-full min-h-0 min-w-0 flex-col items-center gap-2 overflow-hidden">
          <div className="preview-stage min-h-0 w-full max-lg:h-[min(52dvh,28rem)] lg:flex-1">
            <div className="preview-frame overflow-hidden rounded-xl border border-border bg-black">
              <div
                ref={frameRef}
                className="absolute inset-0"
                style={{ containerType: "size" }}
                onDragOver={(event) => {
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files[0];
                  if (file?.type.startsWith("image/")) void onLogo(file);
                }}
                onPointerDown={(event) => {
                  if (!placing || !hasLogo) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  movePlaced(event);
                }}
                onPointerMove={(event) => {
                  if (placing && event.currentTarget.hasPointerCapture(event.pointerId)) movePlaced(event);
                }}
              >
                {previewSrc ? (
                  <video
                    key={previewSrc}
                    ref={videoRef}
                    src={previewSrc}
                    className={cn("h-full w-full object-cover", placing && "opacity-35")}
                    playsInline
                    loop
                    autoPlay
                    muted={false}
                  />
                ) : (
                  <label className="flex h-full cursor-pointer flex-col items-center justify-center gap-3 p-6 text-center">
                    <Upload className="size-6 text-muted" aria-hidden="true" />
                    <span className="text-body font-semibold">Drop a mark</span>
                    <span className="text-meta text-muted">PNG, JPG or WebP. We read the palette from it.</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        void onLogo(file);
                      }}
                    />
                  </label>
                )}
                {hasLogo && placing ? (
                  <LayoutPreview
                    logoSrc={logoSrc}
                    cta={cta}
                    handle={handle}
                    mark={mark}
                    accent={palette?.accent}
                    ctaStyle={ctaStyle}
                    handleStyle={handleStyle}
                    fonts={fontChoices}
                    active={placing}
                  />
                ) : null}
                {composing ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                    <Loader2 className="size-6 animate-spin text-fg" aria-hidden="true" />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          {hasLogo ? (
            <div className="flex w-full max-w-[340px] shrink-0 flex-wrap justify-center gap-1.5">
              <Chip
                active={placing === "mark"}
                label={placing === "mark" ? "Drag mark now" : "Place mark"}
                onClick={() => setPlacing((prev) => (prev === "mark" ? null : "mark"))}
              />
              {cta.trim() ? (
                <Chip
                  active={placing === "cta"}
                  label={placing === "cta" ? "Drag CTA now" : "Place CTA"}
                  onClick={() => setPlacing((prev) => (prev === "cta" ? null : "cta"))}
                />
              ) : null}
              {handle.trim() ? (
                <Chip
                  active={placing === "handle"}
                  label={placing === "handle" ? "Drag line now" : "Place line"}
                  onClick={() => setPlacing((prev) => (prev === "handle" ? null : "handle"))}
                />
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="studio-scroll flex min-w-0 flex-col gap-4 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
          <div className="rounded-xl border border-border bg-panel p-3">
            <h3 className="eyebrow mb-1 text-muted">Mark</h3>
            <div className="mt-2 flex items-center gap-3">
              {hasLogo ? (
                <img
                  src={activeId ? projectOutroLogoUrl(projectId, activeId, live?.updatedAt ?? "1") : ""}
                  alt=""
                  className={cn(
                    "size-14 border border-border object-contain bg-black",
                    mark.circle ? "rounded-full p-1.5" : "rounded-lg"
                  )}
                />
              ) : (
                <div
                  className={cn(
                    "size-14 border border-dashed border-control",
                    mark.circle ? "rounded-full" : "rounded-lg"
                  )}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-ui truncate font-semibold">{live?.logoName || "No mark yet"}</p>
                {palette ? (
                  <div className="mt-1.5 flex gap-1.5">
                    {([palette.bg, palette.accent, palette.ink] as const).map((hex) => (
                      <span
                        key={hex}
                        className="size-4 rounded-full border border-border"
                        style={{ background: hex }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
              <label className="press text-ui inline-flex h-10 cursor-pointer items-center rounded-lg border border-control px-3 font-medium hover:border-accent">
                {busy === "logo" ? "Reading…" : hasLogo ? "Replace" : "Upload"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="sr-only"
                  disabled={busy !== null}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    void onLogo(file);
                  }}
                />
              </label>
            </div>
            <label className="mt-3 block">
              <span className="text-ui text-muted">Name</span>
              <input
                value={name}
                maxLength={40}
                disabled={!activeId}
                placeholder="Outro"
                onChange={(event) => setName(event.target.value)}
                className="text-ui mt-1 h-11 w-full rounded-lg border border-control bg-panel-2 px-3"
              />
            </label>
            <p className="eyebrow mt-4 text-muted">Shape</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Chip
                active={!mark.circle}
                label="Free"
                disabled={!hasLogo}
                onClick={() => setMark((prev) => ({ ...prev, circle: false }))}
              />
              <Chip
                active={mark.circle}
                label="Circle"
                disabled={!hasLogo}
                onClick={() => setMark((prev) => ({ ...prev, circle: true }))}
              />
            </div>
            <p className="text-meta mt-2 text-muted">
              {mark.circle ? "Bloom and settle move with the disc." : "The mark sits free on the field."}
            </p>
            <Slider
              label="Size"
              value={mark.sizeScale}
              min={0.35}
              max={1.8}
              step={0.05}
              disabled={!hasLogo}
              format={(value) => `${Math.round(value * 100)}%`}
              onChange={(sizeScale) => setMark((prev) => ({ ...prev, sizeScale }))}
            />
            <details className="mt-2">
              <summary className="text-ui cursor-pointer text-muted">Position</summary>
              <Slider
                label="Horizontal"
                value={mark.x}
                min={0.04}
                max={0.96}
                step={0.005}
                disabled={!hasLogo}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(x) => setMark((prev) => ({ ...prev, x }))}
              />
              <Slider
                label="Vertical"
                value={mark.y}
                min={0.04}
                max={0.96}
                step={0.005}
                disabled={!hasLogo}
                format={(value) => `${Math.round(value * 100)}% down`}
                onChange={(y) => setMark((prev) => ({ ...prev, y }))}
              />
            </details>
          </div>

          <div className="rounded-xl border border-border bg-panel p-3">
            <h3 className="eyebrow mb-1 text-muted">Motion</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {templates.map((item) => (
                <Chip
                  key={item.id}
                  active={templateId === item.id}
                  label={item.label}
                  disabled={!hasLogo}
                  onClick={() => setTemplateId(item.id)}
                />
              ))}
            </div>
            <p className="text-meta mt-2 text-muted">
              {templates.find((item) => item.id === templateId)?.summary}
            </p>
            <p className="eyebrow mt-4 text-muted">Hold</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {DURATIONS.map((value) => (
                <Chip
                  key={value}
                  active={durationSec === value}
                  label={`${value.toFixed(1).replace(/\.0$/, "")}s`}
                  disabled={!hasLogo}
                  onClick={() => setDurationSec(value)}
                />
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-panel p-3">
            <h3 className="eyebrow mb-1 text-muted">Line</h3>
            <label className="mt-2 block">
              <span className="text-ui text-muted">CTA</span>
              <input
                value={cta}
                maxLength={42}
                disabled={!hasLogo}
                placeholder="optional — empty is the premium default"
                onChange={(event) => setCta(event.target.value)}
                className="text-ui mt-1 h-11 w-full rounded-lg border border-control bg-panel-2 px-3"
              />
            </label>
            {cta.trim() ? (
              <details className="mt-2">
                <summary className="text-ui cursor-pointer text-muted">CTA look</summary>
                <LineAppearance
                  style={ctaStyle}
                  fonts={fontChoices}
                  disabled={!hasLogo}
                  onChange={setCtaStyle}
                />
              </details>
            ) : null}
            <label className="mt-4 block">
              <span className="text-ui text-muted">Handle</span>
              <input
                value={handle}
                maxLength={32}
                disabled={!hasLogo}
                placeholder="optional"
                onChange={(event) => setHandle(event.target.value.replace(/^@/, ""))}
                className="text-ui mt-1 h-11 w-full rounded-lg border border-control bg-panel-2 px-3"
              />
            </label>
            {handle.trim() ? (
              <details className="mt-2">
                <summary className="text-ui cursor-pointer text-muted">Handle look</summary>
                <LineAppearance
                  style={handleStyle}
                  fonts={fontChoices}
                  disabled={!hasLogo}
                  onChange={setHandleStyle}
                />
              </details>
            ) : null}
          </div>

          <div className="rounded-xl border border-border bg-panel p-3">
            <h3 className="eyebrow mb-1 text-muted">Sound</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip active={!sfxAssetId} label="Silent" disabled={!hasLogo} onClick={() => setSfxAssetId("")} />
              {sfxTracks.map((asset) => (
                <Chip
                  key={asset.id}
                  active={sfxAssetId === asset.id}
                  label={asset.label}
                  disabled={!hasLogo}
                  onClick={() => setSfxAssetId(asset.id)}
                />
              ))}
            </div>
            {sfxAssetId ? (
              <label className="mt-3 block">
                <span className="text-ui flex items-center justify-between text-muted">
                  Hit level
                  <span className="num font-semibold text-fg">{Math.round(sfxGain * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1.2}
                  step={0.05}
                  value={sfxGain}
                  disabled={!hasLogo}
                  onChange={(event) => setSfxGain(Number(event.target.value))}
                  className="accent-accent mt-1 h-11 w-full"
                />
              </label>
            ) : null}
            <p className="eyebrow mt-4 text-muted">Bed</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Chip active={!musicAssetId} label="None" disabled={!hasLogo} onClick={() => setMusicAssetId("")} />
              {musicTracks.map((asset) => (
                <Chip
                  key={asset.id}
                  active={musicAssetId === asset.id}
                  label={asset.label}
                  disabled={!hasLogo}
                  onClick={() => setMusicAssetId(asset.id)}
                />
              ))}
            </div>
          </div>

          {error ? <p className="text-meta text-bad">{error}</p> : null}
        </section>
      </div>

      <footer className="safe-b flex flex-wrap items-center gap-2 border-t border-border px-3 pt-2 lg:px-5">
        {activeId ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void clearSting()}
            className="press text-ui h-10 rounded-md px-2 font-medium text-muted hover:text-bad"
          >
            Remove from library
          </button>
        ) : null}
        <span className="text-meta me-auto text-muted">
          {placing
            ? "Drag on the frame. The sting follows."
            : hasPreview
              ? "Shared library. Every project can pick this sting."
              : "A logo is enough. New stings land in the shared library."}
        </span>
        {returnClipId ? (
          <button
            type="button"
            disabled={!hasPreview || busy !== null}
            onClick={() => void finishAndReturn()}
            className="press text-ui inline-flex h-10 items-center gap-1.5 rounded-md bg-accent px-3 font-semibold text-accent-fg disabled:opacity-50"
          >
            Use outro & return
          </button>
        ) : (
          <button
            type="button"
            disabled={busy !== null}
            onClick={onBack}
            className="press text-ui inline-flex h-10 items-center rounded-md border border-border px-3 font-semibold"
          >
            Done
          </button>
        )}
      </footer>
    </div>
  );
}

function LayoutPreview({
  logoSrc,
  cta,
  handle,
  mark,
  accent,
  ctaStyle,
  handleStyle,
  fonts,
  active,
}: {
  logoSrc?: string;
  cta: string;
  handle: string;
  mark: Required<OutroMarkStyle>;
  accent?: string;
  ctaStyle: Required<OutroLineStyle>;
  handleStyle: Required<OutroLineStyle>;
  fonts: CaptionFontInfo[];
  active: PlaceTarget;
}) {
  const ctaFont = fonts.find((font) => font.family === ctaStyle.fontFamily);
  const handleFont = fonts.find((font) => font.family === handleStyle.fontFamily);
  const handleText = handle ? (handle.startsWith("@") ? handle : `@${handle}`) : "";
  const ring = accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#c8d0d6";
  return (
    <div className="pointer-events-none absolute inset-0">
      {logoSrc ? (
        mark.circle ? (
          <div
            className={cn(
              "absolute overflow-hidden rounded-full bg-[#0a0c0e]",
              active === "mark" ? "ring-2 ring-accent" : "opacity-90"
            )}
            style={{
              left: `${mark.x * 100}%`,
              top: `${mark.y * 100}%`,
              width: `${Math.min(90, 52 * mark.sizeScale)}%`,
              aspectRatio: "1",
              transform: "translate(-50%, -50%)",
              boxShadow: `0 0 0 2px ${ring}`,
            }}
          >
            <img src={logoSrc} alt="" className="h-full w-full object-contain p-[18%]" />
          </div>
        ) : (
          <img
            src={logoSrc}
            alt=""
            className={cn(
              "absolute object-contain",
              active === "mark" ? "ring-2 ring-accent" : "opacity-90"
            )}
            style={{
              left: `${mark.x * 100}%`,
              top: `${mark.y * 100}%`,
              width: `${Math.min(96, 72 * mark.sizeScale)}%`,
              transform: "translate(-50%, -50%)",
            }}
          />
        )
      ) : null}
      {cta ? (
        <span
          className={cn(
            "absolute max-w-[90%] text-center leading-none",
            active === "cta" && "ring-2 ring-accent"
          )}
          style={{
            left: `${ctaStyle.x * 100}%`,
            top: `${ctaStyle.y * 100}%`,
            transform: "translate(-50%, -50%)",
            fontSize: `calc(${(CTA_BASE_FONT * ctaStyle.sizeScale) / 1920} * 100cqh)`,
            fontFamily: ctaFont?.stack ?? ctaStyle.fontFamily,
            color: ctaStyle.textColor,
            letterSpacing: `${ctaStyle.spacing * 0.04}em`,
            whiteSpace: "nowrap",
          }}
        >
          {ctaStyle.uppercase ? cta.toUpperCase() : cta}
        </span>
      ) : null}
      {handleText ? (
        <span
          className={cn(
            "absolute max-w-[90%] text-center leading-none",
            active === "handle" && "ring-2 ring-accent"
          )}
          style={{
            left: `${handleStyle.x * 100}%`,
            top: `${handleStyle.y * 100}%`,
            transform: "translate(-50%, -50%)",
            fontSize: `calc(${(HANDLE_BASE_FONT * handleStyle.sizeScale) / 1920} * 100cqh)`,
            fontFamily: handleFont?.stack ?? handleStyle.fontFamily,
            color: handleStyle.textColor,
            letterSpacing: `${handleStyle.spacing * 0.05}em`,
            whiteSpace: "nowrap",
          }}
        >
          {handleStyle.uppercase ? handleText.toUpperCase() : handleText}
        </span>
      ) : null}
    </div>
  );
}

function LineAppearance({
  style,
  fonts,
  disabled,
  onChange,
}: {
  style: Required<OutroLineStyle>;
  fonts: CaptionFontInfo[];
  disabled: boolean;
  onChange: (next: Required<OutroLineStyle>) => void;
}) {
  const catalogFont = fonts.find((font) => font.family === style.fontFamily);
  const options =
    fonts.length > 0
      ? fonts.some((font) => font.family === style.fontFamily)
        ? fonts
        : [
            {
              id: "current",
              label: style.fontFamily,
              family: style.fontFamily,
              stack: style.fontFamily,
              weight: 700,
            },
            ...fonts,
          ]
      : [{ id: "arial", label: "Arial", family: "Arial", stack: "Arial", weight: 700 }];
  return (
    <div className="mt-1">
      <Slider
        label="Size"
        value={style.sizeScale}
        min={0.5}
        max={2.5}
        step={0.05}
        disabled={disabled}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(sizeScale) => onChange({ ...style, sizeScale })}
      />
      <Slider
        label="Horizontal"
        value={style.x}
        min={0.04}
        max={0.96}
        step={0.005}
        disabled={disabled}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(x) => onChange({ ...style, x })}
      />
      <Slider
        label="Vertical"
        value={style.y}
        min={0.04}
        max={0.96}
        step={0.005}
        disabled={disabled}
        format={(value) => `${Math.round(value * 100)}% down`}
        onChange={(y) => onChange({ ...style, y })}
      />
      <Slider
        label="Tracking"
        value={style.spacing}
        min={0}
        max={16}
        step={0.5}
        disabled={disabled}
        format={(value) => `${value.toFixed(1)}`}
        onChange={(spacing) => onChange({ ...style, spacing })}
      />
      <label className="mt-3 block">
        <span className="eyebrow text-muted">Font</span>
        <select
          value={style.fontFamily}
          disabled={disabled}
          onChange={(event) => onChange({ ...style, fontFamily: event.target.value })}
          className="text-ui mt-1 h-11 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent disabled:opacity-40"
          style={{ fontFamily: catalogFont?.stack ?? style.fontFamily }}
        >
          {(options).map(
            (font) => (
              <option key={font.id} value={font.family} style={{ fontFamily: font.stack }}>
                {font.label}
              </option>
            )
          )}
        </select>
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="eyebrow text-muted">Text</span>
          <input
            type="color"
            value={style.textColor}
            disabled={disabled}
            onChange={(event) => onChange({ ...style, textColor: event.target.value })}
            className="h-9 w-12 cursor-pointer rounded border border-control bg-panel-2 disabled:opacity-40"
            aria-label="Line colour"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={style.uppercase}
            disabled={disabled}
            onChange={(event) => onChange({ ...style, uppercase: event.target.checked })}
            className="size-4 accent-accent"
          />
          <span className="text-ui text-muted">Uppercase</span>
        </label>
      </div>
      <label className="mt-3 block">
        <span className="eyebrow text-muted">Entrance</span>
        <select
          value={style.animation}
          disabled={disabled}
          onChange={(event) => onChange({ ...style, animation: event.target.value as OutroLineAnimation })}
          className="text-ui mt-1 h-10 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent disabled:opacity-40"
        >
          <option value="none">None</option>
          <option value="fade">Quick fade</option>
          <option value="pop">Punch pop</option>
        </select>
      </label>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mt-3 block">
      <span className="text-ui flex items-center justify-between">
        <span className="text-muted">{label}</span>
        <span className="num font-semibold">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-accent mt-1 h-11 w-full disabled:opacity-40"
      />
    </label>
  );
}

function Chip({
  active,
  label,
  disabled,
  onClick,
}: {
  active: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "press text-ui h-9 rounded-full border px-3 font-medium",
        active ? "border-accent bg-accent/10 text-fg" : "border-border text-muted hover:border-control hover:text-fg",
        disabled && "opacity-40"
      )}
    >
      {label}
    </button>
  );
}
