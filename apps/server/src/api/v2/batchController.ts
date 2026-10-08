/**
 * v24-batch-all · 批量 dry-run / execute / cancel
 *
 * POST /api/v2/batch/dry-run   · 不调 provider, 仅预估
 * POST /api/v2/batch/execute   · 创建 batch_id + pendingJob, 并逐项派发到 orchestrator / 后期设置
 * POST /api/v2/batch/:bid/cancel · 取消
 */

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  createPendingJob,
  updatePendingJob,
  completePendingJob,
  failPendingJob,
  cancelPendingJob,
} from "../../jobs/pendingJobs";
import { orchestrator } from "../../jobs/orchestrator";
import { listShots, readShot, locateShotMatches, updateShot, type ShotData } from "./seriesStore";

export const batchRouter = Router();

interface BatchTarget {
  sid: string;
  action: "firstframe" | "video" | "subtitle_burn" | "compose";
  params?: Record<string, unknown>;
}

interface BatchTargetResult {
  sid: string;
  action: BatchTarget["action"];
  status: "queued" | "applied" | "skipped" | "failed";
  job_id?: string;
  tasks?: Array<{ task_id: string; shot_id: string; status: string }>;
  affected_shots?: number;
  error?: string;
  message?: string;
}

const batchAttemptIndex = new Map<string, string>();

function estimateCost(action: BatchTarget["action"]): { cost: number; duration: number; warnings?: string[] } {
  switch (action) {
    case "firstframe":  return { cost: 1.0, duration: 6 };
    case "video":       return { cost: 0.62, duration: 85 };
    case "subtitle_burn": return { cost: 0, duration: 8 };
    case "compose":     return { cost: 0, duration: 20 };
    default:            return { cost: 0, duration: 0, warnings: ["未知 action"] };
  }
}

