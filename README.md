# clipperOS — viral clip factory

Paste a YouTube link (or upload a video of any length) → get a ranked board of
standalone short-form clips, each with a scored peak, the transcript, and the
reason it was picked. Then render the ones you pick as vertical clips, edit them
(trim, restyle the subtitles against a live preview, follow the speaker, paint
out a watermark, merge several into one), and keep them in S3 or delete them to
reclaim the storage.

**Genre-agnostic.** The pipeline has no built-in notion of what a good clip is.
Each genre supplies its own editorial rules — what qualifies, what to reject, how
to score, how long a clip should run, and whether the peak is a spoken line or a
visual moment. Motivation is one profile among several, not the architecture.

Ships with four: **motivation / advice**, **comedy / talk**, **sports / gaming**,
**music / performance**. Adding another is one entry in `config/genres.ts`.

## Why this is fast

Measured on a real 14-minute TED talk:

| | Reference pipeline | clipperOS |
|---|---|---|
| Transcript | download 1080p, then Whisper-align | **YouTube captions only** (`--skip-download`) |
| Time to clip board | 10–15 min | **~8 s** (ingest ~4 s + mining ~4 s) |
| Video download | before mining, always | **lazily, only when you render** |
| Whisper | always | opt-in, only for caption-less sources |

Renders are ~7–25 s per clip (one FFmpeg pass, on cached source).

### Three structural wins

1. **No download to mine.** yt-dlp fetches the caption track only. The 1080p
   source is pulled on the first render, once per project even with concurrent
   renders (in-flight fetch lock).
2. **Free forced alignment.** YouTube's inline `<ts><c>word</c>` tags are exact
   word onsets — no recognizer, no GPU, no cost. Whisper is only a fallback.
3. **Parallel chunk mining.** The transcript is split into 12-minute windows and
   mined 8 chunks at a time, with a hard output-token cap so a rambling model
   can't turn a 20 s pass into a 2-minute one.

## The genre system

A `GenreProfile` (`server/src/config/genres.ts`) answers five questions:

| Field | Meaning |
|---|---|
| `qualification` / `rejects` / `rewards` | What makes a clip, and what disqualifies one |
| `scoringAxes` | Named, weighted judgements — see below |
| `clipDuration` | `{ min, target, max }` seconds |
| `peakKind` | `"line"` (a burnable sentence) or `"moment"` (a play, a drop) |
| `themes` | Suggested cutaway themes |

### Scoring is data-driven

An axis either contributes **additively** to a craft sum, or — with
`gate: true` — **multiplicatively** as a near-veto:

```
craft = Σ (weight × score) / Σ weight          (normalised to 0-10)
gate  = Π (score / 10) ^ gateExponent          (0-1)
total = craft × gate × fluency
```

That distinction is the whole idea: craft axes trade off against each other, but a
precondition does not. A clip whose opening line is "and that's why I did it"
isn't merely weaker — it confuses every viewer, so no amount of hook compensates.
`fluency` only applies to a line peak (a moment has no text to stutter).

Crucially, **not every genre has every axis**. That asymmetry is why this is a
profile field rather than a constant:

| Genre | Axes | Gate | Duration | Peak | Captions |
|---|---|---|---|---|---|
| `motivation` | hook, payoff, quotability | standalone ^0.75 | 20–45s | line | on |
| `comedy_talk` | hook, punchline, humour, quotability | standalone ^0.6 | 15–55s | line | on |
| `sports_gaming` | hook, spectacle, stakes | — | 8–35s | moment | off |
| `music` | hook, peak, energy | — | 12–60s | moment | off |

Sports and music have **no gate at all**: nobody needs context to enjoy a goal or
a chorus. A clip is only ever judged by its own genre's rules, so the same
football video yields different clips (and different lengths) depending on whether
you cut it as a highlight or a motivation story.

### Genre detection

Omit the genre and one cheap call picks it from the title, channel, and a
transcript slice. Verified 4/4 correct on real videos:

```
AUTO motivation     conf=0.9  Inside the Mind of a Master Procrastinator (TED)
AUTO comedy_talk    conf=1    Me and My Boss | Stand-up Comedy
AUTO sports_gaming  conf=1    Chelsea 6-3 Leeds United | EFL Cup highlights
AUTO music          conf=1    OLIVIA RODRIGO FULL SET (LIVE)
```

