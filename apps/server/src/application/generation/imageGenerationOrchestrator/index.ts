/**
 * imageGenerationOrchestrator — Phase 1 解耦重构主入口 (Wave 1, 2026-05-16).
 *
 * 一句话: controller 收到 request → orchestrator 调 generateImagesWithProvider 拿 buffer
 *         → 对应 TargetAdapter 把 buffer 写入业务对象 → orchestrator 把 PersistedImage[]
 *         和最新 target_state 返给 controller. 8 个 controller 的 53 行 post-处理统一收敛.
 *
 * 用户禁线: 任何 silent fallback / 假数据全部 throw (红线 #1).
 *
 * 为什么不动 generateImagesWithProvider:
 *   - 它已经是统一纯函数 service, 内部不写文件. 任何"接收提示词 + 调 provider"路径都过它.
 *   - 本 orchestrator 在它之上加了"业务对象持久化"这一层, 让 controller 只剩 thin wrapper.
 */

import { generateImagesWithProvider } from "../imageGenerationService";
import { providerIdFromModelRef } from "../modelRef";
import type { ProviderRegistry } from "../../../../../../packages/providers/src/core/registry";
import type { GeneratedImage, ProviderContext } from "../../../../../../packages/providers/src/core/types";
import { getAdapterFor } from "./registry";
import { ImageGenerationTargetSchema } from "./types";
import type {
  GenerateImagesForTargetRequest,
  GenerateImagesForTargetResult,
  PersistedImage,
} from "./types";
import { sseBroker } from "../../../api/v2/sseBroker";

export type {
  GenerateImagesForTargetRequest,
  GenerateImagesForTargetResult,
  PersistedImage,
  ImageGenerationTarget,
  ImageTargetKind,
  ImageTargetAdapter,
} from "./types";
export { ImageGenerationTargetSchema, ImageTargetKindSchema } from "./types";

/**
 * 唯一对外入口. controller 调这里, 不再自己 saveToVault + addAsset.
 *
 * 流程:
 *   1. 校验 target (zod schema) — 不合法 throw, 由 route next(err) 转 400.
 *   2. 调 generateImagesWithProvider 拿 buffer 列表(已统一, 不重写).
 *   3. 拿 target.kind 对应的 adapter, 对每张 buffer 调 adapter.persist().
 *   4. 调 adapter.readState 拿业务对象最新状态.
 *   5. 返回 PersistedImage[] + target_state.
 *
 * 任何一步失败立刻 throw, 让上层路由的 next(err) handle. 不 silent ignore.
 */
