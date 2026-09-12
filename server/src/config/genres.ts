// ============================================
// GENRE PROFILES — the per-genre editorial brain.
//
// Everything that differs between "a motivational podcast clip" and "a football
// highlight" lives here and nowhere else. The miner reads a profile; it never
// hardcodes a genre. Adding a genre = adding an entry to REGISTRY.
//
// A profile answers five questions:
//   1. What qualifies as a clip?      -> qualification / rejects / rewards
//   2. How is it judged?              -> scoringAxes (named, weighted)
//   3. How long should it be?         -> clipDuration
//   4. What IS the peak?              -> peakKind ("line" | "moment")
//   5. Which cutaways fit?            -> themes
//
// The scoring model is deliberately data-driven. An axis either contributes
// ADDITIVELY to a craft sum (craft = Σ weight × score) or, with `gate: true`,
// MULTIPLICATIVELY as a near-veto. That distinction is the load-bearing idea:
// craft axes trade off against each other, but a precondition (like
// "comprehensible with no context") does not — a clip that fails it is
// unusable regardless of how good the other axes are.
//
// Not every genre has every axis. Comedy has no time for a slow "standalone"
// penalty; music has no context problem at all and no gate. That asymmetry is
// exactly why this is a profile field rather than a constant.
// ============================================

export type PeakKind =
  /** The peak is a spoken line that can be burned on screen. */
  | "line"
  /** The peak is a moment — a play, a drop, a reaction. May have no words. */
  | "moment";

export interface ScoringAxis {
  /** Stable key; becomes the key in a candidate's `scores` map. */
  id: string;
  /** Short label for the review UI. */
  label: string;
  /** How to judge it — rendered verbatim into the prompt. */
  description: string;
  /** Additive weight in the craft sum. Ignored when `gate` is true. */
  weight: number;
  /** Applied multiplicatively as a near-veto rather than added. */
  gate?: boolean;
  /** Exponent for the gate curve; <1 is sub-linear (lenient at high scores). */
  gateExponent?: number;
}

export interface GenreProfile {
  id: string;
  label: string;
  /** One line, shown in the UI. */
  summary: string;
  /** What qualifies as a clip. Rendered as the "WHAT QUALIFIES" block. */
  qualification: string[];
  /** Failure modes. Rendered as the "REJECT" block. */
  rejects: string[];
  /** Winning shapes to prefer. Rendered as the "REWARD" block. */
  rewards: string[];
  /** How to open the clip. */
  coldOpenGuidance: string;
  scoringAxes: ScoringAxis[];
  clipDuration: { min: number; target: number; max: number };
  peakKind: PeakKind;
  /** What the peak is and how to find it. Rendered into the prompt. */
  peakGuidance: string[];
  /** Candidate cutaway themes for this genre. */
  themes: string[];
  /** How to pick themes. Rendered into the prompt. */
  themeGuidance: string;
  /** Whether burned word-timed captions make sense by default. */
  captionsDefault: boolean;
}

// ---------------------------------------------------------------------------
// 1. Motivation / advice
//
// The original behaviour, preserved exactly — the prompt, the axis set, the
// weights and the gate were validated against real episodes and are load-bearing.
// ---------------------------------------------------------------------------

