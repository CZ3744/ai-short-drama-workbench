/**
 * orchestration/previewRoutes.ts — W5-B
 *
 * "发送前查看完整提示词" 端点合集. 每个端点都:
 *   - 拼出即将发给 provider 的完整 prompt
 *   - **不真发起调用**, 不扣费, 不写状态
 *
 * 端点:
 *   POST /series/:slug/preview-expand-prompt
 *   POST /series/:slug/episodes/:epId/preview-plan-storyboard-prompt
 *   POST /series/:slug/preview-ai-chat-prompt
 *   POST /series/:slug/preview-ai-suggest-prompt
 *   POST /series/:slug/episodes/:epId/preview-revise-prompt
 *   POST /series/:slug/episodes/:epId/preview-tts-prompt
 *
 * 图像 / 视频已有 dryRun 端点 (W3-B dryRunElementImage / W1-Y dryRunVideo) 直接复用.
 */

import { Router, type Response } from "express";

import {
  previewExpandScriptPrompt,
  previewPlanStoryboardPrompt,
  previewSeriesPlanStoryboardPrompt,
  previewAiChatPrompt,
  previewAiSuggestPrompt,
  previewRevisePrompt,
  previewTtsPrompt,
  previewComposePrompt,
  type PreviewResult,
} from "../../../application/preview/previewPrompts";
import {
  previewBatchElementImagePrompts,
  previewAutoPipelinePrompts,
} from "../../../application/preview/batchPreviewPrompts";

export const previewRouter = Router();

function sendPreviewResult(res: Response, result: PreviewResult): void {
  if (result.kind === "validation") {
    res.status(result.status).json({
      error: { code: "ValidationError", message: "请求体校验失败", details: result.errors },
    });
    return;
  }
  if (result.kind === "error") {
    res.status(result.status).json(result.body);
    return;
  }
  res.json(result.body);
}

// 1. expand-script prompt preview
previewRouter.post("/series/:slug/preview-expand-prompt", async (req, res, next) => {
  try {
    const result = await previewExpandScriptPrompt({ slug: req.params.slug, body: req.body });
    sendPreviewResult(res, result);
  } catch (err) { next(err); }
});

// 2. plan-storyboard prompt preview (episode-level)
previewRouter.post(
  "/series/:slug/episodes/:epId/preview-plan-storyboard-prompt",
  async (req, res, next) => {
    try {
      const result = await previewPlanStoryboardPrompt({
        slug: req.params.slug,
        episodeId: req.params.epId,
        body: req.body,
      });
      sendPreviewResult(res, result);
    } catch (err) { next(err); }
  },
);

// 5. plan-storyboard prompt preview (系列级，无 epId — ScriptCanvasPage 用)
previewRouter.post("/series/:slug/preview-storyboard-prompt", async (req, res, next) => {
  try {
    const result = await previewSeriesPlanStoryboardPrompt({ slug: req.params.slug, body: req.body });
    sendPreviewResult(res, result);
  } catch (err) { next(err); }
});

// 3. ai chat prompt preview (剧本页 AI 助手)
previewRouter.post("/series/:slug/preview-ai-chat-prompt", async (req, res, next) => {
  try {
    const result = await previewAiChatPrompt({ slug: req.params.slug, body: req.body });
    sendPreviewResult(res, result);
  } catch (err) { next(err); }
});

// 4. ai suggest prompt preview (剧本页 AI 改写 / 行内改写)
previewRouter.post("/series/:slug/preview-ai-suggest-prompt", async (req, res, next) => {
  try {
    const result = await previewAiSuggestPrompt({ slug: req.params.slug, body: req.body });
    sendPreviewResult(res, result);
  } catch (err) { next(err); }
});

// 5. episode revise prompt preview
previewRouter.post(
  "/series/:slug/episodes/:epId/preview-revise-prompt",
  async (req, res, next) => {
    try {
      const result = await previewRevisePrompt({
        slug: req.params.slug,
        episodeId: req.params.epId,
        body: req.body,
      });
      sendPreviewResult(res, result);
    } catch (err) { next(err); }
  },
);

// 6. TTS prompt preview (compose 页)
previewRouter.post(
  "/series/:slug/episodes/:epId/preview-tts-prompt",
  async (req, res, next) => {
    try {
      const result = await previewTtsPrompt({
        slug: req.params.slug,
        episodeId: req.params.epId,
        body: req.body,
      });
      sendPreviewResult(res, result);
    } catch (err) { next(err); }
  },
);

// 6B. compose full request preview (compose 页)
previewRouter.post(
  "/series/:slug/episodes/:epId/preview-compose-prompt",
  async (req, res, next) => {
    try {
      const result = await previewComposePrompt({
        slug: req.params.slug,
        episodeId: req.params.epId,
        body: req.body ?? {},
      });
      sendPreviewResult(res, result);
    } catch (err) { next(err); }
  },
);

// 2026-05-20 P0 架构修复: 批量 AI 入口的"发送前查看完整提示词"端点 (铁律 #2 + #13).
//
// 7. element 批量补全 preview (BatchElementImageDialog 用)
//    返回: 每个 element × 每个未生成 brief 的完整 prompt + 自动 reference 图.
previewRouter.post("/series/:slug/elements/batch-preview-prompts", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const result = await previewBatchElementImagePrompts({
      slug: req.params.slug,
      image_provider_id: typeof body.image_provider_id === "string" ? body.image_provider_id : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    });
    if ("error" in result) {
      res.status(result.status).json({
        error: { code: result.status === 404 ? "NotFound" : "PreviewError", message: result.error },
      });
      return;
    }
    res.json(result);
  } catch (err) { next(err); }
});

// 8. AutoPipeline 全集 preview (AutoPipelineLauncher 用)
//    返回: 4 个 stage 各自的调用数 + 前 N 个 sample prompts.
previewRouter.post(
  "/series/:slug/episodes/:epId/auto-pipeline/preview-prompts",
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const result = await previewAutoPipelinePrompts({
        slug: req.params.slug,
        episode_id: req.params.epId,
        options: {
          image_provider_id: typeof body.image_provider_id === "string" ? body.image_provider_id : undefined,
          video_provider_id: typeof body.video_provider_id === "string" ? body.video_provider_id : undefined,
          image_count_per_shot: typeof body.image_count_per_shot === "number" ? body.image_count_per_shot : undefined,
          video_count_per_shot: typeof body.video_count_per_shot === "number" ? body.video_count_per_shot : undefined,
          only_element_images: body.only_element_images === true,
          only_firstframes: body.only_firstframes === true,
          skip_element_images: body.skip_element_images === true,
          sample_limit: typeof body.sample_limit === "number" ? body.sample_limit : undefined,
        },
      });
      if ("error" in result) {
        res.status(result.status).json({
          error: { code: result.status === 404 ? "NotFound" : "PreviewError", message: result.error },
        });
        return;
      }
      res.json(result);
    } catch (err) { next(err); }
  },
);