Detection is best-effort: any failure falls back to motivation rather than
failing the import. You can always override it — before mining, or afterwards via
**re-mine**, which reuses the stored transcript and costs no re-ingest.

## Requirements

- **Bun** ≥ 1.3
- **FFmpeg + ffprobe** on PATH
- **MongoDB** (local `mongod` or an Atlas URI)
- **Redis** (`redis-server`)
- **OpenRouter API key**
- Optional: **AWS S3** credentials for CDN delivery, **whisper.cpp** for
  caption-less sources, and the **local vision stack** (OpenCV + YuNet, plus
  onnxruntime + RobustVideoMatting) for speaker-aware reframing, watermark
  removal and creator mode's behind-subject titles

## Setup

```bash
cd server
bun install
cp .env.example .env      # fill in OPENROUTER_API_KEY at minimum
bun run dev               # http://localhost:8787

cd ../client
bun install
bun run dev               # http://localhost:5174
```

Open <http://localhost:5174>, paste a link, and the clip board appears in seconds.

### Speaker tracking and watermark removal (optional)

Both need OpenCV, which ships as a Python wheel, so it lives in a project-local
venv rather than on your system Python:

```bash
cd server
bun run vision:install     # venv + OpenCV headless (~40 MB) + the YuNet model
# then set VISION_REFRAME_ENABLED=true in .env and restart
```

Neither feature is required. With the flag off, or the venv missing, reframing
falls back to the vision model and then a centre crop, and cleanup falls back to
ffmpeg `delogo` — a render never fails because of this.

### Redis + Mongo locally

```bash
redis-server --daemonize yes
# Use the machine's existing mongod on :27017 — do not start a second
# instance with a project dbpath on that port, or Compass will hide
# every other local database.
mongod --config /opt/homebrew/etc/mongod.conf --fork
```

`MONGODB_URI_FALLBACK` (optional) is tried automatically if the primary MongoDB
URI is unreachable.

### S3 (optional)

Set `S3_BUCKET` + AWS credentials and leave `OUTPUT_STORAGE=s3`. Objects go under
`S3_PREFIX` (default `clipperOS/`) so this app stays separate in a shared bucket.
With `OUTPUT_STORAGE=local` renders are served straight from the API.

## Configuration

All settings live in `server/.env` (see `.env.example`). The ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | — | **Required.** Mining, detection, smart reframe |
| `LLM_MODEL` | `google/gemini-2.5-flash-lite` | Latency-driven: ~0.6 s/call vs ~3.5 s for deepseek-v4-flash |
| `LLM_MAX_OUTPUT_TOKENS` | `2000` | Ceiling per chunk; stops models rambling |
| `VISION_MODEL` | `google/gemini-2.5-flash` | Smart-reframe frame analysis |
| `QUEUE_CONCURRENCY` | `3` | Render parallelism |
| `OUTPUT_STORAGE` | `s3` | `s3` \| `local` |
| `VISION_REFRAME_ENABLED` | `false` | Speaker tracking + watermark removal. Needs `bun run vision:install` |
| `RECONCILE_MIN_AGE_MS` | `900000` | Objects younger than this are never treated as orphans by the storage reconciler |
| `YT_DLP_JS_RUNTIME` | `node` | **YouTube video downloads need a JS runtime**; captions work without one |
| `WHISPER_ALIGNMENT_ENABLED` | `false` | Only needed for sources with no captions |

### If YouTube downloads start failing with HTTP 403

YouTube changes extraction often; a stale yt-dlp is the usual cause.

```bash
cd server && bun run ytdlp:update
```

## Pipeline

```
POST /api/projects
   └─ clip-ingest   fetch captions (or Whisper fallback)   ~4 s, no media
        └─ clip-mining   detect genre → parallel LLM sweep  ~4 s (14 min source)
             └─ clip-render  (on demand, per clip)  lazy download → reframe → captions → 1 FFmpeg pass
```

Both stages run as BullMQ jobs, so a restart mid-pipeline redelivers rather than
losing work.

## API

