/**
 * Failures (失败记录) endpoints — 拆自原 shotStageController.ts。
 *
 * 覆盖 4 个 endpoint:
 *   - GET    /api/v2/shots/:sid/failures
 *   - POST   /api/v2/shots/:sid/failures/:aid/retry
 *   - POST   /api/v2/shots/:sid/failures/:aid/retry-with-model
 *   - DELETE /api/v2/shots/:sid/failures/:aid
 *
 * 这些端点 controller 头注释里早就声明过, 但之前没有真正实现 → withFallback 把 404
 * 当成 not_implemented, 前端右栏因此一直显示「功能尚在接通中」。
 * W3-A 把 listShotFailuresWithId / dismissShotFailureById 接通; retry-with-model
 * 通过 orchestrator.prompt_override 保留原 prompt, 仅切 provider/model_ref。
 */

import { Router, type Request, type Response } from "express";
import {
  locateShotById,
  listShotFailuresWithId,
  dismissShotFailureById,
} from "../seriesStore";
import {
  createPendingJob,
  updatePendingJob,
  failPendingJob,
} from "../../../jobs/pendingJobs";
import { orchestrator } from "../../../jobs/orchestrator";
import { providerIdFromModelRef } from "../../../application/generation/modelRef";
import { err } from "./shared";

export const failuresRouter = Router();

failuresRouter.get("/shots/:sid/failures", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    // 2026-05-26 walkthrough fix (shotId 不全局唯一): 同名 shotId 在多个 series 都存在,
    // listShotFailuresWithId 走 locator 返第一个匹配, 导致新建 series 的 shot 看到老 series
    // 的失败计数 ("6 次失败"幽灵). 必须用 ?slug=&epId= 显式定位.
    const slug = typeof req.query.slug === "string" ? req.query.slug : undefined;
    const epId = typeof req.query.epId === "string" ? req.query.epId : undefined;
    let failures;
    if (slug && epId) {
      const { readShot } = await import("../../../repositories/shotRepo");
      const shot = await readShot(slug, epId, sid);
      if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到 (slug=${slug}, epId=${epId})`);
      failures = shot.failures ?? [];
    } else {
      failures = await listShotFailuresWithId(sid);
      if (!failures) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    }
    // 兼容旧契约: failure.error -> message
    const normalized = (failures as unknown as Array<Record<string, unknown>>).map((f) => ({
      attempt_id: f.attempt_id,
      at: f.at,
      stage: f.stage,
      model: f.model,
      code: (f.code as string | undefined) ?? "error",
      message: (f.error as string | undefined) ?? (f.message as string | undefined) ?? "",
      request_json: f.request_json,
      response_json: f.response_json,
      suggested_model: f.suggested_model,
    }));
    res.json({ failures: normalized });
  } catch (e) { next(e); }
});

failuresRouter.post("/shots/:sid/failures/:aid/retry", async (req: Request, res: Response, next) => {
  let attemptId: string | undefined;
  try {
    const sid = String(req.params.sid);
    const aid = String(req.params.aid);
    // 2026-05-28 P0#9: 跟 GET /shots/:sid/failures 一致显式接 ?slug=&epId=,
    // 不再走 locateShotById 找第一个匹配 (shotId 不全局唯一 — 新建 series 会拿到老
    // series 的 shot 失败记录, retry 跑错 episode_id).
    const querySlug = typeof req.query.slug === "string" ? req.query.slug : undefined;
    const queryEpId = typeof req.query.epId === "string" ? req.query.epId : undefined;
    let slug: string;
    let epId: string;
    let shotId: string;
    if (querySlug && queryEpId) {
      const { readShot } = await import("../../../repositories/shotRepo");
      const shot = await readShot(querySlug, queryEpId, sid);
      if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到 (slug=${querySlug}, epId=${queryEpId})`);
      slug = querySlug;
      epId = queryEpId;
      shotId = shot.id;
    } else {
      const loc = await locateShotById(sid);
      if (!loc) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
      slug = loc.slug;
      epId = loc.epId;
      shotId = loc.shotId;
    }
    const failures = await listShotFailuresWithId(sid);
    const failure = failures?.find((f) => f.attempt_id === aid);
    if (!failure) return err(res, 404, "NotFound", `failure ${aid} 未找到`);

    const isVideo = failure.stage === "video" || failure.stage === "generate_videos";
    const job = createPendingJob(isVideo ? "shot.video.retry" : "shot.firstframe.retry", {
      sid, slug, epId, aid,
    });
    attemptId = job.attempt_id;
    updatePendingJob(job.attempt_id, { status: "running", progress: 0.2, eta_s: 6 });
    const result = await orchestrator.orchestrate({
      series_slug: slug,
      episode_id: epId,
      action: isVideo ? "generate_videos" : "generate_first_frames",
      count_per_shot: 1,
      provider_override: providerIdFromModelRef(failure.model),
      model_ref_override: failure.model,
      only_shot_ids: [shotId],
      requestId: req.requestId,
      attempt_id: job.attempt_id,
    });
    res.json({ ok: true, attempt_id: job.attempt_id, job_id: result.job_id, tasks: result.tasks });
  } catch (e) {
    if (attemptId) failPendingJob(attemptId, { code: "DispatchFailed", message: e instanceof Error ? e.message : String(e) });
    next(e);
  }
});

