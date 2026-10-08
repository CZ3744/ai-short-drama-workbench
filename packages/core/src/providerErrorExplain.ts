/**
 * Provider Error Explanation — 中文错误解释模块
 * 将机器可读的 error_type 翻译为用户可理解的中文建议
 */

export interface ErrorExplanation {
  error_type: string;
  title: string;
  message: string;
  suggestion: string;
  can_retry: boolean;
  can_fallback: boolean;
  severity: "info" | "warn" | "error" | "critical";
}

const ERROR_MAP: Record<string, ErrorExplanation> = {
  missing_key: {
    error_type: "missing_key",
    title: "API Key 未配置",
    message: "当前视频服务商的 API Key 未填写。",
    suggestion: "请前往设置页，填写对应平台的 API Key 后重试。",
    can_retry: true,
    can_fallback: true,
    severity: "warn"
  },
  auth_failed: {
    error_type: "auth_failed",
    title: "认证失败",
    message: "API Key 可能错误、过期或没有权限。",
    suggestion: "请检查平台 API Key 是否正确、是否过期、是否有视频生成权限。可在平台控制台重新获取 Key。",
    can_retry: true,
    can_fallback: true,
    severity: "error"
  },
  insufficient_quota: {
    error_type: "insufficient_quota",
    title: "余额或额度不足",
    message: "平台账户余额或视频生成额度不足。",
    suggestion: "请到平台控制台查看余额，充值后重试。阿里云百炼在「费用中心」查看，MiniMax 在「账户中心」查看。",
    can_retry: true,
    can_fallback: true,
    severity: "error"
  },
  rate_limited: {
    error_type: "rate_limited",
    title: "请求频率超限",
    message: "短时间内发送了过多请求，被平台限流。",
    suggestion: "请等待 30 秒到 1 分钟后重试。如果频繁出现，可适当增大轮询间隔。",
    can_retry: true,
    can_fallback: true,
    severity: "warn"
  },
  provider_job_failed: {
    error_type: "provider_job_failed",
    title: "平台任务失败",
    message: "视频生成平台返回了失败状态。",
    suggestion: "可能是 prompt 内容违规、参数不支持或平台内部错误。请检查 prompt 内容，尝试简化后重试。如持续失败可切回本地模拟。",
    can_retry: true,
    can_fallback: true,
    severity: "error"
  },
  provider_job_unknown: {
    error_type: "provider_job_unknown",
    title: "平台状态未知",
    message: "视频生成平台返回了未知状态。",
    suggestion: "平台可能正在维护或返回了非标准响应。请稍后重试，或在平台控制台查看任务状态。",
    can_retry: true,
    can_fallback: true,
    severity: "warn"
  },
  poll_timeout: {
    error_type: "poll_timeout",
    title: "轮询超时",
    message: "视频生成任务长时间未完成，超过了等待时限。",
    suggestion: "任务可能仍在平台排队。可以稍后继续轮询，或在平台控制台查看任务是否已完成。不建议立即重试（可能重复扣费）。",
    can_retry: false,
    can_fallback: true,
    severity: "warn"
  },
  invalid_downloaded_video: {
    error_type: "invalid_downloaded_video",
    title: "下载的视频文件无效",
    message: "从平台下载的文件不是有效的 MP4 视频。",
    suggestion: "可能是下载中断或平台临时错误。已写入失败版本记录，可重试生成。如果反复失败，可先切回本地模拟。",
    can_retry: true,
    can_fallback: true,
    severity: "error"
  },
  parameter_invalid: {
    error_type: "parameter_invalid",
    title: "参数不支持",
    message: "模型、尺寸、时长等参数组合不在平台支持范围内。",
    suggestion: "请使用设置页或 presets 中的合法组合。例如 wan2.2-t2v-plus 仅支持 480P/1080P、固定 5 秒时长。",
    can_retry: true,
    can_fallback: true,
    severity: "warn"
  },
  real_video_job_in_progress: {
    error_type: "real_video_job_in_progress",
    title: "已有真实视频任务运行中",
    message: "当前已有另一个真实视频生成任务正在运行。",
    suggestion: "为防止重复扣费，同一时间只允许一个真实视频任务。请等待当前任务完成后再试。",
    can_retry: true,
    can_fallback: false,
    severity: "info"
  },
  download_failed: {
    error_type: "download_failed",
    title: "视频下载失败",
    message: "无法从平台下载生成的视频文件。",
    suggestion: "可能是网络问题或平台临时不可用。请检查网络连接后重试。如果平台 URL 已过期，需要重新生成。",
    can_retry: true,
    can_fallback: true,
    severity: "error"
  },
  ffprobe_failed: {
    error_type: "ffprobe_failed",
    title: "视频文件损坏",
    message: "下载的视频文件无法被 ffprobe 解析。",
    suggestion: "文件可能下载不完整或已损坏。已标记为失败版本，可重试生成。",
    can_retry: true,
    can_fallback: true,
    severity: "error"
  },
  not_supported: {
    error_type: "not_supported",
    title: "功能不支持",
    message: "当前 provider 不支持此操作。",
    suggestion: "请切换到支持的 provider，或使用本地模拟模式。",
    can_retry: false,
    can_fallback: true,
    severity: "warn"
  },
  invalid_preset: {
    error_type: "invalid_preset",
    title: "预设配置无效",
    message: "选择的 provider/model/resolution/duration 组合不在预设中。",
    suggestion: "请在设置页选择 presets 中支持的合法组合。",
    can_retry: true,
    can_fallback: true,
    severity: "warn"
  }
};

/**
 * 根据 error_type 获取中文解释
 */
export function explainProviderError(errorType: string): ErrorExplanation {
  return ERROR_MAP[errorType] || {
    error_type: errorType,
    title: "未知错误",
    message: `发生了未预期的错误类型: ${errorType}`,
    suggestion: "请重试，如果持续出现请联系开发者。可先切回本地模拟模式继续工作。",
    can_retry: true,
    can_fallback: true,
    severity: "error"
  };
}

/**
 * 根据 HTTP 状态码和响应体推断 error_type
 */
export function inferErrorType(httpStatus: number, responseBody?: string): string {
  if (httpStatus === 401 || httpStatus === 403) return "auth_failed";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 400) return "parameter_invalid";
  if (httpStatus === 402) return "insufficient_quota";

  if (responseBody) {
    const body = responseBody.toLowerCase();
    if (body.includes("insufficient") || body.includes("quota") || body.includes("balance")) return "insufficient_quota";
    if (body.includes("unauthorized") || body.includes("invalid key") || body.includes("authentication")) return "auth_failed";
    if (body.includes("rate limit") || body.includes("too many")) return "rate_limited";
  }

  return "provider_job_failed";
}

/**
 * 获取所有已知错误类型列表
 */
export function listErrorTypes(): string[] {
  return Object.keys(ERROR_MAP);
}
