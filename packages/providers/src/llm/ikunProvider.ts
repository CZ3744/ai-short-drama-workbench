// P20: IKunCode LLM Provider wrapper — adapts existing llm.ts to LlmProvider interface

import type { PresetOption } from "../../../core/src/presetSchema";
import type { LlmProvider, LlmCompleteRequest, LlmCompleteResponse, ProviderContext, HealthCheckResult } from "../core/types";
import { ProviderError } from "../core/errors";
import { OpenAiCompatibleProvider, type LlmProvider as OldLlmProvider } from "../llm";
import type { LlmConfig } from "../config";

export class IkunProvider implements LlmProvider {
  readonly id: string;
  private _inner: OldLlmProvider;
  private _apiKey: string | null;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._apiKey = apiKey;
    const config: LlmConfig = {
      provider: "ikuncode",
      baseUrl: (cfg as any).base_url ?? "https://api.ikuncode.cc/v1",
      apiKey: apiKey ?? "",
      model: (cfg as any).model_id ?? "gpt-5.5",
      temperature: 0.35,
      mock: !apiKey,
      subtitleMode: "both",
      ttsProvider: "edge_tts",
      ttsFallbackProvider: "edge_tts",
      ttsVoice: "zh-CN-YunxiNeural",
      ttsRate: "+0%",
      ttsEnabled: true,
    };
    this._inner = new OpenAiCompatibleProvider(config);
  }

  async complete(req: LlmCompleteRequest, ctx: ProviderContext): Promise<LlmCompleteResponse> {
    if (!this._apiKey) {
      throw new ProviderError({
        message: `IKunCode API key not configured`,
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    try {
      const result = await this._inner.callJson<{ text?: string; response?: string }>({
        agentName: "IkunProvider",
        promptFile: "unified",
        inputSummary: req.prompt.slice(0, 200),
        system: req.system ?? "",
        user: req.prompt,
      });

      const text = typeof result === "string" ? result : (result.text ?? result.response ?? JSON.stringify(result));
      return { text };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError({
        message: err.message ?? String(err),
        code: "server",
        provider_id: this.id,
        retriable: false,
        original: err,
      });
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing key" };
    return { ok: true };
  }
}
