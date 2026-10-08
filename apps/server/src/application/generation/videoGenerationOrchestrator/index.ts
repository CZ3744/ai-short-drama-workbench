/**
 * videoGenerationOrchestrator — Phase 1 解耦重构主入口 (Wave 1, 2026-05-16).
 *
 * 对称 imageGenerationOrchestrator. 视频 target 只有 shot_video / vault_only 两种.
 *
 * Phase 1 范围说明: orchestrator (jobs/orchestrator.ts) 视频任务路径自带 ffprobe 校验 /
 * 末帧抽取 / 真实视频锁 / SSE 任务追踪, **暂不**走本 orchestrator. 当前实际接入 Phase 1
 * 的只有 raw /videos/generate (走 vault_only adapter). shot_video adapter 已就绪供
 * 后续 Wave 切换使用.
 */

import { generateVideoWithProvider } from "../videoGenerationService";
import type { ProviderRegistry } from "../../../../../../packages/providers/src/core/registry";
import type { ProviderContext } from "../../../../../../packages/providers/src/core/types";
import { getVideoAdapterFor } from "./registry";
import { VideoGenerationTargetSchema } from "./types";
import type {
  GenerateVideoForTargetRequest,
  GenerateVideoForTargetResult,
  PersistedVideo,
} from "./types";

export type {
  GenerateVideoForTargetRequest,
  GenerateVideoForTargetResult,
  PersistedVideo,
  VideoGenerationTarget,
  VideoTargetKind,
  VideoTargetAdapter,
} from "./types";
export { VideoGenerationTargetSchema, VideoTargetKindSchema } from "./types";

export async function generateVideoForTarget(
  req: GenerateVideoForTargetRequest,
  deps: { registry: ProviderRegistry; log?: ProviderContext["log"] },
): Promise<GenerateVideoForTargetResult> {
  const parsed = VideoGenerationTargetSchema.safeParse(req.target);
  if (!parsed.success) {
    throw Object.assign(new Error(`VideoGenerationTarget 校验失败: ${parsed.error.message}`), {
      status: 400,
      code: "InvalidTarget",
    });
  }
  const target = parsed.data;

  const generation = await generateVideoWithProvider(
    {
      provider_id: req.provider_id,
      model_ref: req.model_ref,
      prompt: req.prompt,
      negative_prompt: req.negative_prompt,
      duration_sec: req.duration_sec,
      aspect_ratio: req.aspect_ratio,
      seed: req.seed,
      first_frame: req.first_frame,
      reference_images: req.reference_images,
      strict_reference_images: req.strict_reference_images,
      series_slug: target.series_slug,
      job_id: req.job_id,
      task_id: req.task_id,
      timeout_ms: req.timeout_ms,
    },
    {
      registry: deps.registry,
      log: deps.log,
      default_provider_id: req.default_provider_id,
    },
  );

  const adapter = getVideoAdapterFor(target.kind);
  const video: PersistedVideo = await adapter.persist({
    video: generation.video,
    target,
    provider_id: generation.provider_id,
    request: req,
  });
  const target_state = await adapter.readState(target);

  return {
    video,
    provider_id: generation.provider_id,
    cost: generation.cost,
    target_state,
  };
}
