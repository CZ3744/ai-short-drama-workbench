/**
 * voiceReplacer — 后期统一烧录: 扫描全剧本对白 → 按角色配音 → ffmpeg 替换音轨
 *
 * Wave 3C: 角色语音管理 + 统一烧录
 *
 * 两种策略:
 *   - "overlay": 将新 TTS 音频叠加到原音频上 (保留背景音)
 *   - "replace": 完全替换原音轨 (口型较差但音质高)
 */

import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { ensureDir, pathExists, writeJson } from "../../core/src/index";
import { parseDialogue, resolveVoiceForEmotion } from "../../drama/src/dialogueParser";
import type { DialogueLine } from "../../drama/src/dialogueParser";
import { runProcess, killProcessTree } from "./process";

// Re-export types for external consumers
export type { DialogueLine };

// ─── Types ─────────────────────────────────────────────────────────

export interface RevoiceOptions {
  /** "overlay" = 叠加保留背景音; "replace" = 完全替换 */
  strategy: "overlay" | "replace";
  /** 目标视频文件绝对路径 */
  videoPath: string;
  /** 输出文件路径 (默认: videoPath 同目录下 _reviced.mp4) */
  outputPath?: string;
  /** TTS provider ID (默认 edge_tts) */
  ttsProvider?: string;
  /** 默认 voice_id (用于无 voice_style_map 的角色) */
  defaultVoiceId?: string;
  /** 语速 (默认 "+0%") */
  rate?: string;
  /** Python 解释器路径 (用于 edge_tts CLI) */
  pythonPath?: string;
  /** 工作目录 (用于临时文件) */
  workDir?: string;
  /** ffmpeg 可执行文件路径 */
  ffmpegPath?: string;
  /** 取消信号，传递给 TTS 子进程 */
  signal?: AbortSignal;
}

export interface DialogueEntry {
  /** 行号 (0-based) */
  index: number;
  /** 镜头 ID */
  shotId: string;
  /** 角色名 */
  characterName: string;
  /** 情绪标签 */
  emotion: string | null;
  /** 对白文本 */
  text: string;
  /** 该行 TTS 音频文件绝对路径 */
  audioPath: string;
  /** 使用的 voice_id */
  voiceId: string;
  /** 音频时长 (秒) */
  durationSec: number;
}

