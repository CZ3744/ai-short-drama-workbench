// bgmMixer.ts — 2026-05-19 P1 + P3
// 给已合成的 mp4 (已有 TTS 对白音轨) 叠加 BGM + 做音量归一化.
//
// 工作流:
//   1. 找 BGM 文件 (`data/bgm-library/<mood>.mp3` 等). 没找到 → 不混 BGM (仍可做 loudnorm).
//   2. ffmpeg sidechain ducking: 有对白时 BGM 自动让位, 无对白时 BGM 满音量.
//   3. 整段过 loudnorm 滤镜归一化到 -16 LUFS (业内 OTT 标准).
//   4. 输出 mp4 替换原文件.
//
// 不阻塞合成: 任何失败都返回 { skipped: true, reason }, composeEpisode 继续用原 mp4.
// 这是用户 UX 决策 — BGM 是锦上添花, 不能因 BGM 找不到导致整集合成失败.
//
// 2026-05-29 P0-1 (silent skip 红线): "找不到 BGM 文件"以前在 loudnorm 开着时被完全吞掉
// (ok=true, bgm_file=null, 无 reason) → 前端 0 提示. 现在无论 loudnorm 是否继续, 只要"请求了
// BGM 但没用上", 都把缺失原因写进 bgm_requested_mood / bgm_missing_reason 字段, render.ts 据此
// 落 manifest + SSE 透前端 banner —— 绝不再"悄悄没 BGM".

import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { killProcessTree, registerChildProcess } from "./process";

export interface MixBgmOptions {
  /** 已合成 mp4 (含对白 audio) */
  input_mp4: string;
  /** 输出 mp4 (混音后) */
  output_mp4: string;
  /** BGM mood, e.g. "温馨" / "紧张" / "舒缓". 留空 = 跳过. */
  bgm_mood?: string;
  /** BGM 相对响度 0.0-1.0, 默认 0.35 (跟人声 ducking 后留住氛围) */
  bgm_volume?: number;
  /** BGM 库根目录, 默认 data/bgm-library/ */
  bgm_library_root?: string;
  /** 是否做 loudnorm 归一化, 默认 true */
  normalize_loudness?: boolean;
  /** 中止信号 */
  signal?: AbortSignal;
}

export interface MixBgmResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  bgm_file?: string;
  output_mp4?: string;
  loudnorm_applied?: boolean;
  /**
   * 2026-05-29 P0-1 (silent skip 红线): 用户选了 BGM 风格, 但库里没对应音频文件 / 文件无音轨。
   * 老逻辑只在 `!normalize_loudness` 时返 skipped reason; loudnorm 开着 (默认) 时 BGM 缺失被
   * 完全吞掉 (ok=true, bgm_file=null, 无 reason) → 前端 0 提示, 用户拿到无 BGM 视频毫无头绪。
   * 现在无论 loudnorm 是否继续, 只要"请求了 BGM 但没用上", 都把缺失 mood + 原因写到这两个字段,
   * render.ts 落 manifest + SSE done 透给前端 banner。
   */
  bgm_requested_mood?: string;
  bgm_missing_reason?: "file_not_found" | "no_audio_track";
}

/**
 * 在 BGM 库里找匹配 mood 的音频文件.
 *
 * 查找顺序:
 *   1. `<root>/<mood>.mp3` (精确)
 *   2. `<root>/<mood>.wav`
 *   3. `<root>/<mood>.m4a`
 *   4. 找不到 → null
 *
 * mood 字符串 trim + 大小写敏感 (mood 是用户选的, 文件名应一致).
 */
export async function findBgmFile(mood: string, libraryRoot: string): Promise<string | null> {
  const m = mood.trim();
  if (!m) return null;
  const exts = [".mp3", ".wav", ".m4a", ".ogg"];
  for (const ext of exts) {
    const file = path.join(libraryRoot, `${m}${ext}`);
    try {
      await fs.access(file);
      return file;
    } catch {
      // 继续尝试下一个
    }
  }
  return null;
}

/**
 * V-29: 用 ffprobe 检查文件是否包含音频流。bgmFile 存在但无音轨时跳过混音。
 */
async function probeAudioStream(filePath: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const child = spawn("ffprobe", [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
      "-of", "csv=p=0", filePath,
    ], { windowsHide: true });
    // BUG-43: ffprobe 15s timeout — 超时 kill 防止进程挂死
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; if (child.pid !== undefined) void killProcessTree(child.pid); resolve(false); }
    }, 15_000);
    if (signal) {
      const onAbort = () => { if (!resolved) { resolved = true; clearTimeout(timer); if (child.pid !== undefined) void killProcessTree(child.pid); resolve(false); } };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); if (out.length > 4096) out = out.slice(-4096); });
    child.on("close", () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(out.trim().toLowerCase().includes("audio")); } });
    child.on("error", () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(false); } });
  });
}

/**
 * 用 ffprobe 取文件时长, 失败返 0 (不阻塞流程).
 */
async function probeDurationSec(filePath: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    let resolved = false;
    const child = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ], { windowsHide: true });
    // BUG-43: ffprobe 15s timeout — 超时 kill 防止进程挂死
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; if (child.pid !== undefined) void killProcessTree(child.pid); resolve(0); }
    }, 15_000);
    if (signal) {
      const onAbort = () => { if (!resolved) { resolved = true; clearTimeout(timer); if (child.pid !== undefined) void killProcessTree(child.pid); resolve(0); } };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); if (out.length > 16384) out = out.slice(-16384); });
    child.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        const n = parseFloat(out.trim());
        resolve(isFinite(n) ? n : 0);
      }
    });
    child.on("error", () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(0); } });
  });
}

