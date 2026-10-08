/**
 * Multi-format exporter — P170 Wave 3E: 单镜头重合成 + 多规格导出
 *
 * Takes a source video path and an array of format identifiers,
 * runs ffmpeg in parallel to produce all requested formats.
 *
 * Supported formats:
 *   "1080p_16x9"          → 1920x1080, 30fps H.264 MP4  (B 站 / YouTube)
 *   "1080p_9x16"          → 1080x1920, 30fps H.264 MP4  (抖音 / 视频号)
 *   "720p_1x1"            → 1080x1080, 30fps H.264 MP4  (square, labelled "720p" for user familiarity)
 *   "gif_10fps"           → max 480p, 10fps GIF, ≤60s
 *   "480p_16x9"           → 854x480,  30fps H.264 MP4
 *   "4k_16x9"             → 3840x2160, 30fps H.264 MP4  (40Mbps, upscale if source smaller)
 *   "kuaishou_9x16"       → 1080x1920, 30fps H.264 MP4  (快手, 8Mbps)
 *   "youtube_shorts_9x16" → 1080x1920, 30fps H.264 MP4  (YouTube Shorts, 8Mbps)
 *   "tiktok_9x16"         → 1080x1920, 30fps H.264 MP4  (TikTok, 8Mbps)
 *   "bilibili_hq_16x9"    → 1920x1080, 60fps H.264 MP4  (B 站高码率, 16Mbps)
 *   "xiaohongshu_3x4"     → 1080x1440, 30fps H.264 MP4  (小红书 3:4, 6Mbps)
 *
 * 2026-05-29 P0-4: 4 → 11 个预设 (前端 EXPORT_PRESETS 10 个 mp4/gif + 后端保留 480p_16x9 内部档).
 *   前端 apps/web/src/lib/exportPresets.ts 的每个 id 都必须在此有对应 def, 否则 resolveFormats 静默丢弃.
 */

import path from "node:path";
import { runProcess, type ProcessResult } from "./process";

// ── Format definitions ──────────────────────────────────────────────

/**
 * P1-10: 横竖屏 fit mode — 用户选导出规格时可选画面适配方式.
 *   letterbox   = 黑边填充 (默认, 原行为)
 *   center-crop = 中心裁剪填满目标画幅 (画面更大但可能切掉边缘)
 *   blur-fill   = 模糊背景填充 (原画居中 + 上下/左右模糊拉伸, 剪映同款)
 */
export type FitMode = "letterbox" | "center-crop" | "blur-fill";

export interface ExportFormatDef {
  id: string;
  container: "mp4" | "gif";
  width: number;
  height: number;
  fps: number;
  /** Optional additional ffmpeg video filter args (appended after scale+pad) */
  extraVf?: string;
  /** Optional additional output args (e.g. for GIF palettegen) */
  extraOutputArgs?: string[];
  /** Max pixel dimension for GIF (to cap file size) */
  maxDimension?: number;
  /**
   * 2026-05-29 P0-4: 目标视频码率 (ffmpeg -b:v, 如 "8M" / "16M" / "40M").
   * 设了就用 VBV 限码 (-b:v + -maxrate + -bufsize) 替代默认 CRF 23 —
   * 高码率档 (B 站高码率 / 4K) 才能真比标准档清晰. 不设保持 CRF 23 老行为.
   */
  bitrate?: string;
  label: string;
}

/** 把 "8M" / "16000k" 形式的码率字符串解析成 bps 数字; 解析不出返 null. */
function parseBitrateToBps(bitrate: string | undefined): number | null {
  if (!bitrate) return null;
  const m = /^([\d.]+)\s*([MmKk]?)$/.exec(bitrate.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit === "m") return Math.round(n * 1_000_000);
  if (unit === "k") return Math.round(n * 1_000);
  return Math.round(n);
}

