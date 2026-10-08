import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, getConfigValue } from "../../core/src/index";

// --- Config ---

export interface AliyunWanConfig {
  apiKey: string;
  baseUrl: string;
  region: string;
  model: string;
  resolutionTier: string;
  aspectRatio: string;
  size: string;
  duration: number;
  promptExtend: boolean;
  watermark: boolean;
  seed?: number;
  negativePrompt: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  downloadTimeoutMs: number;
}

export function loadAliyunWanConfig(): AliyunWanConfig {
  return {
    apiKey: getConfigValue("ALIYUN_DASHSCOPE_API_KEY"),
    baseUrl: getConfigValue("ALIYUN_WAN_BASE_URL", "https://dashscope.aliyuncs.com"),
    region: getConfigValue("ALIYUN_WAN_REGION", "cn-beijing"),
    model: getConfigValue("ALIYUN_WAN_MODEL", "wan2.2-t2v-plus"),
    resolutionTier: getConfigValue("ALIYUN_WAN_RESOLUTION_TIER", "480P"),
    aspectRatio: getConfigValue("ALIYUN_WAN_ASPECT_RATIO", "16:9"),
    size: getConfigValue("ALIYUN_WAN_SIZE", "832*480"),
    duration: Number(getConfigValue("ALIYUN_WAN_DURATION", "5")),
    promptExtend: getConfigValue("ALIYUN_WAN_PROMPT_EXTEND", "true").toLowerCase() === "true",
    watermark: getConfigValue("ALIYUN_WAN_WATERMARK", "false").toLowerCase() === "true",
    seed: (() => { const v = getConfigValue("ALIYUN_WAN_SEED"); return v ? Number(v) : undefined; })(),
    negativePrompt: getConfigValue("ALIYUN_WAN_NEGATIVE_PROMPT"),
    pollIntervalMs: Number(getConfigValue("ALIYUN_WAN_POLL_INTERVAL_MS", "15000")),
    pollTimeoutMs: Number(getConfigValue("ALIYUN_WAN_POLL_TIMEOUT_MS", "900000")),
    downloadTimeoutMs: Number(getConfigValue("ALIYUN_WAN_DOWNLOAD_TIMEOUT_MS", "300000"))
  };
}

// --- Types ---

export interface WanSubmitInput {
  prompt: string;
  negativePrompt?: string;
  model?: string;
  size?: string;
  duration?: number;
  promptExtend?: boolean;
  watermark?: boolean;
  seed?: number;
}

export interface WanSubmitResult {
  task_id: string;
  request_id: string;
  raw: unknown;
}

export interface WanQueryResult {
  task_id: string;
  task_status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";
  video_url?: string;
  orig_prompt?: string;
  actual_prompt?: string;
  code?: string;
  message?: string;
  request_id?: string;
  usage?: {
    duration?: number;
    size?: string;
    video_count?: number;
    SR?: number;
  };
  raw: unknown;
}

export interface WanDownloadResult {
  filePath: string;
  bytes: number;
}

// --- Helpers ---

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-DashScope-Async": "enable"
  };
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

// --- Submit text-to-video task ---

