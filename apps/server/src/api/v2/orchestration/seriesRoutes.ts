/**
 * v2 Orchestration — series-scoped LLM routes
 *
 * Step 3a batch 1 extraction — verbatim from orchestrationController.ts.
 * Handlers:
 *   POST /series/:slug/clarify              — IntentClarifier (P150-B1)
 *   POST /series/:slug/infer-setting        — AI inference for series defaults
 *   POST /series/:slug/expand-script        — Script expansion
 */

import { Router, type Response } from "express";
import { clientDisconnectSignal } from "../../../middleware/clientDisconnectSignal";
import { z } from "zod";

import { respondJson, respondError, enableSse } from "./_shared/sse";
import { scrubForClient } from "../../../../../../packages/core/src/logger";
import { makeResProgressSink } from "./_shared/progressSink";
import { clarify as clarifySeries } from "../../../application/series/clarify";
import { inferSetting } from "../../../application/series/inferSetting";
import { expandScript, type ExpandScriptResult } from "../../../application/series/expandScript";

import { ProviderError } from "../../../../../../packages/providers/src/core/index";
import { FallbackChainError } from "../../../../../../packages/providers/src/core/queue";

export const seriesOrchestrationRouter = Router();

function sendExpandValidationError(
  res: Response,
  result: Extract<ExpandScriptResult, { kind: "validation" }>,
): void {
  res.status(result.status).json({
    error: {
      code: "ValidationError",
      message: "请求体校验失败",
      details: result.errors,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
// 0. POST /series/:slug/clarify — P150-B1 IntentClarifier
// ═══════════════════════════════════════════════════════════════════
// 开关: getConfigValue("ENABLE_CLARIFIER", "0") === "1" 时生效
// 默认关闭，用户体验成熟后再开

seriesOrchestrationRouter.post("/series/:slug/clarify", async (req, res, next) => {
  try {
    const { user_input } = req.body as { user_input?: string };
    const result = await clarifySeries(
      // 2026-05-20 P1 铁律 #1: 透传 req.signal — 客户端断开能真 abort LLM clarifier 调用
      { slug: req.params.slug, user_input, signal: clientDisconnectSignal(req, res) },
      { progress: makeResProgressSink(res) },
    );

    if (result.kind === "respondError") {
      respondError(res, result.status, result.body);
      return;
    }

    respondJson(res, result.body);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      respondError(res, 422, {
        error: { code: "ValidationError", message: "LLM 返回 JSON 校验失败", details: err.issues },
      });
      return;
    }
    if (err instanceof FallbackChainError) {
      respondError(res, 502, {
        error: { code: "AllProvidersFailed", message: err.summary(), suggestion: err.suggestion() },
      });
      return;
    }
    if (err instanceof ProviderError) {
      if (err.code === "rate_limit") {
        respondError(res, 429, { error: { code: "RateLimit", message: scrubForClient(err.message) } });
        return;
      }
      if (err.code === "missing_key") {
        respondError(res, 400, { error: { code: "MissingKey", message: scrubForClient(err.message) } });
        return;
      }
    }
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 0b. POST /series/:slug/infer-setting — P160-B1 "我还没想好"
// ═══════════════════════════════════════════════════════════════════
// 基于已填字段 + 灵感文本,调 LLM 推断单个设置项的建议值

seriesOrchestrationRouter.post("/series/:slug/infer-setting", async (req, res, next) => {
  try {
    const result = await inferSetting(
      // 2026-05-20 P1 铁律 #1: 透传 req.signal 让客户端断开能真 abort LLM 调用
      { slug: req.params.slug, body: req.body, signal: clientDisconnectSignal(req, res) },
      { progress: makeResProgressSink(res), requestId: req.requestId },
    );

    if (result.kind === "rawJson") {
      res.status(result.status).json(result.body);
      return;
    }
    if (result.kind === "respondError") {
      respondError(res, result.status, result.body);
      return;
    }

    respondJson(res, result.body);
  } catch (err: unknown) {
    if (err instanceof FallbackChainError) {
      respondError(res, 502, {
        error: { code: "AllProvidersFailed", message: err.summary(), suggestion: err.suggestion() },
      });
      return;
    }
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 1. POST /series/:slug/expand-script
// ═══════════════════════════════════════════════════════════════════

seriesOrchestrationRouter.post("/series/:slug/expand-script", async (req, res, next) => {
  const t0 = Date.now();
  try {
    enableSse(req, res);

    const result = await expandScript(
      // 2026-05-20 P1 铁律 #1: 透传 req.signal — 客户端断开 / 用户取消能真正中止 LLM 调用
      { slug: req.params.slug, body: req.body, startedAtMs: t0, signal: clientDisconnectSignal(req, res) },
      {
        progress: makeResProgressSink(res),
        requestId: req.requestId,
        requestLog: req.log,
      },
    );

    if (result.kind === "validation") {
      sendExpandValidationError(res, result);
      return;
    }
    if (result.kind === "respondError") {
      respondError(res, result.status, result.body);
      return;
    }
    if (result.kind === "respondJson") {
      respondJson(res, result.body);
      return;
    }

    res.json(result.body);
  } catch (err: unknown) {
    if (err instanceof ProviderError) {
      if (err.code === "rate_limit") {
        res.status(429).json({ error: { code: "RateLimit", message: scrubForClient(err.message), provider_id: err.provider_id } });
        return;
      }
      if (err.code === "missing_key") {
        res.status(400).json({ error: { code: "MissingKey", message: scrubForClient(err.message), provider_id: err.provider_id } });
        return;
      }
    }
    next(err);
  }
});
