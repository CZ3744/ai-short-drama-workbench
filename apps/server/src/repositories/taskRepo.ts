/**
 * Task repository — extracted from seriesStore.ts (step 1: 按聚合根拆上帝模块).
 * 零行为变更, 逐字搬运. 重复 helper 是有意为之.
 */

import fs from "node:fs/promises";
import { pathExists, ensureDir } from "../../../../packages/core/src/index";
import { migrateToLatest } from "../../../../packages/core/src/migrations";
import { loggerSync } from "../../../../packages/core/src/logger";
import { TASKS_ROOT, TASKS_FILE } from "./_paths";

// ─── Private helpers (复制自 seriesStore) ──────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  if (!(await pathExists(filePath))) return [];
  const content = await fs.readFile(filePath, "utf8");
  const entries: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // E3: apply global schema version migration to each JSONL entry
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(migrateToLatest(parsed as Record<string, unknown>));
      } else {
        entries.push(parsed);
      }
    } catch { /* skip */ }
  }
  return entries;
}

// T3: in-process mutex per file path — prevents JSONL line-sticking under concurrent appends
const _appendLocks = new Map<string, Promise<void>>();

async function appendJsonl(filePath: string, entry: unknown): Promise<void> {
  const prev = _appendLocks.get(filePath) ?? Promise.resolve();
  let resolveLock!: () => void;
  const lock = new Promise<void>((r) => { resolveLock = r; });
  _appendLocks.set(filePath, prev.then(() => lock));
  try {
    await prev;
    await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
  } finally {
    resolveLock();
    // GC: if no more waiters, drop the entry
    if (_appendLocks.get(filePath) === lock) _appendLocks.delete(filePath);
  }
}

// ─── Task Store (in-memory + disk) ─────────────────────────────

export interface TaskRecord {
  id: string;
  job_id: string;
  kind: string;
  provider_id: string;
  status: "queued" | "running" | "done" | "failed";
  meta: Record<string, any>;
  created_at: string;
  updated_at: string;
  error?: string;
  result?: unknown;
}

// ─── Task Store ─────────────────────────────────────────────────

const _tasks = new Map<string, TaskRecord>();
const MAX_TASKS = 1000;

/**
 * Append a TaskRecord to tasks.jsonl (fire-and-forget).
 * Errors are swallowed so callers don't need to handle them.
 */
async function persistTask(record: TaskRecord): Promise<void> {
  try {
    await ensureDir(TASKS_ROOT);
    await appendJsonl(TASKS_FILE, record);
  } catch (err) {
    loggerSync().warn("[seriesStore] failed to persist task record:", err instanceof Error ? err.message : err);
  }
}

export function createTaskRecord(input: Omit<TaskRecord, "created_at" | "updated_at">): TaskRecord {
  const record: TaskRecord = {
    ...input,
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  _tasks.set(record.id, record);
  void persistTask(record);
  return record;
}

export function updateTaskRecord(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
  const existing = _tasks.get(taskId);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updated_at: nowISO() };
  _tasks.set(taskId, updated);
  void persistTask(updated);
  return updated;
}

/**
 * Restore _tasks Map from tasks.jsonl on server startup.
 * Keeps only the last MAX_TASKS records; older ones are rotated out.
 *
 * 2026-05-27 — 启动时把"queued/running 超 30 分钟没更新"的任务直接标 failed.
 * 之前 dev server tsx watch restart 时, 内存里跑着的 task promise 链断了, jsonl
 * 最后状态留在 "running" 永远不会被任何人推 task.done → 前端任务中心一直显示
 * 这些僵尸 + 重复堆积 (用户截图 7 条同款"废墟微光·EP05·未命名分镜·首帧").
 * 启动时一次性翻成 failed, 客户端 listTasks?status=running 就看不到了.
 */
const STALE_PENDING_MS = 30 * 60 * 1000;

