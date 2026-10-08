/**
 * Unified video generation service (W7-decouple, 2026-05-15).
 *
 * 对齐 `imageGenerationService.ts` 设计 — 任何"接收提示词输入,调用视频 provider
 * 拉取结果"的业务路径必须走这里,**不允许**直接调 `registry.getVideo(id).generate(...)`。
 *
 * 责任划分:
 *   - 本 service:provider 选择、model_ref 拆分、reference 图解析、ProviderContext
 *     生成、调 `provider.generate(req, ctx)`、返回 buffer + cost。
 *   - 调用方:写 vault、更新实体(shot/character/element)、发 SSE、ffprobe 校验等
 *     业务后处理。
 *
 * 这样图像/视频生成两条路径完全对称(`generateImagesWithProvider` /
 * `generateVideoWithProvider`),保证铁律#4(就近决策) + 解耦信仰(模块只通过
 * 数据交接)。
 */

import fs from "node:fs/promises";
import type {
  CostInfo,
  GeneratedVideo,
  ProviderContext,
  VideoGenerateRequest,
} from "../../../../../packages/providers/src/core/types";
import type { ProviderRegistry } from "../../../../../packages/providers/src/core/registry";
import { providerIdFromModelRef, modelIdFromModelRef } from "./modelRef";
import { ProviderNotSelectedError } from "../../jobs/errors";
import { budgetGuard } from "../../../../../packages/providers/src/core/budgetGuard";
import { isRealVideoProvider } from "../../../../../packages/core/src/realVideoLock";
import {
  getVideoModelInstance,
  type VideoChannelId,
  type VideoModelInstance,
} from "../../../../../packages/core/src/videoModelInstances";
// B-P0-3 (2026-06-01): 共享 helper (去重 imageGenerationService / videoGenerationService 5 个完整重复函数)
import {
  makeProviderContext as _makeProviderContext,
  resolveReferenceImages as _resolveReferenceImages,
  writeTempReference as _writeTempReference,
  resolveSingleRef,
  VIDEO_EXTRA_EXTS,
} from "./shared/resolveRef";

export { providerIdFromModelRef, modelIdFromModelRef } from "./modelRef";

// ─── Input / Output ─────────────────────────────────────────────────

export interface VideoInputRef {
  asset_id?: string;
  vault_id?: string;
  path?: string;
  data_url?: string;
  base64?: string;
  mime?: string;
  weight?: number;
}

export type VideoAspectRatio = VideoGenerateRequest["aspect_ratio"];

export interface GenerateVideoInput {
  provider_id?: string;
  /**
   * Full ModelPicker model_ref, e.g. "kling_3:kling-v1.6".
   * Service splits this into provider id (selects instance) and model id
   * (passed to adapter as request.model_id, overriding cfg.model_id).
   */
  model_ref?: string;
  prompt: string;
  negative_prompt?: string;
  duration_sec?: number;
  aspect_ratio?: VideoAspectRatio;
  seed?: number;
  /** First-frame for i2v providers. Can be an asset id, vault id, or absolute path. */
  first_frame?: VideoInputRef;
  /** 2026-05-21 X-1: 尾帧 ref,支持 i2v 首尾连贯的 provider 用 (kling/jimeng/vidu) */
  last_frame?: VideoInputRef;
  reference_images?: VideoInputRef[];
  series_slug?: string;
  job_id?: string;
  task_id?: string;
  timeout_ms?: number;
  /** Throw if a referenced asset cannot be resolved. Defaults true. */
  strict_reference_images?: boolean;
  extras?: Record<string, unknown>;
  /**
   * 2026-05-21 V-5: 估算成本(CNY),给 budgetGuard 做 preflight。
   * 若传入则 service 在调 provider 前先 budgetGuard.preflight(thisCost, job_id, providerId)。
   * 不传 = 跳过 preflight(orchestrator 已自己 preflight / raw 路径兜底)。
   * recordCharge 仍由 service 在拿到 result.cost 后自动调用。
   */
  estimated_cost_cny?: number;
  /**
   * 2026-05-21 V-5: orchestrator 这些路径自己已经在 caller 调 recordCharge,
   * 传 true 关掉 service 内部 recordCharge,避免双重计费。
   * 其他 caller(clipRoutes / videoController / vault remix-video 等)不传 → service 自动 record。
   */
  skip_budget_record?: boolean;
}

