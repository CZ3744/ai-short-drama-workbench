// v4 schema adapter: Anthropic-compatible text LLM
//
// 接受 ProviderInstance (包含 base_url / api_key / model / temperature / max_tokens) 直接构造,
// 不再从 ENV / localSettings v3 / preset 读. 内部用标准 Anthropic /v1/messages 协议.
//
// 兼容:
//   - Anthropic 官方 (https://api.anthropic.com/v1)
//   - MiMo Anthropic 网关 (https://token-plan-cn.xiaomimimo.com/anthropic)
//   - 任何 Anthropic Messages API 兼容代理
//
// v4 schema kind 覆盖: anthropic_compat
//
// 错误码映射经由 ../core/errors:codeFromHttpStatus(), 不重复实现.

import type {
  LlmProvider,
  LlmCompleteRequest,
  LlmCompleteResponse,
  ProviderContext,
  HealthCheckResult,
} from "../core/types";
import { ProviderError, codeFromHttpStatus } from "../core/errors";

export interface AnthropicCompatInstance {
  id: string;
  label?: string;
  kind?: "anthropic_compat";
  base_url: string;
  /** 真实 api key, caller 解密后传入. */
  api_key: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicCompatProvider implements LlmProvider {
  readonly id: string;
  private readonly _baseUrl: string;
  private readonly _apiKey: string;
  private readonly _model: string;
  private readonly _temperature?: number;
  private readonly _maxTokens?: number;

  constructor(instance: AnthropicCompatInstance) {
    this.id = instance.id;
    this._baseUrl = String(instance.base_url ?? "").replace(/\/+$/, "");
    this._apiKey = instance.api_key ?? "";
    this._model = instance.model;
    this._temperature = instance.temperature;
    this._maxTokens = instance.max_tokens;
  }

  async complete(req: LlmCompleteRequest, ctx: ProviderContext): Promise<LlmCompleteResponse> {
    if (!this._apiKey || this._apiKey.trim() === "") {
      throw new ProviderError({
        message: `Anthropic-compat provider "${this.id}" API key not configured`,
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }
    if (!this._baseUrl) {
      throw new ProviderError({
        message: `Anthropic-compat provider "${this.id}" base_url missing`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    const body: Record<string, unknown> = {
      model: this._model,
      messages: [{ role: "user", content: req.prompt }],
      max_tokens: req.max_tokens ?? this._maxTokens ?? 4096,
    };
    if (req.system) body.system = req.system;
    const temp = req.temperature ?? this._temperature;
    if (temp !== undefined) body.temperature = temp;

    let response: Response;
    try {
      response = await fetch(`${this._baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this._apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
        // 删 AbortSignal.timeout(DEFAULT_TIMEOUT_MS), 只透传 ctx.signal (用户主动中止).
        signal: ctx.signal,
      });
    } catch (err) {
      throw this._networkError(err);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new ProviderError({
        message: `Anthropic-compat HTTP ${response.status}: ${errBody.slice(0, 300)}`,
        code: codeFromHttpStatus(response.status),
        provider_id: this.id,
        retriable: response.status === 429 || response.status >= 500,
        original: { status: response.status, body: errBody.slice(0, 500) },
      });
    }

    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const contentArr = (json.content as Array<Record<string, unknown>> | undefined) ?? [];
    const firstText = contentArr.find((b) => b?.type === "text") ?? contentArr[0] ?? {};
    const text = typeof firstText.text === "string" ? firstText.text : "";
    const usage = (json.usage as Record<string, unknown> | undefined) ?? undefined;

    if (!text) {
      throw new ProviderError({
        message: `Anthropic-compat returned empty content from model ${this._model}`,
        code: "invalid_output",
        provider_id: this.id,
        retriable: false,
        original: json,
      });
    }

    return {
      text,
      usage: usage
        ? {
            in_tokens: Number(usage.input_tokens ?? 0),
            out_tokens: Number(usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing key" };
    if (!this._baseUrl) return { ok: false, reason: "missing base_url" };
    return { ok: true };
  }

  private _networkError(err: unknown): ProviderError {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err);
    const code: "timeout" | "server" =
      name === "AbortError" || name === "TimeoutError" ? "timeout" : "server";
    return new ProviderError({
      message: `Anthropic-compat network failed: ${message}`,
      code,
      provider_id: this.id,
      retriable: true,
      original: err,
    });
  }
}
