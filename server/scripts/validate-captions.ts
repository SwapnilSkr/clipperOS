import { listCaptionStyles } from "../src/config/caption-styles";
import { snapCleanCues, stripCaptionFillers } from "../src/services/caption-clean.service";
import { ASS_FONT_SIZE_MATCH, CAPTION_BASE_FONT } from "../src/types/clip.types";
import {
  applyCaptionWords,
  bindTranscriptToTimings,
  buildTimelineCaptions,
  renderAss,
} from "../src/services/caption.service";
import { expandWordTimings } from "../src/services/transcript.service";
import { assVideoFilter } from "../src/utils/ffmpeg-path.utils";

let failures = 0;
function check(name: string, pass: boolean): void {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
}

const words = [
  { t: 10, word: "original" },
  { t: 10.4, word: "subtitle" },
  { t: 11, word: "next" },
];
const captions = buildTimelineCaptions(words, 10, 2, undefined, undefined, 2, [
  { startSec: 10, text: "Corrected subtitle" },
]);
check("text correction keeps timing and replaces only copy", captions[0]?.text === "Corrected subtitle");
check("following subtitle remains generated", captions[1]?.text === "next");

const extended = buildTimelineCaptions(
  [...words, { t: 12, word: "fresh" }, { t: 12.4, word: "line" }],
  10,
  4,
  undefined,
  undefined,
  2,
  [{ startSec: 10, text: "Corrected subtitle" }]
);
check("extending the window keeps the edited subtitle", extended[0]?.text === "Corrected subtitle");
check(
  "extending the window generates captions for the new words",
  extended.some((caption) => caption.text.includes("fresh") || caption.text.includes("line"))
);

const afterRemovedTail = buildTimelineCaptions(
  [...words, { t: 12, word: "fresh" }, { t: 12.4, word: "line" }],
  10,
  4,
  undefined,
  undefined,
  2,
  [{ startSec: 11, hidden: true, text: "next" }]
);
check(
  "a removed leftover at the old out-point does not swallow new captions",
  afterRemovedTail.some((caption) => caption.text.includes("fresh"))
);

const strideWords = [
  { t: 10, word: "one" },
  { t: 10.3, word: "two" },
  { t: 10.6, word: "three" },
  { t: 11, word: "four" },
  { t: 11.3, word: "five" },
  { t: 11.6, word: "six" },
];
const afterHideGroup = buildTimelineCaptions(strideWords, 10, 3, undefined, undefined, 3, [
  { startSec: 10, endSec: 11, hidden: true },
]);
check(
  "hiding a section keeps the next words-per-caption group intact",
  afterHideGroup.length === 1 && afterHideGroup[0]?.text === "four five six"
);
const afterHideWord = buildTimelineCaptions(strideWords, 10, 3, undefined, undefined, 3, [
  { startSec: 10.3, hidden: true },
]);
check(
  "dropping one leftover word still packs the rest by words-per-caption",
  afterHideWord[0]?.text.split(" ").length === 3 &&
    afterHideWord.every((caption) => caption.text.split(" ").length <= 3)
);

const sectionEdits = buildTimelineCaptions(words, 10, 3, undefined, undefined, 2, [
  { startSec: 10, hidden: true },
  { id: "manual-1", custom: true, startSec: 10.75, endSec: 11.7, text: "Added section" },
]);
check("generated subtitle section can be removed", !sectionEdits.some((caption) => caption.text.includes("original")));
check(
  "custom timestamped subtitle section is inserted",
  sectionEdits.some(
    (caption) =>
      caption.text === "Added section" &&
      Math.abs(caption.start - 0.75) < 0.001 &&
      Math.abs(caption.end - 1.7) < 0.001
  )
);

const retimed = buildTimelineCaptions(words, 10, 3, undefined, undefined, 2, [
  { id: "manual-2", custom: true, startSec: 10.2, endSec: 10.9, text: "Retimed" },
]);
check(
  "subtitle section start and end can be retimed",
  retimed.some(
    (caption) =>
      caption.text === "Retimed" &&
      Math.abs(caption.start - 0.2) < 0.001 &&
      Math.abs(caption.end - 0.9) < 0.001
  )
);

