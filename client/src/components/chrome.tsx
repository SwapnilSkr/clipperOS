import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/** Compact control: 44px on a phone, Linear-dense 32px from `sm` up. */
export const ctrl =
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md text-ui font-medium sm:h-8";

/**
 * Quiet segmented group. Lime is reserved for the one primary action on the
 * page — a pressed segment is just a lifted chip, not a second CTA.
 */
export function Segmented<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  label: string;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="flex h-11 items-center rounded-md border border-border bg-bg p-0.5 sm:h-8"
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const pressed = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            title={option.label}
            onClick={() => onChange(option.value)}
            className={cn(
              "press text-ui inline-flex h-full min-w-8 items-center justify-center rounded-[5px] px-2.5 font-medium",
              pressed ? "bg-panel-2 text-fg shadow-[inset_0_0_0_1px_var(--color-border)]" : "text-muted hover:text-fg"
            )}
          >
            {option.icon ?? option.label}
            {option.icon ? <span className="sr-only">{option.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Kebab that parks secondary actions so the toolbar stays one row. */
export function MoreMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [pos, setPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const box = buttonRef.current?.getBoundingClientRect();
      if (!box) return;
      setPos({ top: box.bottom + 4, right: window.innerWidth - box.right });
    };
    place();
    function onPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          ctrl,
          "w-11 border border-border bg-panel-2 text-muted hover:border-control hover:text-fg sm:w-8"
        )}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              onClick={() => setOpen(false)}
              style={{ top: pos.top, right: pos.right }}
              className="fixed z-[180] min-w-[12rem] overflow-hidden rounded-lg border border-border bg-panel py-1 shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
            >
              {children}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export function MenuItem({
  children,
  disabled,
  tone,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  tone?: "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "text-ui flex w-full items-center gap-2 px-3 py-2 text-start font-medium hover:bg-panel-2 disabled:opacity-40",
        tone === "danger" ? "text-bad hover:bg-bad/10" : "text-fg"
      )}
    >
      {children}
    </button>
  );
}
