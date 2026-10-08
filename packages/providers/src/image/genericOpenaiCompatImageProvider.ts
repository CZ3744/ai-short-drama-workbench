// TODO(v4-schema): 此 adapter 待改造接入 v4 ProviderInstance
//   当前仍走旧 ENV 读取方式 (从 localSettings v3 读)
//   对应 v4 kind: openai_image_compat
//   备注: gpt-image-1 不支持 response_format 字段, 需按 model 条件拆分
import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  ImageProvider,
  ImageGenerateRequest,
  ImageGenerateResponse,
  ProviderContext,
  HealthCheckResult,
} from "../core/types";
import { ProviderError } from "../core/errors";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Generic OpenAI-compatible image provider for CUSTOM_PROVIDERS.
 * Uses the standard OpenAI /v1/images/generations API.
 */
export class GenericOpenaiCompatImageProvider implements ImageProvider {
  readonly id: string;
  private _apiKey: string | null;
  private _cfg: PresetOption;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._cfg = cfg;
    this._apiKey = apiKey;
  }

  async generate(
    req: ImageGenerateRequest,
    ctx: ProviderContext,
  ): Promise<ImageGenerateResponse> {
    if (!this._apiKey) {
      throw new ProviderError({
        message: `API key not configured for custom image provider "${this.id}"`,
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    const baseUrl: string =
      ((this._cfg as any).base_url as string) ?? "https://api.openai.com/v1";
    // B5: request.model_id (ModelPicker colon-suffix) wins over cfg default.
    const modelId: string =
      req.model_id ?? ((this._cfg as any).model_id as string) ?? "dall-e-3";
    const timeoutMs: number =
      ((this._cfg as any).timeout_ms as number) ?? DEFAULT_TIMEOUT_MS;

    const url = `${baseUrl.replace(/\/$/, "")}/images/generations`;

    ctx.log("info", `[${this.id}] Generating ${req.count} image(s) via ${url}`);

    // B7: gpt-image-* rejects response_format; omit it for those models
    const _isGptImageModel = (m: string) => /^gpt-image-\d+/i.test(m);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        prompt: req.prompt,
        n: req.count ?? 1,
        size: `${req.width}x${req.height}`,
        ...(!_isGptImageModel(modelId) && { response_format: "b64_json" }),
      }),
      // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
      // 删 AbortSignal.timeout(timeoutMs), 只透传 ctx.signal (用户主动中止). 远端等多久就等多久,
      // 只听 API 真实结果. 复杂图片可能 >3min, 不能本地误判超时.
      signal: ctx.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError({
        message: `${this.id} returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        code: response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : "invalid_request",
        provider_id: this.id,
        retriable: response.status >= 500 || response.status === 429,
      });
    }

    const data: any = await response.json();
    const images: Buffer[] = [];

    for (const item of data.data ?? []) {
      if (item.b64_json) {
        images.push(Buffer.from(item.b64_json, "base64"));
      } else if (item.url) {
        const imgResp = await fetch(item.url, {
          // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(30000), 只透传 ctx.signal.
          signal: ctx.signal,
        });
        if (!imgResp.ok) {
          throw new ProviderError({
            message: `Failed to download image from URL: HTTP ${imgResp.status}`,
            code: "server",
            provider_id: this.id,
            retriable: true,
          });
        }
        const buf = await imgResp.arrayBuffer();
        images.push(Buffer.from(buf));
      }
    }

    if (images.length === 0) {
      throw new ProviderError({
        message: "No images returned from API",
        code: "unknown",
        provider_id: this.id,
        retriable: true,
      });
    }

    return {
      images: images.map((buf) => ({
        buffer: buf,
        mime: "image/png",
        width: req.width,
        height: req.height,
      })),
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) {
      return { ok: false, reason: "未配置 API Key" };
    }
    return { ok: true };
  }

  // B3: 预估成本(自定义 provider 无法精确报价)
  estimateCost(req: ImageGenerateRequest): { cny: number; basis: "estimated" } {
    return { cny: 0, basis: "estimated" };
  }
}
