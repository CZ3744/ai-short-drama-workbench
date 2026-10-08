import fs from "node:fs/promises";
import type {
  CostInfo,
  GeneratedImage,
  ImageGenerateRequest,
  ProviderContext,
} from "../../../../../packages/providers/src/core/types";
export type { GeneratedImage } from "../../../../../packages/providers/src/core/types";
import type { ProviderRegistry } from "../../../../../packages/providers/src/core/registry";
import { providerIdFromModelRef, modelIdFromModelRef } from "./modelRef";
import { ProviderNotSelectedError } from "../../jobs/errors";
import { budgetGuard } from "../../../../../packages/providers/src/core/budgetGuard";
// X1-4 (A6-4): 图像侧付费 provider 判定 — 图像是权威门且无下游视频门兜底, 零单价付费图像 provider
// 在 budget=0 时必须靠这个 flag 才被冻结 (真旁路修复)。
import { isRealPaidImageProvider } from "../../../../../packages/providers/src/core/realPaidImageProviders";
// 2026-05-26 全局并发上限 — batch 启 5 集瞬间 25 个 ChatGPT 请求触发 429.
// 所有 image generation 调 provider 前都走这个信号量, 默认 max 3.
import { withImageGenPermit } from "../../jobs/imageGenSemaphore";
// B-P0-3 (2026-06-01): 共享 helper (去重 imageGenerationService / videoGenerationService 5 个完整重复函数)
import {
  makeProviderContext as _makeProviderContext,
  resolveReferenceImages as _resolveReferenceImages,
  writeTempReference as _writeTempReference,
} from "./shared/resolveRef";

export { providerIdFromModelRef, modelIdFromModelRef } from "./modelRef";

export interface ImageInputRef {
  asset_id?: string;
  vault_id?: string;
  path?: string;
  data_url?: string;
  base64?: string;
  mime?: string;
  weight?: number;
}

export interface GenerateImagesInput {
  provider_id?: string;
  /**
   * Full ModelPicker model_ref, e.g. "chatgpt_codex_image:gpt-image-2".
   * Service splits this into provider id (selects instance) and model id
   * (passed to adapter as request.model_id, overriding cfg.model_id).
   */
  model_ref?: string;
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  count?: number;
  seed?: number;
  reference_images?: ImageInputRef[];
  series_slug?: string;
  job_id?: string;
  task_id?: string;
  timeout_ms?: number;
  strict_reference_images?: boolean;
  extras?: Record<string, unknown>;
  /**
   * 2026-05-21 V-5: 估算成本(CNY),给 budgetGuard 做 preflight。
   * 若传入则 service 在调 provider 前先 budgetGuard.preflight(thisCost, job_id, providerId)。
   * 不传 = 跳过 preflight(对应直接 raw 调用 + 信任 caller / 兜底场景)。
   * recordCharge 仍由 service 在拿到 result.cost 后自动调用,确保日预算统计完整。
   */
  estimated_cost_cny?: number;
  /**
   * 2026-05-21 V-5: orchestrator / retryJob 这些路径自己已经在 caller 调 recordCharge,
   * 传 true 关掉 service 内部 recordCharge,避免双重计费。
   * 其他 caller(library / vault / imageController / characterController 等)不传 → service 自动 record。
   */
  skip_budget_record?: boolean;
  /**
   * 2026-05-16 渐进式落盘 — 每完成一张图后立即触发的回调.
   * 透传给 provider.generate() 的 ImageGenerateRequest.on_image_ready.
   * 详见 packages/providers/src/core/types.ts 接口注释.
   */
  on_image_ready?: (image: GeneratedImage, index: number, total: number) => Promise<void>;
}

export interface GenerateImagesResult {
  provider_id: string;
  images: GeneratedImage[];
  cost?: CostInfo;
}

