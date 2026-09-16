import { config } from "../config";
import { listCaptionFonts } from "../config/caption-fonts";
import { listCaptionStyles } from "../config/caption-styles";
import { effectInfo } from "../config/effects";
import { directorModel, imageModel, musicModel, senseModel, sfxModel, videoModel } from "../config/models";
import { transitionInfo } from "../config/transitions";
import {
  MAX_CAMERA_MOVES,
  MAX_CAPTION_SCENES,
  MAX_CUTAWAYS,
  MAX_EFFECT_SPANS,
  MAX_SPEED_SPANS,
  MAX_TITLES,
} from "../types/clip.types";
import { falConfigured } from "./fal.service";
import { freesoundConfigured } from "./freesound.service";
import { MAX_MUSIC_BEDS, MAX_SOUNDTRACK_HITS } from "./soundtrack.service";
import { stockSources } from "./stock.service";

// ============================================
// WHAT THE DIRECTOR KNOWS ABOUT THE EDITOR — read from this install, not
// written from memory: the model behind every generator, which sources have
// keys, the limits the sanitiser enforces. It goes into the request reader
// (so a question about the editor gets a true answer) and into every brief
// (so a note naming a tool or a desk is understood).
// ============================================

const on = (yes: boolean, what: string) => (yes ? `configured` : `NOT configured (${what} is not set)`);

export function editorKnowledge(): string {
  const stock = stockSources();
  const stockLine = stock.length
    ? `configured (${stock.map((source) => (source === "pexels" ? "Pexels" : "Pixabay")).join(" + ")}): real footage and stills, searched by 2–4 visual words, downloaded into the media library`
    : "NOT configured (PEXELS_API_KEY / PIXABAY_API_KEY are not set)";
  const openRouter = on(Boolean(config.openRouterApiKey), "OPENROUTER_API_KEY");
  return `EDITOR KNOWLEDGE (clipperOS, as installed right now):
- What it is: paste a YouTube link or upload a video; it transcribes it, mines the moments that work as Shorts, and ranks them on a board. Each clip opens in the editor and renders with FFmpeg to a 9:16 MP4 (captions burned by libass exactly as previewed).
- Edit desk: trim; reframe (centre or smart, which tracks the speaker); Subtitles panel (caption look presets, font, size, position, colours, words per line, box, animation, per-word transcript fixes); Viral edit (edit recipes and video effects); Cleanup (paint out burned-in text or watermarks); the outro sting joined after the clip.
- Create desk: the beat plan, in lanes — Cuts (dead air removed; candidates found where no word starts AND the audio is silent), Camera (follow that pins the head, punch / push / pull / frame / hold moves, up to ${MAX_CAMERA_MOVES}), Speed (slow motion, freeze, fast; up to ${MAX_SPEED_SPANS}), FX (${effectInfo().length} effects, up to ${MAX_EFFECT_SPANS} spans), B-roll cutaways (up to ${MAX_CUTAWAYS}, ${transitionInfo().length} transitions, Ken Burns drift on stills), Caption scenes (a caption look per stretch of the clip, up to ${MAX_CAPTION_SCENES}), Text / titles (the creator's own animated text, in front or behind the speaker via a matte, up to ${MAX_TITLES}), SFX hits (up to ${MAX_SOUNDTRACK_HITS}), Music beds (up to ${MAX_MUSIC_BEDS}). The Framing widget, the Studio and the AI Director live here too.
- Sound desk: music beds (level, dip under speech in dB, in/out, start point in the file, fades, sting carry) and one-shot hits with their own level; "Find a sound on Freesound" under the hits searches freesound.org, takes a recording into the shared library and drops it at the playhead.
- Caption looks: ${listCaptionStyles().map((style) => style.id).join(", ")}. Fonts: ${listCaptionFonts().map((font) => font.family).join(", ")}.
- Media library: the creator's uploads plus everything downloaded from stock or generated — reusable across clips. The harness has described every sound and picture from its actual audio or pixels.
- Stock video/stills: ${stockLine}.
- Freesound (sound effects): ${freesoundConfigured() ? "configured: searched with licence and rating filters, each candidate listened to, only clean recordings placed, credit kept" : "NOT configured (FREESOUND_API_KEY is not set)"}.
- Models (all on OpenRouter, ${openRouter}, unless said otherwise):
  · AI Director (writes the plan, reads notes, answers questions): ${directorModel()} — it watches the clip as video with its audio.
  · Sense / review (describes the clip, every library sound and picture, and scores each render 1–10): ${senseModel()}.
  · Image generation (stills for B-roll, matched to the footage's look and quality-checked; a bad one is retried once or dropped): ${imageModel()}.
  · Video generation (motion clips from a prompt or animating a still; takes minutes, about $0.40–0.50 per 5 s): ${videoModel()}.
  · Music generation (instrumental beds made to order, 15–40 s to make): ${musicModel()}.
  · Sound-effect generation: ${sfxModel()} on fal.ai, about 2¢ an effect — ${on(falConfigured(), "FAL_KEY")}.
- Studio (Create desk): generate stills, motion and music by prompt; results land in the library.
- AI Director panel: Auto (cuts in one pass) or Plan first (proposes lane by lane and asks up to 4 questions, each with 2–4 options and a recommended one already picked; cuts on the answers). The note switches between them: "go ahead", picked answers or a precise request cut straight away; asking for a plan or options proposes first; and in Auto the Director stops to ask when a note leaves a real fork in direction. Settings: B-roll source (Library / Stock / AI / Both), Lay music, Watch the clip, Lock lanes — a note from the creator outranks every one of them. Per pass it generates at most 3 pictures and 1 music bed, and looks up at most 3 sounds on Freesound. It makes a bed to order when B-roll is AI or Both and nothing in the catalogue fits, or whenever a note asks for music made to order (whatever the B-roll setting). Every generated bed, picture and sound stays in the shared library, described, so later passes on any clip can reuse it and the creator can lay it by hand on the Sound desk.
- Taste memory: it learns lessons from the edits the creator makes after a pass, its own review of every render, thumbs up / down, and rules the creator writes; any lesson can be forgotten.`;
}
