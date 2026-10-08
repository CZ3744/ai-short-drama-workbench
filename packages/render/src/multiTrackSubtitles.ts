// W7 Phase 3: 多轨字幕(multi-track subtitles)
//
// ASS Layer 0/1/2 多层字幕生成 + 烧录 helper。
//
// Layer 0 — 主字幕(对白 + 旁白合并,底部居中,大字号)
// Layer 1 — 辅助字幕(注释 / 翻译,顶部居中,中字号)
// Layer 2 — 角标(右下角持续显示,如 "第 1 集",小字号)
//
// 主字幕一般从 SRT 转 ASS 而来(burnSubtitles 默认行为)。
// 多轨字幕走本模块 — 调用方先 buildMultiTrackAss → 落盘 .ass → burnMultiTrackAss 烧进 mp4。

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { ulid } from "ulid";
import { killProcessTree, registerChildProcess } from "./process";

export type SubtitleLayer = 0 | 1 | 2;
export type SubtitleAnimation = "none" | "fade_in" | "typewriter";

export interface SubtitleTrackInput {
  layer: SubtitleLayer;
  /** ASS Dialogue 行的内容(已 sanitized,不含 { } \) */
  text: string;
  /** 起始时间(秒) */
  startSec: number;
  /** 结束时间(秒) */
  endSec: number;
  /** 关联 shot id(留作 debugging) */
  shot_id?: string;
}

export interface MultiTrackAssInput {
  /** 视频宽度(用于 ASS PlayResX) */
  width: number;
  /** 视频高度(用于 ASS PlayResY) */
  height: number;
  tracks: SubtitleTrackInput[];
  /** 主字幕动画；注释和角标保持静态，避免干扰阅读 */
  animation?: SubtitleAnimation | string;
  /** 主字幕底部安全区比例；竖屏默认 20%、横屏默认 5%。 */
  safeZoneBottomPct?: number;
}

/** 跨平台字体 fallback 链: Windows → macOS → Linux → 通用 */
const FONT_FAMILY = "Microsoft YaHei, PingFang SC, WenQuanYi Micro Hei, DejaVu Sans";

/** ASS Layer → Style 名 — 与 STYLES 字典 key 一一对应 */
const STYLE_BY_LAYER: Record<SubtitleLayer, string> = {
  0: "MainDialog",
  1: "Note",
  2: "Watermark",
};

/**
 * Layer 对应的 ASS Style 定义(V4+ Styles 段)。
 * 颜色格式: &Hbbggrr (ASS 是 BGR 不是 RGB)
 *
 * Alignment 编号(numpad):
 *  7 8 9     ← 顶部 左/中/右
 *  4 5 6     ← 中部 左/中/右
 *  1 2 3     ← 底部 左/中/右
 */
const STYLE_DEFS: Record<SubtitleLayer, string> = {
  // 主字幕 — 底部居中(2)、大字号、白色 + 黑描边
  0: `Style: MainDialog,${FONT_FAMILY},56,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,2,30,30,60,1`,
  // 辅助字幕 — 顶部居中(8)、中字号、黄色 + 黑描边
  1: `Style: Note,${FONT_FAMILY},32,&H0000F0FF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,30,30,40,1`,
  // 角标 — 右下(3)、小字号、半透明白色
  2: `Style: Watermark,${FONT_FAMILY},24,&H80FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,3,20,20,20,1`,
};

