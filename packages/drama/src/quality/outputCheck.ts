/**
 * C5 — 输出前质检报告卡
 *
 * 合成完毕后调用 outputCheck 生成报告:
 * - 时长、分辨率、fps、码率
 * - 音画同步偏差 (ffprobe)
 * - 字幕存在与对齐
 * - 预计完播率 (启发式基于时长和节奏)
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────

export type CheckLevel = "pass" | "warn" | "fail";

export interface QualityCheckItem {
  /** 检查项名称 */
  label: string;
  /** 检查结果等级 */
  level: CheckLevel;
  /** 显示值 */
  value: string;
  /** 附加说明 (可选) */
  detail?: string;
}

export interface OutputQualityReport {
  /** 生成时间 */
  checked_at: string;
  /** 各检查项 */
  items: QualityCheckItem[];
  /** 是否存在红色项 */
  has_red: boolean;
  /** 是否存在黄色项 */
  has_yellow: boolean;
  /** 预计完播率 0-100 */
  estimated_completion_rate: number;
}

// ─── ffprobe JSON output types ──────────────────────────────────────────

interface FfprobeStream {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
}

interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
  size?: string;
  format_name?: string;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

// ─── Probe implementation ───────────────────────────────────────────────

function runFfprobe(filePath: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error("ffprobe timeout (30s)"));
    }, 30_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`ffprobe JSON parse error: ${(e as Error).message}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`ffprobe spawn error: ${err.message}`));
    });
  });
}

/** 解析帧率字符串如 "30/1" → 30 */
function parseFrameRate(fr: string | undefined): number {
  if (!fr) return 0;
  const parts = fr.split("/");
  if (parts.length === 2 && Number(parts[1]) !== 0) {
    return Number(parts[0]) / Number(parts[1]);
  }
  return Number(fr) || 0;
}

/** 从字幕文件读取内容, 检查是否存在和基本对齐 */
async function checkSubtitles(composeDir: string): Promise<{ exists: boolean; count: number; maxGap: number }> {
  const srtPath = path.join(composeDir, "subtitles", "final.srt");
  const assPath = path.join(composeDir, "subtitles", "final.ass");
  let srtExists = false;
  let assExists = false;
  let srtCount = 0;
  let maxGapSec = 0;

  try {
    await fs.access(srtPath);
    srtExists = true;
    const content = await fs.readFile(srtPath, "utf8");
    // 计算字幕条数
    const cues = content.trim().split(/\n\s*\n/).filter(Boolean);
    srtCount = cues.length;
    // 检查相邻字幕间隔
    const timeRegex = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g;
    const timestamps: Array<{ start: number; end: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = timeRegex.exec(content)) !== null) {
      const startH = Number(match[1]), startM = Number(match[2]), startS = Number(match[3]), startMs = Number(match[4]);
      const endH = Number(match[5]), endM = Number(match[6]), endS = Number(match[7]), endMs = Number(match[8]);
      timestamps.push({
        start: startH * 3600 + startM * 60 + startS + startMs / 1000,
        end: endH * 3600 + endM * 60 + endS + endMs / 1000,
      });
    }
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i].start - timestamps[i - 1].end;
      if (gap > maxGapSec) maxGapSec = gap;
    }
  } catch { /* srt not found */ }

  try {
    await fs.access(assPath);
    assExists = true;
  } catch { /* ass not found */ }

  return { exists: srtExists || assExists, count: srtCount, maxGap: maxGapSec };
}

/**
 * 预计完播率 — 启发式算法
 *
 * 因素:
 * - 时长: 短视频 (<60s) 高完播, 中等 (60-300s) 中等, 长 (>300s) 低
 * - 节奏: 字幕间隔均匀度 (间隔标准差小 → 节奏好 → 完播率高)
 * - 字幕密度: 每秒字幕条数 (0.3-0.8 为佳)
 */
function estimateCompletionRate(durationSec: number, subtitleCount: number, maxGapSec: number): number {
  let rate = 70; // 基线 70%

  // 时长因子
  if (durationSec <= 30) rate += 15;
  else if (durationSec <= 60) rate += 10;
  else if (durationSec <= 180) rate += 0;
  else if (durationSec <= 300) rate -= 10;
  else rate -= 25;

  // 字幕密度因子 (条/秒)
  if (durationSec > 0) {
    const density = subtitleCount / durationSec;
    if (density >= 0.3 && density <= 0.8) rate += 10;
    else if (density < 0.1) rate -= 15;
    else if (density > 1.5) rate -= 5;
  }

  // 最大间隔因子 (长间隔意味着观众可能流失)
  if (maxGapSec > 15) rate -= 15;
  else if (maxGapSec > 8) rate -= 8;
  else if (maxGapSec > 5) rate -= 3;

  return Math.max(10, Math.min(95, Math.round(rate)));
}

// ─── Main entry ─────────────────────────────────────────────────────────

/**
 * 对合成完毕的视频执行质检, 返回结构化报告。
 *
 * @param videoPath  最终视频文件路径 (final.mp4)
 * @param composeDir compose 目录路径 (包含 subtitles/ 子目录)
 * @param expectedFps 期望帧率 (可选, 用于 fps 检查)
 * @param expectedWidth 期望宽度 (可选)
 * @param expectedHeight 期望高度 (可选)
 */
export async function runOutputCheck(
  videoPath: string,
  composeDir: string,
  expectedFps?: number,
  expectedWidth?: number,
  expectedHeight?: number,
): Promise<OutputQualityReport> {
  const items: QualityCheckItem[] = [];
  let probe: FfprobeOutput | null = null;

  // ── 1. ffprobe 视频信息 ──
  try {
    probe = await runFfprobe(videoPath);
  } catch (err) {
    items.push({
      label: "视频探测",
      level: "fail",
      value: "ffprobe 失败",
      detail: (err as Error).message,
    });
    return buildReport(items);
  }

  const videoStream = probe.streams.find((s) => s.codec_type === "video");
  const audioStream = probe.streams.find((s) => s.codec_type === "audio");
  const durationSec = Number(probe.format.duration ?? videoStream?.duration ?? 0);
  const width = videoStream?.width ?? 0;
  const height = videoStream?.height ?? 0;
  const fps = parseFrameRate(videoStream?.r_frame_rate || videoStream?.avg_frame_rate);
  const bitrate = Number(probe.format.bit_rate ?? 0);

  // ── 2. 时长检查 ──
  {
    let level: CheckLevel = "pass";
    let detail: string | undefined;
    if (durationSec < 1) {
      level = "fail";
      detail = "视频时长不足 1 秒, 可能合成异常";
    } else if (durationSec > 600) {
      level = "warn";
      detail = "视频超过 10 分钟, 完播率可能较低";
    }
    items.push({
      label: "时长",
      level,
      value: formatDuration(durationSec),
      detail,
    });
  }

  // ── 3. 分辨率检查 ──
  {
    let level: CheckLevel = "pass";
    let detail: string | undefined;
    if (width === 0 || height === 0) {
      level = "fail";
      detail = "无法读取分辨率";
    } else if (expectedWidth && expectedHeight && (width !== expectedWidth || height !== expectedHeight)) {
      level = "warn";
      detail = `期望 ${expectedWidth}x${expectedHeight}`;
    } else if (width < 1280 || height < 720) {
      level = "warn";
      detail = "低于 720p, 建议提高分辨率";
    }
    items.push({
      label: "分辨率",
      level,
      value: `${width}x${height}`,
      detail,
    });
  }

  // ── 4. 帧率检查 ──
  {
    let level: CheckLevel = "pass";
    let detail: string | undefined;
    if (fps === 0) {
      level = "warn";
      detail = "无法读取帧率";
    } else if (expectedFps && Math.abs(fps - expectedFps) > 1) {
      level = "warn";
      detail = `期望 ${expectedFps}fps`;
    } else if (fps < 20) {
      level = "warn";
      detail = "帧率偏低, 画面可能不流畅";
    }
    items.push({
      label: "帧率",
      level,
      value: fps > 0 ? `${fps.toFixed(1)} fps` : "未知",
      detail,
    });
  }

  // ── 5. 码率检查 ──
  {
    let level: CheckLevel = "pass";
    let detail: string | undefined;
    const bitrateKbps = bitrate / 1000;
    if (bitrate === 0) {
      level = "warn";
      detail = "无法读取码率";
    } else if (bitrateKbps < 1000) {
      level = "warn";
      detail = "码率低于 1 Mbps, 画质可能较差";
    } else if (bitrateKbps > 50000) {
      level = "warn";
      detail = "码率超过 50 Mbps, 文件可能过大";
    }
    items.push({
      label: "码率",
      level,
      value: bitrate > 0 ? `${(bitrateKbps / 1000).toFixed(1)} Mbps` : "未知",
      detail,
    });
  }

  // ── 6. 音画同步偏差 ──
  {
    let level: CheckLevel = "pass";
    let detail: string | undefined;
    if (!audioStream) {
      level = "fail";
      detail = "无音频轨道";
      items.push({ label: "音画同步", level, value: "无音频", detail });
    } else {
      const videoDur = Number(videoStream?.duration ?? probe.format.duration ?? 0);
      const audioDur = Number(audioStream.duration ?? probe.format.duration ?? 0);
      const delta = Math.abs(videoDur - audioDur);
      if (delta > 2) {
        level = "fail";
        detail = `音视频时长偏差 ${delta.toFixed(1)}s, 可能不同步`;
      } else if (delta > 0.5) {
        level = "warn";
        detail = `音视频时长偏差 ${delta.toFixed(2)}s`;
      }
      items.push({
        label: "音画同步",
        level,
        value: delta < 0.01 ? "同步" : `偏差 ${delta.toFixed(2)}s`,
        detail,
      });
    }
  }

  // ── 7. 字幕检查 (BUG-54: 缓存结果复用) ──
  const subInfo = await checkSubtitles(composeDir);
  {
    let level: CheckLevel = "pass";
    let detail: string | undefined;
    if (!subInfo.exists) {
      level = "warn";
      detail = "未找到字幕文件";
    } else if (subInfo.count === 0) {
      level = "warn";
      detail = "字幕文件为空";
    } else if (subInfo.maxGap > 10) {
      level = "warn";
      detail = `最大字幕间隔 ${subInfo.maxGap.toFixed(1)}s, 观众可能在此处流失`;
    }
    items.push({
      label: "字幕",
      level,
      value: subInfo.exists ? `${subInfo.count} 条字幕` : "无字幕",
      detail,
    });
  }

  // ── 8. 预计完播率 ──
  const completionRate = estimateCompletionRate(durationSec, subInfo.count, subInfo.maxGap);
  {
    let level: CheckLevel = "pass";
    if (completionRate < 40) level = "fail";
    else if (completionRate < 60) level = "warn";
    items.push({
      label: "预计完播率",
      level,
      value: `${completionRate}%`,
      detail: completionRate < 50 ? "时长或节奏可能影响完播" : undefined,
    });
  }

  return buildReport(items);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function buildReport(items: QualityCheckItem[]): OutputQualityReport {
  const has_red = items.some((i) => i.level === "fail");
  const has_yellow = items.some((i) => i.level === "warn");
  const completionItem = items.find((i) => i.label === "预计完播率");
  const estimated_completion_rate = completionItem
    ? parseInt(completionItem.value, 10) || 0
    : 0;
  return {
    checked_at: new Date().toISOString(),
    items,
    has_red,
    has_yellow,
    estimated_completion_rate,
  };
}
