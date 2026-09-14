/**
 *   bun run scripts/validate-creator-parity.ts
 *
 * The client's creator-timeline is a port of the server's. This runs both on
 * the same inputs and fails on the first disagreement, so a rule changed on
 * one side cannot quietly desynchronise the preview from the burn.
 */
import * as client from "../src/lib/creator-timeline";
import * as server from "../../server/src/services/creator-timeline";
import type { CreatorPlan, PauseCut, ReframeTrack } from "../src/api";

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Deterministic pseudo-random so a failure reproduces.
let seed = 7;
function rand(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

const track: ReframeTrack = {
  mode: "crop",
  sourceWidth: 1920,
  sourceHeight: 1080,
  confidence: 1,
  provider: "faces",
  originSec: 100,
  untilSec: 140,
  cuts: [12.5],
  keyframes: Array.from({ length: 20 }, (_, i) => ({
    t: i * 2,
    cx: 700 + rand() * 500,
    cy: 540,
    width: 608,
    fx: 700 + rand() * 500,
    fy: 300 + rand() * 200,
    fw: 100 + rand() * 40,
  })),
};

let mismatches = 0;
for (let round = 0; round < 60; round++) {
  const trimStart = 100 + rand() * 5;
  const trimEnd = trimStart + 15 + rand() * 20;
  const cuts: PauseCut[] = Array.from({ length: Math.floor(rand() * 6) }, (_, i) => {
    const start = trimStart + rand() * (trimEnd - trimStart);
    return { id: `c${i}`, startSec: start, endSec: start + rand() * 1.5, enabled: rand() > 0.3, source: "user" };
  });
  const plan: CreatorPlan = {
    enabled: true,
    version: 1,
    cuts,
    camera: {
      follow: { enabled: rand() > 0.5, tightness: rand(), zoom: 1 + rand() * 0.3 },
      moves: Array.from({ length: Math.floor(rand() * 4) }, (_, i) => {
        const start = trimStart + i * 5 + rand() * 2;
        const kinds = ["punch", "push", "pull"] as const;
        const eases = ["cut", "out", "in_out"] as const;
        const anchors = ["face", "center", { x: rand(), y: rand() }] as const;
        return {
          id: `m${i}`,
          kind: kinds[Math.floor(rand() * 3)]!,
          startSec: start,
          endSec: start + 0.3 + rand() * 2,
          zoom: 1.05 + rand() * 0.4,
          anchor: anchors[Math.floor(rand() * 3)]!,
          ease: eases[Math.floor(rand() * 3)]!,
        };
      }),
    },
  };

  const a = client.windowsFor(trimStart, trimEnd, cuts);
  const b = server.windowsFor(trimStart, trimEnd, cuts);
  if (JSON.stringify(a) !== JSON.stringify(b)) mismatches++;

  for (let i = 0; i < 40; i++) {
    const t = trimStart + rand() * (trimEnd - trimStart);
    if (Math.abs(client.sourceToOutput(a, t) - server.sourceToOutput(b, t)) > 1e-9) mismatches++;
    if (Math.abs(client.nextKeptTime(a, t) - server.nextKeptTime(b, t)) > 1e-9) mismatches++;
    const ca = client.cameraStateAt(plan, track, t);
    const cb = server.cameraStateAt(plan, track, t);
    if (Math.abs(ca.zoom - cb.zoom) > 1e-9 || Math.abs(ca.ax - cb.ax) > 1e-9 || Math.abs(ca.ay - cb.ay) > 1e-9) mismatches++;
  }
}

check("windows, clock mapping and camera state agree on 60 random plans", mismatches === 0, `${mismatches} mismatches`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ncreator timeline parity holds");
