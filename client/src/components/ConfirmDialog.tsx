import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Say exactly what is destroyed. Vague warnings train people to click through. */
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A focus-trapping confirmation dialog, portaled onto `document.body`.
 *
 * It must live outside `#root`. Marking `#root` inert (so the board behind
 * cannot be reached) would otherwise inert the dialog itself — which is why
 * Cancel/Delete looked fine and did nothing.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  /**
   * Keep the panel mounted for the length of its exit so it can animate out.
   * Unmounting on `open === false` would make the exit impossible — the element
   * would be gone before the browser could interpolate anything.
   */
  const [rendered, setRendered] = useState(open);
  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    const t = window.setTimeout(() => setRendered(false), 170);
    return () => window.clearTimeout(t);
  }, [open]);
  const motionState = open ? "open" : "closed";

  useEffect(() => {
    if (!open) return;

    openerRef.current = document.activeElement;
    const root = document.getElementById("root");
    const previouslyInert = root?.inert ?? false;
    if (root) root.inert = true;

    const focusCancel = window.requestAnimationFrame(() => cancelRef.current?.focus());

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;

      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables?.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusCancel);
      document.removeEventListener("keydown", onKeyDown, true);
      if (root) root.inert = previouslyInert;
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onCancel]);

  if (!rendered) return null;

  return createPortal(
    <div
      data-state={motionState}
      className="motion-scrim fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-state={motionState}
        inert={!open}
        className="motion-pop pointer-events-auto w-full max-w-md rounded-xl border border-border bg-panel p-5 shadow-xl"
      >
        <div className="flex items-start gap-3">
          {destructive ? (
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-bad" aria-hidden="true" />
          ) : null}
          <div className="min-w-0">
            <h2 id={titleId} className="text-title font-semibold">
              {title}
            </h2>
            <p id={bodyId} className="text-body mt-2 text-muted">
              {body}
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="press text-ui h-11 rounded-lg border border-control bg-panel-2 px-4 font-medium hover:border-accent"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={cn(
              "press text-ui h-11 rounded-lg px-4 font-semibold hover:opacity-90 disabled:opacity-50",
              destructive ? "bg-bad text-white" : "bg-accent text-accent-fg"
            )}
          >
            {busy ? `${confirmLabel}…` : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
