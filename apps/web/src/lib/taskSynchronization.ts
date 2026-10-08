import type { TaskKind, TaskRecord, TaskStatus } from "../stores/tasksStore";

export interface TaskStorePort {
  tasks: Record<string, TaskRecord>;
  upsertTask(task: TaskRecord): void;
  removeTask(id: string): void;
  markShotDirty(id: string): void;
}
interface BackendTask {
  id?: string;
  task_id?: string;
  kind?: string;
  status?: string;
  error?: string;
  meta?: Record<string, unknown>;
}
export interface TaskSyncOptions {
  getStore(): TaskStorePort;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
}
const kinds = new Set<string>(["image", "video", "tts", "llm", "compose"]);
const pending = (task: TaskRecord | undefined) => task?.status === "queued" || task?.status === "running";
const taskId = (task: BackendTask) => task.task_id || task.id || "";

function normalizeStatus(status: string | undefined): TaskStatus | undefined {
  switch (status) {
    case "done": case "succeeded": return "succeeded";
    case "failed": case "cancelled": case "aborted": return "failed";
    case "queued": case "running": return status;
    default: return undefined; // 未知状态不是成功，也不是排队。
  }
}

/**
 * HTTP 只负责补齐 SSE 可能遗漏的状态。所有写入重新读取 store；请求发出后由
 * SSE/用户操作更新过的记录不会被旧响应覆盖。只有明确 done 才能显示成功。
 */
export function createTaskSynchronizer(options: TaskSyncOptions): () => Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let inFlight: Promise<void> | undefined;

  async function readTasks(query: string): Promise<BackendTask[] | null> {
    try {
      const response = await fetcher(`/api/v2/tasks?${query}`, { signal: options.signal });
      if (!response.ok || options.signal?.aborted) return null;
      const payload: unknown = await response.json();
      if (options.signal?.aborted || !payload || typeof payload !== "object") return null;
      const tasks = (payload as { tasks?: unknown }).tasks;
      // 格式错误绝不视作空列表，否则会误清除仍在运行的任务。
      if (!Array.isArray(tasks) || !tasks.every(t => t && typeof t === "object" &&
        typeof (t.task_id || t.id) === "string" && (t.task_id || t.id).length > 0)) return null;
      return tasks;
    } catch {
      return null; // SSE 仍是主链路；下次 online/可见/定时触发重试，不伪造结果。
    }
  }

  function apply(remote: BackendTask, baseline: TaskRecord | undefined) {
    if (options.signal?.aborted) return;
    const id = taskId(remote);
    const store = options.getStore();
    const existing = store.tasks[id];
    if (existing !== baseline) return; // 请求期间已有更近的事件，保留它。
    const status = normalizeStatus(remote.status);
    const kind = remote.kind && kinds.has(remote.kind) ? remote.kind as TaskKind : existing?.kind;
    if (!status || !kind) return;
    if (existing && !pending(existing) && (status === "running" || status === "queued")) return;
    if (existing?.status === "running" && status === "queued") return;
    const meta = remote.meta;
    const field = (key: string, fallback?: string) => typeof meta?.[key] === "string" ? meta[key] as string : fallback;
    const next: TaskRecord = {
      ...existing,
      task_id: id, kind, status,
      shot_id: field("shot_id", existing?.shot_id),
      element_id: field("element_id", existing?.element_id),
      series_slug: field("series_slug", existing?.series_slug),
      ep_id: field("episode_id", existing?.ep_id),
      started_at: existing?.started_at ?? now(),
      progress: status === "succeeded" ? 100 : existing?.progress ?? 0,
      error_message: status === "failed"
        ? remote.error || existing?.error_message || (remote.status === "aborted" || remote.status === "cancelled" ? "任务已取消" : "任务失败")
        : undefined,
    };
    // 相同轮询结果不触发 localStorage 写入和全页面重新渲染。
    if (existing && Object.keys(next).every(key => next[key as keyof TaskRecord] === existing[key as keyof TaskRecord])) return;
    store.upsertTask(next);
    if (next.shot_id && existing?.status !== status) store.markShotDirty(next.shot_id);
  }

  async function reconcile() {
    if (options.signal?.aborted) return;
    const initial = { ...options.getStore().tasks };
    const [queued, running] = await Promise.all([readTasks("status=queued"), readTasks("status=running")]);
    if (!queued || !running || options.signal?.aborted) return;
    // running 后覆盖 queued，避免两份列表采集之间的状态前进被倒退。
    const active = new Map([...queued, ...running].map(t => [taskId(t), t]));
    for (const [id, remote] of active) apply(remote, initial[id]);

    const missing = Object.entries(options.getStore().tasks)
      .filter(([id, task]) => pending(task) && !active.has(id) && initial[id] === task).map(([id]) => id);
    for (let offset = 0; offset < missing.length; offset += 100) {
      if (options.signal?.aborted) return;
      const ids = missing.slice(offset, offset + 100);
      // Later batches must retain the original snapshot too: SSE may update an ID
      // while an earlier batch is in flight.
      const baseline = initial;
      const records = await readTasks(new URLSearchParams({ ids: ids.join(",") }).toString());
      if (!records || options.signal?.aborted) continue;
      const byId = new Map(records.map(record => [taskId(record), record]));
      for (const id of ids) {
        const remote = byId.get(id);
        if (remote) {
          apply(remote, baseline[id]);
        } else {
          const store = options.getStore();
          // 明确按 ID 查询且没有记录：清除过期占位，不把它伪装成成功。
          if (store.tasks[id] === baseline[id] && pending(store.tasks[id])) store.removeTask(id);
        }
      }
    }
  }

  return () => {
    if (!inFlight) inFlight = reconcile().finally(() => { inFlight = undefined; });
    return inFlight; // 多个触发源共享本轮请求，不叠加轮询。
  };
}
