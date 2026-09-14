import { useMemo, useState, type ReactNode } from "react";
import { Camera, Captions, Loader2, Mic, Music, Play, Scissors, Trash2, Type, Upload, Volume2, Wand2 } from "lucide-react";
import {
  api,
  MAX_CAMERA_ZOOM,
  MAX_FOLLOW_ZOOM,
  type AudioAsset,
  type BehindTitle,
  type CameraMove,
  type CaptionFontInfo,
  type CaptionOverrides,
  type CaptionScene,
  type CaptionStyleInfo,
  type CreatorPlan,
  type DirectorLane,
  type PauseCandidate,
  type PauseCut,
  type Soundtrack,
  type SoundtrackHit,
  type FollowAxis,
  type FollowResponse,
  type VideoEffects,
} from "@/api";
import { enablePlan, removeBeat, type BeatLane } from "@/lib/beat-plan";
import { FOLLOW_MIN_ZOOM, outputDuration, type TimeWindow } from "@/lib/creator-timeline";
import { cn, timecode } from "@/lib/utils";
import type { BeatSelection } from "./BeatTimeline";
import { DirectorPanel } from "./DirectorPanel";
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
  fonts: CaptionFontInfo[];
  /** The clip-wide motion, migrated into a move when creator mode turns on. */
  videoEffects: VideoEffects;
  selected: BeatSelection | null;
  onSelect: (selection: BeatSelection | null) => void;
  /** Whether the reframe track carries face positions (needed for follow). */
  hasFaceTrack: boolean;
  /** How far the head moves within a shot, as fractions of the frame — what follow has to work with. */
  headTravel?: { x: number; y: number };
  /** Built-in and uploaded audio: beds for the Sound panel, one-shots for the SFX lane. */
  audioLibrary: AudioAsset[];
  /** Upload a file into the shared library; the editor refreshes `audioLibrary`. */
  onUploadAudio: (file: File, kind: "music" | "sfx") => Promise<void>;
  /** Flush the draft, run the Director, adopt its plan. Rejects with a message. */
  onDirect: (input: { notes?: string; keep: DirectorLane[] }) => Promise<void>;
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
  fonts,
  videoEffects,
  selected,
  onSelect,
  hasFaceTrack,
  headTravel,
  audioLibrary: library,
  onUploadAudio,
  onDirect,
}: CreatorDeskProps) {
  const [detecting, setDetecting] = useState(false);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState<"music" | "sfx" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const sfx = soundtrack.sfx ?? [];
  const onSfxChange = (hits: SoundtrackHit[]) => onSoundtrackChange({ ...soundtrack, sfx: hits });
  const sfxAssets = useMemo(() => library.filter((asset) => asset.kind === "sfx"), [library]);
  const musicAssets = useMemo(() => library.filter((asset) => asset.kind === "music"), [library]);

  function setMusic(assetId: string | null) {
    if (!assetId) {
      const next = { ...soundtrack };
      delete next.music;
      onSoundtrackChange(next);
      return;
    }
    onSoundtrackChange({
      ...soundtrack,
      music: {
        assetId,
        gain: soundtrack.music?.gain ?? 0.22,
        duck: soundtrack.music?.duck ?? true,
        carryIntoOutro: soundtrack.music?.carryIntoOutro,
      },
    });
  }

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
  const selectedScene = selected?.lane === "captions" ? scenes.find((scene) => scene.id === selected.id) : undefined;
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

  return (
    <>
      <Panel
        title="Beat plan"
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
            ? `${moves.length} camera · ${scenes.length} caption ${scenes.length === 1 ? "scene" : "scenes"} · ${titles.length} ${titles.length === 1 ? "title" : "titles"} · ${sfx.length} SFX${removed > 0.05 ? ` · −${removed.toFixed(1)}s` : ""}`
            : "Renders with the Edit desk only."}
        </p>
      </Panel>

      {plan.enabled && selectedCut ? (
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

      {plan.enabled && selectedMove ? (
        <Inspector title="Camera move" icon={Camera} onRemove={() => remove("camera", selectedMove.id)}>
          <Choice<CameraMove["kind"]>
            value={selectedMove.kind}
            options={[
              ["punch", "Punch in"],
              ["push", "Slow push"],
              ["pull", "Hook pull"],
            ]}
            onChange={(kind) => updateMove(selectedMove.id, { kind })}
          />
          <SpanFields
            startSec={selectedMove.startSec}
            endSec={selectedMove.endSec}
            min={trimStart}
            max={trimEnd}
            onChange={(span) => updateMove(selectedMove.id, span)}
          />
          <Slider
            label="Zoom"
            value={selectedMove.zoom}
            min={1.02}
            max={MAX_CAMERA_ZOOM}
            step={0.01}
            format={(value) => `${Math.round((value - 1) * 100)}%${value > 1.35 ? " · soft" : ""}`}
            onChange={(zoom) => updateMove(selectedMove.id, { zoom: round3(zoom) })}
          />
          <Field label="Anchor">
            <Choice<"face" | "center" | "custom">
              value={typeof selectedMove.anchor === "string" ? selectedMove.anchor : "custom"}
              options={[
                ["face", "Face"],
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
          {typeof selectedMove.anchor === "object" ? (
            <>
              <Slider
                label="Across"
                value={selectedMove.anchor.x}
                min={0}
                max={1}
                step={0.01}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(x) =>
                  updateMove(selectedMove.id, {
                    anchor: {
                      ...(selectedMove.anchor as { x: number; y: number }),
                      x: round3(x),
                    },
                  })
                }
              />
              <Slider
                label="Down"
                value={selectedMove.anchor.y}
                min={0}
                max={1}
                step={0.01}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(y) =>
                  updateMove(selectedMove.id, {
                    anchor: {
                      ...(selectedMove.anchor as { x: number; y: number }),
                      y: round3(y),
                    },
                  })
                }
              />
            </>
          ) : null}
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
        </Inspector>
      ) : null}

      {plan.enabled && selectedScene ? (
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
          <details
            className="mt-3 rounded-lg border border-border bg-panel-2/40"
            open={Boolean(selectedScene.overrides)}
          >
            <summary className="text-ui cursor-pointer px-3 py-2 font-semibold text-muted">Fine-tune</summary>
            <div className="border-t border-border px-3 pb-3">
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
                  <option value="">Look's font</option>
                  {fontChoices.map((font) => (
                    <option key={font.id} value={font.family} style={{ fontFamily: font.stack }}>
                      {font.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Slider
                label="Size"
                value={selectedScene.overrides?.sizeScale ?? 1}
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
                label="Height"
                value={selectedScene.overrides?.verticalFrac ?? 0.25}
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
                value={selectedScene.overrides?.chunkWords ?? 3}
                min={1}
                max={8}
                step={1}
                format={(value) => String(value)}
                onChange={(chunkWords) => updateSceneOverrides(selectedScene.id, { chunkWords })}
              />
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <ColorControl
                  label="Text"
                  value={selectedScene.overrides?.textColor ?? "#ffffff"}
                  onChange={(textColor) => updateSceneOverrides(selectedScene.id, { textColor })}
                />
                <ColorControl
                  label="Accent"
                  value={selectedScene.overrides?.peakColor ?? "#fde047"}
                  onChange={(peakColor) => updateSceneOverrides(selectedScene.id, { peakColor })}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Check
                  label="Box"
                  checked={selectedScene.overrides?.background === "box"}
                  onChange={(on) =>
                    updateSceneOverrides(selectedScene.id, {
                      background: on ? "box" : "none",
                    })
                  }
                />
                <Check
                  label="Uppercase"
                  checked={selectedScene.overrides?.uppercase === true}
                  onChange={(on) => updateSceneOverrides(selectedScene.id, { uppercase: on })}
                />
                <Check
                  label="Karaoke"
                  checked={selectedScene.overrides?.highlight === "word"}
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

      {plan.enabled && selectedTitle ? (
        <Inspector title="Title" icon={Type} onRemove={() => remove("titles", selectedTitle.id)}>
          <input
            value={selectedTitle.text}
            maxLength={120}
            aria-label="Title text"
            onChange={(event) => updateTitle(selectedTitle.id, { text: event.target.value })}
            className={cn(FIELD, "mt-0 font-semibold")}
          />
          <div className="mt-2">
            <Choice<BehindTitle["depth"]>
              value={selectedTitle.depth}
              options={[
                ["behind", "Behind speaker"],
                ["front", "In front"],
              ]}
              onChange={(depth) => updateTitle(selectedTitle.id, { depth })}
            />
          </div>
          <SpanFields
            startSec={selectedTitle.startSec}
            endSec={selectedTitle.endSec}
            min={trimStart}
            max={trimEnd}
            onChange={(span) => updateTitle(selectedTitle.id, span)}
          />
          <Slider
            label="Across"
            value={selectedTitle.x}
            min={0.05}
            max={0.95}
            step={0.005}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(x) => updateTitle(selectedTitle.id, { x: round3(x) })}
          />
          <Slider
            label="Down"
            value={selectedTitle.y}
            min={0.05}
            max={0.95}
            step={0.005}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(y) => updateTitle(selectedTitle.id, { y: round3(y) })}
          />
          <Slider
            label="Size"
            value={selectedTitle.sizeScale}
            min={0.4}
            max={3}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(sizeScale) => updateTitle(selectedTitle.id, { sizeScale: round3(sizeScale) })}
          />
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
          </div>
          <Field label="Entrance">
            <Choice<BehindTitle["animation"]>
              value={selectedTitle.animation}
              options={[
                ["none", "None"],
                ["pop", "Pop"],
                ["fade", "Fade"],
                ["rise", "Rise"],
              ]}
              onChange={(animation) => updateTitle(selectedTitle.id, { animation })}
            />
          </Field>
        </Inspector>
      ) : null}

      {plan.enabled && selectedHit ? (
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

      <DirectorPanel
        director={plan.director}
        hasPlan={Boolean(plan.director?.generatedAt)}
        disabled={!sourceReady}
        onDirect={onDirect}
      />

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
            title="Sound"
            icon={Music}
            actions={
              <span className="flex gap-1">
                <UploadButton kind="sfx" busy={uploading === "sfx"} onPick={(file) => void upload(file, "sfx")} />
                <UploadButton kind="music" busy={uploading === "music"} onPick={(file) => void upload(file, "music")} />
              </span>
            }
          >
            <select
              value={soundtrack.music?.assetId ?? ""}
              aria-label="Music bed"
              onChange={(event) => setMusic(event.target.value || null)}
              className={cn(FIELD, "mt-0")}
            >
              <option value="">No music</option>
              <AssetOptions assets={musicAssets} />
            </select>
            {soundtrack.music?.assetId ? (
              <Slider
                label="Bed level"
                value={soundtrack.music.gain ?? 0.22}
                min={0}
                max={0.8}
                step={0.02}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(gain) =>
                  onSoundtrackChange({ ...soundtrack, music: { ...soundtrack.music!, gain: round3(gain) } })
                }
              />
            ) : null}
            {uploadError ? <p className="text-meta mt-2 text-bad">{uploadError}</p> : null}
          </Panel>
        </>
      ) : null}
    </>
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

/** Built-ins first, then the shared uploads, so a pack you added is easy to find. */
function AssetOptions({ assets }: { assets: AudioAsset[] }) {
  const builtin = assets.filter((asset) => !asset.id.startsWith("custom:"));
  const custom = assets.filter((asset) => asset.id.startsWith("custom:"));
  if (custom.length === 0) {
    return (
      <>
        {builtin.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.label}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      <optgroup label="Yours">
        {custom.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Built in">
        {builtin.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.label}
          </option>
        ))}
      </optgroup>
    </>
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