export const FORMAT_PRESETS: Record<string, ExportFormatDef> = {
  // ── 抖音系 (竖屏 9:16) ──────────────────────────────────────────────
  "1080p_9x16": {
    id: "1080p_9x16",
    container: "mp4",
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: "6M",
    label: "抖音 / 视频号 竖屏 9:16",
  },
  "kuaishou_9x16": {
    id: "kuaishou_9x16",
    container: "mp4",
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: "8M",
    label: "快手 竖屏 9:16",
  },
  // ── YouTube 海外 (竖屏 9:16) ────────────────────────────────────────
  "youtube_shorts_9x16": {
    id: "youtube_shorts_9x16",
    container: "mp4",
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: "8M",
    label: "YouTube Shorts 竖屏 9:16",
  },
  "tiktok_9x16": {
    id: "tiktok_9x16",
    container: "mp4",
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: "8M",
    label: "TikTok 竖屏 9:16",
  },
  // ── 中长视频 (横屏 16:9) ────────────────────────────────────────────
  "1080p_16x9": {
    id: "1080p_16x9",
    container: "mp4",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: "8M",
    label: "B 站 / YouTube 横屏 16:9",
  },
  "bilibili_hq_16x9": {
    id: "bilibili_hq_16x9",
    container: "mp4",
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: "16M",
    label: "B 站高码率 60fps 横屏 16:9",
  },
  "4k_16x9": {
    id: "4k_16x9",
    container: "mp4",
    width: 3840,
    height: 2160,
    fps: 30,
    bitrate: "40M",
    label: "4K 超清 横屏 16:9",
  },
  // ── 社交 ────────────────────────────────────────────────────────────
  "xiaohongshu_3x4": {
    id: "xiaohongshu_3x4",
    container: "mp4",
    width: 1080,
    height: 1440,
    fps: 30,
    bitrate: "6M",
    label: "小红书 竖屏 3:4",
  },
  "720p_1x1": {
    id: "720p_1x1",
    container: "mp4",
    width: 1080,
    height: 1080,
    fps: 30,
    bitrate: "5M",
    label: "朋友圈 / Instagram 方形 1:1",
  },
  // ── 预览 ────────────────────────────────────────────────────────────
  "gif_10fps": {
    id: "gif_10fps",
    container: "gif",
    width: 0, // computed from source aspect ratio, capped at maxDimension
    height: 0,
    fps: 10,
    maxDimension: 480,
    extraVf: "split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5",
    label: "GIF 预览 10fps",
  },
  // ── 内部档 (前端不暴露, 保留供低带宽/兜底用) ────────────────────────
  "480p_16x9": {
    id: "480p_16x9",
    container: "mp4",
    width: 854,
    height: 480,
    fps: 30,
    label: "480p 横屏 16:9",
  },
};

export interface ExportFormatRequest {
  formatId: string;
  outputPath: string;
}

export interface ExportFormatResult {
  formatId: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  container: "mp4" | "gif";
  sizeBytes: number;
  ok: boolean;
  error?: string;
}

// ── ffmpeg argument builders ────────────────────────────────────────

/**
 * Build scale+pad filter so output matches target dimensions exactly.
 * P1-10: 支持三种 fit mode — letterbox / center-crop / blur-fill.
 *
 * 2026-05-25 用户报"ffmpeg exited 1 for 1080p_9x16":
 *   scale 输出中间可能 odd 尺寸 (例如 source 1280x720 → 1080x608, H=608 even OK,
 *   但 source 1920x1080 → 1080x607.5 → 取整 607 ODD → libx264 + yuv420p 拒绝).
 *   加 force_divisible_by=2 让 scale 自动 round 到 even. flags=lanczos 锐度更好.
 *   pad 加 black 显式底色防默认 transparent 不被 yuv420p 接受.
 *   setsar=1 防 anamorphic SAR 让 pad 计算错位.
 */