export async function submitWanTextToVideo(
  config: AliyunWanConfig,
  input: WanSubmitInput
): Promise<WanSubmitResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`;

  const model = input.model ?? config.model;
  const size = input.size ?? config.size;
  const duration = input.duration ?? config.duration;

  const payload: Record<string, unknown> = {
    model,
    input: {
      prompt: input.prompt,
      ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {})
    },
    parameters: {
      size,
      prompt_extend: input.promptExtend ?? config.promptExtend,
      duration,
      watermark: input.watermark ?? config.watermark,
      ...(input.seed !== undefined ? { seed: input.seed } : config.seed !== undefined ? { seed: config.seed } : {})
    }
  };

  const headers = buildHeaders(config.apiKey);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    // 2026-05-18: 用户原话"本地不设额外的等待时间限制"
  });

  const raw = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errMsg = (raw as any)?.message || (raw as any)?.error?.message || `HTTP ${response.status}`;
    const code = (raw as any)?.code || (raw as any)?.error?.code;
    // v0.2.4: previously spread the entire Aliyun response into raw_redacted,
    // which could leak echoed prompt / input fields. Now we keep only a
    // whitelisted, audit-relevant subset.
    const safeRaw: Record<string, unknown> = {
      code,
      request_id: (raw as any)?.request_id,
      status: (raw as any)?.output?.task_status,
      message: typeof errMsg === "string" ? errMsg.slice(0, 400) : undefined,
      headers: redactHeaders(headers)
    };
    throw Object.assign(new Error(`Aliyun Wan submit failed: ${errMsg}`), {
      error_type: response.status === 401 || response.status === 403 ? "auth_failed" : "provider_error",
      request_id: (raw as any)?.request_id,
      code,
      raw_redacted: safeRaw
    });
  }

  const output = (raw as any)?.output;
  const taskId = output?.task_id;
  if (!taskId) {
    throw Object.assign(new Error("Aliyun Wan submit response missing task_id"), {
      error_type: "provider_error",
      raw_redacted: raw
    });
  }

  return {
    task_id: taskId,
    request_id: (raw as any)?.request_id || "",
    raw
  };
}

// --- Query task ---

export async function queryWanTask(
  config: AliyunWanConfig,
  taskId: string,
  signal?: AbortSignal,
): Promise<WanQueryResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    signal,  // 2026-05-18: 仅透传调用方 abort, 不自加本地 timeout
  });

  const raw = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errMsg = (raw as any)?.message || `HTTP ${response.status}`;
    throw Object.assign(new Error(`Aliyun Wan query failed: ${errMsg}`), {
      error_type: "provider_error",
      request_id: (raw as any)?.request_id,
      provider_task_id: taskId
    });
  }

  const output = (raw as any)?.output || {};
  const taskStatus = output.task_status;

  const validStatuses = new Set(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]);
  if (!validStatuses.has(taskStatus)) {
    throw Object.assign(new Error(`Aliyun Wan query returned unknown status: ${taskStatus}`), {
      error_type: "provider_error",
      provider_task_id: taskId,
      raw_status: taskStatus
    });
  }

  return {
    task_id: taskId,
    task_status: taskStatus,
    video_url: output.video_url,
    orig_prompt: output.orig_prompt,
    actual_prompt: output.actual_prompt,
    code: output.code,
    message: output.message,
    request_id: (raw as any)?.request_id,
    usage: (raw as any)?.usage,
    raw
  };
}

// --- Poll task ---

export async function pollWanTask(
  config: AliyunWanConfig,
  taskId: string,
  logger?: { line: (msg: string) => Promise<void> },
  signal?: AbortSignal,
): Promise<WanQueryResult> {
  const startTime = Date.now();
  const pollInterval = config.pollIntervalMs;
  const pollTimeout = config.pollTimeoutMs;

  while (true) {
    // T1: check abort before each iteration
    if (signal?.aborted) {
      throw Object.assign(new Error(`Aliyun Wan poll aborted for task ${taskId}`), {
        error_type: "aborted",
        provider_task_id: taskId,
      });
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > pollTimeout) {
      throw Object.assign(
        new Error(`Aliyun Wan poll timeout after ${elapsed}ms for task ${taskId}`),
        { error_type: "poll_timeout", provider_task_id: taskId }
      );
    }

    // 2026-05-18: 用户原话"本地不设额外的等待时间限制" — 只透传外部 abort
    const result = await queryWanTask(config, taskId, signal);
    await logger?.line(`[aliyun_wan] Task ${taskId} status: ${result.task_status} (elapsed: ${elapsed}ms)`);

    switch (result.task_status) {
      case "SUCCEEDED":
        if (!result.video_url) {
          throw Object.assign(new Error("Aliyun Wan task succeeded but no video_url returned"), {
            error_type: "provider_error",
            provider_task_id: taskId
          });
        }
        return result;
      case "FAILED":
        return result;
      case "CANCELED":
        return result;
      case "UNKNOWN":
        return result;
      case "PENDING":
      case "RUNNING":
        // Continue polling
        break;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

// --- Download file ---

export async function downloadWanFile(
  downloadUrl: string,
  outputPath: string,
  timeoutMs: number = 300000
): Promise<WanDownloadResult> {
  const { streamDownloadToFile } = await import("./core/streamDownload");
  try {
    const result = await streamDownloadToFile(downloadUrl, outputPath, {
      maxBytes: 200_000_000,
      timeoutMs,
    });
    return { filePath: result.filePath, bytes: result.bytes };
  } catch (err: any) {
    throw Object.assign(new Error(`Aliyun Wan download failed: ${err.message}`), {
      error_type: "download_failed"
    });
  }
}
