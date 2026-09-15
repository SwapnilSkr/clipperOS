import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Camera,
  Captions,
  Clapperboard,
  Film,
  Gauge,
  Loader2,
  Mic,
  Music,
  Play,
  Plus,
  SlidersHorizontal,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Upload,
  Volume2,
  Wand2,
} from "lucide-react";
import {
  api,
  MAX_CAMERA_ZOOM,
  MAX_TRANSITION_SEC,
  MIN_CAMERA_ZOOM,
  MAX_FOLLOW_ZOOM,
  type AudioAsset,
  type BehindTitle,
  type CameraMove,
  type CaptionFontInfo,
  type CaptionOverrides,
  type CaptionScene,
  type CaptionStyleInfo,
  type CreatorPlan,
  type DirectInput,
  type ClipSense,
  type RenderReview,
  type PauseCandidate,
  type PauseCut,
  type Soundtrack,
  type SoundtrackHit,
  type FollowAxis,
  type Cutaway,
  type CutawayMotion,
  type EffectInfo,
  type EffectSpan,
  type MediaAsset,
  type TransitionInfo,
  type FollowResponse,
  type ReframeTrack,
  type SpeedKind,
  type SpeedSpan,
  type TextEnter,
  type TextExit,
  type TextMotion,
  type VideoEffects,
} from "@/api";
import { exitOf, textSchedule } from "@/lib/text-motion";
import { sceneStyleFor } from "@/lib/captions";
import { enablePlan, laneFull, removeBeat, type BeatLane } from "@/lib/beat-plan";
import {
  FOLLOW_MIN_ZOOM,
  followLead,
  followTightnessX,
  moveRampSec,
  outputDuration,
  sourceToOutput,
  type TimeWindow,
} from "@/lib/creator-timeline";
import { FramingWidget } from "./FramingWidget";
import { MusicBedsEditor } from "./MusicBeds";
import { EffectPicker, rememberEffect } from "./EffectPicker";
import { MediaPicker } from "./MediaPicker";
import { cn, timecode } from "@/lib/utils";
import type { BeatSelection } from "./BeatTimeline";
import { DirectorPanel } from "./DirectorPanel";
import { StudioPanel } from "./StudioPanel";
import { MAX_MUSIC_BEDS, musicBeds, newBedId } from "@/lib/music-beds";
import { LANES } from "./lanes";
import { audition, rememberSfx, SfxPicker } from "./SfxPicker";
import { ColorControl, Panel, SegmentedButton, Slider, TimestampInput } from "./editor-controls";

// ============================================================
// CREATOR DESK — the right rail of creator mode.
//
// Owns nothing: the plan and the SFX hits live in the editor's draft state
// (so they autosave with everything else); this desk only proposes changes.
// Adding beats happens on the timeline's lanes; this rail is the switch, the
// inspector for whatever is selected, the Director, and the two clip-wide
// tools (dead air, camera follow).
// ============================================================

