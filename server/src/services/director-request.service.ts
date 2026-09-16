import { directorModel } from "../config/models";
import type { DirectorAsk, DirectorAssetMode, DirectorTurn } from "../types/clip.types";
import { getErrorMessage } from "../types";
import { chat } from "./openrouter.service";

// ============================================
// THE REQUEST COMES FIRST — the creator's note outranks the panel.
//
// The panel's chips (where B-roll comes from, whether music is laid, lane
// locks, Auto or Plan first) are defaults for a pass with no note. A note
// that asks for stock footage, music, a locked lane or a fixed caption length
// is obeyed whatever the chips say, and the note also decides how the pass
// runs: "go ahead", answers to a waiting proposal or a precise request cut
// straight away even in Plan first; asking for a plan or options proposes
// even in Auto. In Auto the Director may still stop and ask on its own when a
// note leaves the direction open — never after a go-ahead, never while a
// proposal is being answered.
//
// A short model call reads the note into a list of asks; each override must
// quote the words of the note that make it (a go-ahead may be judged without
// one), and an ask whose quote is not in the note is dropped — the reader
// cannot unlock a lane the creator never mentioned. It knows the editor
// (director-knowledge), so a question in the note gets a straight answer, and
// a note that is only a question is answered without touching the clip.
// Everything it changed is said back ("Followed your note: …").
// ============================================

export type RequestLane = "cuts" | "camera" | "captions" | "titles" | "sfx" | "speed" | "fx" | "cutaways" | "music";

const LANE_WORDS: Record<RequestLane, string> = {
  cuts: "Cuts",
  camera: "Camera",
  speed: "Speed",
  fx: "FX",
  cutaways: "B-roll",
  captions: "Captions",
  titles: "Titles",
  sfx: "SFX",
  music: "Music",
};

const REQUEST_LANES = Object.keys(LANE_WORDS) as RequestLane[];

const ASSET_WORDS: Record<DirectorAssetMode, string> = { library: "Library", stock: "Stock", ai: "AI", both: "Both" };

export interface PanelOptions {
  assets: DirectorAssetMode;
  music: boolean;
  see: boolean;
  keep: RequestLane[];
  /** Plan first is selected (or Rethink was pressed). */
  plan: boolean;
}

/** A proposal the Director made that is waiting for the creator's answer. */
export interface WaitingProposal {
  proposal: string;
  asks: DirectorAsk[];
}

/** What a note asks for, each override backed by the words that make it. */
export interface RequestIntent {
  lanes: RequestLane[];
  assets?: DirectorAssetMode;
  music?: boolean;
  see?: boolean;
  /** A fixed number of caption words on screen at a time, for the whole clip. */
  wordsPerLine?: number;
  /** False when the note asks for no change to the clip at all (only a question). */
  edits: boolean;
  /** A straight answer to whatever the note asks, when it asks something. */
  reply?: string;
  /** Cut now or propose first, when the note says which. */
  mode?: "execute" | "plan";
  /** A few words the creator reads: why the mode switched. */
  modeWhy?: string;
  /** Take back the Director's last pass first. */
  undo?: boolean;
  /** Music made to order for this clip, whatever the B-roll source. */
  composeMusic?: boolean;
}

export interface ResolvedPass extends PanelOptions {
  wordsPerLine?: number;
  /** False when the note asks for no change beyond an answer or taking a pass back. */
  edits: boolean;
  reply?: string;
  /** Take back the Director's last pass before anything else. */
  undo?: boolean;
  /** Generate a bed for this clip rather than only picking from the catalogue. */
  composeMusic?: boolean;
  /** The lanes the note reads as touching. */
  lanes: RequestLane[];
  /** In Auto, the Director may stop and ask when the note leaves the direction open. */
  mayAsk: boolean;
  /** Plain sentences: every panel setting the note overrode. */
  followed: string[];
}

/** What the Director has done on this clip so far, for reading a note in context. */
export interface ConversationContext {
  /** Earlier turns, oldest first. */
  turns: DirectorTurn[];
  /** The edit as it stands (describeCurrentPlan). */
  plan: string;
  /** A pass of the Director's can be taken back. */
  undoable: boolean;
}