const MOTIVATION: GenreProfile = {
  id: "motivation",
  label: "Motivation / advice",
  summary: "Talking-head advice, self-improvement, mindset. A clip needs a turn.",
  qualification: [
    "A span qualifies ONLY if it contains a TURN. A turn is one of:",
    '  - a REFRAME: the listener\'s existing model of something is replaced ("you don\'t have a motivation problem, you have a clarity problem")',
    "  - a HARD TRUTH: something true, unflattering and specific, stated without hedging",
    "  - an EARNED IMPERATIVE: a command that the preceding two sentences actually justify",
    "",
    "If you cannot name the turn in one clause, there is no turn. Do not submit the span.",
  ],
  rejects: [
    'DANGLING CONTEXT. This is the most common and most fatal failure. If the span opens with "that", "this", "he", "she", "they", "it", "so that\'s why", "which is why" — and the referent is NOT inside the span — it is unusable. The viewer has zero preamble; they land mid-air. Either move the start earlier so the referent is included, or discard the span.',
    "Spans that only make sense as an answer to a question that isn't in the span.",
    "Mid-sentence starts or mid-sentence ends.",
    "Rambling advice that never resolves; setup with no punchline; pure anecdote with no extracted lesson.",
    'Generic platitudes ("work hard", "believe in yourself", "consistency is key") with no specificity, no number, no concrete image.',
    "Anything requiring knowledge of who the host is, what the previous topic was, or an earlier example.",
    'MID-ANECDOTE spans. If the span drops the viewer into the middle of a story, a role-play, or a hypothetical whose scenario was established BEFORE startId, it fails — even when the words themselves are punchy. "And so you\'re going to say to them...", "and then he told me...", quoted dialogue with no established speaker. Unless the span itself establishes who is talking to whom and why, discard it.',
  ],
  rewards: [
    "A COLD OPEN: sentence #startId works as the literal first 3 seconds of the video with zero preamble. Read it alone, out loud, and ask if a stranger would keep watching.",
    'CONTRAST STRUCTURE — "most people X, but actually Y" / "everyone thinks X, the truth is Y". This is the highest-performing shape in this genre. Prefer it.',
    "A payoff line that is quotable VERBATIM — the kind of line people screenshot and repost as text.",
    "Specificity: a number, a named mechanism, a concrete image.",
  ],
  coldOpenGuidance:
    "The first sentence must work as the literal first 3 seconds with zero preamble.",
  scoringAxes: [
    {
      id: "hook",
      label: "Hook",
      weight: 0.35,
      description:
        "does sentence #startId stop a scroll in 3 seconds? 3 = it's a throat-clear, 10 = it's a pattern interrupt.",
    },
    {
      id: "payoff",
      label: "Payoff",
      weight: 0.35,
      description:
        "does the peak line actually land as a turn? 3 = it's just more advice, 10 = it reframes something.",
    },
    {
      id: "quotability",
      label: "Quotable",
      weight: 0.3,
      description:
        "would someone screenshot this line or repeat it to a friend? 3 = forgettable phrasing, 10 = aphorism. HARD CAP: if the peak line contains a stutter, a repeated word, or a false start, quotability cannot exceed 3 — nobody screenshots broken text — and payoff cannot exceed 5.",
    },
    {
      id: "standalone",
      label: "Standalone",
      weight: 0,
      gate: true,
      gateExponent: 0.75,
      description:
        "comprehensible with ZERO surrounding context? Before scoring this, read ONLY the span's first sentence and ask whether a stranger knows who is speaking, to whom, and about what. Score 2 or below for any unresolved pronoun, missing question, or unestablished scenario. This score is a near-veto downstream and it is the axis you are most likely to inflate, so be strict: most spans you like should land 5-8 here, and a 10 should be rare.",
    },
  ],
  clipDuration: { min: 20, target: 32, max: 45 },
  peakKind: "line",
  peakGuidance: [
    "The payoff line is the one line that gets burned on screen at the emotional peak. Getting it wrong ruins the clip even when the span is good. So:",
    "  - peakId: the number of the single sentence that IS the emotional peak. It needs runway: peakId must be at least 2 sentence units after startId, and is usually in the last third of the span. If the sentence you want as the peak is also the first sentence of your span, you have picked the wrong start — move startId earlier so the setup is included. Equally, do not just default to the last line; pick the real peak.",
    "  - peakLine: copy that sentence VERBATIM from the transcript above, character for character, including its bad punctuation and casing. Do not clean it up, do not paraphrase, do not merge two sentences. If the sentence unit is long and only part of it is the peak, copy the exact contiguous words of the peak, still verbatim.",
    "  - THE PEAK LINE MUST BE FLUENT SPEECH. Because you must copy it verbatim and it gets BURNED ON SCREEN, a peak line carrying stutters, repeated words, false starts or filler is unusable — it reads as broken text to the viewer. Reject as peak any sentence like \"they'll they'll skyrocket here and then they and then they plateau\" or \"I I think that that matters\". If the real emotional peak is disfluent, either pick the exact contiguous FLUENT fragment inside it that carries the meaning, or choose a different sentence. A clean 8/10 line beats a stuttering 10/10 one, every time.",
  ],
  themes: ["gym", "running", "boxing", "ocean", "city_night", "sunrise", "nature", "work_desk"],
  themeGuidance:
    "Match the clip's content and energy (discipline/effort -> gym, boxing, running; solitude/perspective -> ocean, nature, sunrise; hustle/ambition -> city_night, work_desk).",
  captionsDefault: true,
};

