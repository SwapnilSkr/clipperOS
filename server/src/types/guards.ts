import { t } from "elysia";

/** Allowed genre ids, mirrored from config/genres.ts for request validation. */
export const GenreIdLiteral = t.Union([
  t.Literal("motivation"),
  t.Literal("comedy_talk"),
  t.Literal("sports_gaming"),
  t.Literal("music"),
]);

/**
 * Exactly the shape POST /api/uploads mints: `${crypto.randomUUID()}.${ext}`.
 *
 * Without this, `uploadId` was any 1-200 character string. It is joined onto the
 * uploads directory to build a filesystem path, and `join` collapses `..`, so
 * `"../../../../etc/passwd"` escaped the storage root. The id is also persisted
 * and later passed to `rm()` on project delete, which made it an arbitrary file
 * delete. Constraining the shape at the boundary removes the vector entirely.
 */
const UPLOAD_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.[a-z0-9]{1,6}$";

/**
 * Mongoose ObjectId. Validating it here stops a malformed id from reaching
 * `findById()`, where it throws a CastError that the error handler reports as a
 * 500 with the internal driver message attached.
 */
const OBJECT_ID_PATTERN = "^[0-9a-f]{24}$";

export const CreateProjectBody = t.Object({
  /** Full YouTube URL or a bare 11-char video id. */
  youtubeUrl: t.Optional(t.String({ minLength: 6, maxLength: 500 })),
  /** Id returned by POST /api/uploads. */
  uploadId: t.Optional(t.String({ maxLength: 200, pattern: UPLOAD_ID_PATTERN })),
  title: t.Optional(t.String({ minLength: 1, maxLength: 300 })),
  /** Omit to let detection pick the genre from the content. */
  genreId: t.Optional(GenreIdLiteral),
});

export const ListProjectsQuery = t.Object({
  limit: t.Optional(t.String()),
  status: t.Optional(t.String({ maxLength: 40 })),
});

export const RenderClipsBody = t.Object({
  clipIds: t.Array(t.String({ pattern: OBJECT_ID_PATTERN }), { minItems: 1, maxItems: 60 }),
  reframeMode: t.Optional(t.Union([t.Literal("center"), t.Literal("smart")])),
  /** Override the genre's caption default (e.g. force captions off). */
  captions: t.Optional(t.Boolean()),
});

/** Re-mine an already-ingested project, optionally with a different genre. */
export const RemineBody = t.Object({
  genreId: t.Optional(GenreIdLiteral),
});

// ---------------------------------------------------------------------------
// Clip editing
//
// `captionStyleId` is validated as a plain bounded string, NOT a literal union:
// the style registry is data-driven and meant to grow, so closing it here would
// make every new preset a request-schema change. `resolveCaptionStyle` falls back
// to the default for an id it does not know.
// ---------------------------------------------------------------------------

const CaptionOverridesBody = t.Object({
  chunkWords: t.Optional(t.Number()),
  sizeScale: t.Optional(t.Number()),
  verticalFrac: t.Optional(t.Number()),
  horizontalFrac: t.Optional(t.Number()),
  textColor: t.Optional(t.String({ maxLength: 9 })),
  background: t.Optional(t.Union([t.Literal("none"), t.Literal("box")])),
  animation: t.Optional(t.Union([t.Literal("none"), t.Literal("pop"), t.Literal("fade")])),
  peakColor: t.Optional(t.String({ maxLength: 9 })),
  peakEmphasis: t.Optional(t.Boolean()),
  fontFamily: t.Optional(t.String({ maxLength: 60 })),
  uppercase: t.Optional(t.Boolean()),
  highlight: t.Optional(t.Union([t.Literal("none"), t.Literal("word")])),
});

// ---- creator mode ----
const PauseCutBody = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  startSec: t.Number(),
  endSec: t.Number(),
  enabled: t.Boolean(),
  source: t.Union([t.Literal("director"), t.Literal("user")]),
});

