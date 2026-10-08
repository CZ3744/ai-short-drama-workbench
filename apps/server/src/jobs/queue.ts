import { randomUUID } from "node:crypto";

import { sseBroker } from "../api/v2/sseBroker";
import type { AttemptJob, AttemptJobError, AttemptJobFilter, JobStats, JobStatus } from "./types";

const DEFAULT_MAX_ENTRIES = 500;

export class AttemptJobQueue {
  private readonly _store = new Map<string, AttemptJob>();

  constructor(private readonly _maxEntries = DEFAULT_MAX_ENTRIES) {}

  create(purpose: string, target: Record<string, unknown>, abort?: AbortController): AttemptJob {
    const now = new Date().toISOString();
    const job: AttemptJob = {
      attempt_id: randomUUID(),
      status: "queued",
      progress: 0,
      purpose,
      target,
      started_at: now,
      updated_at: now,
      abort_controller: abort,
    };
    this._store.set(job.attempt_id, job);
    this._evictIfNeeded();

    sseBroker.emit({
      type: "pending_job.progress",
      job_id: job.attempt_id,
      data: { attempt_id: job.attempt_id, status: "queued", progress: 0, purpose, target },
      at: now,
    });

    return job;
  }

  update(
    attempt_id: string,
    patch: Partial<Omit<AttemptJob, "attempt_id" | "started_at" | "abort_controller">>,
  ): AttemptJob | null {
    const job = this._store.get(attempt_id);
    if (!job) return null;
    if (this._isTerminal(job.status)) return job;
    const next: AttemptJob = { ...job, ...patch, updated_at: new Date().toISOString() };
    this._store.set(attempt_id, next);

    sseBroker.emit({
      type: "pending_job.progress",
      job_id: attempt_id,
      data: {
        attempt_id,
        status: next.status,
        progress: next.progress,
        eta_s: next.eta_s,
      },
      at: next.updated_at,
    });

    return next;
  }

  complete(attempt_id: string, result?: unknown): AttemptJob | null {
    const job = this._store.get(attempt_id);
    if (!job) return null;
    if (this._isTerminal(job.status)) return job;
    const now = new Date().toISOString();
    const next: AttemptJob = {
      ...job,
      status: "done",
      progress: 1,
      result,
      finished_at: now,
      updated_at: now,
    };
    this._store.set(attempt_id, next);

    sseBroker.emit({
      type: "pending_job.done",
      job_id: attempt_id,
      data: { attempt_id, status: "done", progress: 1, result },
      at: now,
    });

    return next;
  }

  fail(attempt_id: string, error: AttemptJobError): AttemptJob | null {
    const job = this._store.get(attempt_id);
    if (!job) return null;
    if (this._isTerminal(job.status)) return job;
    const now = new Date().toISOString();
    const next: AttemptJob = {
      ...job,
      status: "failed",
      error,
      finished_at: now,
      updated_at: now,
    };
    this._store.set(attempt_id, next);

    sseBroker.emit({
      type: "pending_job.failed",
      job_id: attempt_id,
      data: { attempt_id, status: "failed", error },
      at: now,
    });

    return next;
  }

  cancel(attempt_id: string): AttemptJob | null {
    const job = this._store.get(attempt_id);
    if (!job) return null;
    if (this._isTerminal(job.status)) return job;
    if (job.abort_controller) {
      try { job.abort_controller.abort(); } catch { /* noop */ }
    }
    const now = new Date().toISOString();
    const error: AttemptJobError = { code: "Cancelled", message: "任务已取消" };
    const next: AttemptJob = {
      ...job,
      status: "cancelled",
      error,
      finished_at: now,
      updated_at: now,
    };
    this._store.set(attempt_id, next);

    sseBroker.emit({
      type: "pending_job.failed",
      job_id: attempt_id,
      data: { attempt_id, status: "cancelled", error },
      at: now,
    });

    return next;
  }

  get(attempt_id: string): AttemptJob | null {
    return this._store.get(attempt_id) ?? null;
  }

  list(filter?: AttemptJobFilter): AttemptJob[] {
    const all = Array.from(this._store.values());
    if (!filter) return all;
    return all.filter(
      (j) =>
        (filter.status === undefined || j.status === filter.status) &&
        (filter.purpose === undefined || j.purpose === filter.purpose),
    );
  }

  stats(): JobStats {
    const stats: JobStats = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: 0 };
    for (const job of this._store.values()) {
      stats[job.status]++;
      stats.total++;
    }
    return stats;
  }

  private _evictIfNeeded(): void {
    if (this._store.size <= this._maxEntries) return;
    const excess = this._store.size - this._maxEntries;
    let removed = 0;
    for (const key of this._store.keys()) {
      if (removed >= excess) break;
      const entry = this._store.get(key);
      if (entry && this._isTerminal(entry.status)) {
        this._store.delete(key);
        removed++;
      }
    }
  }

  private _isTerminal(status: JobStatus): boolean {
    return status === "done" || status === "failed" || status === "cancelled";
  }
}

export const attemptJobQueue = new AttemptJobQueue();
