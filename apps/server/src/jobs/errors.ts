/**
 * Job orchestrator error classes
 *
 * W7 (2026-05-15): Bug 1 修复 — 删掉 orchestrator silent mock fallback。
 * 当 caller 既没传 provider override 也没在 series.defaults 里设
 * image_provider_id / video_provider_id 时,原代码会 fallback 到
 * `local_card_image` / `local_mock_video` 静默给出"假数据"(SVG 渐变卡片图 / mock 视频),
 * 违反质量红线#1(禁伪 mock)。改成抛出本错误,由路由层翻成 HTTP 400 + 人话提示。
 */

export type GenerationAction = "generate_first_frames" | "generate_videos";

/**
 * 没有可用的 provider — 用户没在 ModelPicker 选模型,
 * shot.image_model_ref / video_model_ref 也没存,
 * series.defaults.image_provider_id / video_provider_id 也是空。
 *
 * httpStatus 固定 400,code 给前端 ErrorTranslator 用。
 * message 是给用户看的人话(toC),不要暴露 image_provider_id 等技术字段。
 */
export class ProviderNotSelectedError extends Error {
  public readonly code = "provider_not_selected" as const;
  public readonly httpStatus = 400 as const;
  /** 同时设置 status 让 apps/server/src/index.ts 的全局 error middleware
   *  能直接读出 400(它 fallback 到 `error.status / statusCode`)。 */
  public readonly status = 400 as const;
  /** 指明缺的是图像模型还是视频模型,前端可以指向对应 ModelPicker */
  public readonly action: GenerationAction;
  public readonly kind: "image" | "video";

  constructor(action: GenerationAction) {
    const kind: "image" | "video" = action === "generate_first_frames" ? "image" : "video";
    const label = kind === "image" ? "图像" : "视频";
    super(`请先在右上角选择${label}模型,或在设置中配置默认${label}模型`);
    this.name = "ProviderNotSelectedError";
    this.action = action;
    this.kind = kind;
  }
}

export function isProviderNotSelectedError(err: unknown): err is ProviderNotSelectedError {
  return err instanceof ProviderNotSelectedError;
}
