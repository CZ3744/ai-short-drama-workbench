// 2026-05-21 — Secret provider registry (P1 重构).
//
// 背景:
//   原 packages/core/src/localSettings.ts 内 saveSecrets / clearSecret /
//   getSecretStatus / testProviderConnection / getKeyFor 5 个 fn 各自硬编码
//   30+ provider 的 ENV 名 switch — 同样的 ENV key 名最多写过 5 次,
//   ENV key 改名 / 加新 provider 必须同步改 5 处, 容易遗漏.
//
// 本文件目标:
//   把"provider id ↔ ENV 名 list ↔ label ↔ category ↔ test 端点"五元关系
//   集中收口到 SECRET_PROVIDERS, 上游 fn 改读 helper, 不再硬编码 switch.
//
// 边界:
//   - 仅收口"secret 元数据" (id + lookupKeys + clearKeys + label + category + testAdapter).
//   - 不动业务字段 (model / voice / duration / aspect_ratio 等) — 那些字段
//     高度异质, driver 化收益低, 仍由 saveSecrets / getSecretStatus 内联.
//   - 不动 encryptSettingValue / writeLocalSettings / getConfigValue 等
//     底层读写, 这些已经是单点.

/**
 * "Secret category" 用于 UI 分组与未来 listSecretProviders 过滤.
 * - llm: 文本/对话模型 (OpenAI / Claude / DeepSeek / IkunCode / MiMo …)
 * - image: 文生图 (jimeng_image / aliyun_wanx / openai_gpt_image …)
 * - video: 文生视频 (aliyun_wan / minimax / kling / vidu …)
 * - tts:  语音 (mimo_tts / minimax_tts / huoshan_tts …)
 * - other: 其他 (openrouter 这种聚合, codex OAuth-ish, 自定义 OpenAI-compat …)
 */
export type SecretCategory = "llm" | "image" | "video" | "tts" | "other";

/**
 * 单个 secret-bearing provider 的元数据.
 *
 * lookupKeys 约定:
 *   - getKeyFor() 按数组顺序查, 返回第一个非空字符串 (作为 bearer credential).
 *   - 通常只有 API_KEY 一个; legacy / 多 key provider (kling) 多个但只取首个.
 *   - 不列 BASE_URL / MODEL / REGION 等业务字段.
 *
 * clearKeys 约定:
 *   - clearProviderKey() 把所有这些 ENV 都置 null.
 *   - 多 key provider (jimeng / kling) 需要同时清 access_key + secret_key + legacy api_key,
 *     即 clearKeys ⊇ lookupKeys.
 *   - 缺省时 (undefined) = lookupKeys.
 */
export interface SecretProviderEntry {
  /** Canonical provider id, 与前端 / preset / saveSecrets section 名对齐 */
  id: string;
  /** 前端展示标签 (中文优先, 给设置页用) */
  label: string;
  /** 该 provider 在 getKeyFor 中的查询优先级列表 */
  lookupKeys: string[];
  /** clear 时要置 null 的全部 ENV (缺省 = lookupKeys) */
  clearKeys?: string[];
  /** 分组 — UI / listSecretProviders 用 */
  category: SecretCategory;
  /** testProviderConnection 的 case 名 (省略 = 没单独 test endpoint) */
  testAdapter?: string;
}

/**
 * Secret provider 完整注册表.
 *
 * 加新 provider 流程:
 *   1. 在此追加一条
 *   2. 如果 testProviderConnection 需要 case, 在 localSettings.ts 加一段
 *   3. 如果 saveSecrets / getSecretStatus 要管业务字段, 也在那两个 fn 加一段
 *   4. 跑 `npx tsc --noEmit` 验证类型
 *
 * 删 provider 流程: 反过来 4 步. 不要忘记 saveSecrets / getSecretStatus.
 *
 * 字段口径来自 localSettings.ts 历史 switch + getKeyFor envKeyMap, 不增不减.
 */