function conversationBlock(context: ConversationContext | undefined): string {
  if (!context) return "";
  const turns = context.turns.slice(-8).map((turn, index) => {
    const did =
      turn.kind === "plan" ? "proposed" : turn.kind === "reply" ? "answered" : turn.kind === "undo" ? "took back a pass" : `cut${turn.changed?.length ? ` (changed ${turn.changed.join(", ")})` : ""}${turn.undone ? " — later taken back" : ""}`;
    return `${index + 1}. creator: ${turn.notes ? `"${turn.notes}"` : "(no note)"} → Director ${did}: ${turn.summary.slice(0, 400)}`;
  });
  return `${turns.length ? `\nTHE CONVERSATION SO FAR ON THIS CLIP (oldest first):\n${turns.join("\n")}\n` : ""}${
    context.plan ? `\nTHE EDIT AS IT STANDS (clip-relative seconds):\n${context.plan.slice(0, 5000)}\n` : "\nTHE EDIT AS IT STANDS: nothing directed yet.\n"
  }${context.undoable ? "" : "(There is no Director pass that can be taken back.)\n"}`;
}

export function requestReaderPrompt(notes: string, panel: PanelOptions, knowledge: string, waiting?: WaitingProposal, context?: ConversationContext): string {
  const proposal = waiting
    ? `\nA PROPOSAL IS WAITING FOR THE CREATOR'S ANSWER — the Director laid out:\n${waiting.proposal}\n${waiting.asks
        .map((ask, index) => `Q${index + 1}. ${ask.question}${ask.options.length ? ` [${ask.options.map((option) => option.label).join(" / ")}]` : ""}`)
        .join("\n")}\n`
    : "";
  return `A video creator typed a note to the AI Director of their short-form video editor, in an ongoing conversation about the clip. The panel also has settings; the note OUTRANKS them. Read the note in the light of the conversation so far, list what it asks for so the panel can be overridden where the note asks, decide whether it wants the cut made now or a plan first, and answer anything it asks.

${knowledge}
${conversationBlock(context)}
PANEL NOW: B-roll source ${panel.assets}; lay music ${panel.music ? "on" : "off"}; watch the clip ${panel.see ? "on" : "off"}; locked lanes ${panel.keep.length ? panel.keep.join(", ") : "none"}; mode ${panel.plan ? "Plan first (propose and ask before cutting)" : "Auto (cut)"}.
${proposal}
NOTE:
"""${notes}"""

Return ONLY JSON. Every override carries "quote": the exact words from the note that make it (copied verbatim, 2–8 words). Leave an override out (null or absent) when the note does not make it — do not infer from taste, only from what is written.
{
  "edits": true,
  "reply": "",
  "mode": { "value": "execute|plan", "quote": "...", "why": "..." },
  "lanes": [{ "lane": "captions", "quote": "..." }],
  "assets": { "value": "stock|ai|both|library", "quote": "..." },
  "music": { "value": true, "quote": "..." },
  "composeMusic": { "value": true, "quote": "..." },
  "see": { "value": true, "quote": "..." },
  "wordsPerLine": { "value": 2, "quote": "..." },
  "undo": { "value": true, "quote": "..." }
}
- "edits": false ONLY when the note asks for no change to the clip at all: it is just a question (e.g. "which model makes the music?"), or it only asks to take the last pass back. Any request to change, add, remove or improve anything is true — and so are "go ahead", "yes" and answers to the waiting proposal.
- "reply": when the note asks a question (about the editor, its tools, its models, what it can do, what it would do — or about the edit itself and what the Director did, answered from THE EDIT AS IT STANDS and THE CONVERSATION with the real times, assets and settings), answer it directly and correctly in 1–4 sentences; say plainly when something is not configured or not possible. Name sounds, beds and pictures by their quoted name, never by id, and give numbers as the edit gives them without inventing units (a bed's level and dip are 0–1). Empty when the note asks nothing.
- "undo": true when the note asks to take back the Director's last pass as a whole — undo that, revert it, go back, put it back how it was, I liked it better before (quote required). Not for removing one thing ("drop the title" is a change to titles). If it also asks for something else ("undo that and try a darker bed"), set "edits" true as well.
- "mode": how this pass runs. "execute" when the creator wants it done now — go ahead, do it, yes, sounds good, ship it, apply it, cut it, just fix it — or the note answers the waiting proposal, or it is a precise change that leaves nothing to decide (a quote is optional here). "plan" when they ask to see a plan, options or ideas before anything changes — plan it first, what would you do, show me options, don't cut yet, rethink it (quote required). Leave it out when the note gives no sign. "why" is 3–8 words the creator reads, e.g. "you said go ahead".
- "lanes": every lane the note asks to add, change or remove something in (a lane mentioned only to leave it alone is NOT listed). Lane ids: cuts, camera, speed, fx, cutaways, captions, titles, sfx, music. Read "that", "it", "again", "more of that" against the conversation: "make that shorter" right after a turn that laid B-roll is cutaways — quote the words the note uses ("make that shorter").
- "assets": "stock" when it asks for stock footage / real videos; "ai" when it asks for generated or AI pictures; "both" when it asks for both; "library" only when it says to use only its own uploads.
- "music": true when it asks for music; false only when it says no music.
- "composeMusic": true when it asks for music made to order — generate / compose / create / make an original or custom bed, AI music, "make me a track" (quote required). Not for picking or changing a bed ("a darker bed" is only "music").
- "see": true when it asks the Director to watch or look at the video.
- "wordsPerLine": when it asks for a set number of caption words at a time (1–8).`;
}

