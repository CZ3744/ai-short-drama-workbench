// T08: Task queue manager — session-bound queue with budget cap + ordering
import { getDb } from "./database";
import { ulid } from "ulid";

export interface QueueTask {
  id: string;
  project_id: string;
  episode_id: string | null;
  shot_stable_id: string | null;
  task_type: "generate_video" | "generate_image" | "generate_tts" | "render";
  provider: string;
  model: string | null;
  priority: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  estimated_cost_cny: number;
  estimated_duration_sec: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  failed_reason: string | null;
}

export function enqueueTask(input: {
  project_id: string;
  episode_id?: string;
  shot_stable_id?: string;
  task_type: QueueTask["task_type"];
  provider: string;
  model?: string;
  priority?: number;
  estimated_cost_cny?: number;
  estimated_duration_sec?: number;
}): QueueTask {
  const db = getDb();
  const now = new Date().toISOString();
  const id = ulid();

  // 2026-05-28 audit P0-12: SELECT MAX + INSERT 必须包事务. 之前两条 statement 之间
  // 另一个 enqueue 并发跑进来会读到同一个 max → 两个 task priority 冲突, listQueueTasks
  // ORDER BY priority 不稳定. better-sqlite3 同步 API 单进程内仍可能因 setImmediate / 回调
  // 交错出问题, 用 db.transaction 把 SELECT + INSERT 锁起来.
  const tx = db.transaction((): void => {
    const maxPrio = db.prepare("SELECT MAX(priority) as mp FROM task_queue WHERE status = 'queued'").get() as any;
    const priority = input.priority ?? ((maxPrio?.mp ?? 0) + 1);

    db.prepare(`INSERT INTO task_queue (id, project_id, episode_id, shot_stable_id, task_type, provider, model, priority, status, estimated_cost_cny, estimated_duration_sec, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(
      id, input.project_id, input.episode_id ?? null, input.shot_stable_id ?? null,
      input.task_type, input.provider, input.model ?? null, priority,
      input.estimated_cost_cny ?? 0, input.estimated_duration_sec ?? 60, now
    );
  });
  tx();
  return getQueueTask(id)!;
}

export function getQueueTask(id: string): QueueTask | undefined {
  return getDb().prepare("SELECT * FROM task_queue WHERE id = ?").get(id) as QueueTask | undefined;
}

export function listQueueTasks(filter?: { status?: string; project_id?: string }): QueueTask[] {
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.status) { conditions.push("status = ?"); params.push(filter.status); }
  if (filter?.project_id) { conditions.push("project_id = ?"); params.push(filter.project_id); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return getDb().prepare(`SELECT * FROM task_queue ${where} ORDER BY priority ASC, created_at ASC`).all(...params) as QueueTask[];
}

export function updateTaskStatus(id: string, status: QueueTask["status"], error?: string): QueueTask | undefined {
  ensureTaskQueueTable();
  const db = getDb();
  const now = new Date().toISOString();
  if (status === "running") {
    db.prepare("UPDATE task_queue SET status=?, started_at=?, failed_reason=NULL WHERE id=?").run(status, now, id);
  } else if (status === "completed" || status === "failed" || status === "cancelled") {
    db.prepare("UPDATE task_queue SET status=?, completed_at=?, error=?, failed_reason=? WHERE id=?").run(
      status,
      now,
      error ?? null,
      status === "failed" ? (error ?? "failed") : null,
      id
    );
  } else {
    db.prepare("UPDATE task_queue SET status=? WHERE id=?").run(status, id);
  }
  return getQueueTask(id);
}

export function popNext(): QueueTask | undefined {
  ensureTaskQueueTable();
  const db = getDb();
  const tx = db.transaction(() => {
    const running = db.prepare("SELECT COUNT(*) as count FROM task_queue WHERE status = 'running'").get() as { count: number };
    if (running.count > 0) return undefined;

    const next = db.prepare(`
      SELECT * FROM task_queue
      WHERE status = 'queued'
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `).get() as QueueTask | undefined;
    if (!next) return undefined;

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE task_queue
      SET status = 'running', started_at = ?, completed_at = NULL, error = NULL, failed_reason = NULL
      WHERE id = ? AND status = 'queued'
    `).run(now, next.id);

    return db.prepare("SELECT * FROM task_queue WHERE id = ?").get(next.id) as QueueTask | undefined;
  });
  return tx();
}

