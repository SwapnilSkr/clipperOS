import { useEffect, useRef, useState } from "react";
import { Loader2, Search, Trash2, Upload } from "lucide-react";
import { api, mediaThumbUrl, type MediaAsset, type StockResult } from "@/api";
import { cn } from "@/lib/utils";

// ============================================================
// MEDIA PICKER — the B-roll library and stock search, side by side.
//
// Library: what has been uploaded or picked, newest first, as thumbnails.
// Stock: one search across the configured providers (Pexels, Pixabay);
// picking a result downloads it into the library once and hands back the
// asset. Both tabs end in the same call: `onPick(asset)`.
// ============================================================

export function MediaPicker({
  assets,
  stockSources,
  value,
  onPick,
  onChanged,
  pickLabel = "Use",
}: {
  assets: MediaAsset[];
  stockSources: ("pexels" | "pixabay")[];
  /** The asset in use, highlighted. */
  value?: string;
  onPick: (asset: MediaAsset) => void;
  /** The library changed (upload, stock pick, delete): reload it. */
  onChanged: () => Promise<void> | void;
  pickLabel?: string;
}) {
  const [tab, setTab] = useState<"library" | "stock">("library");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"image" | "video">("video");
  const [results, setResults] = useState<StockResult[]>([]);
  const [searching, setSearching] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy("upload");
    setError(null);
    try {
      const asset = await api.uploadMedia(file);
      await onChanged();
      onPick(asset);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function search() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      const response = await api.searchStock(q, kind);
      setResults(response.results);
      if (response.results.length === 0) setError("Nothing found — try other words.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  async function pick(result: StockResult) {
    setBusy(`${result.source}:${result.id}`);
    setError(null);
    try {
      const asset = await api.pickStock({ source: result.source, id: result.id, kind: result.kind, query: query.trim() });
      await onChanged();
      onPick(asset);
      setTab("library");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(asset: MediaAsset) {
    setBusy(asset.id);
    try {
      await api.deleteMedia(asset.id);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // A search re-runs when the kind flips, if there is a query.
  useEffect(() => {
    if (tab === "stock" && query.trim()) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setTab("library")}
          aria-pressed={tab === "library"}
          className={cn("press text-micro rounded-full border px-2 py-0.5 font-semibold", tab === "library" ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:border-control")}
        >
          Library{assets.length ? ` · ${assets.length}` : ""}
        </button>
        <button
          type="button"
          onClick={() => setTab("stock")}
          aria-pressed={tab === "stock"}
          className={cn("press text-micro rounded-full border px-2 py-0.5 font-semibold", tab === "stock" ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:border-control")}
        >
          Stock
        </button>
        <span className="flex-1" />
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(event) => void upload(event.target.files?.[0])}
        />
        <button
          type="button"
          disabled={busy === "upload"}
          onClick={() => fileRef.current?.click()}
          className="press text-micro inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-semibold text-muted hover:border-control hover:text-fg disabled:opacity-50"
        >
          {busy === "upload" ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Upload className="size-3" aria-hidden="true" />}
          Upload
        </button>
      </div>

      {tab === "library" ? (
        assets.length === 0 ? (
          <p className="text-meta mt-2 text-muted">Nothing yet — upload a still or video, or search stock.</p>
        ) : (
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {assets.map((asset) => (
              <div
                key={asset.id}
                className={cn(
                  "group relative overflow-hidden rounded-md border bg-black",
                  asset.id === value ? "border-accent" : "border-border"
                )}
                style={{ aspectRatio: "9 / 14" }}
              >
                <button type="button" onClick={() => onPick(asset)} className="block h-full w-full" title={`${asset.label} · ${pickLabel}`}>
                  <img src={mediaThumbUrl(asset.id)} alt={asset.label} className="h-full w-full object-cover" loading="lazy" />
                </button>
                <span className="text-micro pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-fg">
                  {asset.kind === "video" ? `▶ ${asset.durationSec?.toFixed(0) ?? ""}s · ` : ""}
                  {asset.label}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(asset)}
                  disabled={busy === asset.id}
                  aria-label={`Delete ${asset.label}`}
                  className="press absolute right-0.5 top-0.5 hidden rounded bg-black/70 p-0.5 text-muted hover:text-bad group-hover:block"
                >
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="mt-2">
          {stockSources.length === 0 ? (
            <p className="text-meta text-muted">
              No stock provider is set up. Add <code>PEXELS_API_KEY</code> or <code>PIXABAY_API_KEY</code> to <code>server/.env</code> (both are free) and restart the server.
            </p>
          ) : (
            <>
              <div className="flex gap-1">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void search();
                  }}
                  placeholder="server room at night, mountain sunrise…"
                  aria-label="Stock search"
                  className="text-ui h-8 min-w-0 flex-1 rounded-md border border-control bg-panel-2 px-2 outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={() => void search()}
                  disabled={searching}
                  aria-label="Search"
                  className="press inline-flex h-8 w-8 items-center justify-center rounded-md border border-control bg-panel-2 text-muted hover:border-accent hover:text-fg disabled:opacity-50"
                >
                  {searching ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Search className="size-4" aria-hidden="true" />}
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                {(["video", "image"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setKind(option)}
                    aria-pressed={kind === option}
                    className={cn("press text-micro rounded-full border px-2 py-0.5 font-semibold", kind === option ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:border-control")}
                  >
                    {option === "video" ? "Videos" : "Stills"}
                  </button>
                ))}
                <span className="text-micro ml-auto text-muted">{stockSources.join(" + ")}</span>
              </div>
              {results.length > 0 ? (
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {results.map((result) => {
                    const id = `${result.source}:${result.id}`;
                    return (
                      <button
                        key={id}
                        type="button"
                        disabled={busy === id}
                        onClick={() => void pick(result)}
                        title={`${result.attribution} · ${pickLabel}`}
                        className="relative overflow-hidden rounded-md border border-border bg-black disabled:opacity-60"
                        style={{ aspectRatio: "9 / 14" }}
                      >
                        <img src={result.thumbUrl} alt={result.label} className="h-full w-full object-cover" loading="lazy" />
                        {busy === id ? (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                            <Loader2 className="size-4 animate-spin text-fg" aria-hidden="true" />
                          </span>
                        ) : null}
                        <span className="text-micro pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-fg">
                          {result.kind === "video" ? `▶ ${result.durationSec ?? ""}s · ` : ""}
                          {result.source}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
      {error ? <p className="text-meta mt-2 text-bad">{error}</p> : null}
    </div>
  );
}
