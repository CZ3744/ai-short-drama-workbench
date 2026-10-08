// P20+P5B: ProviderRegistry — lookup by preset id, cache, inject key, fallback chain

import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  LlmProvider,
  ImageProvider,
  VideoProvider,
  TtsProvider,
  ProviderKind,
  HealthCheckResult,
  LlmCompleteRequest,
  LlmCompleteResponse,
  ProviderContext,
} from "./types";
import { ProviderError } from "./errors";
import { GenericLlmProvider } from "../llm/genericProvider";
import { IkunProvider } from "../llm/ikunProvider";
import { MimoLlmProvider } from "../llm/mimoProvider";
import { LocalCardImageProvider } from "../image/localCardImageProvider";
import { JimengImageProvider } from "../image/jimengImageProvider";
import { OpenAIGptImage2Provider } from "../image/openaiGptImage2Provider";
import { OpenRouterImageProvider } from "../image/openRouterImageProvider";
import { OpenClawLocalImageProvider } from "../image/openclawLocalImageProvider";
import { AliyunWanxImageProvider } from "../image/aliyunWanxImageProvider";
import { OpenClawLocalVideoProvider } from "../video/openclawLocalVideoProvider";
import { JimengVideoProvider } from "../video/jimengVideoProvider";
import { KlingVideoProvider } from "../video/klingVideoProvider";
import { loadKlingConfig } from "../video/klingClient";
import { MiniMaxHailuoVideoWrapper } from "../video/minimaxHailuoProvider";
import { AliyunWanVideoProvider } from "../video/aliyunWanProvider";
import { ViduRefVideoProvider } from "../video/viduRefVideoProvider";
import { ZhipuCogVideoProvider } from "../video/zhipuCogVideoProvider";
import { BaiduQianfanVideoProvider } from "../video/baiduQianfanVideoProvider";
import { TencentHunyuanVideoProvider } from "../video/tencentHunyuanVideoProvider";
import { LocalMockVideoProvider } from "../video/localMockVideoProvider";
import { EdgeTtsWrapper } from "../tts/edgeTtsProvider";
import { MiMoTtsWrapper } from "../tts/mimoTtsProvider";
import { WindowsSapiWrapper } from "../tts/windowsSapiProvider";
import { OpenClawLocalTtsProvider } from "../tts/openclawLocalTtsProvider";
// 2026-05-20 P0 #3: FallbackTtsWrapper 已从 registry 6 处 callsite 全部移除 — 改用
// CustomTtsNotImplementedProvider 显式 throw 而非 silent 回退 edge_tts. 类本身保留在
// packages/providers/src/tts/fallbackTtsProvider.ts 不删 (外部代码可能仍引用), 但 registry
// 内不再 import / new.
import { CustomTtsNotImplementedProvider } from "../tts/customTtsNotImplementedProvider";
import { GenericOpenaiCompatImageProvider } from "../image/genericOpenaiCompatImageProvider";
import { ChatgptCodexImageProvider } from "../image/chatgptCodexImageProvider";
import { readLocalSettings } from "../../../core/src/localSettings";
// 2026-05-13: v4 13-kind 试验层 (providerV4Controller / localSettings.v2 / providerSchema)
// 已搬到 .trash/2026-05-13-cleanup/v4-experiment/ — 当前生产用 v2 简化二维 schema
// (providerController.ts 里的 ProviderConfig kind+api_type). v4 cache / getInstance 全部移除.
import { tryWithFallback, resolveChain, FallbackChainError, type OnFallback } from "./queue";

// ─── Types ──────────────────────────────────────────────────────────

export type ProviderFactory<T> = (cfg: PresetOption, apiKey: string | null) => T;

export interface AvailableProvider {
  id: string;
  label_zh: string;
  enabled: boolean;
  reason?: string;
}

// ─── Registry ───────────────────────────────────────────────────────