/**
 * 主函数: 给 mp4 加 BGM + loudnorm.
 *
 * @returns ok=true 表示输出了新 mp4 (output_mp4 字段); skipped=true 表示原文件未改 (跳过原因写 reason).
 */
export async function mixBgmAndNormalize(opts: MixBgmOptions): Promise<MixBgmResult> {
  const {
    input_mp4,
    output_mp4,
    bgm_mood,
    bgm_volume = 0.35,
    bgm_library_root = path.join(process.cwd(), "data", "bgm-library"),
    normalize_loudness = true,
    signal,
  } = opts;

  // 0. 没 mood 也没要求 loudnorm → 完全跳过
  if (!bgm_mood?.trim() && !normalize_loudness) {
    return { ok: false, skipped: true, reason: "no_bgm_no_loudnorm" };
  }

  // 1. 找 BGM 文件 (mood 给了才找)
  // 2026-05-29 P0-1: bgmMissingReason 跨"找不到文件" / "文件无音轨"两种缺失, 一路带到返回值,
  // 不管后面 loudnorm 走不走 — 让 render.ts 永远能透出"你选了 BGM 但没用上"给前端。
  let bgmFile: string | null = null;
  const requestedMood = bgm_mood?.trim() || "";
  let bgmMissingReason: "file_not_found" | "no_audio_track" | null = null;
  if (requestedMood) {
    bgmFile = await findBgmFile(requestedMood, bgm_library_root);
    if (bgmFile) {
      // V-29: 文件存在但可能无音轨 — ffprobe 验证
      const hasAudio = await probeAudioStream(bgmFile, signal);
      if (!hasAudio) {
        bgmFile = null;
        bgmMissingReason = "no_audio_track";
        if (!normalize_loudness) {
          return { ok: false, skipped: true, reason: `bgm_no_audio_track:${requestedMood}`, bgm_requested_mood: requestedMood, bgm_missing_reason: "no_audio_track" };
        }
      }
    } else {
      bgmMissingReason = "file_not_found";
      if (!normalize_loudness) {
        // 用户配了 BGM 但找不到, 又不做 loudnorm → 跳过 (不阻塞合成)
        return { ok: false, skipped: true, reason: `bgm_file_not_found:${requestedMood}`, bgm_requested_mood: requestedMood, bgm_missing_reason: "file_not_found" };
      }
    }
  }

  // 2. 校验输入存在
  try {
    await fs.access(input_mp4);
  } catch {
    return { ok: false, skipped: true, reason: "input_mp4_not_found" };
  }

  // 3. 拼 ffmpeg 命令
  // 场景 A: 有 BGM → 复杂 filter_complex (sidechain ducking + amix + loudnorm)
  // 场景 B: 无 BGM 只 loudnorm → -af loudnorm
  const args: string[] = ["-y", "-i", input_mp4];
  const vol = Math.max(0.05, Math.min(1.0, bgm_volume));

  if (bgmFile) {
    args.push("-stream_loop", "-1", "-i", bgmFile);
    // 拿成片时长, BGM stream_loop 后 ffmpeg 自己截断 (-shortest)
    // filter_complex:
    //   [1:a] 调音量到 vol → bgm_v
    //   [bgm_v][0:a] sidechaincompress (对白触发 BGM 压低) → bgm_ducked
    //   [0:a][bgm_ducked] amix 平均 → mixed
    //   [mixed] loudnorm? → final
    const loudnormSuffix = normalize_loudness ? ",loudnorm=I=-16:TP=-1.5:LRA=11" : "";
    const filterComplex =
      `[1:a]volume=${vol.toFixed(2)}[bgm_v];` +
      `[bgm_v][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400:makeup=1[bgm_ducked];` +
      `[0:a][bgm_ducked]amix=inputs=2:duration=first:dropout_transition=2${loudnormSuffix}[aout]`;
    args.push(
      "-filter_complex", filterComplex,
      "-map", "0:v",
      "-map", "[aout]",
      "-c:v", "copy",        // 视频流不重编, 快
      "-c:a", "aac", "-b:a", "192k",
      "-shortest",
      output_mp4,
    );
  } else if (normalize_loudness) {
    // 只 loudnorm
    args.push(
      "-c:v", "copy",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-c:a", "aac", "-b:a", "192k",
      output_mp4,
    );
  } else {
    return { ok: false, skipped: true, reason: "no_op" };
  }

  // 2026-05-29 P0-1: 用户选了 BGM 但没用上 (找不到文件 / 无音轨) 的标记 — 不管 loudnorm 走不走,
  // 一律带进返回值, 让 render.ts 永远能透出给前端 banner。
  const missingFields = bgmMissingReason
    ? { bgm_requested_mood: requestedMood, bgm_missing_reason: bgmMissingReason }
    : {};

  // 4. 跑 ffmpeg
  return new Promise<MixBgmResult>((resolve) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿
    if (signal) {
      const onAbort = () => { if (child.pid !== undefined) void killProcessTree(child.pid); };
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
        resolve({ ok: false, skipped: true, reason: "aborted", ...missingFields });
        return;
      }
      if (code === 0) {
        resolve({
          ok: true,
          output_mp4,
          bgm_file: bgmFile ?? undefined,
          loudnorm_applied: normalize_loudness,
          ...missingFields,
        });
      } else {
        resolve({
          ok: false,
          skipped: true,
          reason: `ffmpeg_mix_failed:code=${code}:${stderr.slice(-300)}`,
          ...missingFields,
        });
      }
    });
    child.on("error", (err) => {
      resolve({ ok: false, skipped: true, reason: `ffmpeg_spawn_failed:${err.message}`, ...missingFields });
    });
  });
}

/** 强引用避免 tree-shake (probeDurationSec 暂未直接调, 留 export 给未来需要时长校准用) */
export { probeDurationSec as _probeDurationSec };
