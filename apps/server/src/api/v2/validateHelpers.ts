/**
 * OPT-008: 共享验证辅助函数
 * 消除所有 controller 中重复的 `if (!v.ok) { res.status(v.status).json({...}) }` 模式
 *
 * A-8 (2026-05-12): 同时提供 sendError / sendOk 统一错误/成功响应格式. 之前 routes.ts
 * 老路用 { ok:true/false, message }, v2 用 { error: { code, message } },
 * imageRoutes 又用 { ok:false, error, error_type }, 三套形态前端必须三路兼容.
 * 新增 controller 一律走 sendError/sendOk; 旧的迁移时一并替换.
 *
 * B-P0-2 (2026-06-01): 新增 assertProviderSelectedOrErr — 统一 provider_not_selected
 * 三层校验逻辑, 消除 shotController / elementController 各自手动重复实现.
 * 修复 shotController 只查 image_provider_id 漏查 default_image 的一致性 bug.
 */
import type { Response } from "express";
import type { ValidationResult } from "./validators";
import { readSeries } from "./seriesStore";

export function handleValidationError<T>(
  res: Response,
  v: ValidationResult<T>
): v is Extract<ValidationResult<T>, { ok: false }> {
  if (!v.ok) {
    res.status(v.status).json({
      error: {
        code: "ValidationError",
        message: "请求体校验失败",
        details: v.errors,
      },
    });
    return true;
  }
  return false;
}

function scrubErrorText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-]{16,}/g, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-[REDACTED]")
    .replace(/tp-[a-z0-9]{20,}/g, "tp-[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]")
    .replace(/"(api_?key|token|secret)"\s*:\s*"[^"]{8,}"/gi, '"$1":"[REDACTED]"');
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  res.status(status).json({
    error: {
      code,
      message: scrubErrorText(message),
      ...(details !== undefined ? { details } : {}),
    },
  });
}

export function sendOk<T extends Record<string, unknown> = Record<string, unknown>>(
  res: Response,
  data?: T,
  message?: string,
): void {
  res.json({
    ok: true,
    ...(data ?? {}),
    ...(message ? { message } : {}),
  });
}

/**
 * B-P0-2: 统一 provider_not_selected 三层校验。
 *
 * 三层来源优先级(任一非空都算"已选定"):
 *   1) body 里 caller 显式传的 model_ref (ModelPicker 选的) — fromBody
 *   2) shot/element 上保存的模型偏好                       — fromEntity
 *   3) series.defaults.{image|video}_provider_id           — series 旧字段
 *      series.defaults.default_image (新建系列字段)         — series 新字段 (仅 image kind)
 *
 * 都空 → 写 HTTP 400 + `provider_not_selected`,返回 true 表示已写响应,调用方应直接 return。
 * 返回 false 表示通过校验。
 *
 * 修复说明: 原 shotController 只查 image_provider_id,漏查 default_image,
 * elementController/generation.ts:generate-image 已查两个字段但 dry-run 路径只查旧字段。
 * 本函数统一同时检查两个字段,保证所有 caller 行为一致。
 */
export async function assertProviderSelectedOrErr(
  res: Response,
  kind: "image" | "video",
  fromBody: string | null | undefined,
  fromEntity: string | null | undefined,
  seriesSlug: string,
): Promise<boolean> {
  if (fromBody && fromBody.trim()) return false;
  if (fromEntity && fromEntity.trim()) return false;
  const series = await readSeries(seriesSlug);
  let defaultProvider: string | undefined;
  if (kind === "image") {
    // 同时检查新旧两个字段: default_image (新建系列) 和 image_provider_id (旧字段)
    defaultProvider =
      ((series?.defaults as Record<string, any>)?.default_image?.trim?.())
      || series?.defaults?.image_provider_id?.trim();
  } else {
    defaultProvider = series?.defaults?.video_provider_id?.trim();
  }
  if (defaultProvider && defaultProvider.trim()) return false;
  const label = kind === "image" ? "图像" : "视频";
  sendError(
    res,
    400,
    "provider_not_selected",
    `请先在右上角选择${label}模型,或在设置中配置默认${label}模型`,
  );
  return true;
}
