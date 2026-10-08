import assert from "node:assert/strict";
import test from "node:test";

import { AttemptJobQueue } from "./queue";
import {
  registerPollerTask,
  runPollerTaskNow,
  stopJobsPoller,
  stopJobsPollerIfIdle,
} from "./poller";

test("AttemptJobQueue tracks queued, running, done, failed, and cancelled attempts", () => {
  const queue = new AttemptJobQueue(10);

  const done = queue.create("test.done", { shot_id: "s1" });
  assert.equal(done.status, "queued");

  const running = queue.update(done.attempt_id, { status: "running", progress: 0.5, eta_s: 3 });
  assert.equal(running?.status, "running");
  assert.equal(running?.progress, 0.5);

  const completed = queue.complete(done.attempt_id, { ok: true });
  assert.equal(completed?.status, "done");
  assert.equal(completed?.progress, 1);
  assert.deepEqual(completed?.result, { ok: true });

  const failed = queue.create("test.failed", {});
  queue.fail(failed.attempt_id, { code: "Boom", message: "failed" });
  assert.equal(queue.get(failed.attempt_id)?.status, "failed");
  assert.equal(queue.get(failed.attempt_id)?.error?.code, "Boom");

  const cancelled = queue.create("test.cancelled", {});
  queue.cancel(cancelled.attempt_id);
  assert.equal(queue.get(cancelled.attempt_id)?.status, "cancelled");
  assert.equal(queue.list({ status: "done" }).length, 1);
  assert.deepEqual(queue.stats(), {
    queued: 0,
    running: 0,
    done: 1,
    failed: 1,
    cancelled: 1,
    total: 3,
  });
});

test("AttemptJobQueue keeps terminal status stable", () => {
  const queue = new AttemptJobQueue();

  const cancelled = queue.create("test.cancelled", {});
  queue.cancel(cancelled.attempt_id);
  assert.equal(queue.update(cancelled.attempt_id, { status: "running", progress: 0.8 })?.status, "cancelled");
  assert.equal(queue.complete(cancelled.attempt_id, { late: true })?.status, "cancelled");
  assert.equal(queue.get(cancelled.attempt_id)?.result, undefined);

  const failed = queue.create("test.failed", {});
  queue.fail(failed.attempt_id, { code: "Boom", message: "failed" });
  assert.equal(queue.update(failed.attempt_id, { status: "running", progress: 0.8 })?.status, "failed");
  assert.equal(queue.complete(failed.attempt_id, { late: true })?.status, "failed");
  assert.equal(queue.get(failed.attempt_id)?.result, undefined);
});

test("jobs poller can run a registered task immediately", async () => {
  let calls = 0;
  const unregister = registerPollerTask("queue.test", () => {
    calls++;
  }, { intervalMs: 10_000 });

  try {
    await runPollerTaskNow("queue.test");
    assert.equal(calls, 1);
  } finally {
    unregister();
    stopJobsPollerIfIdle();
    stopJobsPoller();
  }
});

test("JobOrchestrator finalizes an attempt job after queued tasks settle", async () => {
  const { addShot, createEpisode, createSeries, deleteSeries } = await import("../api/v2/seriesStore");
  const { JobOrchestrator } = await import("./orchestrator");
  const { createPendingJob, getPendingJob } = await import("./pendingJobs");

  const series = await createSeries({
    title: `Attempt Queue Test ${Date.now()}`,
    defaults: { max_parallel_tasks: 1, max_retake_per_shot: 3 },
  });

  try {
    const episode = await createEpisode(series.slug, { title: "测试集" });
    await addShot(series.slug, episode.id, {
      title: "测试镜头",
      action: "测试动作",
      prompt_img: "simple image prompt",
      prompt_vid: "simple video prompt",
    });

    const pending = createPendingJob("test.orchestrate", {
      series_slug: series.slug,
      episode_id: episode.id,
    });
    const orch = new JobOrchestrator({ max_parallel: 1, default_retries: 0 });
    const { getRegistry } = await import("../api/v2/orchestration/_shared/registry");
    orch.setRegistry(getRegistry()); // 显式配置本地卡片渲染，不依赖已被移除的 mock runner。
    const result = await orch.orchestrate({
      series_slug: series.slug,
      episode_id: episode.id,
      action: "generate_first_frames",
      count_per_shot: 1,
      attempt_id: pending.attempt_id,
      // W7 (2026-05-15) — Bug 1: silent fallback 已去掉, 必须显式选 provider
      provider_override: "local_card_image",
    });

    assert.equal(result.task_count, 1);
    for (let i = 0; i < 20; i++) {
      if (getPendingJob(pending.attempt_id)?.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const finalJob = getPendingJob(pending.attempt_id);
    assert.equal(finalJob?.status, "done");
    assert.equal(finalJob?.progress, 1);
    assert.equal((finalJob?.result as { job_id?: string } | undefined)?.job_id, result.job_id);
  } finally {
    await deleteSeries(series.slug).catch(() => false);
  }
});
