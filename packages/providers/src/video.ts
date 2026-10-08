/** @deprecated Use video/*Provider wrappers with core/types VideoProvider interface instead */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, pathExists, readLocalSettings, getConfigValue, resolveVideoFormat, type JobLogger } from "../../core/src/index";

export type VideoProviderName = "local_mock_video" | "minimax_hailuo" | "aliyun_wan_t2v" | "future_api";

export interface ClipJobInput {
  assetPath: string;
  prompt: string;
  durationSec: number;
  aspectRatio?: string;
  resolution?: string;
  jobRoot?: string;
  sceneStableId?: string;
  outputPath?: string;
  dimensions?: { width: number; height: number };
  model?: string;
}

export interface CostEstimate {
  estimated_credits: number;
  estimated_usd: number;
  currency: string;
  notes: string;
}

export interface ClipJobResult {
  ok: boolean;
  providerJobId?: string;
  clipPath?: string;
  durationSec?: number;
  error?: string;
  error_type?: string;
  providerFileId?: string;
  videoWidth?: number;
  videoHeight?: number;
  bytes?: number;
  promptOriginalLength?: number;
  promptFinalLength?: number;
  rawStatusRedacted?: unknown;
  isRealVideo?: boolean;
  providerKind?: "real_video" | "local_mock";
  promptWasFallback?: boolean;
}

export interface ClipJobStatus {
  status: "queued" | "running" | "completed" | "failed";
  clipPath?: string;
  durationSec?: number;
  error?: string;
  error_type?: string;
}

export interface VideoProvider {
  id: string;
  label: string;
  submitTextToVideoClip(input: ClipJobInput): Promise<ClipJobResult>;
  submitImageToVideoClip?(input: ClipJobInput): Promise<ClipJobResult>;
  getJobStatus(providerJobId: string): Promise<ClipJobStatus>;
  downloadClip(providerJobId: string, outputPath: string): Promise<string>;
  cancelJob?(providerJobId: string): Promise<void>;
  estimateCost?(input: ClipJobInput): Promise<CostEstimate>;
}

// --- Generic command runner ---

export async function runCommand(command: string, args: string[], options?: { timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  // 默认 5 min 兜底, 任何 ffmpeg/python 调用都不能没有 timeout, 否则会卡死整个 job
  const effectiveTimeoutMs = options?.timeoutMs ?? 5 * 60_000;
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      stderr += `\n[timeout] Process killed after ${effectiveTimeoutMs}ms`;
    }, effectiveTimeoutMs);
    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? null : code, stdout, stderr });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${command} not found or failed to start` });
    });
  });
}

// --- Mock clip generation ---

export async function generateMockClip(
  assetPngPath: string,
  outputPath: string,
  durationSec: number,
  logger?: JobLogger,
  dimensions?: { width: number; height: number }
): Promise<{ ok: boolean; clipPath?: string; durationSec?: number; error?: string }> {
  if (!(await pathExists(assetPngPath))) {
    return { ok: false, error: `Asset not found: ${assetPngPath}` };
  }

  const w = dimensions?.width ?? 1920;
  const h = dimensions?.height ?? 1080;
  const res = `${w}x${h}`;

  await logger?.line(`[local_mock_video] Generating clip from ${assetPngPath}, duration ${durationSec}s, resolution ${res}`);

  const result = await runCommand("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", assetPngPath,
    "-t", durationSec.toFixed(3),
    "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,zoompan=z='min(zoom+0.0005,1.05)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${res}`,
    "-r", "30",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-an",
    "-movflags", "+faststart",
    outputPath
  ], { timeoutMs: 120000 });

  if (result.code !== 0) {
    return { ok: false, error: `FFmpeg failed: ${result.stderr.slice(-500)}` };
  }

  await logger?.line(`[local_mock_video] Clip ready: ${outputPath}`);
  return { ok: true, clipPath: outputPath, durationSec };
}

// --- Probe clip duration using ffprobe (NOT ffmpeg) ---