export interface CreatorDeskProps {
  clipId: string;
  plan: CreatorPlan;
  onChange: (plan: CreatorPlan) => void;
  soundtrack: Soundtrack;
  onSoundtrackChange: (next: Soundtrack) => void;
  trimStart: number;
  trimEnd: number;
  windows: TimeWindow[];
  peakSec: number;
  sourceReady: boolean;
  styles: CaptionStyleInfo[];
  /** The Edit desk's look, which a scene without a preset starts from. */
  clipStyle: CaptionStyleInfo;
  fonts: CaptionFontInfo[];
  /** The clip-wide motion, migrated into a move when creator mode turns on. */
  videoEffects: VideoEffects;
  selected: BeatSelection | null;
  onSelect: (selection: BeatSelection | null) => void;
  /** Whether the reframe track carries face positions (needed for follow). */
  hasFaceTrack: boolean;
  /** How far the head moves within a shot, as fractions of the frame — what follow has to work with. */
  headTravel?: { x: number; y: number };
  /** The effects pack, served by the API. */
  effects: EffectInfo[];
  /** Stills and videos for cutaways, the stock providers with a key, and the transitions on offer. */
  mediaLibrary: MediaAsset[];
  stockSources: ("pexels" | "pixabay")[];
  transitions: TransitionInfo[];
  /** The library changed: reload it. */
  onMediaChanged: () => Promise<void> | void;
  /** Place a cutaway with this asset at the playhead. */
  onPlaceCutaway: (assetId: string) => void;
  /** Add a default beat on a lane at the playhead (a sound for the SFX lane), and select it. */
  onAdd: (lane: BeatLane, sfxAssetId?: string) => void;
  /** Source seconds of the playhead, where "Add" puts things. */
  playhead: number;
  /** Transcript text spoken in [from, to] (source seconds), for filling a Text beat. */
  spokenTextBetween?: (from: number, to: number) => string;
  /** Seek to a source instant and play from there. */
  onPlayFrom?: (sourceSec: number) => void;
  /** Render [startSec, endSec] exactly (the draft is flushed first); resolves to a streamable URL. */
  onPreviewSpan: (startSec: number, endSec: number) => Promise<{ url: string; durationSec: number }>;
  /** The player's source element and its crop track, for the framing widget. */
  videoRef: RefObject<HTMLVideoElement | null>;
  track: ReframeTrack | undefined;
  /** The track's time origin (source seconds of keyframe t=0). */
  cropOrigin: number;
  /** Built-in and uploaded audio: beds for the Sound panel, one-shots for the SFX lane. */
  audioLibrary: AudioAsset[];
  /** Sting length after the clip, so a bed's out point means the same here as on the Sound desk. */
  outroSec?: number;
  /** Upload a file into the shared library; the editor refreshes `audioLibrary`. */
  onUploadAudio: (file: File, kind: "music" | "sfx") => Promise<void>;
  /** Flush the draft, run the Director, adopt its plan. Rejects with a message. */
  onDirect: (input: DirectInput) => Promise<{ warnings: string[]; pending: string[] }>;
  /** A thumbs up / down on the last pass, learned. */
  onDirectorFeedback: (verdict: "up" | "down", note?: string) => Promise<void>;
  /** The harness watches the window / the last render on demand. */
  onSense: () => Promise<void>;
  onReview: () => Promise<void>;
  /** What the harness saw and its critique of the last render. */
  sense?: ClipSense;
  review?: RenderReview;
  /** The clip has a render to watch. */
  rendered: boolean;
  /** The audio library changed: reload it. */
  onAudioChanged: () => Promise<void> | void;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const FIELD =
  "text-ui mt-1 h-10 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent";

export function CreatorDesk({
  clipId,
  plan,
  onChange,
  soundtrack,
  onSoundtrackChange,
  trimStart,
  trimEnd,
  windows,
  peakSec,
  sourceReady,
  styles,
  clipStyle,
  fonts,
  videoEffects,
  selected,
  onSelect,
  hasFaceTrack,
  headTravel,
  effects: effectsPack,
  mediaLibrary,
  stockSources,
  transitions,
  onMediaChanged,
  onPlaceCutaway,
  onAdd,
  playhead,
  spokenTextBetween,
  onPlayFrom,
  onPreviewSpan,
  videoRef,
  track,
  cropOrigin,
  audioLibrary: library,
  outroSec = 0,
  onUploadAudio,
  onDirect,
  onDirectorFeedback,
  onSense,
  onReview,
  sense,
  review,
  rendered,
  onAudioChanged,
}: CreatorDeskProps) {
  const [detecting, setDetecting] = useState(false);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState<"music" | "sfx" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [tab, setTab] = useState<RailTab>(readRailTab);
  // Picking a sound or a picture before it is placed.
  const [choosing, setChoosing] = useState<"sfx" | "cutaways" | null>(null);
  function openTab(next: RailTab) {
    setTab(next);
    rememberRailTab(next);
  }
  // Selecting a block anywhere (the timeline, a list) opens it for editing.
  // Keyed on the selection object itself, not its id: clicking the block that is
  // already selected, from another tab, must still bring its editor back.
  const tabsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selected) return;
    setTab("edit");
    setChoosing(null);
    // Put the editor where it can be seen: the top of the rail when the rail
    // scrolls on its own (desktop), or scroll the page to it when it does not.
    const timer = window.setTimeout(() => {
      const tabs = tabsRef.current;
      const rail = tabs?.parentElement;
      if (!tabs || !rail) return;
      if (rail.scrollHeight > rail.clientHeight && getComputedStyle(rail).overflowY !== "visible") {
        rail.scrollTop = 0;
      } else {
        const box = tabs.getBoundingClientRect();
        if (box.top < 0 || box.top > window.innerHeight - 120) tabs.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selected]);

  const sfx = soundtrack.sfx ?? [];
  const onSfxChange = (hits: SoundtrackHit[]) => onSoundtrackChange({ ...soundtrack, sfx: hits });
  const sfxAssets = useMemo(() => library.filter((asset) => asset.kind === "sfx"), [library]);
  const musicAssets = useMemo(() => library.filter((asset) => asset.kind === "music"), [library]);

  async function upload(file: File | undefined, kind: "music" | "sfx") {
    if (!file) return;
    setUploading(kind);
    setUploadError(null);
    try {
      await onUploadAudio(file, kind);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(null);
    }
  }

  const cuts = plan.cuts ?? [];
  const speed = plan.speed ?? [];
  const effects = plan.effects ?? [];
  const cutaways = plan.cutaways ?? [];
  const moves = plan.camera?.moves ?? [];
  const scenes = plan.captionScenes ?? [];
  const titles = plan.titles ?? [];
  const removed = Math.max(0, trimEnd - trimStart - outputDuration(windows));

  function patch(next: Partial<CreatorPlan>) {
    onChange({ ...plan, ...next });
  }

  function setEnabled(enabled: boolean) {
    onChange(enabled ? enablePlan(plan, videoEffects, trimStart, trimEnd, peakSec) : { ...plan, enabled: false });
  }

  // ---- lanes ----
  function updateCut(id: string, change: Partial<PauseCut>) {
    patch({
      cuts: cuts.map((cut) => (cut.id === id ? { ...cut, ...change } : cut)),
    });
  }
  function updateCutaway(id: string, change: Partial<Cutaway>) {
    patch({ cutaways: cutaways.map((item) => (item.id === id ? { ...item, ...change } : item)) });
  }
  function updateEffect(id: string, change: Partial<EffectSpan>) {
    patch({ effects: effects.map((span) => (span.id === id ? { ...span, ...change } : span)) });
  }
  function updateSpeed(id: string, change: Partial<SpeedSpan>) {
    patch({ speed: speed.map((span) => (span.id === id ? { ...span, ...change } : span)) });
  }
  function updateMove(id: string, change: Partial<CameraMove>) {
    patch({
      camera: {
        ...plan.camera,
        moves: moves.map((move) => (move.id === id ? { ...move, ...change } : move)),
      },
    });
  }
  function updateScene(id: string, change: Partial<CaptionScene>) {
    patch({
      captionScenes: scenes.map((scene) => (scene.id === id ? { ...scene, ...change } : scene)),
    });
  }
  function updateSceneOverrides(id: string, change: Partial<CaptionOverrides>) {
    const scene = scenes.find((item) => item.id === id);
    if (!scene) return;
    updateScene(id, { overrides: { ...scene.overrides, ...change } });
  }
  function updateTitle(id: string, change: Partial<BehindTitle>) {
    patch({
      titles: titles.map((title) => (title.id === id ? { ...title, ...change } : title)),
    });
  }
  function updateHit(id: string, change: Partial<SoundtrackHit>) {
    onSfxChange(sfx.map((hit) => (hit.id === id ? { ...hit, ...change } : hit)));
  }
  function remove(lane: BeatLane, id: string) {
    const next = removeBeat(lane, id, { plan, sfx });
    if (next.plan !== plan) onChange(next.plan);
    if (next.sfx !== sfx) onSfxChange(next.sfx);
    onSelect(null);
  }

  async function detectPauses() {
    setDetecting(true);
    setDetectNote(null);
    try {
      const result = await api.getClipPauses(clipId, {
        startSec: trimStart,
        endSec: trimEnd,
      });
      const users = cuts.filter((cut) => cut.source === "user");
      const found: PauseCut[] = result.candidates.map((candidate: PauseCandidate) => ({
        id: candidate.id,
        startSec: candidate.startSec,
        endSec: candidate.endSec,
        // Keep an accepted candidate accepted across a re-detect.
        enabled: cuts.some((cut) => cut.enabled && Math.abs(cut.startSec - candidate.startSec) < 0.15),
        source: "director",
      }));
      patch({ cuts: [...users, ...found] });
      if (result.candidates.length === 0) setDetectNote("Nothing worth cutting.");
    } catch (error) {
      setDetectNote(error instanceof Error ? error.message : "Could not detect pauses");
    } finally {
      setDetecting(false);
    }
  }

  const selectedCut = selected?.lane === "cuts" ? cuts.find((cut) => cut.id === selected.id) : undefined;
  const selectedMove = selected?.lane === "camera" ? moves.find((move) => move.id === selected.id) : undefined;
  const selectedSpeed = selected?.lane === "speed" ? speed.find((span) => span.id === selected.id) : undefined;
  const selectedEffect = selected?.lane === "fx" ? effects.find((span) => span.id === selected.id) : undefined;
  const selectedCutaway = selected?.lane === "cutaways" ? cutaways.find((item) => item.id === selected.id) : undefined;
  const selectedScene = selected?.lane === "captions" ? scenes.find((scene) => scene.id === selected.id) : undefined;
  // What the scene actually renders with — its preset (or the Edit desk's
  // look) under its fine-tuning — so every control shows the value in force.
  const sceneLook = selectedScene ? sceneStyleFor(styles, clipStyle, selectedScene) : clipStyle;
  const selectedTitle = selected?.lane === "titles" ? titles.find((title) => title.id === selected.id) : undefined;
  const selectedHit = selected?.lane === "sfx" ? sfx.find((hit) => hit.id === selected.id) : undefined;
  const fontChoices =
    fonts.length > 0
      ? fonts
      : [
          {
            id: "arial",
            label: "Arial",
            family: "Arial",
            stack: "Arial, sans-serif",
            weight: 900,
          },
        ];
  const sfxLabels = useMemo(() => new Map(sfxAssets.map((asset) => [asset.id, asset.label])), [sfxAssets]);
  const applied = cuts.filter((cut) => cut.enabled).length;
  const follow = plan.camera?.follow;

  // Editing works with creator effects off too: the banner says they will not render.
  const editing = Boolean(
    selectedCut || selectedSpeed || selectedEffect || selectedCutaway || selectedMove || selectedScene || selectedTitle || selectedHit
  );
  // Blocks on the same lane that overlap the selected one — stacked effects, two
  // hits on one beat — which a click on the timeline cannot tell apart.
  const alsoHere: { id: string; label: string }[] = (() => {
    if (!selected || !editing) return [];
    const overlaps = (a: { startSec: number; endSec: number }, b: { startSec: number; endSec: number }) =>
      a.startSec < b.endSec && b.startSec < a.endSec;
    switch (selected.lane) {
      case "sfx":
        return selectedHit
          ? sfx
              .filter((hit) => hit.id !== selectedHit.id && Math.abs(hit.atSec - selectedHit.atSec) < 0.3)
              .map((hit) => ({ id: hit.id, label: sfxLabels.get(hit.assetId) ?? hit.assetId }))
          : [];
      case "fx":
        return selectedEffect
          ? effects
              .filter((item) => item.id !== selectedEffect.id && overlaps(item, selectedEffect))
              .map((item) => ({ id: item.id, label: effectsPack.find((info) => info.id === item.effectId)?.label ?? item.effectId }))
          : [];
      case "titles":
        return selectedTitle
          ? titles.filter((item) => item.id !== selectedTitle.id && overlaps(item, selectedTitle)).map((item) => ({ id: item.id, label: item.text }))
          : [];
      case "cuts":
        return selectedCut
          ? cuts
              .filter((item) => item.id !== selectedCut.id && overlaps(item, selectedCut))
              .map((item) => ({ id: item.id, label: `Cut at ${timecode(item.startSec)}` }))
          : [];
      default:
        return [];
    }
  })();
  const editingLane = editing && selected ? LANES.find((lane) => lane.id === selected.lane) : undefined;

  return (
    <>
      <RailTabs value={tab} onChange={openTab} anchorRef={tabsRef} />

      {!plan.enabled ? (
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-3">
          <p className="text-meta text-fg">
            Creator effects are off — this clip renders with the Edit desk only. Your beats are kept.
          </p>
          <button
            type="button"
            onClick={() => setEnabled(true)}
            className="press text-ui mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 font-semibold text-accent-fg hover:opacity-90"
          >
            <Wand2 className="size-3.5" aria-hidden="true" />
            Turn on
          </button>
        </div>
      ) : null}

      {tab === "edit" ? (
        <>
          {editingLane ? (
            <div className="flex items-center justify-between gap-2 px-1">
              <p className="text-micro flex items-center gap-1.5 text-muted">
                <editingLane.icon className="size-3" aria-hidden="true" />
                Editing · {editingLane.name}
              </p>
              <button
                type="button"
                onClick={() => onSelect(null)}
                className="press text-micro inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 font-semibold text-muted hover:border-control hover:text-fg"
              >
                <Plus className="size-3" aria-hidden="true" />
                Add new
              </button>
            </div>
          ) : null}
          {editingLane && alsoHere.length > 0 && selected ? (
            <div className="flex flex-wrap items-center gap-1.5 px-1">
              <span className="text-micro text-muted">Also here:</span>
              {alsoHere.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect({ lane: selected.lane, id: item.id })}
                  className="press text-micro max-w-[12rem] truncate rounded-full border border-border px-2 py-0.5 font-semibold text-muted hover:border-accent hover:text-fg"
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
          {editingLane ? null : (
            <Panel title={`Add at ${timecode(playhead)}`} icon={Plus}>
              <p className="text-meta text-muted">Adds at the playhead. To change something, click it on the timeline.</p>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {LANES.map((lane) => {
                  const full = laneFull(lane.id, plan, sfx);
                  const needsChoice = lane.id === "sfx" || lane.id === "cutaways";
                  return (
                    <button
                      key={lane.id}
                      type="button"
                      disabled={full}
                      aria-pressed={choosing === lane.id}
                      title={full ? "This lane is full" : undefined}
                      onClick={() => (needsChoice ? setChoosing((open) => (open === lane.id ? null : (lane.id as "sfx" | "cutaways"))) : onAdd(lane.id))}
                      className={cn(
                        "press flex items-start gap-2 rounded-lg border p-2 text-left disabled:opacity-40",
                        choosing === lane.id ? "border-accent bg-accent/10" : "border-border hover:border-control hover:bg-panel-2"
                      )}
                    >
                      <lane.icon className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="text-ui block font-semibold leading-tight">{lane.name}</span>
                        <span className="text-micro mt-0.5 block leading-snug text-muted">{lane.summary}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {choosing === "sfx" ? (
                <div className="mt-3 border-t border-border pt-2">
                  <p className="text-micro mb-1.5 text-muted">Choose a sound for {timecode(playhead)}</p>
                  <SfxPicker
                    assets={sfxAssets}
                    onPick={(assetId) => {
                      setChoosing(null);
                      onAdd("sfx", assetId);
                    }}
                  />
                </div>
              ) : null}
              {choosing === "cutaways" ? (
                <div className="mt-3 border-t border-border pt-2">
                  <p className="text-micro mb-1.5 text-muted">
                    Choose a picture or clip for {timecode(playhead)} — or drop a file on the B-roll lane
                  </p>
                  <MediaPicker
                    assets={mediaLibrary}
                    stockSources={stockSources}
                    onPick={(asset) => {
                      setChoosing(null);
                      onPlaceCutaway(asset.id);
                    }}
                    onChanged={onMediaChanged}
                    pickLabel="Place at playhead"
                  />
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => openTab("director")}
                className="press text-meta mt-3 inline-flex items-center gap-1.5 font-semibold text-accent hover:underline"
              >
                <Clapperboard className="size-3.5" aria-hidden="true" />
                Not sure where to start? Let the AI Director make a first pass
              </button>
            </Panel>
          )}

          {selectedCut ? (
            <Inspector title="Pause cut" icon={Scissors} onRemove={() => remove("cuts", selectedCut.id)}>
              <Check
                label="Apply this cut"
                checked={selectedCut.enabled}
                onChange={(enabled) => updateCut(selectedCut.id, { enabled })}
              />
              <SpanFields
                startSec={selectedCut.startSec}
                endSec={selectedCut.endSec}
                min={trimStart}
                max={trimEnd}
                onChange={(span) => updateCut(selectedCut.id, span)}
              />
            </Inspector>
          ) : null}

          {selectedSpeed ? (
            <Inspector title="Speed" icon={Gauge} onRemove={() => remove("speed", selectedSpeed.id)}>
              <Choice<SpeedKind>
                value={selectedSpeed.kind}
                options={[
                  ["slow", "Slow motion"],
                  ["freeze", "Freeze frame"],
                  ["fast", "Fast forward"],
                ]}
                onChange={(kind) =>
                  updateSpeed(selectedSpeed.id, {
                    kind,
                    rate: kind === "freeze" ? 0 : kind === "fast" ? 1.5 : 0.5,
                    ...(kind !== "slow" ? { smooth: undefined } : {}),
                  })
                }
              />
              {selectedSpeed.kind === "slow" ? (
                <Field label="Rate">
                  <Choice<string>
                    value={String(selectedSpeed.rate)}
                    options={[
                      ["0.25", "¼×"],
                      ["0.4", "0.4×"],
                      ["0.5", "½×"],
                      ["0.75", "¾×"],
                    ]}
                    onChange={(rate) => updateSpeed(selectedSpeed.id, { rate: Number(rate) })}
                  />
                </Field>
              ) : null}
              {selectedSpeed.kind === "fast" ? (
                <Field label="Rate">
                  <Choice<string>
                    value={String(selectedSpeed.rate)}
                    options={[
                      ["1.25", "1¼×"],
                      ["1.5", "1½×"],
                      ["2", "2×"],
                      ["3", "3×"],
                    ]}
                    onChange={(rate) => updateSpeed(selectedSpeed.id, { rate: Number(rate) })}
                  />
                </Field>
              ) : null}
              <SpanFields
                startSec={selectedSpeed.startSec}
                endSec={selectedSpeed.endSec}
                min={trimStart}
                max={trimEnd}
                onChange={(span) => updateSpeed(selectedSpeed.id, span)}
              />
              {selectedSpeed.kind === "slow" ? (
                <Check
                  label="Smooth (synthesise in-between frames; slower render)"
                  checked={selectedSpeed.smooth === true}
                  onChange={(smooth) => updateSpeed(selectedSpeed.id, { smooth: smooth || undefined })}
                />
              ) : null}
              {selectedSpeed.kind !== "fast" ? (
                <Check
                  label="Keep captions on"
                  checked={selectedSpeed.captions === true}
                  onChange={(captions) => updateSpeed(selectedSpeed.id, { captions: captions || undefined })}
                />
              ) : null}
              <p className="text-meta mt-2 text-muted">
                {selectedSpeed.kind === "fast"
                  ? "The voice speeds up with the picture, pitch kept."
                  : "The voice fades out for this stretch; music and sound effects carry on."}
              </p>
            </Inspector>
          ) : null}

          {selectedCutaway ? (
            <Inspector
              title={mediaLibrary.find((item) => item.id === selectedCutaway.assetId)?.label ?? "Cutaway"}
              icon={Film}
              onRemove={() => remove("cutaways", selectedCutaway.id)}
            >
              <SpanFields
                startSec={selectedCutaway.startSec}
                endSec={selectedCutaway.endSec}
                min={trimStart}
                max={trimEnd}
                onChange={(span) => updateCutaway(selectedCutaway.id, span)}
              />
              <Field label="Fit">
                <Choice<Cutaway["fit"]>
                  value={selectedCutaway.fit}
                  options={[
                    ["cover", "Fill the frame"],
                    ["blur", "Whole, blurred fill"],
                  ]}
                  onChange={(fit) => updateCutaway(selectedCutaway.id, { fit })}
                />
              </Field>
              <Field label="Motion">
                <Choice<CutawayMotion>
                  value={selectedCutaway.motion}
                  options={[
                    ["none", "Still"],
                    ["in", "Zoom in"],
                    ["out", "Zoom out"],
                    ["left", "← Pan"],
                    ["right", "Pan →"],
                  ]}
                  onChange={(motion) => updateCutaway(selectedCutaway.id, { motion })}
                />
              </Field>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <TransitionField
                  label="In"
                  edge={selectedCutaway.in}
                  transitions={transitions}
                  onChange={(edge) => updateCutaway(selectedCutaway.id, { in: edge })}
                />
                <TransitionField
                  label="Out"
                  edge={selectedCutaway.out}
                  transitions={transitions}
                  onChange={(edge) => updateCutaway(selectedCutaway.id, { out: edge })}
                />
              </div>
              {mediaLibrary.find((item) => item.id === selectedCutaway.assetId)?.kind === "video" ? (
                <Slider
                  label="Start in the video at"
                  value={selectedCutaway.offsetSec ?? 0}
                  min={0}
                  max={Math.max(0.5, (mediaLibrary.find((item) => item.id === selectedCutaway.assetId)?.durationSec ?? 10) - 0.5)}
                  step={0.1}
                  format={(value) => `${value.toFixed(1)}s`}
                  onChange={(offsetSec) => updateCutaway(selectedCutaway.id, { offsetSec: offsetSec > 0 ? round3(offsetSec) : undefined })}
                />
              ) : null}
              <Field label="Picture">
                <MediaPicker
                  assets={mediaLibrary}
                  stockSources={stockSources}
                  value={selectedCutaway.assetId}
                  onPick={(asset) => updateCutaway(selectedCutaway.id, { assetId: asset.id })}
                  onChanged={onMediaChanged}
                  pickLabel="Use here"
                />
              </Field>
              <SpanPreview
                key={selectedCutaway.id}
                startSec={selectedCutaway.startSec}
                endSec={selectedCutaway.endSec}
                onRender={onPreviewSpan}
              />
            </Inspector>
          ) : null}

          {selectedEffect ? (
            <Inspector
              title={effectsPack.find((item) => item.id === selectedEffect.effectId)?.label ?? "Effect"}
              icon={Sparkles}
              onRemove={() => remove("fx", selectedEffect.id)}
            >
              <SpanFields
                startSec={selectedEffect.startSec}
                endSec={selectedEffect.endSec}
                min={trimStart}
                max={trimEnd}
                onChange={(span) => updateEffect(selectedEffect.id, span)}
              />
              <Slider
                label="Amount"
                value={selectedEffect.amount}
                min={0}
                max={1}
                step={0.05}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(amount) => updateEffect(selectedEffect.id, { amount: round3(amount) })}
              />
              {(() => {
                const variants = effectsPack.find((item) => item.id === selectedEffect.effectId)?.variants;
                return variants?.length ? (
                  <Field label="Direction">
                    <Choice<string>
                      value={selectedEffect.variant ?? variants[0]!.id}
                      options={variants.map((variant) => [variant.id, variant.label] as [string, string])}
                      onChange={(variant) => updateEffect(selectedEffect.id, { variant })}
                    />
                  </Field>
                ) : null;
              })()}
              <Field label="Effect">
                <EffectPicker
                  effects={effectsPack}
                  sample={{ video: videoRef, track, cropOrigin, tightness: followTightnessX(plan), lead: followLead(plan) }}
                  amount={selectedEffect.amount}
                  value={selectedEffect.effectId}
                  onPick={(effectId) => {
                    updateEffect(selectedEffect.id, { effectId, variant: undefined });
                    rememberEffect(effectId);
                  }}
                />
              </Field>
              <SpanPreview
                key={selectedEffect.id}
                startSec={selectedEffect.startSec}
                endSec={selectedEffect.endSec}
                onRender={onPreviewSpan}
              />
            </Inspector>
          ) : null}

          {selectedMove ? (
            <Inspector title="Camera move" icon={Camera} onRemove={() => remove("camera", selectedMove.id)}>
              <Choice<CameraMove["kind"]>
                value={selectedMove.kind}
                options={[
                  ["punch", "Punch"],
                  ["push", "Push"],
                  ["pull", "Pull"],
                  ["frame", "Frame"],
                  ["hold", "Hold"],
                ]}
                onChange={(kind) => updateMove(selectedMove.id, { kind })}
              />
              <p className="text-meta mt-1 text-muted">
                {selectedMove.kind === "punch"
                  ? "Hard in, hold, hard out."
                  : selectedMove.kind === "push"
                    ? "Creeps in, lets go at the end."
                    : selectedMove.kind === "pull"
                      ? "Starts zoomed, settles out."
                      : selectedMove.kind === "hold"
                        ? "Locks the camera off: it stops riding the head for the span, then glides back."
                        : "Ramps to the framing you set below and holds it."}
              </p>
              <SpanFields
                startSec={selectedMove.startSec}
                endSec={selectedMove.endSec}
                min={trimStart}
                max={trimEnd}
                onChange={(span) => updateMove(selectedMove.id, span)}
              />
              <FramingWidget
                video={videoRef}
                track={track}
                plan={plan}
                move={selectedMove}
                tightness={followTightnessX(plan)}
                lead={followLead(plan)}
                cropOrigin={cropOrigin}
                onChange={(change) => updateMove(selectedMove.id, change)}
              />
              <Slider
                label={selectedMove.kind === "pull" ? "Zoom from" : selectedMove.kind === "hold" ? "Zoom" : "Zoom to"}
                value={selectedMove.zoom}
                min={MIN_CAMERA_ZOOM}
                max={MAX_CAMERA_ZOOM}
                step={0.01}
                format={(value) =>
                  `${value >= 1 ? "+" : ""}${Math.round((value - 1) * 100)}%${value > 1.35 ? " · soft" : value < 1 ? " · out" : ""}`
                }
                onChange={(zoom) => updateMove(selectedMove.id, { zoom: round3(zoom) })}
              />
              {selectedMove.kind !== "hold" ? (
                <Slider
                  label={selectedMove.kind === "pull" ? "Zoom to" : "Zoom from"}
                  value={selectedMove.zoomFrom ?? 1}
                  min={MIN_CAMERA_ZOOM}
                  max={MAX_CAMERA_ZOOM}
                  step={0.01}
                  format={(value) => `${value >= 1 ? "+" : ""}${Math.round((value - 1) * 100)}%`}
                  onChange={(zoomFrom) =>
                    updateMove(selectedMove.id, { zoomFrom: Math.abs(zoomFrom - 1) < 0.005 ? undefined : round3(zoomFrom) })
                  }
                />
              ) : null}
              <Field label="Zoom point">
                <Choice<"face" | "look" | "center" | "custom">
                  value={typeof selectedMove.anchor === "string" ? selectedMove.anchor : "custom"}
                  options={[
                    ["face", "Face"],
                    ["look", "Look"],
                    ["center", "Centre"],
                    ["custom", "Point"],
                  ]}
                  onChange={(value) =>
                    updateMove(selectedMove.id, {
                      anchor: value === "custom" ? { x: 0.5, y: 0.4 } : value,
                    })
                  }
                />
              </Field>
              {selectedMove.anchor === "look" && !hasFaceTrack ? (
                <p className="text-meta mt-1 text-warn">No face track yet — Look behaves like Face until one exists.</p>
              ) : null}
              {/* A hold is in force for its whole span: no ease, no ramp. */}
              {selectedMove.kind !== "hold" ? (
                <Field label="Ease">
                  <Choice<CameraMove["ease"]>
                    value={selectedMove.ease}
                    options={[
                      ["cut", "Hard"],
                      ["out", "Out"],
                      ["in_out", "In & out"],
                    ]}
                    onChange={(ease) => updateMove(selectedMove.id, { ease })}
                  />
                </Field>
              ) : null}
              {selectedMove.ease !== "cut" && selectedMove.kind !== "hold" ? (
                <Slider
                  label="Ramp"
                  value={moveRampSec(selectedMove)}
                  min={0.05}
                  max={Math.max(0.1, Math.min(3, selectedMove.endSec - selectedMove.startSec))}
                  step={0.05}
                  format={(value) => `${value.toFixed(2)}s`}
                  onChange={(rampSec) => updateMove(selectedMove.id, { rampSec: round3(rampSec) })}
                />
              ) : null}
            </Inspector>
          ) : null}

          {selectedScene ? (
            <Inspector title="Caption scene" icon={Captions} onRemove={() => remove("captions", selectedScene.id)}>
              <input
                value={selectedScene.label ?? ""}
                maxLength={40}
                placeholder="Label"
                aria-label="Scene label"
                onChange={(event) => updateScene(selectedScene.id, { label: event.target.value })}
                className={cn(FIELD, "mt-0")}
              />
              <SpanFields
                startSec={selectedScene.startSec}
                endSec={selectedScene.endSec}
                min={trimStart}
                max={trimEnd}
                onChange={(span) => updateScene(selectedScene.id, span)}
              />
              <p className="text-micro mt-2 text-muted">
                These are the transcript captions in this stretch — their words stay as the Edit desk has them. To place
                them, drag a caption on the preview while the playhead is inside this scene. For extra text of your own,
                add <span className="font-semibold text-fg">Text</span>.
              </p>
              <Field label="Look">
                <select
                  value={selectedScene.styleId ?? ""}
                  onChange={(event) =>
                    updateScene(selectedScene.id, {
                      styleId: event.target.value || undefined,
                      overrides: undefined,
                    })
                  }
                  className={FIELD}
                >
                  <option value="">Clip's own</option>
                  {styles.map((style) => (
                    <option key={style.id} value={style.id} title={style.summary}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-micro mt-2 text-muted">
                {selectedScene.styleId
                  ? `The ${sceneLook.label} look: ${sceneLook.chunkWords} word${sceneLook.chunkWords === 1 ? "" : "s"} at a time, ${sceneLook.fontFamily}.`
                  : `The Edit desk's look: ${sceneLook.chunkWords} word${sceneLook.chunkWords === 1 ? "" : "s"} at a time, ${sceneLook.fontFamily}.`}{" "}
                Fine-tune changes only this scene.
              </p>
              <details
                className="mt-3 rounded-lg border border-border bg-panel-2/40"
                open={Boolean(selectedScene.overrides)}
              >
                <summary className="text-ui cursor-pointer px-3 py-2 font-semibold text-muted">
                  Fine-tune{selectedScene.overrides && Object.keys(selectedScene.overrides).length > 0 ? " · changed" : ""}
                </summary>
                <div className="border-t border-border px-3 pb-3">
                  {selectedScene.overrides && Object.keys(selectedScene.overrides).length > 0 ? (
                    <button
                      type="button"
                      onClick={() => updateScene(selectedScene.id, { overrides: undefined })}
                      className="press text-micro mt-2 rounded border border-border px-2 py-1 font-semibold text-muted hover:border-control hover:text-fg"
                    >
                      Back to the look
                    </button>
                  ) : null}
                  <Field label="Font">
                    <select
                      value={selectedScene.overrides?.fontFamily ?? ""}
                      onChange={(event) =>
                        updateSceneOverrides(selectedScene.id, {
                          fontFamily: event.target.value || undefined,
                        })
                      }
                      className={FIELD}
                    >
                      <option value="">Look's font ({sceneLook.fontFamily})</option>
                      {fontChoices.map((font) => (
                        <option key={font.id} value={font.family} style={{ fontFamily: font.stack }}>
                          {font.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Slider
                    label="Size"
                    value={sceneLook.sizeScale}
                    min={0.6}
                    max={2.2}
                    step={0.05}
                    format={(value) => `${Math.round(value * 100)}%`}
                    onChange={(sizeScale) =>
                      updateSceneOverrides(selectedScene.id, {
                        sizeScale: round3(sizeScale),
                      })
                    }
                  />
                  <Slider
                    label="Across"
                    value={sceneLook.horizontalFrac}
                    min={0.05}
                    max={0.95}
                    step={0.005}
                    format={(value) => `${Math.round(value * 100)}%`}
                    onChange={(horizontalFrac) =>
                      updateSceneOverrides(selectedScene.id, {
                        horizontalFrac: round3(horizontalFrac),
                      })
                    }
                  />
                  <Slider
                    label="Height"
                    value={sceneLook.verticalFrac}
                    min={0.05}
                    max={0.8}
                    step={0.005}
                    format={(value) => `${Math.round(value * 100)}%`}
                    onChange={(verticalFrac) =>
                      updateSceneOverrides(selectedScene.id, {
                        verticalFrac: round3(verticalFrac),
                      })
                    }
                  />
                  <Slider
                    label="Words at a time"
                    value={sceneLook.chunkWords}
                    min={1}
                    max={8}
                    step={1}
                    format={(value) => String(value)}
                    onChange={(chunkWords) => updateSceneOverrides(selectedScene.id, { chunkWords })}
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <ColorControl
                      label="Text"
                      value={sceneLook.textColor}
                      onChange={(textColor) => updateSceneOverrides(selectedScene.id, { textColor })}
                    />
                    <ColorControl
                      label="Accent"
                      value={sceneLook.peakColor}
                      onChange={(peakColor) => updateSceneOverrides(selectedScene.id, { peakColor })}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Check
                      label="Box"
                      checked={sceneLook.background === "box"}
                      onChange={(on) =>
                        updateSceneOverrides(selectedScene.id, {
                          background: on ? "box" : "none",
                        })
                      }
                    />
                    <Check
                      label="Uppercase"
                      checked={sceneLook.uppercase}
                      onChange={(on) => updateSceneOverrides(selectedScene.id, { uppercase: on })}
                    />
                    <Check
                      label="Karaoke"
                      checked={sceneLook.highlight === "word"}
                      onChange={(on) =>
                        updateSceneOverrides(selectedScene.id, {
                          highlight: on ? "word" : "none",
                        })
                      }
                    />
                  </div>
                  <Field label="Entrance">
                    <Choice<"" | "none" | "fade" | "pop">
                      value={selectedScene.overrides?.animation ?? ""}
                      options={[
                        ["", "Look's"],
                        ["none", "None"],
                        ["fade", "Fade"],
                        ["pop", "Pop"],
                      ]}
                      onChange={(value) =>
                        updateSceneOverrides(selectedScene.id, {
                          animation: (value || undefined) as CaptionOverrides["animation"],
                        })
                      }
                    />
                  </Field>
                </div>
              </details>
            </Inspector>
          ) : null}

          {selectedTitle ? (
            <Inspector title="Text" icon={Type} onRemove={() => remove("titles", selectedTitle.id)}>
              <textarea
                value={selectedTitle.text}
                maxLength={120}
                rows={2}
                aria-label="Text"
                placeholder="Type your caption"
                onChange={(event) => updateTitle(selectedTitle.id, { text: event.target.value })}
                className="text-ui w-full resize-y rounded-lg border border-control bg-panel-2 px-2 py-2 font-semibold outline-none focus:border-accent"
              />
              {spokenTextBetween ? (
                <button
                  type="button"
                  onClick={() => {
                    const spoken = spokenTextBetween(selectedTitle.startSec, selectedTitle.endSec);
                    if (spoken) updateTitle(selectedTitle.id, { text: spoken.slice(0, 120) });
                  }}
                  className="press text-micro mt-1.5 inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 font-semibold text-muted hover:border-control hover:text-fg"
                  title="Fill with the transcript words spoken between Start and End (the transcript itself is not changed)"
                >
                  <Captions className="size-3" aria-hidden="true" />
                  Use the words spoken here
                </button>
              ) : null}

              <SectionLabel>When</SectionLabel>
              <SpanFields
                startSec={selectedTitle.startSec}
                endSec={selectedTitle.endSec}
                min={trimStart}
                max={trimEnd}
                onChange={(span) => updateTitle(selectedTitle.id, span)}
              />
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={playhead >= selectedTitle.endSec - 0.1}
                  onClick={() => updateTitle(selectedTitle.id, { startSec: round3(Math.max(trimStart, playhead)) })}
                  className="press text-micro h-7 rounded-md border border-border font-semibold text-muted hover:border-control hover:text-fg disabled:opacity-40"
                >
                  Start at playhead
                </button>
                <button
                  type="button"
                  disabled={playhead <= selectedTitle.startSec + 0.1}
                  onClick={() => updateTitle(selectedTitle.id, { endSec: round3(Math.min(trimEnd, playhead)) })}
                  className="press text-micro h-7 rounded-md border border-border font-semibold text-muted hover:border-control hover:text-fg disabled:opacity-40"
                >
                  End at playhead
                </button>
              </div>

              <SectionLabel>Where</SectionLabel>
              <p className="text-micro text-muted">Drag the text on the preview, or pick a spot:</p>
              <div className="mt-1.5 grid w-28 grid-cols-3 gap-1" role="group" aria-label="Place text">
                {PLACES.map((place) => {
                  const on = Math.abs(selectedTitle.x - place.x) < 0.04 && Math.abs(selectedTitle.y - place.y) < 0.04;
                  return (
                    <button
                      key={place.label}
                      type="button"
                      aria-label={place.label}
                      aria-pressed={on}
                      title={place.label}
                      onClick={() => updateTitle(selectedTitle.id, { x: place.x, y: place.y })}
                      className={cn(
                        "press flex h-7 items-center justify-center rounded border",
                        on ? "border-accent bg-accent/20" : "border-border hover:border-control"
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full", on ? "bg-accent" : "bg-muted")} />
                    </button>
                  );
                })}
              </div>
              <Slider
                label="Size"
                value={selectedTitle.sizeScale}
                min={0.4}
                max={3}
                step={0.05}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(sizeScale) => updateTitle(selectedTitle.id, { sizeScale: round3(sizeScale) })}
              />
              <Slider
                label="Tilt"
                value={selectedTitle.rotation ?? 0}
                min={-45}
                max={45}
                step={1}
                format={(value) => (value === 0 ? "straight" : `${value > 0 ? "+" : ""}${value}°`)}
                onChange={(rotation) => updateTitle(selectedTitle.id, { rotation: rotation === 0 ? undefined : rotation })}
              />
              <Field label="Layer">
                <Choice<BehindTitle["depth"]>
                  value={selectedTitle.depth}
                  options={[
                    ["front", "In front"],
                    ["behind", "Behind speaker"],
                  ]}
                  onChange={(depth) => updateTitle(selectedTitle.id, { depth })}
                />
              </Field>

              <SectionLabel>Look</SectionLabel>
              <Field label="Font">
                <select
                  value={selectedTitle.fontFamily ?? ""}
                  onChange={(event) =>
                    updateTitle(selectedTitle.id, {
                      fontFamily: event.target.value || undefined,
                    })
                  }
                  className={FIELD}
                >
                  <option value="">Anton</option>
                  {fontChoices.map((font) => (
                    <option key={font.id} value={font.family} style={{ fontFamily: font.stack }}>
                      {font.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <ColorControl
                  label="Colour"
                  value={selectedTitle.color}
                  onChange={(color) => updateTitle(selectedTitle.id, { color })}
                />
                <Check
                  label="Uppercase"
                  checked={selectedTitle.uppercase === true}
                  onChange={(on) => updateTitle(selectedTitle.id, { uppercase: on })}
                />
                <Check
                  label="Background box"
                  checked={Boolean(selectedTitle.box)}
                  onChange={(on) => updateTitle(selectedTitle.id, { box: on ? { color: "#000000", opacity: 0.7 } : undefined })}
                />
              </div>
              {selectedTitle.box ? (
                <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
                  <ColorControl
                    label="Box"
                    value={selectedTitle.box.color}
                    onChange={(color) => updateTitle(selectedTitle.id, { box: { ...selectedTitle.box!, color } })}
                  />
                  <div className="min-w-40 flex-1">
                    <Slider
                      label="Box opacity"
                      value={selectedTitle.box.opacity}
                      min={0.1}
                      max={1}
                      step={0.05}
                      format={(value) => `${Math.round(value * 100)}%`}
                      onChange={(opacity) => updateTitle(selectedTitle.id, { box: { ...selectedTitle.box!, opacity: round3(opacity) } })}
                    />
                  </div>
                </div>
              ) : (
                <Slider
                  label="Outline"
                  value={selectedTitle.outline ?? 1}
                  min={0}
                  max={2}
                  step={0.1}
                  format={(value) => (value === 0 ? "off" : `${Math.round(value * 100)}%`)}
                  onChange={(outline) => updateTitle(selectedTitle.id, { outline: Math.abs(outline - 1) < 0.001 ? undefined : round3(outline) })}
                />
              )}

              <SectionLabel>Animation</SectionLabel>
              <Field label="Comes in">
                <ChipGrid<TextEnter>
                  value={selectedTitle.animation}
                  options={ENTER_CHOICES}
                  onChange={(animation) => updateTitle(selectedTitle.id, { animation, enterSec: undefined })}
                />
              </Field>
              {selectedTitle.animation !== "none" ? (
                <Slider
                  label={selectedTitle.animation === "words" ? "Reveal takes" : "Takes"}
                  value={textSchedule(selectedTitle).enterEnd}
                  min={0.05}
                  max={Math.max(0.1, Math.min(3, (selectedTitle.endSec - selectedTitle.startSec) * 0.9))}
                  step={0.05}
                  format={(value) => `${value.toFixed(2)}s`}
                  onChange={(enterSec) => updateTitle(selectedTitle.id, { enterSec: round3(enterSec) })}
                />
              ) : null}
              <Field label="While on screen">
                <ChipGrid<TextMotion>
                  value={selectedTitle.motion ?? "none"}
                  options={MOTION_CHOICES}
                  onChange={(motion) => updateTitle(selectedTitle.id, { motion: motion === "none" ? undefined : motion })}
                />
              </Field>
              <Field label="Goes out">
                <ChipGrid<TextExit>
                  value={exitOf(selectedTitle)}
                  options={EXIT_CHOICES}
                  onChange={(exit) => updateTitle(selectedTitle.id, { exit, exitSec: undefined })}
                />
              </Field>
              {exitOf(selectedTitle) !== "none" ? (
                <Slider
                  label="Takes"
                  value={(() => {
                    const schedule = textSchedule(selectedTitle);
                    return round3(schedule.duration - schedule.exitStart);
                  })()}
                  min={0.05}
                  max={Math.max(0.1, Math.min(3, (selectedTitle.endSec - selectedTitle.startSec) * 0.9))}
                  step={0.05}
                  format={(value) => `${value.toFixed(2)}s`}
                  onChange={(exitSec) => updateTitle(selectedTitle.id, { exit: exitOf(selectedTitle), exitSec: round3(exitSec) })}
                />
              ) : null}
              {onPlayFrom ? (
                <button
                  type="button"
                  onClick={() => onPlayFrom(Math.max(trimStart, selectedTitle.startSec - 0.4))}
                  className="press text-ui mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-control font-semibold hover:border-accent"
                >
                  <Play className="size-3.5 fill-current" aria-hidden="true" />
                  Play this text
                </button>
              ) : null}
              <SpanPreview
                key={selectedTitle.id}
                startSec={selectedTitle.startSec}
                endSec={selectedTitle.endSec}
                onRender={onPreviewSpan}
              />
            </Inspector>
          ) : null}

          {selectedHit ? (
            <Inspector
              title={sfxLabels.get(selectedHit.assetId) ?? "Sound effect"}
              icon={Volume2}
              onRemove={() => remove("sfx", selectedHit.id)}
            >
              <div className="grid grid-cols-2 gap-2">
                <TimestampInput
                  label="At"
                  value={selectedHit.atSec}
                  min={0}
                  max={Math.max(0.05, outputDuration(windows))}
                  onChange={(atSec) => updateHit(selectedHit.id, { atSec })}
                />
                <button
                  type="button"
                  onClick={() => audition(selectedHit.assetId)}
                  className="press text-ui mt-auto inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-control bg-panel-2 px-2 hover:border-accent"
                >
                  <Play className="size-3.5 fill-current" aria-hidden="true" />
                  Hear it
                </button>
              </div>
              <Field label="Sound">
                <SfxPicker
                  assets={sfxAssets}
                  value={selectedHit.assetId}
                  onPick={(assetId) => {
                    updateHit(selectedHit.id, { assetId });
                    rememberSfx(assetId);
                  }}
                />
              </Field>
              <Slider
                label="Level"
                value={selectedHit.gain ?? 0.9}
                min={0}
                max={1.5}
                step={0.05}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(gain) => updateHit(selectedHit.id, { gain: round3(gain) })}
              />
            </Inspector>
          ) : null}

        </>
      ) : null}

      {tab === "director" ? (
        <DirectorPanel
          director={plan.director}
          hasPlan={Boolean(plan.director?.generatedAt)}
          disabled={!sourceReady}
          stock={stockSources.length > 0}
          sense={sense}
          review={review}
          rendered={rendered}
          onDirect={onDirect}
          onFeedback={onDirectorFeedback}
          onSense={onSense}
          onReview={onReview}
        />
      ) : null}

      {tab === "studio" ? (
        <StudioPanel
          mediaLibrary={mediaLibrary}
          audioLibrary={library}
          onMediaChanged={onMediaChanged}
          onAudioChanged={onAudioChanged}
          onPlaceCutaway={onPlaceCutaway}
          onAddBed={(assetId) =>
            onSoundtrackChange({ ...soundtrack, beds: [...musicBeds(soundtrack), { id: newBedId(), assetId }].slice(0, MAX_MUSIC_BEDS) })
          }
        />
      ) : null}

      {tab === "clip" ? (
        <>
          <Panel
            title="Creator effects"
            icon={Wand2}
            actions={
              <div className="flex w-32 gap-1">
                <SegmentedButton active={plan.enabled} onClick={() => setEnabled(true)} label="On" />
                <SegmentedButton active={!plan.enabled} onClick={() => setEnabled(false)} label="Off" />
              </div>
            }
          >
            <p className="text-meta text-muted">
              {plan.enabled
                ? `Everything on the timeline renders.${removed > 0.05 ? ` Cuts remove ${removed.toFixed(1)}s.` : ""}`
                : "Off: the clip renders with the Edit desk only. Nothing is deleted."}
            </p>
          </Panel>

          {plan.enabled ? (
            <>
              <Panel
                title="Dead air"
                icon={Scissors}
                actions={
                  cuts.length > 0 ? (
                    <span className="flex items-center gap-2">
                      <span className="num text-micro text-muted">
                        {applied}/{cuts.length}
                        {removed > 0.05 ? ` · −${removed.toFixed(1)}s` : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          patch({
                            cuts: cuts.map((cut) => ({ ...cut, enabled: true })),
                          })
                        }
                        className="text-micro font-semibold text-accent"
                      >
                        All
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          patch({
                            cuts: cuts.map((cut) => ({ ...cut, enabled: false })),
                          })
                        }
                        className="text-micro font-semibold text-muted"
                      >
                        None
                      </button>
                    </span>
                  ) : null
                }
              >
                <button
                  type="button"
                  disabled={detecting}
                  onClick={() => void detectPauses()}
                  title={
                    sourceReady
                      ? "Word gaps confirmed against the audio"
                      : "Word gaps only — the source is not on this machine yet"
                  }
                  className="press text-ui inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-control px-2 font-semibold text-muted hover:border-accent disabled:opacity-50"
                >
                  {detecting ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Mic className="size-3.5" aria-hidden="true" />
                  )}
                  {detecting
                    ? "Listening…"
                    : cuts.some((cut) => cut.source === "director")
                      ? "Find again"
                      : "Find dead air"}
                </button>
                {detectNote ? <p className="text-meta mt-1 text-muted">{detectNote}</p> : null}
                {cuts.length > 0 ? (
                  <ul className="mt-2 max-h-44 space-y-0.5 overflow-y-auto pr-1">
                    {cuts.map((cut) => (
                      <li
                        key={cut.id}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-1.5 py-0.5",
                          selected?.lane === "cuts" && selected.id === cut.id ? "bg-accent/10" : "hover:bg-panel-2"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={cut.enabled}
                          onChange={(event) => updateCut(cut.id, { enabled: event.target.checked })}
                          className="size-4 accent-accent"
                          aria-label={`Apply cut at ${timecode(cut.startSec)}`}
                        />
                        <button
                          type="button"
                          onClick={() => onSelect({ lane: "cuts", id: cut.id })}
                          className="num text-meta flex flex-1 items-center justify-between text-left text-muted hover:text-fg"
                        >
                          <span>{timecode(cut.startSec)}</span>
                          <span>
                            −{(cut.endSec - cut.startSec).toFixed(2)}s{cut.source === "user" ? " ·" : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Panel>

              <Panel
                title="Camera follow"
                icon={Camera}
                actions={
                  <div className="flex w-32 gap-1">
                    <SegmentedButton
                      active={follow?.enabled === true}
                      onClick={() =>
                        patch({
                          camera: {
                            moves,
                            follow: {
                              enabled: true,
                              tightness: follow?.tightness ?? 0.85,
                              zoom: Math.max(FOLLOW_MIN_ZOOM, follow?.zoom ?? 1.18),
                            },
                          },
                        })
                      }
                      label="On"
                    />
                    <SegmentedButton
                      active={follow?.enabled !== true}
                      onClick={() =>
                        patch({
                          camera: {
                            moves,
                            follow: {
                              ...(follow ?? { tightness: 0.6 }),
                              enabled: false,
                            },
                          },
                        })
                      }
                      label="Off"
                    />
                  </div>
                }
              >
                {follow?.enabled ? (
                  <>
                    <Slider
                      label="Tightness"
                      value={follow.tightness}
                      min={0}
                      max={1}
                      step={0.05}
                      format={(value) => `${Math.round(value * 100)}%`}
                      onChange={(tightness) =>
                        patch({
                          camera: {
                            moves,
                            follow: { ...follow, tightness: round3(tightness) },
                          },
                        })
                      }
                    />
                    <Slider
                      label="Zoom"
                      value={Math.max(FOLLOW_MIN_ZOOM, follow.zoom ?? FOLLOW_MIN_ZOOM)}
                      min={FOLLOW_MIN_ZOOM}
                      max={MAX_FOLLOW_ZOOM}
                      step={0.01}
                      format={(value) => `${Math.round((value - 1) * 100)}%`}
                      onChange={(zoom) => patch({ camera: { moves, follow: { ...follow, zoom: round3(zoom) } } })}
                    />
                    <Field label="Response">
                      <Choice<FollowResponse>
                        value={follow.response ?? "natural"}
                        options={[
                          ["snappy", "Snappy"],
                          ["natural", "Natural"],
                          ["smooth", "Smooth"],
                        ]}
                        onChange={(response) => patch({ camera: { moves, follow: { ...follow, response } } })}
                      />
                    </Field>
                    <Slider
                      label="Lead room"
                      value={follow.lead ?? 0}
                      min={0}
                      max={1}
                      step={0.05}
                      format={(value) => (value > 0 ? `${Math.round(value * 100)}%` : "off")}
                      onChange={(lead) =>
                        patch({ camera: { moves, follow: { ...follow, lead: lead > 0 ? round3(lead) : undefined } } })
                      }
                    />
                    <Field label="Follow">
                      <Choice<FollowAxis>
                        value={follow.axis ?? "both"}
                        options={[
                          ["both", "Both ways"],
                          ["x", "Across"],
                          ["y", "Up & down"],
                        ]}
                        onChange={(axis) => patch({ camera: { moves, follow: { ...follow, axis } } })}
                      />
                    </Field>
                    {!hasFaceTrack ? (
                      <p className="text-meta mt-2 text-warn">
                        No face track yet — smart reframe runs first, then follow takes over.
                      </p>
                    ) : headTravel ? (
                      <p className="text-meta mt-2 text-muted">
                        Head travel in this clip: {Math.round(headTravel.x * 100)}% across, {Math.round(headTravel.y * 100)}
                        % up.
                        {headTravel.x < 0.03 && headTravel.y < 0.03 ? " A still speaker — expect a gentle drift." : ""}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-meta text-muted">Pins the head to the frame; the room moves around it.</p>
                )}
              </Panel>

              <Panel
                title="Music"
                icon={Music}
                actions={
                  <span className="flex gap-1">
                    <UploadButton kind="sfx" busy={uploading === "sfx"} onPick={(file) => void upload(file, "sfx")} />
                    <UploadButton kind="music" busy={uploading === "music"} onPick={(file) => void upload(file, "music")} />
                  </span>
                }
              >
                <MusicBedsEditor
                  soundtrack={soundtrack}
                  onChange={onSoundtrackChange}
                  assets={musicAssets}
                  localTime={sourceToOutput(windows, playhead)}
                  clipEndSec={Math.max(0.1, outputDuration(windows))}
                  outroSec={outroSec}
                />
                {uploadError ? <p className="text-meta mt-2 text-bad">{uploadError}</p> : null}
              </Panel>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

// ---- rail tabs ----

type RailTab = "edit" | "clip" | "director" | "studio";

const RAIL_TAB_KEY = "clipperos.createTab";

function readRailTab(): RailTab {
  try {
    const saved = window.localStorage.getItem(RAIL_TAB_KEY);
    return saved === "clip" || saved === "director" || saved === "studio" ? saved : "edit";
  } catch {
    return "edit";
  }
}

function rememberRailTab(tab: RailTab): void {
  try {
    window.localStorage.setItem(RAIL_TAB_KEY, tab);
  } catch {
    // Private mode: the rail opens on "Add & edit".
  }
}

const RAIL_TABS: { id: RailTab; label: string; icon: typeof Plus; hint: string }[] = [
  { id: "edit", label: "Add & edit", icon: Plus, hint: "Add beats at the playhead, edit the one selected on the timeline" },
  { id: "clip", label: "Whole clip", icon: SlidersHorizontal, hint: "Settings for the whole clip: camera follow, dead air, music" },
  { id: "director", label: "Director", icon: Clapperboard, hint: "Let the AI watch the clip and build or change the plan from a note" },
  { id: "studio", label: "Studio", icon: Sparkles, hint: "Make stills, motion and music to order; see what the Director has learned" },
];

/** Three places, one at a time: what you are adding or editing, the clip as a whole, the Director. */
function RailTabs({
  value,
  onChange,
  anchorRef,
}: {
  value: RailTab;
  onChange: (tab: RailTab) => void;
  anchorRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={anchorRef} role="tablist" aria-label="Create" className="sticky top-0 z-10 grid grid-cols-4 gap-1 rounded-xl border border-border bg-panel p-1">
      {RAIL_TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          title={item.hint}
          onClick={() => onChange(item.id)}
          className={cn(
            "press text-ui inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-1 font-semibold",
            value === item.id ? "bg-panel-2 text-fg shadow-sm" : "text-muted hover:text-fg"
          )}
        >
          <item.icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---- inspector pieces ----

function Inspector({
  title,
  icon,
  onRemove,
  children,
}: {
  title: string;
  icon: typeof Scissors;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <Panel
      title={title}
      icon={icon}
      actions={
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${title.toLowerCase()}`}
          title="Remove (Delete)"
          className="press inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-bad/15 hover:text-bad"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      }
    >
      {children}
    </Panel>
  );
}

function UploadButton({
  kind,
  busy,
  onPick,
}: {
  kind: "music" | "sfx";
  busy: boolean;
  onPick: (file: File | undefined) => void;
}) {
  return (
    <label
      title={kind === "music" ? "Upload a music bed" : "Upload a sound effect"}
      className={cn(
        "press text-micro inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border px-2 font-semibold text-muted hover:border-control hover:text-fg",
        busy && "opacity-50"
      )}
    >
      {busy ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Upload className="size-3" aria-hidden="true" />}
      {kind === "music" ? "Music" : "SFX"}
      <input
        type="file"
        accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg"
        disabled={busy}
        className="sr-only"
        onChange={(event) => {
          onPick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </label>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <span className="text-micro text-muted">{label}</span>
      {children}
    </div>
  );
}

/** A row of segmented buttons for a small enum. */
function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="mt-1 flex gap-1">
      {options.map(([key, label]) => (
        <SegmentedButton key={key} active={value === key} onClick={() => onChange(key)} label={label} />
      ))}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-accent"
      />
      <span className="text-ui text-muted">{label}</span>
    </label>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="eyebrow mt-4 border-t border-border pt-3 text-muted">{children}</p>;
}

/** Many options that wrap, for animation lists too long for a segmented row. */
function ChipGrid<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={cn(
            "press text-micro h-7 rounded-md border px-2 font-semibold",
            value === key ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:border-control hover:text-fg"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Quick placements for Text: a 3×3 grid over the frame. */
const PLACES: { label: string; x: number; y: number }[] = [
  { label: "Top left", x: 0.25, y: 0.15 },
  { label: "Top", x: 0.5, y: 0.15 },
  { label: "Top right", x: 0.75, y: 0.15 },
  { label: "Left", x: 0.25, y: 0.5 },
  { label: "Middle", x: 0.5, y: 0.5 },
  { label: "Right", x: 0.75, y: 0.5 },
  { label: "Bottom left", x: 0.25, y: 0.8 },
  { label: "Bottom", x: 0.5, y: 0.8 },
  { label: "Bottom right", x: 0.75, y: 0.8 },
];

const ENTER_CHOICES: [TextEnter, string][] = [
  ["none", "Cut in"],
  ["pop", "Pop"],
  ["fade", "Fade"],
  ["rise", "Rise"],
  ["zoom_in", "Zoom in"],
  ["zoom_out", "Zoom out"],
  ["slide_left", "From right"],
  ["slide_right", "From left"],
  ["slide_up", "From below"],
  ["slide_down", "From above"],
  ["drop", "Drop"],
  ["words", "Word by word"],
];

const MOTION_CHOICES: [TextMotion, string][] = [
  ["none", "Still"],
  ["grow", "Slow zoom in"],
  ["shrink", "Slow zoom out"],
  ["pulse", "Pulse"],
  ["wiggle", "Wiggle"],
  ["float", "Float"],
];

const EXIT_CHOICES: [TextExit, string][] = [
  ["none", "Cut out"],
  ["fade", "Fade"],
  ["pop", "Pop"],
  ["zoom_in", "Zoom in"],
  ["zoom_out", "Zoom out"],
  ["slide_left", "To left"],
  ["slide_right", "To right"],
  ["slide_up", "Up"],
  ["slide_down", "Down"],
  ["sink", "Sink"],
];

function SpanFields({
  startSec,
  endSec,
  min,
  max,
  onChange,
}: {
  startSec: number;
  endSec: number;
  min: number;
  max: number;
  onChange: (span: { startSec?: number; endSec?: number }) => void;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      <TimestampInput
        label="Start"
        value={startSec}
        min={min}
        max={endSec - 0.05}
        onChange={(value) => onChange({ startSec: value })}
      />
      <TimestampInput
        label="End"
        value={endSec}
        min={startSec + 0.05}
        max={max}
        onChange={(value) => onChange({ endSec: value })}
      />
    </div>
  );
}

/**
 * "Render this span": the exact burn of a stretch, played beside the live
 * approximation. Rendered on demand (a second or two), cached by the server.
 */
function SpanPreview({
  startSec,
  endSec,
  onRender,
}: {
  startSec: number;
  endSec: number;
  onRender: (startSec: number, endSec: number) => Promise<{ url: string; durationSec: number }>;
}) {
  const [state, setState] = useState<{ status: "idle" } | { status: "busy" } | { status: "ready"; url: string } | { status: "error"; message: string }>({
    status: "idle",
  });
  // Half a second either side, so the way in and out of the look is visible too.
  const from = Math.max(0, startSec - 0.5);
  const to = endSec + 0.5;
  async function run() {
    setState({ status: "busy" });
    try {
      const result = await onRender(from, to);
      setState({ status: "ready", url: `${result.url}?t=${Date.now()}` });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={state.status === "busy"}
        onClick={() => void run()}
        className="press text-ui inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-control bg-panel-2 px-2 hover:border-accent disabled:opacity-50"
      >
        {state.status === "busy" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-3.5 fill-current" aria-hidden="true" />}
        {state.status === "busy" ? "Rendering…" : state.status === "ready" ? "Render again" : "Render this span (exact)"}
      </button>
      {state.status === "ready" ? (
        <video src={state.url} controls autoPlay loop muted playsInline className="mt-2 w-full rounded-md border border-border bg-black" />
      ) : null}
      {state.status === "error" ? <p className="text-meta mt-2 text-bad">{state.message}</p> : null}
      <p className="text-micro mt-1 text-muted">The player approximates looks; this is the burn itself, half a second either side.</p>
    </div>
  );
}

/** One edge of a cutaway: which transition, and how long it takes. */
function TransitionField({
  label,
  edge,
  transitions,
  onChange,
}: {
  label: string;
  edge: Cutaway["in"];
  transitions: TransitionInfo[];
  onChange: (edge: Cutaway["in"]) => void;
}) {
  return (
    <div>
      <span className="text-micro text-muted">{label}</span>
      <select
        value={edge.transitionId}
        aria-label={`${label} transition`}
        onChange={(event) => onChange({ ...edge, transitionId: event.target.value })}
        className={cn(FIELD, "mt-1")}
      >
        {transitions.length === 0 ? <option value={edge.transitionId}>{edge.transitionId}</option> : null}
        {transitions.map((transition) => (
          <option key={transition.id} value={transition.id} title={transition.summary}>
            {transition.label}
          </option>
        ))}
      </select>
      {edge.transitionId !== "cut" ? (
        <input
          type="range"
          min={0.1}
          max={MAX_TRANSITION_SEC}
          step={0.05}
          value={edge.sec}
          aria-label={`${label} transition length`}
          onChange={(event) => onChange({ ...edge, sec: round3(Number(event.target.value)) })}
          className="mt-1 w-full"
        />
      ) : null}
      {edge.transitionId !== "cut" ? <span className="text-micro text-muted">{edge.sec.toFixed(2)}s</span> : null}
    </div>
  );
}
