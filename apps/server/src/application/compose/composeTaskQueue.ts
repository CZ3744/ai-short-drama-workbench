import crypto from "node:crypto";
import { scrubForClient, loggerSync } from "../../../../../packages/core/src/logger";
import { validate, ComposeSchema } from "../../api/v2/validators";
import {
  createTaskRecord,
  getTask,
  listTasks,
  readEpisode,
  updateTaskRecord,
} from "../../api/v2/seriesStore";
import { sseBroker } from "../../api/v2/sseBroker";

import {
  composeEpisode,
  isComposeRateLimitError,
  type ComposeEpisodeInput,
  type ComposeEpisodeResult,
  type RequestLog,
} from "./composeEpisode";
import {
  episodeComposeLockKey,
  tryAcquireEpisodeComposeLock,
  releaseEpisodeComposeLock,
  getEpisodeComposeLockHolder,
  composeLockBusyMessage,
} from "./composeLock";

type EnqueueComposeResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "queued"; body: { ok: true; job_id: string; task_id: string; status: "queued" } };

interface ComposeTaskRuntime {
  job_id: string;
  task_id: string;
  controller: AbortController;
  /** P1-2: 本 task 持有的每集互斥锁 key, runQueuedCompose finally 里据此释放 */
  lockKey: string;
}

const activeComposeTasks = new Map<string, ComposeTaskRuntime>();

const noopProgress = { progress: () => {} };

/**
 * 2026-05-28 P1-50: 启动恢复 — taskRepo.restoreTasks 已做 30 分钟僵尸翻 failed, 但
 * compose task 的 abort 路径走 activeComposeTasks Map (内存级 AbortController), 重启后
 * Map 空, 即使 task 在 jsonl 还显 running 也 abort 不了. 这里再扫一遍 compose kind 的
 * queued/running, 一律翻 failed + emit SSE, 用户 UI 不会再卡 "合成中…".
 *
 * apps/server/src/index.ts startup hook 调一次此函数.
 */
