export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface AttemptJobError {
  code: string;
  message: string;
}

export interface AttemptJob {
  attempt_id: string;
  status: JobStatus;
  progress: number;
  eta_s?: number;
  purpose: string;
  target: Record<string, unknown>;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  error?: AttemptJobError;
  result?: unknown;
  abort_controller?: AbortController;
}

export interface AttemptJobFilter {
  status?: JobStatus;
  purpose?: string;
}

export interface JobStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  total: number;
}
