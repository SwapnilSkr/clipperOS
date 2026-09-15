import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  Eraser,
  Loader2,
  Merge,
  Music,
  Pause,
  Play,
  Plus,
  Save,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Redo2,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import {
  api,
  clipDownloadUrl,
  clipMatteUrl,
  MAX_CLEANUP_REGIONS,
  pickProjectOutro,
  projectOutroPreviewUrl,
  type CaptionFontInfo,
  type CaptionOverrides,
  type CaptionScene,
  type CaptionStyleInfo,
  type ClipSense,
  type DirectInput,
  type RenderReview,
  type CaptionTextOverride,
  type CaptionWordOverride,
  type CleanupRegion,
  type CreatorPlan,
  type AudioAsset,
  type EffectInfo,
  type MediaAsset,
  type TransitionInfo,
  type ClipEdit,
  type ClipPayload,
  type ClipSegment,
  type ClipOutro,
  type ProjectSummary,
  type ReframeTrack,
  type Soundtrack,
  type VideoEffects,
} from "@/api";
import { BeatTimeline, type BeatSelection } from "./BeatTimeline";
import { CaptionOverlay } from "./CaptionOverlay";
import { CreatorDesk } from "./CreatorDesk";
import { CleanupLayer } from "./CleanupLayer";
import { CutCheckPanel } from "./CutCheckPanel";
import { MixPanel, MixTimeline, soundtrackPayload } from "./MixPanel";
import { OutroAttachCard } from "./OutroBuilder";
import { ShareCopyButton } from "./ShareCopyButton";
import {
  applyCaptionWords,
  assignTokensToWords,
  bindTranscriptToTimings,
  buildTimelineCaptions,
  captionAt,
  compileGroupEditsToWords,
  effectiveCaptionStyle,
  expandWordTimings,
  sceneStyleFor,
  spokenWordIndex,
  type WordTiming,
} from "@/lib/captions";
import { checkSceneCuts, sceneCutsInWindow } from "@/lib/cut-check";
import {
  cameraStateAt,
  followLead,
  followSigma,
  followTightness,
  followTightnessX,
  headTravel,
  panPxAt,
  nextKeptTime,
  outputDuration,
  outputToSource,
  smoothedTrack,
  heldTrack,
  holdSpans,
  sourceToOutput,
  windowIndexAt,
  windowsFor,
} from "@/lib/creator-timeline";
import { useLiveSoundtrack } from "@/lib/live-soundtrack";
import { speechSpans } from "@/lib/music-beds";
import { addBeat, enablePlan, removeBeat, type BeatLane } from "@/lib/beat-plan";
import { rememberSfx } from "./SfxPicker";
import { lastEffect } from "./EffectPicker";
import { CutawayLayer } from "./CutawayLayer";
import { TextPlacement } from "./TextPlacement";
import { activeEffectsAt, cssFilterFor, paintFxLayers } from "@/lib/fx-preview";
import { cropTransformFor, holdCropUntilCuts, paintCropPreview, sourceTimeOnTrack, type Framing } from "@/lib/reframe";
import { DEFAULT_VIDEO_EFFECTS, SHORT_FORM_TEMPLATES, resolveVideoEffects } from "@/lib/edit-templates";
import { cn, formatBytes, timecode } from "@/lib/utils";
import { CaptionSectionField, ColorControl, Panel, PillToggle, SegmentedButton, Slider, TimestampInput } from "./editor-controls";

/** What the editor hands back when the user saves or renders. */
export interface ClipEditDraft {
  title?: string;
  edit: ClipEdit;
  /** Only sent for a merged clip. */
  segments?: ClipSegment[];
}

interface ClipEditorProps {
  clip: ClipPayload;
  project: ProjectSummary;
  styles: CaptionStyleInfo[];
  fonts: CaptionFontInfo[];
  /** The genre's caption default, used until the user overrides it. */
  defaultCaptionsOn: boolean;
  rendering: boolean;
  onSave: (draft: ClipEditDraft) => Promise<void>;
  onRender: (draft: ClipEditDraft) => Promise<void>;
  onRequestDelete: () => void;
  /** Open the project sting builder, then return to this clip. */
  onOpenOutro: (outroId?: string) => void;
  /** Back to the clip's board. */
  onBack: () => void;
  onClipUpdated?: (clip: ClipPayload) => void;
}

interface TrimHistoryEntry {
  trimStart: number;
  trimEnd: number;
  segments: ClipSegment[];
  activeIndex: number;
  label: "Mark in" | "Mark out";
}

/**
 * The clip editor page.
 *
 * Preview is deliberately local: the caption grouping runs in the browser off
 * the word onsets the API hands over, so dragging a trim handle or changing a
 * preset updates what you see with no round-trip. Nothing is burned until you
 * ask for a render.
 *
 * The player reads the SOURCE video, not the last render — trim handles have to
 * point at the same clock the renderer seeks on, otherwise the window you mark
 * is not the window you get.
 *
 * Edits AUTOSAVE (debounced). Saving is a metadata write, so it is free, and it
 * means a refresh, a crash, or a closed tab never costs the user their work.
 */