function squashText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** A quote counts when the note really contains it. */
function quoted(raw: unknown, notes: string): boolean {
  if (typeof raw !== "string") return false;
  const quote = squashText(raw);
  return quote.length >= 3 && squashText(notes).includes(quote);
}

function ask(raw: unknown, notes: string): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  return quoted(item.quote, notes) ? item : undefined;
}

/** The reader's answer, keeping only overrides whose quote is in the note. */
export function parseRequestIntent(text: string, notes: string): RequestIntent | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const reply = typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim().slice(0, 1000) : undefined;
  const undo = ask(raw.undo, notes)?.value === true;
  // Only a note with an answer to give or a pass to take back may skip the edit; anything unclear edits.
  const intent: RequestIntent = { lanes: [], edits: !(raw.edits === false && (reply || undo)), ...(reply ? { reply } : {}), ...(undo ? { undo } : {}) };
  for (const item of Array.isArray(raw.lanes) ? raw.lanes : []) {
    const lane = ask(item, notes)?.lane;
    if (typeof lane === "string" && (REQUEST_LANES as string[]).includes(lane) && !intent.lanes.includes(lane as RequestLane)) {
      intent.lanes.push(lane as RequestLane);
    }
  }
  const assets = ask(raw.assets, notes);
  if (assets && typeof assets.value === "string" && assets.value in ASSET_WORDS) intent.assets = assets.value as DirectorAssetMode;
  const music = ask(raw.music, notes);
  if (music && typeof music.value === "boolean") intent.music = music.value;
  if (ask(raw.composeMusic, notes)?.value === true) intent.composeMusic = true;
  if (ask(raw.see, notes)?.value === true) intent.see = true;
  const words = ask(raw.wordsPerLine, notes);
  const count = Number(words?.value);
  if (words && Number.isFinite(count) && count >= 1) intent.wordsPerLine = Math.min(8, Math.round(count));
  // Going ahead can be judged from the note as a whole; holding the cut back needs the creator's words.
  const mode = typeof raw.mode === "object" && raw.mode !== null ? (raw.mode as Record<string, unknown>) : undefined;
  if (mode?.value === "execute" || (mode?.value === "plan" && quoted(mode.quote, notes))) {
    intent.mode = mode.value as "execute" | "plan";
    if (typeof mode.why === "string" && mode.why.trim()) intent.modeWhy = mode.why.trim().slice(0, 120);
  }
  return intent;
}

/**
 * The pass the note asks for: the panel, overridden wherever the note speaks.
 * `answering` is true while a proposal waits for the creator's answer.
 */
