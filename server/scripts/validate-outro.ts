import {
  DEFAULT_OUTRO_SEC,
  buildOutroJoinGraph,
  outroJoinEncodeArgs,
  isOutroId,
  isOutroTemplateId,
  isOutroTransitionId,
  joinVideoGraph,
  outroJoinDuration,
  outroNeedsJoin,
  mergeOutroLibraries,
  overlaySharedOutroLibrary,
  pickProjectOutro,
  resolveLibraryDefault,
  resolveTransition,
  sanitizeClipOutro,
  sanitizeProjectOutro,
} from "../src/services/outro.service";

function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

check("lockup is a template", isOutroTemplateId("lockup"));
check("unknown template is rejected", isOutroTemplateId("glitch") === false);
check("smash is a transition", isOutroTransitionId("smash"));
check("unknown transition is rejected", isOutroTransitionId("cube") === false);

const smash = resolveTransition("smash");
check("smash is a hard cut", smash.xfade === "cut" && smash.durationSec === 0);
check("unknown transition falls back to smash", resolveTransition("nope").id === smash.id);
check("iris is not a transition", isOutroTransitionId("iris") === false);
check("punch is a short zoom then dissolve", resolveTransition("punch").durationSec <= 0.32);
check("whip is a horizontal smear", resolveTransition("whip").xfade === "hblur");
check("push is a horizontal cover", resolveTransition("push").xfade === "coverleft");
check("smash join is a concat", joinVideoGraph("smash", 0, 12).includes("concat"));
check(
  "punch zooms the outgoing frame",
  joinVideoGraph("punch", 0.28, 10).includes("eval=frame") &&
    joinVideoGraph("punch", 0.28, 10).includes("xfade=transition=fade") &&
    joinVideoGraph("punch", 0.28, 10).includes("zoomin") === false
);
check("whip join uses a smear", joinVideoGraph("whip", 0.32, 10).includes("hblur"));

check(
  "join duration is clip plus sting",
  Math.abs(outroJoinDuration(12, 2.4, 0.32) - 14.4) < 0.001
);
check("a smash join is the same length", Math.abs(outroJoinDuration(12, 2.4, 0) - 14.4) < 0.001);

const join = buildOutroJoinGraph({ clipSec: 12, outroSec: 2.4, clipHasAudio: true, outroHasAudio: true });
check("export join is a hard concat", join.some((line) => line.includes("concat=n=2:v=1:a=0")));
check("export join does not xfade the sting", join.every((line) => !line.includes("xfade")));
check("export join keeps the encoded talk window", !join[0]!.includes("trim="));
check("export join does not atrim the talk audio", !join.some((line) => line.includes("[0:a]atrim")));
check("export join keeps both audio legs", join.some((line) => line.includes("[a0][a1]concat")));
check("export join does not trim the sting", !join[1]!.includes("trim="));
const encode = outroJoinEncodeArgs(join, 14.4, "out.mp4");
check("export join remuxes, never copies", !encode.includes("copy"));
check("export join maps both legs", encode.includes("[vout]") && encode.includes("[outa]"));
check("export join uses x264", encode.includes("libx264"));
check("join duration never goes negative", outroJoinDuration(0.2, 2.5, 0.4) > 0);

check("no preview means no join", outroNeedsJoin({ enabled: true }, false) === false);
check("explicit skip is a no-op", outroNeedsJoin({ enabled: false }, true) === false);
check("a ready sting joins by default", outroNeedsJoin(undefined, true) === true);
check("enabled true still joins", outroNeedsJoin({ enabled: true, transitionId: "whip" }, true) === true);

const spec = sanitizeProjectOutro({
  templateId: "card",
  durationSec: 9,
  cta: "  Follow for more clips please and thank you forever  ",
  handle: "@StudioName",
  sfxAssetId: "hit",
});
check("duration is clamped to the sting band", spec.durationSec === 3.2);
check("cta is bounded", (spec.cta ?? "").length <= 42);
check("handle drops the at-sign", spec.handle === "StudioName");
check("client cannot mark a sting ready", spec.ready === false);
check("a sting gets an id", isOutroId(spec.id));
check(
  "an explicit pick wins",
  pickProjectOutro(
    [
      { id: "aaaa", ready: false },
      { id: "bbbb", ready: true },
    ],
    "aaaa"
  )?.id === "aaaa"
);
check(
  "the default sting is used when none is named",
  pickProjectOutro(
    [
      { id: "aaaa", ready: true },
      { id: "bbbb", ready: true },
    ],
    undefined,
    "bbbb"
  )?.id === "bbbb"
);
check(
  "shared merge keeps stings from every project",
  mergeOutroLibraries([{ id: "aaaa", ready: true }], [{ id: "bbbb", ready: true }]).map((item) => item.id).join(",") ===
    "aaaa,bbbb"
);
check(
  "shared merge prefers the ready sting",
  mergeOutroLibraries([{ id: "aaaa", ready: false }], [{ id: "aaaa", ready: true }])[0]?.ready === true
);
check(
  "a project can keep its own default from the shared list",
  resolveLibraryDefault(
    [
      { id: "aaaa", ready: true },
      { id: "bbbb", ready: true },
    ],
    "bbbb",
    "aaaa"
  ) === "bbbb"
);
check(
  "a new project sees the shared library",
  overlaySharedOutroLibrary({ outros: [] }, { items: [{ id: "cccc", ready: true }], defaultOutroId: "cccc" }).items[0]
    ?.id === "cccc"
);

const placed = sanitizeProjectOutro({
  mark: { sizeScale: 9, x: -1, y: 2 },
  ctaStyle: {
    fontFamily: "Impact",
    sizeScale: 9,
    textColor: "nope",
    uppercase: true,
    spacing: 99,
    animation: "pop",
    x: 0.1,
    y: 0.2,
  },
  handleStyle: { fontFamily: "Comic Sans", animation: "spin" as never },
});
check("logo size is clamped", placed.mark?.sizeScale === 1.8);
check("logo stays on the frame", placed.mark?.x === 0.04 && placed.mark?.y === 0.96);
check("circle defaults off", sanitizeProjectOutro({}).mark?.circle === false);
check("circle can be on", sanitizeProjectOutro({ mark: { circle: true } }).mark?.circle === true);
check("cta font is a catalog face", placed.ctaStyle?.fontFamily === "Impact");
check("cta size is clamped", placed.ctaStyle?.sizeScale === 2.5);
check("cta colour falls back", placed.ctaStyle?.textColor === "#d4d8de");
check("cta tracking is clamped", placed.ctaStyle?.spacing === 16);
check("cta keeps a free position", placed.ctaStyle?.x === 0.1 && placed.ctaStyle?.y === 0.2);
check("unknown handle font falls back", placed.handleStyle?.fontFamily === "Arial");
check("unknown handle motion falls back", placed.handleStyle?.animation === "fade");

try {
  sanitizeClipOutro({ transitionId: "cube" as never });
  throw new Error("expected unknown transition to throw");
} catch (error: unknown) {
  check("unknown clip transition throws", error instanceof Error && error.message.includes("transition"));
}

check("default sting length is short-form", DEFAULT_OUTRO_SEC >= 2 && DEFAULT_OUTRO_SEC <= 3.6);

console.log("\nall outro checks passed");
