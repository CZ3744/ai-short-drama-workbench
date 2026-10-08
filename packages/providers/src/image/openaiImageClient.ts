// P25: Low-level OpenAI Image API client for gpt-image-2

import { ProviderError, codeFromHttpStatus } from "../core/errors";

export interface OpenAIImageClientConfig {
  api_key: string;
  base_url?: string; // default: https://api.openai.com/v1
  model?: string;    // default: gpt-image-2
  timeout_ms?: number; // default: 120000
}

export interface OpenAIImageGenerateParams {
  prompt: string;
  size?: "1024x1024" | "1536x1024" | "1024x1536";
  n?: number;        // 1-4
  quality?: "standard" | "hd";
  response_format?: "b64_json" | "url"; // default b64_json
  /** B5: override constructor-level default model per-call. */
  model?: string;
}

export interface OpenAIImageEditParams {
  prompt: string;
  image: Buffer;      // the reference image
  image_mime?: string; // default: image/png
  size?: "1024x1024" | "1536x1024" | "1024x1536";
  n?: number;
  quality?: "standard" | "hd";
}

export interface OpenAIImageData {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

export interface OpenAIImageResponse {
  created: number;
  data: OpenAIImageData[];
}

/**
 * Thin OpenAI Image API client.
 *
 * - POST /v1/images/generations (text-to-image)
 * - POST /v1/images/edits (image-to-image, if supported)
 * - base_url overridable via preset for proxy/gateway scenarios
 */
// B7: gpt-image-1 / gpt-image-2 reject response_format field — omit it for these models
const isGptImageModel = (model: string): boolean => /^gpt-image-\d+/i.test(model);

export class OpenAIImageClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(cfg: OpenAIImageClientConfig) {
    this.apiKey = cfg.api_key;
    this.baseUrl = (cfg.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = cfg.model ?? "gpt-image-2";
    this.timeoutMs = cfg.timeout_ms ?? 120_000;
  }

  async generate(params: OpenAIImageGenerateParams, signal?: AbortSignal): Promise<OpenAIImageResponse> {
    const effectiveModel = params.model ?? this.model;
    const body: Record<string, unknown> = {
      model: effectiveModel,
      prompt: params.prompt,
      size: params.size ?? "1024x1024",
      n: params.n ?? 1,
      quality: params.quality ?? "standard",
      // B7: gpt-image-* rejects response_format; omit it for those models
      ...(!isGptImageModel(effectiveModel) && { response_format: params.response_format ?? "b64_json" }),
    };

    const res = await this._fetch("/images/generations", body, signal);
    return res as OpenAIImageResponse;
  }

  async edit(params: OpenAIImageEditParams, signal?: AbortSignal): Promise<OpenAIImageResponse> {
    // OpenAI /v1/images/edits uses multipart/form-data
    const form = new FormData();
    form.set("model", this.model);
    form.set("prompt", params.prompt);
    form.set("size", params.size ?? "1024x1024");
    form.set("n", String(params.n ?? 1));
    form.set("quality", params.quality ?? "standard");
    // B7: gpt-image-* rejects response_format; omit it for those models
    if (!isGptImageModel(this.model)) {
      form.set("response_format", "b64_json");
    }

    const mime = params.image_mime ?? "image/png";
    const ext = mime.includes("png") ? "png" : "webp";
    const blob = new Blob([new Uint8Array(params.image)], { type: mime });
    form.set("image", blob, `reference.${ext}`);

    const url = `${this.baseUrl}/images/edits`;

    // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
    // 删除 setTimeout(() => controller.abort(), this.timeoutMs) 模式, 只透传外部 signal (用户主动中止).
    // 远端等多久就等多久, 只听 API 真实结果. 复杂图片可能 >3min, 不能本地误判超时.
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 2026-05-28 audit P0-09: 改 throw ProviderError 让 caller 拿到结构化 code/status_code,
      // 之前裸 Error("OpenAI Image API 400: ...") caller 用 regex `/API (\d{3})/` 提 status,
      // base_url 一被 proxy 改就解析失败 → status=500 → 错误分类成 server 而非 invalid_request.
      throw new ProviderError({
        message: `OpenAI Image API ${res.status}: ${text.slice(0, 500)}`,
        code: codeFromHttpStatus(res.status),
        provider_id: "openai_image",
        retriable: res.status === 429 || res.status >= 500,
      });
    }

    return (await res.json()) as OpenAIImageResponse;
  }

  // ─── internals ──────────────────────────────────────────────────

  private async _fetch(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<OpenAIImageResponse> {
    const url = `${this.baseUrl}${endpoint}`;

    // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
    // 删除 setTimeout(() => controller.abort(), this.timeoutMs) 模式, 只透传外部 signal (用户主动中止).
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 2026-05-28 audit P0-09: throw ProviderError 同上.
      throw new ProviderError({
        message: `OpenAI Image API ${res.status}: ${text.slice(0, 500)}`,
        code: codeFromHttpStatus(res.status),
        provider_id: "openai_image",
        retriable: res.status === 429 || res.status >= 500,
      });
    }

    return (await res.json()) as OpenAIImageResponse;
  }
}
