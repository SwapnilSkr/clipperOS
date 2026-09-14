import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Scissors } from "lucide-react";
import { cn, timecodeFine } from "@/lib/utils";

// Small controls shared by the editor's desks. Kept presentational: no clip
// state, no network, so any desk can compose them.

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function Panel({
  title,
  icon: Icon,
  actions,
  children,
}: {
  title: string;
  icon: typeof Scissors;
  /** Right-aligned header content: a toggle, a remove button. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="eyebrow flex items-center gap-1.5 text-muted">
          <Icon className="size-3" aria-hidden="true" />
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function SegmentedButton({
  active,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "press text-ui h-11 flex-1 rounded-md border px-3 font-medium sm:h-8",
        active ? "border-border bg-panel-2 text-fg" : "border-border text-muted hover:border-control hover:text-fg",
        disabled && "opacity-40"
      )}
    >
      {label}
    </button>
  );
}

export function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="eyebrow text-muted">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-12 cursor-pointer rounded border border-control bg-panel-2"
        aria-label={`${label} caption colour`}
      />
    </label>
  );
}

export function CaptionSectionField({
  value,
  onCommit,
  onFocusSeek,
}: {
  value: string;
  onCommit: (text: string) => void;
  onFocusSeek: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  return (
    <input
      value={draft}
      maxLength={160}
      onFocus={() => {
        focused.current = true;
        onFocusSeek();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        focused.current = false;
        onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className="text-ui h-10 w-full rounded-md border border-control bg-panel-2 px-2 outline-none focus:border-accent"
    />
  );
}

export function TimestampInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(() => timecodeFine(value));

  useEffect(() => {
    setDraft(timecodeFine(value));
  }, [value]);

  function commit() {
    // A blur without an edit must not move the value: the field shows 2 dp,
    // the stored value keeps 3.
    if (draft === timecodeFine(value)) return;
    const parsed = parseTimestamp(draft);
    if (parsed === null) {
      setDraft(timecodeFine(value));
      return;
    }
    const next = round3(Math.min(max, Math.max(min, parsed)));
    setDraft(timecodeFine(next));
    onChange(next);
  }

  return (
    <label className="block">
      <span className="text-micro text-muted">{label}</span>
      <input
        value={draft}
        inputMode="decimal"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(timecodeFine(value));
            event.currentTarget.blur();
          }
        }}
        aria-label={`${label} subtitle timestamp`}
        className="num text-ui mt-1 h-9 w-full rounded-md border border-control bg-panel-2 px-2 outline-none focus:border-accent"
      />
    </label>
  );
}

/** Accept seconds, MM:SS, or HH:MM:SS like a conventional subtitle editor. */
export function parseTimestamp(input: string): number | null {
  const parts = input.trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => part.trim() === "")) return null;
  const values = parts.map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (values.length === 1) return values[0] ?? null;
  if (values.length === 2) return (values[0] ?? 0) * 60 + (values[1] ?? 0);
  return (values[0] ?? 0) * 3600 + (values[1] ?? 0) * 60 + (values[2] ?? 0);
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
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
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-accent mt-1 h-11 w-full"
      />
    </label>
  );
}
