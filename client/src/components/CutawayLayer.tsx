import { useEffect, useRef, type CSSProperties } from "react";
import { mediaFileUrl, mediaThumbUrl, type CreatorPlan, type MediaAsset } from "@/api";
import { CUTAWAY_DRIFT, cutawayAt } from "@/lib/creator-timeline";

// ============================================================
// CUTAWAY LAYER — the stock shot over the player, as the burn lays it.
//
// The burn overlays a fitted, drifting stream with an xfade at each edge.
// Here the same asset sits over the crop canvas: object-fit for the fit,
// a CSS transform for the drift, and the transition as opacity, translate,
// clip-path or scale on the same 0→1 curve. Videos are seeked to the same
// media second the burn would show. Wipes, slides and the iris preview
// their shape; pixelize previews as a blurred fade. The exact edge is the
// "Render this span" check.
// ============================================================

export function CutawayLayer({
  plan,
  assets,
  sourceSec,
  playing,
}: {
  plan: CreatorPlan;
  assets: MediaAsset[];
  /** Absolute source seconds of the frame being shown. */
  sourceSec: number;
  playing: boolean;
}) {
  const state = cutawayAt(plan, sourceSec);
  const asset = state ? assets.find((item) => item.id === state.cutaway.assetId) : undefined;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Keep a video asset on the media clock the burn uses.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !state || asset?.kind !== "video") return;
    const want = asset.durationSec ? state.mediaSec % Math.max(0.1, asset.durationSec) : state.mediaSec;
    if (Math.abs(video.currentTime - want) > 0.2 && !video.seeking) video.currentTime = want;
    if (playing && video.paused) void video.play().catch(() => undefined);
    if (!playing && !video.paused) video.pause();
  }, [state, asset, playing]);

  if (!state || !asset) return null;
  const { cutaway, progress, inU, outU } = state;

  // Drift: the same 12% the burn uses, over the whole appearance.
  const drift = CUTAWAY_DRIFT;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  switch (cutaway.motion) {
    case "in":
      scale = 1 + drift * progress;
      break;
    case "out":
      scale = 1 + drift - drift * progress;
      break;
    case "left":
      scale = 1 + drift;
      tx = -(drift * progress) * 100;
      break;
    case "right":
      scale = 1 + drift;
      tx = -(drift * (1 - progress)) * 100;
      break;
    case "up":
      scale = 1 + drift;
      ty = -(drift * progress) * 100;
      break;
    case "down":
      scale = 1 + drift;
      ty = -(drift * (1 - progress)) * 100;
      break;
  }
  // Percentages of the layer's own size; the scale grows from the top-left so
  // a 12% drift covers exactly the extra 12%.
  const media: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: cutaway.fit === "cover" ? "cover" : "contain",
    transformOrigin: "top left",
    transform: `translate(${tx / (1 + drift)}%, ${ty / (1 + drift)}%) scale(${scale})`,
  };

  // The transition: which edge is live, and its 0→1 curve toward "off".
  const inLive = inU < 1;
  const edge = inLive ? cutaway.in : cutaway.out;
  const u = inLive ? 1 - inU : outU; // 1 = fully off, 0 = fully on
  const layer: CSSProperties = { position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" };
  let backdrop: string | undefined;
  switch (edge.transitionId) {
    case "cut":
      break;
    case "dissolve":
      layer.opacity = 1 - u;
      break;
    case "dip_black":
    case "dip_white":
      // First half (u 1→0.5): the main fades to the colour; second half: the media fades up from it.
      backdrop = edge.transitionId === "dip_black" ? "black" : "white";
      break;
    case "slide_left":
      layer.transform = `translateX(${u * 100}%)`;
      break;
    case "slide_right":
      layer.transform = `translateX(${-u * 100}%)`;
      break;
    case "slide_up":
      layer.transform = `translateY(${u * 100}%)`;
      break;
    case "slide_down":
      layer.transform = `translateY(${-u * 100}%)`;
      break;
    case "wipe_right":
      layer.clipPath = `inset(0 ${u * 100}% 0 0)`;
      break;
    case "wipe_left":
      layer.clipPath = `inset(0 0 0 ${u * 100}%)`;
      break;
    case "wipe_down":
      layer.clipPath = `inset(0 0 ${u * 100}% 0)`;
      break;
    case "smooth_left": {
      // A feathered edge: the reveal runs right to left, 20% soft.
      const edgeAt = (1 - u) * 120;
      layer.maskImage = `linear-gradient(to left, black ${edgeAt - 20}%, transparent ${edgeAt}%)`;
      layer.WebkitMaskImage = layer.maskImage;
      break;
    }
    case "circle_open":
      // 71% of the reference radius reaches the corners.
      layer.clipPath = `circle(${(1 - u) * 72}% at 50% 50%)`;
      break;
    case "pixelize":
      // CSS cannot pixelate cheaply: a blur through the fade reads the same at a glance.
      layer.opacity = 1 - u;
      layer.filter = `blur(${(u * 14).toFixed(1)}px)`;
      break;
    case "zoom":
      layer.opacity = 1 - u;
      layer.transform = `scale(${1 - 0.25 * u})`;
      break;
  }
  const backdropOpacity = backdrop ? Math.min(1, (1 - u) * 2) : 0;
  const mediaOpacity = backdrop ? Math.max(0, (0.5 - u) * 2) : 1;

  return (
    <div style={layer} aria-hidden="true">
      {backdrop ? <div style={{ position: "absolute", inset: 0, background: backdrop, opacity: backdropOpacity }} /> : null}
      <div style={{ position: "absolute", inset: 0, opacity: mediaOpacity }}>
        {cutaway.fit === "blur" ? (
          <img
            // A video's blurred fill is its thumbnail: blurred, a still reads the same.
            src={asset.kind === "video" ? mediaThumbUrl(asset.id) : mediaFileUrl(asset.id)}
            alt=""
            style={{ ...media, objectFit: "cover", filter: "blur(24px)", transform: "scale(1.1)", transformOrigin: "center" }}
          />
        ) : null}
        {asset.kind === "image" ? (
          <img src={mediaFileUrl(asset.id)} alt="" style={media} />
        ) : (
          <video ref={videoRef} src={mediaFileUrl(asset.id)} muted playsInline preload="auto" style={media} />
        )}
      </div>
    </div>
  );
}
