/**
 * Provider Controller — Shared types, storage helpers, builtin presets, and status helpers.
 *
 * Split from providerController.ts (Wave Z-9).
 * This module contains zero route handlers; it only exports types and pure/shared functions.
 */

import {
  getSecretStatus,
  getConfigValue,
  getKeyFor,
  readLocalSettings,
  writeLocalSettings,
} from "../../../../../../packages/core/src/localSettings";
import { listPresets } from "../../../../../../packages/core/src/presets";
import { getStatus as getChatgptOauthStatus } from "../../../../../../packages/core/src/chatgptOauth";
import {
  getCachedHealth,
  setCachedHealth,
  clearHealthCache,
} from "../providersHealthCache";
import { loggerSync } from "../../../../../../packages/core/src/logger";

// ── Types ───────────────────────────────────────────────────────

export interface ProviderConfig {
  id: string;
  label_zh: string;
  kind: "llm" | "image" | "video" | "tts";
  api_type: "openai_compat" | "anthropic" | "custom";
  base_url: string;
  api_key?: string;
  model_id?: string;
  model_list_cache?: string[];
  model_list_fetched_at?: string;
  anthropic_version?: string;
  custom_headers?: Record<string, string>;
  timeout_ms?: number;
  max_retries?: number;
  cost_per_1k_tokens_in?: number;
  cost_per_1k_tokens_out?: number;
  notes?: string;
  enabled?: boolean;
  is_builtin?: boolean;
  /** Derived from local presets; executor paths must never be sent to the UI. */
  local_executor_configured?: boolean;
  /**
   * LLM dual builtin only: 两套 api_type 各自的配置 (供前端"切换看到对应配置"用).
   * 前端切 api_type 时直接从这里读字段填表, 不调后端. 保存时一次性 PATCH api_type + base_url + api_key + model_id.
   */
  api_type_variants?: {
    openai_compat?: { base_url: string; model_id: string; key_present: boolean };
    anthropic?: { base_url: string; model_id: string; key_present: boolean };
  };
}

export type QuotaColor = "green" | "yellow" | "red" | "gray";

// Re-export health cache helpers for sub-modules
export { getCachedHealth, setCachedHealth, clearHealthCache };

// ── Local helper: percentile ─────────────────────────────────────
// Used by speed-test in health.ts. Returns the requested percentile value
// (0..1) from a numeric array. Caller MUST sort ascending before calling.

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return -1;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

// ── Storage helpers ─────────────────────────────────────────────

const CUSTOM_PROVIDERS_KEY = "CUSTOM_PROVIDERS";

export function readCustomProviders(): ProviderConfig[] {
  try {
    const raw = readLocalSettings()[CUSTOM_PROVIDERS_KEY];
    if (!raw) return [];
    return JSON.parse(raw) as ProviderConfig[];
  } catch {
    return [];
  }
}

export async function writeCustomProviders(providers: ProviderConfig[]): Promise<void> {
  await writeLocalSettings({
    [CUSTOM_PROVIDERS_KEY]: JSON.stringify(providers),
  });
}

export function maskApiKey(provider: ProviderConfig): ProviderConfig {
  const key = provider.api_key ?? getResolvedKey(provider.id);
  const masked = key
    ? key.length > 8
      ? `${key.slice(0, 4)}****${key.slice(-4)}`
      : "****"
    : undefined;
  return { ...provider, api_key: masked };
}

export function getResolvedKey(providerId: string): string {
  return getKeyFor(providerId) ?? getConfigValue(`CUSTOM_PROVIDER_${storageId(providerId)}_API_KEY`);
}

