import { mkdir, stat, unlink, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { config } from "../config";
import { isNodeError } from "../types";

/** True when `candidate` resolves to `dir` itself or something beneath it. */
export function isContained(dir: string, candidate: string): boolean {
  const root = resolve(dir);
  const resolved = resolve(root, candidate);
  return resolved === root || resolved.startsWith(root + sep);
}

/**
 * Resolve `name` inside `dir`, refusing anything that escapes it.
 *
 * `join` normalises `..`, so joining an untrusted id onto a storage directory
 * can walk out of it. This is the belt to the request guard's braces: even if a
 * path ever reaches here unvalidated, it cannot leave the storage root.
 */
export function containedPath(dir: string, name: string): string {
  const resolved = resolve(dir, name);
  if (!isContained(dir, resolved)) throw new Error("Invalid file reference");
  return resolved;
}

export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code !== "EEXIST") throw error;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getFileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

export async function deleteFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code !== "ENOENT") throw error;
  }
}

/** Best-effort delete of local scratch files. URLs and missing files are skipped. */
export async function cleanupFiles(filePaths: (string | undefined)[]): Promise<void> {
  await Promise.all(
    filePaths
      .filter((p): p is string => typeof p === "string" && p.length > 0 && !p.startsWith("http"))
      .map((p) => deleteFile(p).catch(() => undefined))
  );
}

export async function listFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

export function generateFilename(prefix: string, extension: string): string {
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${Date.now()}_${random}.${extension}`;
}

export function getExtension(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? (parts.pop() as string).toLowerCase() : "";
}

/** Create every storage directory this app writes to. */
export async function initializeStorage(): Promise<void> {
  await Promise.all([
    ensureDir(config.processingPath),
    ensureDir(config.uploadsPath),
    ensureDir(config.outputPath),
    ensureDir(config.mediaPath),
  ]);
}

/** Directory that holds rendered output for one project. */
export function projectOutputDir(projectId: string): string {
  return join(config.outputPath, projectId);
}

/** Directory that holds fetched source media for one project. */
export function projectMediaDir(projectId: string): string {
  return join(config.mediaPath, projectId);
}
