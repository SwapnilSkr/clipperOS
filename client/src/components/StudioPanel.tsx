import { useEffect, useMemo, useState } from "react";
import { Brain, Clapperboard, Image as ImageIcon, Loader2, Music, Sparkles, Trash2, Zap } from "lucide-react";
import { api, mediaThumbUrl, type AudioAsset, type DirectorLesson, type GenerationJob, type GenerationKind, type MediaAsset } from "@/api";
import { cn } from "@/lib/utils";
import { Panel } from "./editor-controls";

// ============================================================
// STUDIO — pictures, motion and music made to order, and the Director's memory.
//
// Everything generated lands in the shared libraries (a still or a video in
// the media library, a bed in the audio library), described by the harness
// on arrival, so it is reusable in any project and the Director can pick it
// by what it is. A still can be animated into a motion asset ("Animate"):
// the image becomes the first frame of a short video. Videos render for
// minutes; the job list polls while any is running.
//
// The memory is what the Director has learned: from your edits after a
// pass, from renders it reviewed, and from thumbs up / down. Rules can be
// written here directly and any lesson can be forgotten.
// ============================================================

const FIELD = "text-ui h-10 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent";

const KINDS: { id: GenerationKind; label: string; icon: typeof ImageIcon; hint: string }[] = [
  { id: "image", label: "Still", icon: ImageIcon, hint: "A picture for a cutaway; ~10 s" },
  { id: "video", label: "Motion", icon: Clapperboard, hint: "5–15 s of video from a prompt or a still; minutes" },
  { id: "music", label: "Music", icon: Music, hint: "A bed to sit under the voice; ~20 s" },
  { id: "sfx", label: "SFX", icon: Zap, hint: "A one-shot hit at a set length, on fal.ai (needs FAL_KEY); ~10 s, about two cents" },
];

