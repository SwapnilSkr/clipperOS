import type { VideoEffects } from "@/api";

export interface ShortFormEditTemplate {
  id: string;
  label: string;
  summary: string;
  techniques: string[];
  captionStyleId: string;
  reframeMode: "center" | "smart";
  captionsOn: boolean;
  effects: Required<VideoEffects>;
}

/**
 * Coherent recipes, not a bag of random effects. Each one maps a familiar
 * short-form grammar to picture, motion, sound, framing and subtitle choices.
 */
export const SHORT_FORM_TEMPLATES: ShortFormEditTemplate[] = [
  {
    id: "clean_podcast",
    label: "Clean podcast",
    summary: "Natural speaker-first cut for interviews and conversations.",
    techniques: ["speaker tracking", "clean captions", "voice clarity"],
    captionStyleId: "clean",
    reframeMode: "smart",
    captionsOn: true,
    effects: { grade: "natural", motion: "none", zoom: 1.04, sharpen: 0.15, vignette: false, audio: "voice" },
  },
  {
    id: "high_energy_hook",
    label: "High-energy hook",
    summary: "Fast visual emphasis for challenges, hot takes and reveals.",
    techniques: ["opening push-in", "bold captions", "vibrant grade", "loudness control"],
    captionStyleId: "creator_hook",
    reframeMode: "smart",
    captionsOn: true,
    effects: { grade: "vibrant", motion: "hook_push", zoom: 1.08, sharpen: 0.45, vignette: false, audio: "loud" },
  },
  {
    id: "storytime_warm",
    label: "Storytime",
    summary: "Warm, conversational treatment that keeps attention on the narrative.",
    techniques: ["warm grade", "readable phrases", "subtle hook motion", "voice clarity"],
    captionStyleId: "storytime",
    reframeMode: "smart",
    captionsOn: true,
    effects: { grade: "warm", motion: "hook_push", zoom: 1.045, sharpen: 0.2, vignette: true, audio: "voice" },
  },
  {
    id: "authority_explainer",
    label: "Authority explainer",
    summary: "Crisp, restrained presentation for facts, business and education.",
    techniques: ["cool clean grade", "lower-third captions", "speaker tracking", "voice clarity"],
    captionStyleId: "newsroom",
    reframeMode: "smart",
    captionsOn: true,
    effects: { grade: "cool", motion: "none", zoom: 1.03, sharpen: 0.5, vignette: false, audio: "voice" },
  },
  {
    id: "reaction_payoff",
    label: "Reaction payoff",
    summary: "Punchy treatment that visually lands the strongest reaction or punchline.",
    techniques: ["peak punch-in", "impact captions", "vibrant grade", "loudness control"],
    captionStyleId: "reaction_pop",
    reframeMode: "smart",
    captionsOn: true,
    effects: { grade: "vibrant", motion: "peak_punch", zoom: 1.09, sharpen: 0.4, vignette: false, audio: "loud" },
  },
  {
    id: "motivational_peak",
    label: "Motivational peak",
    summary: "Builds visual focus around the clip's strongest line.",
    techniques: ["peak punch-in", "payoff emphasis", "warm contrast", "voice clarity"],
    captionStyleId: "peak_heavy",
    reframeMode: "smart",
    captionsOn: true,
    effects: { grade: "warm", motion: "peak_punch", zoom: 1.07, sharpen: 0.35, vignette: true, audio: "voice" },
  },
  {
    id: "cinematic_short",
    label: "Cinematic short",
    summary: "Controlled contrast and subtle edge focus for emotional moments.",
    techniques: ["cinematic grade", "subtle vignette", "minimal captions", "natural audio"],
    captionStyleId: "minimal",
    reframeMode: "smart",
    captionsOn: true,
    effects: { grade: "cinematic", motion: "none", zoom: 1.03, sharpen: 0.2, vignette: true, audio: "natural" },
  },
  {
    id: "karaoke_energy",
    label: "Karaoke energy",
    summary: "Word-by-word rhythm for music, lyrics and highly kinetic delivery.",
    techniques: ["word rhythm", "opening push-in", "vibrant grade", "loudness control"],
    captionStyleId: "karaoke",
    reframeMode: "smart",
    captionsOn: true,
    effects: { grade: "vibrant", motion: "hook_push", zoom: 1.07, sharpen: 0.3, vignette: false, audio: "loud" },
  },
];

export const DEFAULT_VIDEO_EFFECTS: Required<VideoEffects> = {
  grade: "natural",
  motion: "none",
  zoom: 1.06,
  sharpen: 0,
  vignette: false,
  audio: "natural",
};

export function resolveVideoEffects(effects?: VideoEffects): Required<VideoEffects> {
  return { ...DEFAULT_VIDEO_EFFECTS, ...effects };
}