failuresRouter.post("/shots/:sid/failures/:aid/retry-with-model", async (req: Request, res: Response, next) => {
  let attemptId: string | undefined;
  try {
    const sid = String(req.params.sid);
    const aid = String(req.params.aid);
    const { model } = req.body ?? {};
    if (typeof model !== "string" || !model.trim()) {
      return err(res, 400, "ValidationError", "model 必填 (完整 model_ref)");
    }
    // 2026-05-28 P0#9: 同 retry — 显式 ?slug=&epId= 定位, shotId 不全局唯一.
    const querySlug = typeof req.query.slug === "string" ? req.query.slug : undefined;
    const queryEpId = typeof req.query.epId === "string" ? req.query.epId : undefined;
    let slug: string;
    let epId: string;
    let shotId: string;
    if (querySlug && queryEpId) {
      const { readShot } = await import("../../../repositories/shotRepo");
      const shot = await readShot(querySlug, queryEpId, sid);
      if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到 (slug=${querySlug}, epId=${queryEpId})`);
      slug = querySlug;
      epId = queryEpId;
      shotId = shot.id;
    } else {
      const loc = await locateShotById(sid);
      if (!loc) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
      slug = loc.slug;
      epId = loc.epId;
      shotId = loc.shotId;
    }
    const failures = await listShotFailuresWithId(sid);
    const failure = failures?.find((f) => f.attempt_id === aid);
    if (!failure) return err(res, 404, "NotFound", `failure ${aid} 未找到`);

    const isVideo = failure.stage === "video" || failure.stage === "generate_videos";
    const job = createPendingJob(isVideo ? "shot.video.retry_with_model" : "shot.firstframe.retry_with_model", {
      sid, slug, epId, aid, model,
    });
    attemptId = job.attempt_id;
    updatePendingJob(job.attempt_id, { status: "running", progress: 0.2, eta_s: 6 });
    const result = await orchestrator.orchestrate({
      series_slug: slug,
      episode_id: epId,
      action: isVideo ? "generate_videos" : "generate_first_frames",
      count_per_shot: 1,
      provider_override: providerIdFromModelRef(model),
      model_ref_override: model,
      only_shot_ids: [shotId],
      requestId: req.requestId,
      attempt_id: job.attempt_id,
    });
    res.json({ ok: true, attempt_id: job.attempt_id, job_id: result.job_id, tasks: result.tasks });
  } catch (e) {
    if (attemptId) failPendingJob(attemptId, { code: "DispatchFailed", message: e instanceof Error ? e.message : String(e) });
    next(e);
  }
});

failuresRouter.delete("/shots/:sid/failures/:aid", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    const aid = String(req.params.aid);
    const ok = await dismissShotFailureById(sid, aid);
    if (!ok) return err(res, 404, "NotFound", `failure ${aid} 未找到`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
