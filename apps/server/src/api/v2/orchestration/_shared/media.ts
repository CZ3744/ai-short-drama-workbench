/**
 * Shared media / subtitle low-level utilities (Step 3a batch 0-B).
 *
 * Extracted verbatim from orchestrationController.ts — zero behavior change.
 * Signatures, JSDoc and inline comments are preserved exactly. All symbols
 * are exported (some were module-private in the original file).
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir } from "../../../../../../../packages/core/src/index";
import { killProcessTree, registerChildProcess } from "../../../../../../../packages/render/src/process";

export function formatSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
}

/** SRT 时间戳 "00:01:23,456" → 秒数 */
export function parseSrtTimeToSec(ts: string): number {
  const match = ts.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return 0;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  const ms = parseInt(match[4], 10);
  return h * 3600 + m * 60 + s + ms / 1000;
}

/** 用 ffprobe 探测音频时长 (秒) */
export async function probeAudioDuration(filePath: string): Promise<number | null> {
  try {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
      // P1-NEW: ffprobe 输出通常很小但仍加 cap 保险.
      let stdout = "";
      let stderr = "";
      const LIMIT = 64 * 1024;
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > LIMIT) stdout = stdout.slice(stdout.length - LIMIT);
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > LIMIT) stderr = stderr.slice(stderr.length - LIMIT);
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
    });
    if (result.code !== 0) return null;
    const d = parseFloat(result.stdout.trim());
    return isNaN(d) ? null : d;
  } catch {
    return null;
  }
}

// ─── Python path resolution for edge_tts ──────────────────────────

const PYTHON_CANDIDATES: string[] = process.platform === "win32"
  ? ["python", "python3", "py", "python.exe"]
  : ["python3", "python"];

/**
 * Try each Python candidate with `--version`.
 * Returns the first working executable name, or null if none found.
 */
export async function findPython(): Promise<string | null> {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(candidate, ["--version"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          timeout: 10_000,
        });
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`exit ${code}`));
        });
        child.on("error", reject);
      });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ─── Compose video helpers ──────────────────────────────────────────

/**
 * Generate a mock video (solid dark color) using ffmpeg.
 * Used when no real video generation exists for a shot.
 *
 * 2026-05-27 — 接 aspectRatio. 之前硬编码 1920×1080, 9:16 短剧合成时 mock 占位镜跟其他真镜
 * 画面比例不一致, concat 后被强制缩放 → 视觉错乱. agent audit #35 P2 #10.
 */
export async function generateMockVideo(outputPath: string, durationSec: number, aspectRatio?: string): Promise<void> {
  // 解析 aspectRatio: "9:16" / "16:9" / "1:1" / "9/16" 都支持. 不识别时 fallback 16:9 1920×1080.
  const dim = ((): { w: number; h: number } => {
    if (!aspectRatio) return { w: 1920, h: 1080 };
    const m = aspectRatio.trim().match(/^(\d+)[:/](\d+)$/);
    if (!m) return { w: 1920, h: 1080 };
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (!num || !den) return { w: 1920, h: 1080 };
    if (num >= den) {
      // 横版 e.g. 16:9 → 1920×(9×1920/16)
      return { w: 1920, h: Math.round((den * 1920) / num) };
    }
    // 竖版 e.g. 9:16 → 1080×(16×1080/9)
    return { w: 1080, h: Math.round((den * 1080) / num) };
  })();
  const w = dim.w;
  const h = dim.h;
  const duration = Math.max(durationSec, 1);
  // 4C: resolve to absolute path to handle Unicode/spaces
  const resolvedOutput = path.resolve(outputPath);
  await ensureDir(path.dirname(resolvedOutput));

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y", "-f", "lavfi",
      "-i", `color=c=0x1a1a2e:s=${w}x${h}:d=${duration}:r=30`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      resolvedOutput,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 });
    registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿

    // P1-NEW (2026-05-12): stderr 加 ring buffer 64KB, 跟 process.ts runProcess 行为一致.
    // 之前 ffmpeg 长时间 stderr 会持续累加, 极端情况 Node OOM.
    let stderr = "";
    const STDERR_LIMIT = 64 * 1024;
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(stderr.length - STDERR_LIMIT);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mock video ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    child.on("error", reject);
  });
}

/**
 * Concatenate video files using ffmpeg concat demuxer.
 * @param concatListPath - path to file listing videos (format: "file '<abs_path>'")
 * @param outputPath - destination mp4 path
 * @param signal - 2026-05-27 abort signal. 之前完全失控, full mode hard cut 路径走这条 →
 *                 用户取消合成时这一段 concat 跑完才停 (跟 xfade 路径自带 signal 不对称).
 */
export async function ffmpegConcat(concatListPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  // 4C: resolve to absolute paths to handle Unicode/spaces
  const resolvedConcatList = path.resolve(concatListPath);
  const resolvedOutput = path.resolve(outputPath);
  await ensureDir(path.dirname(resolvedOutput));

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0",
      "-i", resolvedConcatList,
      "-c", "copy",
      resolvedOutput,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 });
    registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿

    const onAbort = () => {
      if (child.pid !== undefined) void killProcessTree(child.pid); // X7-3: tree-kill
      reject(new Error("ffmpegConcat aborted by signal"));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // P1-NEW: stderr ring buffer 64KB
    let stderr = "";
    const STDERR_LIMIT = 64 * 1024;
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(stderr.length - STDERR_LIMIT);
    });
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg concat exited ${code}: ${stderr.slice(-500)}`));
    });
    child.on("error", reject);
  });
}