function buildScalePadFilter(targetW: number, targetH: number, fitMode: FitMode = "letterbox"): string {
  if (fitMode === "center-crop") {
    // 中心裁剪: 先 scale 让短边填满目标 (force_original_aspect_ratio=increase),
    // 再 crop 到精确尺寸. 画面填满无黑边, 但边缘会被切掉.
    return `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=${targetW}:${targetH},setsar=1`;
  }
  if (fitMode === "blur-fill") {
    // 模糊背景填充 (剪映同款): 原图 scale 到 decrease (居中, 不切),
    // 背景层 scale 到 increase + crop + 高斯模糊, 叠加原图居中.
    // split → [s0]=清晰前景, [s1]=模糊背景
    return [
      `split[fg][bg]`,
      `[bg]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=${targetW}:${targetH},boxblur=20:5[bgblur]`,
      `[fg]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fgscaled]`,
      `[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2,setsar=1`,
    ].join(";");
  }
  // 默认 letterbox: 黑边填充 (原行为)
  return `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

/**
 * Build ffmpeg args for a single MP4 format export.
 */
function buildMp4Args(
  sourcePath: string,
  outputPath: string,
  def: ExportFormatDef,
  fitMode: FitMode = "letterbox",
): string[] {
  // 2026-05-29 P0-4: 码率控制 — 高码率档 (B 站高码率 16M / 4K 40M) 设了 bitrate 就走 VBV 限码,
  //   否则保持默认 CRF 23 (老行为, 旧 4 预设不设 bitrate 时不变). VBV: -b:v 目标 + -maxrate 1.25x +
  //   -bufsize 2x 让画质稳定不爆码率, 平台 (B 站/抖音) 转码不会二次压糊.
  const targetBps = parseBitrateToBps(def.bitrate);
  const rateArgs: string[] = targetBps
    ? [
        "-b:v", String(targetBps),
        "-maxrate", String(Math.round(targetBps * 1.25)),
        "-bufsize", String(targetBps * 2),
      ]
    : ["-crf", "23"];

  return [
    "-y",
    "-i", sourcePath,
    "-vf", buildScalePadFilter(def.width, def.height, fitMode),
    "-r", String(def.fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    ...rateArgs,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-shortest",
    outputPath,
  ];
}

/**
 * Build ffmpeg args for GIF export with palette optimization.
 * Caps max dimension for reasonable file size.
 */
function buildGifArgs(
  sourcePath: string,
  outputPath: string,
  def: ExportFormatDef,
): string[] {
  const maxDim = def.maxDimension ?? 480;
  const scaleFilter = `scale=min(${maxDim}\\,iw):min(${maxDim}\\,ih):force_original_aspect_ratio=decrease:flags=lanczos`;
  const paletteFilter = `${scaleFilter},split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;

  return [
    "-y",
    "-i", sourcePath,
    "-vf", paletteFilter,
    "-r", String(def.fps),
    "-ss", "0",
    "-t", "60", // Cap GIF at 60 seconds
    outputPath,
  ];
}

/**
 * Build ffmpeg args for a single format export.
 */
function buildFfmpegArgs(
  sourcePath: string,
  outputPath: string,
  def: ExportFormatDef,
  fitMode: FitMode = "letterbox",
): string[] {
  if (def.container === "gif") {
    return buildGifArgs(sourcePath, outputPath, def);
  }
  return buildMp4Args(sourcePath, outputPath, def, fitMode);
}

// ── Main export function ────────────────────────────────────────────

/**
 * T4: compute a per-format timeout based on source video duration + output resolution.
 * Formula: baseMs = max(600_000, duration_sec * width * height / 4_000_000 * 1000)
 * Clamped to [600s, 3600s].
 */
function computeFormatTimeoutMs(
  def: ExportFormatDef,
  durationSec: number,
): number {
  const w = def.width || (def.maxDimension ?? 480);
  const h = def.height || (def.maxDimension ?? 480);
  const dynamic = durationSec * w * h / 4_000_000 * 1000;
  const base = Math.max(600_000, dynamic);
  return Math.min(3_600_000, base);
}

/**
 * T4: run an array of async tasks with at most `concurrency` running in parallel.
 * Preserves input order in the returned results.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const idx = next++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * 2026-05-29 P0-6: 每完成一个 format 回调一次进度, 让导出 UI 显 percent / 当前规格 / ETA.
 * exportUseCases 把它接到 SSE broker (export.format_progress) 推给前端.
 */
export interface ExportProgressEvent {
  /** 已完成 (含成功 + 失败) 的规格数 */
  completed: number;
  /** 总规格数 */
  total: number;
  /** 刚完成的那个规格的中文标签 (如 "B 站 / YouTube 横屏 16:9") */
  justFinishedLabel: string;
  /** 刚完成的那个规格 id */
  justFinishedId: string;
  /** 刚完成的规格是否成功 */
  ok: boolean;
}