export async function generateImagesWithProvider(
  input: GenerateImagesInput,
  deps: {
    registry: ProviderRegistry;
    ctx?: ProviderContext;
    default_provider_id?: string;
    log?: ProviderContext["log"];
  },
): Promise<GenerateImagesResult> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt 不能为空");

  // W7 (2026-05-16): 删 silent fallback 到 local_card_image — 红线 #1。
  // deps.default_provider_id 保留给 orchestrator 路径用(orchestrator 自己已经校验过
  // override / shot.image_model_ref / series.defaults),raw API 在 controller 层断了。
  // 三层都空 → throw,由 route next(err) 转 HTTP 400。
  const providerId = providerIdFromModelRef(input.provider_id)
    ?? providerIdFromModelRef(input.model_ref)
    ?? deps.default_provider_id;
  if (!providerId) throw new ProviderNotSelectedError("generate_first_frames");

  // B5: Extract model id (colon-suffix) so the adapter can override its default
  // cfg.model_id. Prefer model_ref's suffix; fall back to provider_id's suffix
  // if caller mistakenly passed a full ref there.
  const modelIdOverride = modelIdFromModelRef(input.model_ref)
    ?? modelIdFromModelRef(input.provider_id);

  const tempPaths: string[] = [];
  const seriesSlug = input.series_slug ?? deps.ctx?.series_slug ?? "adhoc";

  const ctx = deps.ctx ?? makeProviderContext({
    series_slug: seriesSlug,
    job_id: input.job_id,
    task_id: input.task_id,
    timeout_ms: input.timeout_ms,
    log: deps.log,
  });

  try {
    const referenceImages = await resolveReferenceImages({
      refs: input.reference_images ?? [],
      series_slug: seriesSlug,
      temp_paths: tempPaths,
      strict: input.strict_reference_images !== false,
      log: ctx.log,
    });

    const request: ImageGenerateRequest = {
      prompt,
      negative_prompt: input.negative_prompt,
      width: clampDimension(input.width, 1024),
      height: clampDimension(input.height, 1024),
      count: Math.max(1, Math.min(Math.round(input.count ?? 1), 16)),
      seed: input.seed,
      reference_images: referenceImages.length > 0 ? referenceImages : undefined,
      extras: input.extras,
      // B5: pass colon-suffix model id so adapter can override cfg.model_id.
      model_id: modelIdOverride,
      // 2026-05-16 渐进式落盘 — 透传 caller 提供的 on_image_ready,
      // 让 provider 在每张图完成时 await 它(caller 在 orchestrator/adapter 里写盘 + 推 SSE).
      on_image_ready: input.on_image_ready,
    };

    const provider = deps.registry.getImage(providerId);

    // 2026-05-21 V-5: budgetGuard preflight — 调 provider 前先看日预算是否超
    // (caller 传了 estimated_cost_cny 才执行。raw API 路径 / orchestrator 已自己 preflight 的路径不传 → 跳过)。
    // X1-4 (A6-4): 真实付费图像 provider 即使估算成本为 0 (零单价 preset) 也要 preflight — 否则用户把
    // 日预算显式设为 ¥0 想冻结时, estimate=0 会跳过 preflight 直接放行扣费 (图像无下游视频门兜底 = 真旁路)。
    // 与 videoGenerationService 相同的 flag 语义。
    const realPaidProvider = isRealPaidImageProvider(providerId);
    const estCost = typeof input.estimated_cost_cny === "number" && input.estimated_cost_cny > 0
      ? input.estimated_cost_cny
      : 0;
    if (estCost > 0 || realPaidProvider) {
      budgetGuard.preflight(estCost, input.job_id ?? "direct", providerId, { realPaidProvider });
    }

    // 2026-05-26 全局并发上限: 等到有 permit 再调 provider — 防止瞬时多请求触 429.
    const result = await withImageGenPermit(() => provider.generate(request, ctx));

    // 2026-05-21 V-5: budgetGuard recordCharge — 所有路径产生的真实成本都计入日预算统计
    // (library variants / vault inpaint / imageController raw / characterController 等 caller 自动覆盖)。
    // orchestrator / retryJob 自己已 recordCharge → 传 skip_budget_record:true 关掉避免双重计费。
    if (!input.skip_budget_record && result.cost && result.cost.amount > 0) {
      try {
        const currency = result.cost.currency === "USD" ? "USD" : "CNY";
        budgetGuard.recordCharge(result.cost.amount, input.job_id, providerId, currency);
      } catch (err) {
        ctx.log?.("warn", `[imageService] budgetGuard.recordCharge failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      provider_id: providerId,
      images: result.images,
      cost: result.cost,
    };
  } finally {
    await Promise.all(tempPaths.map((p) => fs.unlink(p).catch(() => undefined)));
  }
}

// B-P0-3: thin wrapper — 固定 taskIdPrefix "image_", 其余参数透传
function makeProviderContext(args: {
  series_slug: string;
  job_id?: string;
  task_id?: string;
  timeout_ms?: number;
  log?: ProviderContext["log"];
  signal?: AbortSignal;
}): ProviderContext {
  return _makeProviderContext({ ...args, taskIdPrefix: "image_" });
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(256, Math.min(Math.round(value), 4096));
}

// B-P0-3: thin wrapper — 固定 image-generation 专用参数
async function resolveReferenceImages(args: {
  refs: ImageInputRef[];
  series_slug: string;
  temp_paths: string[];
  strict: boolean;
  log: ProviderContext["log"];
}): Promise<Array<{ asset_id: string; weight?: number }>> {
  return _resolveReferenceImages({
    ...args,
    logLabel: "[image-generation]",
    tmpDirName: "image-generation-inputs",
    errLabel: "参考图",
    extraExts: undefined,
  });
}

// B-P0-3: writeTempReference thin wrapper (image 版, 无 extraExts)
async function writeTempReference(raw: string, mime: string | undefined, tempPaths: string[]): Promise<string> {
  return _writeTempReference({ raw, mime, tempPaths, tmpDirName: "image-generation-inputs" });
}