// ---------------------------------------------------------------------------
// 2. Comedy / talk
//
// The unit is a BIT with a punchline, not a lesson. Worse than a bad clip is a
// clip that explains the joke's context, so setup-inclusion matters; but the
// payoff test is "did it get a laugh / did the story land", not "did it reframe
// the listener's model".
// ---------------------------------------------------------------------------

const COMEDY_TALK: GenreProfile = {
  id: "comedy_talk",
  label: "Comedy / talk",
  summary: "Stand-up, comedy podcasts, talk shows. A clip needs a punchline or a story that lands.",
  qualification: [
    "A span qualifies ONLY if it PAYS OFF. One of:",
    "  - a PUNCHLINE: a setup inside the span that detonates on a laugh line",
    "  - a STORY BEAT: an anecdote that is fully established AND resolved inside the span",
    "  - a HOT TAKE: a confidently stated, funny or provocative opinion that stands on its own",
    "",
    "If you cannot point at the exact sentence that lands the bit, there is no bit. Do not submit it.",
  ],
  rejects: [
    'DANGLING SETUP. The single most common failure. If the span opens mid-story ("and then he said", "so I told her", "that is why") and the who/where/what was established BEFORE startId, the viewer is dropped into a conversation they never heard. Move startId back to include the setup, or discard the span.',
    "Spans where the laugh depends on something the audience can only know from the rest of the episode.",
    "Material that needs the visual, an impression, or a physical bit to be funny — you are selecting from a transcript, so if the words alone aren't funny, it will not land.",
    "Rambling asides, crowd work that only makes sense live, and premises that never reach a punchline.",
    "Mid-sentence starts or mid-sentence ends.",
    "Anything that requires knowing who the host is or what the previous topic was.",
  ],
  rewards: [
    "A COLD OPEN: the first sentence works as the literal first 3 seconds — a strange claim, a mid-action line, or a direct address that makes a stranger stop.",
    "TIGHT SETUP → ESCALATION → PUNCHLINE. The classic three-beat. Prefer spans where the escalation is visible in the text.",
    "A punchline that is quotable VERBATIM — the kind of line people caption a screenshot with.",
    "Specificity: a real name, a number, a place, an absurd concrete detail. Vagueness kills comedy.",
  ],
  coldOpenGuidance:
    "The first sentence must be funny-adjacent or intriguing enough to survive 3 seconds with zero preamble.",
  scoringAxes: [
    {
      id: "hook",
      label: "Hook",
      weight: 0.25,
      description:
        "does sentence #startId make a stranger stop scrolling? 3 = a neutral throat-clear, 10 = a genuinely strange or bold opening line.",
    },
    {
      id: "punchline",
      label: "Punchline",
      weight: 0.35,
      description:
        "how hard does the bit land? 3 = mild, 10 = a real laugh. Judge the WRITTEN joke: would it be funny read aloud with no performance? If the humour is purely in the delivery, the visual, or an impression, score 3 or below — a transcript clip cannot carry it.",
    },
    {
      id: "humour",
      label: "Funny",
      weight: 0.25,
      description:
        "how funny is the span as a whole, start to finish? 3 = wry, 10 = consistently funny. Do not reward a good punchline attached to a slow minute.",
    },
    {
      id: "quotability",
      label: "Quotable",
      weight: 0.15,
      description:
        "would someone screenshot this line or repeat it to a friend? 3 = forgettable, 10 = instantly repeatable.",
    },
    {
      id: "standalone",
      label: "Standalone",
      weight: 0,
      gate: true,
      gateExponent: 0.6,
      description:
        "does the bit work with ZERO surrounding context? Score 2 or below if any pronoun, story, or premise is unresolved inside the span. A joke you have to explain is not a joke — this is a near-veto. Be strict: most spans you like should land 5-8 here.",
    },
  ],
  clipDuration: { min: 15, target: 28, max: 55 },
  peakKind: "line",
  peakGuidance: [
    "The punchline is what gets burned on screen at the peak — usually the last line of the bit. So:",
    "  - peakId: the number of the sentence that IS the laugh line. It needs runway: peakId must be at least 2 sentence units after startId, and is almost always in the last third of the span. If the funniest sentence is your first sentence, you have picked the wrong start — move startId earlier so the setup is included.",
    "  - peakLine: copy that sentence VERBATIM from the transcript, character for character, including its bad punctuation. Do not clean it up or paraphrase. If only part of a long sentence is the laugh, copy the exact contiguous words, still verbatim.",
    "  - THE PUNCHLINE MUST BE FLUENT SPEECH, because it is burned on screen. If the real laugh is disfluent, pick the exact contiguous FLUENT fragment that carries it, or choose a different sentence.",
  ],
  themes: ["stage", "crowd", "city_night", "bar", "party", "street", "casual", "office"],
  themeGuidance:
    "Match the bit's setting and energy (performance -> stage, crowd; storytelling -> bar, city_night; everyday life -> office, casual).",
  captionsDefault: true,
};