export async function probeClipDuration(filePath: string): Promise<number | null> {
  try {
    const result = await runCommand("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath
    ], { timeoutMs: 30000 });
    if (result.code !== 0) {
      console.warn(`[probeClipDuration] ffprobe failed for ${filePath}: ${result.stderr.slice(-200)}`);
      return null;
    }
    const val = parseFloat(result.stdout.trim());
    return Number.isFinite(val) ? val : null;
  } catch {
    console.warn(`[probeClipDuration] ffprobe not available, returning null`);
    return null;
  }
}

// --- In-memory job registry for LocalMockVideoProvider ---

interface MockJobRecord {
  providerJobId: string;
  clipPath: string;
  durationSec: number;
  status: "completed" | "failed";
  createdAt: number;
}

const mockJobRegistry = new Map<string, MockJobRecord>();

// --- LocalMockVideoProvider ---

export class LocalMockVideoProvider implements VideoProvider {
  id = "local_mock_video";
  label = "Local Mock Video (本地测试)";

  async submitTextToVideoClip(input: ClipJobInput): Promise<ClipJobResult> {
    // Use sceneStableId for output path if provided, otherwise use "mock"
    const sceneDir = input.sceneStableId || "mock";
    const clipsDir = input.outputPath
      ? path.dirname(input.outputPath)
      : input.jobRoot
        ? path.join(input.jobRoot, "clips", sceneDir)
        : path.join(path.dirname(input.assetPath), "..", "clips", sceneDir);
    await ensureDir(clipsDir);
    const clipFilename = input.outputPath
      ? path.basename(input.outputPath)
      : `clip_v${Date.now()}.mp4`;
    const outputPath = input.outputPath || path.join(clipsDir, clipFilename);

    const dims = input.dimensions ?? resolveVideoFormat({ resolution: input.resolution, aspectRatio: input.aspectRatio });
    const result = await generateMockClip(input.assetPath, outputPath, input.durationSec, undefined, dims);
    if (!result.ok || !result.clipPath) {
      return { ok: false, error: result.error || "Mock clip generation failed", error_type: "provider_job_failed" };
    }

    const actualDuration = await probeClipDuration(result.clipPath);
    const providerJobId = `local_mock_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    // Register job for later lookup
    mockJobRegistry.set(providerJobId, {
      providerJobId,
      clipPath: result.clipPath,
      durationSec: actualDuration ?? input.durationSec,
      status: "completed",
      createdAt: Date.now()
    });

    return {
      ok: true,
      providerJobId,
      clipPath: result.clipPath,
      durationSec: actualDuration ?? input.durationSec
    };
  }

  async submitImageToVideoClip(input: ClipJobInput): Promise<ClipJobResult> {
    return this.submitTextToVideoClip(input);
  }

  async getJobStatus(providerJobId: string): Promise<ClipJobStatus> {
    const job = mockJobRegistry.get(providerJobId);
    if (!job) {
      return { status: "failed", error: `Job ${providerJobId} not found`, error_type: "job_not_found" };
    }
    return {
      status: job.status,
      clipPath: job.clipPath,
      durationSec: job.durationSec
    };
  }

  async downloadClip(providerJobId: string, outputPath: string): Promise<string> {
    const job = mockJobRegistry.get(providerJobId);
    if (!job) {
      throw new Error(`Job ${providerJobId} not found in registry`);
    }
    if (!(await pathExists(job.clipPath))) {
      throw new Error(`Source clip not found: ${job.clipPath}`);
    }
    // If outputPath differs from clipPath, copy the file
    if (outputPath !== job.clipPath) {
      await ensureDir(path.dirname(outputPath));
      await fs.copyFile(job.clipPath, outputPath);
    }
    return outputPath;
  }

  async cancelJob(providerJobId: string): Promise<void> {
    // No-op for local mock
  }

  async estimateCost(input: ClipJobInput): Promise<CostEstimate> {
    return {
      estimated_credits: 0,
      estimated_usd: 0,
      currency: "free",
      notes: "Local mock video, no cost"
    };
  }
}

// --- RealVideoApiTemplateProvider (skeleton for future real API) ---
//
// @deprecated 本类是空壳占位，不含任何真实 API 调用。
// 对应 provider id: "future_api"。当前通过 clipRoutes.ts 的 CLIP_ALLOWED_STATIC 白名单
// 进入，但所有方法均抛出 "未实现" 错误，防止 silent fallback。
// 如需接入真实 API，请新建专用 Provider 类（参考 jimengVideo.ts / klingVideo.ts）。
// 接入完成前严禁将此 provider 的 preset enabled 设为 true。

export class RealVideoApiTemplateProvider implements VideoProvider {
  id = "future_api";
  label = "Real Video API (待接入)";
  private config: Record<string, string>;

  constructor(config: Record<string, string> = {}) {
    this.config = config;
  }

  async submitTextToVideoClip(_input: ClipJobInput): Promise<ClipJobResult> {
    const apiKey = this.config.VIDEO_API_KEY || process.env.VIDEO_API_KEY;
    const baseUrl = this.config.VIDEO_API_BASE_URL || process.env.VIDEO_API_BASE_URL;
    if (!apiKey) return { ok: false, error: "VIDEO_API_KEY not configured", error_type: "key_missing" };
    if (!baseUrl) return { ok: false, error: "VIDEO_API_BASE_URL not configured", error_type: "endpoint_not_found" };
    // 明确 throw，禁止 silent stub 流向用户
    throw new Error("future_api: 真实 API 尚未实现。请联系开发者接入具体 provider，不要绕过此报错。");
  }

  async submitImageToVideoClip(_input: ClipJobInput): Promise<ClipJobResult> {
    throw new Error("future_api: 图转视频尚未实现。请联系开发者接入具体 provider，不要绕过此报错。");
  }

  async getJobStatus(_providerJobId: string): Promise<ClipJobStatus> {
    throw new Error("future_api: 任务状态查询尚未实现。");
  }

  async downloadClip(_providerJobId: string, _outputPath: string): Promise<string> {
    throw new Error("future_api: 视频下载尚未实现。");
  }

  async cancelJob(_providerJobId: string): Promise<void> {
    throw new Error("future_api: 取消任务尚未实现。");
  }

  async estimateCost(_input: ClipJobInput): Promise<CostEstimate> {
    return {
      estimated_credits: -1,
      estimated_usd: -1,
      currency: "unknown",
      notes: "future_api 占位 provider，价格未配置，实际调用会抛出错误"
    };
  }
}

// --- Provider factory ---

export async function createVideoProvider(providerId: string, config?: Record<string, string>): Promise<VideoProvider> {
  switch (providerId) {
    case "local_mock_video":
      return new LocalMockVideoProvider();
    case "minimax_hailuo": {
      const minimaxMod = await import("./minimaxVideo");
      return new minimaxMod.MiniMaxHailuoVideoProvider();
    }
    case "aliyun_wan_t2v": {
      const aliyunMod = await import("./aliyunWanVideo");
      return new aliyunMod.AliyunWanT2VProvider();
    }
    case "future_api": {
      const merged: Record<string, string> = {
        VIDEO_API_KEY: getConfigValue("VIDEO_API_KEY"),
        VIDEO_API_BASE_URL: getConfigValue("VIDEO_API_BASE_URL"),
        VIDEO_MODEL: getConfigValue("VIDEO_MODEL"),
        ...config
      };
      return new RealVideoApiTemplateProvider(merged);
    }
    default:
      throw new Error(`Unknown video provider: ${providerId}`);
  }
}

// --- Resolution helpers ---

export function parseResolution(resolution: string): { width: number; height: number } | null {
  const match = resolution.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) return null;
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

export function aspectRatioToResolution(aspectRatio: string): { width: number; height: number } {
  switch (aspectRatio) {
    case "16:9": return { width: 1920, height: 1080 };
    case "9:16": return { width: 1080, height: 1920 };
    case "1:1": return { width: 1080, height: 1080 };
    default: return { width: 1920, height: 1080 };
  }
}
