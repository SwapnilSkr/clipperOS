import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { api, type AudioAsset, type LibrarySoundResult } from "@/api";

// ============================================================
// FREESOUND SEARCH — real recordings from freesound.org, one-shot hits up to
// 8 s, filtered to licences a published clip may carry. Each result can be
// previewed; "Take it" brings it into the shared audio library (credit kept
// with the file), after which it can be dropped at the playhead like any
// other hit — and the Director can pick it on later passes.
// ============================================================

export function FreesoundSearch({
  onTaken,
  onPlace,
  placeDisabled,
  placeLabel = "Drop at playhead",
}: {
  /** A result became a library sound: refresh the library that lists it. */
  onTaken: (asset: AudioAsset) => Promise<void> | void;
  /** Place a taken sound as a hit. */
  onPlace: (assetId: string) => void;
  /** No room for another hit. */
  placeDisabled?: boolean;
  placeLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LibrarySoundResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [taking, setTaking] = useState<string | null>(null);
  const [taken, setTaken] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function search() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await api.searchSounds(q));
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  async function take(result: LibrarySoundResult) {
    setTaking(result.id);
    setError(null);
    try {
      const asset = await api.pickSound(result);
      setTaken((prev) => ({ ...prev, [result.id]: asset.id }));
      await onTaken(asset);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaking(null);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={120}
          placeholder="glass shatter, crowd gasp, cash register…"
          aria-label="Search Freesound"
          onKeyDown={(event) => {
            if (event.key === "Enter") void search();
          }}
          className="text-ui h-9 min-w-0 flex-1 rounded-md border border-control bg-panel-2 px-2 outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching || !query.trim()}
          className="press text-ui inline-flex h-9 items-center gap-1 rounded-md border border-accent px-2 font-semibold text-accent disabled:opacity-50"
        >
          {searching ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Search className="size-3.5" aria-hidden="true" />}
          Search
        </button>
      </div>
      {searched && results.length === 0 && !searching && !error ? <p className="text-meta mt-2 text-muted">Nothing on Freesound for that — try plainer words.</p> : null}
      {results.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {results.map((result) => (
            <li key={result.id} className="rounded-lg border border-border bg-panel-2/50 p-1.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-ui truncate" title={result.name}>
                    {result.name}
                  </p>
                  <p className="text-micro text-muted">
                    {result.durationSec.toFixed(1)} s · {result.ratings > 0 ? `${result.rating.toFixed(1)}★ (${result.ratings})` : "unrated"} · {result.needsCredit ? "credit" : "CC0"} · {result.username}
                  </p>
                </div>
                {taken[result.id] ? (
                  <button
                    type="button"
                    disabled={placeDisabled}
                    onClick={() => onPlace(taken[result.id]!)}
                    className="press text-micro rounded-md border border-accent px-2 py-1 font-semibold text-accent disabled:opacity-50"
                  >
                    {placeLabel}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={taking === result.id}
                    onClick={() => void take(result)}
                    className="press text-micro rounded-md border border-border px-2 py-1 font-semibold text-muted hover:border-accent hover:text-fg disabled:opacity-50"
                  >
                    {taking === result.id ? "Taking…" : "Take it"}
                  </button>
                )}
              </div>
              <audio controls preload="none" src={result.previewUrl} className="mt-1 h-8 w-full" aria-label={`Preview of ${result.name}`} />
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-meta mt-2 text-bad">{error}</p> : null}
    </div>
  );
}