const CameraMoveBody = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  kind: t.Union([t.Literal("punch"), t.Literal("push"), t.Literal("pull")]),
  startSec: t.Number(),
  endSec: t.Number(),
  zoom: t.Number(),
  anchor: t.Union([t.Literal("face"), t.Literal("center"), t.Object({ x: t.Number(), y: t.Number() })]),
  ease: t.Union([t.Literal("cut"), t.Literal("out"), t.Literal("in_out")]),
});

const CaptionSceneBody = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  startSec: t.Number(),
  endSec: t.Number(),
  label: t.Optional(t.String({ maxLength: 40 })),
  styleId: t.Optional(t.String({ maxLength: 40 })),
  overrides: t.Optional(CaptionOverridesBody),
});

const BehindTitleBody = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  text: t.String({ maxLength: 120 }),
  startSec: t.Number(),
  endSec: t.Number(),
  x: t.Number(),
  y: t.Number(),
  sizeScale: t.Number(),
  fontFamily: t.Optional(t.String({ maxLength: 60 })),
  color: t.String({ maxLength: 9 }),
  uppercase: t.Optional(t.Boolean()),
  animation: t.Union([t.Literal("none"), t.Literal("pop"), t.Literal("fade"), t.Literal("rise")]),
  depth: t.Union([t.Literal("behind"), t.Literal("front")]),
});

export const CreatorPlanBody = t.Object({
  enabled: t.Boolean(),
  version: t.Literal(1),
  cuts: t.Optional(t.Array(PauseCutBody, { maxItems: 40 })),
  camera: t.Optional(
    t.Object({
      follow: t.Optional(
        t.Object({
          enabled: t.Boolean(),
          tightness: t.Number(),
          zoom: t.Optional(t.Number()),
          response: t.Optional(t.Union([t.Literal("snappy"), t.Literal("natural"), t.Literal("smooth")])),
          axis: t.Optional(t.Union([t.Literal("both"), t.Literal("x"), t.Literal("y")])),
        })
      ),
      moves: t.Array(CameraMoveBody, { maxItems: 24 }),
    })
  ),
  captionScenes: t.Optional(t.Array(CaptionSceneBody, { maxItems: 12 })),
  titles: t.Optional(t.Array(BehindTitleBody, { maxItems: 6 })),
  director: t.Optional(
    t.Object({
      notes: t.Optional(t.String({ maxLength: 600 })),
      summary: t.Optional(t.String({ maxLength: 1200 })),
      generatedAt: t.Optional(t.String({ maxLength: 40 })),
      model: t.Optional(t.String({ maxLength: 80 })),
    })
  ),
});

const CaptionTextOverrideBody = t.Object({
  startSec: t.Number(),
  id: t.Optional(t.String({ maxLength: 64 })),
  text: t.Optional(t.String({ maxLength: 160 })),
  displayStartSec: t.Optional(t.Number()),
  endSec: t.Optional(t.Number()),
  hidden: t.Optional(t.Boolean()),
  custom: t.Optional(t.Boolean()),
});

const CaptionWordOverrideBody = t.Object({
  t: t.Number(),
  word: t.Optional(t.String({ maxLength: 120 })),
  hidden: t.Optional(t.Boolean()),
});

const VideoEffectsBody = t.Object({
  grade: t.Optional(t.Union([
    t.Literal("natural"), t.Literal("vibrant"), t.Literal("warm"),
    t.Literal("cool"), t.Literal("cinematic"),
  ])),
  motion: t.Optional(t.Union([
    t.Literal("none"), t.Literal("hook_push"), t.Literal("peak_punch"),
  ])),
  zoom: t.Optional(t.Number()),
  sharpen: t.Optional(t.Number()),
  vignette: t.Optional(t.Boolean()),
  audio: t.Optional(t.Union([t.Literal("natural"), t.Literal("voice"), t.Literal("loud")])),
});

const SoundtrackHitBody = t.Object({
  id: t.String({ minLength: 1, maxLength: 80 }),
  assetId: t.String({ minLength: 1, maxLength: 80 }),
  atSec: t.Number(),
  gain: t.Optional(t.Number()),
});

const SoundtrackBody = t.Object({
  voiceGain: t.Optional(t.Number()),
  music: t.Optional(
    t.Object({
      assetId: t.Optional(t.String({ maxLength: 80 })),
      gain: t.Optional(t.Number()),
      duck: t.Optional(t.Boolean()),
      carryIntoOutro: t.Optional(t.Boolean()),
    })
  ),
  sfx: t.Optional(t.Array(SoundtrackHitBody, { maxItems: 16 })),
});

