// P23: Kling API client — low-level HTTP calls for image-to-video
// Official doc: https://klingai.com/document-api/apiReference/model/imageToVideo

import path from "node:path";
import fs from "node:fs/promises";
import { getConfigValue } from "../../../core/src/index";
import { KlingJwtManager } from "./klingJwt";
import { pollAsyncJob, type PollResult } from "../core/asyncJobPoller";
import { ProviderError } from "../core/errors";

// ─── Config ────────────────────────────────────────────────────────

export interface KlingConfig {
  accessKey: string;
  secretKey: string;
  baseUrl: string;
  model: string;
  cfgScale: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  downloadTimeoutMs: number;
}

export function loadKlingConfig(): KlingConfig {
  return {
    accessKey: getConfigValue("KLING_ACCESS_KEY"),
    secretKey: getConfigValue("KLING_SECRET_KEY"),
    baseUrl: getConfigValue("KLING_BASE_URL", "https://api.klingai.com"),
    // 2026-05-14 (per PM C9): 不再硬编码占位 model 名。用户在设置自己填。
    // O10.5: kling-v2-master 为 2026-05 当前可用 model_name（原 kling-v2 已改名）
    model: getConfigValue("KLING_MODEL", "kling-v2-master"),
    cfgScale: Number(getConfigValue("KLING_CFG_SCALE", "0.5")),
    pollIntervalMs: Number(getConfigValue("KLING_POLL_INTERVAL_MS", "5000")),
    // 2026-05-14 per PM C10: 默认无超时(0 → Infinity)
    pollTimeoutMs: (() => {
      const raw = getConfigValue("KLING_POLL_TIMEOUT_MS", "0");
      const n = Number(raw);
      return n > 0 ? n : Number.POSITIVE_INFINITY;
    })(),
    downloadTimeoutMs: Number(getConfigValue("KLING_DOWNLOAD_TIMEOUT_MS", "300000")),
  };
}

// ─── Types ─────────────────────────────────────────────────────────

export interface KlingSubmitInput {
  model_name?: string;
  prompt: string;
  negative_prompt?: string;
  image: string;           // base64 or URL
  image_tail?: string;     // optional end-frame (v1 not used)
  duration: "5" | "10";
  aspect_ratio: string;    // "9:16" | "16:9" | "1:1"
  cfg_scale?: number;
  mode?: "std" | "pro";
}

export interface KlingSubmitResult {
  task_id: string;
  request_id?: string;
  raw: unknown;
}

export interface KlingTaskResult {
  task_id: string;
  task_status: "submitted" | "processing" | "succeed" | "failed";
  task_status_msg?: string;
  created_at?: number;
  updated_at?: number;
  task_result?: {
    videos?: Array<{
      id?: string;
      url?: string;
      duration?: string;
    }>;
  };
  raw: unknown;
}

export interface KlingDownloadResult {
  filePath: string;
  bytes: number;
}

// ─── Error mapping ─────────────────────────────────────────────────

/**
 * Map Kling error codes to ProviderErrorCode.
 * Kling error codes: https://klingai.com/document-api/productBilling/errorCode
 */
export function mapKlingErrorCode(
  httpStatus: number,
  klingCode?: number
): { code: import("../core/errors").ProviderErrorCode; retriable: boolean } {
  // HTTP-level
  if (httpStatus === 401 || httpStatus === 403) return { code: "missing_key", retriable: false };
  if (httpStatus === 429) return { code: "rate_limit", retriable: true };

  // Kling-specific error codes (from response body)
  if (klingCode !== undefined) {
    // Auth errors
    if (klingCode === 10001 || klingCode === 10002 || klingCode === 10003) return { code: "missing_key", retriable: false };
    // Rate limit
    if (klingCode === 10010 || klingCode === 10011) return { code: "rate_limit", retriable: true };
    // Invalid request
    if (klingCode >= 20001 && klingCode <= 20099) return { code: "invalid_request", retriable: false };
    // Content filter
    if (klingCode === 30001 || klingCode === 30002) return { code: "content_filter", retriable: false };
    // Server errors
    if (klingCode >= 50000) return { code: "server", retriable: true };
  }

  if (httpStatus >= 500) return { code: "server", retriable: true };
  if (httpStatus === 408 || httpStatus === 504) return { code: "timeout", retriable: true };
  return { code: "unknown", retriable: false };
}

// ─── Redact helpers ────────────────────────────────────────────────

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

// ─── Submit image-to-video ─────────────────────────────────────────

