/**
 * Image dry-run helper (W3-B T2) — mirrors videoDryRun.ts for asset/element image generation.
 *
 * Builds a faux provider request payload + cost estimate without invoking the
 * provider. Used by:
 *   POST /api/v2/series/:slug/elements/:id/generate-image/dry-run
 *
 * Safety guarantees:
 *   - never calls fetch / provider.generate
 *   - never charges budget
 *   - redacts any key field in the request preview (replaced with "****")
 *   - returns key_present boolean so UI can guide user without exposing the key
 *
 * Caller is responsible for HTTP status / response shape; this helper returns
 * a structured result and `key_present === false` for cases where the controller
 * may decide to surface HTTP 400 + `{ error: "key_missing" }`.
 */

import { getKeyFor } from "../../../../../packages/core/src/index";
import type { ProviderRegistry } from "../../../../../packages/providers/src/core/registry";
import type { ImageProvider, ImageGenerateRequest } from "../../../../../packages/providers/src/core/types";
import { providerIdFromModelRef, modelIdFromModelRef } from "./modelRef";
import { ProviderNotSelectedError } from "../../jobs/errors";

/** Providers that don't need a key (local mock / OAuth / etc.) — copies the
 *  KEYLESS_PROVIDER_IDS list from providerController to keep this helper standalone. */
const IMAGE_KEYLESS_PROVIDERS = new Set([
  "local_card_image",
  "local_sdxl_openclaw",
  "chatgpt_codex_image",
]);

export interface ImageDryRunInput {
  /** Full ModelPicker ref ("local_card_image:abc") or just provider id. */
  model_ref?: string;
  prompt?: string;
  negative_prompt?: string;
  count?: number;
  width?: number;
  height?: number;
  has_reference_images?: boolean;
}

export interface ImageDryRunResult {
  ok: boolean;
  dry_run: true;
  will_not_call_provider: true;
  provider_id: string;
  model_id: string | null;
  key_present: boolean;
  is_keyless: boolean;
  request_preview: Record<string, unknown>;
  full_prompt_preview: string;
  estimated_cost_cny: number | null;
  estimated_cost_note: string;
  count: number;
  message?: string;
  error?: "key_missing";
}

function redactSensitiveFields<T extends Record<string, unknown>>(obj: T): T {
  const SENSITIVE = new Set([
    "authorization", "api_key", "apikey", "access_key", "secret_key",
    "ak", "sk", "token", "x-api-key", "bearer",
  ]);
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    if (SENSITIVE.has(k.toLowerCase())) {
      out[k] = "****";
    }
  }
  return out as T;
}