// ---------------------------------------------------------------------------
// 3. Sports / gaming
//
// The peak is a PLAY, not a sentence. Text mining still helps enormously here —
// commentary, casting, and player comms carry the stakes — but the model must be
// allowed to return a peak with no clean line, and captions are usually off.
// ---------------------------------------------------------------------------

const SPORTS_GAMING: GenreProfile = {
  id: "sports_gaming",
  label: "Sports / gaming",
  summary: "Highlights, plays, clutch moments. The peak is a moment, not a line.",
  qualification: [
    "A span qualifies ONLY if it contains a PLAY. One of:",
    "  - a CLUTCH MOMENT: something is at stake and it is decided inside the span",
    "  - an ESCALATION: tension builds and pays off — a comeback, a streak, a turning point",
    "  - a REACTION: a genuine, extreme response to something that just happened",
    "",
    "If you cannot say what was won or lost inside the span, there is no play. Do not submit it.",
  ],
  rejects: [
    'DANGLING ACTION. If the span opens mid-play ("and he goes again", "watch this", "so that\'s why") and what is at stake was established before startId, the viewer has no idea what they are watching or why it matters. Move startId back to include the stakes, or discard.',
    "Spans with no stakes: warm-up, filler talk, ad reads, scheduling chatter, and long tactical explanations.",
    "Post-game analysis and punditry with no live action in the span.",
    "Mid-sentence starts or mid-sentence ends.",
    "Anything that needs the on-screen scoreboard, the bracket, or knowledge of an earlier game to make sense.",
  ],
  rewards: [
    "A COLD OPEN: the first sentence puts the viewer in the moment — commentary that is already elevated, or a direct line about what is about to be decided.",
    "A DECIDING BEAT: commentary tightening as the play resolves (tension -> release).",
    "A reaction line quotable VERBATIM — punchy commentary, a player's call-out, a caster losing it.",
    'Specificity: a score, a clock, a name, a distance, a rank. "He needs one more" beats "he needs to do well".',
  ],
  coldOpenGuidance:
    "The first sentence must land the viewer already inside the stakes, with no preamble.",
  scoringAxes: [
    {
      id: "hook",
      label: "Hook",
      weight: 0.25,
      description:
        "does sentence #startId create instant tension or curiosity? 3 = flat commentary, 10 = you cannot look away.",
    },
    {
      id: "spectacle",
      label: "Spectacle",
      weight: 0.4,
      description:
        "how big is the moment? 3 = routine, 10 = genuinely extraordinary. Judge what happens, not how loud it is narrated.",
    },
    {
      id: "stakes",
      label: "Stakes",
      weight: 0.35,
      description:
        "is something clearly being won or lost INSIDE the span? 3 = nothing on the line, 10 = the whole thing is decided here. Score 2 or below if the viewer cannot tell why this matters without outside knowledge.",
    },
  ],
  clipDuration: { min: 8, target: 20, max: 35 },
  peakKind: "moment",
  peakGuidance: [
    "The peak is the MOMENT the play resolves — the goal, the dunk, the ace, the final kill. A spoken line is optional here. So:",
    "  - peakId: the sentence whose start time is closest to the resolving moment. It must be at least 2 sentence units after startId, and is usually in the last third of the span.",
    "  - peakLine: copy the commentary line spoken at that moment VERBATIM, if there is a clear one. If the moment lands on grunts, crowd noise, or silence rather than a sentence, return the empty string and rely on peakId for the timing. Do NOT invent a line, and do NOT move peakId to a sentence that merely describes the play.",
    "  - The span must still contain the setup of the PLAY, not just its conclusion.",
  ],
  themes: ["stadium", "court", "track", "gym", "crowd", "scoreboard", "arena", "screens"],
  themeGuidance:
    "Match the setting and energy (live action -> stadium, court, track, arena; reaction -> crowd, screens).",
  captionsDefault: false,
};

