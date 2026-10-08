/** @deprecated Use image/localCardImageProvider.ts with core/types ImageProvider interface instead */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, pathExists, getConfigValue, type JobLogger } from "../../core/src/index";

export type ImageProviderName = "local_card_image" | "future_gpt_image_2" | "future_flux" | "future_wanx" | "future_hunyuan_image";

export interface ImageJobInput {
  sceneStableId: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  resolution?: string;
  style?: string;
  assetPath?: string;
  jobRoot?: string;
  outputPath?: string;
}

export interface ImageJobResult {
  ok: boolean;
  providerJobId?: string;
  imagePath?: string;
  width?: number;
  height?: number;
  error?: string;
  error_type?: string;
}

export interface ImageJobStatus {
  status: "queued" | "running" | "completed" | "failed";
  imagePath?: string;
  width?: number;
  height?: number;
  error?: string;
  error_type?: string;
}

export interface ImageCostEstimate {
  estimated_credits: number;
  estimated_usd: number;
  currency: string;
  notes: string;
}

export interface ImageProvider {
  id: string;
  label: string;
  submitTextToImage(input: ImageJobInput): Promise<ImageJobResult>;
  getJobStatus?(providerJobId: string): Promise<ImageJobStatus>;
  downloadImage?(providerJobId: string, outputPath: string): Promise<string>;
  estimateCost?(input: ImageJobInput): Promise<ImageCostEstimate>;
}

// --- LocalCardImageProvider: registers existing scene asset as image_version ---

export class LocalCardImageProvider implements ImageProvider {
  id = "local_card_image";
  label = "Local Card Image (本地卡片)";

  async submitTextToImage(input: ImageJobInput): Promise<ImageJobResult> {
    if (!input.assetPath) {
      return { ok: false, error: "No asset path provided for local_card_image", error_type: "missing_asset" };
    }

    const resolvedPath = path.isAbsolute(input.assetPath)
      ? input.assetPath
      : input.jobRoot
        ? path.join(input.jobRoot, input.assetPath)
        : input.assetPath;

    if (!(await pathExists(resolvedPath))) {
      return { ok: false, error: `Asset file not found: ${resolvedPath}`, error_type: "file_not_found" };
    }

    // Copy to image output if outputPath specified, otherwise reference original
    let outputPath = resolvedPath;
    if (input.outputPath) {
      await ensureDir(path.dirname(input.outputPath));
      await fs.copyFile(resolvedPath, input.outputPath);
      outputPath = input.outputPath;
    }

    const providerJobId = `local_card_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    return {
      ok: true,
      providerJobId,
      imagePath: outputPath
    };
  }

  async getJobStatus(providerJobId: string): Promise<ImageJobStatus> {
    return { status: "completed" };
  }

  async estimateCost(input: ImageJobInput): Promise<ImageCostEstimate> {
    return {
      estimated_credits: 0,
      estimated_usd: 0,
      currency: "free",
      notes: "Local card image, no cost"
    };
  }
}

// --- Skeleton providers for future real APIs ---

abstract class FutureImageProviderBase implements ImageProvider {
  abstract id: string;
  abstract label: string;

  async submitTextToImage(input: ImageJobInput): Promise<ImageJobResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return { ok: false, error: `${this.id} API key not configured`, error_type: "key_missing" };
    }
    return { ok: false, error: `${this.label} not yet implemented`, error_type: "not_implemented" };
  }

  async getJobStatus(providerJobId: string): Promise<ImageJobStatus> {
    return { status: "failed", error: "Not implemented", error_type: "not_implemented" };
  }

  async estimateCost(input: ImageJobInput): Promise<ImageCostEstimate> {
    return {
      estimated_credits: -1,
      estimated_usd: -1,
      currency: "unknown",
      notes: `${this.label} pricing not yet configured`
    };
  }

  protected abstract getApiKey(): string | undefined;
}

export class FutureGptImage2Provider extends FutureImageProviderBase {
  id = "future_gpt_image_2";
  label = "GPT Image 2 (待接入真实 API)";
  protected getApiKey(): string | undefined {
    return getConfigValue("IMAGE_API_KEY") || process.env.IMAGE_API_KEY;
  }
}

export class FutureFluxProvider extends FutureImageProviderBase {
  id = "future_flux";
  label = "FLUX (待接入真实 API)";
  protected getApiKey(): string | undefined {
    return getConfigValue("FLUX_API_KEY") || process.env.FLUX_API_KEY;
  }
}

export class FutureWanxProvider extends FutureImageProviderBase {
  id = "future_wanx";
  label = "通义万相 (待接入真实 API)";
  protected getApiKey(): string | undefined {
    return getConfigValue("WANX_API_KEY") || process.env.WANX_API_KEY;
  }
}

export class FutureHunyuanImageProvider extends FutureImageProviderBase {
  id = "future_hunyuan_image";
  label = "混元图像 (待接入真实 API)";
  protected getApiKey(): string | undefined {
    return getConfigValue("HUNYUAN_IMAGE_API_KEY") || process.env.HUNYUAN_IMAGE_API_KEY;
  }
}

// --- Provider factory ---

export function createImageProvider(providerId: string): ImageProvider {
  switch (providerId) {
    case "local_card_image":
      return new LocalCardImageProvider();
    case "future_gpt_image_2":
      return new FutureGptImage2Provider();
    case "future_flux":
      return new FutureFluxProvider();
    case "future_wanx":
      return new FutureWanxProvider();
    case "future_hunyuan_image":
      return new FutureHunyuanImageProvider();
    default:
      throw new Error(`Unknown image provider: ${providerId}`);
  }
}

export function listImageProviders(): Array<{ id: string; label: string; isLocal: boolean; requiresKey: boolean }> {
  return [
    { id: "local_card_image", label: "Local Card Image (本地卡片)", isLocal: true, requiresKey: false },
    { id: "future_gpt_image_2", label: "GPT Image 2 (待接入真实 API)", isLocal: false, requiresKey: true },
    { id: "future_flux", label: "FLUX (待接入真实 API)", isLocal: false, requiresKey: true },
    { id: "future_wanx", label: "通义万相 (待接入真实 API)", isLocal: false, requiresKey: true },
    { id: "future_hunyuan_image", label: "混元图像 (待接入真实 API)", isLocal: false, requiresKey: true }
  ];
}