export async function restoreTasks(): Promise<{ restored: number; rotated: number; stale_marked: number }> {
  try {
    const entries = await readJsonl(TASKS_FILE);
    if (entries.length === 0) return { restored: 0, rotated: 0, stale_marked: 0 };

    // Validate and restore last MAX_TASKS
    const valid: TaskRecord[] = [];
    for (const entry of entries) {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        const e = entry as Record<string, unknown>;
        if (typeof e.id === "string" && typeof e.job_id === "string" && typeof e.status === "string") {
          valid.push(e as unknown as TaskRecord);
        }
      }
    }

    const rotated = Math.max(0, valid.length - MAX_TASKS);
    let keep = valid.slice(-MAX_TASKS);

    // 2026-05-27 — 僵尸 task 标 failed (启动一次性翻账, 不动盘上原记录, 只更新内存)
    const now = Date.now();
    let staleMarked = 0;
    keep = keep.map((r) => {
      if (r.status !== "queued" && r.status !== "running") return r;
      const updatedAt = Date.parse(r.updated_at || r.created_at);
      if (Number.isFinite(updatedAt) && now - updatedAt > STALE_PENDING_MS) {
        staleMarked++;
        return {
          ...r,
          status: "failed" as const,
          error: r.error ?? "server restart 后 promise 链中断, 启动时标记僵尸 (>30min 未更新)",
          updated_at: new Date().toISOString(),
        };
      }
      return r;
    });

    _tasks.clear();
    for (const record of keep) {
      _tasks.set(record.id, record);
    }

    // T3: atomic rewrite via .tmp + rename if we rotated any (prevents corrupt file on crash mid-write)
    // 2026-05-27 — 标了僵尸也写一次, 让磁盘跟内存一致
    if (rotated > 0 || staleMarked > 0) {
      await ensureDir(TASKS_ROOT);
      const content = keep.map(r => JSON.stringify(r)).join("\n") + "\n";
      const tmpPath = TASKS_FILE + ".tmp";
      await fs.writeFile(tmpPath, content, "utf8");
      await fs.rename(tmpPath, TASKS_FILE);
    }

    if (staleMarked > 0) {
      loggerSync().info(`[taskRepo] 启动僵尸清理: ${staleMarked} 条 queued/running 超 30 分钟未更新, 标 failed`);
    }
    return { restored: keep.length, rotated, stale_marked: staleMarked };
  } catch (err) {
    loggerSync().warn("[seriesStore] failed to restore tasks:", err instanceof Error ? err.message : err);
    return { restored: 0, rotated: 0, stale_marked: 0 };
  }
}

export function getTask(taskId: string): TaskRecord | null {
  const t = _tasks.get(taskId) ?? null;
  if (!t) return null;
  // 2026-05-27 — 单条查询也加 lazy 僵尸修正: queued/running 超 30min 没动直接
  // 返 failed 给客户端 (前端 syncTasks B 阶段 batch fetch ?ids= 会拿到, 立即
  // 标记成功转 failed 不再卡 running).
  const updatedAt = Date.parse(t.updated_at || t.created_at);
  if (
    (t.status === "queued" || t.status === "running") &&
    Number.isFinite(updatedAt) &&
    Date.now() - updatedAt > STALE_PENDING_MS
  ) {
    return {
      ...t,
      status: "failed",
      error: t.error ?? "task 超 30 分钟未更新, 视为后端 promise 中断的僵尸",
    };
  }
  return t;
}

/**
 * 2026-05-27 — listTasks 实时再加一层 TTL 兜底:
 * 启动时虽然清过僵尸, 但用户长时间不重启 dev server, 任务跑到一半被 abort
 * 也会卡 running. 这里 listTasks 时再过滤 30 分钟没更新的 queued/running, 不返
 * 给客户端 (但不动 _tasks Map / 盘上记录 — 让 abort/retry 路径仍能查到).
 */
function isStalePending(t: TaskRecord, nowMs: number): boolean {
  if (t.status !== "queued" && t.status !== "running") return false;
  const updatedAt = Date.parse(t.updated_at || t.created_at);
  if (!Number.isFinite(updatedAt)) return false;
  return nowMs - updatedAt > STALE_PENDING_MS;
}

export function listTasks(filter?: { job_id?: string; status?: string }): TaskRecord[] {
  const now = Date.now();
  let results = Array.from(_tasks.values()).filter((t) => !isStalePending(t, now));
  if (filter?.job_id) results = results.filter(t => t.job_id === filter.job_id);
  if (filter?.status) results = results.filter(t => t.status === filter.status);
  return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
