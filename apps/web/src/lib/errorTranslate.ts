/**
 * E2 · 统一错误消息翻译 + P170 1E toast 动作 + P170 Wave4 4F 全局错误态优化
 *
 * 把后端技术消息翻译成用户可理解的中文。
 * 由 P160 Wave E 定义，P170 Wave 1 1E 增强，P170 Wave 4 4F 加入动态模板插值与多 action 按钮。
 */

import { toast } from "sonner";
import { ApiError } from "./api";

// ---- 模板插值 ----

/**
 * 简易模板插值：将 "{key}" 替换为 data 中对应值。
 */
function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = data[key];
    return v !== undefined && v !== null ? String(v) : `{${key}}`;
  });
}

// ---- 类型 guard helpers (2026-05-28 audit P1: 收敛 unknown 错误对象的字段读取, 替代 any 强转) ----

/**
 * 从未知 err 安全读 property。返回 unknown,调用方需自检 typeof.
 * 替代项目内历史上 18 处对错误对象的强类型转换 (err -> any 后读 .xxx)。
 */
function getErrorProp(err: unknown, key: string): unknown {
  if (err && typeof err === "object" && key in err) {
    return (err as Record<string, unknown>)[key];
  }
  return undefined;
}

/** 从 unknown err 读 string 类型的 code (常见 ApiError.code 或 err.code) */
function getErrorCode(err: unknown): string | undefined {
  const code = getErrorProp(err, "code");
  return typeof code === "string" ? code : undefined;
}

/** 全局错误日志类型 — window.__errorLog 通过此接口强声明, 不再走 any 强转 */
interface ErrorLogWindow extends Window {
  __errorLog?: Array<{ time: string; message: string; raw: string }>;
}

/**
 * 从错误对象提取可用的模板变量。
 * 优先级：ApiError.details > err.details > err.顶层的 provider_name / N / limit 等键
 */
function extractTemplateData(err: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  // 1. ApiError.details（后端标准格式）
  if (err instanceof ApiError && err.details && typeof err.details === "object" && !Array.isArray(err.details)) {
    Object.assign(data, err.details as Record<string, unknown>);
  }

  // 2. 通用对象的 details
  if (err && typeof err === "object") {
    const d = getErrorProp(err, "details");
    if (d && typeof d === "object" && !Array.isArray(d)) {
      Object.assign(data, d);
    }
    // 3. 顶层常用变量
    for (const key of ["provider_name", "providerName", "N", "limit", "count", "budget_limit", "timeout_sec"]) {
      const v = getErrorProp(err, key);
      if (v !== undefined && v !== null) {
        // 归一化 key 名
        if (key === "providerName") data["provider_name"] = v;
        else if (key === "budget_limit") data["limit"] = v;
        else data[key] = v;
      }
    }
  }

  // 兜底：如果 provider_name 仍未解析，尝试从消息中提取
  if (!data["provider_name"]) {
    const raw = extractMessage(err);
    const m = raw.match(/provider[:\s]+(\w+)/i) || raw.match(/"(mimo_\w+|openai|gemini|claude)"/i);
    if (m) data["provider_name"] = m[1];
  }
  if (!data["N"]) {
    // 尝试从"备选 N 家"之类消息提取
    const raw = extractMessage(err);
    const m = raw.match(/备选\s*(\d+)/) || raw.match(/尝试了?\s*(\d+)\s*家/);
    if (m) data["N"] = m[1];
  }

  return data;
}

// ---- 翻译表（支持静态字符串与动态函数） ----

type Translator = string | ((data: Record<string, unknown>) => string);