export function storageId(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

export function providerMetaKey(providerId: string, field: string): string {
  return `PROVIDER_${storageId(providerId)}_${field.toUpperCase()}`;
}

export const REGISTERED_BUILTIN_IDS: Record<ProviderConfig["kind"], Set<string>> = {
  llm: new Set(["ikuncode_gpt55", "mimo_v25pro", "openai_gpt5", "claude_opus47", "deepseek", "custom_openai_compat"]),
  image: new Set([
    "local_card_image",
    "jimeng_image_4",
    "aliyun_wanx_26",
    "openai_gpt_image_2",
    "local_sdxl_openclaw",
    "openrouter_gemini_image",
    "openrouter_flux_11_pro",
    "openai_via_codex",
    "chatgpt_codex_image",
  ]),
  video: new Set([
    "local_mock_video",
    "local_animatediff_lightning_openclaw",
    "local_animatediff_lightning8_openclaw",
    "local_animatediff_v15_openclaw",
    "local_animatediff_openclaw",
    "local_wan_openclaw",
    "local_video_mock_openclaw",
    "jimeng_video_3pro",
    "jimeng_video_3_720p",
    "kling_3",
    "minimax_hailuo",
    "aliyun_wan_t2v",
    "vidu_q3_ref",
    "zhipu_cogvideox",
    "baidu_qianfan_video",
    "tencent_hunyuan_video",
  ]),
  tts: new Set([
    "edge_tts",
    "mimo_tts",
    "huoshan_tts",
    "minimax_tts",
    "windows_sapi",
    "local_gpt_sovits_openclaw",
    "local_cosyvoice2_openclaw",
    "local_tts_mock_openclaw",
    "openclaw_local_tts",
  ]),
};

export const KEYLESS_PROVIDER_IDS = new Set([
  "local_mock_video",
  "local_card_image",
  "edge_tts",
  "windows_sapi",
  "local_sdxl_openclaw",
  "local_animatediff_openclaw",
  "local_animatediff_lightning_openclaw",
  "local_animatediff_lightning8_openclaw",
  "local_animatediff_v15_openclaw",
  "local_wan_openclaw",
  "local_video_mock_openclaw",
  "local_gpt_sovits_openclaw",
  "local_cosyvoice2_openclaw",
  "local_tts_mock_openclaw",
  "openclaw_local_tts",
  "chatgpt_codex_image",
]);

export function providerHasGenerationAdapter(p: ProviderConfig): boolean {
  if (p.is_builtin === false) return p.kind !== "video";
  return REGISTERED_BUILTIN_IDS[p.kind].has(p.id);
}

export function readBooleanSetting(key: string, fallback: boolean): boolean {
  const raw = readLocalSettings()[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export interface SingleKeyBucket {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * LLM builtin 双套 api_type 配置.
 */
export interface DualLlmKeys {
  isDualLlm: true;
  apiTypeEnv: string;
  defaultApiType: "openai_compat" | "anthropic";
  openai_compat: SingleKeyBucket;
  anthropic: SingleKeyBucket;
}

export type BuiltinWritableKeys = SingleKeyBucket | DualLlmKeys;

export function isDual(k: BuiltinWritableKeys | undefined): k is DualLlmKeys {
  return !!k && (k as DualLlmKeys).isDualLlm === true;
}

export const BUILTIN_WRITABLE_KEYS: Record<string, BuiltinWritableKeys> = {
  ikuncode_gpt55: {
    isDualLlm: true,
    apiTypeEnv: "IKUNCODE_API_TYPE",
    defaultApiType: "openai_compat",
    openai_compat: { apiKey: "IKUNCODE_API_KEY", baseUrl: "IKUNCODE_LLM_BASE_URL", model: "IKUNCODE_LLM_MODEL" },
    anthropic: { apiKey: "IKUNCODE_CLAUDE_API_KEY", baseUrl: "IKUNCODE_CLAUDE_BASE_URL", model: "IKUNCODE_CLAUDE_MODEL" },
  },
  mimo_v25pro: {
    isDualLlm: true,
    apiTypeEnv: "MIMO_API_TYPE",
    defaultApiType: "openai_compat",
    openai_compat: { apiKey: "MIMO_API_KEY", baseUrl: "MIMO_OPENAI_BASE_URL", model: "MIMO_TEXT_MODEL" },
    anthropic: { apiKey: "MIMO_API_KEY", baseUrl: "MIMO_ANTHROPIC_BASE_URL", model: "MIMO_ANTHROPIC_MODEL" },
  },
  // 2026-05-27 — MIMO 新加坡节点 (1M 长上下文版), 跟 mimo_v25pro 是不同节点 + 不同 key.
  // 单一 anthropic 协议 (不走 dual), env key 独立 MIMO_SINGAPORE_API_KEY 不与 mimo 共用.
  mimo_singapore: {
    apiKey: "MIMO_SINGAPORE_API_KEY",
    baseUrl: providerMetaKey("mimo_singapore", "base_url"),
    model: providerMetaKey("mimo_singapore", "model"),
  },
  openai_gpt5: {
    isDualLlm: true,
    apiTypeEnv: "OPENAI_API_TYPE",
    defaultApiType: "openai_compat",
    openai_compat: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL", model: "OPENAI_MODEL" },
    anthropic: { apiKey: "OPENAI_ANTHROPIC_API_KEY", baseUrl: "OPENAI_ANTHROPIC_BASE_URL", model: "OPENAI_ANTHROPIC_MODEL" },
  },
  claude_opus47: {
    isDualLlm: true,
    apiTypeEnv: "ANTHROPIC_API_TYPE",
    defaultApiType: "anthropic",
    openai_compat: { apiKey: "ANTHROPIC_OPENAI_API_KEY", baseUrl: "ANTHROPIC_OPENAI_BASE_URL", model: "ANTHROPIC_OPENAI_MODEL" },
    anthropic: { apiKey: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL", model: "ANTHROPIC_MODEL" },
  },
  deepseek: {
    isDualLlm: true,
    apiTypeEnv: "DEEPSEEK_API_TYPE",
    defaultApiType: "openai_compat",
    openai_compat: { apiKey: "DEEPSEEK_API_KEY", baseUrl: "DEEPSEEK_BASE_URL", model: "DEEPSEEK_MODEL" },
    anthropic: { apiKey: "DEEPSEEK_ANTHROPIC_API_KEY", baseUrl: "DEEPSEEK_ANTHROPIC_BASE_URL", model: "DEEPSEEK_ANTHROPIC_MODEL" },
  },
  custom_openai_compat: {
    isDualLlm: true,
    apiTypeEnv: "CUSTOM_LLM_API_TYPE",
    defaultApiType: "openai_compat",
    openai_compat: { apiKey: "CUSTOM_LLM_API_KEY", baseUrl: "CUSTOM_LLM_BASE_URL", model: "CUSTOM_LLM_MODEL" },
    anthropic: { apiKey: "CUSTOM_LLM_ANTHROPIC_API_KEY", baseUrl: "CUSTOM_LLM_ANTHROPIC_BASE_URL", model: "CUSTOM_LLM_ANTHROPIC_MODEL" },
  },
  jimeng_image_4: { apiKey: "JIMENG_API_KEY", baseUrl: "JIMENG_BASE_URL", model: providerMetaKey("jimeng_image_4", "model") },
  aliyun_wanx_26: { apiKey: "ALIYUN_DASHSCOPE_API_KEY", baseUrl: "ALIYUN_WAN_BASE_URL", model: providerMetaKey("aliyun_wanx_26", "model") },
  openai_gpt_image_2: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL", model: providerMetaKey("openai_gpt_image_2", "model") },
  openai_via_codex: { apiKey: "CODEX_API_KEY", baseUrl: "CODEX_BASE_URL", model: providerMetaKey("openai_via_codex", "model") },
  chatgpt_codex_image: { baseUrl: providerMetaKey("chatgpt_codex_image", "base_url"), model: providerMetaKey("chatgpt_codex_image", "model") },
  local_sdxl_openclaw: { baseUrl: providerMetaKey("local_sdxl_openclaw", "base_url"), model: providerMetaKey("local_sdxl_openclaw", "model") },
  openrouter_gemini_image: { apiKey: "OPENROUTER_API_KEY", baseUrl: "OPENROUTER_BASE_URL", model: providerMetaKey("openrouter_gemini_image", "model") },
  openrouter_flux_11_pro: { apiKey: "OPENROUTER_API_KEY", baseUrl: "OPENROUTER_BASE_URL", model: providerMetaKey("openrouter_flux_11_pro", "model") },
  jimeng_video_3pro: { apiKey: "JIMENG_API_KEY", baseUrl: "JIMENG_BASE_URL", model: providerMetaKey("jimeng_video_3pro", "model") },
  jimeng_video_3_720p: { apiKey: "JIMENG_API_KEY", baseUrl: "JIMENG_BASE_URL", model: providerMetaKey("jimeng_video_3_720p", "model") },
  kling_3: { apiKey: "KLING_API_KEY", baseUrl: "KLING_BASE_URL", model: "KLING_MODEL" },
  vidu_q3_ref: { apiKey: "VIDU_API_KEY", baseUrl: "VIDU_BASE_URL", model: "VIDU_MODEL" },
  aliyun_wan_t2v: { apiKey: "ALIYUN_DASHSCOPE_API_KEY", baseUrl: "ALIYUN_WAN_BASE_URL", model: "ALIYUN_WAN_MODEL" },
  minimax_hailuo: { apiKey: "MINIMAX_API_KEY", baseUrl: "MINIMAX_BASE_URL", model: "MINIMAX_VIDEO_MODEL" },
  zhipu_cogvideox: { apiKey: "ZHIPU_API_KEY", baseUrl: "ZHIPU_BASE_URL", model: "ZHIPU_VIDEO_MODEL" },
  baidu_qianfan_video: { apiKey: "BAIDU_QIANFAN_API_KEY", baseUrl: "BAIDU_QIANFAN_BASE_URL", model: "BAIDU_QIANFAN_VIDEO_MODEL" },
  tencent_hunyuan_video: { apiKey: "TENCENT_SECRET_ID", baseUrl: "TENCENT_HUNYUAN_VIDEO_BASE_URL", model: "TENCENT_HUNYUAN_VIDEO_MODEL" },
  local_animatediff_openclaw: { baseUrl: providerMetaKey("local_animatediff_openclaw", "base_url"), model: providerMetaKey("local_animatediff_openclaw", "model") },
  local_animatediff_lightning_openclaw: { baseUrl: providerMetaKey("local_animatediff_lightning_openclaw", "base_url"), model: providerMetaKey("local_animatediff_lightning_openclaw", "model") },
  local_animatediff_lightning8_openclaw: { baseUrl: providerMetaKey("local_animatediff_lightning8_openclaw", "base_url"), model: providerMetaKey("local_animatediff_lightning8_openclaw", "model") },
  local_animatediff_v15_openclaw: { baseUrl: providerMetaKey("local_animatediff_v15_openclaw", "base_url"), model: providerMetaKey("local_animatediff_v15_openclaw", "model") },
  local_wan_openclaw: { baseUrl: providerMetaKey("local_wan_openclaw", "base_url"), model: providerMetaKey("local_wan_openclaw", "model") },
  local_video_mock_openclaw: { baseUrl: providerMetaKey("local_video_mock_openclaw", "base_url"), model: providerMetaKey("local_video_mock_openclaw", "model") },
  local_gpt_sovits_openclaw: { baseUrl: providerMetaKey("local_gpt_sovits_openclaw", "base_url"), model: providerMetaKey("local_gpt_sovits_openclaw", "model") },
  local_cosyvoice2_openclaw: { baseUrl: providerMetaKey("local_cosyvoice2_openclaw", "base_url"), model: providerMetaKey("local_cosyvoice2_openclaw", "model") },
  local_tts_mock_openclaw: { baseUrl: providerMetaKey("local_tts_mock_openclaw", "base_url"), model: providerMetaKey("local_tts_mock_openclaw", "model") },
  mimo_tts: { apiKey: "MIMO_API_KEY", baseUrl: "MIMO_OPENAI_BASE_URL", model: "MIMO_TTS_MODEL" },
  huoshan_tts: { apiKey: "VOLC_API_KEY", model: providerMetaKey("huoshan_tts", "model") },
  minimax_tts: { apiKey: "MINIMAX_API_KEY", baseUrl: "MINIMAX_BASE_URL", model: providerMetaKey("minimax_tts", "model") },
};

/** 读 LLM builtin 当前 active api_type. 不存在则返回 default. */
export function readBuiltinApiType(id: string): "openai_compat" | "anthropic" {
  const k = BUILTIN_WRITABLE_KEYS[id];
  if (!isDual(k)) return "openai_compat";
  const raw = getConfigValue(k.apiTypeEnv, "");
  if (raw === "anthropic" || raw === "openai_compat") return raw;
  return k.defaultApiType;
}

/** 读 LLM builtin 在某 api_type 模式下的当前 apiKey/baseUrl/model. */
export function readBuiltinLlmBucket(id: string, apiType: "openai_compat" | "anthropic"): { apiKey: string; baseUrl: string; model: string } {
  const k = BUILTIN_WRITABLE_KEYS[id];
  if (!isDual(k)) return { apiKey: "", baseUrl: "", model: "" };
  const bucket = k[apiType];
  return {
    apiKey: (bucket.apiKey && getConfigValue(bucket.apiKey, "")) || "",
    baseUrl: (bucket.baseUrl && getConfigValue(bucket.baseUrl, "")) || "",
    model: (bucket.model && getConfigValue(bucket.model, "")) || "",
  };
}

export function applyBuiltinLocalOverrides(provider: ProviderConfig): ProviderConfig {
  const enabled = readBooleanSetting(providerMetaKey(provider.id, "enabled"), provider.enabled !== false);
  const notes = getConfigValue(providerMetaKey(provider.id, "notes"), provider.notes ?? "");
  const label = getConfigValue(providerMetaKey(provider.id, "label"), provider.label_zh);
  provider = { ...provider, label_zh: label || provider.label_zh };
  const keys = BUILTIN_WRITABLE_KEYS[provider.id];

  if (isDual(keys)) {
    const activeApiType = readBuiltinApiType(provider.id);
    const bucket = readBuiltinLlmBucket(provider.id, activeApiType);
    const openaiBucket = readBuiltinLlmBucket(provider.id, "openai_compat");
    const anthropicBucket = readBuiltinLlmBucket(provider.id, "anthropic");
    return {
      ...provider,
      enabled,
      notes,
      api_type: activeApiType,
      api_key: bucket.apiKey || provider.api_key,
      base_url: bucket.baseUrl || provider.base_url,
      model_id: bucket.model || provider.model_id,
      anthropic_version: activeApiType === "anthropic" ? (provider.anthropic_version ?? "2023-06-01") : undefined,
      api_type_variants: {
        openai_compat: { base_url: openaiBucket.baseUrl, model_id: openaiBucket.model, key_present: !!openaiBucket.apiKey },
        anthropic: { base_url: anthropicBucket.baseUrl, model_id: anthropicBucket.model, key_present: !!anthropicBucket.apiKey },
      },
    };
  }

  const single = keys && !isDual(keys) ? keys as SingleKeyBucket : undefined;
  const model = single?.model
    ? getConfigValue(single.model, provider.model_id ?? "")
    : getConfigValue(providerMetaKey(provider.id, "model"), provider.model_id ?? "");
  const baseUrl = single?.baseUrl
    ? getConfigValue(single.baseUrl, provider.base_url ?? "")
    : getConfigValue(providerMetaKey(provider.id, "base_url"), provider.base_url ?? "");
  const customHeaders = { ...(provider.custom_headers ?? {}) };
  if (provider.id === "tencent_hunyuan_video") {
    customHeaders.region = getConfigValue("TENCENT_REGION", "ap-guangzhou");
  }
  return {
    ...provider,
    enabled,
    notes,
    model_id: model || provider.model_id,
    base_url: baseUrl || provider.base_url,
    custom_headers: Object.keys(customHeaders).length > 0 ? customHeaders : provider.custom_headers,
  };
}

export function buildBuiltinSettingsPatch(id: string, data: Partial<ProviderConfig>): Record<string, string | null> {
  const keys = BUILTIN_WRITABLE_KEYS[id];
  const patch: Record<string, string | null> = {};

  if (isDual(keys)) {
    const targetApiType: "openai_compat" | "anthropic" =
      data.api_type === "anthropic" ? "anthropic" :
      data.api_type === "openai_compat" ? "openai_compat" :
      readBuiltinApiType(id);
    const bucket = keys[targetApiType];

    if (data.api_type !== undefined) {
      patch[keys.apiTypeEnv] = targetApiType;
    }

    if (data.api_key !== undefined && bucket.apiKey) {
      patch[bucket.apiKey] = data.api_key.trim();
    }
    if (data.base_url !== undefined && bucket.baseUrl) {
      patch[bucket.baseUrl] = data.base_url;
    }
    if (data.model_id !== undefined && bucket.model) {
      patch[bucket.model] = data.model_id;
    }
    if (data.notes !== undefined) patch[providerMetaKey(id, "notes")] = data.notes;
    if (data.enabled !== undefined) patch[providerMetaKey(id, "enabled")] = String(data.enabled);
    if (data.label_zh !== undefined) patch[providerMetaKey(id, "label")] = data.label_zh;
    return patch;
  }

  const single = (keys as SingleKeyBucket) ?? {};
  if (data.api_key && single.apiKey) patch[single.apiKey] = data.api_key.trim();
  if (data.base_url !== undefined) {
    patch[single.baseUrl ?? providerMetaKey(id, "base_url")] = data.base_url;
  }
  if (data.model_id !== undefined) {
    patch[single.model ?? providerMetaKey(id, "model")] = data.model_id;
  }
  if (data.custom_headers) {
    if (id === "jimeng_video_3pro" || id === "jimeng_video_3_720p") {
      if (data.custom_headers.access_key) patch.JIMENG_VOLC_ACCESS_KEY = data.custom_headers.access_key.trim();
      if (data.custom_headers.secret_key) patch.JIMENG_VOLC_SECRET_KEY = data.custom_headers.secret_key.trim();
    }
    if (id === "kling_3") {
      if (data.custom_headers.access_key) patch.KLING_ACCESS_KEY = data.custom_headers.access_key.trim();
      if (data.custom_headers.secret_key) patch.KLING_SECRET_KEY = data.custom_headers.secret_key.trim();
    }
    if (id === "tencent_hunyuan_video") {
      if (data.custom_headers.secret_id) patch.TENCENT_SECRET_ID = data.custom_headers.secret_id.trim();
      if (data.custom_headers.secret_key) patch.TENCENT_SECRET_KEY = data.custom_headers.secret_key.trim();
      if (data.custom_headers.region !== undefined) patch.TENCENT_REGION = data.custom_headers.region.trim() || "ap-guangzhou";
    }
  }
  if (data.notes !== undefined) patch[providerMetaKey(id, "notes")] = data.notes;
  if (data.enabled !== undefined) patch[providerMetaKey(id, "enabled")] = String(data.enabled);
  if (data.label_zh !== undefined) patch[providerMetaKey(id, "label")] = data.label_zh;
  return patch;
}

export function listMergedProviders(): ProviderConfig[] {
  const merged = new Map<string, ProviderConfig>();
  for (const b of getBuiltinPresets()) merged.set(b.id, { ...b });
  for (const c of readCustomProviders()) {
    if (merged.has(c.id)) {
      loggerSync().warn(`[providers] Custom provider "${c.id}" overrides builtin preset`);
    }
    const custom = { ...c, is_builtin: false };
    if (custom.kind === "video") {
      custom.enabled = false;
      custom.notes = custom.notes
        ? `${custom.notes}\n自定义视频 Provider 暂无通用适配器，已禁用。`
        : "自定义视频 Provider 暂无通用适配器，已禁用。";
    }
    merged.set(c.id, custom);
  }
  return [...merged.values()];
}

// ── Built-in presets ────────────────────────────────────────────

export function getBuiltinPresets(): ProviderConfig[] {
  const status = getSecretStatus();
  const chatgptOauthLoggedIn = getChatgptOauthStatus().logged_in;

  function llmDualEnabled(id: string): boolean {
    const activeType = readBuiltinApiType(id);
    const bucket = readBuiltinLlmBucket(id, activeType);
    return !!bucket.apiKey;
  }
  function llmEffectiveEnabled(id: string, fallback: boolean): boolean {
    return llmDualEnabled(id) || fallback;
  }

  const llmBuiltins: ProviderConfig[] = [
    { id: "ikuncode_gpt55", label_zh: "IKunCode gpt-5.5", kind: "llm", api_type: "openai_compat", base_url: status.ikuncode.base_url, model_id: status.ikuncode.model, enabled: llmEffectiveEnabled("ikuncode_gpt55", status.ikuncode.key_present), is_builtin: true },
    { id: "mimo_v25pro", label_zh: "MiMo v2.5 Pro", kind: "llm", api_type: "openai_compat", base_url: status.mimo.openai_base_url, model_id: status.mimo.text_model, enabled: llmEffectiveEnabled("mimo_v25pro", status.mimo.key_present), is_builtin: true },
    { id: "openai_gpt5", label_zh: "OpenAI GPT-5", kind: "llm", api_type: "openai_compat", base_url: status.openai.base_url, model_id: status.openai.model, enabled: llmEffectiveEnabled("openai_gpt5", status.openai.key_present), is_builtin: true },
    { id: "claude_opus47", label_zh: "Anthropic Claude", kind: "llm", api_type: "anthropic", base_url: status.anthropic.base_url, model_id: status.anthropic.model, anthropic_version: "2023-06-01", enabled: llmEffectiveEnabled("claude_opus47", status.anthropic.key_present), is_builtin: true },
    { id: "deepseek", label_zh: "DeepSeek", kind: "llm", api_type: "openai_compat", base_url: status.deepseek.base_url, model_id: status.deepseek.model, enabled: llmEffectiveEnabled("deepseek", status.deepseek.key_present), is_builtin: true },
    { id: "custom_openai_compat", label_zh: "自定义 OpenAI 兼容", kind: "llm", api_type: "openai_compat", base_url: status.custom_openai_compat.base_url, model_id: status.custom_openai_compat.model, enabled: llmEffectiveEnabled("custom_openai_compat", status.custom_openai_compat.key_present), is_builtin: true },
  ];

  function apiTypeFor(kind: ProviderConfig["kind"], p: Record<string, any>): ProviderConfig["api_type"] {
    if (p.api_type === "openai_compat" || p.api_type === "anthropic" || p.api_type === "custom") return p.api_type;
    if (kind === "llm") return "openai_compat";
    if (kind === "image" && (p.id === "openai_gpt_image_2" || p.id === "openai_via_codex")) return "openai_compat";
    if (kind === "tts" && p.id === "mimo_tts") return "openai_compat";
    return "custom";
  }

  function hasGenerationCredential(id: string): boolean {
    if (id === "chatgpt_codex_image") return chatgptOauthLoggedIn;
    if (KEYLESS_PROVIDER_IDS.has(id)) return true;
    return !!getResolvedKey(id);
  }

  function fromPreset(kind: ProviderConfig["kind"], p: Record<string, any>): ProviderConfig {
    const needsLocalExecutor = /^local_.+_openclaw$/.test(p.id) || Object.hasOwn(p, "executor");
    const executorConfigured = needsLocalExecutor
      ? typeof p.executor?.python_path === "string" && p.executor.python_path.trim() !== ""
        && typeof p.executor?.script_path === "string" && p.executor.script_path.trim() !== ""
      : undefined;
    return {
      id: p.id,
      label_zh: p.label_zh,
      kind,
      api_type: apiTypeFor(kind, p),
      base_url: p.base_url ?? "",
      model_id: p.model_id ?? p.model ?? "",
      notes: p.notes ?? "",
      enabled: p.enabled !== false && hasGenerationCredential(p.id),
      is_builtin: true,
      ...(needsLocalExecutor ? { local_executor_configured: executorConfigured } : {}),
    };
  }

  const imageBuiltins: ProviderConfig[] = listPresets("image_provider")
    .filter((p) => REGISTERED_BUILTIN_IDS.image.has(p.id))
    .map((p) => fromPreset("image", p));

  const videoBuiltins: ProviderConfig[] = listPresets("video_provider")
    .filter((p) => REGISTERED_BUILTIN_IDS.video.has(p.id))
    .map((p) => fromPreset("video", p));

  const ttsBuiltins: ProviderConfig[] = listPresets("tts_provider")
    .filter((p) => REGISTERED_BUILTIN_IDS.tts.has(p.id))
    .map((p) => fromPreset("tts", p));

  return [...llmBuiltins, ...imageBuiltins, ...videoBuiltins, ...ttsBuiltins].map(applyBuiltinLocalOverrides);
}

export function resolveProvider(id: string): ProviderConfig | null {
  const customs = readCustomProviders();
  const custom = customs.find((p) => p.id === id);
  if (custom) return { ...custom };
  const builtins = getBuiltinPresets();
  const builtin = builtins.find((p) => p.id === id);
  if (builtin) return { ...builtin };
  return null;
}

// ── B9 Provider Four-State Status ────────────────────────────────

export interface ProviderFourState {
  available: boolean;
  configured: boolean;
  tested: boolean;
  healthy: boolean;
  enabled_for_generation: boolean;
  last_checked_at: string;
  reason?: string;
}

/**
 * Compute the four-state status for a provider.
 */
export function computeProviderStatus(p: ProviderConfig): ProviderFourState {
  const available = providerHasGenerationAdapter(p);
  const isKeyless = KEYLESS_PROVIDER_IDS.has(p.id);
  const needsLocalExecutor = p.local_executor_configured !== undefined || /^local_.+_openclaw$/.test(p.id);
  const key = p.api_key ?? getResolvedKey(p.id);
  const configured = needsLocalExecutor ? p.local_executor_configured === true : p.id === "chatgpt_codex_image"
    ? getChatgptOauthStatus().logged_in
    : isKeyless || (!!key && key.trim() !== "");

  const healthEntry = getCachedHealth(p.id);
  const tested = healthEntry !== null;
  const healthy = configured && healthEntry?.ok === true;
  const last_checked_at = healthEntry?.last_checked_at ?? new Date().toISOString();

  let reason: string | undefined;
  if (!available) {
    reason = "尚未接入生成适配器";
  } else if (!configured) {
    reason = needsLocalExecutor ? "未配置本地执行器" : "未配置 API Key";
  } else if (!tested) {
    reason = "尚未进行健康检查";
  } else if (!healthy) {
    reason = healthEntry?.reason ?? "健康检查未通过";
  }

  return {
    available,
    configured,
    tested,
    healthy,
    enabled_for_generation: p.enabled !== false && available && configured && healthy,
    last_checked_at,
    reason,
  };
}

/** Map four-state to UI dot color: gray / yellow / green / red */
export function statusDotColor(s: ProviderFourState): "green" | "yellow" | "red" | "gray" {
  if (!s.configured) return "gray";
  if (s.healthy) return "green";
  if (s.tested && !s.healthy) return "red";
  return "yellow";
}

// ── Quota helper (preserved for backward compat) ──────────────────

export function getQuotaStatus(p: ProviderConfig): { color: QuotaColor; label: string } {
  if (!providerHasGenerationAdapter(p)) return { color: "gray", label: "未接入" };
  if ((p.local_executor_configured !== undefined || /^local_.+_openclaw$/.test(p.id)) && !p.local_executor_configured) {
    return { color: "gray", label: "未配置本地执行器" };
  }
  if (KEYLESS_PROVIDER_IDS.has(p.id)) {
    if (p.id === "chatgpt_codex_image" && !getChatgptOauthStatus().logged_in) return { color: "gray", label: "未登录" };
    return { color: "green", label: "免费可用" };
  }
  const key = p.api_key ?? getResolvedKey(p.id);
  if (!key || key.trim() === "") return { color: "gray", label: "未配置 Key" };
  if (p.enabled !== false) return { color: "green", label: "已配置" };
  return { color: "yellow", label: "已禁用" };
}
