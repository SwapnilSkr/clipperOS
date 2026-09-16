/**
 *   bun run scripts/validate-harness.ts
 *
 * The Director's harness without a model call: what the parsers make of a
 * model's answer (a clip's sense, a sound's catalogue entry, a render
 * review — including loose and broken answers), what the taste memory says
 * in a prompt, and how the studio frames a request for each generator. The
 * model-facing paths (video input, generation) are exercised live by the
 * Director itself; `bun run creator:validate` covers how the answer is applied.
 */
import { parseAssetSense, parseClipSense, parseRenderReview } from "../src/services/sense.service";
import { describeLessons } from "../src/services/taste.service";
import { framePrompt } from "../src/services/ai-assets.service";
import { searchLocalSounds } from "../src/services/sound-search.service";
import { directorModel, imageModel, musicModel, senseModel, videoModel } from "../src/config/models";
import { editorKnowledge } from "../src/services/director-knowledge.service";
import { parseRequestIntent, requestReaderPrompt, resolvePass, type RequestLane } from "../src/services/director-request.service";
import { changedLanes, describePlanLanes, parsePlanProposal } from "../src/services/director.service";
import { sanitizeCreatorPlan } from "../src/services/creator-plan.service";
import type { CreatorPlan, SoundtrackHit } from "../src/types/clip.types";

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- models: the defaults are the multimodal ones the harness needs ----
check("the Director's default model takes video", directorModel() === "google/gemini-3.8-flash" || Boolean(process.env.DIRECTOR_MODEL));
check("sense follows the Director unless overridden", process.env.SENSE_MODEL ? true : senseModel() === directorModel());
check("generators have defaults", Boolean(imageModel()) && Boolean(videoModel()) && Boolean(musicModel()));

// ---- clip sense ----
const senseText = `Here is what I saw:
\`\`\`json
{
  "overall": "A studio, warm light.",
  "shots": [{ "start": 0, "end": 10.8, "framing": "medium profile", "note": "one shot", "energy": 3 }, { "start": 10.8, "end": 99, "framing": "two-shot", "note": "", "energy": 9 }, { "start": 5, "end": 2, "framing": "bad", "note": "", "energy": 1 }],
  "moments": [{ "t": 2.2, "what": "laughs and gestures outward", "use": "punch in" }, { "t": 50, "what": "", "use": "x" }],
  "broll": [{ "t": 30.5, "idea": "a dragon", "query": "dragon dark cinematic silhouette" }, { "t": 1, "idea": "nothing", "query": "" }],
  "audio": "clean voice",
  "hook": "opens mid-chuckle",
  "payoff": "the dragon line"
}
\`\`\``;
const sense = parseClipSense(senseText, "m", { startSec: 100, endSec: 143.6 });
check("clip sense: fenced JSON parses", sense !== null);
check("clip sense: shots are clamped to the window, a backwards shot is dropped, energy is 1–5", sense!.shots.length === 2 && sense!.shots[1]!.end === 43.6 && sense!.shots[1]!.energy === 5);
check("clip sense: an empty moment and an empty b-roll query are dropped", sense!.moments.length === 1 && sense!.broll.length === 1 && sense!.broll[0]!.query === "dragon dark cinematic silhouette");
check("clip sense: the window it was made for is kept", sense!.for.startSec === 100 && sense!.for.endSec === 143.6 && sense!.model === "m");
check("clip sense: no JSON is null, not a throw", parseClipSense("I could not watch it.", "m", { startSec: 0, endSec: 1 }) === null);

// ---- asset sense ----
const asset = parseAssetSense(`{"line":"dark phonk beat, distorted cowbells","tags":["phonk","dark",7,"808s"],"bpm":"136","energy":4.4,"suits":["a hype peak"]}`, "m");
check("asset sense: bpm from a string, energy rounded, non-string tags dropped", asset?.bpm === 136 && asset.energy === 4 && asset.tags.length === 3);
check("asset sense: an sfx has no bpm", parseAssetSense(`{"line":"a whoosh","tags":[],"bpm":0,"energy":4}`, "m")?.bpm === undefined);
const judged = parseAssetSense(`{"line":"a dragon","tags":["dragon"],"energy":3,"quality":"2","flaws":["text or lettering","AI artifacts"]}`, "m");
check("asset sense: a picture's quality and flaws are kept", judged?.quality === 2 && judged.flaws?.length === 2);
check("asset sense: no line is null", parseAssetSense(`{"tags":["x"]}`, "m") === null);

