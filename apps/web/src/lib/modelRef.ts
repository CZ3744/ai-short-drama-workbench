/**
 * modelRef — 前端 model_ref 解析工具 (唯一实现, 镜像后端 modelRef.ts).
 *
 * model_ref 格式: "<provider_id>:<model_id>" 或纯 "<provider_id>"
 *
 * 后端 canonical: apps/server/src/application/generation/modelRef.ts
 *   (providerIdFromModelRef / modelIdFromModelRef)
 *
 * 历史: 原有 4 处 inline split(":") 分散在:
 *   - AutoPipelineLauncher.tsx:49
 *   - ComposePage.tsx:124
 *   - InboxPage.tsx:234-235
 *   - providerKind.ts:47 (extractProviderId, 内部函数)
 *
 * 注意: model_id 本身可能含 "-" 或 "/" (如 "gpt-image-2", "google/gemini-2.5-flash-image"),
 * 因此只 split 第一个 ":", 冒号后面全部为 model_id.
 */

/** 从 model_ref 提取 provider_id.
 *  - "minimax_hailuo:hailuo-02-pro" → "minimax_hailuo"
 *  - "minimax_hailuo"               → "minimax_hailuo"
 *  - undefined / null / ""          → undefined
 */
export function parseProviderFromModelRef(ref?: string | null): string | undefined {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf(":");
  const providerId = idx >= 0 ? trimmed.slice(0, idx) : trimmed;
  return providerId.trim() || undefined;
}

/** 从 model_ref 提取 model_id (冒号后部分).
 *  - "chatgpt_codex_image:gpt-image-2"                   → "gpt-image-2"
 *  - "openrouter_image:google/gemini-2.5-flash-image"    → "google/gemini-2.5-flash-image"
 *  - "local_card_image"                                   → undefined (无冒号)
 *  - undefined / null / ""                                → undefined
 */
export function parseModelIdFromModelRef(ref?: string | null): string | undefined {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf(":");
  if (idx < 0) return undefined;
  const modelId = trimmed.slice(idx + 1).trim();
  return modelId || undefined;
}

/**
 * 标准化 model_ref — null/undefined/空白 trim 后转 undefined.
 *
 * 2026-05-28 P2#46: 原本在 ShotStagePage / FirstFrameColumn / VideoColumn
 * 各有一份本地 inline 定义 (三处一模一样). 抽到 lib/modelRef.ts 复用.
 */
export function modelRefOrUndefined(ref: string | null | undefined): string | undefined {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  return trimmed || undefined;
}
