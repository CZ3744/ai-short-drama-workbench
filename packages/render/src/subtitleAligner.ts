/**
 * subtitleAligner.ts — Wave 3 3B: Whisper 强制对齐 + 精确时间戳
 *
 * 功能:
 *   1. 对每个 shot 的音频用 Whisper (OpenAI API 或本地 whisper.cpp) 做强制对齐
 *   2. 返回精确的字幕段起止时间戳
 *   3. 生成 SRT 时用对齐结果而非估算时长
 *
 * 策略:
 *   - 主: OpenAI Whisper API (verbose_json + timestamp_granularities)
 *   - 备: 本地 whisper.cpp (如果已安装且可执行)
 *   - 兜底: 按字符数估算 (保证不出错)
 */

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists, getConfigValue } from "../../core/src/index";
import { runProcess } from "./process";

// ─── Types ─────────────────────────────────────────────────────────

export interface SubtitleAlignmentSegment {
  /** 片段序号 (1-based) */
  index: number;
  /** 该片段对应的台词文本 */
  text: string;
  /** 起始时间 (秒) */
  startSec: number;
  /** 结束时间 (秒) */
  endSec: number;
  /** 时长 (秒) */
  durationSec: number;
  /** 对齐方式 */
  source: "whisper_api" | "whisper_local" | "whisper_python" | "fallback_estimate";
  /** 置信度 (0-1), whisper 模式有值 */
  confidence?: number;
}

export interface SubtitleAlignmentResult {
  /** 对齐方式 */
  method: "whisper_api" | "whisper_local" | "whisper_python" | "fallback_estimate";
  /** 对齐后的每条字幕片段 */
  segments: SubtitleAlignmentSegment[];
  /** 音频文件路径 */
  audioPath: string;
  /** 台词原文 */
  fullText: string;
  /** 总时长 (秒) */
  totalDurationSec: number;
  /** 对齐时是否出现了警告 */
  warnings: string[];
}

export interface SubtitleAlignerOptions {
  /** Whisper provider: "openai" | "whisper_cpp" | "python_faster_whisper" | "auto" (default) */
  whisperProvider?: "openai" | "whisper_cpp" | "python_faster_whisper" | "auto";
  /** OpenAI API key (若未提供，从 localSettings 读取) */
  openaiApiKey?: string;
  /** OpenAI API base URL */
  openaiBaseUrl?: string;
  /** Whisper model (default: "whisper-1") */
  whisperModel?: string;
  /** whisper.cpp 可执行文件路径 */
  whisperCppPath?: string;
  /** whisper.cpp model 路径 */
  whisperCppModelPath?: string;
  /** Python faster-whisper model size (tiny/base/small/medium/large-v3, default 'small') */
  pythonWhisperModel?: string;
  /** Python faster-whisper device (auto/cpu/cuda, default 'auto') */
  pythonWhisperDevice?: string;
  /** 语言 (default: "zh") */
  language?: string;
  /** 超时毫秒 (default: 120000) */
  timeoutMs?: number;
}

// ─── Core API ──────────────────────────────────────────────────────

/**
 * 对单个音频片段做强制对齐，返回精确的字段时间戳。
 *
 * @param audioPath 音频文件绝对路径 (mp3/wav/m4a)
 * @param text 该段音频对应的台词文本 (用于强制对齐引导)
 * @param options 对齐选项
 */
