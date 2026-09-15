import { Camera, Captions, Film, Gauge, Scissors, Sparkles, Type, Volume2, type LucideIcon } from "lucide-react";
import type { BeatLane } from "@/lib/beat-plan";

// ============================================================
// LANES — one name, one icon, one sentence per kind of beat.
//
// The timeline's lane labels, the "Add" list in the Create rail and the
// inspector headers all read from here, so the thing you add is visibly the
// thing on the lane and the thing you then edit.
// ============================================================

export interface LaneInfo {
  id: BeatLane;
  /** Lane label on the timeline (plural, short). */
  label: string;
  /** What one of them is called (the Add list, the inspector). */
  name: string;
  icon: LucideIcon;
  /** One line on what it does, for the Add list. */
  summary: string;
  /** The lane "+" tooltip. */
  add: string;
}

export const LANES: LaneInfo[] = [
  { id: "cuts", label: "Cuts", name: "Cut", icon: Scissors, summary: "Remove a pause or a stumble", add: "Cut 0.4s here" },
  { id: "camera", label: "Camera", name: "Camera move", icon: Camera, summary: "Punch in, frame a shot, hold still", add: "Punch in here" },
  { id: "speed", label: "Speed", name: "Speed", icon: Gauge, summary: "Slow motion, fast or a freeze", add: "Slow motion here" },
  { id: "fx", label: "FX", name: "Effect", icon: Sparkles, summary: "A look: B&W, VHS, glitch…", add: "Effect here" },
  { id: "cutaways", label: "B-roll", name: "B-roll", icon: Film, summary: "A picture or stock clip over the speaker", add: "Cutaway here" },
  { id: "captions", label: "Captions", name: "Caption style", icon: Captions, summary: "How captions look from here", add: "Caption scene here" },
  { id: "titles", label: "Text", name: "Text", icon: Type, summary: "Your own caption, placed and animated", add: "Text here" },
  { id: "sfx", label: "SFX", name: "Sound effect", icon: Volume2, summary: "A whoosh, pop or boom", add: "Sound here" },
];

export const LANE_BY_ID = new Map(LANES.map((lane) => [lane.id, lane]));
