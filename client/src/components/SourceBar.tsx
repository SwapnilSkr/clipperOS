import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { AlertTriangle, Link2, Loader2, Tag, UploadCloud } from "lucide-react";
import type { GenreInfo } from "@/api";
import { cn } from "@/lib/utils";

interface SourceBarProps {
  busy: boolean;
  genres: GenreInfo[];
  /** "" = auto-detect. */
  genreChoice: string;
  /** Field-level failure from the last submit, shown next to the input. */
  error?: string | null;
  onGenreChoice: (genreId: string) => void;
  onClearError: () => void;
  onYoutube: (url: string) => void;
  onUpload: (file: File) => void;
}

const ERROR_ID = "source-url-error";

/** Paste a YouTube link, or drop/choose a file. Both paths land in the same pipeline. */
export function SourceBar({
  busy,
  genres,
  genreChoice,
  error,
  onGenreChoice,
  onClearError,
  onYoutube,
  onUpload,
}: SourceBarProps) {
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * The submit stays ENABLED, even with an empty field.
   *
   * A button disabled until the form is valid hides the very thing that needs
   * fixing and gives the user nothing to click. Instead we let them submit, then
   * point at the field and say what is wrong — which is both the fix path and the
   * announcement.
   */
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    onClearError();

    const trimmed = url.trim();
    if (!trimmed) {
      setLocalError("Paste a YouTube link, or choose a video file to upload.");
      inputRef.current?.focus();
      return;
    }
    setLocalError(null);
    onYoutube(trimmed);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = event.dataTransfer.files?.[0];
    if (file) {
      setLocalError(null);
      onClearError();
      onUpload(file);
    }
  }

  const chosen = genres.find((g) => g.id === genreChoice);
  const message = localError ?? error ?? null;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={cn(
        "rounded-xl border border-border bg-panel p-3 transition-colors",
        dragging && "border-accent bg-panel-2"
      )}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <label htmlFor="source-url" className="sr-only">
            Video to clip
          </label>
          <Link2
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <input
            id="source-url"
            ref={inputRef}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (localError) setLocalError(null);
              if (error) onClearError();
            }}
            onKeyDown={(e) => {
              // Escape clears a failed entry rather than making the user select-all.
              if (e.key === "Escape" && url) {
                e.preventDefault();
                setUrl("");
                setLocalError(null);
                onClearError();
              }
            }}
            type="url"
            inputMode="url"
            autoComplete="url"
            enterKeyHint="go"
            placeholder="Paste a YouTube link, or drop a video file here"
            disabled={busy}
            aria-invalid={message ? "true" : undefined}
            aria-describedby={message ? ERROR_ID : undefined}
            className={cn(
              "text-body h-11 w-full rounded-md border bg-bg ps-9 pe-3 outline-none placeholder:text-muted/70 focus:border-accent disabled:opacity-50",
              message ? "border-bad" : "border-border"
            )}
          />
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="press text-ui inline-flex h-11 items-center gap-2 rounded-md bg-accent px-4 font-semibold text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <UploadCloud className="size-4" aria-hidden="true" />
            )}
            {busy ? "Finding clips…" : "Find clips"}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="press text-ui inline-flex h-11 items-center gap-2 rounded-md border border-border bg-panel-2 px-3 font-medium hover:border-control disabled:opacity-40"
          >
            Upload
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file && !busy) {
                setLocalError(null);
                onClearError();
                onUpload(file);
              }
              e.target.value = "";
            }}
          />
        </div>
      </form>

      {/* Recovery path: the field says what broke, how to fix it, and keeps the
          typed value so nothing is retyped. */}
      <div role="alert" aria-live="polite" className="empty:hidden">
        {message ? (
          <p id={ERROR_ID} className="motion-reveal text-meta mt-2 flex items-start gap-1.5 text-bad">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {message}
          </p>
        ) : null}
      </div>

      {/* Deliberately distinct from the board's "Re-cut as", which re-mines the
          project already on screen. This one scopes to the NEXT import only. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="text-meta flex items-center gap-2 text-muted">
          <Tag className="size-3.5" aria-hidden="true" />
          <span>Import as</span>
          <select
            value={genreChoice}
            disabled={busy}
            onChange={(e) => onGenreChoice(e.target.value)}
            className="text-ui h-11 rounded-md border border-border bg-panel-2 px-2 outline-none focus:border-accent disabled:opacity-50 sm:h-8"
          >
            <option value="">Auto-detect from the content</option>
            {genres.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        {/* Desktop-only prose: it is not part of the mobile critical path. */}
        <p className="text-meta hidden max-w-[46ch] text-muted md:block">
          {chosen ? chosen.summary : "Auto-detect picks the rules and the clip length."}
        </p>
      </div>
    </div>
  );
}