export async function recoverComposeTasksOnStartup(): Promise<{ marked_failed: number }> {
  try {
    const composeTasks = listTasks({ status: "running" }).filter((t) => t.kind === "compose");
    const queued = listTasks({ status: "queued" }).filter((t) => t.kind === "compose");
    const all = [...composeTasks, ...queued];
    if (all.length === 0) return { marked_failed: 0 };
    for (const t of all) {
      const msg = "server 重启时丢失 — fire-and-forget chain 无法跨进程恢复";
      updateTaskRecord(t.id, { status: "failed", error: msg });
      const epId = String(t.meta?.episode_id || t.meta?.ep_id || "");
      emitTaskFailed(t.job_id, t.id, epId, msg);
    }
    loggerSync().info(`[composeTaskQueue] 启动恢复: ${all.length} 个 compose task 翻 failed`);
    return { marked_failed: all.length };
  } catch (err) {
    loggerSync().warn(`[composeTaskQueue] 启动恢复失败: ${err instanceof Error ? err.message : err}`);
    return { marked_failed: 0 };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeComposeJobId(): string {
  return `compose_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 12)}`;
}

function errorMessageFromResult(result: Exclude<ComposeEpisodeResult, { kind: "json" }>): string {
  if (result.kind === "validation") return "请求体校验失败";
  const err = result.body.error;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return "合成失败";
}

function emitTaskQueued(job_id: string, task_id: string, episodeId: string): void {
  sseBroker.emit({
    type: "task.queued",
    job_id,
    task_id,
    data: { shot_id: "", action: "compose" },
    at: nowIso(),
  });
  sseBroker.emit({
    type: "compose.stage",
    job_id,
    task_id,
    data: { stage: "compose.queued", episode_id: episodeId, percent: 0 },
    at: nowIso(),
  });
}

function emitTaskRunning(job_id: string, task_id: string, episodeId: string): void {
  sseBroker.emit({
    type: "task.running",
    job_id,
    task_id,
    data: { action: "compose", episode_id: episodeId },
    at: nowIso(),
  });
}

function emitTaskDone(job_id: string, task_id: string, result: Record<string, unknown>): void {
  sseBroker.emit({
    type: "task.done",
    job_id,
    task_id,
    data: { shot_id: "", generation: result },
    at: nowIso(),
  });
}

function emitTaskFailed(job_id: string, task_id: string, episodeId: string, message: string): void {
  sseBroker.emit({
    type: "task.failed",
    job_id,
    task_id,
    data: { action: "compose", episode_id: episodeId, error: message },
    at: nowIso(),
  });
  sseBroker.emit({
    type: "compose.error",
    job_id,
    task_id,
    data: { error: message, episode_id: episodeId },
    at: nowIso(),
  });
}

async function runQueuedCompose(
  input: ComposeEpisodeInput,
  requestLog: RequestLog | undefined,
  runtime: ComposeTaskRuntime,
): Promise<void> {
  const { job_id, task_id, controller } = runtime;
  try {
    if (controller.signal.aborted) return;
    updateTaskRecord(task_id, { status: "running" });
    emitTaskRunning(job_id, task_id, input.episodeId);

    const result = await composeEpisode(input, {
      progress: noopProgress,
      requestLog,
      signal: controller.signal,
      taskContext: { job_id, task_id },
    });

    if (controller.signal.aborted) return;

    if (result.kind !== "json") {
      const message = errorMessageFromResult(result);
      updateTaskRecord(task_id, { status: "failed", error: message });
      emitTaskFailed(job_id, task_id, input.episodeId, message);
      return;
    }

    updateTaskRecord(task_id, { status: "done", result: result.body });
    emitTaskDone(job_id, task_id, result.body);
  } catch (err) {
    const message = controller.signal.aborted
      ? "用户已中止合成"
      : isComposeRateLimitError(err)
        ? scrubForClient(err.message)
        : scrubForClient(err instanceof Error ? err.message : String(err));
    updateTaskRecord(task_id, { status: "failed", error: message });
    emitTaskFailed(job_id, task_id, input.episodeId, message);
  } finally {
    activeComposeTasks.delete(task_id);
    // P1-2: 合成真正跑完(成功/失败/被 abort 都经此 finally)才释放锁 —
    // 绝不在 abortComposeTask 里提前释放, 否则旧 ffmpeg 还在收尾写文件时新合成就抢进来。
    releaseEpisodeComposeLock(runtime.lockKey, job_id);
  }
}

export async function enqueueComposeTask(
  input: ComposeEpisodeInput,
  deps: { requestLog?: RequestLog; requestId?: string },
): Promise<EnqueueComposeResult> {
  const v = validate(ComposeSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }

  const job_id = makeComposeJobId();
  const task_id = `task_${job_id}`;
  const mode = (v.data as { mode?: string }).mode || "full";

  // P1-2: 每集一把内存互斥锁 — 已有合成在跑(手动 rough/full/单镜重合成, 或一键管线的
  // compose 阶段)直接 409, 不让两个 ffmpeg 交错写同一批 compose 文件 / 双花 TTS。
  // 获取锁必须在最后一个 await(readEpisode)之后同步进行, tryAcquire 内 check→set 无 await,
  // 对事件循环原子, 两个并发请求只有一个拿得到。
  const lockKey = episodeComposeLockKey(input.slug, input.episodeId);
  const acquired = tryAcquireEpisodeComposeLock(lockKey, {
    job_id,
    task_id,
    source: "manual",
    mode,
    started_at: nowIso(),
  });
  if (!acquired) {
    const holder = getEpisodeComposeLockHolder(lockKey);
    return {
      kind: "error",
      status: 409,
      body: {
        error: {
          code: "ComposeInProgress",
          message: holder ? composeLockBusyMessage(holder) : "本集正在合成中，请等它完成后再试。",
          // 结构化持有者信息给前端接线("取消当前合成"), 不进用户可见句子(不泄漏技术 id)
          details: holder
            ? {
                job_id: holder.job_id,
                task_id: holder.task_id ?? null,
                pipeline_id: holder.pipeline_id ?? null,
                source: holder.source,
                started_at: holder.started_at,
              }
            : undefined,
        },
      },
    };
  }

  const controller = new AbortController();
  const runtime: ComposeTaskRuntime = { job_id, task_id, controller, lockKey };
  try {
    createTaskRecord({
      id: task_id,
      job_id,
      kind: "compose",
      provider_id: "compose",
      status: "queued",
      meta: {
        series_slug: input.slug,
        slug: input.slug,
        episode_id: input.episodeId,
        ep_id: input.episodeId,
        epId: input.episodeId,
        mode,
        action: "compose",
        requestId: deps.requestId,
      },
    });

    activeComposeTasks.set(task_id, runtime);
    emitTaskQueued(job_id, task_id, input.episodeId);

    setImmediate(() => {
      void runQueuedCompose(input, deps.requestLog, runtime);
    });
  } catch (err) {
    // 同步 setup 阶段抛错 → runQueuedCompose 不会跑, 其 finally 到不了, 手动释放锁避免泄漏。
    activeComposeTasks.delete(task_id);
    releaseEpisodeComposeLock(lockKey, job_id);
    throw err;
  }

  return { kind: "queued", body: { ok: true, job_id, task_id, status: "queued" } };
}

export async function abortComposeTask(
  taskId: string,
): Promise<{ ok: boolean; status: string; cancel_result?: string; reason?: string }> {
  const task = getTask(taskId);
  if (!task || task.kind !== "compose") {
    return { ok: false, status: "not_compose", reason: "不是合成任务" };
  }
  if (task.status === "done" || task.status === "failed") {
    return { ok: false, status: "terminal", reason: "任务已终态" };
  }

  const runtime = activeComposeTasks.get(taskId);
  runtime?.controller.abort();

  const message = "用户已中止合成";
  updateTaskRecord(taskId, { status: "failed", error: message });
  emitTaskFailed(task.job_id, taskId, String(task.meta?.episode_id || task.meta?.ep_id || ""), message);

  return { ok: true, status: "aborted_local", cancel_result: "aborted_local" };
}
