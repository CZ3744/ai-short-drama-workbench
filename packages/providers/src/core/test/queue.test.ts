// P20: TaskQueue tests

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskQueue, type Task, type TaskStatus } from "../queue";
import { ProviderError } from "../errors";

function makeTask(id: string, overrides?: Partial<Task>): Task<unknown, unknown> {
  return {
    id,
    kind: "image",
    provider_id: "test",
    input: {},
    meta: { series_slug: "s1", job_id: "j1", purpose: "test" },
    retries_remaining: 3,
    timeout_ms: 5000,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TaskQueue", () => {
  it("concurrency control: 10 tasks, max_parallel=3, ~333ms total", async () => {
    const queue = new TaskQueue({
      max_parallel: 3,
      default_retries: 0,
      default_timeout_ms: 10000,
    });

    const start = Date.now();
    const promises: Promise<string>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        queue.enqueue(makeTask(`t${i}`) as Task<unknown, string>, async () => {
          await sleep(100);
          return `done-${i}`;
        })
      );
    }
    const results = await Promise.all(promises);
    const elapsed = Date.now() - start;

    assert.equal(results.length, 10);
    // With 10 tasks at 100ms each and max_parallel=3:
    // ceil(10/3) * 100 = 400ms (3 batches of 3 + 1 batch of 1)
    assert.ok(elapsed >= 300, `Expected >=300ms, got ${elapsed}ms`);
    assert.ok(elapsed <= 800, `Expected <=800ms, got ${elapsed}ms`);

    const stats = queue.stats();
    assert.equal(stats.done, 10);
    assert.equal(stats.failed, 0);
    assert.equal(stats.queued, 0);
    assert.equal(stats.running, 0);
  });

  it("retry: runner throws retriable error twice, then succeeds", async () => {
    const queue = new TaskQueue({
      max_parallel: 1,
      default_retries: 3,
      default_timeout_ms: 5000,
    });

    let attempts = 0;
    const result = await await queue.enqueue(
      makeTask("retry-task", { retries_remaining: 3 }),
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new ProviderError({
            message: "rate limited",
            code: "rate_limit",
            provider_id: "test",
            retriable: true,
          });
        }
        return "success";
      }
    );

    assert.equal(result, "success");
    assert.equal(attempts, 3);
  });

  it("no local timeout: runner outlasts timeout_ms yet still completes (铁律1)", async () => {
    const queue = new TaskQueue({
      max_parallel: 1,
      default_retries: 0,
      default_timeout_ms: 5000,
    });

    // 铁律1：队列不再执行本地 timeout（default_timeout_ms 已 @deprecated）。
    // 即使运行耗时(100ms)远超 timeout_ms(50)，任务也应正常跑完并返回结果，
    // 而不是被本地中止抛 timeout。本地主动 abort 由“abort by task id”用例覆盖。
    const result = await queue.enqueue(
      makeTask("timeout-task", { timeout_ms: 50, retries_remaining: 0 }),
      async () => {
        await sleep(100);
        return "completed";
      }
    );
    assert.equal(result, "completed");
  });

  it("abort by task id", async () => {
    const queue = new TaskQueue({
      max_parallel: 1,
      default_retries: 0,
      default_timeout_ms: 10000,
    });

    // First task occupies the slot
    const blocker = queue.enqueue(makeTask("blocker"), async () => {
      await sleep(200);
      return "blocked";
    });

    // Second task gets queued
    const abortable = queue.enqueue(makeTask("abortable"), async () => {
      return "should not run";
    });

    queue.abort("abortable");

    await blocker;
    await assert.rejects(() => abortable);
  });

  it("abortJob aborts all tasks in a job", async () => {
    const queue = new TaskQueue({
      max_parallel: 5,
      default_retries: 0,
      default_timeout_ms: 10000,
    });

    const p1 = queue.enqueue(
      makeTask("j1-t1", { meta: { series_slug: "s1", job_id: "job-x", purpose: "test" } }),
      async (_task, ctx) => {
        await sleep(500);
        if (ctx.signal.aborted) throw new Error("aborted");
        return "a";
      }
    );
    const p2 = queue.enqueue(
      makeTask("j1-t2", { meta: { series_slug: "s1", job_id: "job-x", purpose: "test" } }),
      async (_task, ctx) => {
        await sleep(500);
        if (ctx.signal.aborted) throw new Error("aborted");
        return "b";
      }
    );

    // Give tasks a moment to start, then abort the job
    await sleep(20);
    queue.abortJob("job-x");

    const results = await Promise.allSettled([p1, p2]);
    // At least one should be rejected; both might already be running
    const rejectedCount = results.filter(r => r.status === "rejected").length;
    assert.ok(rejectedCount >= 1, `Expected at least 1 rejected, got ${rejectedCount}`);
  });
});
