/**
 * P22: Jimeng Video Client — Low-level HTTP calls for 即梦视频 3.0 Pro / 720P
 *
 * Uses shared volcSign.ts for HMAC-SHA256 signing.
 * Async flow: submitTask → pollStatus → downloadResult
 *
 * Endpoint: POST https://visual.volcengineapi.com
 * Actions:
 *   - Submit: CVSync2AsyncSubmitTask (Version 2022-08-31)
 *   - Query:  CVSync2AsyncGetResult  (Version 2022-08-31)
 *
 * Model variants (req_key):
 *   - jimeng_high_aes_general_v30pro  (即梦视频 3.0 Pro)
 *   - jimeng_high_aes_general_v30     (即梦视频 3.0 720P)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getConfigValue } from "../../../core/src/index";
import { ProviderError, type ProviderErrorCode } from "../core/errors";
import { buildSignedRequest, redactAuthHeader, type VolcSignConfig } from "./volcSign";

// 2026-05-28 audit P0-10: 把字符串 error_type 映射到 ProviderErrorCode.
function errorTypeToProviderCode(errorType: string): ProviderErrorCode {
  switch (errorType) {
    case "auth_failed": return "missing_key";
    case "rate_limited": return "rate_limit";
    case "invalid_input": return "invalid_request";
    case "server_error": return "server";
    case "download_failed": return "server";
    case "provider_error":
    case "unknown":
    default: return "server";
  }
}

// ─── Config ─────────────────────────────────────────────────────────────

export interface JimengVideoConfig {
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  host: string;
  endpoint: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  downloadTimeoutMs: number;
}

export function loadJimengVideoConfig(): JimengVideoConfig {
  return {
    accessKey: getConfigValue("JIMENG_VOLC_ACCESS_KEY"),
    secretKey: getConfigValue("JIMENG_VOLC_SECRET_KEY"),
    region: getConfigValue("JIMENG_VOLC_REGION", "cn-north-1"),
    service: getConfigValue("JIMENG_VOLC_SERVICE", "cv"),
    host: getConfigValue("JIMENG_VOLC_HOST", "visual.volcengineapi.com"),
    endpoint: getConfigValue("JIMENG_VOLC_ENDPOINT", "https://visual.volcengineapi.com"),
    pollIntervalMs: Number(getConfigValue("JIMENG_VIDEO_POLL_INTERVAL_MS", "5000")),
    // 2026-05-14 per PM C10: 默认无超时(0 → Infinity)
    pollTimeoutMs: (() => {
      const raw = getConfigValue("JIMENG_VIDEO_POLL_TIMEOUT_MS", "0");
      const n = Number(raw);
      return n > 0 ? n : Number.POSITIVE_INFINITY;
    })(),
    downloadTimeoutMs: Number(getConfigValue("JIMENG_VIDEO_DOWNLOAD_TIMEOUT_MS", "300000")),
  };
}

// ─── Model variant mapping ──────────────────────────────────────────────

export type JimengVideoModelVariant = "jimeng_high_aes_general_v30pro" | "jimeng_high_aes_general_v30";

export function resolveModelVariant(presetId: string): JimengVideoModelVariant {
  if (presetId.includes("720p") || presetId.includes("720")) {
    return "jimeng_high_aes_general_v30";
  }
  return "jimeng_high_aes_general_v30pro";
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface JimengVideoSubmitInput {
  req_key: JimengVideoModelVariant;
  prompt: string;
  first_frame_image?: string;   // base64 of first frame (required for i2v)
  /**
   * 2026-05-21 X-1: 尾帧 base64, 即梦 3.0 Pro 支持首尾帧连贯生成.
   * 字段名参照即梦 API 文档 — 不确定是否支持时 silent 忽略,不抛错.
   */
  last_frame_image?: string;
  width: number;
  height: number;
  duration?: number;             // 3, 5, or 10 seconds
  seed?: number;
  return_url?: boolean;
}

export interface JimengVideoSubmitResult {
  task_id: string;
  request_id?: string;
  raw: unknown;
}

export interface JimengVideoQueryResult {
  task_id: string;
  task_status: "Pending" | "Running" | "Succeeded" | "Failed" | "Canceled" | "Unknown";
  video_url?: string;
  message?: string;
  code?: number;
  request_id?: string;
  raw: unknown;
}

