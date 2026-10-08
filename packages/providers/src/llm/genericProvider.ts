// P5A: Generic LLM Provider — fetch-based openai_compat / anthropic client
// Supports any provider configured in presets with api_type.

import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  LlmProvider,
  LlmCompleteRequest,
  LlmCompleteResponse,
  ProviderContext,
  HealthCheckResult,
} from "../core/types";
import { ProviderError, codeFromHttpStatus } from "../core/errors";

export class GenericLlmProvider implements LlmProvider {
  readonly id: string;
  private _apiKey: string | null;
  private _baseUrl: string;
  private _model: string;
  private _apiType: "openai_compat" | "anthropic";

  constructor(cfg: PresetOption, apiKey: string | null, baseUrlOverride?: string, modelOverride?: string) {
    this.id = cfg.id;
    this._apiKey = apiKey;
    this._baseUrl = (baseUrlOverride ?? (cfg as any).base_url ?? "").replace(/\/$/, "");
    this._model = modelOverride ?? (cfg as any).model_id ?? "gpt-5.5";
    this._apiType = (cfg as any).api_type === "anthropic" ? "anthropic" : "openai_compat";
  }

  async complete(req: LlmCompleteRequest, ctx: ProviderContext): Promise<LlmCompleteResponse> {
    if (!this._apiKey) {
      throw new ProviderError({
        message: `LLM provider "${this.id}" API key not configured`,
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    if (this._apiType === "openai_compat") {
      return this._completeOpenAiCompat(req, ctx);
    }
    return this._completeAnthropic(req, ctx);
  }

  // ── OpenAI-compatible ──────────────────────────────────────────

  private async _completeOpenAiCompat(req: LlmCompleteRequest, ctx: ProviderContext): Promise<LlmCompleteResponse> {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) {
      messages.push({ role: "system", content: req.system });
    }
    messages.push({ role: "user", content: req.prompt });

    const body: Record<string, unknown> = {
      model: this._model,
      messages,
      max_tokens: req.max_tokens ?? 4096,
      temperature: req.temperature ?? 0.35,
    };

    if (req.response_format === "json") {
      body.response_format = { type: "json_object" };
    }

    let response: Response;
    try {
      response = await fetch(`${this._baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify(body),
        // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
        // 删 AbortSignal.timeout(120_000), 只透传 ctx.signal (用户主动中止).
        signal: ctx.signal,
      });
    } catch (err) {
      throw this._networkError(err);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new ProviderError({
        message: `LLM HTTP ${response.status}: ${errBody.slice(0, 300)}`,
        code: codeFromHttpStatus(response.status),
        provider_id: this.id,
        retriable: response.status === 429 || response.status >= 500,
        original: { status: response.status, body: errBody.slice(0, 500) },
      });
    }

    const json = (await response.json()) as any;
    const text: string = json?.choices?.[0]?.message?.content ?? "";
    const usage = json?.usage;

    return {
      text,
      usage: usage
        ? { in_tokens: usage.prompt_tokens ?? 0, out_tokens: usage.completion_tokens ?? 0 }
        : undefined,
    };
  }

  // ── Anthropic ──────────────────────────────────────────────────

  private async _completeAnthropic(req: LlmCompleteRequest, ctx: ProviderContext): Promise<LlmCompleteResponse> {
    const messages: Array<{ role: string; content: string }> = [];
    messages.push({ role: "user", content: req.prompt });

    const body: Record<string, unknown> = {
      model: this._model,
      messages,
      max_tokens: req.max_tokens ?? 4096,
    };

    if (req.system) {
      body.system = req.system;
    }

    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }

    let response: Response;
    try {
      response = await fetch(`${this._baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this._apiKey!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
        // 删 AbortSignal.timeout(120_000), 只透传 ctx.signal (用户主动中止).
        signal: ctx.signal,
      });
    } catch (err) {
      throw this._networkError(err);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new ProviderError({
        message: `Anthropic HTTP ${response.status}: ${errBody.slice(0, 300)}`,
        code: codeFromHttpStatus(response.status),
        provider_id: this.id,
        retriable: response.status === 429 || response.status >= 500,
        original: { status: response.status, body: errBody.slice(0, 500) },
      });
    }

    const json = (await response.json()) as any;
    const text: string = json?.content?.[0]?.text ?? "";
    const usage = json?.usage;

    return {
      text,
      usage: usage
        ? { in_tokens: usage.input_tokens ?? 0, out_tokens: usage.output_tokens ?? 0 }
        : undefined,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing key" };
    return { ok: true };
  }

  private _networkError(err: unknown): ProviderError {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err);
    const code: "timeout" | "server" = name === "AbortError" || name === "TimeoutError" ? "timeout" : "server";
    return new ProviderError({
      message: `LLM network failed: ${message}`,
      code,
      provider_id: this.id,
      retriable: true,
      original: err,
    });
  }
}
