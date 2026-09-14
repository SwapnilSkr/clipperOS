#!/usr/bin/env python3
"""
Local face detection + mouth-motion energy for speaker-aware reframing.

This is the ONLY part of the reframer that needs a vision stack. It is kept
deliberately dumb and side-effect free:

  stdin  <- JSON job description (raw gray frame file + geometry + model path)
  stdout -> JSON per-frame face observations with stable track ids

Everything judgemental (audio correlation, smoothing, hysteresis, mode choice,
keyframe emission) lives in reframe.service.ts, so that a GPU active-speaker
provider can replace THIS file alone without touching the decision logic.

Detection uses OpenCV's YuNet DNN detector (cv2.FaceDetectorYN). It replaced a
Haar cascade, which mattered for two concrete reasons:

  1. Haar hallucinated faces on high-contrast clutter — book covers, lighting
     strips — and a confident crop onto furniture is worse than a missed face.
     YuNet's false-positive rate on the same footage is effectively zero, so the
     old plausibility gate and the frontal+profile+mirror-flip juggling are gone.
  2. YuNet returns 5 landmarks per face. We use the two mouth corners to place
     the mouth-energy region on the ACTUAL mouth, instead of guessing "lower
     third of the box" — which drifts onto the neck or beard when the head tilts.

Why raw gray frames instead of cv2.VideoCapture: the TypeScript side already
owns every FFmpeg invocation in this project, and handing over one contiguous
grayscale buffer keeps codec/build variance out of the Python venv. YuNet is a
colour model but detects reliably on luma replicated to three channels (verified
at ~0.92 score on real footage), so the gray pipeline is preserved as-is.

Detection runs at `detect_every`-th frame only (~3fps); mouth-difference energy
is computed on EVERY frame (~12fps) by reusing the last known box + mouth point.
Detection is the expensive part, mouth diffing is nearly free, and syllable-rate
mouth motion needs the finer temporal grid to correlate against audio at all.
"""

import json
import sys

# A new detection is bound to an existing track when its centre is within this
# fraction of the frame width. Podcast subjects are seated, so they move slowly;
# a tight gate is what stops two chairs from swapping identities.
TRACK_GATE = 0.12
# Tracks unseen for this many detection passes are retired.
TRACK_MAX_MISSES = 4
# Mean absolute luma delta over the whole frame above which we call it a cut.
CUT_THRESHOLD = 22.0
# YuNet confidence floor. Below this a detection is discarded before tracking.
SCORE_THRESHOLD = 0.6
NMS_THRESHOLD = 0.3
TOP_K = 50