export class ProviderRegistry {
  private _llmFactories = new Map<string, ProviderFactory<LlmProvider>>();
  private _imageFactories = new Map<string, ProviderFactory<ImageProvider>>();
  private _videoFactories = new Map<string, ProviderFactory<VideoProvider>>();
  private _ttsFactories = new Map<string, ProviderFactory<TtsProvider>>();

  private _llmCache = new Map<string, LlmProvider>();
  private _imageCache = new Map<string, ImageProvider>();
  private _videoCache = new Map<string, VideoProvider>();
  private _ttsCache = new Map<string, TtsProvider>();

  private _llmPresets: PresetOption[];
  private _imagePresets: PresetOption[];
  private _videoPresets: PresetOption[];
  private _ttsPresets: PresetOption[];
  private _getKey: (providerId: string) => string | null;

  constructor(opts: {
    llmPresets: PresetOption[];
    imagePresets: PresetOption[];
    videoPresets: PresetOption[];
    ttsPresets: PresetOption[];
    getKeyFor: (providerId: string) => string | null;
  }) {
    this._llmPresets = opts.llmPresets;
    this._imagePresets = opts.imagePresets;
    this._videoPresets = opts.videoPresets;
    this._ttsPresets = opts.ttsPresets;
    this._getKey = opts.getKeyFor;
  }

  // ─── Register ─────────────────────────────────────────────────

  register(kind: "llm", id: string, factory: ProviderFactory<LlmProvider>): void;
  register(kind: "image", id: string, factory: ProviderFactory<ImageProvider>): void;
  register(kind: "video", id: string, factory: ProviderFactory<VideoProvider>): void;
  register(kind: "tts", id: string, factory: ProviderFactory<TtsProvider>): void;
  register(kind: ProviderKind, id: string, factory: ProviderFactory<any>): void {
    const map = this._factoryMap(kind);
    map.set(id, factory);
  }

  // ─── Get ──────────────────────────────────────────────────────

  getLlm(providerId: string): LlmProvider {
    return this._get("llm", providerId, this._llmCache, this._llmFactories, this._llmPresets);
  }

  getImage(providerId: string): ImageProvider {
    return this._get("image", providerId, this._imageCache, this._imageFactories, this._imagePresets);
  }

  getVideo(providerId: string): VideoProvider {
    return this._get("video", providerId, this._videoCache, this._videoFactories, this._videoPresets);
  }

  getTts(providerId: string): TtsProvider {
    return this._get("tts", providerId, this._ttsCache, this._ttsFactories, this._ttsPresets);
  }

  // ─── P5B: Fallback chain ──────────────────────────────────────

  /** Return all registered LLM provider IDs */
  getLlmProviderIds(): string[] {
    return this._llmPresets.filter(p => this._llmFactories.has(p.id)).map(p => p.id);
  }

  /** Check whether a provider has an API key configured */
  hasKeyFor(providerId: string): boolean {
    const key = this._getKey(providerId);
    return key !== null && key.trim().length > 0;
  }

  /**
   * Get an LLM provider wrapped with fallback chain logic.
   *
   * When `complete()` is called on the returned provider, it will try each
   * provider in the chain in order. On retriable errors (rate_limit, missing_key,
   * timeout, server), it falls through to the next provider. On success after
   * a switch, it fires `onFallback`.
   *
   * Chain resolution order:
   * 1. explicitChain (string[]) — caller-provided
   * 2. LLM_PROVIDER_CHAIN from local-settings (JSON string array)
   * 3. GLOBAL_MODEL_PROVIDER as lead, then all providers with keys
   * 4. All registered LLM providers
   */
  getLlmWithFallback(explicitChain?: string[], onFallback?: OnFallback): LlmProvider & { chainIds: string[] } {
    const globalModelProvider = this._readConfig("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55");
    const chainJson = this._readConfig("LLM_PROVIDER_CHAIN", "");
    const allIds = this.getLlmProviderIds();
    const chainIds = explicitChain && explicitChain.length > 0
      ? explicitChain
      : resolveChain(globalModelProvider, allIds, (id) => this.hasKeyFor(id), chainJson);

    const self = this;
    return {
      id: chainIds[0] ?? "llm_fallback",
      chainIds,
      async complete(req: LlmCompleteRequest, ctx: ProviderContext): Promise<LlmCompleteResponse> {
        return tryWithFallback(
          chainIds,
          (id) => self.getLlm(id),
          req,
          ctx,
          onFallback,
        );
      },
      async healthCheck(): Promise<HealthCheckResult> {
        // Check each provider in the chain; overall OK if at least one is OK
        const results: string[] = [];
        for (const id of chainIds) {
          try {
            const p = self.getLlm(id);
            const h = await p.healthCheck();
            if (h.ok) return { ok: true };
            results.push(`${id}: ${h.reason ?? "unknown"}`);
          } catch {
            results.push(`${id}: error`);
          }
        }
        return { ok: false, reason: results.join("; ") };
      },
    };
  }

