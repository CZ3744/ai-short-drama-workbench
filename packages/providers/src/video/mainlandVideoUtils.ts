import { ProviderError, type ProviderErrorCode } from "../core/errors";

export function videoDimsForAspect(aspect: string): { width: number; height: number } {
  switch (aspect) {
    case "9:16": return { width: 1080, height: 1920 };
    case "1:1": return { width: 1080, height: 1080 };
    case "4:3": return { width: 1440, height: 1080 };
    case "3:4": return { width: 1080, height: 1440 };
    case "16:9":
    default: return { width: 1920, height: 1080 };
  }
}

// 2026-05-18: 用户原话"本地不设额外的等待时间限制" — 不再用 AbortSignal.timeout 本地截断
// fetch 请求只透传外部 ctx.signal (用户主动中止按钮),远端任务等多久就等多久,只听 API 真实结果
// timeoutMs 参数保留是为了 caller 调用兼容,实际不再生效
export function combineSignal(signal: AbortSignal | undefined, _timeoutMs?: number): AbortSignal | undefined {
  return signal;
}

export function isTimeoutLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    /aborted|timeout|timed out/i.test(err.message);
}

export function classifyHttpError(status: number, bodyText: string): { code: ProviderErrorCode; retriable: boolean } {
  const body = bodyText.toLowerCase();
  if (status === 408 || status === 504) return { code: "timeout", retriable: true };
  if (status === 429 || body.includes("rate limit") || body.includes("too many") || body.includes("concurrency")) {
    return { code: "rate_limit", retriable: true };
  }
  if (status === 402 || body.includes("quota") || body.includes("balance") || body.includes("insufficient")) {
    return { code: "quota_exceeded", retriable: false };
  }
  if (status === 401 || status === 403) return { code: "missing_key", retriable: false };
  if (status === 400 || status === 422) return { code: "invalid_request", retriable: false };
  if (status >= 500) return { code: "server", retriable: true };
  return { code: "server", retriable: false };
}

export function providerErrorFromResponse(
  providerId: string,
  status: number,
  bodyText: string,
  prefix: string,
): ProviderError {
  const mapped = classifyHttpError(status, bodyText);
  return new ProviderError({
    message: `${prefix} HTTP ${status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
    code: mapped.code,
    provider_id: providerId,
    retriable: mapped.retriable,
  });
}

export function providerErrorFromUnknown(providerId: string, err: unknown, prefix: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (isTimeoutLike(err)) {
    return new ProviderError({
      message: `${prefix}: ${msg}`,
      code: "timeout",
      provider_id: providerId,
      retriable: true,
      original: err,
    });
  }
  if (/quota|balance|insufficient/i.test(msg)) {
    return new ProviderError({
      message: `${prefix}: ${msg}`,
      code: "quota_exceeded",
      provider_id: providerId,
      retriable: false,
      original: err,
    });
  }
  if (/rate limit|too many|concurrency/i.test(msg)) {
    return new ProviderError({
      message: `${prefix}: ${msg}`,
      code: "rate_limit",
      provider_id: providerId,
      retriable: true,
      original: err,
    });
  }
  return new ProviderError({
    message: `${prefix}: ${msg}`,
    code: "server",
    provider_id: providerId,
    retriable: true,
    original: err,
  });
}

export async function readJsonResponse<T>(
  providerId: string,
  response: Response,
  prefix: string,
): Promise<T> {
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw providerErrorFromResponse(providerId, response.status, text, prefix);
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    throw new ProviderError({
      message: `${prefix} returned invalid JSON`,
      code: "invalid_output",
      provider_id: providerId,
      retriable: false,
      original: err,
    });
  }
}

export async function downloadVideoBuffer(
  providerId: string,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    const resp = await fetch(url, { signal: combineSignal(signal, timeoutMs) });
    const text = resp.ok ? "" : await resp.text().catch(() => "");
    if (!resp.ok) throw providerErrorFromResponse(providerId, resp.status, text, "Video download failed");
    return Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    throw providerErrorFromUnknown(providerId, err, "Video download failed");
  }
}
