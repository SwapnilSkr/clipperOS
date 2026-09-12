#!/usr/bin/env python3
"""
Burned-in text / logo / watermark removal by masked inpainting.

Why this exists: the renderer used ffmpeg's `delogo`, which rebuilds a whole
rectangle by interpolating its border pixels inward. On anything larger than a
small logo that leaves visible stripes and a faint ghost of the text — the box
never truly disappears. This pass instead detects the ACTUAL glyph/mark strokes
inside each rect and inpaints only those pixels, so the real background between
and around the letters is left untouched and the fill is sharp, not smeared.

Contract (mirrors reframe_analyze.py — dumb, and errors degrade, never raise):

  stdin  <- JSON job:
    {
      "input":  "/abs/source.mp4",   # the horizontal source
      "output": "/abs/cleaned.mkv",  # video-only, FFV1 lossless
      "ss": 6162.869,                # segment start in the source, seconds
      "duration": 33.921,            # segment length, seconds
      "regions": [                   # rects in SOURCE pixels, times in
        {                            # SEGMENT-relative seconds (0 = ss)
          "x": 120, "y": 880, "w": 300, "h": 90,
          "start": 0.0, "end": 33.921
        }
      ]
    }
  stdout -> {"ok": true, "frames": N, "inpainted": M}
            {"ok": false, "error": "..."}

This is the one image-PROCESSING pass in the project (the analyzer only reads),
so it owns its own cv2 video I/O rather than shuttling multi-GB raw frames
through a pipe. The output is lossless (FFV1) and is re-encoded by the render's
main ffmpeg pass afterwards, so no quality is lost to this intermediate.
"""

import json
import sys

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001 — any import failure means "degrade"
    json.dump({"ok": False, "error": f"cv2/numpy import failed: {exc}"}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)

# Dilate the detected stroke mask by this many pixels before inpainting. The
# fill must swallow the glyph's anti-aliased fringe and any dark outline/shadow,
# or a faint halo survives and the box still "reads" as having had text.
MASK_DILATE = 3
# Telea inpaint radius. Small — we fill thin strokes from their immediate
# neighbours, which is what keeps the result sharp instead of blurry.
INPAINT_RADIUS = 4
# A rect is only inpainted on frames where its mask covers at least this
# fraction of the box; below it there is effectively no text present (a caption
# between words), so we leave the footage untouched.
MIN_COVERAGE = 0.002


def fail(message):
    json.dump({"ok": False, "error": message}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


def build_stroke_mask(patch):
    """Mask of the text/logo strokes inside one rect (uint8, 0 or 255).

    Combines three cues so it survives light OR dark marks on any background:
      - a morphological top-hat isolates bright strokes (white captions),
      - a black-hat isolates dark strokes/outlines,
      - a thresholded gradient catches glyph edges the hats miss.
    The union is cleaned up and dilated to cover the anti-aliased fringe.
    """
    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    # Kernel scaled to the box so thick title text and thin captions both work.
    k = max(3, int(round(min(patch.shape[0], patch.shape[1]) * 0.10)) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))

    tophat = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel)
    blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel)

    # Otsu picks the split between stroke and background per frame, so we don't
    # hard-code a brightness that fails when the set lighting changes.
    _, bright = cv2.threshold(tophat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, dark = cv2.threshold(blackhat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    mag = cv2.normalize(mag, None, 0, 255, cv2.NORM_MINMAX).astype("uint8")
    _, edges = cv2.threshold(mag, 60, 255, cv2.THRESH_BINARY)

    mask = cv2.bitwise_or(cv2.bitwise_or(bright, dark), edges)
    # Close gaps within glyphs, drop lone speckles, then grow to cover fringes.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2)))
    if MASK_DILATE > 0:
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (MASK_DILATE * 2 + 1,) * 2))
    return mask


def main():
    try:
        job = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        fail(f"unparseable job: {exc}")

    src = job.get("input")
    out = job.get("output")
    ss = float(job.get("ss", 0.0))
    duration = float(job.get("duration", 0.0))
    regions = job.get("regions", [])
    if not src or not out:
        fail("input and output are required")
    if not regions or duration <= 0:
        fail("nothing to inpaint")

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        fail(f"could not open source: {src}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if width <= 0 or height <= 0:
        fail("source has no video stream")

    # Seek to the segment start. POS_MSEC lands on the nearest keyframe boundary,
    # which is fine: the render takes AUDIO from the original via ffmpeg -ss, so
    # a sub-frame seek difference here never desyncs the delivered clip.
    cap.set(cv2.CAP_PROP_POS_MSEC, ss * 1000.0)

    writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"FFV1"), fps, (width, height))
    if not writer.isOpened():
        cap.release()
        fail("could not open FFV1 writer (is the venv's opencv built with ffmpeg?)")

    total = int(round(duration * fps))
    # Clamp every rect inside the frame once; masks are computed per frame.
    clamped = []
    for r in regions:
        x = max(0, min(int(r["x"]), width - 2))
        y = max(0, min(int(r["y"]), height - 2))
        w = max(2, min(int(r["w"]), width - x))
        h = max(2, min(int(r["h"]), height - y))
        clamped.append({"x": x, "y": y, "w": w, "h": h,
                        "start": float(r.get("start", 0.0)), "end": float(r.get("end", duration))})

    frames = 0
    inpainted = 0
    for i in range(total):
        ok, frame = cap.read()
        if not ok:
            break
        t = i / fps
        full_mask = None
        for r in clamped:
            if not (r["start"] <= t < r["end"]):
                continue
            x, y, w, h = r["x"], r["y"], r["w"], r["h"]
            patch = frame[y:y + h, x:x + w]
            mask = build_stroke_mask(patch)
            if cv2.countNonZero(mask) < MIN_COVERAGE * w * h:
                continue
            if full_mask is None:
                full_mask = np.zeros((height, width), dtype="uint8")
            full_mask[y:y + h, x:x + w] = cv2.bitwise_or(full_mask[y:y + h, x:x + w], mask)
        if full_mask is not None:
            frame = cv2.inpaint(frame, full_mask, INPAINT_RADIUS, cv2.INPAINT_TELEA)
            inpainted += 1
        writer.write(frame)
        frames += 1

    cap.release()
    writer.release()

    if frames == 0:
        fail("no frames were read from the segment")
    json.dump({"ok": True, "frames": frames, "inpainted": inpainted}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