export interface JimengVideoDownloadResult {
  filePath: string;
  bytes: number;
}

// ─── API response types ─────────────────────────────────────────────────

export interface JimengVideoApiResponse {
  code: number;            // 10000 = success
  message: string;
  data?: {
    task_id?: string;
    task_status?: string;
    video_url?: string;
    binary_data_base64?: string;
    sub_codes?: string[];
  };
  response_metadata?: {
    request_id: string;
    status_code: number;
    error?: {
      code: string;
      message: string;
    };
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

const API_VERSION = "2022-08-31";
const SUBMIT_ACTION = "CVSync2AsyncSubmitTask";
const QUERY_ACTION = "CVSync2AsyncGetResult";

function toVolcSignConfig(config: JimengVideoConfig): VolcSignConfig {
  return {
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region: config.region,
    service: config.service,
    host: config.host,
    endpoint: config.endpoint,
  };
}

// ─── Submit video generation task ───────────────────────────────────────

export async function submitJimengVideoTask(
  config: JimengVideoConfig,
  input: JimengVideoSubmitInput,
): Promise<JimengVideoSubmitResult> {
  const body: Record<string, unknown> = {
    req_key: input.req_key,
    prompt: input.prompt,
    width: input.width,
    height: input.height,
    return_url: input.return_url ?? true,
  };

  if (input.first_frame_image) {
    body.first_frame_image = input.first_frame_image;
  }
  // 2026-05-21 X-1: 尾帧 base64, 即梦 3.0 Pro 首尾帧连贯
  if (input.last_frame_image) {
    body.last_frame_image = input.last_frame_image;
  }
  if (input.duration !== undefined) {
    body.duration = input.duration;
  }
  if (input.seed !== undefined) {
    body.seed = input.seed;
  }

  const bodyStr = JSON.stringify(body);
  const signConfig = toVolcSignConfig(config);
  const { url, headers } = buildSignedRequest(signConfig, SUBMIT_ACTION, API_VERSION, bodyStr);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: bodyStr,
    // 2026-05-18: 用户原话"本地不设额外的等待时间限制"
  });

  const raw = (await response.json().catch(() => ({}))) as JimengVideoApiResponse;

  if (!response.ok && !raw.code) {
    return {
      task_id: "",
      request_id: raw.response_metadata?.request_id,
      raw: {
        ...raw,
        _http_status: response.status,
        _headers: redactAuthHeader(headers),
      },
    };
  }

  // Check API-level success
  if (raw.code !== 10000) {
    const errMsg = raw.message || raw.response_metadata?.error?.message || `API error code ${raw.code}`;
    const errType = mapApiErrorType(raw.code, response.status);
    // 2026-05-28 audit P0-10: throw ProviderError 而非裸 Error + Object.assign,
    // caller (JimengVideoProvider) 之前 catch err.error_type 字符串 fragile, 现走 err.code.
    throw new ProviderError({
      message: `Jimeng video submit failed: ${errMsg}`,
      code: errorTypeToProviderCode(errType),
      provider_id: "jimeng_video",
      retriable: errType === "rate_limited" || errType === "server_error",
      original: {
        error_type: errType,
        jimeng_code: raw.code,
        request_id: raw.response_metadata?.request_id,
        raw_redacted: {
          code: raw.code,
          message: raw.message?.slice(0, 400),
          request_id: raw.response_metadata?.request_id,
          headers: redactAuthHeader(headers),
        },
      },
    });
  }

  const taskId = raw.data?.task_id;
  if (!taskId) {
    throw new ProviderError({
      message: "Jimeng video submit response missing task_id",
      code: "invalid_output",
      provider_id: "jimeng_video",
      retriable: false,
      original: {
        error_type: "provider_error",
        raw_redacted: { code: raw.code, request_id: raw.response_metadata?.request_id },
      },
    });
  }

  return {
    task_id: taskId,
    request_id: raw.response_metadata?.request_id,
    raw,
  };
}

// ─── Query task status ──────────────────────────────────────────────────

