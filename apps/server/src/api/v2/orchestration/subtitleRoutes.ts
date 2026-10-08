/**
 * v2 Orchestration — subtitle preview route
 *
 * Step 3a batch 1 extraction — verbatim from orchestrationController.ts.
 * Handlers:
 *   GET /series/:slug/episodes/:epId/subtitles/preview
 */

import { Router } from "express";

import { previewSubtitles } from "../../../application/subtitles/previewSubtitles";

export const subtitleRouter = Router();

// ═══════════════════════════════════════════════════════════════════
// Wave 3 3B: GET /series/:slug/episodes/:epId/subtitles/preview
// 返回 SRT 内容 + 时长统计，用于字幕校验 Tab
// ═══════════════════════════════════════════════════════════════════

subtitleRouter.get("/series/:slug/episodes/:epId/subtitles/preview", async (req, res, next) => {
  try {
    const result = await previewSubtitles({ slug: req.params.slug, episodeId: req.params.epId });
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }
    res.json(result.body);
  } catch (err) { next(err); }
});