export const SECRET_PROVIDERS: readonly SecretProviderEntry[] = [
  // ── LLM ──────────────────────────────────────────────────────────
  {
    id: "ikuncode",
    label: "IkunCode (默认 LLM)",
    lookupKeys: ["IKUNCODE_API_KEY", "LLM_API_KEY"],
    category: "llm",
    testAdapter: "ikuncode"
  },
  {
    id: "ikuncode_claude",
    label: "IkunCode · Claude 转发",
    lookupKeys: ["IKUNCODE_CLAUDE_API_KEY"],
    category: "llm"
  },
  {
    id: "mimo",
    label: "MiMo (小米)",
    lookupKeys: ["MIMO_API_KEY"],
    category: "llm",
    testAdapter: "mimo_text"
  },
  {
    id: "openai",
    label: "OpenAI",
    lookupKeys: ["OPENAI_API_KEY"],
    category: "llm"
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    lookupKeys: ["ANTHROPIC_API_KEY"],
    category: "llm"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    lookupKeys: ["DEEPSEEK_API_KEY"],
    category: "llm"
  },
  {
    id: "custom_openai_compat",
    label: "自定义 OpenAI 兼容",
    lookupKeys: ["CUSTOM_LLM_API_KEY"],
    category: "llm"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    lookupKeys: ["OPENROUTER_API_KEY"],
    category: "other"
  },
  {
    id: "codex",
    label: "Codex (Anthropic via Codex)",
    lookupKeys: ["CODEX_API_KEY"],
    category: "llm"
  },

  // ── Video ────────────────────────────────────────────────────────
  {
    id: "video",
    label: "视频 (legacy / future_api fallback)",
    lookupKeys: ["VIDEO_API_KEY"],
    category: "video",
    testAdapter: "video"
  },
  {
    id: "minimax",
    label: "MiniMax Hailuo",
    lookupKeys: ["MINIMAX_API_KEY"],
    category: "video",
    testAdapter: "minimax"
  },
  {
    id: "aliyun_wan",
    label: "阿里云百炼 Wan",
    lookupKeys: ["ALIYUN_DASHSCOPE_API_KEY", "DASHSCOPE_API_KEY"],
    category: "video",
    testAdapter: "aliyun_wan"
  },
  {
    id: "kling",
    label: "可灵 (Kling)",
    // getKeyFor 取首个非空: ACCESS_KEY 优先, 然后 API_KEY (legacy alias)
    lookupKeys: ["KLING_ACCESS_KEY", "KLING_API_KEY"],
    // clear 时连同 SECRET_KEY 一起清, 不留 dangling 凭证
    clearKeys: ["KLING_API_KEY", "KLING_ACCESS_KEY", "KLING_SECRET_KEY"],
    category: "video"
  },
  {
    id: "vidu",
    label: "Vidu",
    lookupKeys: ["VIDU_API_KEY"],
    category: "video"
  },
  {
    id: "jimeng",
    label: "即梦 (Jimeng / Volc)",
    // 多 key 组合 (走 getKeyFor 特殊路径), lookupKeys 仅作 fallback
    lookupKeys: ["JIMENG_VOLC_ACCESS_KEY", "JIMENG_API_KEY"],
    clearKeys: ["JIMENG_API_KEY", "JIMENG_VOLC_ACCESS_KEY", "JIMENG_VOLC_SECRET_KEY"],
    category: "video"
  },
  {
    id: "zhipu_cogvideox",
    label: "智谱 CogVideoX",
    lookupKeys: ["ZHIPU_API_KEY"],
    category: "video"
  },
  {
    id: "baidu_qianfan_video",
    label: "百度千帆 视频",
    lookupKeys: ["BAIDU_QIANFAN_API_KEY"],
    category: "video"
  },
  {
    id: "tencent_hunyuan_video",
    label: "腾讯混元 视频",
    // 多 key 组合 (secret_id + secret_key, 走 getKeyFor 特殊路径)
    lookupKeys: ["TENCENT_SECRET_ID"],
    clearKeys: ["TENCENT_SECRET_ID", "TENCENT_SECRET_KEY"],
    category: "video"
  },

  // ── Image ────────────────────────────────────────────────────────
  {
    id: "image",
    label: "图像 (legacy)",
    lookupKeys: ["IMAGE_API_KEY"],
    category: "image",
    testAdapter: "image"
  },

  // ── TTS ──────────────────────────────────────────────────────────
  // edge_tts / windows_sapi / openclaw_local_tts 无 Key, 不入 registry.
  {
    id: "huoshan_tts",
    label: "火山引擎 TTS",
    lookupKeys: ["VOLC_API_KEY"],
    category: "tts"
  }
];

// --- Lookup helpers ---