```
POST   /api/projects                  { youtubeUrl | uploadId, genreId? }
POST   /api/projects/:id/remine       { genreId? }   re-mine, no re-ingest
POST   /api/projects/:id/reconcile    reclaim S3 objects no live clip owns (?dryRun=0 to delete)
GET    /api/projects?limit=           newest first
GET    /api/projects/:id              project + clips + progress   (the poller)
DELETE /api/projects/:id              purge clips, media, output, S3 objects
GET    /api/projects/:id/media        stream the local source video (HTTP range / 206)
POST   /api/projects/:id/media/ensure start fetching the source if it is not local yet
GET    /api/genres                    available rulesets + their axes
GET    /api/caption-styles            available caption looks
POST   /api/uploads                   multipart `file` -> { uploadId }
POST   /api/clips/render              { clipIds, reframeMode, captions? }
POST   /api/clips/merge               { projectId, clipIds[], title? } -> a new merged clip
GET    /api/clips/:id                 clip detail
GET    /api/clips/:id/words           word onsets in the clip's window (for local preview)
PATCH  /api/clips/:id                 { title?, edit?, segments? } persist edits, no render
DELETE /api/clips/:id                 purge this clip's S3 object, local file and record
GET    /api/clips/:id/download        inline stream (?download=1 for attachment)
POST   /api/clips/:id/dismiss         drop a candidate (keeps its storage)
GET    /health
```

Envelope: `{ success: true, data }` or `{ success: false, error }`.

## Editing

The studio is URL-routed, so every view has an address. A refresh lands where
you were, the Back button moves between clips, and a clip link is shareable:

| URL | Page |
|---|---|
| `/` | Intake + the project picker |
| `/projects/:projectId` | That project's clip board |
| `/projects/:projectId/clips/:clipId` | The clip editor |

The editor is a **page**, not a modal, and edits **autosave** on a short
debounce. Saving is a metadata write, so it costs nothing until you render —
and a refresh, a crash or a closed tab never costs you your work.

A rendered clip is a starting point, not a deliverable. Each clip carries a
persisted **edit spec** (`clip.edit`) — window, framing, caption look — and the
renderer is the only thing that interprets it.

- **Trim.** In/out handles on the clip window, marked against the *source*
  clock the renderer seeks on, so what you mark is what you get. `I` / `O` mark
  in and out at the playhead; `Cmd/Ctrl+S` saves.
- **Subtitles, live.** Caption grouping and styling are computed **in the
  browser** from the project's word onsets (`GET /api/clips/:id/words`), so
  dragging a trim handle or changing a preset updates the preview with no
  round-trip. The server burns the same grouping into the final render.
- **Styles are data.** Looks live in `config/caption-styles.ts` — same shape as
  `config/genres.ts`: an open registry, not an enum. Adding one is an entry, and
  the client fetches the list. `clean` reproduces the original constants
  exactly, so an unedited clip renders byte-for-byte as before. Per-clip tweaks
  layer on top; `PATCH` with `captionOverrides: {}` clears them back to the
  preset (omitting the key would mean "no change", so it could never reset).
- **Merge.** Select two or more clips and merge them into a new one. The merge is
  **non-destructive** — it stores its own segments and provenance, so the
  sources are untouched and it survives them being deleted. Segments can be
  reordered and re-trimmed, and playback previews them in order.
- **Framing.** `smart` (speaker tracking, then the vision model) or `center` per
  clip. A merge defaults each segment to `center` rather than paying for N analyses.
- **Cleanup: burned-in text, logos and watermarks.** Drag a rectangle over the
  mark in the editor and the renderer reconstructs those pixels from what
  surrounds them. Regions are stored in **source pixels**, because cleanup runs
  **before** the reframe crop, so a crop change never invalidates them, and they
  live in the same edit spec as everything else — autosaved, persisted, and an
  explicit empty array clears them.
  - Preferred: `python/cleanup_inpaint.py` (OpenCV Telea) detects the actual
    glyph strokes inside each rect and fills only those, so the real background
    between and around the letters is kept.
  - Fallback: a time-gated ffmpeg `delogo` per region. Cheap and dependency-free,
    but it interpolates the rect's border inward and leaves faint stripes on
    anything larger than a small logo.
- **Sound.** The third desk mixes the voice with **music beds** and **hits** on
  the output clock (`clip.edit.soundtrack`). Up to 8 beds play at once, each
  its own file with a level, a *dip under speech* (a sidechain compressor keyed
  off the voice; the slider is the dip in dB, and `dip=0` leaves it alone), in
  and out points on the clip, a start point in the file (which loops), fade
  lengths (auto: a sixth of the span, up to 1.2 s) and whether it carries into
  the sting. Up to 32 hits, each with its own level. The live preview plays one
  looping `<audio>` per bed with the same rules (`lib/music-beds`) and dips it
  where the transcript's words are, at the compressor's attack and release, so
  what you hear on the desk is the mix. `bun run soundtrack:validate` runs the
  graph through ffmpeg and measures it.

