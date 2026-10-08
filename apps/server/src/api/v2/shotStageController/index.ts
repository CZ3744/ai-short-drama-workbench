/**
 * v24-batch-all · Shot-centric 流水线路由 (拆分入口)
 *
 * 挂载前缀: /api/v2 (经由 v2Router.use(shotStageRouter))
 * 实际路径: /api/v2/shots/:sid/* 与 /api/v2/series/:slug/episodes/:epId/shots/:sid/*
 *
 * TODO(pm): BACKEND_SPEC 原始路径是裸 /api/shots/:sid, 为复用 scrubForClient
 * 错误链和 slug guard 挂到 v2 路径下; 若需改裸路径请在 apps/server/src/index.ts
 * 额外挂一个 app.use("/api/shots", shotStageRouter).
 *
 * 历史:本入口原是单文件 shotStageController.ts (1622 行)。2026-05-21 P1
 * 拆分按 endpoint domain 拆 5 子文件 + 抽 firstframe/video generate dispatch
 * helper(scoped + flat 共用,见 dispatch.ts)。各子文件:
 *   - shared.ts       — 共用 helper / DTO 构造 / provider 校验
 *   - dispatch.ts     — firstframe/video generate 共享 dispatch
 *   - frame-anchor.ts — 3 endpoint: stage/frame-anchor / reorder / delete
 *   - prompts.ts      — 4 endpoint: shot detail (scoped+flat) / prompt update / stage/prompt-preview
 *   - firstframe.ts   — 7 endpoint: preview-prompt / import-image / generate (scoped+flat)
 *                       / regen-from-reject / candidate (scoped+flat)
 *   - video.ts        — 7 endpoint: import-local / generate (scoped+flat) / dry-run (scoped+flat)
 *                       / candidate (scoped+flat)
 *   - failures.ts     — 4 endpoint: list / retry / retry-with-model / delete
 *
 * 共 25 endpoint (3+4+7+7+4)。export 名 `shotStageRouter` 保留,
 * 调用方 (`apps/server/src/api/v2/index.ts`) 无须改动。
 */

import { Router } from "express";
import { frameAnchorRouter } from "./frame-anchor";
import { promptsRouter } from "./prompts";
import { firstframeRouter } from "./firstframe";
import { videoRouter } from "./video";
import { failuresRouter } from "./failures";

export const shotStageRouter = Router();
shotStageRouter.use(frameAnchorRouter);
shotStageRouter.use(promptsRouter);
shotStageRouter.use(firstframeRouter);
shotStageRouter.use(videoRouter);
shotStageRouter.use(failuresRouter);