export function ClipEditor({
  clip,
  project,
  styles,
  fonts,
  defaultCaptionsOn,
  rendering,
  onSave,
  onRender,
  onRequestDelete,
  onOpenOutro,
  onBack,
  onClipUpdated,
}: ClipEditorProps) {
  const isMerge = clip.kind === "merge";
  const [searchParams, setSearchParams] = useSearchParams();
  const deskParam = searchParams.get("desk");
  const desk: "cut" | "mix" | "create" = deskParam === "mix" ? "mix" : deskParam === "create" ? "create" : "cut";
  function setDesk(next: "cut" | "mix" | "create") {
    setSearchParams(next === "cut" ? {} : { desk: next }, { replace: true });
  }

  // ---- draft state (seeded once; App keys this component by clip id) ----
  const [title, setTitle] = useState(clip.title ?? "");
  const [styleId, setStyleId] = useState(clip.edit?.captionStyleId ?? "clean");
  const [overrides, setOverrides] = useState<CaptionOverrides>(clip.edit?.captionOverrides ?? {});
  const [captionsOn, setCaptionsOn] = useState(clip.edit?.captionsOn ?? defaultCaptionsOn);
  const [captionTextOverrides, setCaptionTextOverrides] = useState<CaptionTextOverride[]>(
    clip.edit?.captionTextOverrides ?? []
  );
  const [captionWordOverrides, setCaptionWordOverrides] = useState<CaptionWordOverride[]>(
    clip.edit?.captionWordOverrides ?? []
  );
  const [editTemplateId, setEditTemplateId] = useState(clip.edit?.editTemplateId ?? "custom");
  const [videoEffects, setVideoEffects] = useState<VideoEffects>(clip.edit?.videoEffects ?? {});
  const [soundtrack, setSoundtrack] = useState<Soundtrack>(clip.edit?.soundtrack ?? {});
  const [clipOutro, setClipOutro] = useState<ClipOutro>({
    enabled: clip.edit?.outro?.enabled !== false,
    transitionId: clip.edit?.outro?.transitionId ?? "smash",
    outroId: clip.edit?.outro?.outroId,
  });
  const [reframeMode, setReframeMode] = useState<"center" | "smart">(clip.edit?.reframeMode ?? "smart");
  const [creator, setCreator] = useState<CreatorPlan>(clip.edit?.creator ?? { enabled: false, version: 1 });
  /** The person matte the preview composites behind-titles with. */
  const [matte, setMatte] = useState<{
    key: string;
    originSec: number;
    width: number;
    height: number;
  } | null>(null);
  const [matteNote, setMatteNote] = useState<string | null>(null);
  const matteRef = useRef<HTMLVideoElement>(null);
  const [beatSelection, setBeatSelection] = useState<BeatSelection | null>(null);
  const [audioLibrary, setAudioLibrary] = useState<AudioAsset[]>([]);
  /** The effects pack, served once; labels for the lane, previews for the player. */
  const [effectsRegistry, setEffectsRegistry] = useState<EffectInfo[]>([]);
  /** Stills and videos for cutaways, plus which stock providers are configured. */
  const [mediaLibrary, setMediaLibrary] = useState<MediaAsset[]>([]);
  const [stockSources, setStockSources] = useState<("pexels" | "pixabay")[]>([]);
  // What the harness saw in the window and thought of the last render; seeded from the clip, updated by passes.
  const [harness, setHarness] = useState<{ sense?: ClipSense; review?: RenderReview }>({ sense: clip.sense, review: clip.review });
  const [transitions, setTransitions] = useState<TransitionInfo[]>([]);
  const [trimStart, setTrimStart] = useState(clip.edit?.trimStartSec ?? clip.startSec);
  const [trimEnd, setTrimEnd] = useState(clip.edit?.trimEndSec ?? clip.endSec);
  const [segments, setSegments] = useState<ClipSegment[]>(
    isMerge && clip.segments?.length ? clip.segments.map((s) => ({ ...s })) : []
  );
  const [trimPast, setTrimPast] = useState<TrimHistoryEntry[]>([]);
  const [trimFuture, setTrimFuture] = useState<TrimHistoryEntry[]>([]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [previewStage, setPreviewStage] = useState<"clip" | "outro">("clip");
  const [outroTime, setOutroTime] = useState(0);
  const [outroDuration, setOutroDuration] = useState(0);
  const [joinFlash, setJoinFlash] = useState<null | "white" | "black" | "fade">(null);
  const [frameHeight, setFrameHeight] = useState(0);
  // Default to the source (trim handles need its clock). When it is not on disk
  // yet, fall back to the last render so the page still shows something.
  const [mode, setMode] = useState<"source" | "output">(!project.mediaReady && clip.outputUrl ? "output" : "source");
  const [preparingSource, setPreparingSource] = useState(false);
  const [previewTrack, setPreviewTrack] = useState<ReframeTrack | undefined>(
    clip.reframeTrack ? holdCropUntilCuts(clip.reframeTrack) : undefined
  );
  const [analysingFrame, setAnalysingFrame] = useState(false);
  const [words, setWords] = useState<WordTiming[] | null>(null);
  const [wordsError, setWordsError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "render">(null);
  const [autosaving, setAutosaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** "crop" is what-you-see-is-what-renders; "fit" shows the whole source. */
  const [fitMode, setFitMode] = useState<"crop" | "fit">("crop");
  const [frameWidth, setFrameWidth] = useState(0);
  /** The source's natural size, read off the video element once it loads. */
  const [sourceSize, setSourceSize] = useState({ w: 1920, h: 1080 });
  const [cleanup, setCleanup] = useState<CleanupRegion[]>(
    clip.edit?.cleanup ? clip.edit.cleanup.map((r) => ({ ...r })) : []
  );
  const [showCleanup, setShowCleanup] = useState(false);
  const [positioningCaptions, setPositioningCaptions] = useState(false);
  const [cleaningCaptions, setCleaningCaptions] = useState(false);
  const [cleanNote, setCleanNote] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const outroVideoRef = useRef<HTMLVideoElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const previewStageRef = useRef<"clip" | "outro">("clip");
  const handingToOutroRef = useRef(false);
  const beginOutroRef = useRef<() => void>(() => undefined);
  const outroPlaythroughRef = useRef(false);
  /** The freeze window the decoder is parked in, and when it entered. */
  const freezeRef = useRef<{ startSec: number; endSec: number; enteredAt: number } | null>(null);
  // Slow motion and a freeze fade the voice out, as the burn does. Decided on
  // the decoder's clock (the playback timer), not on the presented-frame
  // state, which lags it.
  const [voiceDucked, setVoiceDucked] = useState(false);
  const titleId = useRef(`clip-editor-${clip.id}`).current;
  const migratedWordsFor = useRef<string | null>(null);

  // ---- word onsets for local caption preview ----
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .getClipWords(clip.id, { startSec: trimStart, endSec: trimEnd })
        .then((result) => {
          if (!cancelled) setWords(result.words);
        })
        .catch((error: unknown) => {
          if (!cancelled) setWordsError(messageOf(error));
        });
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [clip.id, trimStart, trimEnd]);

  // ---- the windows the editor is working on ----
  const previewSegments: ClipSegment[] = useMemo(() => {
    if (isMerge && segments.length > 0) return segments;
    return [{ startSec: trimStart, endSec: trimEnd }];
  }, [isMerge, segments, trimStart, trimEnd]);

  // Creator mode: the kept windows once pause cuts are removed. Playback skips
  // the gaps so the preview runs on the output clock's content.
  const creatorWindows = useMemo(
    () =>
      creator.enabled && !isMerge
        ? windowsFor(trimStart, trimEnd, creator.cuts, creator.speed)
        : [{ startSec: trimStart, endSec: trimEnd }],
    [creator.enabled, creator.cuts, creator.speed, isMerge, trimStart, trimEnd]
  );
  const creatorOutputSec = outputDuration(creatorWindows);

  const safeIndex = Math.min(activeIndex, Math.max(0, previewSegments.length - 1));
  const active = previewSegments[safeIndex] ?? {
    startSec: trimStart,
    endSec: trimEnd,
  };
  const sourceDuration = project.durationSec ?? Math.max(trimEnd, active.endSec, clip.endSec, 0.1);
  const projectOutros = project.outros ?? (project.outro ? [project.outro] : []);
  const selectedOutro = pickProjectOutro(projectOutros, clipOutro.outroId, project.defaultOutroId);
  const outroPlaythrough =
    desk === "mix" && mode === "source" && clipOutro.enabled !== false && Boolean(selectedOutro?.ready);
  const outroPreviewUrl =
    outroPlaythrough && selectedOutro
      ? projectOutroPreviewUrl(project.id, selectedOutro.id, selectedOutro.updatedAt)
      : undefined;
  // The clip's length on the OUTPUT clock — creator cuts shorten it. The mix
  // (bed, hits, the sting hand-off) lives on this clock.
  const clipWindowDur = Math.max(0.1, isMerge ? active.endSec - active.startSec : outputDuration(creatorWindows));
  const outroDur = outroDuration > 0.05 ? outroDuration : (selectedOutro?.durationSec ?? 2.4);
  const playthroughDur = outroPlaythrough ? clipWindowDur + outroDur : clipWindowDur;
  previewStageRef.current = previewStage;
  outroPlaythroughRef.current = outroPlaythrough;

  // ---- effective caption look + captions for the active window ----
  const preset = styles.find((s) => s.id === styleId) ?? styles[0] ?? FALLBACK_STYLE;
  const style = effectiveCaptionStyle(preset, overrides);
  const fontChoices = fonts.length > 0 ? fonts : FALLBACK_FONTS;
  const catalogFont = fontChoices.find((font) => font.family === style.fontFamily);

  // Creator mode: each caption scene resolves to its own look, and the grouper
  // never lets a caption cross a scene boundary.
  const sceneLooks = useMemo(
    () =>
      creator.enabled && !isMerge
        ? (creator.captionScenes ?? []).map((scene) => ({
            scene,
            style: sceneStyleFor(styles, style, scene),
          }))
        : [],
    [creator.enabled, creator.captionScenes, isMerge, styles, style]
  );

  const captions = useMemo(() => {
    if (!words || !captionsOn) return [];
    const duration = Math.max(0.1, active.endSec - active.startSec);
    return buildTimelineCaptions(
      words,
      active.startSec,
      duration,
      clip.peakLine,
      clip.peakSec,
      style.chunkWords,
      captionTextOverrides,
      overrides.peakEmphasis !== false,
      captionWordOverrides,
      sceneLooks.map(({ scene, style: look }) => ({
        id: scene.id,
        startSec: scene.startSec,
        endSec: scene.endSec,
        chunkWords: look.chunkWords,
      }))
    );
  }, [
    words,
    captionsOn,
    active.startSec,
    active.endSec,
    style.chunkWords,
    clip.peakLine,
    clip.peakSec,
    captionTextOverrides,
    captionWordOverrides,
    overrides.peakEmphasis,
    sceneLooks,
  ]);

  const activeCaption = mode === "source" ? captionAt(captions, time - active.startSec) : null;
  const activeCaptionStyle =
    (activeCaption?.sceneId && sceneLooks.find(({ scene }) => scene.id === activeCaption.sceneId)?.style) || style;
  const activeCaptionFont = fontChoices.find((font) => font.family === activeCaptionStyle.fontFamily);
  const spokenIndex = activeCaption ? spokenWordIndex(activeCaption, time) : -1;
  const boundTranscript = useMemo(() => {
    if (!words) return "";
    return applyCaptionWords(words, captionWordOverrides, captionTextOverrides)
      .filter((word) => word.t >= active.startSec - 0.05 && word.t <= active.endSec)
      .map((word) => word.word)
      .join(" ");
  }, [words, captionWordOverrides, captionTextOverrides, active.startSec, active.endSec]);
  const [transcriptDraft, setTranscriptDraft] = useState(boundTranscript);
  const [transcriptFocused, setTranscriptFocused] = useState(false);
  const removedCaptionSections = captionTextOverrides.filter((item) => item.hidden);
  const removedWordSpans = useMemo(() => {
    if (!words) return [];
    const hidden = new Set(captionWordOverrides.filter((item) => item.hidden).map((item) => Math.round(item.t * 1000)));
    const spans: { key: string; text: string; ts: number[] }[] = [];
    let current: WordTiming[] = [];
    const flush = () => {
      if (current.length === 0) return;
      spans.push({
        key: `words:${Math.round(current[0]!.t * 1000)}`,
        text: current.map((word) => word.word).join(" "),
        ts: current.map((word) => word.t),
      });
      current = [];
    };
    for (const word of expandWordTimings(words)) {
      if (hidden.has(Math.round(word.t * 1000))) current.push(word);
      else flush();
    }
    flush();
    return spans;
  }, [words, captionWordOverrides]);

  useEffect(() => {
    if (!transcriptFocused) setTranscriptDraft(boundTranscript);
  }, [boundTranscript, transcriptFocused]);

  useEffect(() => {
    if (!words || migratedWordsFor.current === clip.id) return;
    migratedWordsFor.current = clip.id;
    if ((clip.edit?.captionWordOverrides ?? []).length > 0) return;
    const generated = captionTextOverrides.filter((item) => !item.custom);
    if (generated.length === 0) return;
    const compiled = compileGroupEditsToWords(expandWordTimings(words), generated);
    if (compiled.length === 0) return;
    setCaptionWordOverrides(compiled);
    setCaptionTextOverrides((prev) => prev.filter((item) => item.custom));
  }, [words, clip.id, clip.edit?.captionWordOverrides, captionTextOverrides]);

  // ---- player plumbing ----
  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || video.readyState < 1) return;
    video.currentTime = Math.max(0, seconds);
    setTime(video.currentTime);
  }, []);

  // Keep the playhead inside the active window: switching segment, or moving a
  // handle past the playhead, both land here. Skip while the sting is on screen.
  useEffect(() => {
    if (previewStage === "outro" || handingToOutroRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    const outside = video.currentTime < active.startSec - 0.05 || video.currentTime > active.endSec + 0.05;
    if (outside) seekTo(active.startSec);
  }, [active.startSec, active.endSec, seekTo, previewStage]);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setFrameHeight(box.height);
      setFrameWidth(box.width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) return;
    setTime(video.currentTime);
  }

  function leaveOutroStage() {
    outroVideoRef.current?.pause();
    setPreviewStage("clip");
    setJoinFlash(null);
    setOutroTime(0);
    handingToOutroRef.current = false;
  }

  beginOutroRef.current = () => {
    const sting = outroVideoRef.current;
    const clipEl = videoRef.current;
    if (!sting) {
      clipEl?.pause();
      return;
    }
    handingToOutroRef.current = true;
    clipEl?.pause();
    setPreviewStage("outro");
    setJoinFlash(null);
    setOutroTime(0);
    try {
      sting.currentTime = 0;
    } catch {
      /* some engines throw if metadata is not ready */
    }
    void sting.play();
  };

  useEffect(() => {
    if (outroPlaythrough) return;
    if (previewStage === "clip" && joinFlash == null) return;
    outroVideoRef.current?.pause();
    setPreviewStage("clip");
    setJoinFlash(null);
    setOutroTime(0);
    handingToOutroRef.current = false;
  }, [outroPlaythrough, previewStage, joinFlash]);

  function seekPlaythrough(local: number) {
    const clipped = Math.max(0, Math.min(playthroughDur, local));
    if (!outroPlaythrough || clipped < clipWindowDur - 0.02) {
      leaveOutroStage();
      seekTo(isMerge ? active.startSec + Math.min(clipWindowDur, clipped) : outputToSource(creatorWindows, clipped));
      return;
    }
    videoRef.current?.pause();
    setPreviewStage("outro");
    setJoinFlash(null);
    const stingTime = Math.min(outroDur, Math.max(0, clipped - clipWindowDur));
    const sting = outroVideoRef.current;
    if (sting) {
      sting.currentTime = stingTime;
      setOutroTime(stingTime);
    }
  }

  function togglePlay() {
    const video = videoRef.current;
    const sting = outroVideoRef.current;
    if (previewStage === "outro" && sting) {
      if (sting.paused) {
        if (sting.ended || sting.currentTime >= (sting.duration || outroDur) - 0.05) {
          leaveOutroStage();
          if (video) {
            video.currentTime = active.startSec;
            void video.play();
          }
          return;
        }
        void sting.play();
      } else {
        sting.pause();
      }
      return;
    }
    if (!video) return;
    if (video.paused) {
      if (video.currentTime < active.startSec || video.currentTime >= active.endSec - 0.02) {
        video.currentTime = active.startSec;
      }
      void video.play();
    } else {
      video.pause();
    }
  }

  function selectSegment(index: number) {
    leaveOutroStage();
    setActiveIndex(index);
    seekTo(previewSegments[index]?.startSec ?? 0);
  }

  function trimSnapshot(label: TrimHistoryEntry["label"]): TrimHistoryEntry {
    return {
      trimStart,
      trimEnd,
      segments: segments.map((segment) => ({ ...segment })),
      activeIndex: safeIndex,
      label,
    };
  }

  function rememberTrimAction(label: TrimHistoryEntry["label"]) {
    const before = trimSnapshot(label);
    setTrimPast((previous) => [...previous.slice(-29), before]);
    setTrimFuture([]);
  }

  function clearTrimHistory() {
    setTrimPast([]);
    setTrimFuture([]);
  }

  function markIn() {
    const next = isMerge ? Math.min(time, active.endSec - 0.2) : Math.max(0, Math.min(time, trimEnd - 0.2));
    if (Math.abs(next - active.startSec) < 0.001) return;
    rememberTrimAction("Mark in");
    if (isMerge) updateSegment(safeIndex, { startSec: Math.min(time, active.endSec - 0.2) }, true);
    else setTrimStart(Math.max(0, Math.min(time, trimEnd - 0.2)));
  }

  function markOut() {
    const next = isMerge
      ? Math.max(time, active.startSec + 0.2)
      : Math.min(sourceDuration, Math.max(time, trimStart + 0.2));
    if (Math.abs(next - active.endSec) < 0.001) return;
    rememberTrimAction("Mark out");
    if (isMerge) updateSegment(safeIndex, { endSec: Math.max(time, active.startSec + 0.2) }, true);
    else setTrimEnd(Math.min(sourceDuration, Math.max(time, trimStart + 0.2)));
  }

  function applyTrimSnapshot(snapshot: TrimHistoryEntry) {
    videoRef.current?.pause();
    setTrimStart(snapshot.trimStart);
    setTrimEnd(snapshot.trimEnd);
    setSegments(snapshot.segments.map((segment) => ({ ...segment })));
    const nextIndex = Math.min(snapshot.activeIndex, Math.max(0, snapshot.segments.length - 1));
    setActiveIndex(nextIndex);
    const nextStart = isMerge ? (snapshot.segments[nextIndex]?.startSec ?? snapshot.trimStart) : snapshot.trimStart;
    seekTo(nextStart);
  }

  function undoTrimAction() {
    const previous = trimPast[trimPast.length - 1];
    if (!previous) return;
    setTrimPast((history) => history.slice(0, -1));
    setTrimFuture((history) => [...history.slice(-29), trimSnapshot(previous.label)]);
    applyTrimSnapshot(previous);
  }

  function redoTrimAction() {
    const next = trimFuture[trimFuture.length - 1];
    if (!next) return;
    setTrimFuture((history) => history.slice(0, -1));
    setTrimPast((history) => [...history.slice(-29), trimSnapshot(next.label)]);
    applyTrimSnapshot(next);
  }

  function updateSegment(index: number, patch: Partial<ClipSegment>, fromMark = false) {
    if (!fromMark) clearTrimHistory();
    setSegments((prev) => prev.map((segment, i) => (i === index ? { ...segment, ...patch } : segment)));
  }

  function moveSegment(index: number, delta: number) {
    clearTrimHistory();
    setSegments((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      if (index === safeIndex) setActiveIndex(target);
      return next;
    });
  }

  function removeSegment(index: number) {
    clearTrimHistory();
    setSegments((prev) => prev.filter((_, i) => i !== index));
    setActiveIndex((current) => Math.max(0, Math.min(current, segments.length - 2)));
  }

  // ---- save / render ----
  /**
   * Everything that can be edited, as a comparable string. Autosave triggers on
   * a change to this, so it must include every field that reaches the server.
   */
  function snapshot() {
    return JSON.stringify({
      title,
      styleId,
      overrides,
      captionsOn,
      reframeMode,
      trimStart,
      trimEnd,
      segments,
      cleanup,
      captionTextOverrides,
      captionWordOverrides,
      editTemplateId,
      videoEffects,
      soundtrack,
      clipOutro,
      creator,
    });
  }
  const [saved, setSaved] = useState(snapshot);
  const snap = snapshot();
  const dirty = snap !== saved;

  function buildDraft(): ClipEditDraft {
    const edit: ClipEdit = {
      reframeMode,
      captionsOn,
      captionStyleId: styleId,
      // Always sent, even when empty. An omitted key means "no change", so
      // omitting this would make the Reset button unable to clear the overrides.
      captionOverrides: overrides,
      captionTextOverrides,
      captionWordOverrides,
      editTemplateId,
      videoEffects,
      soundtrack: soundtrackPayload(soundtrack),
      outro: {
        enabled: clipOutro.enabled !== false,
        transitionId: clipOutro.transitionId ?? "smash",
        outroId: clipOutro.outroId ?? selectedOutro?.id,
      },
      // Same rule: an empty array is an explicit reset of the cleanup regions.
      cleanup,
      // Always sent; the server drops a disabled, empty plan.
      creator,
    };
    // A merge's window comes from its segments; per-clip trims are meaningless.
    if (!isMerge) {
      edit.trimStartSec = round3(trimStart);
      edit.trimEndSec = round3(trimEnd);
    }
    const draft: ClipEditDraft = { title: title.trim() || undefined, edit };
    if (isMerge) draft.segments = segments;
    return draft;
  }

  // The debounce reads these through a ref so the effect does not re-arm on
  // every parent render (the poller re-renders App every few seconds, and its
  // inline callbacks are new each time).
  const persistRef = useRef({ buildDraft, snapshot, onSave });
  useEffect(() => {
    persistRef.current = { buildDraft, snapshot, onSave };
  });

  async function saveNow(): Promise<void> {
    setBusy("save");
    setActionError(null);
    try {
      await onSave(buildDraft());
      setSaved(snapshot());
    } catch (error: unknown) {
      setActionError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function renderNow(): Promise<void> {
    setBusy("render");
    setActionError(null);
    try {
      // onRender persists the spec first, then queues the encode.
      await onRender(buildDraft());
      setSaved(snapshot());
    } catch (error: unknown) {
      setActionError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function openMixDesk(): Promise<void> {
    setBusy("save");
    setActionError(null);
    try {
      await onSave(buildDraft());
      setSaved(snapshot());
      setDesk("mix");
    } catch (error: unknown) {
      setActionError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Autosave. Saving is a metadata write — no render, no storage churn — so it
   * is cheap enough to do on a short debounce, and it means a refresh or a
   * closed tab never costs the user their edits.
   */
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        setAutosaving(true);
        // Capture what is actually being sent, in one tick, BEFORE awaiting.
        // Recording the live state after the round-trip would mark a change made
        // mid-save as saved when the server never received it — and since the
        // effect only re-arms on a dirty transition, that edit would be silently
        // lost until the next keystroke.
        const { onSave, buildDraft, snapshot } = persistRef.current;
        const draft = buildDraft();
        const sent = snapshot();
        try {
          await onSave(draft);
          setSaved(sent);
          setActionError(null);
        } catch (error: unknown) {
          setActionError(messageOf(error));
        } finally {
          setAutosaving(false);
        }
      })();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, snap]);

  useEffect(() => {
    if (desk !== "create" || audioLibrary.length > 0) return;
    void refreshAudioLibrary();
  }, [desk, project.id, audioLibrary.length]);

  useEffect(() => {
    if (effectsRegistry.length > 0 || (desk !== "create" && !creator.effects?.length)) return;
    api
      .listEffects()
      .then(setEffectsRegistry)
      .catch(() => undefined);
  }, [desk, creator.effects?.length, effectsRegistry.length]);
  const effectLabels = useMemo(() => new Map(effectsRegistry.map((item) => [item.id, item.label])), [effectsRegistry]);

  const refreshMediaLibrary = useCallback(
    () =>
      api
        .listMediaLibrary()
        .then((result) => {
          setMediaLibrary(result.assets);
          setStockSources(result.stock);
        })
        .catch(() => undefined),
    []
  );
  useEffect(() => {
    if (desk !== "create" && !creator.cutaways?.length) return;
    if (mediaLibrary.length === 0) void refreshMediaLibrary();
    if (transitions.length === 0) api.listTransitions().then(setTransitions).catch(() => undefined);
  }, [desk, creator.cutaways?.length, mediaLibrary.length, transitions.length, refreshMediaLibrary]);
  const mediaLabels = useMemo(() => new Map(mediaLibrary.map((item) => [item.id, item.label])), [mediaLibrary]);

  function refreshAudioLibrary(): Promise<void> {
    return api
      .listAudioLibrary(project.id)
      .then((result) => setAudioLibrary([...result.builtin, ...result.custom]))
      .catch(() => undefined);
  }

  async function uploadAudio(file: File, kind: "music" | "sfx"): Promise<void> {
    await api.uploadProjectAudio(project.id, file, kind);
    await refreshAudioLibrary();
  }

  // Behind-titles need the person matte. Ask the server for it (cached per
  // window + spans) whenever the behind spans change, debounced so a drag
  // does not start a matting job per pixel.
  const behindKey = useMemo(() => {
    if (!creator.enabled || isMerge) return "";
    const spans = (creator.titles ?? [])
      .filter((title) => title.depth === "behind")
      .map((title) => `${Math.round(title.startSec * 10)}-${Math.round(title.endSec * 10)}`)
      .sort();
    return spans.length > 0 ? `${Math.round(trimStart * 1000)}:${Math.round(trimEnd * 1000)}:${spans.join(",")}` : "";
  }, [creator.enabled, creator.titles, isMerge, trimStart, trimEnd]);

  useEffect(() => {
    if (!behindKey || !project.mediaReady) {
      setMatte(null);
      setMatteNote(null);
      return;
    }
    if (matte?.key === behindKey) return;
    let cancelled = false;
    setMatteNote("building the cutout…");
    const timer = window.setTimeout(() => {
      api
        .buildClipMatte(clip.id)
        .then((info) => {
          if (cancelled) return;
          if (info.ready && info.originSec != null && info.width && info.height) {
            setMatte({
              key: behindKey,
              originSec: info.originSec,
              width: info.width,
              height: info.height,
            });
            setMatteNote(null);
          } else {
            setMatte(null);
            setMatteNote(info.reason ?? "no cutout yet — the title previews in front");
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setMatteNote(messageOf(error));
        });
    }, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [behindKey, project.mediaReady, clip.id, matte?.key]);

  function updateBeatSpan(lane: BeatLane, id: string, span: { startSec: number; endSec: number }) {
    if (lane === "sfx") {
      setSoundtrack((prev) => ({
        ...prev,
        sfx: (prev.sfx ?? []).map((hit) => (hit.id === id ? { ...hit, atSec: span.startSec } : hit)),
      }));
      return;
    }
    setCreator((prev) => {
      const patchSpan = <T extends { id: string; startSec: number; endSec: number }>(items: T[] | undefined) =>
        (items ?? []).map((item) => (item.id === id ? { ...item, ...span } : item));
      if (lane === "cuts") return { ...prev, cuts: patchSpan(prev.cuts) };
      if (lane === "camera")
        return {
          ...prev,
          camera: { ...prev.camera, moves: patchSpan(prev.camera?.moves) },
        };
      if (lane === "speed") return { ...prev, speed: patchSpan(prev.speed) };
      if (lane === "fx") return { ...prev, effects: patchSpan(prev.effects) };
      if (lane === "cutaways") return { ...prev, cutaways: patchSpan(prev.cutaways) };
      if (lane === "captions") return { ...prev, captionScenes: patchSpan(prev.captionScenes) };
      return { ...prev, titles: patchSpan(prev.titles) };
    });
  }

  /**
   * A file dropped on the B-roll lane: into the media library, then a cutaway
   * at the drop point. Placed through a ref after the upload so the plan it
   * adds to is the one on screen then, not the one from before the await.
   */
  async function dropMediaOnLane(file: File, sourceSec: number): Promise<void> {
    if (!/^(image|video)\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|mp4|mov|m4v|webm|mkv)$/i.test(file.name)) {
      setActionError("Drop an image or a video on the B-roll lane.");
      return;
    }
    setActionError(null);
    try {
      const asset = await api.uploadMedia(file);
      await refreshMediaLibrary();
      addBeatRef.current("cutaways", undefined, asset.id, sourceSec);
    } catch (error: unknown) {
      setActionError(messageOf(error));
    }
  }

  /** A lane's "+": the default beat at the playhead, selected for editing. Turns the plan on. */
  function addBeatAtPlayhead(lane: BeatLane, sfx?: string, assetId?: string, at = time) {
    const plan = enablePlan(creator, resolvedEffects, trimStart, trimEnd, clip.peakSec);
    // A cutaway needs a picture: the newest in the library unless one was chosen.
    const cutawayAsset = assetId ?? mediaLibrary[0]?.id;
    if (lane === "cutaways" && !cutawayAsset) {
      setActionError("Upload a still or video, or pick a stock shot, before placing a cutaway.");
      return;
    }
    const next = addBeat(
      lane,
      { plan, sfx: soundtrack.sfx ?? [] },
      {
        at,
        trimStart,
        trimEnd,
        windows: creatorWindows,
        sfx,
        effectId: lastEffect(),
        assetId: cutawayAsset,
        // A new Text beat starts with the words being spoken there.
        text: lane === "titles" ? spokenTextBetween(at, at + 2.2) : undefined,
      }
    );
    if (!next) return;
    if (next.plan !== creator) setCreator(next.plan);
    if (lane === "sfx") {
      setSoundtrack((prev) => ({ ...prev, sfx: next.sfx }));
      if (sfx) rememberSfx(sfx);
    }
    setBeatSelection({ lane, id: next.id });
  }

  // The latest addBeatAtPlayhead, for work that resumes after an await.
  const addBeatRef = useRef(addBeatAtPlayhead);
  useEffect(() => {
    addBeatRef.current = addBeatAtPlayhead;
  });

  function removeBeatById(lane: BeatLane, id: string) {
    const next = removeBeat(lane, id, {
      plan: creator,
      sfx: soundtrack.sfx ?? [],
    });
    if (lane === "sfx") setSoundtrack((prev) => ({ ...prev, sfx: next.sfx }));
    else setCreator(next.plan);
    setBeatSelection((prev) => (prev?.id === id ? null : prev));
  }

  /**
   * The Director writes the plan on the server from the STORED edit, so the
   * draft is flushed first; its answer then replaces the local plan and hits.
   */
  /** Render a span exactly, with the draft flushed first so the burn sees what the desk shows. */
  async function previewSpan(startSec: number, endSec: number): Promise<{ url: string; durationSec: number }> {
    if (dirty) {
      await onSave(buildDraft());
      setSaved(snapshot());
    }
    const result = await api.previewClipSpan(clip.id, startSec, endSec);
    return { url: result.url, durationSec: result.durationSec };
  }

  async function directClip(input: DirectInput): Promise<{ warnings: string[]; pending: string[] }> {
    await onSave(buildDraft());
    setSaved(snapshot());
    const result = await api.directClip(clip.id, input);
    const next = result.clip.edit?.creator;
    if (next) setCreator(next);
    setSoundtrack((prev) => ({
      ...prev,
      sfx: result.clip.edit?.soundtrack?.sfx ?? [],
      beds: result.clip.edit?.soundtrack?.beds ?? [],
    }));
    if (result.sense) setHarness((prev) => ({ ...prev, sense: result.sense }));
    setBeatSelection(null);
    onClipUpdated?.(result.clip);
    // A cutaway the Director found on stock or made to order is a new library asset; a bed it made, a new track.
    if (next?.cutaways?.some((cutaway) => !mediaLibrary.some((asset) => asset.id === cutaway.assetId))) {
      void refreshMediaLibrary();
    }
    if ((result.clip.edit?.soundtrack?.beds ?? []).some((bed) => !audioLibrary.some((asset) => asset.id === bed.assetId))) {
      void refreshAudioLibrary();
    }
    return { warnings: result.warnings ?? [], pending: result.pending ?? [] };
  }

  async function directorFeedback(verdict: "up" | "down", note?: string): Promise<void> {
    await api.directorFeedback(clip.id, { verdict, note });
  }

  async function senseNow(): Promise<void> {
    const sense = await api.senseClip(clip.id, true);
    setHarness((prev) => ({ ...prev, sense }));
  }

  async function reviewNow(): Promise<void> {
    const review = await api.reviewClip(clip.id);
    setHarness((prev) => ({ ...prev, review }));
  }

  async function prepareSource(): Promise<void> {
    setPreparingSource(true);
    setActionError(null);
    try {
      await api.ensureProjectMedia(project.id);
    } catch (error: unknown) {
      setActionError(messageOf(error));
      setPreparingSource(false);
    }
  }

  // ---- page behaviour: shortcuts only ----
  // This is a page, not a dialog, so there is no focus trap and no inert
  // background. The listener is bound once and reads handlers through a ref, so
  // it never closes over a stale draft.
  const actionsRef = useRef({
    saveNow,
    renderNow,
    onBack,
    markIn,
    markOut,
    undoTrimAction,
    redoTrimAction,
    desk,
  });
  useEffect(() => {
    actionsRef.current = {
      saveNow,
      renderNow,
      onBack,
      markIn,
      markOut,
      undoTrimAction,
      redoTrimAction,
      desk,
    };
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const actions = actionsRef.current;
      // Never steal a key while the user is typing or dragging a slider.
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void actions.saveNow();
        return;
      }
      if (typing) return;
      if (actions.desk === "mix") return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) actions.redoTrimAction();
        else actions.undoTrimAction();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        actions.redoTrimAction();
      } else if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        actions.markIn();
      } else if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        actions.markOut();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const renderProgress = Math.round(clip.renderProgress ?? 0);
  const rendered = clip.status === "rendered" && Boolean(clip.outputUrl);
  const videoSource =
    mode === "output" && clip.outputUrl
      ? clipDownloadUrl(clip.id, { bust: clip.renderedAt })
      : projectMediaUrl(project.id);
  const mediaStatus = project.mediaStatus ?? (project.mediaReady ? "ready" : "absent");
  const sourceReady = project.mediaReady;
  const sourceFetching = mediaStatus === "fetching" || preparingSource;
  const fetchPercent = Math.round(project.mediaProgress ?? 0);

  useEffect(() => {
    if (sourceReady) {
      setPreparingSource(false);
      setMode("source");
    }
  }, [sourceReady]);

  useEffect(() => {
    if (mediaStatus === "fetching") setPreparingSource(true);
    if (mediaStatus === "absent" && project.mediaError) setPreparingSource(false);
  }, [mediaStatus, project.mediaError]);

  useEffect(() => {
    if (!clip.reframeTrack) return;
    setPreviewTrack((prev) => preferCoveringTrack(prev, clip.reframeTrack, trimStart, trimEnd));
  }, [clip.reframeTrack, trimStart, trimEnd]);

  const trackCoversTrim =
    previewTrack?.originSec != null &&
    previewTrack.untilSec != null &&
    trimStart >= previewTrack.originSec - 0.05 &&
    trimEnd <= previewTrack.untilSec + 0.05;

  useEffect(() => {
    if (isMerge || !sourceReady || reframeMode !== "smart") {
      setAnalysingFrame(false);
      return;
    }
    if (trackCoversTrim) {
      setAnalysingFrame(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setAnalysingFrame(true);
      api
        .previewClipReframe(clip.id, {
          startSec: round3(Math.min(trimStart, clip.startSec)),
          endSec: round3(Math.max(trimEnd, clip.endSec)),
          mode: "smart",
        })
        .then((updated) => {
          if (!cancelled && updated.reframeTrack) {
            setPreviewTrack((prev) => preferCoveringTrack(prev, updated.reframeTrack, trimStart, trimEnd));
          }
        })
        .catch(() => {
          // Preview analysis is best-effort: the next render still frames the clip.
        })
        .finally(() => {
          if (!cancelled) setAnalysingFrame(false);
        });
    }, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isMerge, sourceReady, reframeMode, trackCoversTrim, trimStart, trimEnd, clip.id, clip.startSec, clip.endSec]);

  const rawTrack = reframeMode === "smart" ? previewTrack : undefined;
  const tightness = isMerge ? 0 : followTightnessX(creator);
  // A following camera rides the smoothed face path, as the burn does — by the plan's response —
  // and holds lock it off on top. Smoothing is memoised apart: it is the slow half.
  const following = !isMerge && followTightness(creator) > 0;
  const sigma = followSigma(creator);
  const smoothed = useMemo(
    () => (rawTrack && following ? smoothedTrack(rawTrack, sigma) : rawTrack),
    [rawTrack, following, sigma]
  );
  const holds = isMerge ? [] : holdSpans(creator);
  const holdsKey = holds.map((hold) => `${hold.startSec}-${hold.endSec}`).join(",");
  const track = useMemo(
    () => (smoothed && holdsKey ? heldTrack(smoothed, holds) : smoothed),
    // `holds` is keyed by value: a fresh array each render must not recompute.
    [smoothed, holdsKey]
  );
  const travel = useMemo(() => headTravel(rawTrack), [rawTrack]);
  // Crop times are on the analysis origin, not the saved trim. Using the saved
  // in-point here is what brought the cut-flash back after Save.
  const cropOrigin = track?.originSec ?? trimStart;
  // Lead room and a move's pan sit on top of the track, as in the burn.
  const lead = isMerge ? 0 : followLead(creator);
  const framingAt = useCallback(
    (sourceSec: number): Framing => ({ lead, pan: isMerge ? { x: 0, y: 0 } : panPxAt(creator, track, sourceSec) }),
    [lead, isMerge, creator, track]
  );
  const transform = cropTransformFor(
    track,
    time - cropOrigin,
    sourceSize.w,
    sourceSize.h,
    frameWidth,
    frameHeight,
    tightness,
    framingAt(time)
  );
  // WYSIWYG only when the crop is showing: in "fit" the whole source is visible,
  // so a caption at the burned-in position would sit in the wrong place.
  const showCaptionsInFrame = mode === "source" && fitMode === "crop" && previewStage === "clip";
  const cropPreview = mode === "source" && fitMode === "crop" && frameWidth > 0;
  const sceneCuts = useMemo(
    () => (reframeMode === "smart" ? sceneCutsInWindow(track, trimStart, trimEnd) : []),
    [reframeMode, track, trimStart, trimEnd]
  );
  const cutChecks = useMemo(
    () => (reframeMode === "smart" ? checkSceneCuts(track, trimStart, trimEnd, sourceSize.w, sourceSize.h) : []),
    [reframeMode, track, trimStart, trimEnd, sourceSize.w, sourceSize.h]
  );
  const cutFlashes = cutChecks.filter((item) => item.status === "flash").length;
  const resolvedEffects = resolveVideoEffects(videoEffects);
  const sfxLabelMap = useMemo(() => new Map(audioLibrary.map((asset) => [asset.id, asset.label])), [audioLibrary]);
  const sfxAssets = useMemo(() => audioLibrary.filter((asset) => asset.kind === "sfx"), [audioLibrary]);
  // On the output clock: with creator cuts active, the seconds after a cut
  // are earlier than `time − trimStart` says (hits and the bed live there).
  const localPreviewTime = Math.max(0, isMerge ? time - active.startSec : sourceToOutput(creatorWindows, time));
  const playheadLocal = previewStage === "outro" ? clipWindowDur + outroTime : localPreviewTime;
  // Where the voice is on the output clock, so the beds dip in the preview
  // where the burn's compressor will.
  const speech = useMemo(
    () =>
      speechSpans(
        (words ?? [])
          .filter((word) => word.t >= active.startSec && word.t < active.endSec)
          .map((word) => (isMerge ? word.t - active.startSec : sourceToOutput(creatorWindows, word.t)))
      ),
    [words, active.startSec, active.endSec, isMerge, creatorWindows]
  );
  // Hear the mix on any desk that shows the source; the Sound desk's controls
  // and creator mode's SFX lane both edit the same soundtrack.
  useLiveSoundtrack({
    enabled: (desk === "mix" || desk === "create") && mode === "source",
    playing,
    voiceDucked,
    localTime: playheadLocal,
    clipEndSec: clipWindowDur,
    outroSec: outroPlaythrough ? outroDur : 0,
    soundtrack,
    speech,
    videoRef,
  });
  const peakAt = clip.peakSec - active.startSec;
  // Creator mode's camera replaces the clip-wide motion, in the preview as in
  // the render. The transform origin IS the anchor, so a face punch zooms
  // toward the face here exactly as the burn does.
  // Creator mode's camera is painted into the canvas (crop → zoom, exactly the
  // burn's order, so titles are not zoomed with the picture); the clip-wide
  // motion keeps its CSS scale.
  const creatorCamera = creator.enabled && !isMerge;
  const previewZoom = creatorCamera ? 1 : motionZoom(resolvedEffects, localPreviewTime, peakAt);
  const looksCss = creatorCamera ? cssFilterFor(activeEffectsAt(creator, effectsRegistry, time)) : "";
  const picturePreviewStyle = {
    filter: `${previewFilter(resolvedEffects)} ${looksCss}`.replace(/\bnone\b ?/, "").trim() || "none",
    transform: `scale(${previewZoom})`,
    transformOrigin: "center",
  };

  const creatorPaint = creator.enabled && !isMerge;
  // Text beats draw with the caption font catalogue; unknown families fall back like the burn's.
  const titleFontFor = useCallback(
    (family: string) => {
      const font = fontChoices.find((item) => item.family === family);
      return font
        ? { stack: font.stack, weight: font.weight, emScale: font.emScale, baseline: font.baseline }
        : { stack: `"${family}", Impact, sans-serif`, weight: 400 };
    },
    [fontChoices]
  );
  // The Create desk's selection, when it is something placed on the frame.
  const selectedText =
    desk === "create" && beatSelection?.lane === "titles" ? creator.titles?.find((item) => item.id === beatSelection.id) : undefined;
  const placingScene =
    desk === "create" && creator.enabled && beatSelection?.lane === "captions"
      ? creator.captionScenes?.find((scene) => scene.id === beatSelection.id)
      : undefined;
  /** Transcript text spoken inside [from, to] source seconds, as the captions read (edits included). */
  const spokenTextBetween = useCallback(
    (from: number, to: number) =>
      captions
        .filter((caption) => caption.sourceEndSec > from + 0.05 && caption.sourceStartSec < to - 0.05)
        .map((caption) => caption.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    [captions]
  );
  const paintPreview = useCallback(
    (mediaTime?: number) => {
      const video = videoRef.current;
      const canvas = previewCanvasRef.current;
      if (!cropPreview || !video || !canvas) return;
      const sourceSec = mediaTime ?? video.currentTime;
      const matteVideo = matteRef.current;
      // Keep the matte's clock on the source's; two elements drift, and the
      // cutout only has to be right inside the title spans.
      if (matteVideo && matte && matteVideo.readyState >= 1) {
        const want = sourceSec - matte.originSec;
        if (Math.abs(matteVideo.currentTime - want) > 0.08 && !matteVideo.seeking) matteVideo.currentTime = want;
      }
      const looks = creatorPaint ? activeEffectsAt(creator, effectsRegistry, sourceSec) : [];
      paintCropPreview(
        video,
        canvas,
        track,
        sourceTimeOnTrack(track, sourceSec, cropOrigin),
        sourceSize.w,
        sourceSize.h,
        tightness,
        creatorPaint
          ? {
              camera: cameraStateAt(creator, track, sourceSec),
              framing: framingAt(sourceSec),
              titles: creator.titles,
              sourceSec,
              matte:
                matteVideo && matte
                  ? {
                      video: matteVideo,
                      width: matte.width,
                      height: matte.height,
                    }
                  : null,
              fontFor: titleFontFor,
            }
          : {}
      );
      // Looks on top of the crop, on the kept window's clock (the burn's `t`).
      if (looks.length > 0) {
        const index = windowIndexAt(creatorWindows, sourceSec);
        const windowStart = index >= 0 ? creatorWindows[index]!.startSec : trimStart;
        paintFxLayers(canvas, looks, sourceSec - windowStart, (span) => ({
          a: Math.max(0, span.startSec - windowStart),
          b: span.endSec - windowStart,
        }));
      }
    },
    [
      cropPreview,
      track,
      cropOrigin,
      sourceSize.w,
      sourceSize.h,
      tightness,
      creatorPaint,
      creator,
      matte,
      fontChoices,
      framingAt,
      effectsRegistry,
      creatorWindows,
      trimStart,
    ]
  );

  // Paint only when the browser has presented a decoded video frame. An rAF can
  // observe an advanced currentTime while drawImage still sees the previous
  // decoded frame, pairing the incoming crop with the outgoing shot for one
  // paint — a visible flash at scene boundaries.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let stopped = false;
    let frameCallback = 0;
    let raf = 0;

    const present = (mediaTime: number) => {
      // While a freeze holds the picture, the clock is the freeze timer's.
      if (freezeRef.current) return;
      setTime(mediaTime);
      paintPreview(mediaTime);
      if (!video.paused && mediaTime >= active.endSec - 0.03) {
        const lastPart = !isMerge || safeIndex >= previewSegments.length - 1;
        if (lastPart && outroPlaythroughRef.current) {
          beginOutroRef.current();
        } else if (lastPart) {
          video.pause();
        } else {
          setActiveIndex(safeIndex + 1);
        }
      }
    };

    if (typeof video.requestVideoFrameCallback === "function") {
      const tick: VideoFrameRequestCallback = (_now, metadata) => {
        present(metadata.mediaTime);
        // Leave one callback pending while paused too: seeking/scrubbing then
        // paints the newly decoded frame, never the old frame at a new crop.
        if (!stopped) frameCallback = video.requestVideoFrameCallback(tick);
      };
      frameCallback = video.requestVideoFrameCallback(tick);
    } else if (playing) {
      const tick = () => {
        present(video.currentTime);
        if (!stopped && !video.paused) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    return () => {
      stopped = true;
      if (frameCallback) video.cancelVideoFrameCallback(frameCallback);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [playing, active.endSec, isMerge, safeIndex, previewSegments.length, paintPreview]);

  // Pause cuts: while playing, jump the decoder over each removed span. This
  // runs on a timer rather than the frame callback (a heavy 4K source presents
  // frames sparsely at the start of playback) or rAF (frozen in a background
  // tab): the skip has to land on the clock, not on the next painted picture.
  //
  // Speed spans ride the same timer: the decoder's playbackRate follows the
  // window's rate, and a freeze parks the decoder (at the slowest rate the
  // browser allows, so it never pauses) while this timer runs the clock 1:1
  // on the held frame, as the burn's freezeframe does.
  const retimed = creatorWindows.some((window) => (window.rate ?? 1) !== 1);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!playing || (creatorWindows.length <= 1 && !retimed)) {
      freezeRef.current = null;
      video.playbackRate = 1;
      setVoiceDucked(false);
      return;
    }
    const tick = () => {
      if (video.paused || video.seeking) return;
      const frozen = freezeRef.current;
      if (frozen) {
        const elapsed = (performance.now() - frozen.enteredAt) / 1000;
        if (elapsed >= frozen.endSec - frozen.startSec) {
          freezeRef.current = null;
          video.currentTime = Math.min(active.endSec - 0.02, frozen.endSec + 0.001);
          video.playbackRate = 1;
        } else {
          setTime(frozen.startSec + elapsed);
        }
        return;
      }
      const now = video.currentTime;
      const kept = nextKeptTime(creatorWindows, now);
      if (kept > now + 0.02 && kept < active.endSec - 0.03) {
        video.currentTime = kept;
        return;
      }
      const index = windowIndexAt(creatorWindows, now);
      const window_ = index >= 0 ? creatorWindows[index]! : undefined;
      const rate = window_?.rate ?? 1;
      setVoiceDucked(rate < 1);
      if (window_ && rate === 0) {
        freezeRef.current = { startSec: window_.startSec, endSec: window_.endSec, enteredAt: performance.now() };
        video.playbackRate = MIN_BROWSER_RATE;
        paintPreview(window_.startSec);
        return;
      }
      const wanted = Math.max(MIN_BROWSER_RATE, Math.min(16, rate));
      if (Math.abs(video.playbackRate - wanted) > 1e-3) video.playbackRate = wanted;
    };
    const timer = window.setInterval(tick, 33);
    return () => {
      window.clearInterval(timer);
      freezeRef.current = null;
      video.playbackRate = 1;
      setVoiceDucked(false);
    };
  }, [playing, creatorWindows, retimed, active.endSec, paintPreview]);

  useEffect(() => {
    if (playing) return;
    const video = videoRef.current;
    // requestVideoFrameCallback owns paints during a seek; drawing here would
    // combine the new currentTime/crop with the previously decoded picture.
    if (video?.seeking && typeof video.requestVideoFrameCallback === "function") return;
    paintPreview();
  }, [playing, time, paintPreview, frameWidth, frameHeight]);

  function addCleanupRegion(rect: { x: number; y: number; w: number; h: number }) {
    if (cleanup.length >= MAX_CLEANUP_REGIONS) return;
    setCleanup((prev) => [
      ...prev,
      {
        id: `r${Date.now().toString(36)}${prev.length}`,
        ...rect,
        // Default to the whole clip window: a channel logo is usually present
        // throughout, and the span can be narrowed per region below.
        start: round3(active.startSec),
        end: round3(active.endSec),
      },
    ]);
  }

  function updateCleanupRegion(id: string, patch: Partial<CleanupRegion>) {
    setCleanup((prev) => prev.map((region) => (region.id === id ? { ...region, ...patch } : region)));
  }

  function mergeWordPatches(patch: CaptionWordOverride[]) {
    setCaptionWordOverrides((prev) => {
      const map = new Map(prev.map((item) => [Math.round(item.t * 1000), item]));
      for (const item of patch) map.set(Math.round(item.t * 1000), item);
      return [...map.values()].sort((a, b) => a.t - b.t);
    });
  }

  function dropGeneratedGroupEdit(startSec: number) {
    setCaptionTextOverrides((prev) =>
      prev.filter((item) => item.custom || Math.round(item.startSec * 1000) !== Math.round(startSec * 1000))
    );
  }

  function updateCaptionSection(caption: (typeof captions)[number], patch: Partial<CaptionTextOverride>) {
    if (!caption.custom) {
      if (patch.hidden) {
        mergeWordPatches(caption.words.map((word) => ({ t: word.t, hidden: true })));
        dropGeneratedGroupEdit(caption.sourceStartSec);
        return;
      }
      if (patch.text !== undefined) {
        mergeWordPatches(assignTokensToWords(caption.words, patch.text.trim().split(/\s+/).filter(Boolean)));
        dropGeneratedGroupEdit(caption.sourceStartSec);
      }
      return;
    }
    setCaptionTextOverrides((prev) => {
      const matches = (item: CaptionTextOverride) => Boolean(item.custom && `custom:${item.id}` === caption.editId);
      const existing = prev.find(matches);
      const base: CaptionTextOverride = {
        id: caption.editId.replace(/^custom:/, ""),
        custom: true,
        startSec: round3(caption.sourceStartSec),
        endSec: round3(caption.sourceEndSec),
        text: caption.text,
      };
      const next = prev.filter((item) => !matches(item));
      next.push({ ...base, ...existing, ...patch });
      return next.sort((a, b) => (a.displayStartSec ?? a.startSec) - (b.displayStartSec ?? b.startSec));
    });
  }

  function resetCaptionSection(caption: (typeof captions)[number]) {
    if (!caption.custom) {
      const drop = new Set(caption.words.map((word) => Math.round(word.t * 1000)));
      setCaptionWordOverrides((prev) => prev.filter((item) => !drop.has(Math.round(item.t * 1000))));
      dropGeneratedGroupEdit(caption.sourceStartSec);
      return;
    }
    setCaptionTextOverrides((prev) => prev.filter((item) => `custom:${item.id}` !== caption.editId));
  }

  function commitTranscript() {
    if (!words) return;
    const source = expandWordTimings(words).filter(
      (word) => word.t >= active.startSec - 0.05 && word.t <= active.endSec
    );
    const next = bindTranscriptToTimings(source, transcriptDraft);
    setCaptionWordOverrides((prev) => {
      const kept = prev.filter((item) => item.t < active.startSec - 0.05 || item.t > active.endSec + 0.05);
      const map = new Map(kept.map((item) => [Math.round(item.t * 1000), item]));
      for (const item of next) map.set(Math.round(item.t * 1000), item);
      return [...map.values()].sort((a, b) => a.t - b.t);
    });
    setCaptionTextOverrides((prev) => prev.filter((item) => item.custom));
  }

  function addCaptionSection() {
    const startSec = round3(Math.max(active.startSec, Math.min(time, active.endSec - 0.2)));
    const endSec = round3(Math.min(active.endSec, startSec + 1.5));
    setCaptionTextOverrides((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        custom: true,
        startSec,
        endSec: Math.max(startSec + 0.2, endSec),
        text: "New subtitle",
      },
    ]);
    setCaptionsOn(true);
  }

  async function cleanCaptions() {
    if (cleaningCaptions) return;
    setCleaningCaptions(true);
    setCleanNote(null);
    try {
      const result = await api.cleanClipCaptions(clip.id, {
        startSec: trimStart,
        endSec: trimEnd,
        chunkWords: style.chunkWords,
        listen: project.mediaReady,
      });
      setCaptionTextOverrides(result.overrides);
      setCaptionWordOverrides(result.wordOverrides ?? []);
      setCaptionsOn(true);
      setCleanNote(
        result.changed === 0
          ? "Already clean."
          : `Fixed ${result.changed} line${result.changed === 1 ? "" : "s"}${result.listened ? " · heard the clip" : ""}.`
      );
    } catch (error) {
      setCleanNote(error instanceof Error ? error.message : "Could not clean captions");
    } finally {
      setCleaningCaptions(false);
    }
  }

  function restoreRemovedSection(edit: CaptionTextOverride) {
    setCaptionTextOverrides((prev) => prev.map((item) => (item === edit ? { ...item, hidden: false } : item)));
  }

  function applyEditTemplate(id: string) {
    const template = SHORT_FORM_TEMPLATES.find((item) => item.id === id);
    if (!template) {
      setEditTemplateId("custom");
      return;
    }
    setEditTemplateId(template.id);
    setVideoEffects({ ...template.effects });
    setStyleId(template.captionStyleId);
    setOverrides({});
    setCaptionsOn(template.captionsOn);
    setReframeMode(template.reframeMode);
  }

  function updateVideoEffects(patch: Partial<VideoEffects>) {
    setEditTemplateId("custom");
    setVideoEffects((previous) => ({ ...previous, ...patch }));
  }

  return (
    <div aria-labelledby={titleId} className="flex min-h-0 flex-1 flex-col">
      {/* ---- header ---- */}
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
          {isMerge ? (
            <Merge className="size-3.5 shrink-0 text-accent-2" aria-hidden="true" />
          ) : (
            <Scissors className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
          )}
          <label className="min-w-0 flex-1">
            <span className="sr-only">Clip title</span>
            <input
              id={titleId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={`Clip #${clip.rank}`}
              maxLength={200}
              className="text-body h-11 w-full rounded-md border border-transparent bg-transparent px-2 font-semibold outline-none hover:border-border focus:border-accent sm:h-8"
            />
          </label>
          <span className="text-micro hidden shrink-0 text-muted sm:inline">
            {isMerge ? `merge · ${segments.length} parts` : `#${clip.rank}`}
          </span>
          <ShareCopyButton clip={clip} onUpdated={onClipUpdated} />
          <div className="flex shrink-0 rounded-lg border border-border p-0.5">
            <button
              type="button"
              aria-pressed={desk === "cut"}
              onClick={() => setDesk("cut")}
              className={cn(
                "press text-ui h-9 rounded-md px-3 font-medium sm:h-7",
                desk === "cut" ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"
              )}
            >
              Edit
            </button>
            {!isMerge ? (
              <button
                type="button"
                aria-pressed={desk === "create"}
                onClick={() => setDesk("create")}
                className={cn(
                  "press text-ui inline-flex h-9 items-center gap-1 rounded-md px-3 font-medium sm:h-7",
                  desk === "create" ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"
                )}
              >
                <Wand2 className="size-3" aria-hidden="true" />
                Create
              </button>
            ) : null}
            <button
              type="button"
              aria-pressed={desk === "mix"}
              onClick={() => {
                if (desk === "mix") return;
                void openMixDesk();
              }}
              className={cn(
                "press text-ui h-9 rounded-md px-3 font-medium sm:h-7",
                desk === "mix" ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"
              )}
            >
              Sound
            </button>
          </div>
        </div>
      </header>

      {/* ---- body ---- */}
      <div
        className={cn(
          "studio-scroll grid min-h-0 flex-1 gap-4 overflow-y-auto p-3 lg:overflow-hidden lg:p-5",
          // The create desk: a 9:16 preview needs height, the timeline needs
          // width. The player takes a full-height column sized from the window's
          // height; the rail sits over the timeline beside it.
          desk === "create"
            ? "lg:grid-cols-[minmax(240px,calc((100dvh_-_250px)*0.5625))_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]"
            : "lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)]"
        )}
      >
        {/* player + transport stay on screen; only the right rail scrolls */}
        <section
          className={cn(
            // Fixed-height column on desktop only: stacked on a phone, a clipped
            // zero-minimum item let its grid row collapse the player to nothing.
            "flex min-w-0 shrink-0 flex-col items-center gap-2 lg:h-full lg:min-h-0 lg:overflow-hidden",
            desk === "create" && "lg:row-span-2"
          )}
        >
          {!sourceReady ? (
            <div className="w-full max-w-[340px] shrink-0 rounded-lg border border-warn/40 bg-warn/10 p-3">
              {sourceFetching ? (
                <>
                  <p className="text-meta text-warn">
                    Downloading the source onto this machine so you can trim against the real video.
                  </p>
                  <div
                    className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/30"
                    role="progressbar"
                    aria-valuenow={fetchPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Source download progress"
                  >
                    <div
                      className="h-full origin-left rounded-full bg-warn transition-transform duration-500 ease-out-quart"
                      style={{
                        transform: `scaleX(${Math.max(0.03, fetchPercent / 100)})`,
                      }}
                    />
                  </div>
                  <p className="num mt-2 text-meta font-semibold text-warn">
                    {fetchPercent > 0 ? `${fetchPercent}%` : "Starting download…"}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-meta text-warn">
                    {project.mediaError
                      ? project.mediaError
                      : "The source video isn’t on this machine yet, so trimming can’t be previewed against it. Prepare it once and the window you mark will match what renders."}
                  </p>
                  <button
                    type="button"
                    disabled={preparingSource}
                    onClick={() => void prepareSource()}
                    className="press text-ui mt-2 inline-flex h-11 items-center gap-1.5 rounded-lg border border-warn/50 px-3 font-semibold text-warn hover:bg-warn/10 disabled:opacity-50"
                  >
                    <Download className="size-3.5" aria-hidden="true" />
                    {project.mediaError ? "Retry download" : "Prepare source"}
                  </button>
                </>
              )}
            </div>
          ) : null}
          <div className="preview-stage min-h-0 w-full max-lg:h-[min(52dvh,28rem)] lg:flex-1">
            <div ref={frameRef} className="preview-frame overflow-hidden rounded-xl border border-border bg-black">
              <video
                ref={videoRef}
                src={videoSource}
                playsInline
                preload="metadata"
                tabIndex={-1}
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  if (video.videoWidth && video.videoHeight) {
                    setSourceSize({
                      w: video.videoWidth,
                      h: video.videoHeight,
                    });
                  }
                  if (mode === "source") seekTo(active.startSec);
                  else setTime(0);
                }}
                onSeeked={(event) => {
                  // `seeked` guarantees drawImage sees the requested decoded
                  // frame. Keep this explicit path as well as the frame callback:
                  // some engines throttle callbacks while a paused video is
                  // covered by a canvas.
                  paintPreview(event.currentTarget.currentTime);
                }}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => {
                  setPlaying(true);
                  void matteRef.current?.play().catch(() => undefined);
                }}
                onPause={() => {
                  matteRef.current?.pause();
                  if (handingToOutroRef.current) {
                    handingToOutroRef.current = false;
                    return;
                  }
                  if (previewStageRef.current === "outro") return;
                  setPlaying(false);
                }}
                className="absolute"
                style={
                  cropPreview
                    ? {
                        // Decoder sits behind the opaque canvas. Keeping it
                        // paintable (instead of opacity: 0) ensures Chromium
                        // continues delivering requestVideoFrameCallback events.
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        pointerEvents: "none",
                      }
                    : {
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                      }
                }
              />
              {outroPreviewUrl ? (
                <video
                  ref={outroVideoRef}
                  key={outroPreviewUrl}
                  src={outroPreviewUrl}
                  playsInline
                  preload="auto"
                  className={cn(
                    "absolute inset-0 z-[2] h-full w-full object-cover",
                    previewStage === "outro" ? "opacity-100" : "pointer-events-none opacity-0",
                    joinFlash === "fade" && "transition-opacity duration-300"
                  )}
                  onLoadedMetadata={(event) => {
                    const duration = event.currentTarget.duration;
                    if (duration && Number.isFinite(duration)) setOutroDuration(duration);
                  }}
                  onTimeUpdate={(event) => {
                    if (previewStageRef.current === "outro") setOutroTime(event.currentTarget.currentTime);
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => {
                    if (previewStageRef.current === "outro") setPlaying(false);
                  }}
                  onEnded={() => {
                    setPlaying(false);
                    const duration = outroVideoRef.current?.duration;
                    if (duration && Number.isFinite(duration)) setOutroTime(duration);
                  }}
                />
              ) : null}
              {matte ? (
                <video
                  ref={matteRef}
                  key={matte.key}
                  src={clipMatteUrl(clip.id, matte.key)}
                  muted
                  playsInline
                  preload="auto"
                  tabIndex={-1}
                  aria-hidden="true"
                  // A paint that moved the matte's clock drew the previous frame;
                  // repaint once the sought frame is actually decoded.
                  onSeeked={() => paintPreview()}
                  onLoadedData={() => paintPreview()}
                  className="pointer-events-none absolute h-px w-px opacity-0"
                />
              ) : null}
              {joinFlash === "white" || joinFlash === "black" ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-[3]"
                  style={{
                    background: joinFlash === "white" ? "#fff" : "#000",
                  }}
                />
              ) : null}
              {cropPreview ? (
                <canvas
                  ref={previewCanvasRef}
                  width={Math.max(
                    2,
                    Math.round(frameWidth * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1))
                  )}
                  height={Math.max(
                    2,
                    Math.round(frameHeight * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1))
                  )}
                  className="absolute inset-0 h-full w-full bg-black will-change-transform"
                  style={picturePreviewStyle}
                />
              ) : null}
              {cropPreview && resolvedEffects.vignette ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_52%,rgba(0,0,0,0.32)_100%)]"
                />
              ) : null}
              {cropPreview && creatorCamera && creator.cutaways?.length ? (
                <CutawayLayer plan={creator} assets={mediaLibrary} sourceSec={time} playing={playing} />
              ) : null}
              {positioningCaptions ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute border border-dashed border-accent/60"
                  style={{ inset: "8% 14% 18% 8%" }}
                >
                  <span className="text-micro absolute left-1 top-1 rounded bg-black/70 px-1 text-accent">
                    platform safe zone
                  </span>
                </div>
              ) : null}
              {showCaptionsInFrame ? (
                <CaptionOverlay
                  caption={activeCaption}
                  style={activeCaptionStyle}
                  font={activeCaptionFont}
                  frameHeight={frameHeight}
                  frameWidth={frameWidth}
                  spokenIndex={spokenIndex}
                  positioning={positioningCaptions || Boolean(placingScene && activeCaption?.sceneId === placingScene.id)}
                  onPositionChange={(horizontalFrac, verticalFrac) => {
                    // Dragging a caption inside a scene places that scene's look.
                    // On the Create desk only a scene is ever moved: the Edit
                    // desk's own caption position stays exactly as it is.
                    const sceneId = placingScene?.id ?? activeCaption?.sceneId;
                    if (desk === "create" && !sceneId) return;
                    if (sceneId && creator.enabled) {
                      setCreator((prev) => ({
                        ...prev,
                        captionScenes: (prev.captionScenes ?? []).map((scene) =>
                          scene.id === sceneId
                            ? {
                                ...scene,
                                overrides: {
                                  ...scene.overrides,
                                  horizontalFrac,
                                  verticalFrac,
                                },
                              }
                            : scene
                        ),
                      }));
                      return;
                    }
                    setOverrides((prev) => ({
                      ...prev,
                      horizontalFrac,
                      verticalFrac,
                    }));
                  }}
                />
              ) : null}
              {cropPreview && selectedText ? (
                <TextPlacement
                  title={selectedText}
                  frameWidth={frameWidth}
                  frameHeight={frameHeight}
                  fontFor={titleFontFor}
                  onMove={(position) =>
                    setCreator((prev) => ({
                      ...prev,
                      titles: (prev.titles ?? []).map((title) => (title.id === selectedText.id ? { ...title, ...position } : title)),
                    }))
                  }
                />
              ) : null}
              {showCleanup && desk === "cut" && frameWidth > 0 ? (
                <CleanupLayer
                  regions={cleanup}
                  transform={transform}
                  frameWidth={frameWidth}
                  frameHeight={frameHeight}
                  editable={mode === "source" && fitMode === "crop"}
                  onAdd={addCleanupRegion}
                  onChange={updateCleanupRegion}
                  onRemove={(id) => setCleanup((prev) => prev.filter((r) => r.id !== id))}
                />
              ) : null}
              {cropPreview && cutFlashes > 0 ? (
                <span className="eyebrow absolute end-2 top-2 rounded-md border border-warn/50 bg-black/70 px-1.5 py-0.5 text-warn">
                  {cutFlashes} cut flash{cutFlashes === 1 ? "" : "es"}
                </span>
              ) : cropPreview && track && track.confidence < 0.4 ? (
                <span className="eyebrow absolute end-2 top-2 rounded-md border border-warn/50 bg-black/70 px-1.5 py-0.5 text-warn">
                  Check framing
                </span>
              ) : null}
              {fitMode === "fit" && mode === "source" ? (
                // The crop window, drawn on top of the whole source.
                <div
                  className="pointer-events-none absolute border-2 border-accent-2/80"
                  style={{
                    left: transform.box.x * transform.scale,
                    top: transform.box.y * transform.scale,
                    width: transform.box.width * transform.scale,
                    height: transform.box.height * transform.scale,
                  }}
                />
              ) : null}
              {mode === "output" && !rendered ? (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
                  <p className="text-meta text-muted">This clip has not been rendered yet.</p>
                </div>
              ) : null}
              {sourceFetching ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 p-6 text-center">
                  <Loader2 className="size-6 animate-spin text-warn" aria-hidden="true" />
                  <p className="text-meta text-warn">
                    {fetchPercent > 0 ? `Downloading source · ${fetchPercent}%` : "Starting download…"}
                  </p>
                  <div
                    className="h-1.5 w-full max-w-[180px] overflow-hidden rounded-full bg-white/10"
                    role="progressbar"
                    aria-valuenow={fetchPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-hidden="true"
                  >
                    <div
                      className="h-full origin-left rounded-full bg-warn transition-transform duration-500 ease-out-quart"
                      style={{
                        transform: `scaleX(${Math.max(0.03, fetchPercent / 100)})`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
              {matteNote && desk === "create" && mode === "source" ? (
                <div className="absolute inset-x-0 top-0 bg-black/60 px-3 py-1.5">
                  <p className="text-micro text-center text-muted">{matteNote}</p>
                </div>
              ) : null}
              {analysingFrame && mode === "source" && !sourceFetching ? (
                <div className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2">
                  <p className="text-micro flex items-center justify-center gap-1.5 text-muted">
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    Finding the speaker…
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          {/* Player controls, kept compact so the preview above gets the height. */}
          <div className="flex w-full max-w-[420px] shrink-0 flex-col items-center gap-2">
            {/* One compact row: what the player shows, and how it frames the source. */}
            {rendered || mode === "source" ? (
              <div className="flex w-full flex-wrap items-center justify-center gap-2">
                {rendered ? (
                  <PillToggle
                    label="Player shows"
                    value={mode}
                    onChange={setMode}
                    options={[
                      { id: "source", label: "Live edit" },
                      {
                        id: "output",
                        label: "Last render",
                        title: clip.outputBytes
                          ? `Stored: ${formatBytes(clip.outputBytes)}${clip.reframeNote ? ` · ${clip.reframeNote}` : ""}`
                          : undefined,
                      },
                    ]}
                  />
                ) : null}
                {/* Framing: the crop is what renders, "fit" reveals what it cuts off. */}
                {mode === "source" ? (
                  <PillToggle
                    label="Framing"
                    value={fitMode}
                    onChange={setFitMode}
                    options={[
                      { id: "crop", label: "9:16 crop" },
                      { id: "fit", label: "Fit source" },
                    ]}
                  />
                ) : null}
              </div>
            ) : null}

            {/* transport */}
            <div className="flex w-full items-center gap-2">
              {isMerge ? (
                <button
                  type="button"
                  disabled={safeIndex === 0}
                  onClick={() => selectSegment(safeIndex - 1)}
                  className="press inline-flex size-11 items-center justify-center rounded-lg border border-control text-muted hover:border-accent disabled:opacity-40"
                  aria-label="Previous segment"
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={togglePlay}
                className="press inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg hover:opacity-90"
                aria-label={playing ? "Pause preview" : outroPlaythrough ? "Play clip and sting" : "Play window"}
              >
                {playing ? (
                  <Pause className="size-5" aria-hidden="true" />
                ) : (
                  <Play className="size-5" aria-hidden="true" />
                )}
              </button>
              {isMerge ? (
                <button
                  type="button"
                  disabled={safeIndex >= previewSegments.length - 1}
                  onClick={() => selectSegment(safeIndex + 1)}
                  className="press inline-flex size-11 items-center justify-center rounded-lg border border-control text-muted hover:border-accent disabled:opacity-40"
                  aria-label="Next segment"
                >
                  <ArrowRight className="size-4" aria-hidden="true" />
                </button>
              ) : null}
              {/* where you are, and the scrubber, beside the play button */}
              <div className="min-w-0 flex-1">
                <p className="num text-micro truncate text-muted">
                  {previewStage === "outro"
                    ? `sting ${timecode(outroTime)} · ${outroDur.toFixed(1)}s after the window`
                    : `source ${timecode(time)} · window ${timecode(active.startSec)}–${timecode(active.endSec)} · ${(active.endSec - active.startSec).toFixed(1)}s${
                        creator.enabled && creatorWindows.length > 1 ? ` → ${creatorOutputSec.toFixed(1)}s cut` : ""
                      }`}
                  {isMerge && previewStage !== "outro" ? ` · part ${safeIndex + 1}/${previewSegments.length}` : ""}
                </p>

                {/* playhead: clip window, or clip + sting on the mix desk */}
                <input
                  type="range"
                  min={outroPlaythrough ? 0 : active.startSec}
                  max={outroPlaythrough ? playthroughDur : Math.max(active.startSec + 0.1, active.endSec)}
                  step={0.05}
                  value={
                    outroPlaythrough
                      ? Math.min(playthroughDur, Math.max(0, playheadLocal))
                      : Math.min(Math.max(time, active.startSec), active.endSec)
                  }
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (outroPlaythrough) seekPlaythrough(next);
                    else seekTo(next);
                  }}
                  aria-label={outroPlaythrough ? "Playhead through clip and sting" : "Playhead"}
                  className="accent-accent h-6 w-full"
                />
              </div>
            </div>

            {desk === "cut" ? (
              <div className="grid w-full grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={markIn}
                  className="press text-ui h-9 rounded-lg border border-control px-3 font-medium hover:border-accent"
                >
                  Mark in
                </button>
                <button
                  type="button"
                  onClick={markOut}
                  className="press text-ui h-9 rounded-lg border border-control px-3 font-medium hover:border-accent"
                >
                  Mark out
                </button>
              </div>
            ) : null}

            {desk === "cut" ? (
              <div className="grid w-full max-w-[340px] grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={trimPast.length === 0}
                  onClick={undoTrimAction}
                  className="press text-ui inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-control px-2 font-medium text-muted hover:border-accent disabled:opacity-35"
                  aria-label={trimPast.length > 0 ? `Undo ${trimPast[trimPast.length - 1]?.label}` : "Undo trim mark"}
                >
                  <Undo2 className="size-3.5" aria-hidden="true" />
                  {trimPast.length > 0 ? `Undo ${trimPast[trimPast.length - 1]?.label}` : "Undo mark"}
                </button>
                <button
                  type="button"
                  disabled={trimFuture.length === 0}
                  onClick={redoTrimAction}
                  className="press text-ui inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-control px-2 font-medium text-muted hover:border-accent disabled:opacity-35"
                  aria-label={
                    trimFuture.length > 0 ? `Redo ${trimFuture[trimFuture.length - 1]?.label}` : "Redo trim mark"
                  }
                >
                  <Redo2 className="size-3.5" aria-hidden="true" />
                  {trimFuture.length > 0 ? `Redo ${trimFuture[trimFuture.length - 1]?.label}` : "Redo mark"}
                </button>
              </div>
            ) : null}

            {desk === "mix" ? (
              <MixTimeline
                soundtrack={soundtrack}
                localTime={playheadLocal}
                durationSec={clipWindowDur}
                outroSec={outroPlaythrough ? outroDur : 0}
                onSeekLocal={seekPlaythrough}
              />
            ) : null}
            {wordsError ? (
              <p className="text-meta text-warn">
                Caption preview unavailable ({wordsError}). Rendering still uses the stored timings.
              </p>
            ) : null}

            {/* render status */}
            {clip.status === "rendering" ? (
              <div className="w-full max-w-[340px] rounded-lg border border-border bg-panel p-2">
                <p className="text-meta flex items-center gap-2 text-muted">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  Rendering {renderProgress}%
                </p>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-panel-2">
                  <div className="score-fill h-full" style={{ width: `${renderProgress}%` }} />
                </div>
              </div>
            ) : null}
            {clip.renderError ? (
              <p className="text-meta w-full rounded-md bg-bad/10 px-2 py-1 text-bad">{clip.renderError}</p>
            ) : null}
          </div>
        </section>

        {/* the beat timeline: a full-width row under player and rail on desktop */}
        {desk === "create" ? (
          <div className="min-w-0 lg:order-last lg:col-start-2">
            <p className="text-micro mb-1.5 px-1 text-muted">
              Timeline · click a block to edit it · drag to move, drag an edge to resize · + adds at the playhead
            </p>
            <BeatTimeline
              trimStart={trimStart}
              trimEnd={trimEnd}
              plan={creator}
              windows={creatorWindows}
              sfx={soundtrack.sfx ?? []}
              sfxLabels={sfxLabelMap}
              sfxAssets={sfxAssets}
              effectLabels={effectLabels}
              mediaLabels={mediaLabels}
              sceneCuts={sceneCuts}
              peakSec={clip.peakSec}
              playhead={time}
              selected={beatSelection}
              onSelect={setBeatSelection}
              onSeek={(sourceSec) => {
                videoRef.current?.pause();
                seekTo(sourceSec);
              }}
              onSpanChange={updateBeatSpan}
              onAdd={(lane) => addBeatAtPlayhead(lane)}
              onAddSfx={(assetId) => addBeatAtPlayhead("sfx", assetId)}
              onRemove={removeBeatById}
              onDropMedia={dropMediaOnLane}
              dimmed={!creator.enabled}
            />
          </div>
        ) : null}

        {/* controls — the only pane the right scrollbar should move */}
        <section className="studio-scroll relative flex min-w-0 flex-col gap-4 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
          {desk === "create" ? (
            <CreatorDesk
              clipId={clip.id}
              plan={creator}
              onChange={setCreator}
              soundtrack={soundtrack}
              onSoundtrackChange={setSoundtrack}
              trimStart={trimStart}
              trimEnd={trimEnd}
              windows={creatorWindows}
              peakSec={clip.peakSec}
              sourceReady={sourceReady}
              styles={styles}
              clipStyle={style}
              fonts={fontChoices}
              videoEffects={resolvedEffects}
              selected={beatSelection}
              onSelect={setBeatSelection}
              hasFaceTrack={Boolean(track?.keyframes.some((keyframe) => keyframe.fx != null))}
              headTravel={travel}
              videoRef={videoRef}
              track={track}
              cropOrigin={cropOrigin}
              effects={effectsRegistry}
              onPreviewSpan={previewSpan}
              mediaLibrary={mediaLibrary}
              stockSources={stockSources}
              transitions={transitions}
              onMediaChanged={refreshMediaLibrary}
              onPlaceCutaway={(assetId) => addBeatAtPlayhead("cutaways", undefined, assetId)}
              onAdd={(lane, sfxAssetId) => addBeatAtPlayhead(lane, sfxAssetId)}
              playhead={time}
              spokenTextBetween={spokenTextBetween}
              onPlayFrom={(sourceSec) => {
                seekTo(sourceSec);
                void videoRef.current?.play().catch(() => undefined);
              }}
              audioLibrary={audioLibrary}
              outroSec={outroPlaythrough ? outroDur : 0}
              onUploadAudio={uploadAudio}
              onDirect={directClip}
              onDirectorFeedback={directorFeedback}
              onSense={senseNow}
              onReview={reviewNow}
              sense={harness.sense}
              review={harness.review}
              rendered={rendered}
              onAudioChanged={refreshAudioLibrary}
            />
          ) : desk === "mix" ? (
            <>
              <MixPanel
                projectId={project.id}
                soundtrack={soundtrack}
                onChange={setSoundtrack}
                localTime={playheadLocal}
                durationSec={outroPlaythrough ? playthroughDur : clipWindowDur}
                outroSec={outroPlaythrough ? outroDur : 0}
                live={mode === "source"}
              />
              <OutroAttachCard
                items={projectOutros}
                defaultOutroId={project.defaultOutroId}
                attach={clipOutro}
                onChange={setClipOutro}
                onEdit={(id) => onOpenOutro(id)}
              />
            </>
          ) : (
            <>
              {/* window */}
              <Panel title={isMerge ? "Segments" : "Trim"} icon={Scissors}>
                {isMerge ? (
                  <SegmentList
                    segments={segments}
                    activeIndex={safeIndex}
                    maxDuration={sourceDuration}
                    onSelect={selectSegment}
                    onChange={updateSegment}
                    onMove={moveSegment}
                    onRemove={removeSegment}
                  />
                ) : (
                  <WindowSliders
                    sourceDuration={sourceDuration}
                    startSec={trimStart}
                    endSec={trimEnd}
                    markers={sceneCuts}
                    onStart={(value) => {
                      clearTrimHistory();
                      setTrimStart(Math.min(value, trimEnd - 0.2));
                    }}
                    onEnd={(value) => {
                      clearTrimHistory();
                      setTrimEnd(Math.max(value, trimStart + 0.2));
                    }}
                  />
                )}
              </Panel>

              {/* framing */}
              <Panel title="Viral edit" icon={Sparkles}>
                <label className="block">
                  <span className="eyebrow text-muted">Overall video template</span>
                  <select
                    value={editTemplateId}
                    onChange={(event) => applyEditTemplate(event.target.value)}
                    className="text-ui mt-1 h-11 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent"
                  >
                    <option value="custom">Custom settings</option>
                    {SHORT_FORM_TEMPLATES.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.label} — {template.summary}
                      </option>
                    ))}
                  </select>
                </label>

                {editTemplateId !== "custom" ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {SHORT_FORM_TEMPLATES.find((item) => item.id === editTemplateId)?.techniques.map((technique) => (
                      <span
                        key={technique}
                        className="text-micro rounded-full border border-border bg-panel-2 px-2 py-1 text-muted"
                      >
                        {technique}
                      </span>
                    ))}
                  </div>
                ) : null}

                <details className="mt-2 rounded-lg border border-border bg-panel-2/40">
                  <summary className="text-ui cursor-pointer px-3 py-2 font-semibold text-muted">
                    Fine-tune picture & sound
                  </summary>
                  <div className="border-t border-border px-3 pb-3">
                    <label className="mt-3 block">
                      <span className="eyebrow text-muted">Colour treatment</span>
                      <select
                        value={resolvedEffects.grade}
                        onChange={(event) =>
                          updateVideoEffects({
                            grade: event.target.value as VideoEffects["grade"],
                          })
                        }
                        className="text-ui mt-1 h-10 w-full rounded-lg border border-control bg-panel px-2 outline-none focus:border-accent"
                      >
                        <option value="natural">Natural</option>
                        <option value="vibrant">Vibrant</option>
                        <option value="warm">Warm</option>
                        <option value="cool">Cool / authority</option>
                        <option value="cinematic">Cinematic</option>
                      </select>
                    </label>
                    <label className="mt-3 block">
                      <span className="eyebrow text-muted">Motion emphasis</span>
                      <select
                        value={resolvedEffects.motion}
                        onChange={(event) =>
                          updateVideoEffects({
                            motion: event.target.value as VideoEffects["motion"],
                          })
                        }
                        className="text-ui mt-1 h-10 w-full rounded-lg border border-control bg-panel px-2 outline-none focus:border-accent"
                      >
                        <option value="none">None</option>
                        <option value="hook_push">Smooth opening push-in</option>
                        <option value="peak_punch">Punch-in at strongest moment</option>
                      </select>
                    </label>
                    <Slider
                      label="Punch-in strength"
                      value={resolvedEffects.zoom}
                      min={1}
                      max={1.12}
                      step={0.005}
                      format={(value) => `${Math.round((value - 1) * 100)}%`}
                      onChange={(zoom) => updateVideoEffects({ zoom })}
                    />
                    <Slider
                      label="Sharpness"
                      value={resolvedEffects.sharpen}
                      min={0}
                      max={1}
                      step={0.05}
                      format={(value) => `${Math.round(value * 100)}%`}
                      onChange={(sharpen) => updateVideoEffects({ sharpen })}
                    />
                    <label className="mt-3 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={resolvedEffects.vignette}
                        onChange={(event) => updateVideoEffects({ vignette: event.target.checked })}
                        className="size-4 accent-accent"
                      />
                      <span className="text-ui text-muted">Subtle edge focus</span>
                    </label>
                    <label className="mt-3 block">
                      <span className="eyebrow text-muted">Audio treatment</span>
                      <select
                        value={resolvedEffects.audio}
                        onChange={(event) =>
                          updateVideoEffects({
                            audio: event.target.value as VideoEffects["audio"],
                          })
                        }
                        className="text-ui mt-1 h-10 w-full rounded-lg border border-control bg-panel px-2 outline-none focus:border-accent"
                      >
                        <option value="natural">Natural</option>
                        <option value="voice">Voice clarity</option>
                        <option value="loud">High-energy loudness</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setEditTemplateId("custom");
                        setVideoEffects({ ...DEFAULT_VIDEO_EFFECTS });
                      }}
                      className="press text-ui mt-3 rounded-lg border border-control px-2 py-1 font-medium text-muted hover:border-accent"
                    >
                      Reset video treatment
                    </button>
                  </div>
                </details>
              </Panel>

              {/* framing */}
              <Panel title="Framing" icon={Sparkles}>
                <div className="flex gap-2">
                  <SegmentedButton
                    active={reframeMode === "smart"}
                    onClick={() => {
                      setReframeMode("smart");
                      setEditTemplateId("custom");
                    }}
                    label="Smart reframe"
                  />
                  <SegmentedButton
                    active={reframeMode === "center"}
                    onClick={() => {
                      setReframeMode("center");
                      setEditTemplateId("custom");
                    }}
                    label="Centre crop"
                  />
                </div>
                {reframeMode === "smart" && !isMerge ? (
                  <CutCheckPanel
                    track={track}
                    trimStart={trimStart}
                    trimEnd={trimEnd}
                    sourceWidth={sourceSize.w}
                    sourceHeight={sourceSize.h}
                    analysing={analysingFrame}
                    onJump={(sourceSec) => {
                      videoRef.current?.pause();
                      seekTo(sourceSec);
                    }}
                  />
                ) : null}
              </Panel>

              {/* captions */}
              <Panel title="Subtitles" icon={SlidersHorizontal}>
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedButton active={captionsOn} onClick={() => setCaptionsOn(true)} label="On" />
                  <SegmentedButton active={!captionsOn} onClick={() => setCaptionsOn(false)} label="Off" />
                </div>

                <p className="eyebrow mt-3 text-muted">Peak line</p>
                <div className="mt-1 flex gap-2">
                  <SegmentedButton
                    active={overrides.peakEmphasis !== false}
                    onClick={() => setOverrides((prev) => ({ ...prev, peakEmphasis: true }))}
                    label="Highlight"
                  />
                  <SegmentedButton
                    active={overrides.peakEmphasis === false}
                    onClick={() => setOverrides((prev) => ({ ...prev, peakEmphasis: false }))}
                    label="Match others"
                  />
                </div>

                {sceneLooks.length > 0 ? (
                  <SceneNote
                    sceneLooks={sceneLooks}
                    time={time}
                    onOpen={(id) => {
                      setBeatSelection({ lane: "captions", id });
                      setDesk("create");
                    }}
                  />
                ) : null}

                <label className="mt-3 block">
                  <span className="eyebrow text-muted">Caption style</span>
                  <select
                    value={styleId}
                    onChange={(event) => {
                      setStyleId(event.target.value);
                      setCaptionsOn(true);
                      setEditTemplateId("custom");
                      // A preset is a complete look, so picking one clears the
                      // per-caption tweaks rather than mixing two caption designs.
                      // Peak highlight is independent of the look, so it is kept.
                      setOverrides((prev) => (prev.peakEmphasis === false ? { peakEmphasis: false } : {}));
                    }}
                    className="text-ui mt-1 h-11 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent"
                  >
                    {styles.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} — {option.summary}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  disabled={cleaningCaptions}
                  onClick={() => void cleanCaptions()}
                  className="press text-ui mt-2 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-control px-2 font-semibold text-muted hover:border-accent disabled:opacity-50"
                >
                  {cleaningCaptions ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles className="size-3.5" aria-hidden="true" />
                  )}
                  {cleaningCaptions ? "Cleaning captions…" : "Clean captions"}
                </button>
                {cleanNote ? <p className="text-meta mt-1 text-muted">{cleanNote}</p> : null}

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    aria-pressed={positioningCaptions}
                    onClick={() => {
                      setPositioningCaptions((value) => !value);
                      setShowCleanup(false);
                    }}
                    className={cn(
                      "press text-ui h-10 rounded-lg border px-2 font-semibold",
                      positioningCaptions
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-control text-muted hover:border-accent"
                    )}
                  >
                    {positioningCaptions ? "Drag subtitle now" : "Place on video"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCaptionTextOverrides([]);
                      setCaptionWordOverrides([]);
                    }}
                    disabled={captionTextOverrides.length === 0 && captionWordOverrides.length === 0}
                    className="press text-ui h-10 rounded-lg border border-control px-2 font-medium text-muted hover:border-accent disabled:opacity-40"
                  >
                    Reset transcript ({captionTextOverrides.length + captionWordOverrides.length})
                  </button>
                </div>

                <details className="mt-2 rounded-lg border border-border bg-panel-2/40">
                  <summary className="text-ui cursor-pointer px-3 py-2 font-semibold text-muted">
                    Position & appearance
                  </summary>
                  <div className="border-t border-border px-3 pb-3">
                    <Slider
                      label="Horizontal"
                      value={style.horizontalFrac}
                      min={0.05}
                      max={0.95}
                      step={0.005}
                      format={(value) => `${Math.round(value * 100)}%`}
                      onChange={(value) =>
                        setOverrides((prev) => ({
                          ...prev,
                          horizontalFrac: value,
                        }))
                      }
                    />
                    <Slider
                      label="Vertical"
                      value={style.verticalFrac}
                      min={0.05}
                      max={0.95}
                      step={0.005}
                      format={(value) => `${Math.round(value * 100)}% up`}
                      onChange={(value) =>
                        setOverrides((prev) => ({
                          ...prev,
                          verticalFrac: value,
                        }))
                      }
                    />
                    <Slider
                      label="Words per caption"
                      value={style.chunkWords}
                      min={1}
                      max={8}
                      step={1}
                      format={(value) => String(value)}
                      onChange={(value) => setOverrides((prev) => ({ ...prev, chunkWords: value }))}
                    />
                    <p className="text-meta mt-1 text-muted">Groups the transcript. Edits stay on the words.</p>
                    <Slider
                      label="Size"
                      value={style.sizeScale}
                      min={0.6}
                      max={2}
                      step={0.05}
                      format={(value) => `${Math.round(value * 100)}%`}
                      onChange={(value) => setOverrides((prev) => ({ ...prev, sizeScale: value }))}
                    />
                    <label className="mt-3 block">
                      <span className="eyebrow text-muted">Font</span>
                      <select
                        value={style.fontFamily}
                        onChange={(event) => {
                          setOverrides((prev) => ({
                            ...prev,
                            fontFamily: event.target.value,
                          }));
                          setEditTemplateId("custom");
                        }}
                        className="text-ui mt-1 h-11 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent"
                        style={{
                          fontFamily: catalogFont?.stack ?? style.fontFamily,
                        }}
                      >
                        {fontChoices.map((font) => (
                          <option key={font.id} value={font.family} style={{ fontFamily: font.stack }}>
                            {font.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <ColorControl
                        label="Text"
                        value={style.textColor}
                        onChange={(textColor) => setOverrides((prev) => ({ ...prev, textColor }))}
                      />
                      {overrides.peakEmphasis !== false ? (
                        <ColorControl
                          label="Peak"
                          value={style.peakColor}
                          onChange={(peakColor) => setOverrides((prev) => ({ ...prev, peakColor }))}
                        />
                      ) : null}
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={style.background === "box"}
                          onChange={(event) =>
                            setOverrides((prev) => ({
                              ...prev,
                              background: event.target.checked ? "box" : "none",
                            }))
                          }
                          className="size-4 accent-accent"
                        />
                        <span className="text-ui text-muted">Box</span>
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={style.uppercase}
                          onChange={(event) =>
                            setOverrides((prev) => ({
                              ...prev,
                              uppercase: event.target.checked,
                            }))
                          }
                          className="size-4 accent-accent"
                        />
                        <span className="text-ui text-muted">Uppercase</span>
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={style.highlight === "word"}
                          onChange={(event) =>
                            setOverrides((prev) => ({
                              ...prev,
                              highlight: event.target.checked ? "word" : "none",
                            }))
                          }
                          className="size-4 accent-accent"
                        />
                        <span className="text-ui text-muted">Colour the spoken word</span>
                      </label>
                    </div>
                    <label className="mt-3 block">
                      <span className="eyebrow text-muted">Entrance</span>
                      <select
                        value={style.animation}
                        onChange={(event) =>
                          setOverrides((prev) => ({
                            ...prev,
                            animation: event.target.value as CaptionOverrides["animation"],
                          }))
                        }
                        className="text-ui mt-1 h-10 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent"
                      >
                        <option value="none">None</option>
                        <option value="fade">Quick fade</option>
                        <option value="pop">Punch pop</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setOverrides((prev) => (prev.peakEmphasis === false ? { peakEmphasis: false } : {}))
                      }
                      className="press text-ui mt-3 rounded-lg border border-control px-2 py-1 font-medium text-muted hover:border-accent"
                    >
                      Reset appearance
                    </button>
                  </div>
                </details>

                <details open className="mt-2 rounded-lg border border-border bg-panel-2/40">
                  <summary className="text-ui cursor-pointer px-3 py-2 font-semibold text-muted">Transcript</summary>
                  <div className="border-t border-border p-2">
                    <p className="text-meta mb-2 text-muted">
                      Edit the words. Words per caption only groups them on the video.
                    </p>
                    <textarea
                      value={transcriptDraft}
                      rows={8}
                      spellCheck
                      onFocus={() => setTranscriptFocused(true)}
                      onBlur={() => {
                        setTranscriptFocused(false);
                        commitTranscript();
                      }}
                      onChange={(event) => setTranscriptDraft(event.target.value)}
                      className="text-ui min-h-36 w-full resize-y rounded-md border border-control bg-panel px-2 py-2 outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={commitTranscript}
                      className="press text-ui mt-2 h-9 w-full rounded-lg border border-control font-semibold text-muted hover:border-accent"
                    >
                      Bind to video
                    </button>
                  </div>
                </details>

                <details className="mt-2 rounded-lg border border-border bg-panel-2/40">
                  <summary className="text-ui cursor-pointer px-3 py-2 font-semibold text-muted">
                    Edit subtitle sections
                  </summary>
                  <div className="border-t border-border p-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-meta text-muted">
                        {captions.length} active · {removedCaptionSections.length + removedWordSpans.length} removed
                      </span>
                      <button
                        type="button"
                        onClick={addCaptionSection}
                        className="press text-ui inline-flex h-9 items-center gap-1.5 rounded-lg border border-accent/60 px-2.5 font-semibold text-accent hover:bg-accent/10"
                      >
                        <Plus className="size-3.5" aria-hidden="true" />
                        Add at playhead
                      </button>
                    </div>
                    <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
                      {captions.length === 0 ? (
                        <p className="text-meta rounded-lg border border-dashed border-border p-3 text-muted">
                          No active subtitle sections. Add one at the current playhead or restore a removed section.
                        </p>
                      ) : (
                        captions.map((caption) => {
                          const edited = caption.custom
                            ? captionTextOverrides.some((item) => item.custom && `custom:${item.id}` === caption.editId)
                            : caption.words.some((word) =>
                                captionWordOverrides.some(
                                  (item) => Math.round(item.t * 1000) === Math.round(word.t * 1000)
                                )
                              );
                          return (
                            <div key={caption.editId} className="rounded-lg border border-border bg-panel p-2">
                              <div className="mb-2 flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => seekTo(caption.start + active.startSec)}
                                  className="num text-micro flex-1 text-left text-muted hover:text-foreground"
                                >
                                  {timecode(caption.start + active.startSec)}–{timecode(caption.sourceEndSec)}
                                  {caption.custom ? " · added" : edited ? " · edited" : ""}
                                </button>
                                {edited && !caption.custom ? (
                                  <button
                                    type="button"
                                    onClick={() => resetCaptionSection(caption)}
                                    className="text-micro font-semibold text-accent"
                                  >
                                    Restore
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateCaptionSection(caption, {
                                      hidden: true,
                                      endSec: caption.sourceEndSec,
                                    })
                                  }
                                  aria-label={`Remove subtitle at ${timecode(caption.sourceStartSec)}`}
                                  className="press inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-bad/15 hover:text-bad"
                                >
                                  <Trash2 className="size-3.5" aria-hidden="true" />
                                </button>
                              </div>
                              <CaptionSectionField
                                value={caption.text}
                                onFocusSeek={() => seekTo(caption.start + active.startSec)}
                                onCommit={(text) => updateCaptionSection(caption, { text })}
                              />
                              {caption.custom ? (
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                  <TimestampInput
                                    label="Start"
                                    value={caption.sourceStartSec}
                                    min={active.startSec}
                                    max={caption.sourceEndSec - 0.05}
                                    onChange={(value) =>
                                      updateCaptionSection(caption, {
                                        startSec: value,
                                      })
                                    }
                                  />
                                  <TimestampInput
                                    label="End"
                                    value={caption.sourceEndSec}
                                    min={caption.sourceStartSec + 0.05}
                                    max={active.endSec}
                                    onChange={(endSec) => updateCaptionSection(caption, { endSec })}
                                  />
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </div>

                    {removedCaptionSections.length + removedWordSpans.length > 0 ? (
                      <details className="mt-2 rounded-lg border border-border bg-panel-2/50">
                        <summary className="text-meta cursor-pointer px-2.5 py-2 font-semibold text-muted">
                          Removed sections ({removedCaptionSections.length + removedWordSpans.length})
                        </summary>
                        <ul className="space-y-1 border-t border-border p-2">
                          {removedWordSpans.map((span) => (
                            <li key={span.key} className="flex items-center gap-2 rounded-md bg-panel px-2 py-1.5">
                              <span className="num text-micro flex-1 text-muted">
                                {timecode(span.ts[0] ?? 0)} · {span.text || "Generated subtitle"}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  const drop = new Set(span.ts.map((t) => Math.round(t * 1000)));
                                  setCaptionWordOverrides((prev) =>
                                    prev.filter((item) => !item.hidden || !drop.has(Math.round(item.t * 1000)))
                                  );
                                }}
                                className="text-micro font-semibold text-accent"
                              >
                                Restore
                              </button>
                            </li>
                          ))}
                          {removedCaptionSections.map((edit) => (
                            <li
                              key={edit.custom ? edit.id : edit.startSec}
                              className="flex items-center gap-2 rounded-md bg-panel px-2 py-1.5"
                            >
                              <span className="num text-micro flex-1 text-muted">
                                {timecode(edit.displayStartSec ?? edit.startSec)} · {edit.text || "Generated subtitle"}
                              </span>
                              <button
                                type="button"
                                onClick={() => restoreRemovedSection(edit)}
                                className="text-micro font-semibold text-accent"
                              >
                                Restore
                              </button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                </details>
              </Panel>

              {/* Burned-in text / watermark removal */}
              <Panel title="Cleanup" icon={Eraser}>
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedButton active={showCleanup} onClick={() => setShowCleanup(true)} label="Edit regions" />
                  <SegmentedButton active={!showCleanup} onClick={() => setShowCleanup(false)} label="Hidden" />
                </div>
                <p className="text-meta mt-2 text-muted">
                  {mode === "output"
                    ? "Switch the preview to Source to place regions."
                    : "Drag over a logo or burned-in caption in the player. The renderer reconstructs those pixels from what surrounds them."}
                </p>

                {cleanup.length === 0 ? (
                  <p className="text-meta mt-2 text-muted">No regions.</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {cleanup.map((region, index) => (
                      <li key={region.id} className="rounded-lg border border-border bg-panel-2/50 p-2">
                        <div className="flex items-center gap-2">
                          <span className="num text-meta flex-1 text-muted">
                            #{index + 1} · {region.w}×{region.h} @ {region.x},{region.y}
                          </span>
                          <button
                            type="button"
                            onClick={() => setCleanup((prev) => prev.filter((r) => r.id !== region.id))}
                            aria-label={`Remove cleanup region ${index + 1}`}
                            className="press inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-bad/15 hover:text-bad"
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <label className="text-meta flex flex-1 items-center gap-1">
                            <span className="text-muted">from</span>
                            <input
                              type="number"
                              step={0.1}
                              min={0}
                              value={region.start}
                              onChange={(event) =>
                                updateCleanupRegion(region.id, {
                                  start: Number(event.target.value),
                                })
                              }
                              className="num h-9 w-full rounded-md border border-control bg-panel px-2"
                            />
                          </label>
                          <label className="text-meta flex flex-1 items-center gap-1">
                            <span className="text-muted">to</span>
                            <input
                              type="number"
                              step={0.1}
                              min={0}
                              value={region.end}
                              onChange={(event) =>
                                updateCleanupRegion(region.id, {
                                  end: Number(event.target.value),
                                })
                              }
                              className="num h-9 w-full rounded-md border border-control bg-panel px-2"
                            />
                          </label>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {cleanup.length >= MAX_CLEANUP_REGIONS ? (
                  <p className="text-meta mt-2 text-warn">Limit of {MAX_CLEANUP_REGIONS} regions reached.</p>
                ) : null}
              </Panel>
            </>
          )}
        </section>
      </div>

      {/* ---- footer ---- */}
      <footer className="safe-b flex flex-wrap items-center gap-2 border-t border-border px-3 pt-2 lg:px-5">
        <button
          type="button"
          onClick={onRequestDelete}
          className="press text-ui inline-flex h-11 items-center gap-1.5 rounded-md px-2.5 font-medium text-muted hover:bg-bad/10 hover:text-bad sm:h-8"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          Delete
        </button>

        {rendered ? (
          <a
            href={clipDownloadUrl(clip.id, {
              download: true,
              bust: clip.renderedAt,
            })}
            download
            className="press text-ui inline-flex h-11 items-center gap-1.5 rounded-md border border-border px-2.5 font-medium hover:border-control sm:h-8"
          >
            <Download className="size-3.5" aria-hidden="true" />
            Download
          </a>
        ) : null}

        <span className="text-meta me-auto text-muted">
          {actionError ? (
            <span className="text-bad">{actionError}</span>
          ) : rendering ? (
            "Rendering…"
          ) : autosaving || busy === "save" ? (
            "Saving…"
          ) : dirty ? (
            "Unsaved changes"
          ) : (
            "Saved"
          )}
        </span>

        {desk === "mix" ? (
          <button
            type="button"
            disabled={busy !== null || rendering}
            onClick={() => setDesk("cut")}
            className="press text-ui inline-flex h-11 items-center gap-1.5 rounded-md border border-border px-3 font-semibold hover:border-control disabled:opacity-50 sm:h-8"
          >
            <Scissors className="size-3.5" aria-hidden="true" />
            Back to edit
          </button>
        ) : null}

        <button
          type="button"
          disabled={busy !== null || rendering}
          onClick={() => void saveNow()}
          className="press text-ui inline-flex h-11 items-center gap-1.5 rounded-md border border-border px-3 font-semibold hover:border-control disabled:opacity-50 sm:h-8"
        >
          {busy === "save" ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="size-3.5" aria-hidden="true" />
          )}
          Save
        </button>

        {desk === "mix" ? (
          <button
            type="button"
            disabled={busy !== null || rendering}
            onClick={() => void renderNow()}
            className="press text-ui inline-flex h-11 items-center gap-1.5 rounded-md bg-accent px-3 font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50 sm:h-8"
          >
            {rendering || busy === "render" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-3.5" aria-hidden="true" />
            )}
            {rendered ? "Export again" : "Export clip"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy !== null || rendering}
            onClick={() => void openMixDesk()}
            className="press text-ui inline-flex h-11 items-center gap-1.5 rounded-md bg-accent px-3 font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50 sm:h-8"
          >
            {busy === "save" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Music className="size-3.5" aria-hidden="true" />
            )}
            {rendered ? "Mix & export" : "Render"}
          </button>
        )}
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const FALLBACK_FONTS: CaptionFontInfo[] = [
  {
    id: "arial",
    label: "Arial",
    family: "Arial",
    stack: "Arial, Helvetica, sans-serif",
    weight: 900,
  },
];

const FALLBACK_STYLE: CaptionStyleInfo = {
  id: "clean",
  label: "Clean",
  summary: "",
  chunkWords: 3,
  sizeScale: 1,
  verticalFrac: 340 / 1920,
  horizontalFrac: 0.5,
  textColor: "#FFFFFF",
  background: "none",
  animation: "fade",
  peakColor: "#34d8ff",
  fontFamily: "Arial",
  uppercase: false,
};

function motionZoom(effects: Required<VideoEffects>, localTime: number, peakAt: number): number {
  const amount = Math.max(0, effects.zoom - 1);
  if (effects.motion === "hook_push") {
    return 1 + amount * Math.max(0, 1 - localTime / 0.45);
  }
  if (effects.motion === "peak_punch") {
    return 1 + amount * Math.max(0, 1 - Math.abs(localTime - peakAt) / 0.38);
  }
  return 1;
}

/** The slowest rate browsers accept for playbackRate; below it they throw. */
const MIN_BROWSER_RATE = 0.0625;

function previewFilter(effects: Required<VideoEffects>): string {
  const grade = {
    natural: "",
    vibrant: "contrast(1.06) saturate(1.14) brightness(1.01)",
    warm: "contrast(1.04) saturate(1.07) sepia(0.06)",
    cool: "contrast(1.05) saturate(0.98) hue-rotate(4deg)",
    cinematic: "contrast(1.1) saturate(0.86) brightness(0.98)",
  }[effects.grade];
  // CSS cannot reproduce FFmpeg's unsharp/vignette filters exactly; this is a
  // lightweight visual preview. The encoded output uses the real filters.
  const sharpness = effects.sharpen > 0 ? ` contrast(${1 + effects.sharpen * 0.025})` : "";
  return `${grade}${sharpness}`.trim() || "none";
}

function projectMediaUrl(projectId: string): string {
  return `/api/projects/${projectId}/media`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function tracksLookEqual(a: ReframeTrack | undefined, b: ReframeTrack | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.originSec !== b.originSec || a.untilSec !== b.untilSec || a.keyframes.length !== b.keyframes.length) {
    return false;
  }
  return a.keyframes.every(
    (keyframe, i) =>
      keyframe.t === b.keyframes[i]!.t && keyframe.cx === b.keyframes[i]!.cx && keyframe.width === b.keyframes[i]!.width
  );
}

function trackCoversRange(track: ReframeTrack | undefined, start: number, end: number): boolean {
  return (
    track?.originSec != null &&
    track.untilSec != null &&
    track.originSec <= start + 0.05 &&
    track.untilSec >= end - 0.05
  );
}

function preferCoveringTrack(
  current: ReframeTrack | undefined,
  incoming: ReframeTrack | undefined,
  start: number,
  end: number
): ReframeTrack | undefined {
  if (tracksLookEqual(current, incoming)) return current ?? incoming;
  const currentCovers = trackCoversRange(current, start, end);
  const incomingCovers = trackCoversRange(incoming, start, end);
  let chosen: ReframeTrack | undefined;
  if (currentCovers && !incomingCovers) chosen = current;
  else if (incomingCovers) chosen = incoming;
  else {
    const currentUntil = current?.untilSec ?? Number.NEGATIVE_INFINITY;
    const incomingUntil = incoming?.untilSec ?? Number.NEGATIVE_INFINITY;
    chosen = currentUntil > incomingUntil + 0.05 ? current : (incoming ?? current);
  }
  return chosen ? holdCropUntilCuts(chosen) : chosen;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function WindowSliders({
  sourceDuration,
  startSec,
  endSec,
  markers = [],
  onStart,
  onEnd,
}: {
  sourceDuration: number;
  startSec: number;
  endSec: number;
  markers?: number[];
  onStart: (value: number) => void;
  onEnd: (value: number) => void;
}) {
  const span = Math.max(0.1, sourceDuration);
  return (
    <div>
      <p className="num text-meta text-muted">
        {timecode(startSec)}–{timecode(endSec)} · {(endSec - startSec).toFixed(1)}s of {timecode(sourceDuration)}
      </p>
      {markers.length > 0 ? (
        <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-panel-2" aria-hidden="true">
          <div
            className="absolute inset-y-0 rounded-full bg-accent/20"
            style={{
              left: `${(startSec / span) * 100}%`,
              width: `${((endSec - startSec) / span) * 100}%`,
            }}
          />
          {markers.map((mark) => (
            <span
              key={Math.round(mark * 1000)}
              className="absolute top-0 h-2 w-0.5 bg-accent-2"
              style={{ left: `${(mark / span) * 100}%` }}
            />
          ))}
        </div>
      ) : null}
      <Slider
        label="Start"
        value={startSec}
        min={0}
        max={Math.max(0.1, sourceDuration)}
        step={0.1}
        format={timecode}
        onChange={onStart}
      />
      <Slider
        label="End"
        value={endSec}
        min={0}
        max={Math.max(0.1, sourceDuration)}
        step={0.1}
        format={timecode}
        onChange={onEnd}
      />
      <p className="text-meta mt-1 text-muted">Tip: press I / O to mark in and out at the playhead.</p>
    </div>
  );
}

function SegmentList({
  segments,
  activeIndex,
  maxDuration,
  onSelect,
  onChange,
  onMove,
  onRemove,
}: {
  segments: ClipSegment[];
  activeIndex: number;
  maxDuration: number;
  onSelect: (index: number) => void;
  onChange: (index: number, patch: Partial<ClipSegment>) => void;
  onMove: (index: number, delta: number) => void;
  onRemove: (index: number) => void;
}) {
  if (segments.length === 0) {
    return <p className="text-meta text-muted">No segments — this merge has no parts left.</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {segments.map((segment, index) => (
        <li
          key={`${segment.sourceClipId ?? "seg"}-${index}`}
          className={cn(
            "rounded-lg border p-2",
            index === activeIndex ? "border-accent bg-accent/5" : "border-border bg-panel-2/50"
          )}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelect(index)}
              aria-label={`Preview segment ${index + 1}`}
              aria-pressed={index === activeIndex}
              className="press num text-ui inline-flex h-9 min-w-9 items-center justify-center rounded-md border border-control font-semibold"
            >
              {index + 1}
            </button>
            <span className="num text-meta flex-1 text-muted">
              {timecode(segment.startSec)}–{timecode(segment.endSec)} · {(segment.endSec - segment.startSec).toFixed(1)}
              s
            </span>
            <button
              type="button"
              disabled={index === 0}
              onClick={() => onMove(index, -1)}
              aria-label={`Move segment ${index + 1} earlier`}
              className="press inline-flex size-9 items-center justify-center rounded-md border border-control text-muted hover:border-accent disabled:opacity-30"
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={index === segments.length - 1}
              onClick={() => onMove(index, 1)}
              aria-label={`Move segment ${index + 1} later`}
              className="press inline-flex size-9 items-center justify-center rounded-md border border-control text-muted hover:border-accent disabled:opacity-30"
            >
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={segments.length <= 1}
              onClick={() => onRemove(index)}
              aria-label={`Remove segment ${index + 1}`}
              className="press inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-bad/15 hover:text-bad disabled:opacity-30"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <WindowSliders
            sourceDuration={maxDuration}
            startSec={segment.startSec}
            endSec={segment.endSec}
            onStart={(value) =>
              onChange(index, {
                startSec: Math.min(value, segment.endSec - 0.2),
              })
            }
            onEnd={(value) =>
              onChange(index, {
                endSec: Math.max(value, segment.startSec + 0.2),
              })
            }
          />
        </li>
      ))}
    </ol>
  );
}

/**
 * Create's caption scenes carry their own look, so the Subtitles panel's
 * controls hold only outside them (and inside scenes set to "Clip's own").
 * Says so, and names the scene under the playhead — the usual reason a
 * setting here seems not to take.
 */
function SceneNote({
  sceneLooks,
  time,
  onOpen,
}: {
  sceneLooks: { scene: CaptionScene; style: CaptionStyleInfo }[];
  time: number;
  onOpen: (sceneId: string) => void;
}) {
  const here = sceneLooks.find(({ scene }) => time >= scene.startSec && time < scene.endSec);
  const styled = sceneLooks.filter(({ scene }) => scene.styleId).length;
  if (here?.scene.styleId) {
    const words = here.style.chunkWords;
    return (
      <p className="text-meta mt-3 rounded-md bg-warn/10 px-2 py-1.5 text-warn">
        At the playhead, the <span className="font-semibold">{here.scene.label || "caption"}</span> scene from Create uses the{" "}
        {here.style.label} look — {words} word{words === 1 ? "" : "s"} at a time, {here.style.fontFamily}. The controls below
        do not reach it.{" "}
        <button type="button" onClick={() => onOpen(here.scene.id)} className="font-semibold underline">
          Edit that scene
        </button>
      </p>
    );
  }
  if (styled === 0) return null;
  return (
    <p className="text-meta mt-3 text-muted">
      {styled} Create scene{styled === 1 ? " sets its" : "s set their"} own look; these controls hold outside{" "}
      {styled === 1 ? "it" : "them"}.
    </p>
  );
}
