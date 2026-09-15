import { Plus, Trash2 } from "lucide-react";
import type { AudioAsset, MusicBed, Soundtrack } from "@/api";
import {
  bedFadeSec,
  bedOutSec,
  DEFAULT_BED_DIP,
  DEFAULT_BED_GAIN,
  dipDb,
  MAX_MUSIC_BEDS,
  musicBeds,
  newBedId,
} from "@/lib/music-beds";
import { cn, timecodeFine } from "@/lib/utils";
import { Slider } from "./editor-controls";

// ============================================================
// MUSIC BEDS — the inspector for a clip's music.
//
// Several beds play at once, each its own file with its own level, dip under
// speech, in and out on the clip's clock, start point in the file and fades.
// The readouts are what the burn does (lib/music-beds mirrors the server's
// rules), so "−7 dB under speech" is the export's dip, not a guess.
// ============================================================

const FIELD =
  "text-ui h-10 w-full rounded-lg border border-control bg-panel-2 px-2 outline-none focus:border-accent";

export function MusicBedsEditor({
  soundtrack,
  onChange,
  assets,
  localTime,
  clipEndSec,
  outroSec = 0,
}: {
  soundtrack: Soundtrack;
  onChange: (next: Soundtrack) => void;
  /** The music files on offer (built-in and shared uploads). */
  assets: AudioAsset[];
  /** Output-clock playhead, for "at playhead". */
  localTime: number;
  /** Where the clip ends on that clock. */
  clipEndSec: number;
  /** Sting length after the clip; 0 when none is attached. */
  outroSec?: number;
}) {
  const beds = musicBeds(soundtrack);
  const files = new Map(assets.map((asset) => [asset.id, asset]));
  const full = beds.length >= MAX_MUSIC_BEDS;

  function setBeds(next: MusicBed[]) {
    const track = { ...soundtrack };
    if (next.length > 0) track.beds = next;
    else delete track.beds;
    onChange(track);
  }
  function update(id: string, patch: Partial<MusicBed>) {
    setBeds(beds.map((bed) => (bed.id === id ? { ...bed, ...patch } : bed)));
  }
  function add(assetId: string) {
    if (full) return;
    setBeds([...beds, { id: newBedId(), assetId }]);
  }

  return (
    <div>
      {beds.length === 0 ? <p className="text-meta text-muted">No music yet. Pick a file to lay a bed under the voice.</p> : null}
      <ul className="flex flex-col gap-2">
        {beds.map((bed, index) => (
          <BedCard
            key={bed.id}
            bed={bed}
            index={index}
            file={files.get(bed.assetId)}
            assets={assets}
            localTime={localTime}
            clipEndSec={clipEndSec}
            outroSec={outroSec}
            onChange={(patch) => update(bed.id, patch)}
            onRemove={() => setBeds(beds.filter((item) => item.id !== bed.id))}
          />
        ))}
      </ul>
      <p className="eyebrow mt-3 text-muted">{beds.length === 0 ? "Add music" : "Add another"}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            disabled={full}
            onClick={() => add(asset.id)}
            className={cn(
              "press text-ui inline-flex h-9 items-center gap-1 rounded-full border border-border px-3 font-medium text-muted hover:border-control hover:text-fg",
              full && "opacity-40"
            )}
          >
            <Plus className="size-3" aria-hidden="true" />
            {asset.label}
          </button>
        ))}
      </div>
      {full ? <p className="text-meta mt-1 text-muted">Up to {MAX_MUSIC_BEDS} beds per clip.</p> : null}
    </div>
  );
}

