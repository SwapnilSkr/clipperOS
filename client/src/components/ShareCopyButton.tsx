import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import { api, type ClipPayload } from "@/api";
import { cn } from "@/lib/utils";

export function clipHeadline(clip: ClipPayload): string {
  return clip.shareCopy?.title || clip.title || clip.hookText;
}

type Copied = "title" | "description" | "both" | null;

interface ShareCopyButtonProps {
  clip: ClipPayload;
  compact?: boolean;
  onUpdated?: (clip: ClipPayload) => void;
}

export function ShareCopyButton({ clip, compact = true, onUpdated }: ShareCopyButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<Copied>(null);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const copy = clip.shareCopy;

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const box = buttonRef.current?.getBoundingClientRect();
      if (!box) return;
      const width = 320;
      const right = Math.max(8, window.innerWidth - box.right);
      const leftSpace = box.right - width;
      setPos({
        top: Math.min(box.bottom + 4, window.innerHeight - 280),
        right: leftSpace < 8 ? Math.max(8, window.innerWidth - (box.left + width)) : right,
      });
    };
    place();
    function onPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function ensureCopy(force = false): Promise<ClipPayload | null> {
    if (!force && copy?.title && copy.description) return clip;
    setBusy(true);
    setError(null);
    try {
      const next = await api.generateClipShareCopy(clip.id, force);
      onUpdated?.(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not write copy");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function openPanel() {
    setOpen(true);
    if (!copy?.title) await ensureCopy(false);
  }

  async function writeClipboard(kind: Exclude<Copied, null>, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setError("Clipboard is blocked");
    }
  }

  const title = copy?.title ?? "";
  const description = copy?.description ?? "";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={copy?.title ? `Copy post for clip ${clip.rank}` : `Write post copy for clip ${clip.rank}`}
        title={copy?.title ? "Copy title & description" : "Write title & description"}
        onClick={() => void (open ? setOpen(false) : openPanel())}
        className={cn(
          "press inline-flex items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-fg",
          compact ? "size-11 sm:size-8" : "size-9"
        )}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label="Post copy"
              style={{ top: pos.top, right: pos.right }}
              className="fixed z-[180] w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border bg-panel p-3 shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-ui font-semibold">Post copy</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void ensureCopy(true)}
                  className="press text-micro inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50"
                >
                  <RefreshCw className={cn("size-3", busy && "animate-spin")} aria-hidden="true" />
                  Rewrite
                </button>
              </div>
              {error ? <p className="text-meta mb-2 text-bad">{error}</p> : null}
              {title ? (
                <div className="space-y-2">
                  <CopyBlock
                    label="Title"
                    text={title}
                    lines={2}
                    copied={copied === "title"}
                    onCopy={() => void writeClipboard("title", title)}
                  />
                  <CopyBlock
                    label="Description"
                    text={description}
                    lines={10}
                    copied={copied === "description"}
                    onCopy={() => void writeClipboard("description", description)}
                  />
                  <button
                    type="button"
                    onClick={() => void writeClipboard("both", `${title}\n\n${description}`)}
                    className="press text-ui inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-bg font-semibold hover:border-control"
                  >
                    {copied === "both" ? (
                      <Check className="size-3.5 text-accent" aria-hidden="true" />
                    ) : (
                      <Copy className="size-3.5" aria-hidden="true" />
                    )}
                    {copied === "both" ? "Copied both" : "Copy title + description"}
                  </button>
                </div>
              ) : (
                <p className="text-meta text-muted">
                  {busy ? "Writing from the transcript…" : "No copy yet."}
                </p>
              )}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function CopyBlock({
  label,
  text,
  lines,
  copied,
  onCopy,
}: {
  label: string;
  text: string;
  lines: number;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-micro font-semibold uppercase tracking-wide text-muted">{label}</p>
        <button
          type="button"
          onClick={onCopy}
          className="press text-micro inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-muted hover:bg-panel-2 hover:text-fg"
        >
          {copied ? (
            <Check className="size-3 text-accent" aria-hidden="true" />
          ) : (
            <Copy className="size-3" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p
        className={cn(
          "text-meta whitespace-pre-wrap rounded-md bg-bg px-2 py-1.5 text-fg/90",
          lines <= 2 ? "line-clamp-2" : "max-h-44 overflow-y-auto"
        )}
      >
        {text}
      </p>
    </div>
  );
}
