import { spawn } from "node:child_process";

export interface RunCommandOptions {
  /** Reject with a truncated stderr tail (default) instead of just the exit code. */
  label?: string;
  /** Called with each stdout line, for progress parsing. */
  onStdout?: (line: string) => void;
  /** Called with each stderr line. yt-dlp writes download progress here. */
  onStderr?: (line: string) => void;
}

/** Run a binary and return its full stdout (used for `yt-dlp -J`, ffprobe -of json). */
export function captureCommand(
  bin: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stderr = "";
    let stdout = "";
    proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.on("error", (error) =>
      reject(new Error(`${options.label ?? bin} could not start: ${error.message}`))
    );
    proc.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${options.label ?? bin} exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

/**
 * Run a binary and resolve on exit code 0. Captures stderr so failures carry a
 * useful tail rather than a bare exit code.
 */
export function runCommand(
  bin: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stderr = "";
    let stdout = "";

    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.onStderr) {
        for (const line of text.split("\n")) if (line.trim()) options.onStderr(line);
      }
    });
    proc.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.onStdout) {
        for (const line of text.split("\n")) if (line.trim()) options.onStdout(line);
      }
    });
    proc.on("error", (error) =>
      reject(new Error(`${options.label ?? bin} could not start: ${error.message}`))
    );
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${options.label ?? bin} exited ${code}: ${stderr.slice(-600) || stdout.slice(-600)}`)
        );
    });
  });
}