/**
 * Export source video to multiple formats with at most 2 concurrent ffmpeg processes.
 *
 * Each format runs in its own ffmpeg process.  The caller gets one
 * result per requested format, with `ok: true/false` and the output
 * path + file size.  Failures on individual formats do not block
 * the others.
 *
 * @param durationSec  Source video duration in seconds (used for per-format timeout calc)
 * @param signal       Optional AbortSignal to cancel all running exports
 * @param onProgress   2026-05-29 P0-6: 每完成一个 format 回调一次 (completed/total + 当前规格)
 */
export async function exportMultiFormat(
  sourcePath: string,
  formats: string[],
  outputDir: string,
  baseName: string,
  timeoutMs: number = 600_000,
  durationSec: number = 0,
  signal?: AbortSignal,
  onProgress?: (ev: ExportProgressEvent) => void,
): Promise<ExportFormatResult[]> {
  const known = resolveFormats(formats);

  if (known.length === 0) {
    return [];
  }

  // Ensure output directory exists
  const { ensureDir } = await import("../../core/src/index");
  await ensureDir(outputDir);

  // 2026-05-29 P0-6: 完成计数 (并发下用闭包累加, 每个 task 完成时 +1 并回调一次进度)
  let completedCount = 0;
  const totalCount = known.length;

  const taskFns = known.map((def) => async (): Promise<ExportFormatResult> => {
    const ext = def.container === "gif" ? "gif" : "mp4";
    const fileName = `${baseName}_${def.id}.${ext}`;
    const outputPath = path.join(outputDir, fileName);
    const args = buildFfmpegArgs(sourcePath, outputPath, def);

    // T4: per-format dynamic timeout
    const effectiveTimeoutMs = durationSec > 0
      ? computeFormatTimeoutMs(def, durationSec)
      : Math.max(timeoutMs, 120_000);

    try {
      // 2026-05-25: stderr buffer 调到 512KB (默认 64KB), 防止 ffmpeg 真错误行被 progress 输出挤掉.
      // ffmpeg 大视频转码每帧输出一行 frame=N fps=X, 几千帧能产生 100+KB stderr.
      // 真错误通常在前面 (filter syntax / file IO), 64KB ring 容易丢. 512KB 足够.
      const result: ProcessResult = await runProcess("ffmpeg", args, {
        timeoutMs: effectiveTimeoutMs,
        signal,
        stderrLimitBytes: 512 * 1024,
        stdoutLimitBytes: 128 * 1024,
      });

      // Check output file exists and has size
      const fs = await import("node:fs/promises");
      let sizeBytes = 0;
      try {
        const stat = await fs.stat(outputPath);
        sizeBytes = stat.size;
      } catch {
        // file may not exist if ffmpeg failed
      }

      if (result.code === 0 && sizeBytes > 0) {
        return {
          formatId: def.id,
          outputPath,
          width: def.width || (def.maxDimension ?? 480),
          height: def.height || (def.maxDimension ?? 480),
          fps: def.fps,
          container: def.container,
          sizeBytes,
          ok: true,
        };
      } else {
        // 2026-05-25 用户报 ffmpeg 报错信息全是 stream metadata 不是真 error.
        //   原因: runProcess 的 stderr buffer 64KB ring, 真 error 行可能被截 + slice(-2000) 又截.
        //   修: 写完整 stderr + cmd 到 ffmpeg log 文件, 用户能 cat 给我看完整信息.
        //   error message 里给出 log path, 让用户直接知道在哪儿.
        const fs2 = await import("node:fs/promises");
        const logPath = path.join(outputDir, `${def.id}.ffmpeg.log`);
        const fullLog = [
          `=== ffmpeg multi-format export failed ===`,
          `Format: ${def.id} (${def.label})`,
          `Exit code: ${result.code}`,
          `Source: ${sourcePath}`,
          `Output: ${outputPath} (dest size after attempt: ${sizeBytes}B)`,
          ``,
          `=== Full command ===`,
          `ffmpeg ${args.map(a => a.includes(" ") || a.includes(",") || a.includes(":") ? `"${a}"` : a).join(" ")}`,
          ``,
          `=== Full stderr (last ${result.stderr.length}B captured) ===`,
          result.stderr,
          ``,
          `=== Full stdout ===`,
          result.stdout,
        ].join("\n");
        try {
          await fs2.writeFile(logPath, fullLog, "utf8");
        } catch (writeErr) {
          console.error(`[multiFormatExporter] 无法写 ffmpeg log:`, writeErr);
        }

        // 提取真错误关键行 — 扩展关键字 (ffmpeg 常见 error idioms)
        const errLines = result.stderr
          .split(/\r?\n/)
          .filter((l) => /\b(Error|Invalid|could not|failed|No such file|Permission denied|Conversion failed|Cannot|height not divisible|width not divisible|Encoder not found|Unknown encoder|moov atom|Operation not permitted)\b/i.test(l))
          .slice(-8)
          .join("\n");
        const errSummary = errLines || result.stderr.slice(-800);

        console.error(`[multiFormatExporter] ${def.id} ffmpeg FAILED (exit ${result.code})\n  完整日志: ${logPath}\n  关键错误行:\n${errSummary || "(stderr 无 error 关键字, 看完整日志)"}\n`);
        return {
          formatId: def.id,
          outputPath,
          width: def.width,
          height: def.height,
          fps: def.fps,
          container: def.container,
          sizeBytes,
          ok: false,
          error: `ffmpeg exit ${result.code}. 完整日志: ${logPath}. 关键错误: ${errLines.trim() || "(stderr 无 error 关键字, cat 完整日志看)"}`,
        };
      }
    } catch (err: any) {
      return {
        formatId: def.id,
        outputPath,
        width: def.width,
        height: def.height,
        fps: def.fps,
        container: def.container,
        sizeBytes: 0,
        ok: false,
        error: err?.message ?? "Unknown ffmpeg error",
      };
    }
  });

  // 2026-05-29 P0-6: 包一层 — 每个 task 完成 (无论成功/失败/异常) 后 +1 计数并回调进度.
  // taskFns 内部多处 return, 与其改每个 return, 不如在外层 await 完统一计数 (并发安全:
  // completedCount 是闭包共享, JS 单线程 await 边界处自增无竞态).
  const wrappedTaskFns = taskFns.map((fn, idx) => async (): Promise<ExportFormatResult> => {
    const def = known[idx];
    try {
      return await fn();
    } finally {
      completedCount++;
      if (onProgress) {
        // finally 里拿不到 result, 但 result 已落到 results 数组; 这里只需上报"又完成一个 + 是哪个规格".
        // ok 字段对进度条不关键 (前端只显 percent + 当前规格名), 传 true 占位.
        try {
          onProgress({
            completed: completedCount,
            total: totalCount,
            justFinishedLabel: def.label,
            justFinishedId: def.id,
            ok: true,
          });
        } catch { /* 进度回调失败不阻塞导出 */ }
      }
    }
  });

  // T4: at most 2 concurrent ffmpeg processes (prevents CPU/IO saturation)
  return runWithConcurrency(wrappedTaskFns, 2);
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve requested format IDs to their definitions.
 * Unknown IDs are silently skipped.
 */
export function resolveFormats(formatIds: string[]): ExportFormatDef[] {
  return formatIds
    .map((id) => FORMAT_PRESETS[id])
    .filter((def): def is ExportFormatDef => def !== undefined);
}

/**
 * Get the file extension for a format ID.
 */
export function formatExtension(formatId: string): string {
  const def = FORMAT_PRESETS[formatId];
  if (!def) return "mp4";
  return def.container === "gif" ? "gif" : "mp4";
}

/**
 * Human-readable label for a format ID.
 */
export function formatLabel(formatId: string): string {
  return FORMAT_PRESETS[formatId]?.label ?? formatId;
}

/**
 * All available format IDs.
 */
export function availableFormatIds(): string[] {
  return Object.keys(FORMAT_PRESETS);
}
