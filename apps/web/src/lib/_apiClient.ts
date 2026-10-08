// ====================================================================
// _apiClient.ts — fetch core (P1 wave 2 #11 解耦)
// ====================================================================
// 从 lib/api.ts 拆出的 fetch 核心层. 不依赖其他模块, 单向依赖图基石.
// 任何 modality file (jobsApi / settingsApi / ...) 都从这里 import
// apiGet/Post/Patch/Put/Delete + ApiError + handleResponse 等基础原语.
//
// 历史: 2026-05-19 用户原话"禁止在本地设置主动超时" — 这里所有 fetch
// 默认不带 AbortSignal.timeout, 只透传 opts.signal (用户主动中止).
// ====================================================================

/**
 * 统一的 API 错误类.
 * 支持标准格式 { error: { code, message, details? } } 和旧格式兼容.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  detail: string;
  details?: unknown;
  /** 后端返回的用户操作建议 (如"请打开设置检查 provider 状态") */
  suggestion?: string;
  requestId?: string;

  constructor(code: string, message: string, status: number, details?: unknown, suggestion?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = message;
    this.details = details;
    this.suggestion = suggestion;
  }

  /** 从 fetch Response 构造 ApiError */
  static async fromResponse(response: Response, fallbackMessage?: string): Promise<ApiError> {
    const bodyText = await response.text().catch(() => "");
    return ApiError.parse(response.status, bodyText, fallbackMessage);
  }

  /** 从 HTTP status + body 字符串解析 */
  static parse(status: number, body: string, fallbackMessage?: string): ApiError {
    try {
      const parsed = JSON.parse(body);
      // 标准格式: { error: { code, message, details?, suggestion? } }
      if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
        return new ApiError(
          parsed.error.code || "UNKNOWN",
          parsed.error.message,
          status,
          parsed.error.details,
          typeof parsed.error.suggestion === "string" ? parsed.error.suggestion : undefined,
        );
      }
      // 旧格式兼容: { error: "string" }
      if (typeof parsed.error === "string") {
        return new ApiError("UNKNOWN", parsed.error, status);
      }
      // 旧格式: { code, message } (flattened)
      if (parsed.code || parsed.message) {
        return new ApiError(
          parsed.code || "UNKNOWN",
          parsed.message || body,
          status
        );
      }
      // 旧格式: { ok: false, error: "str", message: "str" }
      if (parsed.ok === false) {
        return new ApiError(
          parsed.code || parsed.error_type || "UNKNOWN",
          parsed.message || parsed.error || body,
          status
        );
      }
    } catch { /* not JSON */ }
    return new ApiError("UNKNOWN", fallbackMessage || body || String(status), status);
  }
}

export async function handleResponse(response: Response) {
  if (!response.ok) {
    throw await ApiError.fromResponse(response, response.statusText);
  }
}

// 2026-05-28 P2-45: LLM_ENDPOINT_PATTERNS + isLlmEndpoint 函数自 2026-05-19 删除
// AbortSignal.timeout 后就再没人 call. 当时留下 `void isLlmEndpoint;` 假装"还在用"
// 防 lint, 实际就是死代码. 整段删, 减少认知负担.

export interface ApiFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function buildFetchInit(method: string, body?: unknown, opts?: ApiFetchOptions): RequestInit {
  const init: RequestInit = {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  if (opts?.signal) {
    init.signal = opts.signal;
  }
  return init;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

export async function apiGet<T>(url: string, opts?: ApiFetchOptions): Promise<T> {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
  // 删 AbortSignal.timeout 默认值. 只透传 opts.signal (用户主动中止).
  const init = buildFetchInit("GET", undefined, opts);
  const response = await fetch(url, init);
  await handleResponse(response);
  return response.json() as Promise<T>;
}

export async function apiPost<T>(url: string, body?: unknown, opts?: ApiFetchOptions): Promise<T> {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
  // 删 AbortSignal.timeout 默认值. 只透传 opts.signal (用户中止按钮).
  const init = buildFetchInit("POST", body, opts);
  const response = await fetch(url, init);
  await handleResponse(response);
  return response.json() as Promise<T>;
}

export async function apiDelete<T>(url: string, opts?: ApiFetchOptions): Promise<T> {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删默认 AbortSignal.timeout, 只透传 opts.signal.
  const init = buildFetchInit("DELETE", undefined, opts);
  const response = await fetch(url, init);
  await handleResponse(response);
  return response.json() as Promise<T>;
}

export async function apiPut<T>(url: string, body?: unknown, opts?: ApiFetchOptions): Promise<T> {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删默认 AbortSignal.timeout, 只透传 opts.signal.
  const init = buildFetchInit("PUT", body, opts);
  const response = await fetch(url, init);
  await handleResponse(response);
  return response.json() as Promise<T>;
}

export async function apiPatch<T>(url: string, body?: unknown, opts?: ApiFetchOptions): Promise<T> {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删默认 AbortSignal.timeout, 只透传 opts.signal.
  const init = buildFetchInit("PATCH", body, opts);
  const response = await fetch(url, init);
  await handleResponse(response);
  return response.json() as Promise<T>;
}

/**
 * Thin wrapper for fetch calls that don't fit apiGet/apiPost/apiPatch/apiDelete
 * (e.g. FormData). Ensures consistent ApiError handling.
 */
export async function handleFetchResponse<T>(response: Response): Promise<T> {
  await handleResponse(response);
  return response.json() as Promise<T>;
}

/**
 * 2026-05-20 P2: 统一 series slug URL helper.
 *
 * 封装 encodeURIComponent(slug) 让所有新增 API 调用一律走此函数,
 * 避免遗忘 encode 导致含特殊字符的 slug 构成错误 URL.
 *
 * 用法: `seriesPath(slug, "episodes")` → `/api/v2/series/<encoded-slug>/episodes`
 *
 * 历史存量代码约 33 处直接用 `\${slug}` 插值 (在 kebab-case slug 场景无实际 bug),
 * 作为技术债记录在此 — 新代码和未来重构应全部改用 seriesPath.
 */
export function seriesPath(slug: string, path?: string): string {
  const base = `/api/v2/series/${encodeURIComponent(slug)}`;
  if (!path) return base;
  return `${base}/${path}`;
}
