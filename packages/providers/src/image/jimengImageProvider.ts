/**
 * P21: JimengImageProvider — 即梦 4.0 image generation via Volcengine API
 *
 * Implements the ImageProvider interface from P20.
 * Uses JimengImageClient for HTTP + HMAC-SHA256 signing.
 *
 * Key mapping:
 *   JIMENG_VOLC_ACCESS_KEY / JIMENG_VOLC_SECRET_KEY
 *   from localSettings.getKeyFor("jimeng_image_4") — returns JSON {"access_key":"...","secret_key":"..."}
 *
 * Known constraints (needs real-doc confirmation):
 *   - Model req_key: "jimeng_high_aes_general_v40" (即梦4.0)
 *   - Max resolution: 2048x2048
 *   - Prompt length: ~800 Chinese chars (estimated, needs confirmation)
 *   - Supported sizes: 512-2048, multiples of 8
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  ImageProvider,
  ImageGenerateRequest,
  ImageGenerateResponse,
  ProviderContext,
  HealthCheckResult,
  CostInfo,
} from "../core/types";
import { ProviderError, codeFromHttpStatus } from "../core/errors";
import { paramsDigest } from "../core/ledger";
import { JimengImageClient, type JimengImageRequestBody, type JimengApiResponse } from "./jimengImageClient";
import { adaptImagePrompt } from "../promptAdapters/jimeng";

// ─── Constants ──────────────────────────────────────────────────────────

/** 即梦 4.0 req_key — needs real-doc confirmation */
const JIMENG_V4_REQ_KEY = "jimeng_high_aes_general_v40";

/** Default cost per image (CNY). 0 until pricing is confirmed. */
const DEFAULT_COST_PER_IMAGE = 0;

/** Supported size constraints */
const MIN_SIZE = 512;
const MAX_SIZE = 2048;
const SIZE_MULTIPLE = 8;

// ─── JimengImageProvider ────────────────────────────────────────────────

export class JimengImageProvider implements ImageProvider {
  readonly id: string;
  private _client: JimengImageClient | null = null;
  private _accessKey: string | null = null;
  private _secretKey: string | null = null;
  private _costPerImage: number;
  private _cfg: PresetOption;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._cfg = cfg;

    // apiKey may be a JSON string with access_key + secret_key
    if (apiKey) {
      try {
        const parsed = JSON.parse(apiKey);
        this._accessKey = parsed.access_key ?? parsed.JIMENG_VOLC_ACCESS_KEY ?? null;
        this._secretKey = parsed.secret_key ?? parsed.JIMENG_VOLC_SECRET_KEY ?? null;
      } catch {
        // If it's not JSON, treat as single key (backward compat — won't work for signing)
        this._accessKey = apiKey;
        this._secretKey = null;
      }
    }

    if (this._accessKey && this._secretKey) {
      this._client = new JimengImageClient({
        accessKey: this._accessKey,
        secretKey: this._secretKey,
      });
    }

