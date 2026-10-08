/**
 * episodeRoutes — episode-related orchestration endpoints
 *
 *   POST /series/:slug/episodes/:epId/extract-entities
 *   GET  /series/:slug/episodes/:epId/quality-check
 *   POST /series/:slug/episodes/:epId/generate-cover
 *   POST /series/:slug/episodes/:epId/generate-metadata
 */

import { Router, type Response } from "express";
import { z } from "zod";

import {
  extractEntities,
  generateCover,
  generateMetadata,
  runQualityCheck,
  type EpisodeUseCaseResult,
} from "../../../application/episode/episodeUseCases";
import { makeResProgressSink } from "./_shared/progressSink";

import { ProviderError } from "../../../../../../packages/providers/src/core/index";
import { FallbackChainError } from "../../../../../../packages/providers/src/core/queue";
import { scrubForClient } from "../../../../../../packages/core/src/logger";

export const episodeOrchestrationRouter = Router();

function sendEpisodeResult(res: Response, result: EpisodeUseCaseResult): void {
  if (result.kind === "validation") {
    res.status(result.status).json({
      error: {
        code: "ValidationError",
        message: "请求体校验失败",
        details: result.errors,
      },
    });
    return;
  }
  if (result.kind === "error") {
    res.status(result.status).json(result.body);
    return;
  }
  res.json(result.body);
}

function handleExtractEntitiesError(res: Response, err: unknown): boolean {
  if (err instanceof z.ZodError) {
    res.status(422).json({
      error: { code: "ValidationError", message: "LLM 返回 JSON 校验失败", details: err.issues },
    });
    return true;
  }
  if (err instanceof FallbackChainError) {
    res.status(502).json({
      error: { code: "AllProvidersFailed", message: err.summary(), suggestion: err.suggestion() },
    });
    return true;
  }
  if (err instanceof ProviderError) {
    if (err.code === "rate_limit") {
      res.status(429).json({ error: { code: "RateLimit", message: scrubForClient(err.message) } });
      return true;
    }
    if (err.code === "missing_key") {
      res.status(400).json({ error: { code: "MissingKey", message: scrubForClient(err.message) } });
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// 2. POST /series/:slug/episodes/:epId/extract-entities
// ═══════════════════════════════════════════════════════════════════

episodeOrchestrationRouter.post("/series/:slug/episodes/:epId/extract-entities", async (req, res, next) => {
  try {
    const result = await extractEntities(
      { slug: req.params.slug, episodeId: req.params.epId, body: req.body },
      { progress: makeResProgressSink(res) },
    );
    sendEpisodeResult(res, result);
  } catch (err: unknown) {
    if (handleExtractEntitiesError(res, err)) return;
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4B. GET /series/:slug/episodes/:epId/quality-check (C5 输出前质检)
// ═══════════════════════════════════════════════════════════════════

episodeOrchestrationRouter.get("/series/:slug/episodes/:epId/quality-check", async (req, res, next) => {
  try {
    sendEpisodeResult(res, await runQualityCheck({ slug: req.params.slug, episodeId: req.params.epId }));
  } catch (err) {
    next(err);
  }
});

// POST /series/:slug/episodes/:epId/generate-cover
episodeOrchestrationRouter.post("/series/:slug/episodes/:epId/generate-cover/preview", async (req, res, next) => {
  try {
    sendEpisodeResult(res, await generateCover(
      { slug: req.params.slug, episodeId: req.params.epId, body: req.body },
      { preview: true },
    ));
  } catch (err) { next(err); }
});

episodeOrchestrationRouter.post("/series/:slug/episodes/:epId/generate-cover", async (req, res, next) => {
  try {
    const result = await generateCover(
      { slug: req.params.slug, episodeId: req.params.epId, body: req.body },
      { requestId: req.requestId },
    );
    sendEpisodeResult(res, result);
  } catch (err: unknown) {
    if (err instanceof ProviderError) {
      if (err.code === "missing_key") {
        res.status(400).json({ error: { code: "MissingKey", message: scrubForClient(err.message) } });
        return;
      }
    }
    next(err);
  }
});

// POST /series/:slug/episodes/:epId/generate-metadata
episodeOrchestrationRouter.post("/series/:slug/episodes/:epId/generate-metadata", async (req, res, next) => {
  try {
    sendEpisodeResult(res, await generateMetadata({ slug: req.params.slug, episodeId: req.params.epId, body: req.body }));
  } catch (err: unknown) {
    if (err instanceof FallbackChainError) {
      res.status(502).json({
        error: { code: "AllProvidersFailed", message: err.summary(), suggestion: err.suggestion() },
      });
      return;
    }
    next(err);
  }
});