function BedCard({
  bed,
  index,
  file,
  assets,
  localTime,
  clipEndSec,
  outroSec,
  onChange,
  onRemove,
}: {
  bed: MusicBed;
  index: number;
  file: AudioAsset | undefined;
  assets: AudioAsset[];
  localTime: number;
  clipEndSec: number;
  outroSec: number;
  onChange: (patch: Partial<MusicBed>) => void;
  onRemove: () => void;
}) {
  const end = outroSec > 0 && bed.carryIntoOutro !== false ? clipEndSec + outroSec : clipEndSec;
  const inSec = Math.min(Math.max(0, bed.inSec ?? 0), end);
  const outSec = bedOutSec(bed, clipEndSec, outroSec);
  const span = Math.max(0, outSec - inSec);
  const gain = bed.gain ?? DEFAULT_BED_GAIN;
  const dip = bed.dip ?? DEFAULT_BED_DIP;
  const fileLength = file?.durationSec && file.durationSec > 1 ? file.durationSec : 60;
  const playhead = Math.max(0, Math.min(end, localTime));
  const fadeIn = bedFadeSec(bed.fadeInSec, span);
  const fadeOut = bedFadeSec(bed.fadeOutSec, span);
  const fadeMax = Math.max(0.1, Math.min(4, span / 2));

  return (
    <li className="rounded-lg border border-border bg-panel-2/50 p-2">
      <div className="flex items-center gap-2">
        <span className="text-micro num w-5 shrink-0 text-muted">{index + 1}</span>
        <select
          value={bed.assetId}
          aria-label={`Bed ${index + 1} file`}
          onChange={(event) => onChange({ assetId: event.target.value })}
          className={FIELD}
        >
          <AssetOptions assets={assets} />
          {!file ? <option value={bed.assetId}>{bed.assetId}</option> : null}
        </select>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove bed ${index + 1}`}
          className="press inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-bad/15 hover:text-bad"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <Slider
        label="Level"
        value={gain}
        min={0}
        max={1}
        step={0.01}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(value) => onChange({ gain: round3(value) })}
      />
      <Slider
        label="Under speech"
        value={dip}
        min={0}
        max={1}
        step={0.05}
        format={(value) => (value < 0.001 ? "stays put" : `${dipDb(value).toFixed(0)} dB`)}
        onChange={(value) => onChange({ dip: round3(value) })}
      />

      <TimeSlider
        label="Comes in"
        value={inSec}
        max={end}
        playhead={playhead}
        onChange={(value) => {
          const next = Math.min(value, outSec - 0.1);
          onChange({ inSec: next <= 0.0005 ? undefined : round3(Math.max(0, next)) });
        }}
      />
      <TimeSlider
        label="Goes out"
        value={outSec}
        max={end}
        playhead={playhead}
        onChange={(value) => {
          const next = Math.max(value, inSec + 0.1);
          onChange({ outSec: next >= end - 0.0005 ? undefined : round3(Math.min(end, next)) });
        }}
      />
      <Slider
        label="Start in file"
        value={Math.min(bed.offsetSec ?? 0, fileLength)}
        min={0}
        max={fileLength}
        step={0.1}
        format={(value) => `${timecodeFine(value)}${file ? ` / ${timecodeFine(fileLength)}` : ""}`}
        onChange={(value) => onChange({ offsetSec: value <= 0.0005 ? undefined : round3(value) })}
      />
      <div className="grid grid-cols-2 gap-x-3">
        <Slider
          label="Fade in"
          value={Math.min(fadeIn, fadeMax)}
          min={0}
          max={fadeMax}
          step={0.05}
          format={(value) => `${value.toFixed(2)} s${bed.fadeInSec == null ? " auto" : ""}`}
          onChange={(value) => onChange({ fadeInSec: round3(value) })}
        />
        <Slider
          label="Fade out"
          value={Math.min(fadeOut, fadeMax)}
          min={0}
          max={fadeMax}
          step={0.05}
          format={(value) => `${value.toFixed(2)} s${bed.fadeOutSec == null ? " auto" : ""}`}
          onChange={(value) => onChange({ fadeOutSec: round3(value) })}
        />
      </div>
      {outroSec > 0 ? (
        <label className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={bed.carryIntoOutro !== false}
            onChange={(event) => onChange({ carryIntoOutro: event.target.checked ? undefined : false })}
            className="size-4 accent-accent"
          />
          <span className="text-ui text-muted">Carry into sting</span>
        </label>
      ) : null}
    </li>
  );
}

/** A point on the clip's clock, with a way to take it from the playhead. */
function TimeSlider({
  label,
  value,
  max,
  playhead,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  playhead: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mt-3 block">
      <span className="text-ui flex items-center justify-between">
        <span className="text-muted">{label}</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              onChange(playhead);
            }}
            className="press text-micro rounded border border-border px-1.5 py-0.5 font-semibold text-muted hover:border-control hover:text-fg"
          >
            at playhead
          </button>
          <span className="num font-semibold">{timecodeFine(value)}</span>
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={max}
        step={0.05}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-accent mt-1 h-11 w-full"
      />
    </label>
  );
}

/** Built-ins first, then the shared uploads, so a pack you added is easy to find. */
export function AssetOptions({ assets }: { assets: AudioAsset[] }) {
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

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