    // Cost: from preset notes or default 0
    this._costPerImage = DEFAULT_COST_PER_IMAGE;
  }

  // ─── generate ─────────────────────────────────────────────────────

  async generate(req: ImageGenerateRequest, ctx: ProviderContext): Promise<ImageGenerateResponse> {
    if (!this._client) {
      throw new ProviderError({
        message: "Jimeng Volcengine API keys not configured (need access_key + secret_key)",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    // Validate dimensions
    const width = this._clampSize(req.width);
    const height = this._clampSize(req.height);

    // Adapt prompt via P13 adapter
    // adaptImagePrompt expects (generalPromptText, shot, characters, scene, providerConfig)
    // We use a simplified call — the provider receives the final prompt from the pipeline
    // so we use req.prompt directly with minimal adaptation
    const adapted = this._adaptPrompt(req.prompt, req.negative_prompt, width, height);

    // Build reference images (base64)
    let binaryDataB64: string[] | undefined;
    if (req.reference_images && req.reference_images.length > 0) {
      binaryDataB64 = [];
      for (const ref of req.reference_images) {
        const b64 = await this._loadReferenceImageBase64(ref.asset_id, ctx);
        if (b64) binaryDataB64.push(b64);
      }
      if (binaryDataB64.length === 0) binaryDataB64 = undefined;
    }

    // B5: request.model_id (ModelPicker colon-suffix) overrides cfg.model_id /
    // the hardcoded V4 default — preserves the ability to switch versions
    // (jimeng_high_aes_general_v40 ↔ v35) per request.
    const cfgModelId = (this._cfg as any).model_id as string | undefined;
    const reqKey = (req.model_id?.trim() || cfgModelId || JIMENG_V4_REQ_KEY) as JimengImageRequestBody["req_key"];

    // Build request body
    const body: JimengImageRequestBody = {
      req_key: reqKey,
      prompt: adapted.prompt,
      negative_prompt: adapted.negative_prompt,
      width,
      height,
      scale: adapted.scale,
      seed: req.seed,
      steps: adapted.steps,
      return_url: true,   // get URL, then download to Buffer
      model_version: "4.0",
    };

    if (binaryDataB64 && binaryDataB64.length > 0) {
      body.binary_data_base64 = binaryDataB64;
    }

    // Handle count — loop if API doesn't support num_images
    const count = Math.max(1, Math.min(req.count, 4));
    const allBuffers: Buffer[] = [];
    const startMs = Date.now();

    try {
      // 2026-05-19: ctx.signal 现在 optional, 用 new AbortController().signal 兜底 (never-abort).
      const signalOrNoop = ctx.signal ?? new AbortController().signal;
      if (count === 1) {
        const buffer = await this._callAndDownload(body, signalOrNoop);
        allBuffers.push(buffer);
      } else {
        // Concurrent calls for multiple images
        // 2026-05-28 audit P1-37: 之前 N 张图各加一个 random offset, 但 Math.random() < 1 → offset 0-9999,
        // count=4 时碰撞概率 5%+ → 实际只有 3 张不同图. 改用 i*10000 严格不冲突 (+ random 当微调).
        // 这样 4 张图 seed = base+0..9999 / base+10000..19999 / base+20000..29999 / base+30000..39999.
        const promises = Array.from({ length: count }, (_, i) =>
          this._callAndDownload(
            {
              ...body,
              seed: req.seed != null
                ? req.seed + i * 10000 + Math.floor(Math.random() * 10000)
                : undefined,
            },
            signalOrNoop,
          ),
        );
        const results = await Promise.all(promises);
        allBuffers.push(...results);
      }

      const durationMs = Date.now() - startMs;
      ctx.log("info", `Jimeng generated ${allBuffers.length} image(s) in ${durationMs}ms`, {
        provider_id: this.id,
        width,
        height,
      });

      // Build cost info — one ledger entry per image
      const cost: CostInfo | undefined = this._costPerImage > 0
        ? { currency: "CNY", amount: this._costPerImage * allBuffers.length, basis: "estimated" }
        : { currency: "CNY", amount: 0, basis: "estimated" };

      const images = allBuffers.map((buffer) => ({
        buffer,
        mime: "image/png",
        width,
        height,
        seed: req.seed,
      }));

      return { images, cost };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw this._mapError(err);
    }
  }

  // ─── healthCheck ──────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._accessKey || !this._secretKey) {
      return { ok: false, reason: "missing JIMENG_VOLC_ACCESS_KEY / JIMENG_VOLC_SECRET_KEY" };
    }
    return { ok: true };
  }

  // B3: 预估成本(按张单价 × count)
  estimateCost(req: ImageGenerateRequest): { cny: number; basis: "estimated" } {
    return { cny: this._costPerImage * req.count, basis: "estimated" };
  }

  // ─── internal helpers ─────────────────────────────────────────────

  /**
   * Call the API and download the result image to a Buffer.
   */
  private async _callAndDownload(body: JimengImageRequestBody, signal: AbortSignal): Promise<Buffer> {
    const resp = await this._client!.generateImage(body, signal);

    // Check API-level errors
    if (resp.code !== 10000) {
      throw this._mapApiError(resp);
    }

    // Try to get image data
    const imageUrls = resp.data?.image_urls;
    const b64Data = resp.data?.binary_data_base64;

    if (b64Data && b64Data.length > 0 && b64Data[0]) {
      // Direct base64 response
      return Buffer.from(b64Data[0], "base64");
    }

    if (imageUrls && imageUrls.length > 0 && imageUrls[0]) {
      // Download from URL
      try {
        return await this._client!.downloadImage(imageUrls[0], signal);
      } catch (downloadErr: any) {
        throw new ProviderError({
          message: `Image URL download failed: ${downloadErr.message}`,
          code: "server",
          provider_id: this.id,
          retriable: false,
          original: downloadErr,
        });
      }
    }

    throw new ProviderError({
      message: "Jimeng API returned no image data",
      code: "server",
      provider_id: this.id,
      retriable: false,
    });
  }

  /**
   * Simplified prompt adaptation.
   * In full pipeline, adaptImagePrompt from P13 handles shot/character/scene.
   * Here we apply basic quality suffixes.
   */
  private _adaptPrompt(
    prompt: string,
    negativePrompt: string | undefined,
    _width: number,
    _height: number,
  ): { prompt: string; negative_prompt: string; scale: number; steps: number } {
    return {
      prompt,
      negative_prompt: negativePrompt ?? "模糊，变形，低质量，水印，文字",
      scale: 7.5,
      steps: 30,
    };
  }

  /**
   * Load a reference image from a file path or AssetStore index and convert to base64.
   *
   * 2026-05-28 audit P0-06: v2 主流量 (shotStageController / element 路径) 把 picked
   * 图 resolve 后传**绝对文件路径**给 provider. 旧版本扫 series/<slug>/assets/index.jsonl
   * 永远 return null — silent 丢 reference 违反 entity-first 铁律 0.
   *
   * 现在策略:
   *   1. assetId 是绝对路径 → 直接 fs.readFile
   *   2. assetId 看着像相对路径 → 尝试拼到 cwd
   *   3. 都读不到 → throw invalid_request (不 silent return null)
   *
   * 旧版 index.jsonl 扫描留作 graceful fallback, 但找不到就 throw 让 caller 知道.
   */
  private async _loadReferenceImageBase64(assetId: string, ctx: ProviderContext): Promise<string | null> {
    // 1. 绝对路径 — v2 主流量
    if (path.isAbsolute(assetId)) {
      try {
        const buffer = await fs.readFile(assetId);
        return buffer.toString("base64");
      } catch (err: any) {
        throw new ProviderError({
          message: `Failed to read reference image at ${assetId}: ${err.message}`,
          code: "invalid_request",
          provider_id: this.id,
          retriable: false,
          original: err,
        });
      }
    }

    // 2. 相对路径 — 兼容性 fallback
    try {
      const cwdPath = path.resolve(process.cwd(), assetId);
      const buffer = await fs.readFile(cwdPath);
      return buffer.toString("base64");
    } catch {
      // 继续 fallback 到 index.jsonl
    }

    // 3. AssetStore index.jsonl — legacy v1 路径
    try {
      const dataDir = path.resolve(process.cwd(), "data");
      const assetsDir = path.join(dataDir, "series", ctx.series_slug, "assets");
      const indexPath = path.join(assetsDir, "index.jsonl");
      const content = await fs.readFile(indexPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const op = JSON.parse(trimmed);
          if (op.op === "add" && op.asset?.id === assetId && !op.asset?.deleted_at) {
            const filePath = path.join(assetsDir, op.asset.file_path);
            const buffer = await fs.readFile(filePath);
            return buffer.toString("base64");
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // index.jsonl 不存在 — v2 主流量这是常态, fall through 到 throw
    }

    // 4. 都找不到 — 不 silent return null (违反铁律 #3)
    throw new ProviderError({
      message: `Reference image not found: ${assetId}. v2 流量请传绝对文件路径; v1 走 series/${ctx.series_slug}/assets/index.jsonl`,
      code: "invalid_request",
      provider_id: this.id,
      retriable: false,
    });
  }

  /**
   * Clamp dimension to supported range [512, 2048], rounded to multiple of 8.
   */
  private _clampSize(val: number): number {
    let clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, val));
    // Round to nearest multiple of SIZE_MULTIPLE
    clamped = Math.round(clamped / SIZE_MULTIPLE) * SIZE_MULTIPLE;
    return clamped;
  }

  /**
   * Map an API response with error code to ProviderError.
   */
  private _mapApiError(resp: JimengApiResponse): ProviderError {
    const statusCode = resp.response_metadata?.status_code ?? resp.code;
    const errMsg = resp.message || resp.response_metadata?.error?.message || "Unknown API error";

    // Map Volcengine/即梦 error codes to ProviderError codes
    let code = codeFromHttpStatus(statusCode);
    let retriable = false;

    if (statusCode === 401 || statusCode === 403 || resp.code === 50403) {
      code = "missing_key";
    } else if (statusCode === 429 || resp.code === 50429) {
      code = "rate_limit";
      retriable = true;
    } else if (statusCode === 400 || resp.code === 50400) {
      code = "invalid_request";
    } else if (statusCode >= 500) {
      code = "server";
      retriable = true;
    }

    return new ProviderError({
      message: `Jimeng API error (${resp.code}): ${errMsg}`,
      code,
      provider_id: this.id,
      retriable,
    });
  }

  /**
   * Map a raw fetch/network error to ProviderError.
   */
  private _mapError(err: any): ProviderError {
    if (err instanceof ProviderError) return err;

    const msg = err.message ?? String(err);
    if (msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("timeout")) {
      return new ProviderError({
        message: `Jimeng network timeout: ${msg}`,
        code: "timeout",
        provider_id: this.id,
        retriable: true,
        original: err,
      });
    }

    return new ProviderError({
      message: `Jimeng unexpected error: ${msg}`,
      code: "server",
      provider_id: this.id,
      retriable: false,
      original: err,
    });
  }
}