check(
  "peak highlight can be turned off so every caption matches",
  buildTimelineCaptions(words, 10, 2, "original subtitle", 10, 2, [], false).every(
    (caption) => caption.emphasis === false
  )
);
check(
  "peak highlight stays on by default",
  buildTimelineCaptions(words, 10, 2, "original subtitle", 10, 2).some((caption) => caption.emphasis)
);

const ass = renderAss(captions, {
  horizontalFrac: 0.23,
  verticalFrac: 0.71,
  textColor: "#ffffff",
  peakColor: "#fde047",
  background: "box",
  animation: "pop",
});
check("free position reaches ASS output", ass.includes("\\pos(248,557)"));
check("pop entrance reaches ASS output", ass.includes("\\t(0,140"));
check("box treatment reaches ASS styles", ass.includes(",3,14,0,2,"));

const montserrat = renderAss(captions, { fontFamily: "Montserrat" });
check(
  "burned caption size matches the preview optically",
  montserrat.includes(`Style: Cap,Montserrat,${Math.round(CAPTION_BASE_FONT * ASS_FONT_SIZE_MATCH)},`)
);
check("known caption font reaches ASS Fontname", montserrat.includes("Style: Cap,Montserrat,"));
check("ums are stripped from a cue", stripCaptionFillers("um so I've always") === "so I've always");
check("a filler-only cue hides", stripCaptionFillers("uh um") === "");
check(
  "clean snaps to the spoken cue start",
  snapCleanCues([{ startSec: 12.41, text: "so I've always" }], [
    { startSec: 12.4, endSec: 13.1, text: "um so I've always" },
  ])[0]?.startSec === 12.4
);
check(
  "unchanged copy is not written as an override",
  snapCleanCues([{ startSec: 12.4, text: "keep this" }], [
    { startSec: 12.4, endSec: 13.1, text: "keep this" },
  ]).length === 0
);
check(
  "ass filter pins fonts to the 9:16 canvas",
  assVideoFilter("/tmp/captions.ass").includes("original_size=1080x1920")
);
check("unknown caption font falls back to Arial", renderAss(captions, { fontFamily: "Not A Real Face" }).includes("Style: Cap,Arial,"));

const phraseOnsets = expandWordTimings([
  { t: 10, word: "so I've always" },
  { t: 10.9, word: "believed" },
]);
check(
  "a phrase timestamp expands to one token per word",
  phraseOnsets.map((item) => item.word).join(" ") === "so I've always believed"
);
const oneWordFromPhrase = buildTimelineCaptions(
  [{ t: 10, word: "so I've always" }, { t: 10.9, word: "believed" }],
  10,
  2,
  undefined,
  undefined,
  1
);
check(
  "words-per-caption 1 splits a phrase timestamp into one-word cues",
  oneWordFromPhrase.length === 4 && oneWordFromPhrase.every((caption) => caption.text.split(" ").length === 1)
);
const leftoverPhraseEdit = buildTimelineCaptions(
  [{ t: 10, word: "so I've always" }, { t: 10.9, word: "believed" }],
  10,
  2,
  undefined,
  undefined,
  1,
  [{ startSec: 10, endSec: 10.9, text: "so I've always" }]
);
check(
  "a leftover 3-word edit does not cover the new one-word cues",
  leftoverPhraseEdit[0]?.text === "so" && leftoverPhraseEdit.every((caption) => caption.text.split(" ").length === 1)
);
check(
  "a leftover 2-word edit does not cover a one-word cue",
  buildTimelineCaptions(
    [{ t: 10, word: "so I've always" }, { t: 10.9, word: "believed" }],
    10,
    2,
    undefined,
    undefined,
    1,
    [{ startSec: 10.9, text: "of believed" }]
  ).every((caption) => caption.text.split(" ").length === 1)
);
check(
  "a matching one-word rewrite still applies",
  buildTimelineCaptions(
    [{ t: 10, word: "so I've always" }, { t: 10.9, word: "believed" }],
    10,
    2,
    undefined,
    undefined,
    1,
    [],
    true,
    [{ t: 10, word: "So" }]
  )[0]?.text === "So"
);

