/**
 * v2 Task Controller — List, read, abort tasks + SSE events
 */

import { Router } from "express";
import { listTasks, getTask, updateTaskRecord } from "./seriesStore";
import { sseBroker } from "./sseBroker";
import { orchestrator } from "../../jobs/orchestrator";
import { abortComposeTask } from "../../application/compose/composeTaskQueue";

export const taskRouter = Router();

// GET /tasks  (也支持 ?ids=a,b,c batch lookup — 客户端 SSE 漏推时兜底)
taskRouter.get("/tasks", async (req, res, next) => {
  try {
    // 2026-05-27 — 批量按 task_id 查询: SSE 漏推时, 客户端把卡在 queued/running
    // 的 task_id 一次性传过来, 后端直接查 jsonl 最新状态返回. 比 status= 全量过滤
    // 然后客户端 diff 便宜得多.
    const idsParam = req.query.ids as string | undefined;
    if (idsParam) {
      const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
      const tasks = ids.map((id) => getTask(id)).filter((t) => t != null);
      res.json({ tasks });
      return;
    }
    const filter = {
      job_id: req.query.job_id as string | undefined,
      status: req.query.status as string | undefined,
    };
    const tasks = listTasks(filter);
    res.json({ tasks });
  } catch (err) { next(err); }
});

// GET /tasks/:id
taskRouter.get("/tasks/:id", async (req, res, next) => {
  try {
    const task = getTask(req.params.id);
    if (!task) { res.status(404).json({ error: { code: "NotFound", message: "任务不存在" } }); return; }
    res.json({ task });
  } catch (err) { next(err); }
});

// POST /tasks/:id/abort
taskRouter.post("/tasks/:id/abort", async (req, res, next) => {
  try {
    const task = getTask(req.params.id);
    if (!task) { res.status(404).json({ error: { code: "NotFound", message: "任务不存在" } }); return; }

    if (task.status === "done" || task.status === "failed") {
      res.status(409).json({ error: { code: "Conflict", message: "任务已完成或失败，无法中止" } });
      return;
    }

    // compose 不走 provider TaskQueue,由 composeTaskQueue 持有 AbortController。
    const result = task.kind === "compose"
      ? await abortComposeTask(req.params.id)
      : await orchestrator.abortTask(req.params.id);

    const reqLog = req.log;
    if (reqLog) reqLog.info({ task_id: req.params.id, abort_status: result.status, cancel_result: result.cancel_result }, "ABORT task");

    if (!result.ok) {
      res.status(409).json({ error: { code: "Conflict", message: result.reason } });
      return;
    }

    res.json({ ok: true, message: "任务已中止", status: result.status, cancel_result: result.cancel_result });
  } catch (err) { next(err); }
});

// P170 1B: GET /jobs/:job_id — 轮询回退端点，返回 job 状态和统计
taskRouter.get("/jobs/:job_id", async (req, res, next) => {
  try {
    const tasks = listTasks({ job_id: req.params.job_id });
    const done = tasks.filter(t => t.status === "done").length;
    const failed = tasks.filter(t => t.status === "failed").length;
    const running = tasks.filter(t => t.status === "running").length;
    const queued = tasks.filter(t => t.status === "queued").length;

    let status: string;
    if (tasks.length === 0) {
      status = "unknown";
    } else if (failed === tasks.length) {
      status = "failed";
    } else if (done + failed === tasks.length) {
      status = "done";
    } else if (running > 0) {
      status = "running";
    } else {
      status = "queued";
    }

    // 查找 done 任务的 final_video_path
    const doneTask = tasks.find(t => t.status === "done");
    const doneResult = doneTask?.result;
    const finalPath = (doneResult !== null && typeof doneResult === "object" && "final_video_path" in doneResult)
      ? (doneResult as Record<string, unknown>).final_video_path ?? null
      : null;
    const errorMsg = tasks.find(t => t.error)?.error ?? null;

    res.json({
      job_id: req.params.job_id,
      status,
      final_path: finalPath,
      error: errorMsg,
      stats: { total: tasks.length, done, failed, running, queued },
    });
  } catch (err) { next(err); }
});

// GET /events — SSE endpoint (job-specific or global)
taskRouter.get("/events", async (req, res, next) => {
  try {
    const job_id = req.query.job_id as string;
    const series_slug = req.query.series_slug as string;

    // C2: Extract Last-Event-ID from header (native EventSource reconnect)
    // or query param (manual reconnect via new EventSource URL)
    const rawId = (req.headers["last-event-id"] as string) ?? (req.query.lastEventId as string);
    const lastEventId = rawId != null ? Number(rawId) : undefined;

    if (job_id) {
      sseBroker.subscribe(job_id, res, lastEventId);
    } else {
      // W7-sse-fix (2026-05-15): 根本修复 series_slug 永远收不到 task.done 的 bug。
      // 之前 series_slug → subscribe("series:<slug>") 作为 pseudo channel,但 orchestrator
      // emit 的 event.job_id 是 "job_xxx_yyy"(uuid),sseBroker.emit filter
      // (`jid === event.job_id || jid === GLOBAL`)对 "series:<slug>" client 永不匹配
      // → 用户看不到自动刷新,必须 F5。
      // 现在 series_slug 与无参数订阅都走 __global__ 单 channel(D1 设计),前端
      // buildTaskEventHandlers 已按 shot_id 客户端路由(markShotDirty(shotId)),不依赖
      // 服务端 series filter。可选的 series_slug 留在 req.query 仅做日志/统计用。
      void series_slug;
      sseBroker.subscribe("__global__", res, lastEventId);
    }
    // Connection stays open — cleanup handled by SSE broker on 'close'
  } catch (err) { next(err); }
});
