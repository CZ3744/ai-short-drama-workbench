// P20: MiMo LLM Provider wrapper — adapts existing mimo.ts to LlmProvider interface

import type { PresetOption } from "../../../core/src/presetSchema";
import type { LlmProvider, LlmCompleteRequest, LlmCompleteResponse, ProviderContext, HealthCheckResult } from "../core/types";
import { ProviderError } from "../core/errors";
import { MimoTextProvider, type MimoConfig, loadMimoConfig } from "../mimo";

export class MimoLlmProvider implements LlmProvider {
  readonly id: string;
  private _inner: MimoTextProvider;
  private _apiKey: string | null;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._apiKey = apiKey;
    const mimoConfig: MimoConfig = {
      ...loadMimoConfig(),
      apiKey: apiKey ?? undefined,
      textModel: (cfg as any).model_id ?? "mimo-v2.5-pro",
    };
    this._inner = new MimoTextProvider(mimoConfig);
  }

  async complete(req: LlmCompleteRequest, ctx: ProviderContext): Promise<LlmCompleteResponse> {
    if (!this._apiKey) {
      throw new ProviderError({
        message: `MiMo API key not configured`,
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    try {
      const text = await this._inner.chatText({
        system: req.system ?? "",
        user: req.prompt,
      });
      return { text };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      const errType = err.error_type ?? "unknown";
      throw new ProviderError({
        message: err.message ?? String(err),
        code: errType === "key_missing" ? "missing_key" : errType === "rate_limit" ? "rate_limit" : "server",
        provider_id: this.id,
        retriable: errType === "rate_limit",
        original: err,
      });
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing key" };
    return { ok: true };
  }
}
