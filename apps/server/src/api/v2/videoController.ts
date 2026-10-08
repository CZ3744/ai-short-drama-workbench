import { Router } from "express";
import { z } from "zod";
import { generateVideoWithProvider, mapChannelToProviderId } from "../../application/generation/videoGenerationService";
import { getRegistry } from "./orchestration/_shared/registry";
// 2026-07-22 X3-6 (A1-2): raw `/videos/generate` 补真实视频锁(与 orchestrator.ts:1879 同语义)
import { providerIdFromModelRef, videoInstanceIdFromModelRef } from "../../application/generation/modelRef";
import { getVideoModelInstance } from "../../../../../packages/core/src/videoModelInstances";
import {
  acquireRealVideoLock,
  releaseRealVideoLock,
  getRealVideoLockHolder,
} from "../../../../../packages/core/src/index";

/**
 * W7-decouple (2026-05-15): 通用 raw video 生成入口,镜像 `/api/v2/images/generate`。
 *
 * 业务/真镜头生成走 orchestrator + shot-centric flat endpoints;这条路由仅为前端/脚本
 * 提供"喂提示词 + 拿 mp4 buffer"的对称入口,不写 vault / 不更新 shot,**调用方自己保存**。
 *
 * Body 与 imageRouter 类同 — provider_id / model_ref / prompt / aspect_ratio /
 * duration_sec / first_frame / reference_images。
 */
export const videoRouter = Router();

const VideoInputRefSchema = z.object({
  asset_id: z.string().max(1000).optional(),
  vault_id: z.string().max(200).optional(),
  path: z.string().max(1000).optional(),
  data_url: z.string().max(50 * 1024 * 1024).optional(),
  base64: z.string().max(50 * 1024 * 1024).optional(),
  mime: z.string().max(100).optional(),
  weight: z.number().min(0).max(1).optional(),
});

const AspectRatioSchema = z.enum(["9:16", "16:9", "1:1", "4:3", "3:4"]);

const GenerateVideoSchema = z.object({
  provider_id: z.string().max(200).optional(),
  model_ref: z.string().max(200).optional(),
  prompt: z.string().min(1).max(12000),
  negative_prompt: z.string().max(4000).optional(),
  duration_sec: z.number().min(1).max(120).default(5),
  aspect_ratio: AspectRatioSchema.default("16:9"),
  seed: z.number().int().optional(),
  series_slug: z.string().max(128).optional(),
  first_frame: VideoInputRefSchema.optional(),
  reference_images: z.array(VideoInputRefSchema).max(8).optional(),
  strict_reference_images: z.boolean().optional(),
  timeout_ms: z.number().int().min(1000).max(1_800_000).optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
}).refine(
  // W7 (2026-05-16): 红线 #1 — 禁止 silent fallback 到 local_mock_video。
  // raw `/api/v2/videos/generate` 没有 series/shot 上下文兜底,必须 body 里显式带
  // provider_id 或 model_ref,否则 400。
  (data) => Boolean((data.provider_id && data.provider_id.trim()) || (data.model_ref && data.model_ref.trim())),
  { message: "请显式选择视频模型,不可使用默认值", path: ["model_ref"] },
);

/**
 * 2026-07-22 X3-6 (A1-2): 解析 provider_id/model_ref → 真实 provider id(含 "instance:" 二级架构 unwrap),
 * 与 videoGenerationService(123-174) / dispatch.ts 同款, 供真实视频锁 isRealVideoProvider 判定用.
 */
function resolveLockProviderId(input: { provider_id?: string; model_ref?: string }): string {
  const instId = videoInstanceIdFromModelRef(input.model_ref) ?? videoInstanceIdFromModelRef(input.provider_id);
  if (instId) {
    const inst = getVideoModelInstance(instId);
    if (inst) return mapChannelToProviderId(inst.channel);
  }
  return providerIdFromModelRef(input.provider_id) ?? providerIdFromModelRef(input.model_ref) ?? "";
}

videoRouter.post("/videos/generate", async (req, res, next) => {
  const started = Date.now();
  // 2026-07-22 X3-6 (A1-2): 真实视频锁 — 与 orchestrator.ts:1879 同语义(全局同一时间最多一个真实视频任务).
  // 之前这条 raw 入口(脚本/直连可达)不过锁, 可与主路径真实 job 并发扣费; 现补: 真实付费 provider
  // 抢不到锁 → 409 + 持锁者信息; 非真实(mock/local)返 MOCK_TOKEN 不真锁. 释放在 finally.
  let lockToken: string | undefined;
  try {
    const parsed = GenerateVideoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const providerMissing = (flat.fieldErrors?.model_ref || []).some(
        (m) => typeof m === "string" && m.includes("请显式选择视频模型"),
      );
      res.status(400).json({
        error: providerMissing
          ? { code: "provider_not_selected", message: "请显式选择视频模型,不可使用默认值" }
          : { code: "ValidationError", message: "请求体校验失败", details: flat },
      });
      return;
    }

    const taskId = `video_generate_${Date.now()}`;
    const lockProviderId = resolveLockProviderId(parsed.data);
    const lock = await acquireRealVideoLock({ provider: lockProviderId, jobId: taskId, sceneId: "videos_generate_raw" });
    if (!lock) {
      const holder = getRealVideoLockHolder();
      res.status(409).json({
        error: {
          code: "RealVideoLockHeld",
          message: holder
            ? `已有真实视频任务在跑 (provider=${holder.provider}, 已运行 ${Math.round((Date.now() - new Date(holder.startedAt).getTime()) / 1000)}s), 请等它结束或到 /cockpit 强制释放`
            : "已有真实视频任务在跑, 请稍后再试",
        },
      });
      return;
    }
    lockToken = lock.token;

    const result = await generateVideoWithProvider(
      { ...parsed.data, task_id: taskId, job_id: taskId },
      {
        registry: getRegistry(),
        log: (level, msg, meta) => {
          const line = `[video-generate] ${msg}`;
          if (level === "error") console.error(line, meta ?? "");
          else if (level === "warn") console.warn(line, meta ?? "");
          else console.log(line, meta ?? "");
        },
      },
    );

    res.json({
      ok: true,
      provider_id: result.provider_id,
      elapsed_ms: Date.now() - started,
      video: {
        data_url: `data:${result.video.mime || "video/mp4"};base64,${result.video.buffer.toString("base64")}`,
        base64: result.video.buffer.toString("base64"),
        mime: result.video.mime || "video/mp4",
        bytes: result.video.buffer.length,
        width: result.video.width,
        height: result.video.height,
        duration_sec: result.video.duration_sec,
      },
      cost: result.cost,
      task_id: taskId,
    });
  } catch (err) {
    next(err);
  } finally {
    // mock/local provider 拿 MOCK_TOKEN, release 无副作用; 真实锁在此释放(与 orchestrator finally 同).
    if (lockToken) releaseRealVideoLock(lockToken);
  }
});