const bound = bindTranscriptToTimings(
  [
    { t: 10, word: "so" },
    { t: 10.3, word: "I've" },
    { t: 10.6, word: "always" },
    { t: 10.9, word: "believed" },
  ],
  "So I have always believed"
);
const afterBind = buildTimelineCaptions(
  [
    { t: 10, word: "so" },
    { t: 10.3, word: "I've" },
    { t: 10.6, word: "always" },
    { t: 10.9, word: "believed" },
  ],
  10,
  2,
  undefined,
  undefined,
  1,
  [],
  true,
  bound
);
check(
  "an edited transcript stays bound when words-per-caption is 1",
  afterBind.map((caption) => caption.text).join(" ") === "So I have always believed"
);
const regrouped = buildTimelineCaptions(
  [
    { t: 10, word: "so" },
    { t: 10.3, word: "I've" },
    { t: 10.6, word: "always" },
    { t: 10.9, word: "believed" },
  ],
  10,
  2,
  undefined,
  undefined,
  3,
  [],
  true,
  bound
);
check(
  "the same transcript edit survives a words-per-caption change",
  regrouped.some((caption) => caption.text.includes("So")) &&
    regrouped.map((caption) => caption.text).join(" ").includes("believed")
);

const firstWordPrefix = bindTranscriptToTimings(
  [
    { t: 10, word: "so" },
    { t: 10.3, word: "I've" },
    { t: 10.6, word: "always" },
  ],
  "Well so I've always"
);
const firstPatched = applyCaptionWords(
  [
    { t: 10, word: "so" },
    { t: 10.3, word: "I've" },
    { t: 10.6, word: "always" },
  ],
  firstWordPrefix
);
check(
  "a word typed at the start stays on the first onset",
  firstPatched[0]?.word === "Well" && firstPatched.map((word) => word.word).join(" ") === "Well so I've always"
);
const firstWordSwap = bindTranscriptToTimings(
  [
    { t: 10, word: "so" },
    { t: 10.3, word: "I've" },
    { t: 10.6, word: "always" },
  ],
  "Because I've always"
);
check(
  "replacing the first word does not move it later",
  applyCaptionWords(
    [
      { t: 10, word: "so" },
      { t: 10.3, word: "I've" },
      { t: 10.6, word: "always" },
    ],
    firstWordSwap
  )
    .map((word) => word.word)
    .join(" ") === "Because I've always"
);

const lastWordNearOut = buildTimelineCaptions(
  [
    { t: 10, word: "hello" },
    { t: 11.85, word: "benefits." },
  ],
  10,
  2,
  undefined,
  undefined,
  1
);
const lastNearOut = lastWordNearOut[lastWordNearOut.length - 1];
check(
  "a last word inside the trim is captioned and clears before the join frame",
  (lastNearOut?.text ?? "").toLowerCase().includes("benefit") && (lastNearOut?.end ?? 2) <= 1.96
);

const templates = listCaptionStyles();
check("short-form template library is broad but compact", templates.length >= 9);
check(
  "every template has render-complete position and motion",
  templates.every(
    (style) =>
      style.horizontalFrac >= 0 &&
      style.horizontalFrac <= 1 &&
      style.verticalFrac >= 0 &&
      style.verticalFrac <= 1 &&
      ["none", "pop", "fade"].includes(style.animation)
  )
);
check(
  "every template uses a known caption font",
  templates.every((style) => renderAss([], { fontFamily: style.fontFamily }).includes(`Style: Cap,${style.fontFamily},`))
);

console.log(failures === 0 ? "\nall caption checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
