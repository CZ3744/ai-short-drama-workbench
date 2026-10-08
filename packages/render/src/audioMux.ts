// audioMux.ts — 2026-05-22 P0
// audio_mode="tts" 专用: 把每镜 TTS 合成语音按整集时间轴拼成一条音轨, 替换视频原声。
//
// 背景 (用户原话): "我说用视频原声不等于不烧录字幕" — 上一波只做了 audio_mode 的 UI 开关,
// 后端 compose 链路完全没接通。事实上 full 模式一直用 ffmpegConcat -c copy 保留视频原声,
// audio_mode="tts" 从来没真正实现过 (TTS mp3 只喂 Whisper 做字幕对齐, 从未 mux 进成片)。
//
// 本模块就是补上 audio_mode="tts" 缺失的真实路径:
//   1. 每镜 TTS mp3 用 adelay 放到它在整集时间轴上的起始位置 (startMs)。
//   2. 全部 adelay 后的片段 amix 成一条整集音轨。
//   3. 用 `-map 0:v:0 -map [aout]` 把整集音轨替换掉视频自带音轨。
//
// 不阻塞合成: 无 TTS 片段 / ffmpeg 失败 → 返回 { ok:false, reason }, 调用方继续用视频原声。
// 铁律 #1: 不设本地 AbortSignal.timeout, 只透传 caller 的 signal (本地 spawn 子进程死锁
//          兜底交给 caller 主动中止)。

import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { probeVideoFile } from "./ffprobe";
import { killProcessTree } from "./process";

export interface TtsAudioSegment {
  /** 镜头 ID, 仅日志用 */
  shotId: string;
  /** 该镜 TTS 音频文件绝对路径 (.mp3) */
  absPath: string;
  /** 该镜在整集时间轴上的起始毫秒 */
  startMs: number;
}

export interface MuxTtsOptions {
  /** 已拼接的视频 (含视频原声), 通常是 compose 的 source.mp4 */
  input_mp4: string;
  /** 输出 mp4 (TTS 音轨替换后) */
  output_mp4: string;
  /** 每镜 TTS 音频片段 + 整集起始毫秒 */
  segments: TtsAudioSegment[];
  /** 中止信号 (透传 compose 的 deps.signal, 不本地造) */
  signal?: AbortSignal;
}

export interface MuxTtsResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  output_mp4?: string;
  /** 实际 mux 进音轨的片段数 */
  segment_count?: number;
}

/** 用 ffprobe 探测文件是否含音频流 (片段文件可能 0 字节或损坏)。 */
async function hasAudioStream(filePath: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
      "-of", "csv=p=0", filePath,
    ], { windowsHide: true });
    if (signal) {
      const onAbort = () => { if (child.pid !== undefined) void killProcessTree(child.pid); }; // XT-T2: tree-kill
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); if (out.length > 4096) out = out.slice(-4096); });
    child.on("close", () => resolve(out.trim().toLowerCase().includes("audio")));
    child.on("error", () => resolve(false));
  });
}

/**
 * 主函数: 把每镜 TTS 片段按时间轴拼成整集音轨并替换视频原声。
 *
 * filter_complex 形如 (N 个片段):
 *   [1:a]adelay=0|0[a0];[2:a]adelay=4500|4500[a1];...
 *   [a0][a1]...[aN-1]amix=inputs=N:duration=longest:dropout_transition=0[aout]
 * 然后 -map 0:v:0 -map [aout] 替换音轨。
 *
 * @returns ok=true 表示输出了新 mp4; skipped=true 表示无可用片段未改 (调用方继续用视频原声)。
 */
