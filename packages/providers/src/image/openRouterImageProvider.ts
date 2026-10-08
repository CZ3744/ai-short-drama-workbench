// P120 Wave 1A: OpenRouter Image Provider — ImageProvider implementation
// Supports Gemini 2.5 Flash Image and Flux 1.1 Pro via OpenRouter /chat/completions

import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  ImageProvider,
  ImageGenerateRequest,
  ImageGenerateResponse,
  ProviderContext,
  HealthCheckResult,
  GeneratedImage,
} from "../core/types";
import { ProviderError, type ProviderErrorCode } from "../core/errors";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 120_000;

export class OpenRouterImageProvider implements ImageProvider {
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
        message: "OpenRouter API key not configured",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    // B5: request.model_id (ModelPicker colon-suffix) takes priority over
    // the instance's preset default. Lets users pick e.g.
    // "openrouter_image:google/gemini-2.5-flash-image" vs ":black-forest-labs/flux-1.1-pro".
    const modelId: string = req.model_id ?? (this._cfg as any).model_id;
    const baseUrl: string =
      ((this._cfg as any).base_url as string) ?? DEFAULT_BASE_URL;
    const supportsRef: boolean =
      (this._cfg as any).supports_reference_image === true;

    ctx.log(
      "info",
      `[OpenRouter ${modelId}] Generating ${req.count} image(s), ${req.width}x${req.height}, prompt=${req.prompt.slice(0, 60)}...`,
    );

    // Build the message content array
    const contentParts: Array<Record<string, unknown>> = [
      { type: "text", text: req.prompt },
    ];

    // Handle reference images
    if (req.reference_images && req.reference_images.length > 0) {
      if (supportsRef) {
        const fs = await import("node:fs/promises");
        for (const ref of req.reference_images) {
          try {
            const fileBuffer = await fs.readFile(ref.asset_id);
            const b64 = fileBuffer.toString("base64");
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:image/png;base64,${b64}` },
            });
            ctx.log(
              "info",
              `[OpenRouter ${modelId}] Attached reference image: ${ref.asset_id}`,
            );
          } catch (err: any) {
            ctx.log(
              "warn",
              `[OpenRouter ${modelId}] Cannot read reference image ${ref.asset_id}: ${err.message}`,
            );
          }
        }
      } else {
        ctx.log(
          "warn",
          `[OpenRouter ${modelId}] Reference images not supported, ignoring ${req.reference_images.length} reference(s)`,
        );
      }
    }

    const body: Record<string, unknown> = {
      model: modelId,
      messages: [{ role: "user", content: contentParts }],
      modalities: ["image", "text"],
    };

    const count = req.count > 0 ? req.count : 1;
    // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
    // timeout_ms 配置不再读, 留 backward-compat. _combinedSignal 改为只透传 ctx.signal.

    // OpenRouter does not support 'n' for image models;
    // fire count concurrent requests manually.
    const generateOne = async (): Promise<any> => {
      const signal = ctx.signal;

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._apiKey}`,
          "HTTP-Referer": "http://localhost:5173",
          "X-Title": "AI-ScriptForge-Workbench",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw { status: res.status, text: text.slice(0, 500) };
      }

      return res.json();
    };

    try {
      const results = await Promise.all(
        Array.from({ length: count }, () => generateOne()),
      );

      const allImages: GeneratedImage[] = [];
      for (const data of results) {
        const choice = data.choices?.[0];
        if (!choice) {
          ctx.log(
            "warn",
            `[OpenRouter ${modelId}] No choices in response`,
          );
          continue;
        }

        const message = choice.message;
        if (!message) {
          ctx.log(
            "warn",
            `[OpenRouter ${modelId}] No message in response choice`,
          );
          continue;
        }

        let found = false;

        // Gemini format: data.choices[0].message.images[].image_url.url
        if (
          message.images &&
          Array.isArray(message.images) &&
          message.images.length > 0
        ) {
          for (const img of message.images) {
            const dataUrl = img.image_url?.url;
            if (dataUrl) {
              allImages.push({
                buffer: this._dataUrlToBuffer(dataUrl as string),
                mime: "image/png",
                width: req.width,
                height: req.height,
              });
              found = true;
            }
          }
        }

        // Future compatibility: check content blocks for image_url
        if (!found && message.content) {
          const contentArr = Array.isArray(message.content)
            ? message.content
            : [message.content];
          for (const block of contentArr) {
            if (block.type === "image_url" && block.image_url?.url) {
              allImages.push({
                buffer: this._dataUrlToBuffer(
                  block.image_url.url as string,
                ),
                mime: "image/png",
                width: req.width,
                height: req.height,
              });
              found = true;
            }
          }
        }

        if (!found) {
          ctx.log(
            "warn",
            `[OpenRouter ${modelId}] No image data found in response`,
          );
        }
      }

      if (allImages.length === 0) {
        throw new ProviderError({
          message: "No images returned from OpenRouter",
          code: "unknown",
          provider_id: this.id,
          retriable: true,
        });
      }

      const costPerImage: number =
        (this._cfg as any).cost_per_image_cny ?? 0;
      return {
        images: allImages,
        cost:
          costPerImage > 0
            ? {
                currency: "CNY" as const,
                amount: costPerImage * allImages.length,
                basis: "estimated" as const,
              }
            : undefined,
      };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;

      // Handle structured fetch error with status code
      if (typeof err.status === "number") {
        throw new ProviderError({
          message: `OpenRouter API ${err.status}: ${err.text ?? String(err)}`,
          code: _codeFromStatus(err.status),
          provider_id: this.id,
          retriable: err.status === 429,
          original: err,
        });
      }

      throw new ProviderError({
        message: err.message ?? String(err),
        code: "unknown",
        provider_id: this.id,
        retriable: false,
        original: err,
      });
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey)
      return { ok: false, reason: "missing OPENROUTER_API_KEY" };
    return { ok: true };
  }

  // B3: 预估成本(从 preset 的 cost_per_image_cny 获取)
  estimateCost(req: ImageGenerateRequest): { cny: number; basis: "estimated" } {
    const costPerImage: number = (this._cfg as any).cost_per_image_cny ?? 0;
    return { cny: costPerImage * req.count, basis: "estimated" };
  }

  // ─── internals ──────────────────────────────────────────────────

  private _dataUrlToBuffer(dataUrl: string): Buffer {
    const b64 = dataUrl.includes(",")
      ? dataUrl.split(",")[1]!
      : dataUrl;
    return Buffer.from(b64, "base64");
  }

  /**
   * 2026-05-19: 用户原话"禁止在本地设置主动超时" — 此 helper 不再叠加 AbortSignal.timeout,
   * 仅透传外部 signal. 保留方法签名以避免破坏调用方, 不读 _timeoutMs.
   */
  private _combinedSignal(
    external: AbortSignal,
    _timeoutMs: number,
  ): AbortSignal {
    return external;
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function _codeFromStatus(status: number): ProviderErrorCode {
  if (status === 401) return "missing_key";
  if (status === 402) return "insufficient_balance";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  return "unknown";
}
