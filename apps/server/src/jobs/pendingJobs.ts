/**
 * Compatibility facade for attempt-aware jobs.
 *
 * Step 5: the mutable lifecycle store now lives in jobs/queue.ts. Existing
 * controllers keep importing pendingJobs.ts while the job system converges.
 */

import { attemptJobQueue } from "./queue";
import type { AttemptJob, AttemptJobFilter, AttemptJobError, JobStats, JobStatus } from "./types";

export type PendingJobStatus = JobStatus;
export type PendingJob = AttemptJob;

export function createPendingJob(purpose: string, target: Record<string, unknown>, abort?: AbortController): PendingJob {
  return attemptJobQueue.create(purpose, target, abort);
}

export function updatePendingJob(
  attempt_id: string,
  patch: Partial<Omit<PendingJob, "attempt_id" | "started_at" | "abort_controller">>,
): PendingJob | null {
  return attemptJobQueue.update(attempt_id, patch);
}

export function completePendingJob(attempt_id: string, result?: unknown): PendingJob | null {
  return attemptJobQueue.complete(attempt_id, result);
}

export function failPendingJob(attempt_id: string, error: AttemptJobError): PendingJob | null {
  return attemptJobQueue.fail(attempt_id, error);
}

export function cancelPendingJob(attempt_id: string): PendingJob | null {
  return attemptJobQueue.cancel(attempt_id);
}

export function getPendingJob(attempt_id: string): PendingJob | null {
  return attemptJobQueue.get(attempt_id);
}

export function listPendingJobs(filter?: AttemptJobFilter): PendingJob[] {
  return attemptJobQueue.list(filter);
}

export function getPendingJobStats(): JobStats {
  return attemptJobQueue.stats();
}
