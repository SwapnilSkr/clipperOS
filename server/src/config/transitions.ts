// ============================================
// CUTAWAY TRANSITIONS — how a stock shot arrives and leaves.
//
// A cutaway is an overlay on the main picture, so a transition is a change
// in the overlay's alpha, position or extent over its length. The burn
// (cutaway.service.ts) runs each as `xfade` between the cutaway and a
// transparent stream — a dissolve as an alpha `fade`, which does not dip —
// and the preview (CutawayLayer) approximates the same with CSS. The time
// comes from the footage either side, so the clip's clock never changes.
// ============================================

export type TransitionKind = "fade" | "slide" | "wipe" | "zoom" | "dip" | "circle" | "smooth" | "pixelize";

export interface TransitionDef {
  id: string;
  label: string;
  summary: string;
  kind: TransitionKind;
  /** For slides and wipes: where the picture comes from / goes to. */
  side?: "left" | "right" | "up" | "down";
  /** For dips: the colour passed through. */
  colour?: "black" | "white";
}

export const CUTAWAY_TRANSITIONS: TransitionDef[] = [
  { id: "dissolve", label: "Dissolve", summary: "Cross-fades.", kind: "fade" },
  { id: "cut", label: "Cut", summary: "Hard cut.", kind: "fade" },
  { id: "dip_black", label: "Dip to black", summary: "Through black.", kind: "dip", colour: "black" },
  { id: "dip_white", label: "Flash", summary: "Through white.", kind: "dip", colour: "white" },
  { id: "slide_left", label: "Slide from right", summary: "Pushes in from the right.", kind: "slide", side: "right" },
  { id: "slide_right", label: "Slide from left", summary: "Pushes in from the left.", kind: "slide", side: "left" },
  { id: "slide_up", label: "Slide from below", summary: "Rises in from the bottom.", kind: "slide", side: "down" },
  { id: "slide_down", label: "Slide from above", summary: "Drops in from the top.", kind: "slide", side: "up" },
  { id: "wipe_right", label: "Wipe", summary: "Reveals left to right.", kind: "wipe", side: "left" },
  { id: "wipe_left", label: "Wipe left", summary: "Reveals right to left.", kind: "wipe", side: "right" },
  { id: "wipe_down", label: "Wipe down", summary: "Reveals top to bottom.", kind: "wipe", side: "up" },
  { id: "smooth_left", label: "Soft wipe", summary: "A feathered edge sweeping right to left.", kind: "smooth", side: "right" },
  { id: "circle_open", label: "Iris", summary: "Opens from a circle in the middle.", kind: "circle" },
  { id: "pixelize", label: "Pixelize", summary: "Dissolves through big pixels.", kind: "pixelize" },
  { id: "zoom", label: "Zoom", summary: "Grows in while fading.", kind: "zoom" },
];

export const TRANSITIONS_BY_ID = new Map(CUTAWAY_TRANSITIONS.map((item) => [item.id, item]));

export function isTransitionId(value: unknown): value is string {
  return typeof value === "string" && TRANSITIONS_BY_ID.has(value);
}

export function transitionInfo(): { id: string; label: string; summary: string }[] {
  return CUTAWAY_TRANSITIONS.map(({ id, label, summary }) => ({ id, label, summary }));
}