const ERROR_TRANSLATIONS: Array<{ pattern: RegExp; translate: Translator }> = [
  // 2026-07-22 Y5 (UP-5): 本地 SDXL 未配置 — 防御英文裸串 (Y1 已把源头 message 改中文人话,
  // 此处兜底旧缓存 / 其它 emit 点的英文串). "打开设置" action 由 needsSettingsAction 触发.
  {
    pattern: /python_path|executor\.(python|script)|not configured in preset|OpenClaw.*not configured/i,
    translate: "本地 SDXL 图像模型还没配置好，请到设置页补全本地图像模型配置，或先选「本地卡片图 · 免费」这类无需配置的渠道出图",
  },
  // 2026-07-22 Y5 (UP-5): 引用素材文件缺失 — 防御任何抛"无法读取参考资源 + 绝对路径"的旧路径
  // (Y2 已把源头 resolveRef.ts 改人话无路径, 此处兜底并保证零路径 / 零内部 id 见人).
  {
    pattern: /无法读取参考资源|无法读取.{0,6}参考|参考资源.{0,4}(缺失|不存在|无法读取)|reference (image |asset )?(not found|missing|unreadable)/i,
    translate: "引用的素材文件缺失了，请重新导入或重新挑选参考图",
  },
  { pattern: /plan_storyboard.*(?:500|failed|error)/i, translate: "分镜生成遇到问题，请重试" },
  { pattern: /AllProvidersFailed|所有 LLM|LLM.*全部失败|fallback.*链.*失败/i, translate: "AI 模型调用链路全部失败，请打开设置检查 API Key" },
  { pattern: /rate.?limit/i, translate: "调用太频繁，等 10 秒再试" },

  // P170 4F: provider_unavailable 动态 —— "{provider_name} 当前不可用，已尝试备选 {N} 家"
  {
    pattern: /provider_unavailable/i,
    translate: (d) => {
      const name = d["provider_name"] ? String(d["provider_name"]) : "该 Provider";
      const n = d["N"] ? String(d["N"]) : "多";
      return `${name} 当前不可用，已尝试备选 ${n} 家`;
    },
  },

  // P170 4F: budget_exceeded 动态 —— "超出今日预算 ¥{limit}，剩余任务已暂停"
  {
    pattern: /budget_exceeded|budget.*exceed/i,
    translate: (d) => {
      const limit = d["limit"] ? String(d["limit"]) : d["budget_limit"] ? String(d["budget_limit"]) : "";
      if (limit) return `超出今日预算 ¥${limit}，剩余任务已暂停`;
      return "超出今日预算，剩余任务已暂停。可调整设置 → 运行限制";
    },
  },

  // P170 4F: timeout 明确 —— "请求超时(30s)，请检查网络或重试"
  { pattern: /timeout|timed.?out/i, translate: "请求超时(30s)，请检查网络或重试" },

  // P170 4F: missing_key 动态 —— "{provider_name} 的 API Key 未配置，点击去设置"
  {
    pattern: /key_missing|missing.?key/i,
    translate: (d) => {
      const name = d["provider_name"] ? String(d["provider_name"]) : "";
      if (name) return `${name} 的 API Key 未配置，点击去设置`;
      return "请在设置里填写对应 Provider 的 API Key";
    },
  },

  { pattern: /unauthorized|401|auth.*invalid/i, translate: "认证已过期，请重新登录" },
  { pattern: /network|fetch.*fail|ECONNREFUSED/i, translate: "网络连接失败，请确认服务器正在运行" },
  { pattern: /quota|rate.*exceeded|too many requests/i, translate: "额度已用完，请稍后再试或更换 Provider" },
  { pattern: /provider_job_failed/i, translate: "视频生成失败" },
  { pattern: /invalid_output/i, translate: "生成结果格式异常" },
  { pattern: /INTERNAL_ERROR/i, translate: "服务器内部错误" },
  { pattern: /EmptyImageBuffer/i, translate: "图像生成返回空数据" },
  { pattern: /provider_in_progress/i, translate: "当前有任务正在生成中，请等待完成" },
  { pattern: /not found|404|ENOENT/i, translate: "请求的资源不存在" },
  { pattern: /server error|500|internal/i, translate: "服务器内部错误，请稍后重试" },
  { pattern: /parse.*error|invalid.*json|syntax error/i, translate: "数据解析出错，请检查输入内容" },
];

// ---- 工具函数 ----

/**
 * 客户端安全过滤：去掉可能泄露在错误消息中的 token/密钥片段。
 * 防御层，后端 `scrubForClient` 已做过一轮，这里再做一次客户端侧的二次防护。
 */