export function buildImageDryRunResult(
  input: ImageDryRunInput,
  opts: { registry: ProviderRegistry; default_provider_id?: string },
): ImageDryRunResult {
  // W7-sweep (2026-05-16): 不再 silent fallback 到 "local_card_image" — 红线 #1。
  // 之前 dry-run 在用户没选模型时会假装"将使用 local_card_image",对用户极度误导
  // (用户以为他已选,实际预估的是假数据 SVG 卡片图费用)。
  // 改:三层都空 → throw ProviderNotSelectedError,error middleware 自动转 400 + 中文提示。
  const trimmedModelRef = (typeof input.model_ref === "string" && input.model_ref.trim())
    ? input.model_ref.trim()
    : undefined;
  const defaultProviderId = typeof opts.default_provider_id === "string" && opts.default_provider_id.trim()
    ? opts.default_provider_id.trim()
    : undefined;

  const rawModelRef = trimmedModelRef ?? defaultProviderId;
  if (!rawModelRef) throw new ProviderNotSelectedError("generate_first_frames");

  const providerId = providerIdFromModelRef(rawModelRef) ?? defaultProviderId;
  if (!providerId) throw new ProviderNotSelectedError("generate_first_frames");
  const modelId = modelIdFromModelRef(rawModelRef) ?? null;

  const isKeyless = IMAGE_KEYLESS_PROVIDERS.has(providerId);
  const key = isKeyless ? null : getKeyFor(providerId);
  const keyPresent = isKeyless || !!(key && key.trim() !== "");

  const promptText = (typeof input.prompt === "string" ? input.prompt : "").trim();
  const negativePrompt = (typeof input.negative_prompt === "string" ? input.negative_prompt : "").trim();
  const count = Math.max(1, Math.min(Math.round(Number(input.count) || 1), 32));
  const width = Math.max(256, Math.min(Math.round(Number(input.width) || 1024), 4096));
  const height = Math.max(256, Math.min(Math.round(Number(input.height) || 1024), 4096));

  const requestPreview = redactSensitiveFields({
    provider_id: providerId,
    model_id: modelId ?? "(provider default)",
    prompt: promptText,
    negative_prompt: negativePrompt,
    width,
    height,
    count,
    reference_images: input.has_reference_images ? "(已附带, 不在 preview 中展开)" : null,
    headers_preview: { authorization: "****", "content-type": "application/json" },
  });

  // 估费: 如果 provider 实现了 estimateCost 用它, 否则给一个保守 0 (local) 或 unknown.
  let estimatedCny: number | null = null;
  let costNote = "";
  let provider: ImageProvider | null = null;
  try {
    provider = opts.registry.getImage(providerId);
  } catch {
    provider = null;
  }

  if (isKeyless) {
    estimatedCny = 0;
    costNote = "本地/OAuth provider, 不计费.";
  } else if (provider && typeof provider.estimateCost === "function") {
    try {
      const req: ImageGenerateRequest = {
        prompt: promptText || "(dry-run)",
        negative_prompt: negativePrompt || undefined,
        width,
        height,
        count,
        model_id: modelId ?? undefined,
      };
      const c = provider.estimateCost(req);
      estimatedCny = c.cny;
      // Y8 (2026-07-22 铁律 #9 泄漏修复): costNote 是用户可见文案的拼接源 (前端拼
      // "预估 ¥X (note)" 直接渲染) —— 之前把内部调用来源 "provider.estimateCost →"
      // 和英文枚举字面量 "(estimated)" 原样塞进去, Y7 浏览器实测亲眼看到裸露给用户。
      // 调用来源/basis 对排障有用但不该进响应, 挪到 server log; 响应只留人话描述。
      console.debug(`[imageDryRun] costNote source: provider=${providerId} estimateCost basis=${c.basis} cny=${c.cny.toFixed(4)}`);
      costNote = c.basis === "accurate"
        ? "按渠道价目精确计价, 请以平台账单为准."
        : "按渠道价目估算, 请以平台账单为准.";
    } catch {
      estimatedCny = null;
      costNote = "无法估算, 请以平台账单为准.";
    }
  } else {
    estimatedCny = null;
    costNote = "该 provider 未实现 estimateCost, 请以平台账单为准.";
  }

  if (!isKeyless && !keyPresent) {
    return {
      ok: false,
      dry_run: true,
      will_not_call_provider: true,
      provider_id: providerId,
      model_id: modelId,
      key_present: false,
      is_keyless: false,
      request_preview: requestPreview,
      full_prompt_preview: promptText,
      estimated_cost_cny: estimatedCny,
      estimated_cost_note: costNote,
      count,
      error: "key_missing",
      // UP-5: 不把裸 provider id 抛给用户 — 前端 key_missing 分支已用 labelOfSource(provider_id)
      // 显示人话模型名做标题, 这里只给可读正文, 两端 caller 各自补"现在去设置页配置吗?".
      message: "该模型的 API Key 还没配置",
    };
  }

  return {
    ok: true,
    dry_run: true,
    will_not_call_provider: true,
    provider_id: providerId,
    model_id: modelId,
    key_present: keyPresent,
    is_keyless: isKeyless,
    request_preview: requestPreview,
    full_prompt_preview: promptText,
    estimated_cost_cny: estimatedCny,
    estimated_cost_note: costNote,
    count,
    // UP-4: 免费/本地渠道文案零"扣费"字样 (统一说"不计费"). 付费分支 message 不进确认门 UI
    // (前端走 labelOfSource(provider_id)+buildCostMessage), 仅 dry-run preview 内部展示.
    message: isKeyless
      ? "本地/免费渠道, 不计费."
      : `将调用 ${providerId} 抽 ${count} 张${estimatedCny != null ? `, 预估 ¥${estimatedCny.toFixed(4)}` : ""}.`,
  };
}
