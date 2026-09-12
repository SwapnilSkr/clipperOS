/**
 *   bun run scripts/validate-cut-check.ts
 */
import { checkSceneCuts } from "../src/lib/cut-check";
import type { ReframeTrack } from "../src/api";

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const track: ReframeTrack = {
  mode: "crop",
  sourceWidth: 1920,
  sourceHeight: 1080,
  confidence: 1,
  provider: "faces",
  originSec: 1055.83,
  untilSec: 1196.1,
  cuts: [29.5543, 41.4996, 50.275],
  keyframes: [
    { t: 29.5543, cx: 1090, cy: 540, width: 608 },
    { t: 41.4996, cx: 1562, cy: 540, width: 608 },
    { t: 50.275, cx: 1119, cy: 540, width: 608 },
  ],
};

{
  const results = checkSceneCuts(track, 1057.13, 1196.1, 1920, 1080);
  const cut = results.find((item) => Math.abs(item.sourceSec - 1097.3296) < 0.01);
  check("18:17 camera cut is in the trim", !!cut);
  check("fixed clocks mark that cut clean", cut?.status === "ok", cut?.status);
}

{
  const late: ReframeTrack = {
    ...track,
    keyframes: [
      { t: 29.5543, cx: 1090, cy: 540, width: 608 },
      { t: 41.56, cx: 1562, cy: 540, width: 608 },
    ],
    cuts: [41.4996],
  };
  const results = checkSceneCuts(late, 1057.13, 1196.1, 1920, 1080);
  check("a snap a frame late is flagged as a flash", results[0]?.status === "flash", results[0]?.status);
}

{
  const results = checkSceneCuts(track, 1057.13, 1090, 1920, 1080);
  check(
    "tightening the out-point drops cuts past the trim",
    !results.some((item) => Math.abs(item.sourceSec - 1097.3296) < 0.01),
    results.map((item) => item.sourceSec.toFixed(1)).join(",")
  );
}

console.log(failures === 0 ? "\nall cut-check checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