export async function alignSubtitlesForAudio(
  audioPath: string,
  text: string,
  options: SubtitleAlignerOptions = {},
): Promise<SubtitleAlignmentResult> {
  const warnings: string[] = [];
  if (!text.trim()) {
    return {
      method: "fallback_estimate",
      segments: [],
      audioPath,
      fullText: text,
      totalDurationSec: 0,
      warnings: ["空文本，跳过对齐"],
    };
  }

  if (!(await pathExists(audioPath))) {
    return {
      method: "fallback_estimate",
      segments: estimateSegments(text, 5),
      audioPath,
      fullText: text,
      totalDurationSec: estimateTotalDuration(text),
      warnings: [`音频文件不存在: ${audioPath}，使用估算`],
    };
  }

  const mode = options.whisperProvider || "auto";
  const timeout = options.timeoutMs ?? 120_000;

  // 2026-05-25 新增 Python faster-whisper 路径 — 用户机器 OpenClaw workspace Python 3.12
  // 已装 faster-whisper 1.2.1 + CUDA. 不要 OpenAI key, 不要 whisper.cpp .exe, 直接本地跑.
  // auto 模式优先级: python_faster_whisper > openai > whisper_cpp (跟用户实际能用什么对齐).

  // ── 策略 P: Python faster-whisper (本地, 免费, 用户已装) ──
  if (mode === "python_faster_whisper" || mode === "auto") {
    const result = await tryPythonFasterWhisper(audioPath, text, options, timeout, warnings);
    if (result) return result;
  }

  // ── 策略 A: 本地 whisper.cpp ──
  if (mode === "whisper_cpp") {
    const result = await tryWhisperCpp(audioPath, text, options, timeout, warnings);
    if (result) return result;
    // fall through to fallback
  }

  // ── 策略 B: OpenAI Whisper API ──
  if (mode === "openai" || mode === "auto") {
    const result = await tryOpenAIWhisper(audioPath, text, options, timeout, warnings);
    if (result) return result;
  }

  // ── 策略 C: 本地 whisper.cpp (auto 模式的第二顺位) ──
  if (mode === "auto") {
    const result = await tryWhisperCpp(audioPath, text, options, timeout, warnings);
    if (result) return result;
  }

  // ── 兜底: 字符数估算 ──
  warnings.push("Whisper 对齐不可用，使用字符数估算时间戳");
  const estimatedSegments = estimateSegments(text, await probeAudioDuration(audioPath));
  return {
    method: "fallback_estimate",
    segments: estimatedSegments,
    audioPath,
    fullText: text,
    totalDurationSec: estimatedSegments.reduce((s, seg) => s + seg.durationSec, 0),
    warnings,
  };
}

// ─── OpenAI Whisper API 实现 ───────────────────────────────────────

interface WhisperWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  words?: WhisperWord[];
}

