import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../../core/src/index";

export interface MiniMaxConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  duration: number;
  resolution: string;
  promptOptimizer: boolean;
  fastPretreatment: boolean;
  aigcWatermark: boolean;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  downloadTimeoutMs: number;
}

export interface SubmitTextToVideoInput {
  prompt: string;
  model?: string;
  duration?: number;
  resolution?: string;
  promptOptimizer?: boolean;
  fastPretreatment?: boolean;
  aigcWatermark?: boolean;
}

export interface SubmitResult {
  task_id: string;
  raw: unknown;
}

export interface QueryResult {
  task_id: string;
  status: string;
  file_id?: string;
  video_width?: number;
  video_height?: number;
  raw: unknown;
}

export interface RetrieveResult {
  file_id: string;
  download_url: string;
  filename?: string;
  bytes?: number;
  raw: unknown;
}

export interface DownloadResult {
  filePath: string;
  bytes: number;
}

const VALID_STATUSES = new Set(["Preparing", "Queueing", "Processing", "Success", "Fail"]);

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function redactKeyFromUrl(url: string): string {
  return url.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") {
      result[k] = "Bearer [REDACTED]";
    } else {
      result[k] = v;
    }
  }
  return result;
}

export async function submitTextToVideo(
  config: MiniMaxConfig,
  input: SubmitTextToVideoInput
): Promise<SubmitResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/video_generation`;
  const payload = {
    model: input.model ?? config.model,
    prompt: input.prompt,
    duration: input.duration ?? config.duration,
    resolution: input.resolution ?? config.resolution,
    prompt_optimizer: input.promptOptimizer ?? config.promptOptimizer,
    fast_pretreatment: input.fastPretreatment ?? config.fastPretreatment,
    aigc_watermark: input.aigcWatermark ?? config.aigcWatermark
  };

  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(config.apiKey),
    body: JSON.stringify(payload),
    // 2026-05-18: 用户原话"本地不设额外的等待时间限制"
  });

  const raw = await response.json().catch(() => ({}));
  if (!response.ok || (raw as any)?.base_resp?.status_code !== 0) {
    const statusMsg = (raw as any)?.base_resp?.status_msg || `HTTP ${response.status}`;
    const statusCode = (raw as any)?.base_resp?.status_code;
    throw Object.assign(new Error(`MiniMax submit failed: ${statusMsg}`), {
      error_type: statusCode === 1004 ? "auth_failed" : statusCode === 1013 ? "rate_limited" : "provider_error",
      provider_task_id: (raw as any)?.task_id,
      raw_redacted: { ...(raw as any), headers: redactHeaders(buildHeaders(config.apiKey)) }
    });
  }

  const taskId = (raw as any).task_id;
  if (!taskId) {
    throw Object.assign(new Error("MiniMax submit response missing task_id"), {
      error_type: "provider_error",
      raw_redacted: raw
    });
  }

  return { task_id: taskId, raw };
}

export async function queryVideoTask(
  config: MiniMaxConfig,
  taskId: string,
  signal?: AbortSignal,
): Promise<QueryResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(config.apiKey),
    signal,  // 2026-05-18: 仅透传调用方的 abort signal, 不自加本地 timeout
  });

  const raw = await response.json().catch(() => ({}));
  if (!response.ok || (raw as any)?.base_resp?.status_code !== 0) {
    const statusMsg = (raw as any)?.base_resp?.status_msg || `HTTP ${response.status}`;
    throw Object.assign(new Error(`MiniMax query failed: ${statusMsg}`), {
      error_type: "provider_error",
      provider_task_id: taskId
    });
  }

  const status = (raw as any).status;
  if (!VALID_STATUSES.has(status)) {
    throw Object.assign(new Error(`MiniMax query returned unknown status: ${status}`), {
      error_type: "provider_error",
      provider_task_id: taskId,
      raw_status: status
    });
  }

  return {
    task_id: taskId,
    status,
    file_id: (raw as any).file_id,
    video_width: (raw as any).video_width,
    video_height: (raw as any).video_height,
    raw
  };
}

export async function retrieveFile(
  config: MiniMaxConfig,
  fileId: string
): Promise<RetrieveResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(config.apiKey),
    // 2026-05-18: 不设本地 timeout
  });

  const raw = await response.json().catch(() => ({}));
  if (!response.ok || (raw as any)?.base_resp?.status_code !== 0) {
    const statusMsg = (raw as any)?.base_resp?.status_msg || `HTTP ${response.status}`;
    throw Object.assign(new Error(`MiniMax retrieve failed: ${statusMsg}`), {
      error_type: "provider_error",
      provider_file_id: fileId
    });
  }

  const file = (raw as any).file;
  if (!file?.download_url) {
    throw Object.assign(new Error("MiniMax retrieve response missing download_url"), {
      error_type: "provider_error",
      provider_file_id: fileId
    });
  }

  return {
    file_id: file.file_id || fileId,
    download_url: file.download_url,
    filename: file.filename,
    bytes: file.bytes,
    raw
  };
}

export async function downloadFile(
  downloadUrl: string,
  outputPath: string,
  timeoutMs: number = 300000
): Promise<DownloadResult> {
  const { streamDownloadToFile } = await import("./core/streamDownload");
  const result = await streamDownloadToFile(downloadUrl, outputPath, {
    maxBytes: 200_000_000,
    timeoutMs,
  });
  return { filePath: result.filePath, bytes: result.bytes };
}

export async function pollVideoTask(
  config: MiniMaxConfig,
  taskId: string,
  logger?: { line: (msg: string) => Promise<void> },
  signal?: AbortSignal,
): Promise<{ status: "Success" | "Fail"; file_id?: string; video_width?: number; video_height?: number }> {
  const startTime = Date.now();
  const pollInterval = config.pollIntervalMs;
  const pollTimeout = config.pollTimeoutMs;

  while (true) {
    // T1: check abort before each iteration
    if (signal?.aborted) {
      throw Object.assign(new Error(`MiniMax poll aborted for task ${taskId}`), {
        error_type: "aborted",
        provider_task_id: taskId,
      });
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > pollTimeout) {
      throw Object.assign(
        new Error(`MiniMax poll timeout after ${elapsed}ms for task ${taskId}`),
        { error_type: "poll_timeout", provider_task_id: taskId }
      );
    }

    // 2026-05-18: 用户原话"本地不设额外的等待时间限制" — 只透传外部 abort
    const result = await queryVideoTask(config, taskId, signal);
    await logger?.line(`[minimax] Task ${taskId} status: ${result.status} (elapsed: ${elapsed}ms)`);

    switch (result.status) {
      case "Success":
        if (!result.file_id) {
          throw Object.assign(new Error("MiniMax task succeeded but no file_id returned"), {
            error_type: "provider_error",
            provider_task_id: taskId
          });
        }
        return {
          status: "Success",
          file_id: result.file_id,
          video_width: result.video_width,
          video_height: result.video_height
        };
      case "Fail":
        return { status: "Fail" };
      case "Preparing":
      case "Queueing":
      case "Processing":
        // Continue polling
        break;
      default:
        throw Object.assign(new Error(`MiniMax unknown task status: ${result.status}`), {
          error_type: "provider_error",
          provider_task_id: taskId,
          raw_status: result.status
        });
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

import { getConfigValue } from "../../core/src/index";

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  return value.toLowerCase() === "true";
}

export { parseBool };

export function loadMiniMaxConfig(): MiniMaxConfig {
  return {
    apiKey: getConfigValue("MINIMAX_API_KEY"),
    baseUrl: getConfigValue("MINIMAX_BASE_URL", "https://api.minimaxi.com"),
    model: getConfigValue("MINIMAX_VIDEO_MODEL", "MiniMax-Hailuo-2.3"),
    duration: Number(getConfigValue("MINIMAX_VIDEO_DURATION", "6")),
    resolution: getConfigValue("MINIMAX_VIDEO_RESOLUTION", "768P"),
    promptOptimizer: parseBool(getConfigValue("MINIMAX_PROMPT_OPTIMIZER", "true"), true),
    fastPretreatment: parseBool(getConfigValue("MINIMAX_FAST_PRETREATMENT", "false"), false),
    aigcWatermark: parseBool(getConfigValue("MINIMAX_AIGC_WATERMARK", "false"), false),
    pollIntervalMs: Number(getConfigValue("MINIMAX_POLL_INTERVAL_MS", "10000")),
    // 2026-05-28 audit P0-08: MiniMax 海螺视频实测 13-20 分钟正常, 客户端不能本地 timeout 误判.
    // 默认 Infinity, 只听 ctx.signal. env 覆盖仍生效.
    pollTimeoutMs: (() => {
      const raw = getConfigValue("MINIMAX_POLL_TIMEOUT_MS", "0");
      const n = Number(raw);
      return n > 0 ? n : Number.POSITIVE_INFINITY;
    })(),
    downloadTimeoutMs: Number(getConfigValue("MINIMAX_DOWNLOAD_TIMEOUT_MS", "300000"))
  };
}