### Creator mode

The third desk in the editor (**Edit · Create · Sound**, `?desk=create`). Where the
Edit desk sets one look for the whole clip, Create carries a **beat plan** — the
per-scene decisions a Shorts editor makes — on a lane timeline, and renders it
WYSIWYG. It lives on `clip.edit.creator`; a clip without one (or with it switched
off) renders exactly as before.

| Lane | What it is | How it burns |
|---|---|---|
| **Cuts** | Dead air to remove. *Find dead air* intersects word-onset gaps with ffmpeg `silencedetect`; each candidate is a toggle. | The trim becomes N kept windows, concatenated in one graph (the merge path). The player skips the gaps. |
| **Camera** | *Ride the speaker* (the crop follows the tracked face by a tightness; optional persistent punch-in and *lead room* toward where the head faces) and **moves**: `punch` (jump in, hold, release), `push` (slow creep), `pull` (open tight, settle), `frame` (ramp to a framing you drag in the Framing widget — zoom from/to, so a zoom *out* too, and a pan of the 9:16 window over the source — and hold it), `hold` (lock the camera off: the follow stops riding the head for the span, then glides back over 0.35 s; it ends at a shot cut). Anchor on the face, the centre, a point, or `look` (ahead of the face, from the analyser's head yaw). | `scale … eval=frame` + `crop` with piecewise expressions of `t` — the same technique as the pan — so the preview's zoom is the burn's zoom. The pan is a flat-sum term on the base crop. A hold rewrites the camera path both sides frame from (`cameraTrackFor`: smoothing, then the holds) into a flagged plateau the renderer's de-duplication keeps. Zoom is capped at 1.5× (0.75× of the follow zoom for a zoom out); the UI warns past 1.35× on 1080p. |
| **Speed** | Slow motion (0.2–0.9×, optionally motion-interpolated), fast (1.1–3×) and freeze spans. The voice fades out through slow motion and freezes; music and hits keep the output clock. | The span becomes its own window with a rate: `setpts` (+ `minterpolate`), `loop`+`trim` for a freeze, `afade`+`apad` (or `atempo` when fast) on the voice. The player drives `playbackRate` and mutes the voice. |
| **FX** | 31 stackable looks (`config/effects.ts`, served at `GET /api/effects`): colour (B&W, duotone, thermal…), texture (grain, VHS, old film…), motion (echo, shake, zoom pulse…), glitch (RGB split, broken TV, strobe…), frame (bars, vignette, bloom, fades). | Filter fragments gated to the span with `enable` (RGB-space and temporal filters on a split/overlay branch, so frames outside the span are untouched), after the camera, before the captions. The preview is a CSS/canvas approximation (the picker's tiles show each look live on the clip's own crop, at the span's amount); *Render this span* (`POST /api/clips/:id/preview-span`) is exact. |
| **B-roll** | Cutaways from the media library — uploads (or drop a file on the lane) and Pexels/Pixabay stock (`PEXELS_API_KEY` / `PIXABAY_API_KEY`, either optional; HD files, portrait first) — with cover or blurred fit, a Ken Burns drift, and one of 15 transitions in and out (`GET /api/transitions`: dissolve, dips, slides, wipes, soft wipe, iris, pixelize, zoom). The voice runs on underneath. Stock downloads no clip uses are swept after a day; uploads are kept. | Each is an extra input, fitted and drifted, transitioned with `xfade` against the cutaway's own frames at alpha 0 (so no transition dips darker; dips go through their colour; a dissolve is an alpha `fade`), then overlaid for its span under the captions. The clip's clock and audio are untouched. |
| **Captions** | Scenes with their own look: preset, font, size, colours, box, words-per-caption, and *colour the spoken word* (karaoke). A group never crosses a scene boundary. | One ASS style pair per scene; karaoke writes one line per word span with the active word in the accent. |
| **Titles** | Free-placed hook text, *behind* the speaker or in front, with pop / fade / rise entrances. | A behind-title is composited between the background and the speaker's cutout from a **person matte** (RobustVideoMatting on onnxruntime, in the vision venv), built only over the title's span and cached per clip under `storage/media/<project>/matte/`. Without the matte the title burns in front and the render says so. |
| **SFX** | The Sound desk's hits, on the output clock, drawn as pins. | `mixSoundtrackOntoClip`, unchanged. |

**The AI Director** (`POST /api/clips/:id/direct`) writes the whole plan in one
call from what the pipeline already knows — every word onset and caption line,
the mined peak, shot changes, where the face sits and which way it looks, the
dead air, the catalogue of looks, effects, transitions, sounds and library
media — and saves it through the same sanitiser as the editor. It is on demand:
*Direct this clip*, then *Redirect* with notes ("slow-mo the last line, VHS on
the hook, cut to a server room on *compute*"), locking any lane you want kept.
The last six passes are kept as a conversation and handed back to the model, so
notes build on each other; a lane the answer leaves out stays as it is. A
cutaway may name a library asset or a stock query — the server searches, takes
the first portrait result and downloads it; one that finds nothing is left out
with a warning, never the render. A malformed answer leaves the stored plan
untouched.

**The harness** (`sense.service`, `taste.service`, `ai-assets.service`) is
what makes the Director an editor rather than a transcript reader:

- **It watches the clip.** The trim window goes to the model as a 360p / 8 fps
  proxy with its audio (`video_url` base64 on OpenRouter; Gemini 3.8 Flash,
  routed to Vertex) and comes back as shots, visible moments to cut on ("2.2 s
  laughs and gestures outward → punch in"), B-roll it would earn, how it
  sounds, and its own read of the hook and payoff. Cached on the clip per
  trim; shown on the Director tab as *What it saw*. The pass itself gets the
  video too, so beats land on what it sees, not only on a word.
- **It listens to the library.** Every bed and hit — built-in, uploaded or
  generated — is described once from its actual sound (`input_audio`): "dark
  aggressive phonk beat with distorted cowbells, punchy 808s, 136 BPM, energy
  4". Pictures likewise. The catalogue in the prompt is those descriptions,
  so it picks *your* uploads by what they sound like. *Describe the library*
  on the Studio tab fills in anything new; a pass describes up to 12 on its own.
- **It lays music.** Beds are a lane (`music`): up to two, chosen by sound
  against the genre and the speaker's energy, at a level and dip under speech
  the mixer honours exactly (see Sound above), a second bed taking over at
  the peak when it earns it.
- **It makes what it cannot find.** B-roll comes from the *Library*, *Stock*,
  *AI* or *Both* (the Director picks per cutaway in *Both*). A generated
  still is made in the pass (~10 s, `IMAGE_MODEL`); a generated video is
  submitted (`VIDEO_MODEL`, minutes) with that still standing in as the
  cutaway until the motion lands and swaps itself in. A bed can be composed
  to order (`MUSIC_MODEL`, ~20 s) when nothing in the catalogue fits.
- **It learns.** Three signals become short lessons in its memory: what you
  changed after a pass (read as taste when the clip renders), what it found
  wrong watching the render (it scores every directed export 1–10, with
  timed issues and fixes — *After the render* on the Director tab), and a
  thumbs up / down with a note. Lessons are global or per project, weighted
  (your own words outrank inference), fed back into every pass, and
  consolidated when they pile up. The Studio tab lists them; any can be
  forgotten or written directly. `DIRECTOR_LEARN=0` switches the post-render
  watching off.

`DIRECTOR_MODEL` picks the model (default `google/gemini-3.8-flash`, which
has video and audio input on OpenRouter — checked live against
`/api/v1/models`). A model without video input still works from the words.

**The studio** (Create → Studio, `POST /api/studio/generate`) makes stills,
motion and music to order on OpenRouter — all models are swappable
(`IMAGE_MODEL`, `VIDEO_MODEL`, `MUSIC_MODEL`) — and sound effects on fal.ai
(`FAL_KEY`, `SFX_MODEL`; OpenRouter has no SFX model — its audio-output
models are music and speech only. Stable Audio 3 Small SFX is ~2¢ an
effect, ElevenLabs' SFX through fal $0.002 a second). A hit is trimmed of
silence and levelled like the bundled ones. *Find a sound* searches
**Freesound** (`FREESOUND_API_KEY`, free): real recordings, filtered to CC0
and Attribution licences (the credit is kept with the file), with a preview
to play before taking one. The Director may ask for a sound the catalogue
lacks (`{ "query": "glass shatter" }` on a hit): the rated matches are
taken in turn and each is listened to — only a recording the harness scores
clean is placed, at most three lookups a pass. **Sound packs** (Studio →
Sound packs) install Kenney's public-domain (CC0) packs in one click — no
key, no credit: impacts (glass, metal, wood, plates, punches, footsteps),
interface, UI, digital, sci-fi, RPG, casino, jingles — several hundred
one-shots ingested like uploads, folded away in the pickers until searched
for, described by the harness in the background. The Director's sound
lookups try the installed packs first (`searchLocalSounds`: name, pack, the
harness's tags and description), then an online library if one is
configured. With an **Epidemic Sound**
partner key (`EPIDEMIC_SOUND_API_KEY`) the same search and the Director's
lookups go to its licensed library instead — 250k effects and 55k tracks,
with music too: the Director may ask for a bed by query and BPM window
(`{ "query": "lo-fi chill laid back", "bpmMin": 70, "bpmMax": 95 }`) and an
instrumental match is downloaded at 320 kbps with its credit. Exports that
carry Epidemic audio are reported to its usage endpoint. Everything lands in the shared
libraries like an upload does, described by the harness on arrival, so it is
reusable in any project and pickable by content. *Animate a still* turns a
library image into the first frame of a 5–15 s video — the way to build your
own motion assets from generated art. Videos render on the provider for
minutes; `GET /api/studio/jobs` polls, and a job the Director started fills
its cutaway in when it completes.

Timing is source seconds everywhere; `creator-timeline.ts` (server, and a verbatim
client port) owns the source↔output clock and the numeric camera, and
`bun run creator:validate` + `client/scripts/validate-creator-parity.ts` assert
the burn's expressions, the preview's maths and the two ports agree.

### Preview is the output

The player shows the **9:16 crop**, not the source. It applies the same step
function the renderer uses, so what you see is what renders — and "Fit source"
reveals what the crop is cutting off. An un-analysed clip falls back to a centred
9:16 window, so the preview is honest before a first render too.

### Storage lifecycle

`download` and the S3 object are the same artefact, not two deliveries.

- **One scratch directory per render**, removed wholesale in `finally`. The
  `.ass` files, the pre-upload MP4 and any FFmpeg partial all go together, so a
  per-file `rm` cannot leak and a crashed render cannot strand scratch.
- **S3 is the home** when the project is `s3`-mode: the render uploads to a
  stable per-clip key (`<prefix>clips/<clipId>.mp4`), verifies the object landed,
  then **deletes the local copy**. Playback and downloads use the CDN.
- **Merges concat inside one filtergraph.** N seeked inputs normalised and
  stitched by `concat`, so there are no per-segment temp files and no second
  pass.
- **Deleting is surgical.** `DELETE /api/clips/:id` removes exactly one object
  (from `outputKey`, or parsed from `outputUrl` for pre-existing rows), its local
  file and its record, and reports the bytes reclaimed. `dismiss` stays the
  cheap, undoable hide and deliberately keeps storage.
- **Editing writes no assets.** A saved edit is a metadata write: no render runs,
  so no `.ass`, no scratch directory, no intermediate. Verified by diffing the
  whole storage tree across a full editing session — trim, caption style and
  overrides, cleanup regions, framing — which created zero files. The only thing
  that touches disk is a render, and a render is always inside its own scratch
  directory.
- **A sweeper is the safety net.** At boot and every 30 minutes it clears:
  abandoned `processing/` entries older than 6 h, `output/` directories whose
  project is gone, **and** source-media debris — yt-dlp fragments (`.part`, one
  file per selected format) and any `source.mp4` whose project never reached
  `ready`, which is what a killed download leaves behind. A live `source.mp4` for
  a `ready` project is never touched, and anything recent is skipped so an
  in-flight download cannot be swept mid-flight. It also resets a project whose
  `mediaStatus` was left lying at `fetching`, so the next attempt starts clean.
- **A failed download cleans up after itself.** The lazy source fetch removes its
  fragments and returns the project to `absent` on failure, rather than leaving
  hundreds of MB of debris behind a status that reads as work in progress.
- **Both kinds of storage are reported.** `storageBytes` counts rendered clips;
  `mediaBytes` reports the cached source, which is the largest thing this app
  writes and is kept until the project is deleted.
- **Storage is reconciled, not guessed.** `POST /api/projects/:id/reconcile`
  finds S3 objects no live clip owns. Objects newer than
  `RECONCILE_MIN_AGE_MS` are reported, never deleted, and the default is a dry
  run — only an explicit `?dryRun=0` reclaims.

## Output quality

- **Reframe.** Three strategies, cheapest capable first, each falling through to
  the next so framing is never the reason a render fails:
  1. **Speaker tracking** (local, needs the vision venv). Faces are detected at
     ~3fps and their mouth motion is correlated against the audio envelope, so the
     crop follows whoever is actually talking. Shot cuts are detected, and the
     crop **jumps** across a cut while a handover inside one shot **glides** —
     conflating those two is what makes reframing look like the camera wandering.
     Keyframes are rendered as consecutive fixed-crop segments, so no ffmpeg
     expression parser is involved. See `bun run reframe:validate`.
  2. **The vision model**: one cheap call per clip asking where the speaker sits.
     Still useful as a second opinion when the face analysis is not confident.
  3. **Centre crop**: deterministic, instant, never fails.

  The resolved track is cached on the clip, so a re-render reuses the analysis
  instead of paying for it again; changing the trim invalidates it.
- **Captions.** Real word onsets grouped a few words at a time, burned via libass;
  the peak window renders larger in accent `#34D8FF`. On by default only for
  speech-driven genres — override per render with `captions`.
- **Guards.** A render that seeks past EOF, or writes an implausibly small file,
  fails loudly instead of reporting a broken clip as successful. Re-mining clears
  the previous renders so no orphans are left in S3 or on disk.

### A note on caption text

YouTube publishes two English tracks and they are not equivalent:

| Track | Size | Word tags | Text |
|---|---|---|---|
| `en-orig` | 113 KB | **1921** | raw ASR — no punctuation or capitals |
| `en` | 22 KB | 0 | punctuated |

clipperOS prefers whichever track **actually carries inline word tags**, because
those onsets keep captions locked to speech (and remove the need for Whisper). The
cost is that burned captions read like YouTube's own auto-captions — lowercase,
unpunctuated. Sync was chosen over punctuation deliberately: a caption on the wrong
syllable costs retention, a missing comma doesn't.

## Known limits

- **Text is the signal.** Mining reads a transcript, so content with no speech
  cannot be mined at all — a silent NBA highlight, a fully instrumental track.
  Verified: NBA highlight videos carry no captions, so `sports_gaming` has nothing
  to work with there. Real highlight detection for those needs audio-energy and
  scene analysis, which is not built.
- **Sports/music peaks are moments, not lines.** The profile supports a peak with
  no spoken line (`peakKind: "moment"`), but the *timing* still comes from the
  transcript. A peak that happens between words is located only to the nearest
  sentence.
- Highlight clips can land slightly over the max duration: the span is fitted to
  the band and then snapped outward to caption-cue boundaries.
- **Speaker tracking needs faces.** A clip with no detectable faces (a screen
  recording, an instrumental) falls back to a centre crop rather than inventing a
  subject. On a two-shot where both people talk at once it deliberately goes to a
  full-frame letterbox instead of whipping the crop back and forth.
- **A multi-segment render drifts ~1% longer than its window.** Each keyframe
  segment rounds to whole frames, so a 25s tracked clip came out 25.2s. It is
  imperceptible and well inside the render's own duration validation, but it is
  real and measurable.
- **Stroke inpainting removes text, not a plate.** It reconstructs the glyphs
  from their immediate surroundings, which is what makes it sharp where `delogo`
  smears. If a watermark sits on a solid opaque box with no real background left
  inside the rect, the box is what neighbours the strokes, so the result is a
  clean box rather than restored footage — widen the rect to include real
  background around it.

## Scripts

```bash
bun run validate:mining <url> [genreId]   # mine a real video, assert the contract
bun run creator:validate                  # beat plan sanitiser, clock mapping, camera expressions, Director post-processing
bun run harness:validate                  # the harness's parsers (sense, review, catalogue), taste prompt, studio prompt framing
bun run effects:validate                  # every effect through ffmpeg: parses, gates to its span, stacks
bun run cutaways:validate                 # cutaway graphs on synthetic media: fits, transitions, untouched picture between
bun run soundtrack:validate               # the mix graph, then ffmpeg on synthetic beds: in/out, offset, the dip under speech
bun run reframe:validate                  # speaker-tracking decision logic, no Python needed
bun run vision:install                    # venv + OpenCV + YuNet (for tracking and cleanup)
bun run typecheck
bun run ytdlp:update                      # fix HTTP 403 on video downloads
bun run whisper:install                   # optional caption-less fallback
```

`validate:mining` fetches a transcript, mines it under the given (or detected)
genre, prints the ranked candidates with their per-genre axes, and exits non-zero
if any invariant breaks: no candidates, a peak line not verbatim in the
transcript, a peak outside the clip, a duration outside the genre's band, a
missing or extraneous score axis.

## Layout

```
server/src/
  config/genres.ts                 THE editorial brains — all genre knowledge lives here
  config/caption-styles.ts         the caption looks (same open-registry shape)
  services/mining.service.ts       segmentation, chunking, peak location (no genre knowledge)
  services/genre-detect.service.ts one call to pick the genre
  services/ingest.service.ts       yt-dlp wrappers, caption fetch, lazy media
  services/transcript.service.ts   VTT parsing + word-onset extraction
  services/reframe.service.ts      the framing provider ladder
  services/speaker-reframe.service.ts  faces + mouth motion -> crop keyframes
  services/cleanup.service.ts      watermark removal (inpaint, then delogo)
  services/caption.service.ts      caption chunks + ASS generation (per-scene looks, karaoke)
  services/creator-timeline.ts     creator mode's clock mapping + numeric camera (ported to the client)
  services/creator-plan.service.ts beat plan sanitiser
  services/camera.service.ts       the camera as FFmpeg expressions
  services/pause-detect.service.ts dead-air candidates (word gaps ∩ silencedetect)
  services/matte.service.ts        the person matte behind titles (RVM via python/person_matte.py)
  services/title.service.ts        title ASS layers
  services/director.service.ts     the AI Director: brief → plan (stock queries resolved before it is applied)
  config/effects.ts                the effects registry (filter fragments + preview hints)
  config/transitions.ts            cutaway transitions
  services/effects.service.ts      the FX lane as one filter chain per window
  services/cutaway.service.ts      cutaway inputs, fits, Ken Burns, xfade transitions
  services/media-library.service.ts  shared stills and videos (uploads + stock picks)
  services/stock.service.ts        Pexels + Pixabay behind one search
  services/clip-render.service.ts  the single-pass render (and the concat paths)
  services/clip.service.ts         edit specs, merges, delete, storage accounting
  services/storage-custody.service.ts  orphan sweeps + S3 reconciliation
  utils/scratch.utils.ts           scratch directories + the processing/ sweeper
  utils/stream.utils.ts            range-correct local media streaming
  queue/{queues,workers}.ts        BullMQ ingest → mining → render
  routes/ controllers/ models/     HTTP + persistence
server/python/                     optional helpers (OpenCV), JSON in / JSON out
  reframe_analyze.py               YuNet faces + mouth energy + cut detection
  cleanup_inpaint.py               Telea inpainting of glyph strokes
client/src/
  App.tsx                          routes, state hub, polling, actions
  routes.ts                        the URL map (/projects/:id, /projects/:id/clips/:id)
  components/ClipEditor.tsx        the editor page (trim, live captions, cleanup, merge parts)
  components/BeatTimeline.tsx      creator mode's lane timeline
  components/CreatorDesk.tsx       creator mode's right rail: Add & edit · Whole clip · AI Director tabs
  components/lanes.ts              one name, icon and summary per beat lane (timeline, Add list, inspectors)
  components/DirectorPanel.tsx     notes, lane locks, and the conversation with the Director
  components/FramingWidget.tsx     drag the 9:16 window and zoom anchor over the source
  components/CutawayLayer.tsx      cutaways over the preview, transitions as CSS
  components/MediaPicker.tsx       library + stock search for B-roll
  lib/fx-preview.ts                the FX lane's CSS/canvas approximation
  lib/creator-timeline.ts          port of the server's creator timeline
  components/CleanupLayer.tsx      draw/move/resize watermark regions
  components/CaptionOverlay.tsx    captions drawn like the burn, at any player size
  lib/reframe.ts                   the crop preview's step function and transforms
  lib/captions.ts                  the preview port of the server's grouping
```

## Not in v1

Music-drop alignment, loudness normalisation, publishing,
auth/billing. Audio/visual peak detection (see Known
limits). A generated headline hook-card is also deferred — `hookText` is shown on
the board but not burned, since a duplicate of the opening captions is worse than
none.
