import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, ScanSearch } from "lucide-react";
import type { ReframeTrack } from "@/api";
import { checkSceneCuts, markAddedCuts } from "@/lib/cut-check";
import { cn, timecode } from "@/lib/utils";

export function CutCheckPanel({
  track,
  trimStart,
  trimEnd,
  sourceWidth,
  sourceHeight,
  analysing,
  onJump,
}: {
  track: ReframeTrack | undefined;
  trimStart: number;
  trimEnd: number;
  sourceWidth: number;
  sourceHeight: number;
  analysing: boolean;
  onJump: (sourceSec: number) => void;
}) {
  const seenCutsRef = useRef<number[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const checks = useMemo(() => {
    const clock = checkSceneCuts(track, trimStart, trimEnd, sourceWidth, sourceHeight);
    return markAddedCuts(clock, seenCutsRef.current);
  }, [track, trimStart, trimEnd, sourceWidth, sourceHeight]);

  useEffect(() => {
    const next = checks.map((item) => item.sourceSec);
    const prev = seenCutsRef.current;
    if (prev.length > 0) {
      const known = new Set(prev.map((t) => Math.round(t * 100)));
      const added = next.filter((t) => !known.has(Math.round(t * 100))).length;
      if (added > 0) {
        setNotice(
          added === 1
            ? "New scene cut in the trim — snap checked"
            : `${added} new scene cuts in the trim — snaps checked`
        );
      } else if (prev.length !== next.length) {
        setNotice("Trim updated — scene cuts rechecked");
      }
    }
    seenCutsRef.current = next;
  }, [checks]);

  const flashes = checks.filter((item) => item.status === "flash");
  const snaps = checks.filter((item) => item.kind === "snap");

  function runManualCheck() {
    const firstFlash = flashes[0];
    if (firstFlash) {
      setNotice(firstFlash.reason ?? "This cut still flashes — playing from just before it");
      onJump(Math.max(trimStart, firstFlash.sourceSec - 0.35));
      return;
    }
    if (snaps.length === 0) {
      setNotice("No camera cuts in this trim");
      return;
    }
    setNotice(`All ${snaps.length} camera cuts snap clean`);
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-panel-2/40 p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-ui font-semibold text-muted">Scene cuts</p>
        <button
          type="button"
          disabled={!track || analysing}
          onClick={runManualCheck}
          className="press text-ui inline-flex h-9 items-center gap-1.5 rounded-lg border border-control px-2.5 font-medium text-muted hover:border-accent disabled:opacity-40"
        >
          <ScanSearch className="size-3.5" aria-hidden="true" />
          Check cuts
        </button>
      </div>
      {analysing ? (
        <p className="text-meta mt-2 flex items-center gap-1.5 text-muted">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          Finding shots in the new window…
        </p>
      ) : checks.length === 0 ? (
        <p className="text-meta mt-2 text-muted">
          No camera cuts in this trim yet. Extend the window or wait for framing to finish.
        </p>
      ) : (
        <p className={cn("text-meta mt-2", flashes.length > 0 ? "text-warn" : "text-muted")}>
          {flashes.length > 0
            ? `${flashes.length} cut${flashes.length === 1 ? "" : "s"} still flash — jump to inspect`
            : `${checks.length} in this trim · ${snaps.length} hard camera change${snaps.length === 1 ? "" : "s"}`}
        </p>
      )}
      {notice ? <p className="text-meta mt-1 text-accent-2">{notice}</p> : null}
      {checks.length > 0 ? (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {checks.map((cut) => (
            <li key={Math.round(cut.sourceSec * 1000)}>
              <button
                type="button"
                onClick={() => onJump(Math.max(trimStart, cut.sourceSec - 0.35))}
                className={cn(
                  "press text-ui flex h-9 w-full items-center gap-2 rounded-md border px-2 text-left",
                  cut.status === "flash"
                    ? "border-warn/50 bg-warn/10 text-warn"
                    : "border-border bg-panel hover:border-accent"
                )}
              >
                {cut.status === "flash" ? (
                  <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <Check className="size-3.5 shrink-0 text-good" aria-hidden="true" />
                )}
                <span className="num flex-1">
                  {timecode(cut.sourceSec)}
                  {cut.added ? " · new" : ""}
                </span>
                <span className="text-micro text-muted">
                  {cut.kind === "snap" ? "camera" : "same seat"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-micro mt-2 text-muted">
        Rechecks when you trim or when new shots are analysed. Check cuts jumps to the first
        flash, or confirms the snaps are clean.
      </p>
    </div>
  );
}
