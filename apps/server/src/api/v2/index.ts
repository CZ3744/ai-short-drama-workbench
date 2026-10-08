/**
 * v2 Router — Assembles all v2 controllers under /api/v2 prefix
 *
 * Mount in main server:
 *   import { v2Router } from "./api/v2";
 *   app.use("/api/v2", v2Router);
 */

import { Router } from "express";
import { seriesRouter } from "./seriesController";
import { episodeRouter } from "./episodeController";
import { characterRouter } from "./characterController";
import { sceneRouter } from "./sceneController";
import { shotRouter } from "./shotController";
import { orchestrationRouter } from "./orchestrationController";
import { assetRouter } from "./assetController";
import { presetRouter } from "./presetController";
import { providerRouter } from "./providerController";
import { videoModelInstancesRouter } from "./videoModelInstancesController";
import { taskRouter } from "./taskController";
import { ledgerRouter } from "./ledgerController";
import { templateRouter } from "./templateController";
import { settingsRouter } from "./settingsController";
import { libraryRouter } from "./libraryController";
import { vaultRouter } from "./vaultController";
import { shotStageRouter } from "./shotStageController";
import { rejectPoolRouter } from "./rejectPoolController";
import { modelsRouter } from "./modelsController";
import { aiRouter } from "./aiController";
import { batchRouter } from "./batchController";
import { imageRouter } from "./imageController";
import { videoRouter } from "./videoController";
import { generationRouter } from "./generationController";
import { elementRouter } from "./elementController";
import { castRouter } from "./castController";
import { inspirationRouter } from "./inspirationController";
// 2026-07-22 Y6 UP-9(b): 系列卡自动封面(cover_vault_id 缺失时取该系列任意已有图) 302 重定向端点
import { seriesCoverFallbackRouter } from "./seriesCoverFallbackController";
// W6-B: 多版本管理（剧本 + 分镜）
import { versionsRouter } from "./versionsController";
import { getDiagnostics, pingProvider } from "./diagnosticsController";
import { getFailures, ignoreFailure } from "./failureController";
import { queryLogs, getLogSummary } from "./logController";
import { chatgptOauthV2Router } from "../routes/chatgptOauthRoutes";

export const v2Router = Router();

// C-N1 (2026-05-12): 统一 slug 白名单 middleware — 任何带 :slug 参数的路由都先过这里.
// 把 ../../etc 一类的非法 slug 直接拦在路由之前, 防 path traversal.
// 命名规则: 字母/数字/下划线/横线, 长度 1-128. 与 createSeries / migrate 生成的命名一致.
const SLUG_PATTERN = /^[A-Za-z0-9_\-]{1,128}$/;
function slugGuard(paramName: string) {
  return (req: any, res: any, next: any, slug: string) => {
    if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
      res.status(400).json({
        error: { code: "ValidationError", message: `${paramName} 含非法字符 (允许 A-Z a-z 0-9 _ -, 长度 1-128)` },
      });
      return;
    }
    next();
  };
}
v2Router.param("slug", slugGuard("slug"));
// P1-NEW (2026-05-12): 其他 :*Slug 路径参数也走同一白名单 — orchestrator 有 :targetSlug,
// 将来如再加 :sourceSlug 等也命中.
v2Router.param("targetSlug", slugGuard("targetSlug"));
v2Router.param("sourceSlug", slugGuard("sourceSlug"));

/**
 * P1-NEW: 导出给 controller 用 — 校验 body / query 里的 slug 字段 (非路径参数).
 * 路径参数走 v2Router.param 自动拦; body 里的 source_slug / target_slug 等仍要手动验.
 */
export function isValidSlug(s: unknown): s is string {
  return typeof s === "string" && SLUG_PATTERN.test(s);
}

// Register all controllers
v2Router.use(seriesRouter);
v2Router.use(episodeRouter);
v2Router.use(characterRouter);
v2Router.use(sceneRouter);
v2Router.use(shotRouter);
v2Router.use(orchestrationRouter);
v2Router.use(assetRouter);
v2Router.use(presetRouter);
v2Router.use(providerRouter);
v2Router.use(videoModelInstancesRouter);
v2Router.use(taskRouter);
v2Router.use(ledgerRouter);
v2Router.use(templateRouter);
v2Router.use(settingsRouter);
v2Router.use("/library", libraryRouter);
v2Router.use("/vault", vaultRouter);

// v24-batch-all — shot-centric / models / ai / batch
v2Router.use(shotStageRouter);
v2Router.use(rejectPoolRouter);
v2Router.use(modelsRouter);
v2Router.use(aiRouter);
v2Router.use(batchRouter);
v2Router.use(imageRouter);
v2Router.use(videoRouter);
// Phase 3 (Wave 2, 2026-05-16): 统一生成端点 /api/v2/generate/* —
// 推荐前端新代码用本端点替代各 controller 自己的 /generate-image / /generate-refs 等.
// 各 legacy URL 保留兼容, Wave 3 前端再逐步切换.
v2Router.use(generationRouter);
// 统一素材元素 (character/scene 适配 + prop/wardrobe/reference) — 见 docs/ASSET_MANAGEMENT_REDESIGN.md
v2Router.use(elementRouter);
// W4 2026-05-26: Cast (跨系列 IP 角色阵容容器) + effective-elements 合并视图 + series.cast_id 挂入
v2Router.use(castRouter);
v2Router.use(inspirationRouter);
v2Router.use(seriesCoverFallbackRouter);
// W6-B: 多版本管理（script-versions / storyboard-versions）
v2Router.use(versionsRouter);
v2Router.use(chatgptOauthV2Router);

// Health check
v2Router.get("/health", (_req, res) => {
  res.json({ ok: true, version: "v2", timestamp: new Date().toISOString() });
});

// Diagnostics
v2Router.get("/diagnostics", getDiagnostics);
v2Router.get("/diagnostics/providers/:id/ping", pingProvider);

// Failure Center (C5)
v2Router.get("/failures", getFailures);
v2Router.patch("/failures/:id/ignore", ignoreFailure);

// Log Query API
v2Router.get("/logs/query", queryLogs);
v2Router.get("/logs/summary", getLogSummary);
