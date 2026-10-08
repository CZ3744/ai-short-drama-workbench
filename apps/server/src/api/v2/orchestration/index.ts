/**
 * orchestration/index.ts — 组装入口
 *
 * Step 3a: 原 4756 行的 orchestrationController.ts 物理拆分。
 * 30 个路由 handler 按工作流分到 9 个 routes 文件, 共享 helper 抽到 _shared/。
 * 这里把 9 个子 router 组装成单一 orchestrationRouter, 挂载行为与原文件一致
 * (路由 path 字符串逐字不变; path 唯一无前缀冲突, 注册顺序不影响匹配)。
 *
 * 子 router 分组:
 *   seriesRoutes        — clarify / infer-setting / expand-script
 *   planStoryboardRoutes— plan-storyboard (系列级 + 单集级)
 *   episodeRoutes       — extract-entities / quality-check / generate-cover / generate-metadata
 *   composeRoutes       — compose / compose/progress
 *   exportRoutes        — export / final.mp4 / compose-versions / compose-file / versions / revert
 *   generateRoutes      — generate-all-first-frames / generate-all-videos / preflight
 *   memoryRoutes        — memory/* / feedback / preferences / script-edit / copy-preferences
 *   ttsRoutes           — tts/test
 *   subtitleRoutes      — subtitles/preview
 */

import { Router } from "express";
import { seriesOrchestrationRouter } from "./seriesRoutes";
import { planStoryboardRouter } from "./planStoryboardRoutes";
import { episodeOrchestrationRouter } from "./episodeRoutes";
import { composeRouter } from "./composeRoutes";
import { exportRouter } from "./exportRoutes";
import { generateRouter } from "./generateRoutes";
import { memoryRouter } from "./memoryRoutes";
import { ttsRouter } from "./ttsRoutes";
import { subtitleRouter } from "./subtitleRoutes";
import { previewRouter } from "./previewRoutes";
// 2026-05-18 一键自动管线 — 首帧 → 视频 → 合成串行 chain
import { autoPipelineRouter } from "./autoPipelineRoutes";

export const orchestrationRouter = Router();

orchestrationRouter.use(seriesOrchestrationRouter);
orchestrationRouter.use(planStoryboardRouter);
orchestrationRouter.use(episodeOrchestrationRouter);
orchestrationRouter.use(composeRouter);
orchestrationRouter.use(exportRouter);
orchestrationRouter.use(generateRouter);
orchestrationRouter.use(memoryRouter);
orchestrationRouter.use(ttsRouter);
orchestrationRouter.use(subtitleRouter);
// W5-B: 发送前查看完整提示词 (4 个 preview-* 端点)
orchestrationRouter.use(previewRouter);
// 一键自动管线 (POST /series/:slug/episodes/:epId/auto-pipeline 等)
orchestrationRouter.use(autoPipelineRouter);
