/**
 * 真实付费图像 provider 名单 — 与视频侧 `isRealVideoProvider` (packages/core/src/realVideoLock.ts) 对称。
 *
 * 2026-07-22 X1 (A5-5 / A6-4): 图像侧的预算冻结 / 估价 fail-closed 需要判定"这个图像 provider 是否
 * 调外部付费 API 计费"。视频侧靠 REAL_VIDEO_PROVIDERS 判定, 图像侧一直缺这个 helper, 导致:
 *   - budgetGuard 冻结旁路: 用户把日预算设为 ¥0 想彻底停付费生成时, 零单价 preset 的付费图像 provider
 *     (estimate=0) 会绕过 `dailyTotal + 0 > 0` 恒 false 的普通熔断 → 图像仍被放行扣费。
 *   - 估价失败静默 return 0: 付费图像 provider 的 estimateCost 抛异常时, 静默当 0 处理 = 绕过预算 preflight。
 *
 * 只列"调外部付费 API 按次计费"的图像 provider。**不含**:
 *   - 本地免费: local_card_image / local_sdxl_openclaw
 *   - 订阅制 codex (走用户 ChatGPT 会话、不按次计费, 通常也不返回 cost): openai_via_codex / chatgpt_codex_image
 *   - 用户自定义 openai-compat 实例 (动态 id, 无法静态枚举; 与 isRealVideoProvider 同样的静态名单局限)
 *
 * id 必须与 packages/providers/src/core/registry.ts 注册的图像 provider id 完全一致。
 */
const REAL_PAID_IMAGE_PROVIDERS = new Set<string>([
  "jimeng_image_4",       // 字节即梦图像 4
  "aliyun_wanx_26",       // 阿里通义万相图像 (异步付费)
  "openai_gpt_image_2",   // OpenAI GPT Image
  "openrouter_gemini_image", // OpenRouter Gemini 图像
  "openrouter_flux_11_pro",  // OpenRouter Flux 1.1 Pro
]);

/** 判定 providerId 是否为"调外部付费 API 计费"的图像 provider (用于预算冻结 / 估价 fail-closed)。 */
export function isRealPaidImageProvider(providerId: string): boolean {
  return REAL_PAID_IMAGE_PROVIDERS.has(providerId);
}