export async function muxTtsAudio(opts: MuxTtsOptions): Promise<MuxTtsResult> {
  const { input_mp4, output_mp4, segments, signal } = opts;

  // 0. 校验输入视频存在
  try {
    await fs.access(input_mp4);
  } catch {
    return { ok: false, skipped: true, reason: "input_mp4_not_found" };
  }

  // 1. 过滤出真实存在 + 含音频流的片段
  const usable: TtsAudioSegment[] = [];
  for (const seg of segments) {
    try {
      await fs.access(seg.absPath);
    } catch {
      continue; // 文件不存在 → 跳过这镜 (该镜没 TTS, 时间轴上是静音)
    }
    if (await hasAudioStream(seg.absPath, signal)) {
      usable.push(seg);
    }
  }

  if (usable.length === 0) {
    // 整集没有任何 TTS 音频 → 不替换, 让调用方保留视频原声
    return { ok: false, skipped: true, reason: "no_tts_audio_segments" };
  }

  // 2. 拼 ffmpeg 命令: input 0 = 视频, input 1..N = 各 TTS 片段
  const args: string[] = ["-y", "-i", input_mp4];
  for (const seg of usable) {
    args.push("-i", path.resolve(seg.absPath));
  }

  // 2.5 X2-1 (A2-1+A2-2 根因同治): 探视频真长 V, 把 TTS 整轨补/裁到恰好 V。
  //   背景: 下方 amix=duration=longest 只把各 TTS 片段混成一条轨, 长度 A=max(startMs+片段长), 与视频长无关。
  //   TTS 常比视频短 → source_tts.mp4 音轨 A<V。下游 bgmMixer 的 amix=duration=first + -shortest, 以及
  //   多规格导出 buildMp4Args 的 -shortest 都取 min(V,A)=A → 成片尾被无声裁掉 (实测 10s 视频截成 4s)。
  //   修法: filter 链末端 apad(补静音)+atrim=end=V(裁超出) 把整轨锚定到视频真长 → 所有下游 -shortest 变
  //   min(V,V)=V 不再截。input_mp4 = ffmpegConcat -c copy 产物 (全长 V, 经 xfade 后的真实成片长),
  //   ffprobe 它取真长最可靠 (不信 shot.duration_sec 累加, 铁律 #4)。
  //   probe 失败 (V<=0) → 退回原行为 (仅 amix 不 pad), 显式 warn, 不阻塞合成 (铁律 #1: 不本地 timeout, 只透传 signal)。
  let videoDurSec = 0;
  try {
    const probe = await probeVideoFile(input_mp4, signal);
    if (probe.duration_sec > 0) videoDurSec = probe.duration_sec;
  } catch {
    // probe 失败 → videoDurSec 保持 0, 下方统一 warn + 退回原行为 (不阻塞合成)
  }
  if (videoDurSec <= 0) {
    console.warn(
      `[audioMux] 未能 ffprobe 取到视频真长 (input=${input_mp4}) — TTS 整轨不 apad 补齐到视频长, 退回原行为 (下游 -shortest 可能把成片截到音轨长)。`,
    );
  }

  // 3. filter_complex: 每个 TTS 片段 adelay 到 startMs (双声道都 delay), 再 amix
  const delayParts: string[] = [];
  const mixLabels: string[] = [];
  for (let i = 0; i < usable.length; i++) {
    const seg = usable[i];
    const inputIdx = i + 1; // input 0 是视频
    const delayMs = Math.max(0, Math.round(seg.startMs));
    const label = `d${i}`;
    // adelay 的 delays 参数对每个声道各写一次, "all=1" 兼容性更好但旧 ffmpeg 不支持, 用 "ms|ms"
    delayParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs}[${label}]`);
    mixLabels.push(`[${label}]`);
  }
  // amix duration=longest 保证整条音轨不被最短片段截断; dropout_transition=0 避免片段间淡出造成音量起伏。
  // X2-1: V>0 时把 amix 结果再过 apad,atrim=end=V 补/裁到视频真长 (音轨==视频); V<=0 退回原行为 (amix 直接出 [aout])。
  const amixLabel = videoDurSec > 0 ? "amixed" : "aout";
  let filterComplex =
    delayParts.join(";") +
    ";" +
    mixLabels.join("") +
    `amix=inputs=${usable.length}:duration=longest:dropout_transition=0:normalize=0[${amixLabel}]`;
  if (videoDurSec > 0) {
    // apad 无参数 = 无限补静音, atrim=end=V 裁到恰好 V 秒 → 音轨长度锚定视频真长 V (atrim 下游 EOF 会让 apad 停止, 不会无限编码)。
    filterComplex += `;[amixed]apad,atrim=end=${videoDurSec.toFixed(3)}[aout]`;
  }

  args.push(
    "-filter_complex", filterComplex,
    "-map", "0:v:0",       // 视频流原样拷贝
    "-map", "[aout]",      // 音轨用拼好的 TTS 整集音轨 (V>0 已 apad/atrim 到视频真长)
    "-c:v", "copy",        // 视频流不重编, 快
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    path.resolve(output_mp4),
  );

  // 4. 跑 ffmpeg — 铁律 #1: 不加本地 timeout, 只透传 signal
  return new Promise<MuxTtsResult>((resolve) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    if (signal) {
      const onAbort = () => { if (child.pid !== undefined) void killProcessTree(child.pid); }; // XT-T2: tree-kill
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(stderr.length - 64 * 1024);
    });
    child.on("close", (code) => {
      if (signal?.aborted) {
        resolve({ ok: false, skipped: true, reason: "aborted" });
        return;
      }
      if (code === 0) {
        resolve({ ok: true, output_mp4, segment_count: usable.length });
      } else {
        resolve({
          ok: false,
          skipped: true,
          reason: `ffmpeg_mux_failed:code=${code}:${stderr.slice(-300)}`,
        });
      }
    });
    child.on("error", (err) => {
      resolve({ ok: false, skipped: true, reason: `ffmpeg_spawn_failed:${err.message}` });
    });
  });
}
