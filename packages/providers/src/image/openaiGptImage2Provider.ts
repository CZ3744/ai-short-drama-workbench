// P25: OpenAI gpt-image-2 Provider — ImageProvider implementation

import type { PresetOption } from "../../../core/src/presetSchema";
import type { ImageProvider, ImageGenerateRequest, ImageGenerateResponse, ProviderContext, HealthCheckResult } from "../core/types";
import { ProviderError } from "../core/errors";
import { codeFromHttpStatus } from "../core/errors";
import { OpenAIImageClient } from "./openaiImageClient";

/**
 * Preset extras expected from image_provider.json:
 *   base_url?: string   — override OpenAI endpoint (proxy/gateway)
 *   model?: string      — override model name (default gpt-image-2)
 *   quality?: "standard" | "hd"
 *   cost_per_image_usd?: number — per-image cost for estimation
 */
export class OpenAIGptImage2Provider implements ImageProvider {
  readonly id: string;
  private _client: OpenAIImageClient | null;
  private _apiKey: string | null;
  private _cfg: PresetOption;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._cfg = cfg;
    this._apiKey = apiKey;
    this._client = apiKey
      ? new OpenAIImageClient({
          api_key: apiKey,
          base_url: (cfg as any).base_url,
          model: (cfg as any).model_id ?? (cfg as any).model,
        })
      : null;
  }

  async generate(req: ImageGenerateRequest, ctx: ProviderContext): Promise<ImageGenerateResponse> {
    if (!this._client || !this._apiKey) {
      throw new ProviderError({
        message: "OpenAI API key not configured for gpt-image-2",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    const size = this._mapSize(req.width, req.height);
    const quality = (this._cfg as any).quality ?? "standard";
    // B5: request.model_id overrides cfg-level default so the same provider
    // instance can serve different models when selected via ModelPicker.
    const modelOverride: string | undefined =
      req.model_id ?? (this._cfg as any).model_id ?? (this._cfg as any).model;

    ctx.log("info", `[gpt-image-2] Generating ${size}, quality=${quality}, model=${modelOverride ?? "default"}, prompt=${req.prompt.slice(0, 60)}...`);

    try {
      // If reference images provided, attempt image edit endpoint
      if (req.reference_images && req.reference_images.length > 0) {
        return await this._generateWithReference(req, ctx, size, quality);
      }

      const response = await this._client.generate({
        prompt: req.prompt,
        size,
        n: Math.min(req.count, 4),
        quality,
        response_format: "b64_json",
        ...(modelOverride ? { model: modelOverride } : {}),
      }, ctx.signal);

      const images = response.data.map((d) => {
        if (!d.b64_json) throw new Error("Missing b64_json in response");
        const buffer = Buffer.from(d.b64_json, "base64");
        return {
          buffer,
          mime: "image/png",
          width: req.width,
          height: req.height,
        };
      });

      // 2026-05-16 渐进式落盘: batch 返回 N 张时, 逐张触发 on_image_ready.
      // gpt-image-2 是 n=N 一次性返, 不是串行, 但 UX 上仍按"一张一张到达"展示.
      if (req.on_image_ready) {
        for (let i = 0; i < images.length; i += 1) {
          try {
            await req.on_image_ready(images[i], i, images.length);
          } catch (cbErr) {
            ctx.log(
              "warn",
              `[gpt-image-2] on_image_ready 回调失败 (index=${i}): ${
                cbErr instanceof Error ? cbErr.message : cbErr
              }`,
            );
          }
        }
      }

      const costPerImage = (this._cfg as any).cost_per_image_usd ?? 0;
      return {
        images,
        cost: costPerImage > 0
          ? { currency: "USD", amount: costPerImage * images.length, basis: "estimated" }
          : undefined,
      };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      // Try to extract HTTP status from error message
      const statusMatch = err.message?.match(/API (\d{3})/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 500;
      throw new ProviderError({
        message: err.message ?? String(err),
        code: codeFromHttpStatus(status),
        provider_id: this.id,
        retriable: status === 429 || status === 503,
        original: err,
      });
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing OPENAI_API_KEY" };
    return { ok: true };
  }

  // B3: 预估成本(USD 按 7.2 汇率折算 CNY)
  estimateCost(req: ImageGenerateRequest): { cny: number; basis: "estimated" } {
    const costPerImageUsd = (this._cfg as any).cost_per_image_usd ?? 0.04;
    return { cny: costPerImageUsd * req.count * 7.2, basis: "estimated" };
  }

  // ─── internals ──────────────────────────────────────────────────

  private async _generateWithReference(
    req: ImageGenerateRequest,
    ctx: ProviderContext,
    size: "1024x1024" | "1536x1024" | "1024x1536",
    quality: string,
  ): Promise<ImageGenerateResponse> {
    // 2026-05-28 audit P0-05: gpt-image-2 edit 端点只接 1 张参考图. 之前 silent 丢
    // 后续 N-1 张 — 违反 entity-first 铁律 0 (跨分镜一致性靠多张参考图).
    // 现在 throw invalid_request, 让 caller 选别的支持多图的 provider, 或减到 1 张.
    if (req.reference_images!.length > 1) {
      throw new ProviderError({
        message: `gpt-image-2 edit endpoint 仅支持 1 张参考图, 但收到 ${req.reference_images!.length} 张. 请减少到 1 张, 或换用 jimeng_image / openrouter_image 等支持多图的 provider.`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    // For image-to-image: use the edit endpoint with the (only) reference image
    // We need to load the reference image buffer from the asset_id
    // For now, the asset_id is expected to be a file path
    const ref = req.reference_images![0];
    const fs = await import("node:fs/promises");
    const refPath = ref.asset_id;

    let refBuffer: Buffer;
    try {
      refBuffer = await fs.readFile(refPath);
    } catch {
      throw new ProviderError({
        message: `Cannot read reference image: ${refPath}`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    ctx.log("info", `[gpt-image-2] Using reference image edit endpoint`);

    const response = await this._client!.edit({
      prompt: req.prompt,
      image: refBuffer,
      size,
      n: Math.min(req.count, 4),
      quality: quality as "standard" | "hd",
    }, ctx.signal);

    const images = response.data.map((d) => {
      if (!d.b64_json) throw new Error("Missing b64_json in edit response");
      const buffer = Buffer.from(d.b64_json, "base64");
      return {
        buffer,
        mime: "image/png",
        width: req.width,
        height: req.height,
      };
    });

    // 2026-05-16 渐进式落盘 — 同 generate 分支.
    if (req.on_image_ready) {
      for (let i = 0; i < images.length; i += 1) {
        try {
          await req.on_image_ready(images[i], i, images.length);
        } catch (cbErr) {
          ctx.log(
            "warn",
            `[gpt-image-2] on_image_ready 回调失败 (edit, index=${i}): ${
              cbErr instanceof Error ? cbErr.message : cbErr
            }`,
          );
        }
      }
    }

    const costPerImage = (this._cfg as any).cost_per_image_usd ?? 0;
    return {
      images,
      cost: costPerImage > 0
        ? { currency: "USD", amount: costPerImage * images.length, basis: "estimated" }
        : undefined,
    };
  }

  private _mapSize(w: number, h: number): "1024x1024" | "1536x1024" | "1024x1536" {
    // Map requested dimensions to closest supported size
    if (w === h) return "1024x1024";
    if (w > h) return "1536x1024";
    return "1024x1536";
  }
}