// ---- render review ----
const review = parseRenderReview(`{"score":"6","verdict":"Fine.","issues":[{"t":28.97,"what":"flat peak","fix":"punch in"},{"what":"","fix":"x"},{"what":"no hook","fix":"title card"}],"keep":["captions read",42]}`, "m", 3);
check("review: score coerced, empty issues dropped, keeps are strings, revision kept", review?.score === 6 && review.issues.length === 2 && review.issues[1]!.t === undefined && review.keep.length === 1 && review.revision === 3);
check("review: a wild score is clamped", parseRenderReview(`{"score":14,"verdict":"","issues":[],"keep":[]}`, "m", 1)?.score === 10);

// ---- taste ----
const block = describeLessons([
  { id: "1", scope: "global", kind: "feedback", text: "No slow motion.", weight: 9, at: "t" },
  { id: "2", scope: "p", kind: "edit", text: "Fewer camera moves.", weight: 5, at: "t" },
]);
check("lessons: the creator's own words are marked as such", block === "- No slow motion. (the creator said so)\n- Fewer camera moves.");
check("lessons: none is an empty block", describeLessons([]) === "");

// ---- studio prompt framing ----
check("music: instrumental unless vocals are asked for", framePrompt({ kind: "music", prompt: "lo-fi bed" }).startsWith("Instrumental only") && !framePrompt({ kind: "music", prompt: "a sung hook with vocals" }).startsWith("Instrumental"));
check("image: vertical by default, no text", framePrompt({ kind: "image", prompt: "a dragon" }).includes("vertical 9:16") && framePrompt({ kind: "image", prompt: "a dragon" }).includes("no text"));
check("video: the aspect asked for", framePrompt({ kind: "video", prompt: "a push in", aspectRatio: "16:9" }).includes("widescreen 16:9"));
check("a picture is asked to match the footage's look", framePrompt({ kind: "image", prompt: "a dragon", look: "moody dark studio, warm accent light" }).includes("match its lighting, palette and mood: moody dark studio"));

// ---- local sound search ----
const shelf = [
  { id: "custom:1", kind: "sfx" as const, label: "Impact glass heavy 000", durationSec: 0.8, source: "upload" as const },
  { id: "custom:2", kind: "sfx" as const, label: "Impact wood light 001", durationSec: 0.4, source: "upload" as const },
  { id: "custom:3", kind: "sfx" as const, label: "Whoosh", durationSec: 0.5, sense: { line: "a fast airy whoosh with a glassy tail", tags: ["whoosh", "transition"], model: "m", at: "t" } },
  { id: "custom:4", kind: "sfx" as const, label: "Impact glass light 002", durationSec: 0.5, source: "freesound" as const, sense: { line: "a small glass tap", tags: ["glass"], quality: 2, flaws: ["hiss or noise floor"], model: "m", at: "t" } },
];
const glass = searchLocalSounds("glass shattering", shelf, { kind: "sfx" });
check("local search: a clean name match leads, a described sound is found, a flawed one sinks below it", glass[0]!.id === "custom:1" && glass.some((a) => a.id === "custom:3") && glass.findIndex((a) => a.id === "custom:4") > 0, glass.map((a) => a.id).join(","));
check("local search: nothing matches nothing", searchLocalSounds("cash register", shelf).length === 0);

// ---- the note outranks the panel ----
const note =
  "Can you maintain a consistent caption that is maybe 2 words per line and maybe at the peak we can have some really gripping captions? Remove all the unnecessary cuts, have proper stock videos, and good sfx and music as well";
const readerAnswer = JSON.stringify({
  edits: true,
  reply: "",
  lanes: [
    { lane: "captions", quote: "2 words per line" },
    { lane: "cuts", quote: "remove all the unnecessary cuts" },
    { lane: "sfx", quote: "good sfx" },
    { lane: "speed", quote: "dramatic slow motion" },
    { lane: "bogus", quote: "good sfx" },
  ],
  assets: { value: "stock", quote: "proper stock videos" },
  music: { value: true, quote: "sfx and music" },
  see: null,
  wordsPerLine: { value: 2, quote: "2 words per line" },
});
const intent = parseRequestIntent("```json\n" + readerAnswer + "\n```", note);
check(
  "request: asks quoting the note are kept; an invented quote and an unknown lane are dropped",
  intent?.lanes.join(",") === "captions,cuts,sfx" && intent.assets === "stock" && intent.music === true && intent.wordsPerLine === 2 && intent.edits,
  intent?.lanes.join(",")
);
const panel = { assets: "library" as const, music: false, see: true, keep: ["captions", "sfx", "music", "camera"] as RequestLane[], plan: false };
const pass = resolvePass(panel, intent, true);
check(
  "request: the note unlocks the lanes it names, switches B-roll to stock, lays music, holds 2 words",
  pass.keep.join(",") === "camera" && pass.assets === "stock" && pass.music && pass.wordsPerLine === 2 && pass.followed.length === 4,
  pass.followed.join(" | ")
);
const noStock = resolvePass(panel, intent, false);
check("request: without a stock provider the panel's source stands and it says why", noStock.assets === "library" && noStock.followed.some((line) => line.includes("no stock provider")));
check("request: Both already covers a note asking for stock", resolvePass({ ...panel, assets: "both" }, intent, true).assets === "both");
const question = parseRequestIntent(`{"edits": false, "reply": "Beds are made by google/lyria-3-pro-preview.", "lanes": [{"lane":"music","quote":"makes the music"}]}`, "Which model makes the music?");
const answered = resolvePass(panel, question, true);
check("request: a question alone is answered and changes nothing", question?.edits === false && Boolean(answered.reply) && !answered.edits && answered.keep.length === 4 && answered.followed.length === 0);
check("request: edits:false with nothing to answer still edits", parseRequestIntent(`{"edits": false, "reply": ""}`, "tighten it")?.edits === true);
check("request: an unreadable answer is null and the panel stands", parseRequestIntent("sure, will do", note) === null && resolvePass(panel, null, true).assets === "library");
const sheet = editorKnowledge();
check(
  "knowledge: names the model behind every generator and what is configured",
  [directorModel(), senseModel(), imageModel(), videoModel(), musicModel()].every((model) => sheet.includes(model)) && sheet.includes("Freesound") && sheet.includes("Stock video/stills")
);