// ---------------------------------------------------------------------------
// 4. Music / performance
//
// No context problem at all — nobody needs a setup to enjoy a chorus. Hence no
// standalone gate, which is the clearest proof the profile system is doing real
// work rather than renaming constants.
// ---------------------------------------------------------------------------

const MUSIC: GenreProfile = {
  id: "music",
  label: "Music / performance",
  summary: "Live sets, sessions, performances. The peak is the drop or the performance moment.",
  qualification: [
    "A span qualifies ONLY if it contains a PERFORMANCE PEAK. One of:",
    "  - THE DROP / CHORUS: the track's hook, build resolving into its payoff",
    "  - a VIRTUOSO MOMENT: a solo, a run, a break, an improvised turn",
    "  - a REACTION or BANTER BEAT around a performance, if genuinely quotable",
    "",
    "If you cannot say what the musical peak is, there is no clip. Do not submit it.",
  ],
  rejects: [
    "Spans entirely made of stage patter, tuning, count-ins, dead air, or explanation with no performance in them.",
    "Intros that never reach the hook, and outros after the performance has ended.",
    "Any span where the interesting part is purely sonic — if you are selecting from a transcript and nothing is happening in the words, say so rather than inventing a moment.",
    "Mid-sentence starts or mid-sentence ends.",
  ],
  rewards: [
    "A COLD OPEN: the span starts close to the peak so a viewer is inside the music within 3 seconds.",
    "A BUILD → RELEASE shape: the transcript carries the ramp (count-in, call-out, lyric leading in) before the peak.",
    "A performance line quotable VERBATIM — a lyric, an ad-lib, a dedication, a stage line.",
    "Specificity: a song title, a dedication, a city, a band name.",
  ],
  coldOpenGuidance:
    "Waveforms write no words. Do not force a narrative onto a span that is mostly instrumental — if a lyric rather than a hook line is the right peak, use it; if nothing, lower the score honestly.",
  scoringAxes: [
    {
      id: "hook",
      label: "Hook",
      weight: 0.3,
      description:
        "does sentence #startId start you inside the performance rather than in preamble? 3 = stage patter, 10 = the hook is already underway.",
    },
    {
      id: "peak",
      label: "Peak",
      weight: 0.45,
      description:
        "how strong is the performance peak inside this span? 3 = a competent run-through, 10 = the moment the whole set exists for. If the span contains no discernible peak, score 2 or below.",
    },
    {
      id: "energy",
      label: "Energy",
      weight: 0.25,
      description:
        "how high is the energy across the span, judged from the transcript's language, lyrics, and crowd cues? 3 = subdued or spoken, 10 = the room is losing it.",
    },
  ],
  clipDuration: { min: 12, target: 25, max: 60 },
  peakKind: "moment",
  peakGuidance: [
    "The peak is the DROP or the performance moment — the hook landing, a solo breaking, the crowd reacting. A spoken line is usually not the peak. So:",
    "  - peakId: the sentence whose start time is closest to the musical peak. It must be at least 2 sentence units after startId, and is usually in the last third of the span.",
    "  - peakLine: copy the lyric or stage line spoken at that moment VERBATIM if there is a clear one. If the peak is purely instrumental or the line is unintelligible, return the empty string and rely on peakId for timing. Do NOT invent a lyric and do NOT paraphrase.",
    "  - Prefer the span that CONTAINS the peak over one that merely leads to it. A clip that never reaches the drop is worthless.",
  ],
  themes: ["stage", "neon", "crowd", "smoke", "studio", "city_night", "lights", "film_grain"],
  themeGuidance:
    "Match the setting and energy (live show -> stage, crowd, smoke, lights; studio -> studio, neon; cinematic -> film_grain, city_night).",
  captionsDefault: false,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: Record<string, GenreProfile> = {
  [MOTIVATION.id]: MOTIVATION,
  [COMEDY_TALK.id]: COMEDY_TALK,
  [SPORTS_GAMING.id]: SPORTS_GAMING,
  [MUSIC.id]: MUSIC,
};

/** Used when detection is unavailable or the caller does not care. */
export const DEFAULT_GENRE_ID = MOTIVATION.id;

export class UnknownGenreError extends Error {
  constructor(id: string) {
    super(`Unknown genre "${id}". Known genres: ${Object.keys(REGISTRY).join(", ")}`);
    this.name = "UnknownGenreError";
  }
}

export function listGenreProfiles(): GenreProfile[] {
  return Object.values(REGISTRY);
}

/** Resolve a profile by id. Throws on an unknown id so typos surface loudly. */
export function resolveGenreProfile(id: string | undefined | null): GenreProfile {
  if (!id) return REGISTRY[DEFAULT_GENRE_ID];
  const profile = REGISTRY[id];
  if (!profile) throw new UnknownGenreError(id);
  return profile;
}

export function isKnownGenre(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Rank a candidate. Axes with `gate: true` are a near-veto (sub-linear penalty);
 * the rest are an additive craft sum. Both scale to 0-10.
 *
 * `fluency` only applies when the peak is a spoken line — a moment has no text
 * to stutter.
 */
export function scoreForProfile(
  profile: GenreProfile,
  scores: Record<string, number>,
  peakLine?: string
): number {
  const clamp = (n: number) => Math.max(0, Math.min(10, Number.isFinite(n) ? n : 0));

  let craft = 0;
  let weightSum = 0;
  let gate = 1;

  for (const axis of profile.scoringAxes) {
    const value = clamp(scores[axis.id]);
    if (axis.gate) {
      gate *= Math.pow(value / 10, axis.gateExponent ?? 0.75);
    } else {
      craft += axis.weight * value;
      weightSum += axis.weight;
    }
  }

  // Normalise so the sum stays on a 0-10 scale regardless of how a profile
  // splits its weights (they need not add to exactly 1).
  if (weightSum > 0) craft = craft / weightSum;

  const fluency =
    profile.peakKind === "line" && peakLine ? payoffFluencyFactor(peakLine) : 1;

  return Math.round(craft * gate * fluency * 100) / 100;
}

/**
 * Detect stutters and false starts in a peak line, returning a 0-1 multiplier.
 *
 * The peak line is copied VERBATIM from auto-captions and then BURNED ON SCREEN
 * at the loudest moment, so a genuinely great moment can carry a payoff like
 * "they'll they'll skyrocket here and then they and then they plateau" — which
 * reads as broken text to the viewer. The prompt forbids it, but a prompt rule
 * is a request, not a guarantee, so the check is also mechanical.
 *
 * Deliberately conservative: it looks for an immediately repeated word, the
 * dominant real failure. Legitimate English doubles ("had had") are rare enough
 * at a peak that the false-positive cost is far cheaper than the false-negative.
 */
export function payoffFluencyFactor(payoffLine: string): number {
  const words = payoffLine
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2) return 1;

  let repeats = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) repeats++;
  }
  if (repeats === 0) return 1;
  // One stumble is a blemish; two or more is unusable on screen.
  return repeats === 1 ? 0.55 : 0.25;
}