export function resolvePass(panel: PanelOptions, intent: RequestIntent | null, stockAvailable: boolean, answering = false): ResolvedPass {
  const out: ResolvedPass = { ...panel, keep: [...panel.keep], edits: true, lanes: [], mayAsk: false, followed: [] };
  if (!intent) return out;
  out.edits = intent.edits;
  if (intent.reply) out.reply = intent.reply;
  if (intent.undo) out.undo = true;
  if (!intent.edits) return out;

  const lanes = new Set(intent.lanes);
  if (intent.assets && intent.assets !== "library") lanes.add("cutaways");
  if (intent.music || intent.composeMusic) lanes.add("music");
  if (intent.wordsPerLine) lanes.add("captions");
  out.lanes = REQUEST_LANES.filter((lane) => lanes.has(lane));

  const unlocked = out.keep.filter((lane) => lanes.has(lane));
  if (unlocked.length) {
    out.keep = out.keep.filter((lane) => !lanes.has(lane));
    out.followed.push(`Unlocked ${unlocked.map((lane) => LANE_WORDS[lane]).join(", ")} — your note asks for ${unlocked.length === 1 ? "it" : "them"}.`);
  }

  if (intent.assets && intent.assets !== panel.assets) {
    // "Both" already covers a note asking for stock or for generated pictures.
    const covered = panel.assets === "both" && (intent.assets === "stock" || intent.assets === "ai");
    if (intent.assets === "stock" && !stockAvailable) {
      out.followed.push("Your note asks for stock footage, but no stock provider is configured (PEXELS_API_KEY / PIXABAY_API_KEY).");
    } else if (!covered) {
      out.assets = intent.assets;
      out.followed.push(`B-roll from ${ASSET_WORDS[intent.assets]} (the panel said ${ASSET_WORDS[panel.assets]}) — your note asks for it.`);
    }
  }

  if (intent.music !== undefined && intent.music !== panel.music) {
    out.music = intent.music;
    out.followed.push(intent.music ? "Laid music although Lay music was off — your note asks for it." : "No music this pass — your note says so.");
  }
  if (intent.composeMusic && intent.music !== false) {
    out.composeMusic = true;
    if (!out.music) {
      out.music = true;
      out.followed.push("Laid music although Lay music was off — your note asks for it.");
    }
    // AI and Both already let a pass make a bed.
    if (out.assets !== "ai" && out.assets !== "both") out.followed.push("Composed a music bed to order although B-roll is not AI or Both — your note asks for one.");
  }
  if (intent.see && !panel.see) {
    out.see = true;
    out.followed.push("Watched the clip although Watch the clip was off — your note asks for it.");
  }
  if (intent.wordsPerLine) {
    out.wordsPerLine = intent.wordsPerLine;
    out.followed.push(`Captions hold ${intent.wordsPerLine} word${intent.wordsPerLine === 1 ? "" : "s"} at a time across the whole clip, every scene included.`);
  }

  const why = intent.modeWhy ? ` — ${intent.modeWhy}` : "";
  if (intent.mode === "execute" && panel.plan) {
    out.plan = false;
    out.followed.push(`Cut straight away instead of proposing${why || " — your note is ready to go"}.`);
  } else if (intent.mode === "plan" && !panel.plan) {
    out.plan = true;
    out.followed.push(`Proposed first instead of cutting${why || " — your note asks to see the plan"}.`);
  }
  // Stopping to ask is for an open direction: not after a go-ahead, and not while a proposal is being answered.
  out.mayAsk = !out.plan && !answering && intent.mode !== "execute";
  return out;
}

/**
 * Read the note into asks. A failed read leaves the panel as it is and says
 * so, rather than failing the pass.
 */
export async function readRequest(
  notes: string | undefined,
  panel: PanelOptions,
  stockAvailable: boolean,
  knowledge: string,
  waiting?: WaitingProposal,
  context?: ConversationContext
): Promise<{ pass: ResolvedPass; warning?: string }> {
  const text = notes?.trim();
  const answering = Boolean(waiting);
  if (!text) return { pass: resolvePass(panel, null, stockAvailable, answering) };
  // A read takes 2–5 s; a stalled provider gets one quick retry, so a slow
  // moment does not quietly drop the note's overrides.
  let failure: unknown = new Error("no readable answer");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chat({
        model: directorModel(),
        parts: [{ type: "text", text: requestReaderPrompt(text, panel, knowledge, waiting, context) }],
        temperature: 0,
        maxTokens: 3000,
        reasoning: "low",
        json: true,
        timeoutMs: 20_000,
        label: "director request",
      });
      const intent = parseRequestIntent(result.text ?? "", text);
      if (intent) return { pass: resolvePass(panel, intent, stockAvailable, answering) };
      failure = new Error("no readable answer");
    } catch (error: unknown) {
      failure = error;
    }
  }
  return {
    pass: resolvePass(panel, null, stockAvailable, answering),
    warning: `The note could not be read against the panel's settings (${getErrorMessage(failure)}), so the settings stood.`,
  };
}
