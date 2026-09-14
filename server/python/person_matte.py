#!/usr/bin/env python3
"""
Person matte for creator-mode titles that sit BEHIND the speaker.

  stdin  <- JSON job: one raw RGB frame file per span to matte, the geometry,
            the model path, the total frame count, and the output path
  stdout -> JSON {ok, frames, matted}

The output is one raw 8-bit gray frame per source frame of the clip window:
255 where a person is, 0 elsewhere. Frames outside the requested spans are
written black without running the network, so a title that lasts two seconds
costs two seconds of inference, not the whole clip.

RobustVideoMatting (MobileNetV3) is a recurrent network: it carries state
across frames, which is what keeps the edge of the cutout steady instead of
crawling. The state is reset at the start of every span, because a span
boundary is a gap in time.

Kept side-effect free and dumb, like reframe_analyze.py: decoding, encoding,
caching and the decision of WHERE to run all live in matte.service.ts.
"""

import json
import sys


def fail(message):
    json.dump({"ok": False, "error": message}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


def main():
    try:
        job = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        fail(f"bad job json: {exc}")

    try:
        import numpy as np
        import onnxruntime as ort
    except Exception as exc:  # noqa: BLE001
        fail(f"onnxruntime/numpy unavailable: {exc}")

    width = int(job["width"])
    height = int(job["height"])
    total = int(job["totalFrames"])
    out_path = job["outPath"]
    model_path = job.get("modelPath")
    spans = job.get("spans", [])
    if not model_path:
        fail("no matte model path provided; run bun run vision:install")

    try:
        session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    except Exception as exc:  # noqa: BLE001
        fail(f"could not load RVM model at {model_path}: {exc}")

    frame_bytes = width * height * 3
    matted = 0
    try:
        with open(out_path, "wb") as out:
            cursor = 0
            black = np.zeros((height, width), dtype=np.uint8).tobytes()
            for span in sorted(spans, key=lambda s: int(s["startFrame"])):
                start = int(span["startFrame"])
                count = int(span["count"])
                # Black up to the span.
                while cursor < start and cursor < total:
                    out.write(black)
                    cursor += 1
                if cursor >= total:
                    break
                try:
                    frames = np.memmap(span["framesPath"], dtype=np.uint8, mode="r")
                except Exception as exc:  # noqa: BLE001
                    fail(f"cannot read frames for span at {start}: {exc}")
                available = frames.size // frame_bytes
                count = min(count, available, total - cursor)
                frames = frames[: count * frame_bytes].reshape((count, height, width, 3))

                # Fresh recurrent state per span: the previous span is a
                # different moment, and its memory would smear into this one.
                rec = [np.zeros([1, 1, 1, 1], dtype=np.float32)] * 4
                downsample = np.array([1.0], dtype=np.float32)
                for i in range(count):
                    src = frames[i].astype(np.float32) / 255.0
                    src = np.transpose(src, (2, 0, 1))[None]
                    fgr, pha, *rec = session.run(
                        [],
                        {
                            "src": src,
                            "r1i": rec[0],
                            "r2i": rec[1],
                            "r3i": rec[2],
                            "r4i": rec[3],
                            "downsample_ratio": downsample,
                        },
                    )
                    alpha = np.clip(pha[0, 0] * 255.0, 0, 255).astype(np.uint8)
                    out.write(np.ascontiguousarray(alpha).tobytes())
                    cursor += 1
                    matted += 1
            while cursor < total:
                out.write(black)
                cursor += 1
    except Exception as exc:  # noqa: BLE001
        fail(f"matting failed: {exc}")

    json.dump({"ok": True, "frames": total, "matted": matted}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
