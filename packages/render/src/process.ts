import { spawn, execSync, type ChildProcess } from "node:child_process";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

// ── X7-4 (A5-6b, 2026-07-22): 活跃子进程注册表 ──────────────────────────
// 目的: 服务器优雅退出 (SIGINT/SIGTERM/uncaughtException) 时, gracefulShutdown 能一把
// tree-kill 所有还在跑的 ffmpeg/whisper/python 子进程, 否则 Windows 上父进程退出不会自动
// 收子进程 (未建 Job Object) → 孤儿 ffmpeg 继续持有 final.mp4 写句柄 → 用户重启后再合成
// 撞 "文件被占用" 玄学报错。runProcess 自动登记; compose/render 里直接 spawn 的调用点手动
// 调 registerChildProcess(child) 登记 (子进程 exit/close/error 时自动注销, 调用点无需注销)。
const _activeChildren = new Set<ChildProcess>();

/**
 * 登记一个活跃子进程, 使其在 gracefulShutdown 时被 killAllTrackedProcesses 一并树杀。
 * 子进程 exit/close/error 后自动从注册表移除 (登记方无需手动注销)。幂等。
 */
export function registerChildProcess(child: ChildProcess | undefined | null): void {
  if (!child) return;
  _activeChildren.add(child);
  const cleanup = () => { _activeChildren.delete(child); };
  child.once("exit", cleanup);
  child.once("close", cleanup);
  child.once("error", cleanup);
}

/** 当前登记在册的活跃子进程数 (诊断用)。 */
export function activeChildProcessCount(): number {
  return _activeChildren.size;
}

/**
 * tree-kill 所有登记在册的活跃子进程 —— **同步** 执行 (taskkill /T /F 阻塞直到发出),
 * 这样 gracefulShutdown 里紧跟着的 process.exit(0) 不会抢在异步 kill 之前把孤儿留下。
 * 内部逐个 try/catch (进程可能已退出), 不抛。
 */
export function killAllTrackedProcesses(): void {
  for (const child of _activeChildren) {
    if (child.pid === undefined) continue;
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true, timeout: 5000 });
      } else {
        process.kill(child.pid, "SIGKILL");
      }
    } catch {
      // 进程可能已自行退出 — 非错误
    }
  }
  _activeChildren.clear();
}

export interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  /** C7: external abort signal — process will be SIGKILL-ed when triggered */
  signal?: AbortSignal;
}

/**
 * Kill a process tree (parent + all children).
 * On Windows, uses `taskkill /T /F /PID` to ensure the entire tree is terminated.
 * On non-Windows, sends SIGKILL to the process (process group kill is not used
 * because we don't set detached:true to avoid orphaned process groups).
 *
 * X7-3 (A5-6a, 2026-07-22): exported so the ~7 compose/render abort/timeout paths
 * (ffmpegBuilder / tts / realignSubtitles / _shared media / bgmMixer / roughCompose /
 * multiTrackSubtitles) reuse this single tree-kill impl instead of the weaker
 * `child.kill("SIGKILL")` (which on Windows only kills the direct PID, leaving any
 * ffmpeg-forked helper as an orphan holding the output-file lock). 解耦信仰: 一份实现。
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, timeout: 5000 });
    } catch {
      // taskkill may fail if process already exited — not an error
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // process may already be gone
    }
  }
}

// A-3 (2026-05-12): CLAUDE.md 红线"所有 spawn 必带 timeout". 之前 timeoutMs 是 opt-in,
// 任何调用方忘了传就裸跑. 现在改为强制 5 分钟默认值; 调用方仍可显式传 timeoutMs 覆盖.
// 传 0 表示完全禁用 (极少数测试场景用), 传 undefined 走默认.
const RUN_PROCESS_DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function runProcess(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options?.cwd,
        windowsHide: true,
        shell: false,
      });
    } catch (err: any) {
      resolve({ code: 1, stdout: "", stderr: `spawn ENOENT: ${command} not found (${err?.message || String(err)})` });
      return;
    }

    // v0.2.4: bound the in-memory buffer per stream. ffmpeg can emit hundreds
    // of MB of progress text on long renders; without a cap, the Node process
    // can OOM when several clips render in sequence. We keep the most recent
    // 64 KB which is what gets surfaced to the UI anyway.
    const DEFAULT_MAX_BUF = 64 * 1024;
    const stdoutLimit = Math.max(1, options?.stdoutLimitBytes ?? DEFAULT_MAX_BUF);
    const stderrLimit = Math.max(1, options?.stderrLimitBytes ?? DEFAULT_MAX_BUF);
    let stdout = "";
    let stderr = "";
    const appendBounded = (cur: string, chunk: string, limit: number) => {
      const next = cur + chunk;
      return next.length > limit ? next.slice(next.length - limit) : next;
    };
    let killed = false;

    // Handle spawn failures where child.pid is undefined (e.g. ENOENT).
    if (!child.pid) {
      const errMsg = "Failed to spawn process (no pid assigned — binary missing?)";
      resolve({ code: 1, stdout: "", stderr: errMsg });
      return;
    }

    // X7-4: 登记到活跃子进程注册表 (exit/close/error 自动注销), 便于 gracefulShutdown 树杀。
    registerChildProcess(child);

    // A-3: 默认 5 分钟; options.timeoutMs === 0 才完全禁用
    const effectiveTimeoutMs = options?.timeoutMs === 0
      ? 0
      : (options?.timeoutMs ?? RUN_PROCESS_DEFAULT_TIMEOUT_MS);
    const timer = effectiveTimeoutMs > 0 ? setTimeout(async () => {
      killed = true;
      try {
        await killProcessTree(child.pid!);
      } catch {}
      stderr = appendBounded(stderr, `\n[timeout] Process killed after ${effectiveTimeoutMs}ms (command=${command}, pid=${child.pid})`, stderrLimit);
    }, effectiveTimeoutMs) : null;

    // C7: external AbortSignal — SIGKILL the child when signalled (on Windows SIGTERM is unreliable)
    if (options?.signal) {
      const abortHandler = async () => {
        killed = true;
        if (timer) clearTimeout(timer);
        try {
          await killProcessTree(child.pid!);
        } catch {}
        stderr = appendBounded(stderr, `\n[aborted] Process killed via AbortSignal (command=${command}, pid=${child.pid})`, stderrLimit);
      };
      if (options.signal.aborted) {
        // Already aborted — kill immediately
        void abortHandler();
      } else {
        options.signal.addEventListener("abort", () => { void abortHandler(); }, { once: true });
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk.toString(), stdoutLimit);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk.toString(), stderrLimit);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: killed ? 1 : (code ?? 1), stdout, stderr });
    });
  });
}

export function runFfmpegWorker(args: string[], options?: ProcessOptions): Promise<ProcessResult> {
  return runProcess("ffmpeg", args, {
    ...options,
    timeoutMs: options?.timeoutMs ?? 300_000,
    stdoutLimitBytes: options?.stdoutLimitBytes ?? 64 * 1024,
    stderrLimitBytes: options?.stderrLimitBytes ?? 64 * 1024,
  });
}
