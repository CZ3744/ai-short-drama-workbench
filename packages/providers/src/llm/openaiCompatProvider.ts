// v4 schema adapter: OpenAI-compatible text LLM
//
// 接受 ProviderInstance (包含 base_url / api_key / model / temperature / max_tokens) 直接构造,
// 不再从 ENV / localSettings v3 / preset 读. 内部用标准 OpenAI /chat/completions 协议.
//
// 兼容所有 OpenAI-compat 网关:
//   - OpenAI 官方 (https://api.openai.com/v1)
//   - MiMo (https://token-plan-cn.xiaomimimo.com/v1)
//   - DeepSeek (https://api.deepseek.com/v1)
//   - Qwen (https://dashscope.aliyuncs.com/compatible-mode/v1)
//   - OpenRouter (https://openrouter.ai/api/v1) ← openrouter_text 复用本 provider, 仅 base_url 不同
//   - 任何用户自建 LiteLLM / vLLM gateway
//
// v4 schema kind 覆盖: openai_compat, openrouter_text
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

// ─── 结构化字段 (与 providerController.ts ProviderConfig 字段名一致) ───
// 历史: 曾计划用 v4 13-kind ProviderInstance, 现简化为下面 minimum structural type.
// 实际 caller (orchestrationController) 传 ProviderConfig 子集, 类型兼容.
export interface OpenaiCompatInstance {
  id: string;
  label?: string;
  kind?: "openai_compat" | "openrouter_text";
  base_url: string;
  /** 加密 ref. 真实 api key 由 caller 解密后传入 (走 secretStore.decryptKeyRef). */
  api_key: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class OpenaiCompatProvider implements LlmProvider {
  readonly id: string;
  private readonly _baseUrl: string;
  private readonly _apiKey: string;
  private readonly _model: string;
  private readonly _temperature?: number;
  private readonly _maxTokens?: number;
  private readonly _kind: "openai_compat" | "openrouter_text";

  constructor(instance: OpenaiCompatInstance) {
    this.id = instance.id;
    this._baseUrl = String(instance.base_url ?? "").replace(/\/+$/, "");
    this._apiKey = instance.api_key ?? "";
    this._model = instance.model;
    this._temperature = instance.temperature;
    this._maxTokens = instance.max_tokens;
    this._kind = instance.kind === "openrouter_text" ? "openrouter_text" : "openai_compat";
  }

  async complete(req: LlmCompleteRequest, ctx: ProviderContext): Promise<LlmCompleteResponse> {
    if (!this._apiKey || this._apiKey.trim() === "") {
      throw new ProviderError({
        message: `OpenAI-compat provider "${this.id}" API key not configured`,
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }
    if (!this._baseUrl) {
      throw new ProviderError({
        message: `OpenAI-compat provider "${this.id}" base_url missing`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

    const body: Record<string, unknown> = {
      model: this._model,
      messages,
      max_tokens: req.max_tokens ?? this._maxTokens ?? 4096,
      temperature: req.temperature ?? this._temperature ?? 0.35,
    };
    if (req.response_format === "json") {
      body.response_format = { type: "json_object" };
    }

    // OpenRouter best-practice 头 — 便于 OpenRouter dashboard 计费归因. 不影响功能.
    const extraHeaders: Record<string, string> = {};
    if (this._kind === "openrouter_text") {
      extraHeaders["HTTP-Referer"] = "https://video-generate.local";
      extraHeaders["X-Title"] = "video-generate";
    }

    let response: Response;
    try {
      response = await fetch(`${this._baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._apiKey}`,
          ...extraHeaders,
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
        message: `OpenAI-compat HTTP ${response.status}: ${errBody.slice(0, 300)}`,
        code: codeFromHttpStatus(response.status),
        provider_id: this.id,
        retriable: response.status === 429 || response.status >= 500,
        original: { status: response.status, body: errBody.slice(0, 500) },
      });
    }

    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const choices = (json.choices as Array<Record<string, unknown>> | undefined) ?? [];
    const message = (choices[0]?.message as Record<string, unknown> | undefined) ?? {};
    const text = typeof message.content === "string" ? message.content : "";
    const usage = (json.usage as Record<string, unknown> | undefined) ?? undefined;

    if (!text) {
      throw new ProviderError({
        message: `OpenAI-compat returned empty content from model ${this._model}`,
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
            in_tokens: Number(usage.prompt_tokens ?? 0),
            out_tokens: Number(usage.completion_tokens ?? 0),
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
      message: `OpenAI-compat network failed: ${message}`,
      code,
      provider_id: this.id,
      retriable: true,
      original: err,
    });
  }
}