// ---- the note switches between proposing and cutting ----
const goAhead = resolvePass({ ...panel, plan: true }, parseRequestIntent(`{"edits": true, "mode": {"value": "execute", "quote": "go ahead", "why": "you said go ahead"}}`, "looks good, go ahead"), true);
check(
  "mode: go ahead in Plan first cuts straight away, says so, and never stops to ask",
  !goAhead.plan && goAhead.followed.includes("Cut straight away instead of proposing — you said go ahead.") && !goAhead.mayAsk,
  goAhead.followed.join(" | ")
);
const proposes = resolvePass(panel, parseRequestIntent(`{"edits": true, "mode": {"value": "plan", "quote": "show me options", "why": "you asked for options"}}`, "redo the hook but show me options first"), true);
check("mode: asking for options in Auto proposes first", proposes.plan && proposes.followed.some((line) => line.startsWith("Proposed first instead of cutting")) && !proposes.mayAsk);
check("mode: holding the cut back needs the note's own words", parseRequestIntent(`{"edits": true, "mode": {"value": "plan", "quote": "let me decide"}}`, "make the hook punchier")?.mode === undefined);
const open = parseRequestIntent(`{"edits": true}`, "make it better");
check(
  "mode: Auto with a note may stop to ask — not while a proposal is answered, not without a note",
  resolvePass(panel, open, true).mayAsk && !resolvePass(panel, open, true, true).mayAsk && !resolvePass(panel, null, true).mayAsk
);

// ---- questions with options ----
const proposal = parsePlanProposal(
  JSON.stringify({
    proposal: "Punch the hook.",
    asks: [
      { header: "Tone", question: "Which tone?", options: [{ label: "Hype (Recommended)", detail: "phonk bed, fast cuts" }, { label: "Calm" }, "Dry", "hype"], recommended: 0 },
      { question: "Use the dragon still?", options: ["Yes"] },
      { question: "" },
      { question: "How long is the B-roll?", options: ["Short", "Long (recommended)"] },
      "Anything else?",
      { question: "A fifth?", options: ["a", "b"] },
    ],
  })
);
check(
  "asks: options keep label and detail, duplicates drop, one option is an open question, a (recommended) tag recommends, at most 4",
  proposal?.asks.length === 4 &&
    proposal.asks[0]!.options.length === 3 &&
    proposal.asks[0]!.options[0]!.label === "Hype" &&
    proposal.asks[0]!.options[0]!.detail === "phonk bed, fast cuts" &&
    proposal.asks[0]!.header === "Tone" &&
    proposal.asks[1]!.options.length === 0 &&
    proposal.asks[2]!.recommended === 1 &&
    proposal.asks[3]!.question === "Anything else?" &&
    proposal.questions.length === 4,
  JSON.stringify(proposal?.asks)
);
check("asks: an older proposal of plain questions still parses", parsePlanProposal(`{"proposal":"x","questions":["A?","B?"]}`)?.asks.length === 2);
const storedPlan = sanitizeCreatorPlan({ enabled: false, version: 1, director: { turns: [{ summary: "p", at: "t", kind: "plan", asks: proposal!.asks }] } });
check(
  "asks: a stored proposal keeps its options and recommendation",
  storedPlan.director?.turns?.[0]?.asks?.[3]?.question === "Anything else?" && storedPlan.director?.turns?.[0]?.asks?.[2]?.recommended === 1
);

