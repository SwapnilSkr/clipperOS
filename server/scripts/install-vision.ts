#!/usr/bin/env bun
/**
 * Prepare the local vision stack: OpenCV in a project-local venv, plus the YuNet
 * face model.
 *
 * Two features need this and nothing else does, so it is opt-in rather than a
 * prerequisite:
 *
 *   • speaker-aware reframing  (python/reframe_analyze.py)
 *   • burned-in text / watermark removal  (python/cleanup_inpaint.py)
 *   • the person matte behind creator-mode titles  (python/person_matte.py)
 *
 * All degrade to a non-vision path when this has not been run — a centre crop,
 * ffmpeg's `delogo`, a title drawn in front — so a missing venv costs quality,
 * never a render.
 *
 * OpenCV is a Python wheel, so a project-local venv is both possible and
 * preferable to a system install: it leaves the host Python alone and pins one
 * interpreter for dev and production. The detector is YuNet
 * (cv2.FaceDetectorYN), a ~230 KB ONNX model that is NOT bundled in the wheel,
 * so it is fetched once next to the venv.
 *
 * Everything lands under storage/vision/, which is gitignored runtime storage.
 */
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const venvDir = resolve(process.env.VISION_VENV_DIR || "./storage/vision/venv");
const pythonPath = resolve(process.env.VISION_PYTHON_PATH || join(venvDir, "bin", "python3"));
const reframeScript = resolve(
  process.env.VISION_SCRIPT_PATH || "./python/reframe_analyze.py"
);
const cleanupScript = resolve(
  process.env.VISION_CLEANUP_SCRIPT_PATH || "./python/cleanup_inpaint.py"
);
const modelPath = resolve(
  process.env.VISION_FACE_MODEL_PATH ||
    "./storage/vision/models/face_detection_yunet_2023mar.onnx"
);
const matteModelPath = resolve(
  process.env.VISION_MATTE_MODEL_PATH || "./storage/vision/models/rvm_mobilenetv3_fp32.onnx"
);
// RobustVideoMatting, MobileNetV3 backbone. A recurrent matting network, so
// the mask is temporally stable rather than flickering frame to frame; the
// ONNX export runs on onnxruntime's CPU provider at ~15 ms per 512-wide frame.
const MATTE_MODEL_URL =
  "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx";

// Raw path in the OpenCV Zoo. The 2023mar revision is the stable YuNet and is
// what the score/NMS thresholds in reframe_analyze.py were tuned against.
const MODEL_URL =
  "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx";

// This script installs DEPENDENCIES, not the scripts themselves — so it can only
// run from the server directory.
for (const scriptPath of [reframeScript, cleanupScript]) {
  try {
    await access(scriptPath);
  } catch {
    console.error(
      `Missing ${scriptPath}. This script installs its dependencies, not the script itself.\n` +
        `Run it from the server directory: cd server && bun run vision:install`
    );
    process.exit(1);
  }
}

/**
 * Bun.spawnSync THROWS ENOENT for a missing executable rather than returning a
 * non-zero code, and "not installed yet" is the expected state here.
 */
function probe(command: string[]): { exitCode: number; stdout: string } {
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout.toString() };
  } catch {
    return { exitCode: 127, stdout: "" };
  }
}

const hostPython = process.env.VISION_HOST_PYTHON || "python3";
if (probe([hostPython, "--version"]).exitCode !== 0) {
  console.error(`Missing ${hostPython}. On macOS, install it once with:\n\n  brew install python@3.12\n`);
  process.exit(1);
}

/**
 * Import alone is not proof of usability: the DNN detector we use
 * (FaceDetectorYN) only landed in OpenCV 4.5.4, so assert the symbol exists
 * rather than merely that cv2 imports.
 */
const READINESS_CHECK = [
  "import cv2, numpy",
  "assert hasattr(cv2, 'FaceDetectorYN'), 'this opencv build has no FaceDetectorYN (need >=4.5.4)'",
  "print(cv2.__version__)",
].join("; ");

