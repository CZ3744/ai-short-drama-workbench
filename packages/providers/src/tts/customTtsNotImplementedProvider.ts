// 2026-05-20 P1 红线 #1: CUSTOM_PROVIDERS kind=tts silent FallbackTtsWrapper 修复.
//
// 历史 bug: CUSTOM_PROVIDERS 里 kind=tts 一律注册 FallbackTtsWrapper(cfg, null), 把
// 用户在 NewProviderDialog 填的 cp.base_url / cp.api_key 全 silent 丢弃 — 用户期望
// 这是自己接的 custom TTS endpoint, 实际是 edge_tts 探活兼 throw "未接入" 通用消息,
// 看不到"你填的 endpoint 实际没有被任何 generic TTS adapter 实现".
//
// 红线 #1 要求: 任何"默认值 → 假数据"路径全部 throw + 友好 message + 告知用户配置去向.
// 本类做:
//   - synthesize: throw, message 显式说明 base_url / api_key 已读但 generic TTS adapter 未实现
//   - listVoices: 返回空数组 (元数据 API, 不应炸 UI)
//   - healthCheck: ok=false + 同 message
//
// 区别于 FallbackTtsWrapper:
//   - Fallback 给"已知未接入"的内置 id (huoshan_tts / minimax_tts / openvoice 等)
//   - 本类给用户自定义 id, message 必须包含用户填的配置摘要让用户能定位

import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  TtsProvider,
  TtsSynthesizeRequest,
  TtsSynthesizeResponse,
  ProviderContext,
  HealthCheckResult,
  TtsVoiceInfo,
} from "../core/types";
import { ProviderError } from "../core/errors";

export interface CustomTtsConfig {
  id: string;
  base_url?: string;
  model_id?: string;
  hasApiKey: boolean;
}

export class CustomTtsNotImplementedProvider implements TtsProvider {
  readonly id: string;
  private _customCfg: CustomTtsConfig;

  constructor(_cfg: PresetOption, customCfg: CustomTtsConfig) {
    this.id = customCfg.id;
    this._customCfg = customCfg;
  }

  /** 构造 toC 友好 + 包含用户配置摘要的失败 message */
  private _buildMessage(action: string): string {
    const parts: string[] = [
      `自定义 TTS provider "${this.id}" 还未接入通用适配器,${action}失败.`,
    ];
    if (this._customCfg.base_url) {
      parts.push(`你填写的 base_url=${this._customCfg.base_url} 已保存, 但目前没有 generic TTS adapter 能调用它.`);
    }
    if (this._customCfg.hasApiKey) {
      parts.push(`api_key 已保存 (本地 only, 未发出), 同样等待 adapter 实现.`);
    }
    if (this._customCfg.model_id) {
      parts.push(`model_id=${this._customCfg.model_id}`);
    }
    parts.push(`请换用已实现的 edge_tts / windows_sapi / local_cosyvoice2_openclaw / local_gpt_sovits_openclaw, 或等 generic TTS adapter 上线.`);
    return parts.join(" ");
  }

  async synthesize(
    _req: TtsSynthesizeRequest,
    ctx: ProviderContext,
  ): Promise<TtsSynthesizeResponse> {
    const message = this._buildMessage("合成");
    ctx.log("warn", `[custom_tts:${this.id}] ${message}`);
    throw new ProviderError({
      message,
      code: "invalid_request",
      provider_id: this.id,
      retriable: false,
    });
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    // 元数据接口 — 返回空列表而非 throw, 避免 UI 设置页一打开就崩
    return [];
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      ok: false,
      reason: this._buildMessage("健康检查"),
    };
  }
}