function getProviderOverride(params: Record<string, unknown> | undefined): string | undefined {
  const raw = params?.provider_override ?? params?.provider ?? params?.model;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function getPromptOverride(params: Record<string, unknown> | undefined, key: "prompt_override" | "motion_prompt"): string | undefined {
  const raw = params?.[key] ?? params?.prompt;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function getCount(params: Record<string, unknown> | undefined, fallback: number): number {
  const n = Number(params?.count);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
}

function getSeed(params: Record<string, unknown> | undefined): number | undefined {
  const raw = params?.seed;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : undefined;
}

type BatchLocator = { slug: string; epId: string; shotId: string };

/**
 * 2026-07-22 X3-3 (A3-4): 批量目标的安全定位, 替代裸 locateShotById(取第一个命中).
 * 优先用 target.params 里的 slug/epId 精确定位; 无上下文时全扫: 0=未找到 / 1=唯一 /
 * >1=歧义(不猜, 返回可读错误让该目标 failed, 不会批量扣错分镜的钱). 与 resolveFlatShotLocatorOrErr 同策略.
 */
async function resolveBatchTargetLocator(
  target: BatchTarget,
): Promise<{ ok: true; loc: BatchLocator } | { ok: false; error: string }> {
  const p = target.params ?? {};
  const ctxSlug = typeof p.slug === "string" && p.slug.trim() ? p.slug.trim() : undefined;
  const ctxEpId = typeof p.epId === "string" && p.epId.trim() ? p.epId.trim() : undefined;
  if (ctxSlug && ctxEpId) {
    const shot = await readShot(ctxSlug, ctxEpId, target.sid);
    if (!shot) return { ok: false, error: `shot ${target.sid} 未找到` };
    return { ok: true, loc: { slug: ctxSlug, epId: ctxEpId, shotId: shot.id } };
  }
  const matches = await locateShotMatches(target.sid);
  if (matches.length === 1) return { ok: true, loc: matches[0] };
  if (matches.length > 1) {
    return { ok: false, error: "该分镜编号在多个剧集里都存在，请从分镜板选中分镜后再批量操作。" };
  }
  return { ok: false, error: `shot ${target.sid} 未找到` };
}

async function dispatchGenerationTarget(target: BatchTarget, req: Request): Promise<BatchTargetResult> {
  const resolved = await resolveBatchTargetLocator(target);
  if (!resolved.ok) {
    return { sid: target.sid, action: target.action, status: "failed", error: resolved.error };
  }
  const loc = resolved.loc;
  const params = target.params ?? {};
  const isVideo = target.action === "video";
  const result = await orchestrator.orchestrate({
    series_slug: loc.slug,
    episode_id: loc.epId,
    action: isVideo ? "generate_videos" : "generate_first_frames",
    count_per_shot: getCount(params, 1),
    provider_override: getProviderOverride(params),
    prompt_override: getPromptOverride(params, isVideo ? "motion_prompt" : "prompt_override"),
    seed_override: getSeed(params),
    only_shot_ids: [loc.shotId],
    requestId: req.requestId,
  });
  return {
    sid: target.sid,
    action: target.action,
    status: "queued",
    job_id: result.job_id,
    tasks: result.tasks,
  };
}

async function applyPostSettingsToEpisode(target: BatchTarget): Promise<BatchTargetResult> {
  // 2026-07-22 X3-3 (A3-4): 安全定位, 同 dispatchGenerationTarget — 歧义不猜.
  const resolved = await resolveBatchTargetLocator(target);
  if (!resolved.ok) {
    return { sid: target.sid, action: target.action, status: "failed", error: resolved.error };
  }
  const loc = resolved.loc;
  const shot = await readShot(loc.slug, loc.epId, loc.shotId);
  if (!shot) {
    return { sid: target.sid, action: target.action, status: "failed", error: `shot ${target.sid} 未找到` };
  }
  const paramsPost = target.params?.post_production ?? target.params?.post;
  // 2026-05-28 audit P1 type-safety — ShotData 没声明 post_production (legacy 历史 ad-hoc 字段),
  // 走 unknown narrowing 替代 (shot as any).post_production
  const shotRec = shot as unknown as Record<string, unknown>;
  const postProduction = (paramsPost && typeof paramsPost === "object")
    ? paramsPost
    : shotRec.post_production;
  if (!postProduction || typeof postProduction !== "object") {
    return {
      sid: target.sid,
      action: target.action,
      status: "skipped",
      message: "当前 shot 没有可批量应用的后期/字幕设置",
    };
  }

  const onlyShotIds = Array.isArray(target.params?.only_shot_ids)
    ? new Set((target.params?.only_shot_ids as unknown[]).filter((x): x is string => typeof x === "string"))
    : null;
  const shots = await listShots(loc.slug, loc.epId);
  let affected = 0;
  for (const item of shots) {
    if (onlyShotIds && !onlyShotIds.has(item.id)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ShotData 没声明 post_production, legacy ad-hoc 字段透传写盘
    const updated = await updateShot(loc.slug, loc.epId, item.id, {
      post_production: postProduction,
    } as Partial<ShotData>);
    if (updated) affected++;
  }
  return {
    sid: target.sid,
    action: target.action,
    status: "applied",
    affected_shots: affected,
    message: "已把当前后期/字幕设置应用到本集镜头",
  };
}

batchRouter.post("/batch/dry-run", (req: Request, res: Response) => {
  const targets = Array.isArray(req.body?.targets) ? (req.body.targets as BatchTarget[]) : [];
  if (targets.length === 0) {
    return res.status(400).json({ error: { code: "ValidationError", message: "targets 必填且非空" } });
  }
  let totalCost = 0;
  let totalDuration = 0;
  const per = targets.map((t) => {
    const est = estimateCost(t.action);
    totalCost += est.cost;
    totalDuration += est.duration;
    return { sid: t.sid, estimated_cost_cny: est.cost, estimated_duration_s: est.duration, warnings: est.warnings };
  });
  res.json({ ok: true, total_estimated_cost_cny: totalCost, total_estimated_duration_s: totalDuration, per_target: per });
});

batchRouter.post("/batch/execute", async (req: Request, res: Response, next) => {
  const targets = Array.isArray(req.body?.targets) ? (req.body.targets as BatchTarget[]) : [];
  if (targets.length === 0) {
    return res.status(400).json({ error: { code: "ValidationError", message: "targets 必填且非空" } });
  }
  const batch_id = `batch_${randomUUID().slice(0, 8)}`;
  const job = createPendingJob("batch.execute", { batch_id, count: targets.length, targets });
  batchAttemptIndex.set(batch_id, job.attempt_id);

  try {
    updatePendingJob(job.attempt_id, { status: "running", progress: 0.05, eta_s: Math.max(1, targets.length) * 8 });
    const results: BatchTargetResult[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        if (target.action === "firstframe" || target.action === "video") {
          results.push(await dispatchGenerationTarget(target, req));
        } else if (target.action === "subtitle_burn") {
          results.push(await applyPostSettingsToEpisode(target));
        } else {
          results.push({
            sid: target.sid,
            action: target.action,
            status: "skipped",
            message: "compose 请使用 /api/v2/series/:slug/episodes/:epId/compose 提交整集合成",
          });
        }
      } catch (error) {
        results.push({
          sid: target.sid,
          action: target.action,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      updatePendingJob(job.attempt_id, {
        status: "running",
        progress: Math.min(0.95, (i + 1) / targets.length),
      });
    }
    completePendingJob(job.attempt_id, { batch_id, results });
    res.json({ ok: true, batch_id, attempt_id: job.attempt_id, results });
  } catch (error) {
    failPendingJob(job.attempt_id, { code: "BatchFailed", message: error instanceof Error ? error.message : String(error) });
    next(error);
  }
});

batchRouter.post("/batch/:bid/cancel", (req: Request, res: Response) => {
  const bid = String(req.params.bid);
  const attemptId = batchAttemptIndex.get(bid) ?? bid;
  const job = cancelPendingJob(attemptId);
  if (!job) return res.status(404).json({ error: { code: "NotFound", message: `batch ${bid} 未找到` } });
  res.json({ ok: true, status: job.status });
});