export async function submitKlingI2V(
  config: KlingConfig,
  jwtManager: KlingJwtManager,
  input: KlingSubmitInput
): Promise<KlingSubmitResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/videos/image2video`;

  const payload: Record<string, unknown> = {
    model_name: input.model_name ?? config.model,
    prompt: input.prompt,
    image: input.image,
    duration: input.duration,
    aspect_ratio: input.aspect_ratio,
    cfg_scale: input.cfg_scale ?? config.cfgScale,
    mode: input.mode ?? "std",
  };

  if (input.negative_prompt) payload.negative_prompt = input.negative_prompt;
  if (input.image_tail) payload.image_tail = input.image_tail;

  const jwt = jwtManager.getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt.token}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    // 2026-05-18: 用户原话"本地不设额外的等待时间限制" — 让 API 自己决定 fail 时机
  });

  const raw = await response.json().catch(() => ({}));
  const rawObj = raw as Record<string, unknown>;
  const data = rawObj?.data as Record<string, unknown> | undefined;
  const klingCode = typeof rawObj?.code === "number" ? rawObj.code : undefined;

  // Handle 401 → auto-retry once with refreshed JWT
  if (response.status === 401) {
    const freshJwt = jwtManager.refresh();
    const retryHeaders: Record<string, string> = {
      Authorization: `Bearer ${freshJwt.token}`,
      "Content-Type": "application/json",
    };

    const retryResponse = await fetch(url, {
      method: "POST",
      headers: retryHeaders,
      body: JSON.stringify(payload),
      // 2026-05-18: 用户原话"本地不设额外的等待时间限制" — 让 API 自己决定 fail 时机
    });

    const retryRaw = await retryResponse.json().catch(() => ({}));
    const retryRawObj = retryRaw as Record<string, unknown>;
    const retryData = retryRawObj?.data as Record<string, unknown> | undefined;
    const retryKlingCode = typeof retryRawObj?.code === "number" ? retryRawObj.code : undefined;

    if (!retryResponse.ok) {
      const mapped = mapKlingErrorCode(retryResponse.status, retryKlingCode);
      const errMsg = (retryRawObj?.message as string) || `HTTP ${retryResponse.status}`;
      throw new ProviderError({
        message: `Kling submit failed (after 401 retry): ${errMsg}`,
        code: mapped.code,
        provider_id: "kling_3",
        retriable: mapped.retriable,
        original: {
          http_status: retryResponse.status,
          kling_code: retryKlingCode,
          request_id: retryData?.request_id,
          headers: redactHeaders(retryHeaders),
        },
      });
    }

    const taskId = retryData?.task_id as string | undefined;
    if (!taskId) {
      throw new ProviderError({
        message: "Kling submit response missing task_id (after 401 retry)",
        code: "server",
        provider_id: "kling_3",
        retriable: false,
        original: { raw_keys: Object.keys(retryRawObj ?? {}) },
      });
    }

    return { task_id: taskId, request_id: retryData?.request_id as string | undefined, raw: retryRaw };
  }

  // Handle other errors
  if (!response.ok) {
    const mapped = mapKlingErrorCode(response.status, klingCode);
    const errMsg = (rawObj?.message as string) || `HTTP ${response.status}`;
    throw new ProviderError({
      message: `Kling submit failed: ${errMsg}`,
      code: mapped.code,
      provider_id: "kling_3",
      retriable: mapped.retriable,
      original: {
        http_status: response.status,
        kling_code: klingCode,
        request_id: data?.request_id,
        headers: redactHeaders(headers),
      },
    });
  }

  const taskId = data?.task_id as string | undefined;
  if (!taskId) {
    throw new ProviderError({
      message: "Kling submit response missing task_id",
      code: "server",
      provider_id: "kling_3",
      retriable: false,
      original: { raw_keys: Object.keys(rawObj ?? {}) },
    });
  }

  return { task_id: taskId, request_id: data?.request_id as string | undefined, raw };
}

// ─── Query task status ─────────────────────────────────────────────

export async function queryKlingTask(
  config: KlingConfig,
  jwtManager: KlingJwtManager,
  taskId: string
): Promise<KlingTaskResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/videos/image2video/${encodeURIComponent(taskId)}`;

  const jwt = jwtManager.getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt.token}`,
  };

  const response = await fetch(url, {
    method: "GET",
    headers,
    // 2026-05-18: 不设本地 timeout
  });

  const raw = await response.json().catch(() => ({}));
  const rawObj = raw as Record<string, unknown>;
  const data = rawObj?.data as Record<string, unknown> | undefined;
  const klingCode = typeof rawObj?.code === "number" ? rawObj.code : undefined;

  // Handle 401 → refresh JWT and retry once
  if (response.status === 401) {
    const freshJwt = jwtManager.refresh();
    const retryHeaders: Record<string, string> = {
      Authorization: `Bearer ${freshJwt.token}`,
    };

    const retryResponse = await fetch(url, {
      method: "GET",
      headers: retryHeaders,
      // 2026-05-18: 不设本地 timeout
    });

    const retryRaw = await retryResponse.json().catch(() => ({}));
    const retryRawObj = retryRaw as Record<string, unknown>;
    const retryData = retryRawObj?.data as Record<string, unknown> | undefined;
    const retryKlingCode = typeof retryRawObj?.code === "number" ? retryRawObj.code : undefined;

    if (!retryResponse.ok) {
      const mapped = mapKlingErrorCode(retryResponse.status, retryKlingCode);
      throw new ProviderError({
        message: `Kling query failed (after 401 retry): ${(retryRawObj?.message as string) ?? `HTTP ${retryResponse.status}`}`,
        code: mapped.code,
        provider_id: "kling_3",
        retriable: mapped.retriable,
        original: { task_id: taskId, http_status: retryResponse.status },
      });
    }

    return {
      task_id: taskId,
      task_status: (retryData?.task_status as KlingTaskResult["task_status"]) ?? "failed",
      task_status_msg: retryData?.task_status_msg as string | undefined,
      created_at: retryData?.created_at as number | undefined,
      updated_at: retryData?.updated_at as number | undefined,
      task_result: retryData?.task_result as KlingTaskResult["task_result"],
      raw: retryRaw,
    };
  }

  if (!response.ok) {
    const mapped = mapKlingErrorCode(response.status, klingCode);
    throw new ProviderError({
      message: `Kling query failed: ${(rawObj?.message as string) ?? `HTTP ${response.status}`}`,
      code: mapped.code,
      provider_id: "kling_3",
      retriable: mapped.retriable,
      original: { task_id: taskId, http_status: response.status },
    });
  }

  return {
    task_id: taskId,
    task_status: (data?.task_status as KlingTaskResult["task_status"]) ?? "failed",
    task_status_msg: data?.task_status_msg as string | undefined,
    created_at: data?.created_at as number | undefined,
    updated_at: data?.updated_at as number | undefined,
    task_result: data?.task_result as KlingTaskResult["task_result"],
    raw,
  };
}

// ─── Poll task (uses asyncJobPoller) ───────────────────────────────

export async function pollKlingTask(
  config: KlingConfig,
  jwtManager: KlingJwtManager,
  taskId: string,
  logger?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<KlingTaskResult> {
  const result = await pollAsyncJob<KlingTaskResult>({
    providerId: "kling_3",
    taskId,
    signal,
    pollFn: async () => {
      const taskResult = await queryKlingTask(config, jwtManager, taskId);

      const statusMap: Record<string, PollResult<KlingTaskResult>["status"]> = {
        succeed: "succeed",
        failed: "failed",
      };

      const mappedStatus = statusMap[taskResult.task_status] ?? "processing";

      return {
        status: mappedStatus,
        data: taskResult,
        error: mappedStatus === "failed" ? taskResult.task_status_msg : undefined,
        raw: taskResult.raw,
      };
    },
    initialIntervalMs: config.pollIntervalMs,
    maxIntervalMs: 15_000,
    timeoutMs: config.pollTimeoutMs,
    logger,
  });

  if (result.status === "timeout") {
    throw new ProviderError({
      message: `Kling poll timeout for task ${taskId}`,
      code: "timeout",
      provider_id: "kling_3",
      retriable: true,
    });
  }

  if (result.status === "failed") {
    throw new ProviderError({
      message: `Kling task ${taskId} failed: ${result.error ?? "unknown"}`,
      code: "server",
      provider_id: "kling_3",
      retriable: false,
    });
  }

  if (!result.data) {
    throw new ProviderError({
      message: `Kling poll returned no data for task ${taskId}`,
      code: "server",
      provider_id: "kling_3",
      retriable: false,
    });
  }

  return result.data;
}

// ─── Cancel task ───────────────────────────────────────────────────

/**
 * S1: Cancel/delete a Kling i2v task.
 * Kling API: DELETE /v1/videos/image2video/{task_id}
 */
export async function cancelKlingTask(
  config: KlingConfig,
  jwtManager: KlingJwtManager,
  taskId: string,
): Promise<"cancelled" | "failed"> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/videos/image2video/${encodeURIComponent(taskId)}`;

  const jwt = jwtManager.getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt.token}`,
    "Content-Type": "application/json",
  };

  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers,
      // 2026-05-18: 不设本地 timeout
    });

    if (response.status === 401) {
      const freshJwt = jwtManager.refresh();
      const retryHeaders: Record<string, string> = {
        Authorization: `Bearer ${freshJwt.token}`,
        "Content-Type": "application/json",
      };
      const retryResponse = await fetch(url, {
        method: "DELETE",
        headers: retryHeaders,
        // 2026-05-18: 不设本地 timeout
      });
      if (!retryResponse.ok) return "failed";
      return "cancelled";
    }

    if (!response.ok) return "failed";
    return "cancelled";
  } catch {
    return "failed";
  }
}

// ─── Download video ────────────────────────────────────────────────

export async function downloadKlingVideo(
  downloadUrl: string,
  outputPath: string,
  timeoutMs: number = 300_000
): Promise<KlingDownloadResult> {
  const { streamDownloadToFile } = await import("../core/streamDownload");
  try {
    const result = await streamDownloadToFile(downloadUrl, outputPath, {
      maxBytes: 200_000_000,
      timeoutMs,
    });
    return { filePath: result.filePath, bytes: result.bytes };
  } catch (err) {
    throw new Error(`Kling video download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