export interface GenerateVideoResult {
  provider_id: string;
  video: GeneratedVideo;
  cost?: CostInfo;
}

// ─── Main entry ─────────────────────────────────────────────────────

export async function generateVideoWithProvider(
  input: GenerateVideoInput,
  deps: {
    registry: ProviderRegistry;
    ctx?: ProviderContext;
    default_provider_id?: string;
    log?: ProviderContext["log"];
  },
): Promise<GenerateVideoResult> {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error("prompt 不能为空");

  // W7 (2026-05-16): 删 silent fallback 到 local_mock_video — 红线 #1。
  // deps.default_provider_id 保留给 orchestrator 路径用,raw API 在 controller 层断了。
  // 三层都空 → throw,由 route next(err) 转 HTTP 400。
  const rawProviderId = providerIdFromModelRef(input.provider_id)
    ?? providerIdFromModelRef(input.model_ref)
    ?? deps.default_provider_id;
  if (!rawProviderId) throw new ProviderNotSelectedError("generate_videos");

  // 2026-05-18: "instance:<vmi_xxx>[:<model_override>]" 二级架构.
  // ModelPicker buildModelRef 把 instance.id ("instance:<vmi>") + model.id 拼成 3 段 colon,
  // 第 1 段 "instance" 是路由标记, 第 2 段是 vmi_id, 第 3 段是可选模型 ID 覆盖.
  //
  // 2026-05-27 改 — 之前条件 `rawProviderId === "instance"` 失效场景:
  //   caller (orchestrator) 已经把 "instance:" 前缀 unwrap 成真 provider_id
  //   ("zhipu_cogvideox"), 但 model_ref 仍是 "instance:vmi_xxx:cogvideox-3".
  //   service 拿 provider_id=zhipu_cogvideox 看不到 "instance" 字面 → 不走 resolve
  //   instance 分支 → resolvedInstance=null → instance.api_key 没注入 provider →
  //   报 "Zhipu API key not configured (实例未填 api_key 也无 env fallback)".
  //
  // 修: 看 model_ref 是不是以 "instance:" 开头, 是就强制走 instance resolve, 不论
  // rawProviderId 是什么. 这样 caller 提前 unwrap 也 OK, 不 unwrap 也 OK.
  let providerId = rawProviderId;
  let resolvedInstance: VideoModelInstance | null = null;
  let modelIdOverride = modelIdFromModelRef(input.model_ref)
    ?? modelIdFromModelRef(input.provider_id);

  const modelRefStr = typeof input.model_ref === "string" ? input.model_ref : "";
  const isInstanceRef = rawProviderId === "instance" || modelRefStr.startsWith("instance:");

  if (isInstanceRef) {
    // model_ref 是 "instance:vmi_xxx:cogvideox-3". 取 vmi_id (第 2 段).
    let instanceId = "";
    let modelOverrideTail = "";
    if (modelRefStr.startsWith("instance:")) {
      const afterPrefix = modelRefStr.slice("instance:".length);
      const colonIdx = afterPrefix.indexOf(":");
      instanceId = colonIdx >= 0 ? afterPrefix.slice(0, colonIdx) : afterPrefix;
      modelOverrideTail = colonIdx >= 0 ? afterPrefix.slice(colonIdx + 1).trim() : "";
    } else {
      // 老路径: rawProviderId === "instance", vmi_id 在 modelIdOverride 里
      const rest = modelIdOverride ?? "";
      if (!rest) throw new Error("model_ref \"instance:<id>\" 缺少 instance id");
      const colonIdx = rest.indexOf(":");
      instanceId = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
      modelOverrideTail = colonIdx >= 0 ? rest.slice(colonIdx + 1).trim() : "";
    }
    if (!instanceId) {
      throw new Error("model_ref \"instance:<id>\" 缺少 instance id");
    }
    const instance = getVideoModelInstance(instanceId);
    if (!instance) {
      throw new Error(`视频模型实例 ${instanceId} 不存在或已被删除`);
    }
    resolvedInstance = instance;
    providerId = mapChannelToProviderId(instance.channel);
    // 优先用 ModelPicker 传入的 trailing model override; 没有就用实例自带 model_id.
    modelIdOverride = modelOverrideTail || instance.model_id;
  }

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
    const isStrict = input.strict_reference_images !== false;

    // 1. Resolve first_frame (if any) — single ref, may be asset_id / vault_id / path / data_url.
    let firstFrame: VideoGenerateRequest["first_frame"];
    if (input.first_frame) {
      try {
        const resolved = await resolveSingleRef({
          ref: input.first_frame,
          series_slug: seriesSlug,
          temp_paths: tempPaths,
          tmpDirName: "video-generation-inputs",
          errLabel: "参考资源",
          extraExts: VIDEO_EXTRA_EXTS,
        });
        if (resolved) firstFrame = { asset_id: resolved };
      } catch (e) {
        if (isStrict) throw e;
        ctx.log("warn", `[video-generation] skip first_frame: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 2026-05-21 X-1: resolve last_frame (尾帧) — 同款逻辑, asset_id/vault_id/path/data_url 五选一.
    let lastFrame: VideoGenerateRequest["last_frame"];
    if (input.last_frame) {
      try {
        const resolved = await resolveSingleRef({
          ref: input.last_frame,
          series_slug: seriesSlug,
          temp_paths: tempPaths,
          tmpDirName: "video-generation-inputs",
          errLabel: "参考资源",
          extraExts: VIDEO_EXTRA_EXTS,
        });
        if (resolved) lastFrame = { asset_id: resolved };
      } catch (e) {
        if (isStrict) throw e;
        ctx.log("warn", `[video-generation] skip last_frame: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 2. Resolve reference_images (optional, multi-ref for ref2v providers).
    const referenceImages = await resolveReferenceImages({
      refs: input.reference_images ?? [],
      series_slug: seriesSlug,
      temp_paths: tempPaths,
      strict: input.strict_reference_images !== false,
      log: ctx.log,
    });

    const aspect: VideoAspectRatio = input.aspect_ratio ?? "16:9";
    const duration = Math.max(1, Math.min(Math.round(input.duration_sec ?? 5), 120));

    const request: VideoGenerateRequest = {
      prompt,
      first_frame: firstFrame,
      last_frame: lastFrame,
      reference_images: referenceImages.length > 0 ? referenceImages : undefined,
      duration_sec: duration,
      aspect_ratio: aspect,
      seed: input.seed,
      extras: {
        ...(input.extras ?? {}),
        ...(input.negative_prompt ? { negative_prompt: input.negative_prompt } : {}),
      },
      model_id: modelIdOverride,
      // 2026-05-18: instance 模式下注入 override, 让 provider 用实例 key 而不是 env fallback
      instance_override: resolvedInstance ? {
        api_key: resolvedInstance.api_key,
        secret_key: resolvedInstance.secret_key,
        api_base_url: resolvedInstance.api_base_url,
        region: resolvedInstance.region,
      } : undefined,
    };

    const provider = deps.registry.getVideo(providerId);

    // 2026-05-21 V-5: budgetGuard preflight — 调 provider 前先看日预算是否超
    // (caller 传了 estimated_cost_cny 才执行;orchestrator 已自己 preflight 不传 → 跳过)
    // 2026-07-10 audit: 真实付费 provider 即使估算成本为 0 (如即梦 preset 单价=0) 也要 preflight —
    // 否则用户把日预算显式设为 0 想冻结时, estimate=0 会跳过 preflight 直接放行扣费 (见 budgetGuard 冻结拦截).
    const realPaidProvider = isRealVideoProvider(providerId);
    const estCost = typeof input.estimated_cost_cny === "number" && input.estimated_cost_cny > 0
      ? input.estimated_cost_cny
      : 0;
    if (estCost > 0 || realPaidProvider) {
      budgetGuard.preflight(estCost, input.job_id ?? "direct", providerId, { realPaidProvider });
    }

    const result = await provider.generate(request, ctx);

    // 2026-05-21 V-5: budgetGuard recordCharge — 所有路径产生的真实成本都计入日预算统计
    // (clipRoutes / videoController / vault remix-video 等 caller 自动覆盖)
    // orchestrator 自己已 recordCharge → 传 skip_budget_record:true 关掉避免双重计费。
    if (!input.skip_budget_record && result.cost && result.cost.amount > 0) {
      try {
        const currency = result.cost.currency === "USD" ? "USD" : "CNY";
        budgetGuard.recordCharge(result.cost.amount, input.job_id, providerId, currency);
      } catch (err) {
        ctx.log?.("warn", `[videoService] budgetGuard.recordCharge failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      provider_id: providerId,
      video: result.video,
      cost: result.cost,
    };
  } finally {
    await Promise.all(tempPaths.map((p) => fs.unlink(p).catch(() => undefined)));
  }
}

// ─── Helpers (parallel to imageGenerationService) ───────────────────
// B-P0-3: 以下 5 个函数已移至 shared/resolveRef.ts, 这里是 thin wrapper 调用共享版。

// thin wrapper — 固定 taskIdPrefix "video_"
function makeProviderContext(args: {
  series_slug: string;
  job_id?: string;
  task_id?: string;
  timeout_ms?: number;
  log?: ProviderContext["log"];
  signal?: AbortSignal;
}): ProviderContext {
  return _makeProviderContext({ ...args, taskIdPrefix: "video_" });
}

// thin wrapper — 固定 video-generation 专用参数(包含 mp4 扩展名)
async function resolveReferenceImages(args: {
  refs: VideoInputRef[];
  series_slug: string;
  temp_paths: string[];
  strict: boolean;
  log: ProviderContext["log"];
}): Promise<Array<{ asset_id: string; weight?: number }>> {
  return _resolveReferenceImages({
    ...args,
    logLabel: "[video-generation]",
    tmpDirName: "video-generation-inputs",
    errLabel: "参考资源",
    extraExts: VIDEO_EXTRA_EXTS,
  });
}

// thin wrapper — 固定 video-generation-inputs 目录 + mp4 扩展名
async function writeTempReference(raw: string, mime: string | undefined, tempPaths: string[]): Promise<string> {
  return _writeTempReference({ raw, mime, tempPaths, tmpDirName: "video-generation-inputs", extraExts: VIDEO_EXTRA_EXTS });
}

/**
 * 2026-05-18: VideoChannel → registered provider id 映射.
 * 5 个真实 channel 全部走对应 wrapper (registry 里 register 时用的 id),
 * 实例的 api_key/model_id/base_url 通过 request.instance_override 注入,
 * provider 实现内优先用 override.
 *
 * 不再有"老占位 model 名"问题 — 实例选什么 model_id 直接发什么.
 */
// 2026-05-27 export — modelRef.ts videoProviderIdFromModelRef 复用
export function mapChannelToProviderId(channel: VideoChannelId): string {
  switch (channel) {
    case "kling": return "kling_3";
    case "vidu": return "vidu_q3_ref";
    case "jimeng": return "jimeng_video_3pro";
    case "minimax": return "minimax_hailuo";
    case "aliyun_wan": return "aliyun_wan_t2v";
    // 2026-05-20 Wave T S25 — 3 个 builtin 升 instance 架构
    case "zhipu": return "zhipu_cogvideox";
    case "baidu_qianfan": return "baidu_qianfan_video";
    case "tencent_hunyuan": return "tencent_hunyuan_video";
  }
}