const CleanupRegionBody = t.Object({
  id: t.String({ maxLength: 80 }),
  x: t.Number(),
  y: t.Number(),
  w: t.Number(),
  h: t.Number(),
  start: t.Number(),
  end: t.Number(),
});

const ClipEditBody = t.Object({
  trimStartSec: t.Optional(t.Number()),
  trimEndSec: t.Optional(t.Number()),
  reframeMode: t.Optional(t.Union([t.Literal("center"), t.Literal("smart")])),
  captionsOn: t.Optional(t.Boolean()),
  captionStyleId: t.Optional(t.String({ maxLength: 40 })),
  captionOverrides: t.Optional(CaptionOverridesBody),
  captionTextOverrides: t.Optional(t.Array(CaptionTextOverrideBody, { maxItems: 240 })),
  captionWordOverrides: t.Optional(t.Array(CaptionWordOverrideBody, { maxItems: 800 })),
  editTemplateId: t.Optional(t.String({ maxLength: 40 })),
  videoEffects: t.Optional(VideoEffectsBody),
  soundtrack: t.Optional(SoundtrackBody),
  outro: t.Optional(
    t.Object({
      enabled: t.Optional(t.Boolean()),
      transitionId: t.Optional(
        t.Union([
          t.Literal("smash"),
          t.Literal("punch"),
          t.Literal("whip"),
          t.Literal("flash"),
          t.Literal("dip"),
          t.Literal("blur"),
          t.Literal("push"),
        ])
      ),
      outroId: t.Optional(t.String({ minLength: 4, maxLength: 24, pattern: "^[a-z0-9]+$" })),
    })
  ),
  cleanup: t.Optional(t.Array(CleanupRegionBody, { maxItems: 8 })),
  creator: t.Optional(CreatorPlanBody),
});

/** GET /api/clips/:id/pauses — dead-air candidates inside a window. */
export const PausesQuery = t.Object({
  startSec: t.Optional(t.String()),
  endSec: t.Optional(t.String()),
});

/** POST /api/clips/:id/direct — one Director pass. */
export const DirectClipBody = t.Object({
  notes: t.Optional(t.String({ maxLength: 600 })),
  /** Lanes to leave exactly as they are. */
  keep: t.Optional(
    t.Array(
      t.Union([
        t.Literal("cuts"),
        t.Literal("camera"),
        t.Literal("captions"),
        t.Literal("titles"),
        t.Literal("sfx"),
      ]),
      { maxItems: 5 }
    )
  ),
});

export const AudioLibraryQuery = t.Object({
  projectId: t.Optional(t.String({ pattern: OBJECT_ID_PATTERN })),
});

export const BuiltinAudioParams = t.Object({
  id: t.String({ minLength: 1, maxLength: 40, pattern: "^[a-z][a-z0-9_]{0,31}$" }),
});

export const SharedAudioParams = t.Object({
  fileId: t.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  }),
});

export const ProjectAudioParams = t.Object({
  id: t.String({ pattern: OBJECT_ID_PATTERN }),
  fileId: t.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  }),
});

const ClipSegmentBody = t.Object({
  startSec: t.Number(),
  endSec: t.Number(),
  sourceClipId: t.Optional(t.String({ pattern: OBJECT_ID_PATTERN })),
  reframeMode: t.Optional(t.Union([t.Literal("center"), t.Literal("smart")])),
  captionStyleId: t.Optional(t.String({ maxLength: 40 })),
  captionsOn: t.Optional(t.Boolean()),
});

/** PATCH /api/clips/:id — persist an edit. Any subset may be sent. */
export const UpdateClipBody = t.Object({
  title: t.Optional(t.String({ maxLength: 200 })),
  edit: t.Optional(ClipEditBody),
  segments: t.Optional(t.Array(ClipSegmentBody, { maxItems: 20 })),
});

