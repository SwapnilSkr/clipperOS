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
import { directorModel, imageModel, musicModel, senseModel, videoModel } from "../src/config/models";

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

if (failures > 0) {
  console.log(`\n${failures} harness check(s) failed`);
  process.exit(1);
}
console.log("\nall harness checks passed");
