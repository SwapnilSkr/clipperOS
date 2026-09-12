import { listCaptionStyles } from "../src/config/caption-styles";
import { buildTimelineCaptions, renderAss } from "../src/services/caption.service";

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
  { startSec: 10, displayStartSec: 10.2, endSec: 10.9, text: "Retimed" },
]);
check(
  "subtitle section start and end can be retimed",
  Math.abs((retimed[0]?.start ?? 0) - 0.2) < 0.001 && Math.abs((retimed[0]?.end ?? 0) - 0.9) < 0.001
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
check("known caption font reaches ASS Fontname", montserrat.includes("Style: Cap,Montserrat,"));
check("unknown caption font falls back to Arial", renderAss(captions, { fontFamily: "Not A Real Face" }).includes("Style: Cap,Arial,"));

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