  // ─── List ─────────────────────────────────────────────────────

  listAvailable(kind: ProviderKind): AvailableProvider[] {
    const presets = this._presetsFor(kind);
    const factories = this._factoryMap(kind);
    const rows = presets.map((p) => {
      const hasFactory = factories.has(p.id);
      let reason: string | undefined;
      if (!p.enabled) reason = "disabled in presets";
      else if (!hasFactory) reason = "no factory registered";
      return {
        id: p.id,
        label_zh: p.label_zh,
        enabled: p.enabled && hasFactory,
        reason,
      };
    });
    for (const id of factories.keys()) {
      if (presets.some((p) => p.id === id)) continue;
      rows.push({ id, label_zh: id, enabled: true, reason: undefined });
    }
    return rows;
  }

  // ─── internals ──────────────────────────────────────────────────

  private _get<T>(
    kind: ProviderKind,
    id: string,
    cache: Map<string, T>,
    factories: Map<string, ProviderFactory<T>>,
    presets: PresetOption[],
  ): T {
    const cached = cache.get(id);
    if (cached) return cached;

    const factory = factories.get(id);
    if (!factory) {
      throw new ProviderError({
        message: `No ${kind} provider registered for id "${id}"`,
        code: "invalid_request",
        provider_id: id,
        retriable: false,
      });
    }

    const preset = presets.find((p) => p.id === id);
    const apiKey = this._getKey(id);

    // M3: Apply PROVIDER_CONFIG_OVERRIDES — read env/localSettings override values
    let mergedCfg = preset ?? { id, label_zh: id, label_en: id, prompt_phrase: "", enabled: true, notes: "", default: false };
    const overrides = PROVIDER_CONFIG_OVERRIDES[id];
    if (overrides) {
      const baseUrlOverride = this._readConfig(overrides.baseUrlKey, "");
      const modelOverride = this._readConfig(overrides.modelKey, "");
      if (baseUrlOverride || modelOverride) {
        mergedCfg = { ...mergedCfg };
        if (baseUrlOverride) (mergedCfg as any).base_url = baseUrlOverride;
        if (modelOverride) (mergedCfg as any).model_id = modelOverride;
      }
    }

    const instance = factory(mergedCfg, apiKey);
    cache.set(id, instance);
    return instance;
  }

  private _factoryMap(kind: ProviderKind): Map<string, ProviderFactory<any>> {
    switch (kind) {
      case "llm": return this._llmFactories;
      case "image": return this._imageFactories;
      case "video": return this._videoFactories;
      case "tts": return this._ttsFactories;
    }
  }

  private _presetsFor(kind: ProviderKind): PresetOption[] {
    switch (kind) {
      case "llm": return this._llmPresets;
      case "image": return this._imagePresets;
      case "video": return this._videoPresets;
      case "tts": return this._ttsPresets;
    }
  }