async function tryOpenAIWhisper(
  audioPath: string,
  text: string,
  options: SubtitleAlignerOptions,
  timeoutMs: number,
  warnings: string[],
): Promise<SubtitleAlignmentResult | null> {
  const apiKey = options.openaiApiKey || getConfigValue("OPENAI_API_KEY") || null;
  if (!apiKey) {
    warnings.push("未配置 OPENAI_API_KEY，跳过 OpenAI Whisper");
    return null;
  }

  const baseUrl = options.openaiBaseUrl || getConfigValue("OPENAI_BASE_URL", "https://api.openai.com/v1");
  const model = options.whisperModel || "whisper-1";
  const lang = options.language || "zh";

  try {
    const audioBuffer = await fs.readFile(audioPath);
    const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });

    const formData = new FormData();
    formData.append("file", audioBlob, path.basename(audioPath));
    formData.append("model", model);
    formData.append("language", lang);
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "word");

    // 强制对齐引导: 将原文作为 prompt 传入
    if (text.trim()) {
      formData.append("prompt", text.trim());
    }

    // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
    // 删本地计时后主动 abort 的模式. Whisper 转写大文件可能 >5min, 不能本地误判超时.
    void timeoutMs; // 保留参数签名 (caller 传入), 不再用于 abort.

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      warnings.push(`OpenAI Whisper 请求失败 (${response.status}): ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as {
      duration: number;
      segments: WhisperSegment[];
      text: string;
    };

    if (!data.segments || data.segments.length === 0) {
      warnings.push("OpenAI Whisper 返回空 segments");
      return null;
    }

    // 将 Whisper 的 segments 按文本映射到用户提供的字幕片段
    const segments = mapSegmentsToText(data.segments, text, data.duration);
    return {
      method: "whisper_api",
      segments,
      audioPath,
      fullText: text,
      totalDurationSec: data.duration,
      warnings,
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      warnings.push(`OpenAI Whisper 超时 (${timeoutMs}ms)`);
    } else {
      warnings.push(`OpenAI Whisper 异常: ${err?.message || String(err)}`);
    }
    return null;
  }
}

// ─── Python faster-whisper 实现 ──────────────────────────────────
//
// 2026-05-25 — 用户机器已装 faster-whisper 1.2.1 (Python 3.12 + CUDA), 比 whisper.cpp .exe
// 配置简单太多. 通过 spawn `py -3.12 scripts/whisper_transcribe.py <audio>` 调.
// 失败 (Python 不存在 / faster-whisper 没装 / 模型下载失败) → return null 让 caller 继续 fallback.
// 铁律 #1: 不本地 timeout, 透传 ctx.signal — Python 子进程死锁兜底交给 caller.

async function tryPythonFasterWhisper(
  audioPath: string,
  text: string,
  options: SubtitleAlignerOptions,
  timeoutMs: number,
  warnings: string[],
): Promise<SubtitleAlignmentResult | null> {
  void timeoutMs;
  // Python 解释器: 用户 OpenClaw workspace Python 3.12. Windows 用 `py -3.12`, 其他系统用 python3.
  const pythonExe = getConfigValue("PYTHON_WHISPER_EXE", "") || (process.platform === "win32" ? "py" : "python3");
  const pythonArgs: string[] = [];
  if (process.platform === "win32" && pythonExe === "py") {
    pythonArgs.push("-3.12");
  }
  // ESM has no __dirname; resolve from the module so arbitrary launch directories work.
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "whisper_transcribe.py");
  if (!(await pathExists(scriptPath))) {
    warnings.push(`Python whisper 桥接脚本不存在: ${scriptPath}`);
    return null;
  }

  const model = options.pythonWhisperModel || getConfigValue("WHISPER_PYTHON_MODEL", "small") || "small";
  const device = options.pythonWhisperDevice || getConfigValue("WHISPER_PYTHON_DEVICE", "auto") || "auto";
  const lang = options.language || "zh";

  pythonArgs.push(
    scriptPath,
    audioPath,
    "--model", model,
    "--device", device,
    "--language", lang,
  );
  if (text.trim().length > 0 && text.trim().length < 200) {
    // initial_prompt: 给 Whisper 解码引导, 提升专有名词/角色名识别准确率.
    pythonArgs.push("--initial-prompt", text.trim());
  }

  try {
    // BUG-42: 本地 spawn 子进程 timeout 属于铁律 #1 例外 — Python 子进程死锁需要兜底 kill.
    const result = await runProcess(pythonExe, pythonArgs, { timeoutMs: 300_000 });
    if (result.code !== 0) {
      const errSnippet = result.stderr.slice(-300).replace(/\s+/g, " ").trim();
      warnings.push(`Python faster-whisper 退出码 ${result.code}: ${errSnippet}`);
      return null;
    }

    const stdout = result.stdout.trim();
    if (!stdout || !stdout.startsWith("{")) {
      warnings.push(`Python faster-whisper 输出非 JSON (前 100 字): ${stdout.slice(0, 100)}`);
      return null;
    }

    let parsed: {
      ok: boolean;
      method: string;
      duration: number;
      language?: string;
      segments: Array<{ start: number; end: number; text: string }>;
    };
    try {
      parsed = JSON.parse(stdout);
    } catch (parseErr: any) {
      warnings.push(`Python faster-whisper 输出 JSON parse 失败: ${parseErr?.message}`);
      return null;
    }

    if (!parsed.ok || !parsed.segments || parsed.segments.length === 0) {
      warnings.push("Python faster-whisper 返回空 segments");
      return null;
    }

    // 把 Whisper 输出 segments 映射到用户原文分句 (跟 OpenAI / whisper.cpp 同款 mapSegmentsToText).
    // mapSegmentsToText 内部按字符重叠匹配, Whisper 转写跟原文有出入也能 fallback 到比例分布.
    const segments = mapSegmentsToText(
      parsed.segments.map(s => ({ start: s.start, end: s.end, text: s.text })),
      text,
      parsed.duration,
    ).map((seg) => ({
      ...seg,
      source: "whisper_python" as const,
    }));

    return {
      method: "whisper_python",
      segments,
      audioPath,
      fullText: text,
      totalDurationSec: parsed.duration,
      warnings,
    };
  } catch (err: any) {
    warnings.push(`Python faster-whisper 异常: ${err?.message || String(err)}`);
    return null;
  }
}

// ─── 本地 whisper.cpp 实现 ─────────────────────────────────────────

async function tryWhisperCpp(
  audioPath: string,
  text: string,
  options: SubtitleAlignerOptions,
  timeoutMs: number,
  warnings: string[],
): Promise<SubtitleAlignmentResult | null> {
  const whisperExe = options.whisperCppPath ||
    getConfigValue("WHISPER_CPP_PATH", "") ||
    findWhisperCppDefault();

  if (!whisperExe || !(await checkExecutableExists(whisperExe))) {
    warnings.push("本地 whisper.cpp 不可用 (未找到可执行文件)");
    return null;
  }

  const modelPath = options.whisperCppModelPath ||
    getConfigValue("WHISPER_CPP_MODEL_PATH", "") ||
    findWhisperModelDefault();

  if (!modelPath) {
    warnings.push("本地 whisper.cpp model 路径未配置");
    return null;
  }

  const lang = options.language || "zh";
  // timeoutMs 保留: 保持与 tryOpenAIWhisper / tryPythonFasterWhisper 签名一致，方便上层统一调用。
  // 实际超时由 runProcess 的默认 5 分钟 timeout 兜底 (见 process.ts RUN_PROCESS_DEFAULT_TIMEOUT_MS)。
  void timeoutMs;

  try {
    // 使用 whisper.cpp 的 --max-len 和 --word-thold 参数
    // 输出 JSON 格式结果到临时文件
    const tmpDir = path.dirname(audioPath);
    const outBase = path.join(tmpDir, `whisper_align_${Date.now()}`);

    const result = await runProcess(whisperExe, [
      "-m", modelPath,
      "-f", audioPath,
      "-l", lang,
      "-oj",  // JSON output
      "-of", outBase,
      "--max-len", "50",
      "--max-tokens", "10000",
      "--suppress-blank",
      "--suppress-non-speech-tokens",
    ], { timeoutMs: 0 });

    // 读取输出的 JSON 文件
    const jsonPath = `${outBase}.json`;
    if (result.code !== 0 || !(await pathExists(jsonPath))) {
      warnings.push(`本地 whisper.cpp 执行失败: ${result.stderr.slice(-300)}`);
      // 清理临时文件
      await fs.unlink(jsonPath).catch(() => {});
      return null;
    }

    const jsonContent = await fs.readFile(jsonPath, "utf-8");
    await fs.unlink(jsonPath).catch(() => {});

    // whisper.cpp JSON 格式: { "transcription": [{ "timestamps": { "from": "...", "to": "..." }, "text": "..." }] }
    const parsed = JSON.parse(jsonContent);
    const transcription = parsed?.transcription || [];

    if (!Array.isArray(transcription) || transcription.length === 0) {
      warnings.push("本地 whisper.cpp 返回空转录结果");
      return null;
    }

    // 将时间戳字符串转为秒
    const rawSegments: Array<{ start: number; end: number; text: string }> = [];
    for (const item of transcription) {
      const ts = item?.timestamps || {};
      const fromStr = ts.from || "00:00:00,000";
      const toStr = ts.to || "00:00:00,000";
      rawSegments.push({
        start: parseSrtTimestamp(fromStr),
        end: parseSrtTimestamp(toStr),
        text: item?.text || "",
      });
    }

    const totalDuration = rawSegments.length > 0
      ? rawSegments[rawSegments.length - 1].end
      : estimateTotalDuration(text);

    const segments = mapSegmentsToText(rawSegments, text, totalDuration);
    return {
      method: "whisper_local",
      segments,
      audioPath,
      fullText: text,
      totalDurationSec: totalDuration,
      warnings,
    };
  } catch (err: any) {
    warnings.push(`本地 whisper.cpp 异常: ${err?.message || String(err)}`);
    return null;
  }
}

// ─── 时间戳映射 ────────────────────────────────────────────────────

/**
 * 将 Whisper 返回的 segments 映射到用户提供的字幕文本片段。
 *
 * Whisper 返回的 segments 可能和用户的分句不完全一致，
 * 这里用最长公共子序列方法做匹配，尽可能还原分段关系。
 */
function mapSegmentsToText(
  rawSegments: Array<{ start: number; end: number; text: string; confidence?: number }>,
  targetText: string,
  totalDuration: number,
): SubtitleAlignmentSegment[] {
  // 将用户原文按中文标点分句
  const sentences = splitSentences(targetText);

  if (sentences.length === 0) {
    return [{
      index: 1,
      text: targetText,
      startSec: 0,
      endSec: totalDuration,
      durationSec: totalDuration,
      source: "whisper_api",
    }];
  }

  // 只有一句话时: 直接用整个音频时长
  if (sentences.length === 1) {
    return [{
      index: 1,
      text: sentences[0],
      startSec: 0,
      endSec: totalDuration,
      durationSec: totalDuration,
      source: "whisper_api",
    }];
  }

  // 多句话: 扫描 Whisper segments,按字符重叠匹配到最近的分句
  const mapped: SubtitleAlignmentSegment[] = [];
  let segIdx = 0;

  for (let si = 0; si < sentences.length; si++) {
    const sentence = sentences[si];
    let bestStart = si > 0 ? mapped[si - 1].endSec : 0;
    let bestEnd = si < sentences.length - 1
      ? totalDuration * (si + 1) / sentences.length
      : totalDuration;

    // 在 Whisper segments 中查找匹配此句的 segment
    let accumulatedStart: number | null = null;
    let accumulatedEnd: number | null = null;

    for (let ri = segIdx; ri < rawSegments.length; ri++) {
      const rawSeg = rawSegments[ri];
      const rawText = rawSeg.text?.replace(/\s+/g, " ").trim() || "";
      const sentenceClean = sentence.replace(/\s+/g, " ").trim();

      // 用简单的字符重叠检测
      const overlap = charOverlap(rawText, sentenceClean);
      if (overlap > 0.3) {
        if (accumulatedStart === null) accumulatedStart = rawSeg.start;
        accumulatedEnd = rawSeg.end;
        segIdx = ri + 1;
      } else if (accumulatedStart !== null) {
        // 超出匹配范围，停止
        break;
      }
    }

    if (accumulatedStart !== null && accumulatedEnd !== null) {
      bestStart = accumulatedStart;
      bestEnd = accumulatedEnd;
    }

    mapped.push({
      index: si + 1,
      text: sentence,
      startSec: round2(bestStart),
      endSec: round2(bestEnd),
      durationSec: round2(bestEnd - bestStart),
      source: "whisper_api",
    });
  }

  return mapped;
}

/**
 * 简单的字符重叠率 (Jaccard-like)
 */
function charOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const setA = new Set([...a]);
  const setB = new Set([...b]);
  let intersection = 0;
  for (const c of setA) {
    if (setB.has(c)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

// ─── 兜底估算 ──────────────────────────────────────────────────────

/**
 * 基于中文字符数和音频实际时长，均匀分配字幕段时间戳。
 * 中文朗读速度约 3.5 字/秒。
 */
function estimateSegments(text: string, actualAudioDurationSec?: number | null): SubtitleAlignmentSegment[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const totalChars = sentences.reduce((s, sent) => s + sent.length, 0);
  // 中文朗读速度: 约 3.5 字符/秒
  const estimatedBySpeech = totalChars > 0 ? Math.max(3, totalChars / 3.5) : 5;
  // 如果有实际音频时长, 优先使用
  const totalDuration = actualAudioDurationSec && actualAudioDurationSec > 0
    ? actualAudioDurationSec
    : estimatedBySpeech;

  const segments: SubtitleAlignmentSegment[] = [];
  let cursor = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i];
    const weight = totalChars > 0 ? sent.length / totalChars : 1 / sentences.length;
    const dur = weight * totalDuration;
    const start = cursor;
    const end = cursor + dur;

    segments.push({
      index: i + 1,
      text: sent,
      startSec: round2(start),
      endSec: round2(end),
      durationSec: round2(dur),
      source: "fallback_estimate",
    });
    cursor = end;
  }

  return segments;
}

function estimateTotalDuration(text: string): number {
  const chars = text.replace(/\s+/g, "").length;
  return Math.max(3, chars / 3.5);
}

// ─── 工具函数 ──────────────────────────────────────────────────────

/**
 * 按中文标点分句
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;，,])/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 探测音频文件时长 (秒)，使用 ffprobe
 */
async function probeAudioDuration(filePath: string): Promise<number | null> {
  try {
    const result = await runProcess("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { timeoutMs: 10000 });
    if (result.code !== 0) return null;
    const d = parseFloat(result.stdout.trim());
    return isNaN(d) ? null : d;
  } catch {
    return null;
  }
}

/**
 * 查找 whisper.cpp 可执行文件。
 * 优先级: 环境变量 WHISPER_CPP_PATH > PATH 中查找 > 通用名 fallback.
 */
function findWhisperCppDefault(): string | null {
  // 优先从环境变量读取 (用户可自定义路径)
  const envPath = process.env.WHISPER_CPP_PATH;
  if (envPath) return envPath;
  // fallback: 让 checkExecutableExists 在 PATH 中探测 (spawn 会失败并通过上层处理)
  return process.platform === "win32" ? "whisper.exe" : "whisper";
}

async function checkExecutableExists(exePath: string): Promise<boolean> {
  // 先用 fs.access 检查文件是否存在，避免 spawn 缺失可执行文件导致 Node.js 崩溃
  try {
    await fs.access(exePath, fs.constants.X_OK);
  } catch {
    return false;
  }
  try {
    const result = await runProcess(exePath, ["--help"], { timeoutMs: 5000 });
    return result.code === 0 || result.stdout.length > 0;
  } catch {
    return false;
  }
}

function findWhisperModelDefault(): string | null {
  return getConfigValue("WHISPER_CPP_MODEL_PATH", "") || null;
}

/**
 * 解析 SRT 时间戳字符串 ("00:01:23,456") 为秒数
 */
function parseSrtTimestamp(ts: string): number {
  const match = ts.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return 0;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  const ms = parseInt(match[4], 10);
  return h * 3600 + m * 60 + s + ms / 1000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 批量对齐多个音频片段。
 * 用于 compose 时对所有 shot 做批量强制对齐。
 */
export async function alignSubtitlesBatch(
  items: Array<{ audioPath: string; text: string; shotId: string }>,
  options: SubtitleAlignerOptions = {},
  onProgress?: (done: number, total: number, shotId: string) => void,
): Promise<Map<string, SubtitleAlignmentResult>> {
  const results = new Map<string, SubtitleAlignmentResult>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const result = await alignSubtitlesForAudio(item.audioPath, item.text, options);
    results.set(item.shotId, result);
    if (onProgress) {
      onProgress(i + 1, items.length, item.shotId);
    }
  }

  return results;
}
