/**
 * orchestration/planStoryboardRoutes.ts
 *
 * Thin HTTP/SSE adapter for storyboard planning orchestration.
 */

import { Router, type Request, type Response } from "express";
import { clientDisconnectSignal } from "../../../middleware/clientDisconnectSignal";
import { z } from "zod";

import {
  planEpisodeStoryboard,
  type PlanEpisodeStoryboardResult,
} from "../../../application/planStoryboard/planEpisodeStoryboard";
import {
  planSeriesStoryboard,
  type PlanSeriesStoryboardResult,
} from "../../../application/planStoryboard/planSeriesStoryboard";
import { validate, PlanStoryboardSchema } from "../validators";
import { ProviderError } from "../../../../../../packages/providers/src/core/index";
import { FallbackChainError } from "../../../../../../packages/providers/src/core/queue";
import { scrubForClient } from "../../../../../../packages/core/src/logger";

import { makeResProgressSink } from "./_shared/progressSink";
import { enableSse, respondError, respondJson } from "./_shared/sse";

export const planStoryboardRouter = Router();

/**
 * 2026-07-10 Fable P0-1 — 重拆分镜 force 判据(query ?force=1/true 或 body.force===true).
 * 系列级与单集级共用一处, 避免两份判断漂移(解耦).
 * 2026-07-22 X3-4 (A6-3): export 供 episodeController 粘贴导入两路由复用同一 force 判据(解耦).
 */
export function isStoryboardForceRequested(req: Request): boolean {
  if (req.query.force === "1" || req.query.force === "true") return true;
  return Boolean(
    req.body && typeof req.body === "object" && "force" in req.body &&
    (req.body as { force?: unknown }).force === true,
  );
}

/**
 * 2026-07-10 Fable P0-1 — 系列级重拆确认门统计: 各集现有分镜数 + 有生成结果的镜数.
 * 用于在硬性重拆(把旧分镜整批移入垃圾桶)前给用户一个明确 409 确认, 附各集拆分供前端拼人话.
 */
async function surveySeriesStoryboard(slug: string): Promise<{
  total_shots: number;
  generation_count: number;
  has_content: boolean;
  episodes: Array<{ index: number; title: string; shot_count: number; generation_count: number }>;
}> {
  const { listEpisodes, listShots } = await import("../seriesStore");
  const episodes = await listEpisodes(slug).catch(() => []);
  let totalShots = 0;
  let generationCount = 0;
  let hasContent = false;
  const perEpisode: Array<{ index: number; title: string; shot_count: number; generation_count: number }> = [];
  for (const ep of episodes) {
    const shots = await listShots(slug, ep.id).catch(() => []);
    if (shots.length === 0) continue;
    let epGen = 0;
    for (const s of shots) {
      if ((s.generations?.length ?? 0) > 0) epGen++;
      if (
        !hasContent &&
        ((s.action ?? "").trim().length > 0 ||
          (s.dialogue ?? "").trim().length > 0 ||
          (s.voiceover ?? "").trim().length > 0 ||
          (s.prompt_img ?? "").trim().length > 0)
      ) {
        hasContent = true;
      }
    }
    totalShots += shots.length;
    generationCount += epGen;
    perEpisode.push({ index: ep.index, title: ep.title ?? "", shot_count: shots.length, generation_count: epGen });
  }
  return { total_shots: totalShots, generation_count: generationCount, has_content: hasContent, episodes: perEpisode };
}

function sendSeriesStoryboardResult(res: Response, result: PlanSeriesStoryboardResult): void {
  if (result.kind === "validation") {
    res.status(result.status).json({
      error: { code: "ValidationError", message: "请求体校验失败", details: result.errors },
    });
    return;
  }
  if (result.kind === "respondError") {
    respondError(res, result.status, result.body);
    return;
  }
  respondJson(res, result.body);
}

function sendEpisodeStoryboardResult(res: Response, result: PlanEpisodeStoryboardResult): void {
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
  respondJson(res, result.body);
}