const _byId: Map<string, SecretProviderEntry> = new Map(
  SECRET_PROVIDERS.map((p) => [p.id, p])
);

/** O(1) 按 id 查 provider 条目, 未注册返回 undefined. */
export function findSecretProvider(id: string): SecretProviderEntry | undefined {
  return _byId.get(id);
}

/**
 * getKeyFor() 用: provider 的 lookup 顺序列表.
 * 数组顺序 = 查询优先级, 取首个非空作为返回值.
 * 未注册返回空数组 (调用方应该自行回退到 CUSTOM_PROVIDER_<ID>_API_KEY).
 */
export function lookupKeysForProvider(id: string): string[] {
  return _byId.get(id)?.lookupKeys ?? [];
}

/**
 * clearProviderKey() 用: provider 的全部清空列表.
 * 缺省 clearKeys = lookupKeys; 多 key provider 显式列出附加凭证 (如 SECRET_KEY).
 * 未注册返回空数组.
 */
export function clearKeysForProvider(id: string): string[] {
  const entry = _byId.get(id);
  if (!entry) return [];
  return entry.clearKeys ?? entry.lookupKeys;
}

/**
 * @deprecated 用 lookupKeysForProvider / clearKeysForProvider 替代,
 * 此 alias 保留兼容旧 import.
 */
export function envKeysForProvider(id: string): string[] {
  return lookupKeysForProvider(id);
}

/** 按 category 过滤; 不传 = 全部. */
export function listSecretProviders(category?: SecretCategory): readonly SecretProviderEntry[] {
  if (!category) return SECRET_PROVIDERS;
  return SECRET_PROVIDERS.filter((p) => p.category === category);
}

// --- model_ref alias map ---
//
// getKeyFor() 的 envKeyMap (P20) 用的是 "preset id" (如 ikuncode_gpt55,
// claude_opus47, kling_3, openai_gpt_image_2, ...), 它跟本文件的 provider id
// 不完全对齐 — 一个 secret provider 可以驱动多个 preset (例如 jimeng 同时驱动
// jimeng_video_3pro / jimeng_video_3_720p / jimeng_image_4). 此处显式列出 alias,
// 避免回到"二次硬编码"的老路.
//
// 没列在 _aliasToProvider 的 preset id 默认按 _byId 查 (大部分一致).
const _aliasToProvider: Record<string, string> = {
  // LLM preset 别名
  ikuncode_gpt55: "ikuncode",
  mimo_v25pro: "mimo",
  openai_gpt5: "openai",
  claude_opus47: "anthropic",
  anthropic_via_codex: "codex",

  // Video preset 别名
  aliyun_wan_t2v: "aliyun_wan",
  minimax_hailuo: "minimax",
  jimeng_video_3pro: "jimeng",
  jimeng_video_3_720p: "jimeng",
  kling_3: "kling",
  vidu_q3_ref: "vidu",

  // Image preset 别名
  jimeng_image_4: "jimeng",
  aliyun_wanx_26: "aliyun_wan",
  openai_gpt_image_2: "openai",
  openai_via_codex: "codex",
  openrouter_gemini_image: "openrouter",
  openrouter_flux_11_pro: "openrouter",

  // TTS preset 别名
  mimo_tts: "mimo",
  minimax_tts: "minimax"
};

/**
 * 把 preset id (如 "claude_opus47" / "kling_3") 解析回对应的 secret provider id
 * (如 "anthropic" / "kling"). 未注册 alias 时直接返回 input (假设 id 一致).
 */
export function resolveProviderAlias(presetOrProviderId: string): string {
  return _aliasToProvider[presetOrProviderId] ?? presetOrProviderId;
}

/**
 * Preset 级别 "无 Key" 名单 — 这些 preset 不需要 ENV 凭证 (本地子进程 / OAuth).
 * 调用方 (主要是 getKeyFor) 命中后返回 null, 不该走 custom-provider fallback.
 */
const _noKeyPresets: ReadonlySet<string> = new Set([
  "local_mock_video",
  "local_animatediff_openclaw",
  "local_wan_openclaw",
  "local_sdxl_openclaw",
  "chatgpt_codex_image", // OAuth token, 不是静态 API Key
  "edge_tts",
  "windows_sapi",
  "openclaw_local_tts"
]);

export function isNoKeyPreset(presetId: string): boolean {
  return _noKeyPresets.has(presetId);
}
