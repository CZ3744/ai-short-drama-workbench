/**
 * Provider ID 映射统一解析器 (P180 B8)
 *
 * 统一三种 ID 语义：
 * - preset_id:         UI 显示的 id, 如 "minimax_hailuo", "ikuncode_gpt55"
 * - secret_provider_id: localSettings key 组名, 如 "minimax", "ikuncode"
 * - test_adapter_id:   testProviderConnection() 接受的参数, 如 "minimax", "ikuncode"
 */

export interface ProviderIdMapping {
  /** UI 显示的 id, 如 "minimax_hailuo" */
  preset_id: string;
  /** localSettings key 名, 如 "minimax" */
  secret_provider_id: string;
  /** testProviderConnection 接受的, 如 "minimax" */
  test_adapter_id: string;
}

/**
 * 内置 presets 的 ID 映射表。
 *
 * secret_provider_id 对应 getSecretStatus() 返回的顶层 key,
 * 决定 getResolvedKey / getConfigValue 的前缀。
 *
 * test_adapter_id 对应 testProviderConnection() 的 switch-case,
 * 必须精确匹配已有的 case 值或落入 default。
 */
const BUILTIN_ID_MAPPING: Record<string, ProviderIdMapping> = {
  /* ── LLM ─────────────────────────────────────────────────── */
  ikuncode_gpt55: {
    preset_id: "ikuncode_gpt55",
    secret_provider_id: "ikuncode",
    test_adapter_id: "ikuncode",
  },
  mimo_v25pro: {
    preset_id: "mimo_v25pro",
    secret_provider_id: "mimo",
    test_adapter_id: "mimo_text",
  },
  openai_gpt5: {
    preset_id: "openai_gpt5",
    secret_provider_id: "openai",
    test_adapter_id: "openai_gpt5",
  },
  claude_opus47: {
    preset_id: "claude_opus47",
    secret_provider_id: "claude_opus47",
    test_adapter_id: "claude_opus47",
  },
  deepseek: {
    preset_id: "deepseek",
    secret_provider_id: "deepseek",
    test_adapter_id: "deepseek",
  },
  custom_openai_compat: {
    preset_id: "custom_openai_compat",
    secret_provider_id: "custom_openai_compat",
    test_adapter_id: "custom_openai_compat",
  },

  /* ── Image ────────────────────────────────────────────────── */
  local_card_image: {
    preset_id: "local_card_image",
    secret_provider_id: "local_card_image",
    test_adapter_id: "local_card_image",
  },
  jimeng_image_4: {
    preset_id: "jimeng_image_4",
    secret_provider_id: "jimeng",
    test_adapter_id: "jimeng_image_4",
  },
  openai_gpt_image_2: {
    preset_id: "openai_gpt_image_2",
    secret_provider_id: "openai",
    test_adapter_id: "openai_gpt_image_2",
  },
  chatgpt_codex_image: {
    preset_id: "chatgpt_codex_image",
    // OAuth-based provider — no API key family; keep id stable so secret lookup
    // returns null which the provider class checks for itself.
    secret_provider_id: "chatgpt_codex_image",
    test_adapter_id: "chatgpt_codex_image",
  },
  local_sdxl_openclaw: {
    preset_id: "local_sdxl_openclaw",
    secret_provider_id: "local_sdxl_openclaw",
    test_adapter_id: "local_sdxl_openclaw",
  },

  /* ── Video ────────────────────────────────────────────────── */
  local_mock_video: {
    preset_id: "local_mock_video",
    secret_provider_id: "local_mock_video",
    test_adapter_id: "local_mock_video",
  },
  jimeng_video_3pro: {
    preset_id: "jimeng_video_3pro",
    secret_provider_id: "jimeng",
    test_adapter_id: "jimeng_video_3pro",
  },
  aliyun_wan_t2v: {
    preset_id: "aliyun_wan_t2v",
    secret_provider_id: "aliyun_wan",
    test_adapter_id: "aliyun_wan",
  },
  minimax_hailuo: {
    preset_id: "minimax_hailuo",
    secret_provider_id: "minimax",
    test_adapter_id: "minimax",
  },

  /* ── TTS ──────────────────────────────────────────────────── */
  edge_tts: {
    preset_id: "edge_tts",
    secret_provider_id: "edge_tts",
    test_adapter_id: "edge_tts",
  },
  mimo_tts: {
    preset_id: "mimo_tts",
    secret_provider_id: "mimo",
    test_adapter_id: "mimo_tts",
  },
  huoshan_tts: {
    preset_id: "huoshan_tts",
    secret_provider_id: "huoshan",
    test_adapter_id: "huoshan_tts",
  },
  minimax_tts: {
    preset_id: "minimax_tts",
    secret_provider_id: "minimax",
    test_adapter_id: "minimax_tts",
  },
  windows_sapi: {
    preset_id: "windows_sapi",
    secret_provider_id: "windows_sapi",
    test_adapter_id: "windows_sapi",
  },

  /* ── 补充：NO_KEY_PROVIDERS 中尚未列出的本地 provider ── */
  local_animatediff_openclaw: {
    preset_id: "local_animatediff_openclaw",
    secret_provider_id: "local_animatediff_openclaw",
    test_adapter_id: "local_animatediff_openclaw",
  },
  local_wan_openclaw: {
    preset_id: "local_wan_openclaw",
    secret_provider_id: "local_wan_openclaw",
    test_adapter_id: "local_wan_openclaw",
  },
};

/**
 * 根据 preset_id 解析出完整的 ProviderIdMapping。
 *
 * 内置 provider 从 BUILTIN_ID_MAPPING 查表；
 * 自定义 provider 默认为三 id 一致（localSettings key 按
 * CUSTOM_PROVIDER_<ID>_API_KEY 约定读取）
 */
export function resolveProviderId(presetId: string): ProviderIdMapping {
  const builtin = BUILTIN_ID_MAPPING[presetId];
  if (builtin) return builtin;
  // Custom provider fallback: three ids identical, secret read via
  // CUSTOM_PROVIDER_<ID>_API_KEY convention.
  return {
    preset_id: presetId,
    secret_provider_id: presetId,
    test_adapter_id: presetId,
  };
}
