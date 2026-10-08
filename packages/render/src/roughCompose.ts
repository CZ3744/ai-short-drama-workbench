// W7 Phase 1: roughCompose — 草稿模式辅助工具
//
// 把单张首帧静态图(+ 可选 TTS 音频)拉伸为指定时长的静态视频片段。
// 用于草稿合成模式:30 秒拼出整集预览,零真实视频 API 成本。
//
// 失败时 throw toC 友好 Error(铁律 §6:不允许 silent mock fallback)。

import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir } from "../../core/src/index";
import { killProcessTree, registerChildProcess } from "./process";

export interface RoughShotInput {
  /** 静态图绝对路径(.png/.jpg) */
  imagePath: string;
  /** TTS 音频文件路径(可选,不存在 → 静音视频) */
  audioPath?: string;
  /** 视频片段时长(秒) */
  durationSec: number;
  /** 输出绝对路径(.mp4) */
  outputPath: string;
  /** 草稿用低分辨率节省渲染时间 */
  width?: number;
  height?: number;
  /** AbortSignal,中断时 SIGKILL */
  signal?: AbortSignal;
  /** 单镜片段超时;默认 60s */
  timeoutMs?: number;
}

/**
 * 把一张首帧静态图按 duration 拉伸为视频片段,可叠加 TTS 音频。
 * 用于草稿模式,30 秒拼出整集预览。
 *
 * 关键 ffmpeg 参数:
 *  - `-loop 1 -t <duration> -i <image>` 单图循环为 N 秒视频
 *  - `-pix_fmt yuv420p` 保证浏览器播放
 *  - `scale + pad + setsar=1` 统一尺寸,否则 concat 会因 SAR 不一致报错
 *  - `-shortest` 保证音视频时长对齐
 *
 * 失败时抛 Error,信息已 toC 翻译;调用方应在 catch 中决定是否降级 mock。
 */
export async function generateRoughShotSegment(input: RoughShotInput): Promise<void> {
  const {
    imagePath,
    audioPath,
    durationSec,
    outputPath,
    width = 1280,
    height = 720,
    signal,
    timeoutMs = 60_000,
  } = input;

  const resolvedImage = path.resolve(imagePath);
  const resolvedOutput = path.resolve(outputPath);
  await ensureDir(path.dirname(resolvedOutput));

  const duration = Math.max(durationSec, 1);

  const args: string[] = [
    "-y",
    "-loop", "1",
    "-t", duration.toFixed(3),
    "-i", resolvedImage,
  ];

  if (audioPath) {
    args.push("-i", path.resolve(audioPath));
  }

  args.push(
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-pix_fmt", "yuv420p",
    "-r", "24",
  );

  if (audioPath) {
    args.push("-c:a", "aac", "-b:a", "96k", "-shortest");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", resolvedOutput);

  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      // 2026-05-27 audit P0-07: 去 spawn 自带 timeout (违反铁律 #1, Windows SIGTERM 不可靠).
      // signal abort 由下面 killOnAbort 处理. 如真需要 wall-clock 兜底改 setTimeout + SIGKILL.
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿
    void timeoutMs; // 保留参数兼容旧 caller, 现走 signal

    let killOnAbort: (() => void) | null = null;
    if (signal) {
      killOnAbort = () => {
        if (child.pid !== undefined) void killProcessTree(child.pid); // X7-3: tree-kill
      };
      signal.addEventListener("abort", killOnAbort, { once: true });
    }

    let stderr = "";
    const STDERR_LIMIT = 16 * 1024;
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > STDERR_LIMIT) {
        stderr = stderr.slice(stderr.length - STDERR_LIMIT);
      }
    });

    child.on("close", (code) => {
      if (signal && killOnAbort) {
        signal.removeEventListener("abort", killOnAbort);
      }
      if (signal?.aborted) {
        reject(new Error("草稿合成已取消"));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`草稿片段渲染失败 (ffmpeg exit ${code}): ${stderr.slice(-300)}`));
      }
    });

    child.on("error", (err) => {
      if (signal && killOnAbort) {
        signal.removeEventListener("abort", killOnAbort);
      }
      reject(new Error(`ffmpeg 启动失败: ${err.message}`));
    });
  });
}
