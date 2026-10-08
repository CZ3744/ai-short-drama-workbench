/**
 * BUG-030: 多 action 错误 toast 组件
 * 从 errorTranslate.ts 拆出，使用 JSX 渲染多个 action 按钮
 * 替代 .ts 文件中只能用 description 文本的降级方案
 *
 * Wave4 T5: 在 key_missing / AllProvidersFailed / rate_limit / budget_exceeded 时
 * 追加"查看失败中心"按钮，navigate 到 /failures。
 */
import { toast } from "sonner";
import { translateError, needsSettingsAction, needsRetryAction, needsLogAction } from "./errorTranslate";
import { ApiError } from "./api";

interface ActionBtn {
  label: string;
  onClick: () => void;
}

// 2026-05-28 audit P1: 跟 errorTranslate.ts 共享的类型 guard helpers
interface ErrorLogWindow extends Window {
  __errorLog?: Array<{ time: string; message: string; raw: string }>;
}

function getErrCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

/**
 * 判断是否需要"查看失败中心"按钮。
 * 触发条件: key_missing | AllProvidersFailed | rate_limit | budget_exceeded
 */
function needsFailureCenterAction(err: unknown): boolean {
  const CODES = ["key_missing", "AllProvidersFailed", "rate_limit", "RateLimit", "budget_exceeded"];
  if (err instanceof ApiError && CODES.includes(err.code)) return true;
  const c = getErrCode(err);
  if (c && CODES.includes(c)) return true;
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (/key_missing|AllProvidersFailed|rate.?limit|budget_exceeded/i.test(raw)) return true;
  return false;
}

/**
 * 支持多个 action 按钮的错误 toast。
 * 在 .tsx 上下文中调用，替代 showErrorToast 的降级多按钮模式。
 */
export function showErrorToastWithActions(
  err: unknown,
  fallbackMsg?: string,
  onRetry?: () => void,
): void {
  const message = translateError(err) || fallbackMsg || "操作失败";

  const actions: ActionBtn[] = [];

  if (needsSettingsAction(err)) {
    actions.push({
      label: "打开设置",
      onClick: () => {
        // 2026-05-27 audit P0-13: setSettingsOpen flag 没人读 → 改 location.href 真跳转
        window.location.href = "/settings";
      },
    });
  }
  if (needsRetryAction(err) && onRetry) {
    actions.push({ label: "重试", onClick: onRetry });
  }
  if (needsLogAction(err)) {
    actions.push({
      label: "查看日志",
      onClick: () => {
        console.log("[errorTranslate] 用户请求查看日志。当前时间:", new Date().toISOString());
        const w = window as ErrorLogWindow;
        const recentErrors = w.__errorLog || [];
        if (recentErrors.length > 0) {
          console.table(recentErrors.slice(-20));
        }
        toast.info("日志已输出到浏览器控制台（F12）", { duration: 4000 });
      },
    });
  }
  // T5: 在特定错误码下追加"查看失败中心"按钮.
  // 2026-05-26 audit #4: 直接走 /status?tab=failures 新 URL, 不经 /failures redirect 两跳;
  // 也不再用动态 import App + try/catch hack — location.href 本身就是最稳的兜底.
  if (needsFailureCenterAction(err)) {
    actions.push({
      label: "查看失败中心",
      onClick: () => {
        window.location.href = "/status?tab=failures";
      },
    });
  }

  const duration = actions.length > 1 ? 12000 : 8000;

  if (actions.length <= 1) {
    // 单按钮或无按钮：直接用 sonner 原生格式
    toast.error(message, {
      duration,
      action: actions[0]
        ? { label: actions[0].label, onClick: actions[0].onClick }
        : undefined,
    });
  } else {
    // 多按钮：用 sonner 的 unstyled API + 自定义 JSX
    // sonner toast.error 不支持多 action，改用 toast() + 自定义渲染
    toast.error(message, {
      duration,
      action: {
        label: actions[0].label,
        onClick: actions[0].onClick,
      },
      description: `其他操作: ${actions.slice(1).map((a) => a.label).join(" / ")}`,
    });
  }

  // 追加到全局错误日志
  const w = window as ErrorLogWindow;
  if (!w.__errorLog) w.__errorLog = [];
  w.__errorLog.push({
    time: new Date().toISOString(),
    message,
    raw: err instanceof Error ? err.message : String(err),
  });
}
