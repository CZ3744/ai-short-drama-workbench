/**
 * B1: ffprobe 真视频校验
 *
 * 校验 provider 返回的视频 buffer 为有效 mp4:
 * - 至少一个 codec_type=video stream
 * - duration > 0s (若提供 expectedDurationSec 则偏差 <= 2s)
 * - width >= 360, height >= 360 (太小的一定是损坏)
 * - width/height 比例与期望 aspect_ratio 偏差 <= 8%
 */

import { spawn } from "node:child_process";
import { killProcessTree } from "./process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FfprobeStream {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

export interface FfprobeOutput {
  streams: FfprobeStream[];
}

export interface VideoProbeResult {
  width: number;
  height: number;
  duration_sec: number;
  has_video_stream: boolean;
  /** 原始 ffprobe streams (调试用) */
  streams: FfprobeStream[];
}

export interface ValidateVideoResult {
  ok: boolean;
  /** ffprobe 探测结果 */
  probe: VideoProbeResult;
  /** 实际 aspect_ratio (宽/高) */
  actualAspectRatio: number;
  /** 期望 aspect_ratio (宽/高) */
  expectedAspectRatio: number;
  /** 比例偏差 (0-1) */
  aspectRatioDeviation: number;
  /** 失败原因列表 (ok=false 时非空) */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Aspect ratio helpers
// ---------------------------------------------------------------------------

const ASPECT_RATIO_MAP: Record<string, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
};

function parseAspectRatio(ar: string): number {
  return ASPECT_RATIO_MAP[ar] ?? 16 / 9;
}

// ---------------------------------------------------------------------------
// ffprobe runner
// ---------------------------------------------------------------------------

/**
 * 对指定文件路径运行 ffprobe，返回 streams 信息的解析结果。
 * 超时 30s。支持 64KB ring buffer 与外部 AbortSignal。
 */
export function runFfprobe(filePath: string, signal?: AbortSignal): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    // T2: abort immediately if already signalled
    if (signal?.aborted) {
      reject(new Error("ffprobe aborted before spawn"));
      return;
    }

    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height,duration,r_frame_rate,avg_frame_rate",
      "-of", "json",
      filePath,
    ], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });

    // T2: 64KB ring buffer for stdout / stderr (prevents OOM on large outputs)
    const BUF_LIMIT = 64 * 1024;
    const appendBounded = (cur: string, chunk: string): string => {
      const next = cur + chunk;
      return next.length > BUF_LIMIT ? next.slice(next.length - BUF_LIMIT) : next;
    };
    let stdout = "";
    let stderr = "";
    let killed = false;

    child.stdout.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk.toString()); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk.toString()); });

    const killChild = (reason: string) => {
      if (killed) return;
      killed = true;
      if (child.pid !== undefined) void killProcessTree(child.pid); // XT-T2: tree-kill
      reject(new Error(reason));
    };

    // T2: external AbortSignal support
    const abortHandler = () => killChild("ffprobe aborted via AbortSignal");
    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    const timer = setTimeout(() => killChild("ffprobe timeout (30s)"), 30_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortHandler);
      if (killed) return; // already rejected via abort/timeout
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
      if (signal) signal.removeEventListener("abort", abortHandler);
      if (killed) return;
      reject(new Error(`ffprobe spawn error: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Probe from file path
// ---------------------------------------------------------------------------

/**
 * 对视频文件执行 ffprobe 并提取结构化 VideoProbeResult。
 */
export async function probeVideoFile(filePath: string, signal?: AbortSignal): Promise<VideoProbeResult> {
  const output = await runFfprobe(filePath, signal);

  const videoStream = output.streams.find((s) => s.codec_type === "video");
  const width = videoStream?.width ?? 0;
  const height = videoStream?.height ?? 0;
  const duration = videoStream?.duration ?? "0";
  const durationSec = parseFloat(duration) || 0;
  const hasVideoStream = !!videoStream;

  return { width, height, duration_sec: durationSec, has_video_stream: hasVideoStream, streams: output.streams };
}

// ---------------------------------------------------------------------------
// Full B1 validation
// ---------------------------------------------------------------------------

/**
 * 对已写入磁盘的视频文件执行 B1 完整校验。
 *
 * @param filePath   视频文件绝对路径
 * @param expectedAspectRatio  期望 aspect_ratio 字符串, e.g. "16:9"
 * @returns ValidateVideoResult
 */
export async function validateVideoFile(
  filePath: string,
  expectedAspectRatio: string = "16:9",
  expectedDurationSec?: number,
): Promise<ValidateVideoResult> {
  const expectedRatio = parseAspectRatio(expectedAspectRatio);
  const errors: string[] = [];

  let probe: VideoProbeResult;
  try {
    probe = await probeVideoFile(filePath);
  } catch (err) {
    return {
      ok: false,
      probe: { width: 0, height: 0, duration_sec: 0, has_video_stream: false, streams: [] },
      actualAspectRatio: 0,
      expectedAspectRatio: expectedRatio,
      aspectRatioDeviation: 1,
      errors: [`ffprobe 执行失败: ${(err as Error).message}`],
    };
  }

  // Check 1: 至少一个 video stream
  if (!probe.has_video_stream) {
    errors.push("无 video stream");
  }

  // Check 2: duration > 0；若提供期望时长则放宽容差到 ±2s
  if (probe.duration_sec <= 0) {
    errors.push(`duration 无效: ${probe.duration_sec.toFixed(2)}s (需要 > 0s)`);
  } else if (expectedDurationSec !== undefined && Math.abs(probe.duration_sec - expectedDurationSec) > 2) {
    errors.push(
      `duration 偏差: 实际 ${probe.duration_sec.toFixed(2)}s vs 期望 ${expectedDurationSec}s，容差 ±2s（偏差 ${Math.abs(probe.duration_sec - expectedDurationSec).toFixed(2)}s）`,
    );
  }

  // Check 3: width >= 360 且 height >= 360 (太小的一定是损坏)
  if (probe.width < 360 || probe.height < 360) {
    errors.push(`分辨率过小(损坏): ${probe.width}x${probe.height}（需要 >= 360x360）`);
  }

  // Check 4: width/height 比例与期望 aspect_ratio 偏差 <= 8%
  let actualAspectRatio = 0;
  let deviation = 0;
  if (probe.width >= 360 && probe.height >= 360) {
    actualAspectRatio = probe.width / probe.height;
    deviation = Math.abs(actualAspectRatio - expectedRatio) / expectedRatio;
    if (deviation > 0.08) {
      errors.push(
        `aspect_ratio 偏差过大: 实际 ${probe.width}x${probe.height} (ratio=${actualAspectRatio.toFixed(4)}) vs 期望 ${expectedAspectRatio} (ratio=${expectedRatio.toFixed(4)})，偏差 ${(deviation * 100).toFixed(1)}%，容差 8%`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    probe,
    actualAspectRatio,
    expectedAspectRatio: expectedRatio,
    aspectRatioDeviation: deviation,
    errors,
  };
}
