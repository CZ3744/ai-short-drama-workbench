import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTaskSynchronizer, type TaskStorePort } from "./taskSynchronization";
import type { TaskRecord } from "../stores/tasksStore";

const task = (id = "t1", patch: Partial<TaskRecord> = {}): TaskRecord => ({
  task_id: id, kind: "video", status: "running", started_at: 10, progress: 72,
  shot_id: "shot1", series_slug: "demo", eta_s: 100, ...patch,
});
const json = (tasks: unknown) => Response.json({ tasks });
function storeOf(...initial: TaskRecord[]) {
  let tasks = Object.fromEntries(initial.map(t => [t.task_id, t]));
  const dirty: string[] = [];
  let writes = 0;
  const getStore = (): TaskStorePort => ({ tasks,
    upsertTask(t) { tasks = { ...tasks, [t.task_id]: t }; writes++; },
    removeTask(id) { const { [id]: _removed, ...rest } = tasks; tasks = rest; writes++; },
    markShotDirty(id) { dirty.push(id); },
  });
  return { getStore, dirty, get writes() { return writes; } };
}
function mockFetch(handler: (url: URL) => Response | Promise<Response>): typeof fetch {
  return (async input => handler(new URL(String(input), "http://fixture"))) as typeof fetch;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("task synchronization", () => {
  it("large queue batches never overwrite SSE changes received during a previous batch", async () => {
    const store = storeOf(...Array.from({ length: 250 }, (_, i) => task(`t${i}`)));
    let batches = 0;
    const sync = createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url => {
      const ids = url.searchParams.get("ids")?.split(",");
      if (!ids) return json([]);
      batches++;
      assert.ok(ids.length <= 100);
      if (batches === 1) {
        store.getStore().upsertTask(task("t150", { status: "failed", error_message: "SSE failure" }));
        store.getStore().removeTask("t151");
        store.getStore().upsertTask(task("t152", { status: "running", progress: 99 }));
      }
      return json(ids.map(id => ({ id, kind: "video", status: "done" })));
    }) });
    await sync();
    assert.equal(batches, 3);
    assert.equal(store.getStore().tasks.t150.error_message, "SSE failure");
    assert.equal(store.getStore().tasks.t151, undefined);
    assert.equal(store.getStore().tasks.t152.progress, 99);
    assert.equal(store.getStore().tasks.t249.status, "succeeded");
  });
  it("looks up a missing active task; does not invent success for a failed task", async () => {
    const store = storeOf(task());
    await createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url =>
      json(url.searchParams.has("ids") ? [{ id: "t1", status: "failed", error: "生成失败" }] : [])) })();
    assert.equal(store.getStore().tasks.t1.status, "failed");
    assert.equal(store.getStore().tasks.t1.error_message, "生成失败");
    assert.deepEqual(store.dirty, ["shot1"]);
  });

  it("accepts an explicit done result and preserves metadata", async () => {
    const store = storeOf(task());
    await createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url =>
      json(url.searchParams.has("ids") ? [{ id: "t1", status: "done" }] : [])) })();
    assert.equal(store.getStore().tasks.t1.status, "succeeded");
    assert.equal(store.getStore().tasks.t1.progress, 100);
    assert.equal(store.getStore().tasks.t1.eta_s, 100);
    assert.equal(store.getStore().tasks.t1.started_at, 10);
  });

  for (const invalid of [null, {}, { tasks: null }, { tasks: [null] }, { tasks: [{}] }]) {
    it(`does not delete tasks for malformed detail response ${JSON.stringify(invalid)}`, async () => {
      const original = task();
      const store = storeOf(original);
      await createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url =>
        url.searchParams.has("ids") ? Response.json(invalid) : json([])) })();
      assert.equal(store.getStore().tasks.t1, original);
      assert.equal(store.writes, 0);
    });
  }

  it("preserves tasks when one active query fails", async () => {
    const store = storeOf(task());
    await createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url =>
      url.searchParams.get("status") === "running" ? new Response("failed", { status: 503 }) : json([])) })();
    assert.equal(store.writes, 0);
  });

  it("does not downgrade an SSE completion received during the active request", async () => {
    const store = storeOf(task());
    const delayed = deferred<Response>();
    const sync = createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url =>
      url.searchParams.get("status") === "running" ? delayed.promise : json([])) });
    const done = sync();
    const newer = task("t1", { status: "succeeded", progress: 100 });
    store.getStore().upsertTask(newer);
    delayed.resolve(json([{ id: "t1", kind: "video", status: "running" }]));
    await done;
    assert.equal(store.getStore().tasks.t1, newer);
  });

  it("does not erase an SSE result received during missing-ID lookup", async () => {
    const store = storeOf(task());
    const lookupStarted = deferred<void>();
    const delayed = deferred<Response>();
    const sync = createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url => {
      if (url.searchParams.has("ids")) { lookupStarted.resolve(); return delayed.promise; }
      return json([]);
    }) });
    const done = sync();
    await lookupStarted.promise;
    const newer = task("t1", { status: "failed", error_message: "稍后收到的真实失败" });
    store.getStore().upsertTask(newer);
    delayed.resolve(json([]));
    await done;
    assert.equal(store.getStore().tasks.t1, newer);
  });

  it("does not remove a task added after active-list polling began", async () => {
    const store = storeOf();
    const delayed = deferred<Response>();
    const sync = createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url =>
      url.searchParams.get("status") === "running" ? delayed.promise : json([])) });
    const done = sync();
    const newlyQueued = task("t1", { status: "queued" });
    store.getStore().upsertTask(newlyQueued);
    delayed.resolve(json([]));
    await done;
    assert.equal(store.getStore().tasks.t1, newlyQueued);
  });

  it("coalesces overlapping triggers and permits a later refresh", async () => {
    const store = storeOf();
    const delayed = deferred<Response>();
    let calls = 0;
    const sync = createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url => {
      calls++;
      return url.searchParams.get("status") === "running" ? delayed.promise : json([]);
    }) });
    const first = sync();
    assert.equal(first, sync());
    assert.equal(calls, 2);
    delayed.resolve(json([]));
    await first;
    await sync();
    assert.equal(calls, 4);
  });

  it("does not write after lifecycle cancellation", async () => {
    const store = storeOf(task());
    const controller = new AbortController();
    const delayed = deferred<Response>();
    const sync = createTaskSynchronizer({ getStore: store.getStore, signal: controller.signal,
      fetcher: mockFetch(url => url.searchParams.get("status") === "running" ? delayed.promise : json([])) });
    const done = sync();
    controller.abort();
    delayed.resolve(json([{ id: "t1", status: "done" }]));
    await done;
    assert.equal(store.writes, 0);
  });

  it("does not invent progress or rerender identical active records", async () => {
    const store = storeOf(task());
    const sync = createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url =>
      json(url.searchParams.get("status") === "running" ? [{ id: "t1", kind: "video", status: "running" }] : [])) });
    await sync(); await sync();
    assert.equal(store.getStore().tasks.t1.progress, 72);
    assert.equal(store.writes, 0);
  });

  it("keeps unknown status untouched instead of treating it as successful", async () => {
    const store = storeOf(task());
    await createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url =>
      json(url.searchParams.has("ids") ? [{ id: "t1", status: "future_state" }] : [])) })();
    assert.equal(store.writes, 0);
  });

  it("removes a confirmed missing record without writing a fake success", async () => {
    const store = storeOf(task());
    await createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(() => json([])) })();
    assert.deepEqual(store.getStore().tasks, {});
    assert.equal(store.dirty.length, 0);
  });

  it("batches missing IDs in groups of at most 100", async () => {
    const store = storeOf(...Array.from({ length: 205 }, (_, i) => task(`t${i}`)));
    const sizes: number[] = [];
    await createTaskSynchronizer({ getStore: store.getStore, fetcher: mockFetch(url => {
      const ids = url.searchParams.get("ids");
      if (ids) sizes.push(ids.split(",").length);
      return json([]);
    }) })();
    assert.deepEqual(sizes, [100, 100, 5]);
    assert.equal(Object.keys(store.getStore().tasks).length, 0);
  });
});
