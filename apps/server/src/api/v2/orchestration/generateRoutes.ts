/**
 * v2 Orchestration — Batch generation & preflight routes
 *
 *   POST /series/:slug/episodes/:epId/generate-all-first-frames
 *   POST /series/:slug/episodes/:epId/generate-all-videos
 *   POST /orchestration/preflight
 */

import { Router, type Response } from "express";
import { scrubForClient } from "../../../../../../packages/core/src/logger";

import {
  generateAllFirstFrames,
  type GenerateAllFirstFramesResult,
} from "../../../application/generation/generateAllFirstFrames";
import {
  generateAllVideos,
  type GenerateAllVideosResult,
} from "../../../application/generation/generateAllVideos";
import { preflight } from "../../../application/generation/preflight";

// ─── Router ───────────────────────────────────────────────────────

export const generateRouter = Router();

function sendValidationError(
  res: Response,
  result: Extract<GenerateAllFirstFramesResult | GenerateAllVideosResult, { kind: "validation" }>,
): void {
  res.status(result.status).json({
    error: {
      code: "ValidationError",
      message: "请求体校验失败",
      details: result.errors,
    },
  });
}

// ─── Existing routes (unchanged — generate-first-frames, generate-videos, cover, metadata) ──

// POST /series/:slug/episodes/:epId/generate-all-first-frames
generateRouter.post("/series/:slug/episodes/:epId/generate-all-first-frames", async (req, res, next) => {
  try {
    const result = await generateAllFirstFrames(
      { slug: req.params.slug, episodeId: req.params.epId, body: req.body },
      { requestId: req.requestId, requestLog: req.log },
    );

    if (result.kind === "validation") {
      sendValidationError(res, result);
      return;
    }

    // W7: provider_not_selected 等业务级 400 走 result.kind === "error"
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }

    res.json(result.body);
  } catch (err) {
    if (err instanceof Error && (err as Error & { status?: number }).status === 429) {
      res.status(429).json({ error: { code: "LimitExceeded", message: scrubForClient(err.message) } });
      return;
    }
    next(err);
  }
});

// POST /series/:slug/episodes/:epId/generate-all-videos
generateRouter.post("/series/:slug/episodes/:epId/generate-all-videos", async (req, res, next) => {
  try {
    const result = await generateAllVideos(
      { slug: req.params.slug, episodeId: req.params.epId, body: req.body },
      { requestId: req.requestId, requestLog: req.log },
    );

    if (result.kind === "validation") {
      sendValidationError(res, result);
      return;
    }

    // W7: provider_not_selected 等业务级 400 走 result.kind === "error"
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }

    res.json(result.body);
  } catch (err) {
    if (err instanceof Error && (err as Error & { status?: number }).status === 429) {
      res.status(429).json({ error: { code: "LimitExceeded", message: scrubForClient(err.message) } });
      return;
    }
    next(err);
  }
});

generateRouter.post("/orchestration/preflight", async (req, res, next) => {
  try {
    const result = await preflight({ body: req.body });
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }
    res.json(result.body);
  } catch (err) { next(err); }
});