function formatAssTime(sec: number): string {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * 把多轨 SubtitleTrackInput 编译为合法 ASS 文档。
 *
 * 输出格式:
 *   [Script Info]
 *   ...
 *   [V4+ Styles]
 *   Style: MainDialog, ...
 *   Style: Note, ...
 *   Style: Watermark, ...
 *
 *   [Events]
 *   Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
 *   Dialogue: 0,0:00:00.00,0:00:05.00,MainDialog,,0,0,0,,主字幕内容
 *   Dialogue: 1,0:00:00.00,0:00:05.00,Note,,0,0,0,,注释内容
 *   Dialogue: 2,0:00:00.00,0:00:30.00,Watermark,,0,0,0,,第 1 集
 */
export function buildMultiTrackAss(input: MultiTrackAssInput): string {
  const { width, height, tracks } = input;
  const animation: SubtitleAnimation =
    input.animation === "fade_in" || input.animation === "typewriter" ? input.animation : "none";
  const mainMarginV = Math.max(20, Math.round(height * resolveSafeZoneBottomPct(width, height, input.safeZoneBottomPct) / 100));

  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "Collisions: Normal",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "Timer: 100.0000",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    withAssStyleMarginV(STYLE_DEFS[0], mainMarginV),
    STYLE_DEFS[1],
    STYLE_DEFS[2],
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  for (const track of tracks) {
    if (track.endSec <= track.startSec) continue;
    const styleName = STYLE_BY_LAYER[track.layer];
    const start = formatAssTime(track.startSec);
    const end = formatAssTime(track.endSec);
    // ASS Dialogue 第一个字段是 Layer 数字
    const safeText = applySubtitleAnimation(sanitizeAssText(track.text), track, animation, width, height);
    lines.push(`Dialogue: ${track.layer},${start},${end},${styleName},,0,0,0,,${safeText}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * 删除 ASS 控制字符,避免出乱码。
 * { } 与 \ 都是 ASS override 语法的控制符,必须清理。
 */
export function sanitizeAssText(text: string): string {
  return text
    .replace(/\\/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "\\N"); // ASS 内换行用 \N
}

/**
 * 便利函数:从 SRT-like segments + 可选 layer1 注释 + 可选 layer2 角标 一次构造多轨 ASS。
 */
export interface ConvenientMultiTrackInput {
  width: number;
  height: number;
  /** Layer 0 主字幕(对白/旁白) */
  mainDialog: Array<{ startSec: number; endSec: number; text: string; shot_id?: string }>;
  /** Layer 1 注释/翻译,可选 */
  notes?: Array<{ startSec: number; endSec: number; text: string; shot_id?: string }>;
  /** Layer 2 角标,固定文案 — 整集显示 */
  watermarkText?: string;
  /** Layer 2 整集时长(秒),需要 watermarkText 才用 */
  totalDurationSec?: number;
  /** Layer 0 主字幕动画 */
  animation?: SubtitleAnimation | string;
  /** 主字幕底部安全区比例 */
  safeZoneBottomPct?: number;
}

export function buildMultiTrackAssConvenient(input: ConvenientMultiTrackInput): string {
  const { width, height, mainDialog, notes = [], watermarkText, totalDurationSec } = input;
  const tracks: SubtitleTrackInput[] = [];

  for (const m of mainDialog) {
    tracks.push({ layer: 0, startSec: m.startSec, endSec: m.endSec, text: m.text, shot_id: m.shot_id });
  }
  for (const n of notes) {
    tracks.push({ layer: 1, startSec: n.startSec, endSec: n.endSec, text: n.text, shot_id: n.shot_id });
  }
  if (watermarkText && totalDurationSec && totalDurationSec > 0) {
    tracks.push({
      layer: 2,
      startSec: 0,
      endSec: totalDurationSec,
      text: watermarkText,
    });
  }

  return buildMultiTrackAss({
    width,
    height,
    tracks,
    animation: input.animation,
    safeZoneBottomPct: input.safeZoneBottomPct,
  });
}

function resolveSafeZoneBottomPct(width: number, height: number, explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.min(40, explicit));
  }
  if (width > height) return 5;
  if (width === height) return 12;
  return 20;
}

function withAssStyleMarginV(styleLine: string, marginV: number): string {
  const parts = styleLine.split(",");
  if (parts.length >= 23) {
    parts[21] = String(marginV);
    return parts.join(",");
  }
  return styleLine;
}

function applySubtitleAnimation(
  text: string,
  track: SubtitleTrackInput,
  animation: SubtitleAnimation,
  width: number,
  height: number,
): string {
  if (track.layer !== 0) return text;
  if (animation === "fade_in") return `{\\fad(180,80)}${text}`;
  if (animation === "typewriter") {
    const durationMs = Math.max(280, Math.min(1100, Math.round((track.endSec - track.startSec) * 1000 * 0.45)));
    return `{\\clip(0,0,0,${height})\\t(0,${durationMs},\\clip(0,0,${width},${height}))}${text}`;
  }
  return text;
}

// ─── ffmpeg burn helper ──────────────────────────────────────────────

export interface BurnMultiTrackAssInput {
  input_mp4: string;
  output_mp4: string;
  /** buildMultiTrackAss / buildMultiTrackAssConvenient 的输出字符串 */
  assContent: string;
  signal?: AbortSignal;
  /** 默认 600s */
  timeoutMs?: number;
}

/**
 * 把 ASS 多轨字幕烧进 mp4。
 * 与 burnSubtitles(SRT 路径)等价的"ASS 内嵌 style"版本 — 多 layer 字幕用这个。
 *
 * 实现要点:
 *   1. 把 assContent 写入 os.tmpdir()/<ulid>.ass(避免中文路径 ffmpeg filter 解析失败)
 *   2. spawn ffmpeg -vf ass='<abs ass>'
 *   3. 600s 硬上限 + AbortSignal 接通
 *   4. 失败 throw 友好 Error,不 silent fallback
 */
export async function burnMultiTrackAss(input: BurnMultiTrackAssInput): Promise<void> {
  const { input_mp4, output_mp4, assContent, signal, timeoutMs = 600_000 } = input;

  const resolvedInput = path.resolve(input_mp4);
  const resolvedOutput = path.resolve(output_mp4);
  await fs.access(resolvedInput);
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });

  const assTmp = path.join(os.tmpdir(), `${ulid()}.ass`);
  await fs.writeFile(assTmp, assContent, "utf8");

  function escapeFilterPath(p: string): string {
    return p
      .replace(/\\/g, "/")
      .replace(/'/g, "\\'")
      .replace(/:/g, "\\:")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
      .replace(/,/g, "\\,");
  }
  const assEsc = escapeFilterPath(assTmp);

  const args: string[] = [
    "-y",
    "-i", resolvedInput,
    "-vf", `ass='${assEsc}'`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    resolvedOutput,
  ];

  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿

    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      if (child.pid !== undefined) void killProcessTree(child.pid); // X7-3: tree-kill
      reject(new Error(`多轨字幕烧录超时 (${Math.round(timeoutMs / 1000)}s): ${stderr.slice(-500)}`));
    }, timeoutMs);

    let killOnAbort: (() => void) | null = null;
    if (signal) {
      killOnAbort = () => {
        if (child.pid !== undefined) void killProcessTree(child.pid); // X7-3: tree-kill
      };
      signal.addEventListener("abort", killOnAbort, { once: true });
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 64_000) {
        stderr = stderr.slice(-32_000);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      fs.unlink(assTmp).catch(() => { /* swallow */ });
      if (signal && killOnAbort) signal.removeEventListener("abort", killOnAbort);
      if (killed) return;
      if (signal?.aborted) {
        reject(new Error("多轨字幕烧录已取消"));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`多轨字幕烧录失败 (ffmpeg exit ${code}): ${stderr.slice(-500)}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      fs.unlink(assTmp).catch(() => { /* swallow */ });
      if (signal && killOnAbort) signal.removeEventListener("abort", killOnAbort);
      if (!killed) reject(new Error(`多轨字幕 ffmpeg 启动失败: ${err.message}`));
    });
  });
}