  private _readConfig(key: string, defaultValue: string): string {
    // Read from process.env (highest priority)
    if (process.env[key] !== undefined && process.env[key] !== "") return process.env[key]!;
    // Fallback to local-settings
    const local = readLocalSettings();
    if (local[key] !== undefined && local[key] !== "") return local[key];
    return defaultValue;
  }

  // ─── 2026-05-13: v4 13-kind 实验层已搬走 ───────────────────────
  //
  // 历史: 曾计划接入 "cc-switch" 风格的 ProviderInstance (UUID + UUID:model
  //       引用). 实现见 .trash/2026-05-13-cleanup/v4-experiment/. 项目最终走的是
  //       providerController.ts 里的简化二维 schema (kind + api_type), 由 SettingsPage
  //       直接编辑 builtin + custom presets, 不再有 "instance_id" 概念.
  // 影响: 业务侧调 endpoint 时统一传 `provider_id` (== preset id), 不需要 :model 后缀.
  //       未来如果重新引入 13-kind, 仍可走 v3 preset-keyed factory map.
}

// ─── Default registrations ─────────────────────────────────────────────

/**
 * Base URL and model overrides from local-settings / env for built-in providers.
 * Preset values are fallbacks; these take precedence.
 */
const PROVIDER_CONFIG_OVERRIDES: Record<string, { baseUrlKey: string; modelKey: string }> = {
  mimo_v25pro: { baseUrlKey: "MIMO_OPENAI_BASE_URL", modelKey: "MIMO_TEXT_MODEL" },
  ikuncode_gpt55: { baseUrlKey: "IKUNCODE_LLM_BASE_URL", modelKey: "IKUNCODE_LLM_MODEL" },
  ikuncode_claude: { baseUrlKey: "IKUNCODE_CLAUDE_BASE_URL", modelKey: "IKUNCODE_CLAUDE_MODEL" },
  openai_gpt5: { baseUrlKey: "OPENAI_BASE_URL", modelKey: "OPENAI_MODEL" },
  claude_opus47: { baseUrlKey: "ANTHROPIC_BASE_URL", modelKey: "ANTHROPIC_MODEL" },
  deepseek: { baseUrlKey: "DEEPSEEK_BASE_URL", modelKey: "DEEPSEEK_MODEL" },
  custom_openai_compat: { baseUrlKey: "CUSTOM_LLM_BASE_URL", modelKey: "CUSTOM_LLM_MODEL" },
  jimeng_image_4: { baseUrlKey: "JIMENG_BASE_URL", modelKey: "PROVIDER_JIMENG_IMAGE_4_MODEL" },
  aliyun_wanx_26: { baseUrlKey: "ALIYUN_WAN_BASE_URL", modelKey: "PROVIDER_ALIYUN_WANX_26_MODEL" },
  openai_gpt_image_2: { baseUrlKey: "OPENAI_BASE_URL", modelKey: "PROVIDER_OPENAI_GPT_IMAGE_2_MODEL" },
  openai_via_codex: { baseUrlKey: "CODEX_BASE_URL", modelKey: "PROVIDER_OPENAI_VIA_CODEX_MODEL" },
  chatgpt_codex_image: { baseUrlKey: "PROVIDER_CHATGPT_CODEX_IMAGE_BASE_URL", modelKey: "PROVIDER_CHATGPT_CODEX_IMAGE_MODEL" },
  local_sdxl_openclaw: { baseUrlKey: "PROVIDER_LOCAL_SDXL_OPENCLAW_BASE_URL", modelKey: "PROVIDER_LOCAL_SDXL_OPENCLAW_MODEL" },
  openrouter_gemini_image: { baseUrlKey: "OPENROUTER_BASE_URL", modelKey: "PROVIDER_OPENROUTER_GEMINI_IMAGE_MODEL" },
  openrouter_flux_11_pro: { baseUrlKey: "OPENROUTER_BASE_URL", modelKey: "PROVIDER_OPENROUTER_FLUX_11_PRO_MODEL" },
  jimeng_video_3pro: { baseUrlKey: "JIMENG_BASE_URL", modelKey: "PROVIDER_JIMENG_VIDEO_3PRO_MODEL" },
  jimeng_video_3_720p: { baseUrlKey: "JIMENG_BASE_URL", modelKey: "PROVIDER_JIMENG_VIDEO_3_720P_MODEL" },
  kling_3: { baseUrlKey: "KLING_BASE_URL", modelKey: "KLING_MODEL" },
  vidu_q3_ref: { baseUrlKey: "VIDU_BASE_URL", modelKey: "VIDU_MODEL" },
  aliyun_wan_t2v: { baseUrlKey: "ALIYUN_WAN_BASE_URL", modelKey: "ALIYUN_WAN_MODEL" },
  minimax_hailuo: { baseUrlKey: "MINIMAX_BASE_URL", modelKey: "MINIMAX_VIDEO_MODEL" },
  zhipu_cogvideox: { baseUrlKey: "ZHIPU_BASE_URL", modelKey: "ZHIPU_VIDEO_MODEL" },
  baidu_qianfan_video: { baseUrlKey: "BAIDU_QIANFAN_BASE_URL", modelKey: "BAIDU_QIANFAN_VIDEO_MODEL" },
  tencent_hunyuan_video: { baseUrlKey: "TENCENT_HUNYUAN_VIDEO_BASE_URL", modelKey: "TENCENT_HUNYUAN_VIDEO_MODEL" },
  local_animatediff_openclaw: { baseUrlKey: "PROVIDER_LOCAL_ANIMATEDIFF_OPENCLAW_BASE_URL", modelKey: "PROVIDER_LOCAL_ANIMATEDIFF_OPENCLAW_MODEL" },
  local_animatediff_lightning_openclaw: { baseUrlKey: "PROVIDER_LOCAL_ANIMATEDIFF_LIGHTNING_BASE_URL", modelKey: "PROVIDER_LOCAL_ANIMATEDIFF_LIGHTNING_MODEL" },
  local_animatediff_lightning8_openclaw: { baseUrlKey: "PROVIDER_LOCAL_ANIMATEDIFF_LIGHTNING8_BASE_URL", modelKey: "PROVIDER_LOCAL_ANIMATEDIFF_LIGHTNING8_MODEL" },
  local_animatediff_v15_openclaw: { baseUrlKey: "PROVIDER_LOCAL_ANIMATEDIFF_V15_BASE_URL", modelKey: "PROVIDER_LOCAL_ANIMATEDIFF_V15_MODEL" },
  local_wan_openclaw: { baseUrlKey: "PROVIDER_LOCAL_WAN_OPENCLAW_BASE_URL", modelKey: "PROVIDER_LOCAL_WAN_OPENCLAW_MODEL" },
  local_video_mock_openclaw: { baseUrlKey: "PROVIDER_LOCAL_VIDEO_MOCK_OPENCLAW_BASE_URL", modelKey: "PROVIDER_LOCAL_VIDEO_MOCK_OPENCLAW_MODEL" },
};