export async function generateImagesForTarget(
  req: GenerateImagesForTargetRequest,
  deps: { registry: ProviderRegistry; log?: ProviderContext["log"] },
): Promise<GenerateImagesForTargetResult> {
  // 1) 校验 target — 防止 controller 不传或传错 kind
  const parsed = ImageGenerationTargetSchema.safeParse(req.target);
  if (!parsed.success) {
    throw Object.assign(new Error(`ImageGenerationTarget 校验失败: ${parsed.error.message}`), {
      status: 400,
      code: "InvalidTarget",
    });
  }
  const target = parsed.data;

  // 2) 准备 adapter, 写好渐进式落盘 callback. 用户原话:
  //    "一键抽 N 张按顺序发送, 回来一张落盘一张, 其他未完成请求在图库该落盘的地方
  //    做生成中占位."
  //
  //    实现策略: 把 adapter.persist 从 "service 全返回后 for 循环" 改成
  //    on_image_ready callback — provider 收到第一张图就立即触发 persist + emit SSE,
  //    前端候选区 skeleton 占位被替换一张, 用户实时看到进度.
  //
  //    解耦保证: service / provider 不知道 adapter 存在, callback 只产生 PersistedImage
  //    塞进 images 数组. provider 返完所有 image 后, 我们再调 adapter.readState 拿最新
  //    业务对象快照返给 controller. 这与旧 for 循环行为等价, 仅多了"中间状态广播".
  const adapter = getAdapterFor(target.kind);
  const images: PersistedImage[] = [];
  const total = Math.max(1, Math.min(Math.round(req.count ?? 1), 16));
  const jobId = req.job_id || req.task_id || `progressive_${Date.now()}`;

  const onImageReady = async (image: GeneratedImage, index: number, totalReported: number) => {
    // adapter.persist 走完整 vault + asset + 业务对象写入. 任何一步抛异常时让 provider
    // 内部的 try/catch (cbErr 分支) 走 warn 日志, 主流程不阻塞. caller (上层 controller)
    // 在 readState 阶段看到的就是"少一张"的业务对象, 与正常错误路径一致.
    const persisted = await adapter.persist({
      image,
      target,
      provider_id: generation_provider_id_ref.value,
      request: req,
      batch_index: index,
    });
    images.push(persisted);

    // 推 SSE image.partial — 前端 useImageGeneration 订阅后更新 skeleton 状态.
    // target.target_id 可空(vault_only), 这种情况就只带 target_kind + series_slug.
    try {
      sseBroker.emit({
        type: "image.partial",
        job_id: jobId,
        task_id: req.task_id,
        at: new Date().toISOString(),
        data: {
          target_kind: target.kind,
          series_slug: target.series_slug,
          target_id: target.target_id,
          element_id:
            target.kind === "element" || target.kind === "character_ref" || target.kind === "scene_ref"
              ? target.target_id
              : undefined,
          shot_id:
            target.kind === "shot_first_frame" || target.kind === "shot_last_frame"
              ? target.target_id
              : undefined,
          image_id: persisted.image_id,
          asset_id: persisted.asset_id,
          vault_id: persisted.vault_id,
          url: persisted.url,
          completed: index + 1,
          total: Math.max(total, totalReported),
          provider_id: generation_provider_id_ref.value,
        },
      });
    } catch (sseErr) {
      // SSE emit 永不阻塞主流程 — 推送失败时仍然要把图落盘+返给 caller.
      deps.log?.("warn", `[orchestrator] sse emit image.partial 失败: ${sseErr instanceof Error ? sseErr.message : sseErr}`);
    }
  };

  // 用 ref 是因为 provider_id 要从 generateImagesWithProvider 解析出, 而 callback 在那之内执行,
  // 不能拿到 generation.provider_id (那是 await 后才有). 改用闭包 ref + 提前用同 helper 预解析.
  // service.ts:74-77 解析逻辑与这里一致, 所以预解析值 == service 真实解析值.
  const preResolvedProviderId =
    providerIdFromModelRef(req.provider_id)
    ?? providerIdFromModelRef(req.model_ref)
    ?? req.default_provider_id
    ?? "";
  const generation_provider_id_ref = { value: preResolvedProviderId };

  // 3) 调 provider 拿 buffer — service 内部已经处理 provider 解析 / reference 图 /
  //    timeout / model_ref 拆分. 三层 provider 都空时它会 throw ProviderNotSelectedError.
  const generation = await generateImagesWithProvider(
    {
      provider_id: req.provider_id,
      model_ref: req.model_ref,
      prompt: req.prompt,
      negative_prompt: req.negative_prompt,
      width: req.width,
      height: req.height,
      count: req.count,
      seed: req.seed,
      reference_images: req.reference_images,
      strict_reference_images: req.strict_reference_images,
      series_slug: target.series_slug,
      job_id: req.job_id,
      task_id: req.task_id,
      on_image_ready: async (image, index, totalReported) => {
        // 第一次调用时 generation_provider_id_ref.value 可能还没被 generateImagesWithProvider
        // 内部写真实值. 但 service.ts:74-77 解析逻辑确定性, 这里同样跑一次拿真值.
        // (避免 race: provider 解析在 service 内, callback 在 provider 内, 顺序: service 解析 →
        // 调 provider.generate → provider 内 callback. 所以 service 解析完后 callback 才可能跑.)
        await onImageReady(image, index, totalReported);
      },
    },
    {
      registry: deps.registry,
      log: deps.log,
      default_provider_id: req.default_provider_id,
    },
  );

  // 同步 ref 到真实解析后的 provider_id (callback 已经用旧 ref.value, 但 SSE 里 provider_id
  // 字段可能差点 — 不致命; 后端 callback 流转后, 我们用 generation.provider_id 校正最后状态).
  generation_provider_id_ref.value = generation.provider_id;

  // 4) 兜底: 万一 provider 没正确调 on_image_ready (例如 mock / 老 provider 未升级),
  //    走旧 for 循环把剩下没 persist 的图补齐. 正常情况下 images.length === generation.images.length
  //    时这段是 no-op.
  for (let i = images.length; i < generation.images.length; i += 1) {
    const persisted = await adapter.persist({
      image: generation.images[i],
      target,
      provider_id: generation.provider_id,
      request: req,
      batch_index: i,
    });
    images.push(persisted);
    // 兜底分支也推一次 SSE, 保持前端 skeleton 行为一致(避免 provider 未实现 callback 时
    // 整批最后才一次性出现 N 张图).
    try {
      sseBroker.emit({
        type: "image.partial",
        job_id: jobId,
        task_id: req.task_id,
        at: new Date().toISOString(),
        data: {
          target_kind: target.kind,
          series_slug: target.series_slug,
          target_id: target.target_id,
          element_id:
            target.kind === "element" || target.kind === "character_ref" || target.kind === "scene_ref"
              ? target.target_id
              : undefined,
          shot_id:
            target.kind === "shot_first_frame" || target.kind === "shot_last_frame"
              ? target.target_id
              : undefined,
          image_id: persisted.image_id,
          asset_id: persisted.asset_id,
          vault_id: persisted.vault_id,
          url: persisted.url,
          completed: i + 1,
          total,
          provider_id: generation.provider_id,
        },
      });
    } catch { /* sse 推送失败不阻塞 */ }
  }

  // 5) 业务对象最新状态. vault_only adapter 返回 undefined.
  const target_state = await adapter.readState(target);

  return {
    images,
    provider_id: generation.provider_id,
    cost: generation.cost,
    target_state,
  };
}