planStoryboardRouter.post("/series/:slug/plan-storyboard", async (req, res, next) => {
  try {
    // 2026-07-10 Fable P0-1 — 系列级重拆确认门. 必须在 enableSse 之前(一旦转成 event-stream 就回不了 409).
    // 已有分镜(尤其含已生成候选)时不无门槛硬拆: 返 409 让前端弹确认, force=true 才放行. 重拆时旧分镜
    // 会整套移入分镜垃圾桶(可恢复), 已生成的图/视频文件仍保留在归档柜.
    if (!isStoryboardForceRequested(req)) {
      const survey = await surveySeriesStoryboard(req.params.slug);
      if (survey.total_shots > 0 && (survey.has_content || survey.generation_count > 0)) {
        const genNote = survey.generation_count > 0 ? `,其中 ${survey.generation_count} 镜已有生成结果` : "";
        res.status(409).json({
          error: {
            code: "StoryboardAlreadyExists",
            message: `本系列已有 ${survey.total_shots} 个分镜${genNote}。重新拆分会把现有分镜整体移入分镜垃圾桶(可恢复),已生成的图片/视频文件仍保留在归档柜。确认重拆请加 force=true。`,
            details: {
              existing_count: survey.total_shots,
              generation_count: survey.generation_count,
              episode_breakdown: survey.episodes,
            },
          },
        });
        return;
      }
    }

    enableSse(req, res);
    const result = await planSeriesStoryboard(
      // 2026-05-20 P1 铁律 #1: 透传 req.signal 让客户端断开能真 abort
      { slug: req.params.slug, body: req.body, signal: clientDisconnectSignal(req, res) },
      { progress: makeResProgressSink(res), requestId: req.requestId },
    );
    sendSeriesStoryboardResult(res, result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(422).json({
        error: { code: "ValidationError", message: "LLM 返回 JSON 校验失败", details: err.issues },
      });
      return;
    }
    next(err);
  }
});

planStoryboardRouter.post("/series/:slug/episodes/:epId/plan-storyboard", async (req, res, next) => {
  try {
    const bodyValidated = validate(PlanStoryboardSchema, req.body);
    if (!bodyValidated.ok) {
      res.status(bodyValidated.status).json({
        error: { code: "ValidationError", message: "请求体校验失败", details: bodyValidated.errors },
      });
      return;
    }

    // 2026-05-21 — 重拆分镜会覆盖用户手改 (灾难 bug):
    // shotId 是 `s${i+1}` 顺序生成, writeJson 直接覆盖同名文件 → 用户在 ShotStage
    // 改过的 action / dialogue / prompt_img 全丢. 用 force=true 显式确认才允许.
    // 2026-07-10 Fable P0-1: force 判据抽成 isStoryboardForceRequested 与系列级共用(解耦).
    const force = isStoryboardForceRequested(req);
    if (!force) {
      const { listShots } = await import("../seriesStore");
      const existingShots = await listShots(req.params.slug, req.params.epId).catch(() => []);
      if (existingShots.length > 0) {
        // 检测用户是否手改过 (任一 shot 的 action / dialogue / voiceover / prompt_img 非空)
        const hasManualEdits = existingShots.some((s) =>
          (s.action ?? "").trim().length > 0 ||
          (s.dialogue ?? "").trim().length > 0 ||
          (s.voiceover ?? "").trim().length > 0 ||
          (s.prompt_img ?? "").trim().length > 0,
        );
        if (hasManualEdits) {
          res.status(409).json({
            error: {
              code: "StoryboardAlreadyExists",
              message: `本集已有 ${existingShots.length} 镜分镜 (含手改内容)。重新拆会覆盖手改,确认请加 force=true 参数。`,
              existing_count: existingShots.length,
            },
          });
          return;
        }
      }
    }

    enableSse(req, res);
    const result = await planEpisodeStoryboard(
      {
        slug: req.params.slug,
        episodeId: req.params.epId,
        body: req.body,
        useDirector: req.query.use_director === "1" || req.query.use_director === "true",
      },
      { progress: makeResProgressSink(res), requestId: req.requestId },
    );
    sendEpisodeStoryboardResult(res, result);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      res.status(422).json({
        error: { code: "ValidationError", message: "LLM 返回 JSON 校验失败", details: err.issues },
      });
      return;
    }
    if (err instanceof FallbackChainError) {
      res.status(502).json({
        error: { code: "AllProvidersFailed", message: err.summary(), suggestion: err.suggestion() },
      });
      return;
    }
    if (err instanceof ProviderError) {
      if (err.code === "rate_limit") {
        res.status(429).json({ error: { code: "RateLimit", message: scrubForClient(err.message) } });
        return;
      }
      if (err.code === "missing_key") {
        res.status(400).json({ error: { code: "MissingKey", message: scrubForClient(err.message) } });
        return;
      }
    }
    next(err);
  }
});