export function markRunningTasksFailedOnStartup(reason = "server_restart"): QueueTask[] {
  ensureTaskQueueTable();
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const running = db.prepare("SELECT * FROM task_queue WHERE status = 'running'").all() as QueueTask[];
    if (running.length === 0) return [];
    const stmt = db.prepare(`
      UPDATE task_queue
      SET status = 'failed', completed_at = ?, error = ?, failed_reason = ?
      WHERE id = ?
    `);
    for (const task of running) {
      stmt.run(now, reason, reason, task.id);
    }
    return running.map((task) => db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task.id) as QueueTask);
  });
  return tx();
}

export function reorderTasks(taskIds: string[]): void {
  const db = getDb();
  const tx = db.transaction(() => {
    for (let i = 0; i < taskIds.length; i++) {
      db.prepare("UPDATE task_queue SET priority = ? WHERE id = ?").run(i + 1, taskIds[i]);
    }
  });
  tx();
}

export function cancelQueuedTasks(project_id?: string): number {
  const result = project_id
    ? getDb().prepare("UPDATE task_queue SET status='cancelled', completed_at=? WHERE status='queued' AND project_id=?").run(new Date().toISOString(), project_id)
    : getDb().prepare("UPDATE task_queue SET status='cancelled', completed_at=? WHERE status='queued'").run(new Date().toISOString());
  return result.changes;
}

export function getQueueStats(project_id?: string): {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  total_estimated_cost: number;
} {
  const db = getDb();
  const where = project_id ? "WHERE project_id = ?" : "";
  const params = project_id ? [project_id] : [];
  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END), 0) as queued,
      COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END), 0) as running,
      COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) as failed,
      COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN estimated_cost_cny ELSE 0 END), 0) as total_estimated_cost
    FROM task_queue ${where}
  `).get(...params) as any;
  return stats;
}

// ─── Budget guard for queue ─────────────────────────────────────────

export interface QueueBudget {
  max_cost_cny: number;
  max_tasks: number;
}

let _queueBudget: QueueBudget = { max_cost_cny: 50, max_tasks: 20 };

export function setQueueBudget(budget: QueueBudget): void {
  _queueBudget = budget;
}

export function getQueueBudget(): QueueBudget {
  return { ..._queueBudget };
}

/** Check if enqueueing a task would exceed budget. Returns remaining budget info. */
export function checkBudget(project_id?: string): {
  allowed: boolean;
  current_queued: number;
  current_cost: number;
  max_tasks: number;
  max_cost: number;
  remaining_tasks: number;
  remaining_cost: number;
} {
  const stats = getQueueStats(project_id);
  const remaining_tasks = _queueBudget.max_tasks - (stats.queued + stats.running);
  const remaining_cost = _queueBudget.max_cost_cny - stats.total_estimated_cost;
  return {
    allowed: remaining_tasks > 0 && remaining_cost > 0,
    current_queued: stats.queued + stats.running,
    current_cost: stats.total_estimated_cost,
    max_tasks: _queueBudget.max_tasks,
    max_cost: _queueBudget.max_cost_cny,
    remaining_tasks: Math.max(0, remaining_tasks),
    remaining_cost: Math.max(0, remaining_cost),
  };
}

// Ensure queue table exists (called from database.ts ensureSchema or lazily here)
export function ensureTaskQueueTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      episode_id TEXT,
      shot_stable_id TEXT,
      task_type TEXT NOT NULL CHECK(task_type IN ('generate_video','generate_image','generate_tts','render')),
      provider TEXT NOT NULL,
      model TEXT,
      priority INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
      estimated_cost_cny REAL DEFAULT 0,
      estimated_duration_sec INTEGER DEFAULT 60,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      failed_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
    CREATE INDEX IF NOT EXISTS idx_task_queue_project ON task_queue(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_queue_status_priority ON task_queue(status, priority, created_at);
  `);
  ensureTaskQueueColumn(db, "failed_reason", "TEXT");
}

function ensureTaskQueueColumn(db: ReturnType<typeof getDb>, column: string, definition: string): void {
  const cols = db.prepare("PRAGMA table_info(task_queue)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.prepare(`ALTER TABLE task_queue ADD COLUMN ${column} ${definition}`).run();
  }
}