export async function queryJimengVideoTask(
  config: JimengVideoConfig,
  taskId: string,
): Promise<JimengVideoQueryResult> {
  const bodyStr = JSON.stringify({ task_id: taskId });
  const signConfig = toVolcSignConfig(config);
  const { url, headers } = buildSignedRequest(signConfig, QUERY_ACTION, API_VERSION, bodyStr);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: bodyStr,
    // 2026-05-18: 不设本地 timeout
  });

  const raw = (await response.json().catch(() => ({}))) as JimengVideoApiResponse;

  if (!response.ok && !raw.code) {
    // 2026-05-28 audit P0-10: throw ProviderError 而非 Object.assign(new Error).
    throw new ProviderError({
      message: `Jimeng video query HTTP ${response.status}`,
      code: errorTypeToProviderCode(mapApiErrorType(raw.code, response.status)),
      provider_id: "jimeng_video",
      retriable: response.status === 429 || response.status >= 500,
      original: { error_type: "provider_error", task_id: taskId, http_status: response.status },
    });
  }

  if (raw.code !== 10000) {
    const errMsg = raw.message || raw.response_metadata?.error?.message || `API error code ${raw.code}`;
    const errType = mapApiErrorType(raw.code, response.status);
    throw new ProviderError({
      message: `Jimeng video query failed: ${errMsg}`,
      code: errorTypeToProviderCode(errType),
      provider_id: "jimeng_video",
      retriable: errType === "rate_limited" || errType === "server_error",
      original: {
        error_type: errType,
        jimeng_code: raw.code,
        task_id: taskId,
        request_id: raw.response_metadata?.request_id,
      },
    });
  }

  const status = raw.data?.task_status ?? "Unknown";
  const validStatuses = new Set(["Pending", "Running", "Succeeded", "Failed", "Canceled", "Unknown"]);
  const mappedStatus = validStatuses.has(status) ? (status as JimengVideoQueryResult["task_status"]) : "Unknown";

  return {
    task_id: taskId,
    task_status: mappedStatus,
    video_url: raw.data?.video_url,
    message: raw.message,
    code: raw.code,
    request_id: raw.response_metadata?.request_id,
    raw,
  };
}

// ─── Download video file ────────────────────────────────────────────────

export async function downloadJimengVideo(
  downloadUrl: string,
  outputPath: string,
  timeoutMs: number = 300_000,
): Promise<JimengVideoDownloadResult> {
  const { streamDownloadToFile } = await import("../core/streamDownload");
  try {
    const result = await streamDownloadToFile(downloadUrl, outputPath, {
      maxBytes: 200_000_000,
      timeoutMs,
    });
    return { filePath: result.filePath, bytes: result.bytes };
  } catch (err: any) {
    // 2026-05-28 audit P0-10: throw ProviderError 而非 Object.assign(new Error).
    throw new ProviderError({
      message: `Jimeng video download failed: ${err.message}`,
      code: "server",
      provider_id: "jimeng_video",
      retriable: false,
      original: { error_type: "download_failed", inner: err },
    });
  }
}

// ─── Cancel task ────────────────────────────────────────────────────────

const CANCEL_ACTION = "CVSync2AsyncCancelTask";

/**
 * S1: Cancel a Jimeng/Volcengine video task.
 * Volcengine CV async API: CVSync2AsyncCancelTask
 */
export async function cancelJimengVideoTask(
  config: JimengVideoConfig,
  taskId: string,
): Promise<"cancelled" | "failed"> {
  const bodyStr = JSON.stringify({ task_id: taskId });
  const signConfig = toVolcSignConfig(config);
  const { url, headers } = buildSignedRequest(signConfig, CANCEL_ACTION, API_VERSION, bodyStr);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      // 2026-05-18: 不设本地 timeout
    });

    if (!response.ok) return "failed";
    const raw = (await response.json().catch(() => ({}))) as JimengVideoApiResponse;
    if (raw.code !== 10000) return "failed";
    return "cancelled";
  } catch {
    return "failed";
  }
}

// ─── Error mapping ──────────────────────────────────────────────────────

export function mapApiErrorType(
  jimengCode: number | undefined,
  httpStatus: number,
): string {
  if (httpStatus === 401 || httpStatus === 403 || jimengCode === 50403) return "auth_failed";
  if (httpStatus === 429 || jimengCode === 50429) return "rate_limited";
  if (httpStatus === 400 || httpStatus === 422 || jimengCode === 50400) return "invalid_input";
  if (httpStatus >= 500) return "server_error";
  return "unknown";
}
