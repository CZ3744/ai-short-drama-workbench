// P20: ProviderError classification

export type ProviderErrorCode =
  | "missing_key"
  | "rate_limit"
  | "invalid_request"
  | "invalid_output"
  | "server"
  | "timeout"
  | "content_filter"
  | "insufficient_balance"
  | "content_policy"       // P186-T2: 文案违规/安全审核
  | "model_warming"        // P186-T2: 模型预热中
  | "quota_exceeded"       // P186-T2: 月/日配额用完
  | "rate_limited"         // P186-T2: 频率限制(区别于 rate_limit)
  | "invalid_prompt"       // P186-T2: 提示词参数非法
  | "unknown";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider_id: string;
  readonly retriable: boolean;
  readonly original?: unknown;

  constructor(opts: {
    message: string;
    code: ProviderErrorCode;
    provider_id: string;
    retriable?: boolean;
    original?: unknown;
  }) {
    super(opts.message);
    this.name = "ProviderError";
    this.code = opts.code;
    this.provider_id = opts.provider_id;
    // rate_limit, rate_limited and timeout are retriable by default; others are not
    this.retriable = opts.retriable ?? (opts.code === "rate_limit" || opts.code === "rate_limited" || opts.code === "timeout");
    this.original = opts.original;
  }

  /**
   * 2026-05-18: Express 全局错误中间件 (apps/server/src/index.ts `getHttpStatus`)
   * 走 `error.status ?? error.statusCode`. 没有 status 时默认返 500.
   * 加这个 getter 让 ProviderError 在 throw 出去时被中间件正确归类为
   * 400 (missing_key / invalid_request / invalid_prompt / content_policy)
   * 429 (rate_limit / rate_limited / quota_exceeded)
   * 402 (insufficient_balance)
   * 502 (server)
   * 503 (model_warming)
   * 504 (timeout)
   * 451 (content_filter)
   * — 这样用户看到 "请先配置密钥" 友好 toast 而非 "Internal server error".
   */
  get status(): number {
    return providerErrorCodeToHttpStatus(this.code);
  }

  get statusCode(): number {
    return providerErrorCodeToHttpStatus(this.code);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      provider_id: this.provider_id,
      retriable: this.retriable,
      status: this.status,
    };
  }
}

/**
 * 2026-05-18: ProviderErrorCode → HTTP status 映射.
 * 用于 ProviderError.status getter 与全局错误中间件对齐.
 */
export function providerErrorCodeToHttpStatus(code: ProviderErrorCode): number {
  switch (code) {
    case "missing_key":
    case "invalid_request":
    case "invalid_prompt":
    case "content_policy":
      return 400;
    case "content_filter":
      return 451;
    case "rate_limit":
    case "rate_limited":
    case "quota_exceeded":
      return 429;
    case "insufficient_balance":
      return 402;
    case "model_warming":
      return 503;
    case "timeout":
      return 504;
    case "invalid_output":
    case "server":
    case "unknown":
    default:
      return 502;
  }
}

/**
 * Infer a ProviderErrorCode from an HTTP status code.
 */
export class BudgetExceededError extends Error {
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export function codeFromHttpStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "missing_key";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  return "unknown";
}