def fail(message):
    """Never raise: the caller treats a well-formed error as 'degrade to static'."""
    json.dump({"ok": False, "error": message}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


def detect_faces(detector, gray_bgr):
    """Run YuNet on a luma-to-BGR frame.

    Returns a list of (box, mouth) where box is (x, y, w, h) and mouth is the
    (mx, my) midpoint of the two mouth-corner landmarks — both in analysis
    pixels. Empty list when nothing clears the score floor.
    """
    _, faces = detector.detect(gray_bgr)
    if faces is None:
        return []
    out = []
    for f in faces:
        x, y, w, h = float(f[0]), float(f[1]), float(f[2]), float(f[3])
        if w <= 0 or h <= 0:
            continue
        # Landmark layout: [x,y,w,h, rEye, lEye, nose, rMouth, lMouth, score].
        r_mx, r_my, l_mx, l_my = float(f[10]), float(f[11]), float(f[12]), float(f[13])
        mouth = ((r_mx + l_mx) / 2.0, (r_my + l_my) / 2.0)
        out.append(((x, y, w, h), mouth))
    return out


def mouth_region(box, mouth, width, height):
    """A tight window around the mouth landmark for pixel-difference energy.

    Sized from the face box (roughly half its width, a fifth of its height) and
    centred on the mouth midpoint, so a tilted or turned head keeps the region on
    the lips rather than sliding onto the beard or neck the way a fixed
    lower-third slice of the box would.
    """
    _, _, bw, bh = box
    mx, my = mouth
    half_w = max(2.0, bw * 0.26)
    half_h = max(2.0, bh * 0.11)
    mx0 = int(max(0, min(width - 1, mx - half_w)))
    mx1 = int(max(mx0 + 1, min(width, mx + half_w)))
    my0 = int(max(0, min(height - 1, my - half_h)))
    my1 = int(max(my0 + 1, min(height, my + half_h)))
    return mx0, my0, mx1, my1


def main():
    try:
        job = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001 - any malformed input degrades cleanly
        fail(f"bad job json: {exc}")

    try:
        import numpy as np
        import cv2
    except Exception as exc:  # noqa: BLE001
        fail(f"opencv/numpy unavailable: {exc}")

    frames_path = job["framesPath"]
    width = int(job["width"])
    height = int(job["height"])
    detect_every = max(1, int(job.get("detectEvery", 4)))
    model_path = job.get("modelPath")

    if not model_path:
        fail("no face model path provided; run bun run vision:install")

    if not hasattr(cv2, "FaceDetectorYN"):
        fail(f"opencv {cv2.__version__} has no FaceDetectorYN; need 4.5.4<=opencv<5")

    try:
        detector = cv2.FaceDetectorYN.create(
            model_path, "", (width, height), SCORE_THRESHOLD, NMS_THRESHOLD, TOP_K
        )
    except Exception as exc:  # noqa: BLE001
        fail(f"could not load YuNet model at {model_path}: {exc}")

    frame_bytes = width * height
    try:
        buffer = np.memmap(frames_path, dtype=np.uint8, mode="r")
    except Exception as exc:  # noqa: BLE001
        fail(f"cannot read frame buffer: {exc}")

    count = buffer.size // frame_bytes
    if count < 2:
        fail(f"expected >=2 frames in buffer, got {count}")

    frames = buffer[: count * frame_bytes].reshape((count, height, width))

    tracks = []       # {id, box, mouth, misses}
    next_track_id = 0
    previous = None
    # track id -> (box, mouth), carried between detection passes so mouth energy
    # can be measured every frame while detection runs only every detect_every.
    last_seen = {}
    output = []

    for index in range(count):
        frame = frames[index]
        cut = False

        if previous is not None:
            # int16 so the subtraction does not wrap on uint8.
            delta = np.abs(frame.astype(np.int16) - previous)
            cut = float(delta.mean()) > CUT_THRESHOLD
        else:
            delta = None

        if cut:
            # A hard cut invalidates every identity: the same screen position is
            # now a different person (or nobody). Starting clean is what stops a
            # cut from being read as a speaker change with stale mouth energy.
            tracks = []
            last_seen = {}

        if index % detect_every == 0 or cut:
            gray_bgr = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
            detections = detect_faces(detector, gray_bgr)
            gate = TRACK_GATE * width
            for track in tracks:
                track["misses"] += 1
            unclaimed = list(detections)
            for det in list(unclaimed):
                (bx0, by0, bw, bh), mouth = det
                bx = bx0 + bw / 2
                by = by0 + bh / 2
                best, best_distance = None, gate
                for track in tracks:
                    tx = track["box"][0] + track["box"][2] / 2
                    ty = track["box"][1] + track["box"][3] / 2
                    distance = ((bx - tx) ** 2 + (by - ty) ** 2) ** 0.5
                    if distance < best_distance:
                        best, best_distance = track, distance
                if best is not None:
                    # Smooth box and mouth: YuNet boxes are far steadier than
                    # Haar's, but a little EMA still keeps crop motion clean.
                    best["box"] = tuple(
                        0.6 * old + 0.4 * new for old, new in zip(best["box"], det[0])
                    )
                    best["mouth"] = (
                        0.6 * best["mouth"][0] + 0.4 * mouth[0],
                        0.6 * best["mouth"][1] + 0.4 * mouth[1],
                    )
                    # The unsmoothed box too: the smoothed one steadies the
                    # crop, but a camera that follows the head needs the nod
                    # the EMA halves (at 12 fps, 0.4 is a 0.2 s constant).
                    best["raw"] = det[0]
                    best["misses"] = 0
                    unclaimed.remove(det)
            for det in unclaimed:
                (bx0, by0, bw, bh), mouth = det
                tracks.append(
                    {
                        "id": next_track_id,
                        "box": (bx0, by0, bw, bh),
                        "raw": (bx0, by0, bw, bh),
                        "mouth": mouth,
                        "misses": 0,
                    }
                )
                next_track_id += 1
            tracks = [t for t in tracks if t["misses"] <= TRACK_MAX_MISSES]
            last_seen = {t["id"]: (t["box"], t["raw"], t["mouth"]) for t in tracks if t["misses"] == 0}

        faces = []
        for track_id, (box, raw, mouth) in last_seen.items():
            x, y, w, h = (int(round(v)) for v in box)
            rx, ry, rw, rh = (int(round(v)) for v in raw)
            mx0, my0, mx1, my1 = mouth_region(box, mouth, width, height)

            energy = 0.0
            if delta is not None and not cut:
                region = delta[my0:my1, mx0:mx1]
                if region.size:
                    energy = float(region.mean())

            faces.append(
                {
                    "trackId": track_id,
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    # This frame's detection, unsmoothed: the face path.
                    "faceX": rx + rw // 2,
                    "faceY": ry + rh // 2,
                    "faceW": rw,
                    "mouthEnergy": energy,
                }
            )

        output.append({"i": index, "cut": bool(cut), "faces": faces})
        previous = frame.astype(np.int16)

    json.dump({"ok": True, "frameCount": count, "frames": output}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
