import { loggerSync } from "../../../../packages/core/src/logger";

export type PollerTask = () => Promise<void> | void;

interface RegisteredPollerTask {
  name: string;
  intervalMs: number;
  run: PollerTask;
  running: boolean;
  lastRunAt: number;
}

const DEFAULT_TICK_MS = 1_000;
const tasks = new Map<string, RegisteredPollerTask>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function registerPollerTask(name: string, run: PollerTask, opts?: { intervalMs?: number }): () => void {
  tasks.set(name, {
    name,
    intervalMs: opts?.intervalMs ?? DEFAULT_TICK_MS,
    run,
    running: false,
    lastRunAt: 0,
  });
  return () => {
    tasks.delete(name);
  };
}

export function startJobsPoller(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void runDuePollerTasks();
  }, DEFAULT_TICK_MS);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
  loggerSync().info("[jobs/poller] started");
}

export function stopJobsPoller(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  loggerSync().info("[jobs/poller] stopped");
}

export function stopJobsPollerIfIdle(): void {
  if (tasks.size === 0) stopJobsPoller();
}

export async function runPollerTaskNow(name: string): Promise<void> {
  const task = tasks.get(name);
  if (!task) return;
  await runOne(task, Date.now(), true);
}

export async function runDuePollerTasks(): Promise<void> {
  const now = Date.now();
  await Promise.all(Array.from(tasks.values()).map((task) => runOne(task, now, false)));
}

async function runOne(task: RegisteredPollerTask, now: number, force: boolean): Promise<void> {
  if (task.running) return;
  if (!force && now - task.lastRunAt < task.intervalMs) return;
  task.running = true;
  task.lastRunAt = now;
  try {
    await task.run();
  } catch (err) {
    loggerSync().error(`[jobs/poller] ${task.name} failed:`, err instanceof Error ? err.message : err);
  } finally {
    task.running = false;
  }
}