/**
 * Register all built-in providers with the given registry.
 * Call this after constructing a ProviderRegistry to set up defaults.
 */
export function registerDefaults(registry: ProviderRegistry): void {
  registry.register("llm", "ikuncode_gpt55", (_cfg, key) => new GenericLlmProvider(_cfg, key));
  // ikuncode_claude: IKunCode 中转站 Claude Messages API (api_type=anthropic), 与 claude_opus47 同路径
  registry.register("llm", "ikuncode_claude", (_cfg, key) => new GenericLlmProvider(_cfg, key));
  registry.register("llm", "mimo_v25pro", (_cfg, key) => new GenericLlmProvider(_cfg, key));
  // 2026-05-27 — MIMO 新加坡节点 (1M 长上下文版), Anthropic Messages 协议
  registry.register("llm", "mimo_singapore", (_cfg, key) => new GenericLlmProvider(_cfg, key));
  registry.register("llm", "openai_gpt5", (_cfg, key) => new GenericLlmProvider(_cfg, key));
  registry.register("llm", "claude_opus47", (_cfg, key) => new GenericLlmProvider(_cfg, key));
  registry.register("llm", "deepseek", (_cfg, key) => new GenericLlmProvider(_cfg, key));
  registry.register("llm", "custom_openai_compat", (_cfg, key) => new GenericLlmProvider(_cfg, key));

  // Image providers
  registry.register("image", "local_card_image", (cfg, key) => new LocalCardImageProvider(cfg, key));
  registry.register("image", "jimeng_image_4", (cfg, key) => new JimengImageProvider(cfg, key));
  registry.register("image", "aliyun_wanx_26", (cfg, key) => new AliyunWanxImageProvider(cfg, key));
  registry.register("image", "openai_gpt_image_2", (cfg, key) => new OpenAIGptImage2Provider(cfg, key));
  registry.register("image", "local_sdxl_openclaw", (cfg, key) => new OpenClawLocalImageProvider(cfg, key));
  registry.register("image", "openrouter_gemini_image", (cfg, key) => new OpenRouterImageProvider(cfg, key));
  registry.register("image", "openrouter_flux_11_pro", (cfg, key) => new OpenRouterImageProvider(cfg, key));
  // C7: register openai_via_codex — reuses GenericOpenaiCompatImageProvider with codex proxy
  registry.register("image", "openai_via_codex", (cfg, key) => new GenericOpenaiCompatImageProvider(cfg, key));
  // 2026-05-14: register chatgpt_codex_image — OAuth-only path (no API key needed)
  registry.register("image", "chatgpt_codex_image", (cfg, key) => new ChatgptCodexImageProvider(cfg, key));

  // Video providers
  registry.register("video", "local_mock_video", (cfg, key) => new LocalMockVideoProvider(cfg, key));
  registry.register("video", "local_animatediff_openclaw", (cfg, key) => new OpenClawLocalVideoProvider(cfg, key));
  // 2026-05-17: AnimateDiff 多个 id - Lightning 4-step 快版 / 8-step 质量版 (新加) / v1-5-2 (disabled)
  registry.register("video", "local_animatediff_lightning_openclaw", (cfg, key) => new OpenClawLocalVideoProvider(cfg, key));
  registry.register("video", "local_animatediff_lightning8_openclaw", (cfg, key) => new OpenClawLocalVideoProvider(cfg, key));
  registry.register("video", "local_animatediff_v15_openclaw", (cfg, key) => new OpenClawLocalVideoProvider(cfg, key));
  registry.register("video", "local_wan_openclaw", (cfg, key) => new OpenClawLocalVideoProvider(cfg, key));
  // 2026-05-17: 本地 video_gen_local.py mock 引擎 — 用 opencv 渲染彩条 + prompt 文字,
  // 走完整个 OpenClawLocalVideoProvider 代码路径(不同于 LocalMockVideoProvider 内嵌 ffmpeg lavfi),
  // 用来验证本地 video Python 链路真接通(无 GPU 也能跑)。
  registry.register("video", "local_video_mock_openclaw", (cfg, key) => new OpenClawLocalVideoProvider(cfg, key));
  registry.register("video", "jimeng_video_3pro", (cfg, key) => new JimengVideoProvider(cfg, key));
  registry.register("video", "jimeng_video_3_720p", (cfg, key) => new JimengVideoProvider(cfg, key));
  registry.register("video", "kling_3", (cfg, apiKey) => {
    const klingCfg = loadKlingConfig();
    return new KlingVideoProvider(cfg, apiKey, klingCfg.secretKey ?? null);
  });
  registry.register("video", "minimax_hailuo", (cfg, key) => new MiniMaxHailuoVideoWrapper(cfg, key));
  registry.register("video", "aliyun_wan_t2v", (cfg, key) => new AliyunWanVideoProvider(cfg, key));
  registry.register("video", "vidu_q3_ref", (cfg, key) => new ViduRefVideoProvider(cfg, key));
  registry.register("video", "zhipu_cogvideox", (cfg, key) => new ZhipuCogVideoProvider(cfg, key));
  registry.register("video", "baidu_qianfan_video", (cfg, key) => new BaiduQianfanVideoProvider(cfg, key));
  registry.register("video", "tencent_hunyuan_video", (cfg, key) => new TencentHunyuanVideoProvider(cfg, key));

  // TTS providers — P170 Wave 1A: full registry coverage from tts_provider.json

  // edge_tts: Microsoft Edge browser TTS, free, no key required (retained existing)
  registry.register("tts", "edge_tts", (cfg, key) => new EdgeTtsWrapper(cfg, key));

  // mimo_tts: MiMo TTS service (free period, base_url from localSettings)
  registry.register("tts", "mimo_tts", (cfg, key) => new MiMoTtsWrapper(cfg, key));

  // huoshan_tts: 火山引擎 TTS — not yet implemented.
  // 2026-05-20 P0 #3: 旧 FallbackTtsWrapper 只在 preset.enabled=false 下安全 (silent disabled),
  // 一旦 preset 误开就 silent 走 EdgeTtsWrapper. 改成 CustomTtsNotImplementedProvider 显式
  // throw + toC 友好 message (说明"未实现 - 请换 edge_tts / windows_sapi / 本地 TTS"),
  // 杜绝 silent fallback.
  registry.register("tts", "huoshan_tts", (cfg, _key) => new CustomTtsNotImplementedProvider(cfg, { id: "huoshan_tts", hasApiKey: false }));

  // minimax_tts: MiniMax TTS — not yet implemented.
  // 同 huoshan_tts: 显式 throw + 友好 message, 不 silent 回退 edge_tts.
  registry.register("tts", "minimax_tts", (cfg, _key) => new CustomTtsNotImplementedProvider(cfg, { id: "minimax_tts", hasApiKey: false }));

  // windows_sapi: Windows built-in SAPI TTS (PowerShell System.Speech)
  registry.register("tts", "windows_sapi", (cfg, key) => new WindowsSapiWrapper(cfg, key));

  // 2026-05-17: OpenClaw 本地 TTS - subprocess + venv-gpu Python + CosyVoice2 引擎
  // 与本地视频 provider 同一 pattern, 用完释放 GPU。多 id 共用一个实现类, 由 preset.executor.engine 区分。
  registry.register("tts", "local_cosyvoice2_openclaw", (cfg, key) => new OpenClawLocalTtsProvider(cfg, key));
  // 2026-05-17: 主推 GPT-SoVITS (B 站社区 ckpt 多) - preset 早就有但 registry 漏注册导致试听 throw
  registry.register("tts", "local_gpt_sovits_openclaw", (cfg, key) => new OpenClawLocalTtsProvider(cfg, key));
  registry.register("tts", "local_tts_mock_openclaw", (cfg, key) => new OpenClawLocalTtsProvider(cfg, key));

  // openclaw_local_tts: OpenClaw local TTS model — not yet implemented.
  // 2026-05-20 P0 #3: 显式 throw + 友好 message, 不 silent 回退. 用户实际想用本地 TTS,
  // 应该选 local_cosyvoice2_openclaw / local_gpt_sovits_openclaw 已接的 id.
  registry.register("tts", "openclaw_local_tts", (cfg, _key) => new CustomTtsNotImplementedProvider(cfg, { id: "openclaw_local_tts", hasApiKey: false }));

  // Additional planned providers (not in tts_provider.json yet).
  // 2026-05-20 P0 #3: 同上, 显式 throw + 友好 message, 不 silent 回退.
  registry.register("tts", "openvoice", (cfg, _key) => new CustomTtsNotImplementedProvider(cfg, { id: "openvoice", hasApiKey: false }));
  registry.register("tts", "cosyvoice", (cfg, _key) => new CustomTtsNotImplementedProvider(cfg, { id: "cosyvoice", hasApiKey: false }));
  registry.register("tts", "xtts_v2", (cfg, _key) => new CustomTtsNotImplementedProvider(cfg, { id: "xtts_v2", hasApiKey: false }));

  // P180 A8: CUSTOM_PROVIDERS — register generic adapters for user-defined providers
  try {
    const raw = readLocalSettings()["CUSTOM_PROVIDERS"];
    if (raw) {
      const customProviders: Array<{
        id: string; kind: string; api_type?: string;
        base_url?: string; api_key?: string; model_id?: string;
        timeout_ms?: number; enabled?: boolean;
      }> = JSON.parse(raw as string);
      for (const cp of customProviders) {
        if (cp.enabled === false) continue;
        const presetCfg = {
          id: cp.id,
          label_zh: cp.id,
          label_en: cp.id,
          prompt_phrase: "",
          enabled: true,
          notes: `Custom ${cp.kind} provider`,
          default: false,
          base_url: cp.base_url,
          model_id: cp.model_id,
          timeout_ms: cp.timeout_ms,
        };
        const storedKey = readLocalSettings()[`CUSTOM_PROVIDER_${cp.id.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_API_KEY`] ?? null;
        if (cp.kind === "llm") {
          registry.register("llm", cp.id, (_cfg, key) => new GenericLlmProvider(presetCfg, cp.api_key ?? storedKey ?? key));
        } else if (cp.kind === "image") {
          registry.register("image", cp.id, (_cfg, key) => new GenericOpenaiCompatImageProvider(presetCfg, cp.api_key ?? storedKey ?? key));
        } else if (cp.kind === "tts") {
          // 2026-05-20 P1 红线 #1: 旧实现 `new FallbackTtsWrapper(cfg, null)` 把用户填的
          // cp.base_url / cp.api_key 全 silent 丢弃, 然后 synthesize 抛"未接入"通用 message,
          // 用户看不到自己的配置去向. 改成 CustomTtsNotImplementedProvider 在 throw 时把
          // 用户配置摘要 (base_url / api_key 是否已填 / model_id) 包进 message,
          // toC 友好 (铁律 #9) + 暴露真实接入缺口而非 silent fallback (红线 #1).
          const resolvedKey = cp.api_key ?? storedKey ?? null;
          registry.register("tts", cp.id, (_cfg, _key) => new CustomTtsNotImplementedProvider(
            presetCfg,
            {
              id: cp.id,
              base_url: cp.base_url,
              model_id: cp.model_id,
              hasApiKey: !!resolvedKey,
            },
          ));
        }
        // kind=video: intentionally skipped (no generic video provider yet)
      }
    }
  } catch (err) {
    // 2026-05-27 audit P0-02: 之前只 console.warn 静默 continue, 用户的 custom providers
    // 一个 JSON 错位整个 fall through, UI 显示"未注册 provider" 但 raw 文件还在 — 用户毫无
    // 头绪. 现在把错误塞到 registry 内部 errors 数组, 让 /api/v2/settings/diagnostics 暴露.
    // eslint-disable-next-line no-console
    console.error("[registry] CUSTOM_PROVIDERS 加载失败 — 用户配置的 custom provider 全部丢失:", err);
    // 标记到 registry 的 loadErrors (诊断端点暴露)
    const errors = (globalThis as { __PROVIDER_REGISTRY_LOAD_ERRORS__?: Array<{ scope: string; message: string }> }).__PROVIDER_REGISTRY_LOAD_ERRORS__ ||= [];
    errors.push({
      scope: "CUSTOM_PROVIDERS",
      message: `CUSTOM_PROVIDERS JSON 解析失败: ${err instanceof Error ? err.message : String(err)}. 请去设置页检查 raw JSON 格式 (常见: 逗号错位 / 引号未闭合).`,
    });
  }
}