export function StudioPanel({
  mediaLibrary,
  audioLibrary,
  onMediaChanged,
  onAudioChanged,
  onPlaceCutaway,
  onAddBed,
  onPlaceHit,
}: {
  mediaLibrary: MediaAsset[];
  audioLibrary: AudioAsset[];
  onMediaChanged: () => Promise<void> | void;
  onAudioChanged: () => Promise<void> | void;
  /** Place a cutaway with this asset at the playhead. */
  onPlaceCutaway: (assetId: string) => void;
  /** Lay this track as a bed on the clip. */
  onAddBed: (assetId: string) => void;
  /** Drop this sound as a hit at the playhead. */
  onPlaceHit: (assetId: string) => void;
}) {
  const [kind, setKind] = useState<GenerationKind>("image");
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [duration, setDuration] = useState(6);
  const [hitLength, setHitLength] = useState(1.5);
  const [fromAssetId, setFromAssetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [lessons, setLessons] = useState<DirectorLesson[]>([]);
  const [rule, setRule] = useState("");
  const [describing, setDescribing] = useState(false);
  const [described, setDescribed] = useState<string | null>(null);

  const stills = useMemo(() => mediaLibrary.filter((asset) => asset.kind === "image"), [mediaLibrary]);
  const known = useMemo(() => {
    const map = new Map<string, MediaAsset | AudioAsset>();
    for (const asset of mediaLibrary) map.set(asset.id, asset);
    for (const asset of audioLibrary) map.set(asset.id, asset);
    return map;
  }, [mediaLibrary, audioLibrary]);
  const running = jobs.some((job) => job.status === "running" || job.status === "queued");

  async function refreshJobs(): Promise<void> {
    try {
      const next = await api.listGenerationJobs();
      // A job that just finished puts something new in a library.
      const landed = next.some((job) => job.status === "done" && !jobs.some((prev) => prev.id === job.id && prev.status === "done"));
      setJobs(next);
      if (landed) {
        await onMediaChanged();
        await onAudioChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refreshJobs();
    void api.listLessons().then(setLessons).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refreshJobs(), 6000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, jobs.length]);

  async function generate() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.generateAsset({
        kind,
        prompt: prompt.trim(),
        aspectRatio: kind === "music" || kind === "sfx" ? undefined : aspect,
        durationSec: kind === "video" ? duration : kind === "sfx" ? hitLength : undefined,
        fromAssetId: kind === "video" && fromAssetId ? fromAssetId : undefined,
      });
      setPrompt("");
      await refreshJobs();
      await onMediaChanged();
      await onAudioChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    const text = rule.trim();
    if (!text) return;
    setError(null);
    try {
      const lesson = await api.addLesson({ text });
      setLessons((prev) => [lesson, ...prev]);
      setRule("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function forget(id: string) {
    setLessons((prev) => prev.filter((lesson) => lesson.id !== id));
    await api.deleteLesson(id).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  async function describeLibrary() {
    setDescribing(true);
    setError(null);
    try {
      const result = await api.senseLibrary();
      setDescribed(result.described > 0 ? `Described ${result.described} more; ${result.audio} sounds and ${result.media} pictures known.` : `Every sound and picture is described (${result.audio} sounds, ${result.media} pictures).`);
      await onMediaChanged();
      await onAudioChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDescribing(false);
    }
  }

  return (
    <>
      <Panel title="Studio" icon={Sparkles}>
        <div className="grid grid-cols-4 gap-1 rounded-lg border border-border bg-panel-2/60 p-1">
          {KINDS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={kind === item.id}
              title={item.hint}
              onClick={() => setKind(item.id)}
              className={cn(
                "press text-ui inline-flex h-9 items-center justify-center gap-1.5 rounded-md font-semibold",
                kind === item.id ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg"
              )}
            >
              <item.icon className="size-3.5" aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          maxLength={2000}
          aria-label="What to make"
          placeholder={
            kind === "sfx"
              ? "A deep cinematic sub boom with a short tail… / a fast airy whoosh… / a glassy UI tick…"
              : kind === "music"
              ? "A warm lo-fi bed, soft keys and vinyl crackle, 84 BPM, calm confidence…"
              : kind === "video"
                ? "Slow push over a dim server room, blue rack lights, haze…"
                : "A dragon silhouette on a jagged peak, fiery backlight, misty…"
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy) void generate();
          }}
          className="text-ui mt-2 w-full resize-y rounded-md border border-control bg-panel-2 px-2 py-2 outline-none focus:border-accent"
        />
        {kind === "sfx" ? (
          <label className="mt-2 block">
            <span className="text-micro text-muted">Length</span>
            <select value={hitLength} onChange={(event) => setHitLength(Number(event.target.value))} className={FIELD} aria-label="Hit length">
              {[0.5, 1, 1.5, 2, 3, 4, 6].map((sec) => (
                <option key={sec} value={sec}>
                  {sec} s
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {kind !== "music" && kind !== "sfx" ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-micro text-muted">Shape</span>
              <select value={aspect} onChange={(event) => setAspect(event.target.value)} className={FIELD} aria-label="Aspect ratio">
                <option value="9:16">Vertical 9:16</option>
                <option value="16:9">Wide 16:9</option>
                <option value="1:1">Square 1:1</option>
              </select>
            </label>
            {kind === "video" ? (
              <label className="block">
                <span className="text-micro text-muted">Length</span>
                <select value={duration} onChange={(event) => setDuration(Number(event.target.value))} className={FIELD} aria-label="Video length">
                  {[5, 6, 8, 10, 12, 15].map((sec) => (
                    <option key={sec} value={sec}>
                      {sec} s
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}
        {kind === "video" ? (
          <label className="mt-2 block">
            <span className="text-micro text-muted">Animate a still (optional)</span>
            <select value={fromAssetId} onChange={(event) => setFromAssetId(event.target.value)} className={FIELD} aria-label="Still to animate">
              <option value="">From the prompt alone</option>
              {stills.map((still) => (
                <option key={still.id} value={still.id}>
                  {still.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          disabled={busy || !prompt.trim()}
          onClick={() => void generate()}
          title="⌘↵"
          className="press text-ui mt-2 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
          {busy ? (kind === "video" ? "Submitting…" : "Making…") : kind === "video" ? "Render motion" : kind === "music" ? "Compose a bed" : kind === "sfx" ? "Make a hit" : "Make a still"}
        </button>
        <p className="text-meta mt-1 text-muted">
          {kind === "sfx"
            ? "Made on fal.ai (Stable Audio SFX, ~2¢; needs FAL_KEY), trimmed and levelled like the bundled hits. Lands in the SFX list."
            : kind === "video"
            ? "Motion renders on the provider for a few minutes; it lands in the library when done."
            : kind === "music"
              ? "Instrumental unless you ask for vocals. Lands in the Sound desk's music list."
              : "Lands in the media library, described by the harness so the Director can pick it later."}
        </p>
        {error ? <p className="text-meta mt-2 text-bad">{error}</p> : null}

        {jobs.length > 0 ? (
          <ul className="mt-3 space-y-1.5 border-t border-border pt-2">
            {jobs.slice(0, 12).map((job) => {
              const asset = job.assetId ? known.get(job.assetId) : undefined;
              const media = asset && "width" in asset ? (asset as MediaAsset) : undefined;
              return (
                <li key={job.id} className="flex items-center gap-2 rounded-lg border border-border bg-panel-2/50 p-1.5">
                  {media ? (
                    <img src={mediaThumbUrl(media.id)} alt="" className="size-10 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded bg-panel text-muted">
                      {job.status === "running" || job.status === "queued" ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : job.kind === "music" ? (
                        <Music className="size-4" aria-hidden="true" />
                      ) : job.kind === "sfx" ? (
                        <Zap className="size-4" aria-hidden="true" />
                      ) : (
                        <Clapperboard className="size-4" aria-hidden="true" />
                      )}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-ui truncate" title={job.prompt}>
                      {job.prompt}
                    </p>
                    <p className="text-micro text-muted">
                      {job.kind}
                      {" · "}
                      {job.status === "failed" ? <span className="text-bad">{job.error ?? "failed"}</span> : job.status === "done" ? "ready" : "rendering…"}
                      {job.cost != null ? ` · $${job.cost.toFixed(2)}` : ""}
                      {media?.sense?.quality != null ? (
                        <span className={cn("ml-1", media.sense.quality >= 3 ? "text-accent" : "text-warn")} title={media.sense.flaws?.join(", ") || "Judged by the harness"}>
                          · {media.sense.quality}/5{media.sense.quality < 3 && media.sense.flaws?.length ? ` — ${media.sense.flaws[0]}` : ""}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  {job.status === "done" && job.assetId ? (
                    job.kind === "music" ? (
                      <button type="button" onClick={() => onAddBed(job.assetId!)} className="press text-micro rounded-md border border-border px-2 py-1 font-semibold text-muted hover:border-accent hover:text-fg">
                        Lay as bed
                      </button>
                    ) : job.kind === "sfx" ? (
                      <button type="button" onClick={() => onPlaceHit(job.assetId!)} className="press text-micro rounded-md border border-border px-2 py-1 font-semibold text-muted hover:border-accent hover:text-fg">
                        Drop at playhead
                      </button>
                    ) : (
                      <button type="button" onClick={() => onPlaceCutaway(job.assetId!)} className="press text-micro rounded-md border border-border px-2 py-1 font-semibold text-muted hover:border-accent hover:text-fg">
                        Cut to it
                      </button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </Panel>

      <Panel
        title="What the Director knows"
        icon={Brain}
        actions={
          <button
            type="button"
            disabled={describing}
            onClick={() => void describeLibrary()}
            title="Have the harness listen to every sound and look at every picture it has not described yet"
            className="press text-micro rounded-md border border-border px-2 py-1 font-semibold text-muted hover:border-control hover:text-fg disabled:opacity-50"
          >
            {describing ? "Listening…" : "Describe the library"}
          </button>
        }
      >
        {described ? <p className="text-meta mb-2 text-muted">{described}</p> : null}
        <div className="flex items-center gap-1.5">
          <input
            value={rule}
            onChange={(event) => setRule(event.target.value)}
            maxLength={400}
            placeholder="A rule it should always follow: “No slow motion on my clips.”"
            aria-label="A rule for the Director"
            onKeyDown={(event) => {
              if (event.key === "Enter") void addRule();
            }}
            className="text-ui h-9 min-w-0 flex-1 rounded-md border border-control bg-panel-2 px-2 outline-none focus:border-accent"
          />
          <button type="button" onClick={() => void addRule()} disabled={!rule.trim()} className="press text-ui h-9 rounded-md border border-accent px-2 font-semibold text-accent disabled:opacity-50">
            Teach
          </button>
        </div>
        {lessons.length === 0 ? (
          <p className="text-meta mt-2 text-muted">Nothing learned yet. It learns from your edits after a pass, from renders it reviews, and from thumbs up / down on the Director tab.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {lessons.map((lesson) => (
              <li key={lesson.id} className="flex items-start gap-2">
                <span
                  className={cn(
                    "text-micro mt-0.5 shrink-0 rounded px-1 font-semibold uppercase",
                    lesson.kind === "feedback" ? "bg-accent/15 text-accent" : lesson.kind === "review" ? "bg-warn/15 text-warn" : "bg-panel-2 text-muted"
                  )}
                  title={lesson.kind === "feedback" ? "You said so" : lesson.kind === "review" ? "From a render it watched" : "From your edits after a pass"}
                >
                  {lesson.kind === "feedback" ? "you" : lesson.kind === "review" ? "seen" : "edit"}
                </span>
                <span className="text-meta min-w-0 flex-1 text-fg">
                  {lesson.text}
                  {lesson.scope !== "global" ? <span className="text-micro ml-1 text-muted">(this project)</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => void forget(lesson.id)}
                  aria-label="Forget this lesson"
                  className="press inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-bad/15 hover:text-bad"
                >
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