function scrubForClient(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-]{16,}/g, "Bearer [REDACTED]")
    // W-4.2: 同步后端 — Vidu Token 格式
    .replace(/Token\s+[A-Za-z0-9+/=_-]{16,}/g, "Token [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-[REDACTED]")
    .replace(/tp-[a-z0-9]{20,}/g, "tp-[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]")
    .replace(/"(api_?key|token|secret)"\s*:\s*"[^"]{8,}"/gi, '"$1":"[REDACTED]"')
    // W-4.2: 同步后端 — header 风格 api-key/x-api-key
    .replace(/(api[-_]?key|x-api-key)\s*[:=]\s*[A-Za-z0-9+/=_-]{8,}/gi, "$1: [REDACTED]")
    // 2026-07-22 Y5 (UP-5): 内网绝对路径 (Windows 盘符 + 反斜杠) → 占位, 防 C:/Projects/video-studio\... 糊脸.
    // 要求盘符后紧跟反斜杠, 天然排除 http:// 等 URL, 不会误伤.
    .replace(/[A-Za-z]:\\[^\s"'<>|)\]]+/g, "[本地文件]")
    // 内部 asset id (asset_<时间戳>_<hex>) → 人话占位, 防 asset_1784699642689_c7163757-ff5 见人.
    .replace(/\basset_\d{6,}_[A-Za-z0-9-]+/g, "素材");
}

/** 从 Error 实例或任意值提取可读的信息字符串 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const detail =
      getErrorProp(err, "detail") ??
      getErrorProp(err, "message") ??
      getErrorProp(err, "error") ??
      "";
    if (typeof detail === "string") return detail;
  }
  return "";
}

/** 提取后端返回的 suggestion（如果有） */
function extractSuggestion(err: unknown): string | undefined {
  if (err instanceof ApiError && err.suggestion) return err.suggestion;
  if (err && typeof err === "object") {
    const sug = getErrorProp(err, "suggestion");
    if (typeof sug === "string" && sug.length > 0) return sug;
  }
  return undefined;
}

// ---- Action 按钮判定 ----

/** 判断是否需要"打开设置"按钮 */
export function needsSettingsAction(err: unknown): boolean {
  const codes = ["AllProvidersFailed", "MissingKey", "key_missing", "provider_unavailable", "budget_exceeded"];
  if (err instanceof ApiError && codes.includes(err.code)) return true;
  const raw = extractMessage(err);
  if (/AllProvidersFailed|missing.?key|key_missing|provider_unavailable|budget_exceed/i.test(raw)) return true;
  // 2026-07-22 Y5 (UP-5): 本地 SDXL 未配置 (code=invalid_request 太泛, 按 message 关键词判定) —
  // 同时命中 Y1 的中文人话 message ("...配置好运行环境...") 与英文防御串 (python_path/executor).
  if (/python_path|executor\.(python|script)|SDXL|配置好运行环境|本地图像模型.{0,6}配置/i.test(raw)) return true;
  const code = getErrorCode(err);
  if (code && codes.includes(code)) return true;
  return false;
}

/** 判断是否需要"重试"按钮 */
export function needsRetryAction(err: unknown): boolean {
  const codes = ["timeout", "TimedOut", "network_error", "ECONNREFUSED"];
  if (err instanceof ApiError && codes.includes(err.code)) return true;
  const raw = extractMessage(err);
  if (/timeout|timed.?out|network|fetch.*fail|ECONNREFUSED/i.test(raw)) return true;
  const code = getErrorCode(err);
  if (code && codes.includes(code)) return true;
  return false;
}

/** 判断是否需要"查看日志"按钮 */
export function needsLogAction(err: unknown): boolean {
  const raw = extractMessage(err);
  // 链路失败、provider 不可用 等复杂错误建议查看日志
  if (/AllProvidersFailed|fallback.*链.*失败|provider_unavailable/i.test(raw)) return true;
  const codes = ["AllProvidersFailed", "provider_unavailable"];
  if (err instanceof ApiError && codes.includes(err.code)) return true;
  const code = getErrorCode(err);
  if (code && codes.includes(code)) return true;
  return false;
}

// ---- 全局副作用 ----

/** 打开设置页 — 2026-05-27 audit P0-12 修
 * 之前调 useSessionStore.setSettingsOpen(true) 但 settingsOpen 字段全项目无人读,
 * 用户点 toast "打开设置" 按钮 silent no-op. 改 location.href = "/settings" 兜底,
 * 跟 MultiActionToast "查看失败中心" 同款做法 (errorTranslate.ts 不是 component, 没法
 * 用 useNavigate).
 */
function openSettings() {
  window.location.href = "/settings";
}

/** 打开浏览器控制台（方便用户查看日志） */
function openConsoleLogs() {
  console.log("[errorTranslate] 用户请求查看日志。当前时间:", new Date().toISOString());
  // 向用户展示控制台，并复制最近错误到剪贴板（可选）
  const w = window as ErrorLogWindow;
  const recentErrors = w.__errorLog || [];
  if (recentErrors.length > 0) {
    console.table(recentErrors.slice(-20));
  }
  // 显示提示
  toast.info("日志已输出到浏览器控制台（F12）", { duration: 4000 });
}

// ---- 公共 API ----

/**
 * 把后端技术消息翻译成用户可理解的中文。
 *
 * 支持模板变量插值：
 *   - {provider_name} 来自 err.details.provider_name 或 err.provider_name
 *   - {N}            来自 err.details.N 或 err.N（备选数量）
 *   - {limit}        来自 err.details.limit 或 err.limit（预算额度）
 *
 * @param err - 可以是 Error 实例、字符串、或任意抓取对象
 * @returns 用户友好的中文错误消息
 *
 * @example
 * translateError(new ApiError("provider_unavailable", "...", 503, { provider_name: "mimo_v25pro", N: 3 }))
 * // "mimo_v25pro 当前不可用，已尝试备选 3 家"
 *
 * translateError(new ApiError("budget_exceeded", "...", 402, { limit: 50 }))
 * // "超出今日预算 ¥50，剩余任务已暂停"
 */
export function translateError(err: unknown): string {
  const raw = extractMessage(err);

  // 先检查是否有后端 suggestion（更具体）
  // 2026-05-28 P1-13: suggestion 也走 scrubForClient — 后端 scrub 一次, 客户端再防一层,
  // 避免 Bearer / sk-* / JWT 等密钥泄露到 toast 上.
  const suggest = extractSuggestion(err);
  if (suggest) {
    if (raw) console.error("[translateError]", raw);
    return scrubForClient(suggest);
  }

  // 提取模板变量（用于动态消息）
  const tplData = extractTemplateData(err);

  // 优先按 pattern 匹配
  for (const { pattern, translate } of ERROR_TRANSLATIONS) {
    if (pattern.test(raw)) {
      if (raw) console.error("[translateError]", raw);
      if (typeof translate === "function") return translate(tplData);
      return translate;
    }
  }

  // 如果 err 是 ApiError 且有 detail，仍然尝试匹配 detail
  const detailVal = getErrorProp(err, "detail");
  if (typeof detailVal === "string" && detailVal.length > 0) {
    const detail = detailVal;
    if (detail !== raw) {
      for (const { pattern, translate } of ERROR_TRANSLATIONS) {
        if (pattern.test(detail)) {
          if (detail) console.error("[translateError]", detail);
          if (typeof translate === "function") return translate(tplData);
          return translate;
        }
      }
    }
  }

  // 都不匹配：返回原消息（经 scrub 过滤）或兜底
  const scrubbed = scrubForClient(raw);
  if (raw) console.error("[translateError]", raw);
  return scrubbed || "操作失败，请重试";
}

// ---- showErrorToast ----

/**
 * P170 4F: 显示带 action 按钮的错误 toast。
 *
 * 根据错误类型自动决定显示哪个 action 按钮：
 * - "打开设置"：key 缺失、provider 不可用、预算超限
 * - "重试"：超时、网络错误（需传 onRetry 回调）
 * - "查看日志"：链路全部失败、provider 不可用（复杂错误）
 *
 * @param err          - 错误对象
 * @param fallbackMsg  - 兜底消息（当无法从 err 提取时）
 * @param onRetry      - 点击"重试"的回调（缺省则无重试按钮）
 */
export function showErrorToast(err: unknown, fallbackMsg?: string, onRetry?: () => void): void {
  const message = translateError(err) || fallbackMsg || "操作失败";

  // 收集需要的 action 按钮（按优先级排列）
  interface ActionBtn {
    label: string;
    onClick: () => void;
  }
  const actions: ActionBtn[] = [];

  if (needsSettingsAction(err)) {
    actions.push({ label: "打开设置", onClick: () => openSettings() });
  }
  if (needsRetryAction(err) && onRetry) {
    actions.push({ label: "重试", onClick: onRetry });
  }
  if (needsLogAction(err)) {
    actions.push({ label: "查看日志", onClick: () => openConsoleLogs() });
  }

  const duration = actions.length > 1 ? 12000 : 8000;

  if (actions.length === 1) {
    // 单个按钮：用 sonner 原生格式
    toast.error(message, {
      duration,
      action: {
        label: actions[0].label,
        onClick: actions[0].onClick,
      },
    });
  } else if (actions.length > 1) {
    // 多按钮：优先使用主 action，次要 action 放入 description。
    // 完整多按钮渲染见 MultiActionToast.tsx（.tsx 文件支持 JSX）。
    // 此处保持兼容：主 action 可点击，次要 action 以文字提示。
    const primaryAction = actions[0];
    const extraActions = actions.slice(1);
    toast.error(message, {
      duration,
      action: {
        label: primaryAction.label,
        onClick: primaryAction.onClick,
      },
      description: extraActions.map((a) => `• ${a.label}`).join("\n"),
    });
    // 执行次要 action 的 onClick 绑定到全局快捷方式，供 description 文字引导
    // （用户需在 .tsx 上下文中使用 showErrorToastWithActions 获得完整按钮体验）
  } else {
    toast.error(message);
  }

  // 追加到全局错误日志（供“查看日志”引用）
  const w = window as ErrorLogWindow;
  if (!w.__errorLog) w.__errorLog = [];
  w.__errorLog.push({
    time: new Date().toISOString(),
    message,
    raw: extractMessage(err),
  });
}