/** POST /api/clips/merge — order is the play order. */
export const MergeClipsBody = t.Object({
  projectId: t.String({ pattern: OBJECT_ID_PATTERN }),
  clipIds: t.Array(t.String({ pattern: OBJECT_ID_PATTERN }), { minItems: 2, maxItems: 20 }),
  title: t.Optional(t.String({ maxLength: 200 })),
});

export const ProjectParams = t.Object({ id: t.String({ pattern: OBJECT_ID_PATTERN }) });
export const ClipParams = t.Object({ id: t.String({ pattern: OBJECT_ID_PATTERN }) });
export const ShareCopyBody = t.Object({
  force: t.Optional(t.Boolean()),
});
export const ProjectOutroParams = t.Object({
  id: t.String({ pattern: OBJECT_ID_PATTERN }),
  outroId: t.String({ minLength: 4, maxLength: 24, pattern: "^[a-z0-9]+$" }),
});

export const CreateProjectOutroBody = t.Object({
  name: t.Optional(t.String({ maxLength: 40 })),
});

export const ProjectOutroBody = t.Object({
  name: t.Optional(t.String({ maxLength: 40 })),
  makeDefault: t.Optional(t.Boolean()),
  templateId: t.Optional(
    t.Union([t.Literal("lockup"), t.Literal("sting"), t.Literal("rise"), t.Literal("card")])
  ),
  durationSec: t.Optional(t.Number()),
  cta: t.Optional(t.String({ maxLength: 42 })),
  handle: t.Optional(t.String({ maxLength: 32 })),
  mark: t.Optional(
    t.Object({
      sizeScale: t.Optional(t.Number()),
      x: t.Optional(t.Number()),
      y: t.Optional(t.Number()),
      circle: t.Optional(t.Boolean()),
    })
  ),
  ctaStyle: t.Optional(
    t.Object({
      fontFamily: t.Optional(t.String({ maxLength: 60 })),
      sizeScale: t.Optional(t.Number()),
      textColor: t.Optional(t.String({ maxLength: 9 })),
      uppercase: t.Optional(t.Boolean()),
      spacing: t.Optional(t.Number()),
      animation: t.Optional(t.Union([t.Literal("none"), t.Literal("pop"), t.Literal("fade")])),
      x: t.Optional(t.Number()),
      y: t.Optional(t.Number()),
    })
  ),
  handleStyle: t.Optional(
    t.Object({
      fontFamily: t.Optional(t.String({ maxLength: 60 })),
      sizeScale: t.Optional(t.Number()),
      textColor: t.Optional(t.String({ maxLength: 9 })),
      uppercase: t.Optional(t.Boolean()),
      spacing: t.Optional(t.Number()),
      animation: t.Optional(t.Union([t.Literal("none"), t.Literal("pop"), t.Literal("fade")])),
      x: t.Optional(t.Number()),
      y: t.Optional(t.Number()),
    })
  ),
  sfxAssetId: t.Optional(t.String({ maxLength: 80 })),
  musicAssetId: t.Optional(t.String({ maxLength: 80 })),
  sfxGain: t.Optional(t.Number()),
  musicGain: t.Optional(t.Number()),
});

/** `?dryRun=0` is the only value that actually deletes; anything else reports. */
export const ReconcileQuery = t.Object({
  dryRun: t.Optional(t.String({ maxLength: 4 })),
});

/** GET /api/clips/:id/words — optional live trim, so extending the out-point fills captions. */
export const ClipWordsQuery = t.Object({
  startSec: t.Optional(t.String()),
  endSec: t.Optional(t.String()),
});

/** POST /api/clips/:id/captions/clean — fix fillers and ASR from the word grid. */
export const CleanCaptionsBody = t.Object({
  startSec: t.Optional(t.Number()),
  endSec: t.Optional(t.Number()),
  chunkWords: t.Optional(t.Number()),
  listen: t.Optional(t.Boolean()),
});

/** POST /api/clips/:id/reframe/preview — analyse the live trim for editor WYSIWYG. */
export const PreviewReframeBody = t.Object({
  startSec: t.Optional(t.Number()),
  endSec: t.Optional(t.Number()),
  mode: t.Optional(t.Union([t.Literal("center"), t.Literal("smart")])),
});
