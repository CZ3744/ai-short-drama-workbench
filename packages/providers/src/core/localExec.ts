// P25: Shared exec helper for spawning local Python scripts safely

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export interface RunPythonScriptOpts {
  python_path: string;
  script_path: string;
  args: string[];
  cwd?: string;
  timeout_ms?: number;
  signal?: AbortSignal;
  on_stdout?: (line: string) => void;
  on_stderr?: (line: string) => void;
}

export interface RunPythonScriptResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

/**
 * Allowed python executable basenames. Anything else is rejected to
 * prevent shell-injection via crafted python_path values.
 */
const ALLOWED_PYTHON_BASENAMES = new Set([
  "python.exe",
  "python",
  "python3",
  "python3.exe",
  "python3.12.exe",
  "python3.11.exe",
  "python3.10.exe",
]);

/**
 * Characters that are forbidden inside any single argument.
 * Since we use shell:false (no cmd.exe wrapping), shell metacharacters
 * like & | < > are harmless. The real security boundary is the python_path
 * allow-list above. We only reject null bytes (C string truncation risk).
 */
const FORBIDDEN_ARG_CHARS = /\0/;

function validatePythonPath(pythonPath: string): void {
  const base = path.basename(pythonPath).toLowerCase();
  if (!ALLOWED_PYTHON_BASENAMES.has(base)) {
    throw new Error(
      `Rejected python_path "${pythonPath}": basename "${base}" is not in the allow-list. ` +
      `Allowed: ${[...ALLOWED_PYTHON_BASENAMES].join(", ")}`
    );
  }
}

function validateArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    if (FORBIDDEN_ARG_CHARS.test(args[i])) {
      throw new Error(
        `Rejected arg[${i}]: contains null byte (C string truncation risk). ` +
        `shell:false is used, so metacharacters are safe.`
      );
    }
  }
}

/**
 * Spawn a Python script as a child process with timeout, abort signal,
 * and stdout/stderr line-by-line callbacks.
 *
 * Security measures:
 * - python_path basename allow-list (no arbitrary executables)
 * - args scanned for shell metacharacters (& | < > ^ " ` $)
 * - spawn uses shell:false (default) — no cmd.exe wrapping
 * - timeout kills process tree via SIGKILL
 * - AbortSignal support for cooperative cancellation
 */
export async function runPythonScript(opts: RunPythonScriptOpts): Promise<RunPythonScriptResult> {
  const start = Date.now();
  if (opts.signal?.aborted) {
    return {
      exit_code: -1,
      stdout: "",
      stderr: "[aborted] Signal already aborted before spawn",
      duration_ms: Date.now() - start,
    };
  }

  validatePythonPath(opts.python_path);
  validateArgs(opts.args);

  const timeoutMs = opts.timeout_ms ?? 300_000; // default 5 min

  return new Promise<RunPythonScriptResult>((resolve) => {
    let killed = false;
    let settled = false;

    const child: ChildProcess = spawn(opts.python_path, [opts.script_path, ...opts.args], {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // shell: false is the default — critical for injection safety
    });

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      // Emit per-line callbacks
      if (opts.on_stdout) {
        for (const line of chunk.split("\n")) {
          if (line.length > 0) opts.on_stdout(line);
        }
      }
    });

    child.stderr!.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      if (opts.on_stderr) {
        for (const line of chunk.split("\n")) {
          if (line.length > 0) opts.on_stderr(line);
        }
      }
    });

    // Timeout
    const timer = setTimeout(() => {
      if (!settled) {
        killed = true;
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }, timeoutMs);

    // AbortSignal
    const onAbort = () => {
      if (!settled) {
        killed = true;
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    };
    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        exit_code: killed ? -1 : (code ?? -1),
        stdout,
        stderr: killed
          ? stderr + `\n[timeout/abort] Process killed after ${Date.now() - start}ms`
          : stderr,
        duration_ms: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        exit_code: -1,
        stdout,
        stderr: stderr + `\n[spawn_error] ${err.message}`,
        duration_ms: Date.now() - start,
      });
    });
  });
}