export interface RevoiceResult {
  ok: boolean;
  outputPath: string | null;
  entries: DialogueEntry[];
  failedEntries: DialogueEntry[];
  totalDurationSec: number;
  message: string;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * 从剧本对白文本和角色语音映射表生成配音并替换视频音轨
 *
 * @param scriptText - 完整剧本文本 (含 "角色名(情绪): 对白" 行)
 * @param characterVoiceMap - Map<角色名, { voice_id, voice_style_map }>
 * @param options - 烧录选项
 * @returns 烧录结果
 */
export async function revoiceEpisode(
  scriptText: string,
  characterVoiceMap: Map<string, { voice_id?: string; voice_style_map?: Record<string, string | undefined> }>,
  options: RevoiceOptions,
): Promise<RevoiceResult> {
  const {
    strategy,
    videoPath,
    outputPath,
    ttsProvider = "edge_tts",
    defaultVoiceId = "zh-CN-YunxiNeural",
    rate = "+0%",
    pythonPath = "python",
    workDir = path.dirname(videoPath),
    ffmpegPath = "ffmpeg",
    signal,
  } = options;

  const revoiceDir = path.join(workDir, "revoice");
  await ensureDir(revoiceDir);

  // Step 1: Parse all dialogue lines from script
  const dialogueLines = parseDialogue(scriptText);
  if (dialogueLines.length === 0) {
    return { ok: false, outputPath: null, entries: [], failedEntries: [], totalDurationSec: 0, message: "剧本中没有检测到对白行" };
  }

  // Step 2: Group by character + emotion → prepare TTS entries
  const entries: DialogueEntry[] = [];
  const failedEntries: DialogueEntry[] = [];

  for (let i = 0; i < dialogueLines.length; i++) {
    const line = dialogueLines[i];
    const charVoice = characterVoiceMap.get(line.character_name);
    const charVoiceId = charVoice?.voice_id;
    const charVoiceStyleMap = charVoice?.voice_style_map;

    const resolvedVoice = resolveVoiceForEmotion(
      charVoiceStyleMap,
      line.emotion,
      charVoiceId ?? defaultVoiceId,
    );

    const audioPath = path.join(revoiceDir, `line_${String(i).padStart(3, "0")}.mp3`);

    entries.push({
      index: i,
      shotId: `line_${i}`,
      characterName: line.character_name,
      emotion: line.emotion,
      text: line.text,
      audioPath,
      voiceId: resolvedVoice,
      durationSec: 0, // filled after synthesis
    });
  }

  // Step 3: Synthesize TTS for each line
  for (const entry of entries) {
    try {
      const dur = await synthesizeTts(
        entry.text,
        entry.voiceId,
        entry.audioPath,
        { rate, pythonPath, provider: ttsProvider, signal },
      );
      entry.durationSec = dur;
    } catch (err) {
      failedEntries.push(entry);
    }
  }

  // Step 4: Generate silence for failed entries
  for (const entry of failedEntries) {
    try {
      const dur = Math.max(2, Math.round(entry.text.length / 3.5));
      await generateSilenceFile(entry.audioPath, dur, ffmpegPath);
      entry.durationSec = dur;
    } catch {
      entry.durationSec = 1;
      try { await fs.writeFile(entry.audioPath, Buffer.alloc(0)); } catch { /* ignore */ }
    }
  }

  // Step 5: Build concat file (all audio lines in order)
  const concatPath = path.join(revoiceDir, "concat.txt");
  const concatLines = entries.map((e) => `file '${e.audioPath.replace(/\\/g, "/")}'`);
  await fs.writeFile(concatPath, concatLines.join("\n") + "\n", "utf8");

  const mergedAudioPath = path.join(revoiceDir, "merged_revoice.m4a");
  const concatResult = await runProcess(ffmpegPath, [
    "-y", "-f", "concat", "-safe", "0",
    "-i", concatPath,
    "-c:a", "aac", "-b:a", "192k",
    mergedAudioPath,
  ], { timeoutMs: 120000 });

  if (concatResult.code !== 0) {
    return {
      ok: false, outputPath: null, entries, failedEntries,
      totalDurationSec: entries.reduce((s, e) => s + e.durationSec, 0),
      message: `音频合并失败: ${concatResult.stderr.slice(-400)}`,
    };
  }

  // Step 6: Replace/overlay audio on video
  const outPath = outputPath ?? path.join(workDir, `${path.basename(videoPath, ".mp4")}_reviced.mp4`);

  try {
    if (strategy === "replace") {
      await replaceAudioTrack(videoPath, mergedAudioPath, outPath, ffmpegPath);
    } else {
      await overlayAudioTrack(videoPath, mergedAudioPath, outPath, ffmpegPath);
    }
  } catch (err: any) {
    return {
      ok: false, outputPath: null, entries, failedEntries,
      totalDurationSec: entries.reduce((s, e) => s + e.durationSec, 0),
      message: `音轨烧录失败: ${err.message}`,
    };
  }

  // Step 7: Write manifest
  const manifest = {
    strategy,
    total_lines: entries.length,
    failed_lines: failedEntries.length,
    entries: entries.map((e) => ({
      index: e.index,
      character: e.characterName,
      emotion: e.emotion,
      voice_id: e.voiceId,
      text: e.text.slice(0, 60),
      duration_sec: e.durationSec,
      ok: !failedEntries.includes(e),
    })),
    output_path: outPath,
    generated_at: new Date().toISOString(),
  };
  await writeJson(path.join(revoiceDir, "revoice_manifest.json"), manifest);

  return {
    ok: true,
    outputPath: outPath,
    entries,
    failedEntries,
    totalDurationSec: entries.reduce((s, e) => s + e.durationSec, 0),
    message: failedEntries.length > 0
      ? `配音完成 (${entries.length - failedEntries.length}/${entries.length} 行成功, ${failedEntries.length} 行回退静音)`
      : `配音完成 (${entries.length} 行全部成功)`,
  };
}

/**
 * 快速: 扫描剧本提取角色列表，按行合成 TTS 并返回 entries（不操作 ffmpeg）
 * 用于仅重录对白音频、不替换视频音轨的场景
 */
export async function revoiceDialogueOnly(
  scriptText: string,
  characterVoiceMap: Map<string, { voice_id?: string; voice_style_map?: Record<string, string | undefined> }>,
  workDir: string,
  options?: { defaultVoiceId?: string; rate?: string; pythonPath?: string; ttsProvider?: string },
): Promise<{ ok: boolean; entries: DialogueEntry[]; message: string }> {
  const dialogueLines = parseDialogue(scriptText);
  if (dialogueLines.length === 0) {
    return { ok: false, entries: [], message: "剧本中没有检测到对白行" };
  }

  const entries: DialogueEntry[] = [];
  const defaultVoiceId = options?.defaultVoiceId ?? "zh-CN-YunxiNeural";
  const rate = options?.rate ?? "+0%";
  const pythonPath = options?.pythonPath ?? "python";
  const ttsProvider = options?.ttsProvider ?? "edge_tts";

  await ensureDir(workDir);

  for (let i = 0; i < dialogueLines.length; i++) {
    const line = dialogueLines[i];
    const charVoice = characterVoiceMap.get(line.character_name);
    const resolvedVoice = resolveVoiceForEmotion(
      charVoice?.voice_style_map,
      line.emotion,
      charVoice?.voice_id ?? defaultVoiceId,
    );

    const audioPath = path.join(workDir, `dialogue_${String(i).padStart(3, "0")}.mp3`);
    try {
      const dur = await synthesizeTts(line.text, resolvedVoice, audioPath, { rate, pythonPath, provider: ttsProvider });
      entries.push({
        index: i, shotId: `line_${i}`,
        characterName: line.character_name, emotion: line.emotion,
        text: line.text, audioPath, voiceId: resolvedVoice, durationSec: dur,
      });
    } catch {
      try {
        const dur = Math.max(2, Math.round(line.text.length / 3.5));
        await generateSilenceFile(audioPath, dur);
        entries.push({
          index: i, shotId: `line_${i}`,
          characterName: line.character_name, emotion: line.emotion,
          text: line.text, audioPath, voiceId: resolvedVoice, durationSec: dur,
        });
      } catch {
        entries.push({
          index: i, shotId: `line_${i}`,
          characterName: line.character_name, emotion: line.emotion,
          text: line.text, audioPath, voiceId: resolvedVoice, durationSec: 1,
        });
      }
    }
  }

  return {
    ok: true,
    entries,
    message: `配音完成 (${entries.length} 行)`,
  };
}

// ─── Internal Helpers ──────────────────────────────────────────────

async function synthesizeTts(
  text: string,
  voiceId: string,
  outputPath: string,
  opts: { rate: string; pythonPath: string; provider: string; signal?: AbortSignal },
): Promise<number> {
  // Use edge_tts CLI (python -m edge_tts) as the default TTS engine
  if (opts.provider === "edge_tts" || !opts.provider) {
    return new Promise<number>((resolve, reject) => {
      // T2: abort immediately if already signalled
      if (opts.signal?.aborted) {
        reject(new Error("synthesizeTts aborted before spawn"));
        return;
      }

      const child = spawn(opts.pythonPath, [
        "-m", "edge_tts",
        "--voice", voiceId,
        "--rate", opts.rate,
        "--text", text,
        "--write-media", outputPath,
      ], {
        // 2026-05-27 audit P0-07: 之前 spawn 自带 timeout 60s 违反铁律 #1, Windows 上发 SIGTERM
        // 不可靠. 真要 timeout 兜底, 改用 setTimeout + SIGKILL (跟 burnSubtitles 同款). 这里因为
        // 是本地 Python 子进程, 60s 足够正常调用, 真死锁 → 用户取消通过 signal 处理.
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      // T2: 64KB ring buffer for stdout + stderr (防止大量输出 OOM)
      const BUF_LIMIT = 64 * 1024;
      let stdout = "";
      let stderr = "";
      let killed = false;
      child.stdout?.on("data", (d: Buffer) => {
        const next = stdout + d.toString();
        stdout = next.length > BUF_LIMIT ? next.slice(next.length - BUF_LIMIT) : next;
      });
      child.stderr?.on("data", (d: Buffer) => {
        const next = stderr + d.toString();
        stderr = next.length > BUF_LIMIT ? next.slice(next.length - BUF_LIMIT) : next;
      });

      // T2: AbortSignal support
      const abortHandler = () => {
        if (killed) return;
        killed = true;
        if (child.pid !== undefined) void killProcessTree(child.pid); // XT-T2: tree-kill
        reject(new Error("edge_tts aborted via AbortSignal"));
      };
      if (opts.signal) {
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }

      child.on("close", (code) => {
        if (opts.signal) opts.signal.removeEventListener("abort", abortHandler);
        if (killed) return;
        if (code === 0) {
          // Probe duration
          probeAudioDuration(outputPath).then((dur) => resolve(dur ?? estimateDuration(text))).catch(() => resolve(estimateDuration(text)));
        } else {
          reject(new Error(`edge_tts exit ${code}: ${stderr.slice(-200)}`));
        }
      });

      child.on("error", (err) => {
        if (opts.signal) opts.signal.removeEventListener("abort", abortHandler);
        if (killed) return;
        reject(err);
      });
    });
  }

  // For other providers, fall back to edge_tts with a warning
  // (mimo_tts and others are registered but may not be available)
  return synthesizeTts(text, voiceId, outputPath, { ...opts, provider: "edge_tts" });
}

async function probeAudioDuration(filePath: string): Promise<number | null> {
  try {
    const result = await runProcess("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { timeoutMs: 10000 });
    if (result.code !== 0) return null;
    const dur = parseFloat(result.stdout.trim());
    return isNaN(dur) ? null : dur;
  } catch {
    return null;
  }
}

function estimateDuration(text: string): number {
  return Math.max(2, Math.round(text.length / 3.5));
}

async function generateSilenceFile(outputPath: string, durationSec: number, ffmpegPath = "ffmpeg"): Promise<void> {
  // toFixed(3) — 1ms 精度, 避免 String(浮点) 长尾 (1.3666666666666667...) 让 ffmpeg
  // 在不同 segment 上拿到不一致的边界
  const result = await runProcess(ffmpegPath, [
    "-y", "-f", "lavfi",
    "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`,
    "-t", durationSec.toFixed(3),
    "-c:a", "aac", "-b:a", "128k",
    outputPath,
  ], { timeoutMs: Math.max(30000, durationSec * 5000) });
  if (result.code !== 0) {
    throw new Error(`Silence generation failed: ${result.stderr.slice(-200)}`);
  }
}

/**
 * 完全替换音轨: 用新 TTS 音频替换视频原音轨
 * ffmpeg -i video.mp4 -i new_audio.m4a -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 out.mp4
 */
async function replaceAudioTrack(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  ffmpegPath = "ffmpeg",
): Promise<void> {
  const result = await runProcess(ffmpegPath, [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-shortest",
    outputPath,
  ], { timeoutMs: 300000 });
  if (result.code !== 0) {
    throw new Error(`replaceAudioTrack failed: ${result.stderr.slice(-400)}`);
  }
}

/**
 * 叠加音轨: 将新 TTS 音频与原音频混合 (降低原音量到 30%)
 * ffmpeg -i video.mp4 -i new_audio.m4a \
 *   -filter_complex "[1:a]volume=1[a1];[0:a]volume=0.3[a0];[a0][a1]amix=inputs=2:duration=first[amix]" \
 *   -c:v copy -map 0:v:0 -map "[amix]" out.mp4
 */
async function overlayAudioTrack(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  ffmpegPath = "ffmpeg",
): Promise<void> {
  // Check if source has an audio track
  const hasAudio = await videoHasAudioTrack(videoPath, ffmpegPath);

  if (!hasAudio) {
    // No existing audio: simply replace
    await replaceAudioTrack(videoPath, audioPath, outputPath, ffmpegPath);
    return;
  }

  const result = await runProcess(ffmpegPath, [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-filter_complex",
    "[1:a]volume=1.0[a1];[0:a]volume=0.3[a0];[a0][a1]amix=inputs=2:duration=first[amix]",
    "-c:v", "copy",
    "-map", "0:v:0",
    "-map", "[amix]",
    "-shortest",
    outputPath,
  ], { timeoutMs: 300000 });
  if (result.code !== 0) {
    throw new Error(`overlayAudioTrack failed: ${result.stderr.slice(-400)}`);
  }
}

async function videoHasAudioTrack(videoPath: string, ffmpegPath = "ffmpeg"): Promise<boolean> {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  try {
    const result = await runProcess(ffmpegPath, [
      "-i", videoPath,
      "-af", "volumedetect",
      "-vn", "-sn",
      "-f", "null", nullDevice,
    ], { timeoutMs: 15000 });
    return result.code === 0 && result.stderr.includes("volumedetect");
  } catch {
    return false;
  }
}