async function ensureModel(): Promise<void> {
  try {
    await access(modelPath);
    return;
  } catch {
    // Not downloaded yet.
  }
  await mkdir(dirname(modelPath), { recursive: true });
  console.log(`Downloading YuNet face model (~230 KB)…\n  ${MODEL_URL}`);
  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error(`YuNet download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A truncated file or an HTML error page would "download" fine and then fail to
  // load; the real model is ~230 KB, so anything tiny is a redirect or error body.
  if (bytes.byteLength < 50_000) {
    throw new Error(`YuNet download looks wrong (${bytes.byteLength} bytes); expected ~230 KB.`);
  }
  await Bun.write(modelPath, bytes);
  console.log(`✓ Model saved to ${modelPath}`);
}

/** Confirms the wheel can actually construct a YuNet detector from the model. */
function verifyModelLoads(): { exitCode: number; stdout: string } {
  return probe([
    pythonPath,
    "-c",
    [
      "import cv2",
      `d = cv2.FaceDetectorYN.create(${JSON.stringify(modelPath)}, '', (320, 320))`,
      "print('yunet-ok')",
    ].join("; "),
  ]);
}

/**
 * The matte stack is best-effort on top of OpenCV: onnxruntime plus the RVM
 * model. A failure here leaves titles rendering in front of the speaker and
 * says so, rather than failing the whole install.
 */
async function ensureMatteStack(): Promise<void> {
  const ready = () =>
    probe([
      pythonPath,
      "-c",
      [
        "import onnxruntime as ort",
        `s = ort.InferenceSession(${JSON.stringify(matteModelPath)}, providers=['CPUExecutionProvider'])`,
        "print('rvm-ok', ort.__version__)",
      ].join("; "),
    ]);
  try {
    if (probe([pythonPath, "-c", "import onnxruntime"]).exitCode !== 0) {
      console.log("Installing onnxruntime for the person matte (~15 MB; one-time)…");
      const install = Bun.spawnSync(
        [pythonPath, "-m", "pip", "install", "--disable-pip-version-check", "onnxruntime>=1.20"],
        { stdout: "inherit", stderr: "inherit" }
      );
      if (install.exitCode !== 0) throw new Error(`pip install onnxruntime failed (exit ${install.exitCode})`);
    }
    try {
      await access(matteModelPath);
    } catch {
      await mkdir(dirname(matteModelPath), { recursive: true });
      console.log(`Downloading RobustVideoMatting model (~15 MB)…\n  ${MATTE_MODEL_URL}`);
      const response = await fetch(MATTE_MODEL_URL);
      if (!response.ok) throw new Error(`RVM download failed: HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 5_000_000) {
        throw new Error(`RVM download looks wrong (${bytes.byteLength} bytes); expected ~15 MB.`);
      }
      await Bun.write(matteModelPath, bytes);
      console.log(`✓ Matte model saved to ${matteModelPath}`);
    }
    const check = ready();
    if (check.exitCode !== 0 || !check.stdout.includes("rvm-ok")) {
      throw new Error("onnxruntime is installed but could not load the RVM model");
    }
    console.log(`✓ Person matte ready (onnxruntime ${check.stdout.trim().split(" ").pop()})`);
  } catch (error) {
    console.warn(
      `⚠️  Person matte unavailable: ${error instanceof Error ? error.message : String(error)}\n` +
        `   Creator-mode titles will render in front of the speaker. Re-run vision:install to retry.`
    );
  }
}

const opencvReady = probe([pythonPath, "-c", READINESS_CHECK]);
if (opencvReady.exitCode === 0) {
  await ensureModel();
  const modelReady = verifyModelLoads();
  if (modelReady.exitCode === 0 && modelReady.stdout.includes("yunet-ok")) {
    console.log(`✓ OpenCV ${opencvReady.stdout.trim()} + YuNet ready\n  ${pythonPath}`);
    await ensureMatteStack();
    process.exit(0);
  }
  console.error("OpenCV is present but the YuNet model failed to load. Check the model file and re-run.");
  process.exit(1);
}

await mkdir(dirname(venvDir), { recursive: true });
console.log("Creating vision venv and installing OpenCV (~40 MB; one-time)…");

const createVenv = Bun.spawnSync([hostPython, "-m", "venv", venvDir], {
  stdout: "inherit",
  stderr: "inherit",
});
if (createVenv.exitCode !== 0) {
  throw new Error(
    `venv creation failed (exit ${createVenv.exitCode}). Ensure ${hostPython} ships the venv module.`
  );
}

// headless: nothing here ever opens a window, and the GUI wheel drags in Qt.
// Pinned below 5 for reproducibility: FaceDetectorYN exists in OpenCV 5 too, but
// 4.x is the line these thresholds were tuned on.
const install = Bun.spawnSync(
  [
    pythonPath,
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "opencv-python-headless>=4.9,<5",
    "numpy>=1.24",
  ],
  { stdout: "inherit", stderr: "inherit" }
);
if (install.exitCode !== 0) {
  throw new Error(`pip install failed (exit ${install.exitCode}). Re-run this command to retry.`);
}

const verifyOpencv = probe([pythonPath, "-c", READINESS_CHECK]);
if (verifyOpencv.exitCode !== 0) {
  throw new Error("OpenCV installed but FaceDetectorYN is missing; refusing to report success.");
}

await ensureModel();
const verifyModel = verifyModelLoads();
if (verifyModel.exitCode !== 0 || !verifyModel.stdout.includes("yunet-ok")) {
  throw new Error("OpenCV installed but the YuNet model could not be loaded; refusing to report success.");
}

await ensureMatteStack();

console.log(
  `✓ Installed OpenCV ${verifyOpencv.stdout.trim()} + YuNet at\n  ${pythonPath}\n\n` +
    `Add this to .env, then restart bun dev:\n  VISION_REFRAME_ENABLED=true`
);