// ---- the conversation: taking a pass back, what a pass changed, a note read in context ----
const undoOnly = parseRequestIntent(`{"edits": false, "undo": {"value": true, "quote": "undo that"}}`, "nah, undo that");
const undoPass = resolvePass(panel, undoOnly, true);
check("undo: a note that only takes the pass back changes nothing else", undoOnly?.undo === true && undoOnly.edits === false && undoPass.undo === true && !undoPass.edits);
const undoAnd = resolvePass(
  panel,
  parseRequestIntent(`{"edits": true, "undo": {"value": true, "quote": "undo that"}, "lanes": [{"lane": "music", "quote": "a darker bed"}]}`, "undo that and try a darker bed"),
  true
);
check("undo: taking back and asking for more does both, and names the lane", undoAnd.undo === true && undoAnd.edits && undoAnd.lanes.join(",") === "music", undoAnd.lanes.join(","));
const composed = resolvePass(
  { ...panel, assets: "stock", music: false },
  parseRequestIntent(`{"edits": true, "composeMusic": {"value": true, "quote": "compose an original bed"}}`, "compose an original bed for this"),
  true
);
check(
  "music: a note asking for a bed made to order composes one whatever the B-roll source, and lays music",
  composed.composeMusic === true && composed.music && composed.lanes.includes("music") && composed.followed.some((line) => line.startsWith("Composed a music bed to order")),
  composed.followed.join(" | ")
);
check(
  "music: a darker bed is not a request to compose, and the words must be in the note",
  !resolvePass(panel, parseRequestIntent(`{"edits": true, "composeMusic": {"value": true, "quote": "compose a bed"}}`, "a darker bed please"), true).composeMusic
);
const notUndo = parseRequestIntent(`{"edits": false, "undo": {"value": true, "quote": "undo that"}}`, "drop the title");
check("undo: needs the note's own words, and without them the note edits", notUndo?.undo === undefined && notUndo?.edits === true);

const lanePlan = (text: string, overrides: Record<string, unknown>) =>
  ({
    enabled: true,
    version: 1,
    titles: [{ text, startSec: 100.1, endSec: 102.4, x: 0.5, y: 0.5, sizeScale: 1.9, depth: "behind", animation: "pop", color: "#ffffff" }],
    captionScenes: [{ startSec: 100, endSec: 102, styleId: "creator_hook", overrides }],
  }) as unknown as CreatorPlan;
const hits = [{ id: "h1", assetId: "swoosh", atSec: 1 }] as unknown as SoundtrackHit[];
const lanesBefore = describePlanLanes(lanePlan("THE ONE RULE", { uppercase: true, sizeScale: 1.3 }), hits, 100);
check(
  "changed: the same plan stored with its overrides in another order reads unchanged",
  changedLanes(lanesBefore, describePlanLanes(lanePlan("THE ONE RULE", { sizeScale: 1.3, uppercase: true }), hits, 100)).length === 0
);
check(
  "changed: a new title text is a titles change and nothing else",
  changedLanes(lanesBefore, describePlanLanes(lanePlan("STOP DOING THIS", { uppercase: true, sizeScale: 1.3 }), hits, 100)).join(",") === "titles"
);
const cutPlan = { enabled: true, version: 1, cuts: [{ id: "pause1", startSec: 100.5, endSec: 101.5, savesSec: 1, enabled: true }] } as unknown as CreatorPlan;
const clocked = describePlanLanes(cutPlan, hits, 100, new Map(), [], 110).sfx[0] ?? "";
check("brief: a hit is told on the source clock the model answers in", clocked.includes("at 2.00 source (1.00 output clock)"), clocked);
const keptTurns = sanitizeCreatorPlan({
  enabled: false,
  version: 1,
  director: { turns: [{ summary: "cut", at: "a", changed: ["titles", 7], undone: true }, { summary: "took back", at: "b", kind: "undo", changed: ["x"] }] },
});
check(
  "turns: a pass keeps what it changed and that it was taken back; an undo turn keeps its kind",
  keptTurns.director?.turns?.[0]?.changed?.join(",") === "titles" &&
    keptTurns.director?.turns?.[0]?.undone === true &&
    keptTurns.director?.turns?.[1]?.kind === "undo" &&
    keptTurns.director?.turns?.[1]?.changed === undefined
);
const readerInContext = requestReaderPrompt("make that shorter", panel, "KNOWLEDGE", undefined, {
  turns: [{ notes: "B-roll of a server room", summary: "Laid a server-room cutaway at 12.4s.", at: "a", changed: ["cutaways"] }],
  plan: "cutaway asset x 12.40–14.60",
  undoable: true,
});
check(
  "reader: reads the note against the conversation and the edit as it stands",
  readerInContext.includes("changed cutaways") && readerInContext.includes("12.40–14.60") && readerInContext.includes('"undo"')
);

if (failures > 0) {
  console.log(`\n${failures} harness check(s) failed`);
  process.exit(1);
}
console.log("\nall harness checks passed");
