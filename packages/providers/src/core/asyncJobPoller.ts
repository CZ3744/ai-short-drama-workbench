// P23: Generic async job poller — shared by Kling, Jimeng, and future async providers.
//
// Pattern: submit task → poll with backoff → terminal state (succeed / failed / timeout)

import { ProviderError } from "./errors";

export type PollTerminalStatus = "succeed" | "failed" | "canceled" | "timeout";
export type PollPendingStatus = "submitted" | "processing" | "pending" | "running";
export type PollStatus = PollTerminalStatus | PollPendingStatus;

export interface PollResult<T = unknown> {
  status: PollStatus;
  /** Provider-specific result data when status === "succeed" */
  data?: T;
  /** Error message when status === "failed" */
  error?: string;
  /** Provider-specific error code */
  errorCode?: string;
  /** Raw provider response (for logging / debugging) */
  raw?: unknown;
}

export interface AsyncJobPollerOptions<T = unknown> {
  /** Provider name for logging */
  providerId: string;
  /** Task/job ID for logging */
  taskId: string;
  /** Poll function — called each iteration, returns PollResult */
  pollFn: () => Promise<PollResult<T>>;
  /** Initial poll interval in ms (default 5000) */
  initialIntervalMs?: number;
  /** Max poll interval in ms (for exponential backoff, default 15000) */
  maxIntervalMs?: number;
  /**
   * Overall wall-clock timeout in ms.
   *
   * 2026-05-28 audit P0-08: 默认 Infinity (无 wall-clock timeout). 远端真实视频生成
   * 13-20 分钟正常, 客户端不能本地 abort 否则用户花了钱、远端跑成功、客户端却 timeout.
   * caller 可以显式传有限值 (CI / 测试用), 但默认让 ctx.signal 决定何时停.
   */
  timeoutMs?: number;
  /** Optional logger */
  logger?: (msg: string) => void;
  /** AbortSignal for external cancellation */
  signal?: AbortSignal;
}

/**
 * Poll an async job until it reaches a terminal state or times out.
 *
 * Uses exponential backoff: starts at initialIntervalMs, doubles each iteration,
 * capped at maxIntervalMs.
 *
 * Returns the final PollResult. If timeout is reached, returns status="timeout".
 */
export async function pollAsyncJob<T = unknown>(
  opts: AsyncJobPollerOptions<T>
): Promise<PollResult<T>> {
  const {
    providerId,
    taskId,
    pollFn,
    initialIntervalMs = 5_000,
    maxIntervalMs = 15_000,
    // 2026-05-28 audit P0-08: 默认 Infinity, caller 可显式传有限值.
    timeoutMs = Number.POSITIVE_INFINITY,
    logger,
    signal,
  } = opts;

  const startTime = Date.now();
  let intervalMs = initialIntervalMs;
  let attempt = 0;

  const terminalStatuses = new Set<PollStatus>(["succeed", "failed", "canceled", "timeout"]);

  while (true) {
    // Check abort
    if (signal?.aborted) {
      return { status: "timeout", error: "Aborted by caller" };
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      logger?.(`[${providerId}] Poll timeout for task ${taskId} after ${elapsed}ms (${attempt} attempts)`);
      return { status: "timeout", error: `Poll timeout after ${elapsed}ms` };
    }

    attempt++;
    logger?.(`[${providerId}] Polling task ${taskId} (attempt ${attempt}, elapsed ${elapsed}ms)`);

    try {
      const result = await pollFn();

      if (terminalStatuses.has(result.status)) {
        logger?.(`[${providerId}] Task ${taskId} reached terminal status: ${result.status}`);
        return result;
      }

      // Pending — wait and retry with backoff
      await sleep(intervalMs, signal);
      intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    } catch (err: any) {
      // 2026-05-28 audit P1-20: 区分错误类型 — 之前所有错误 silent log + retry, 但 401 missing_key
      // / 400 invalid_request 不会因 retry 变 OK, 只会一直重试到 wall-clock timeout. 现在:
      //   - ProviderError 且 !retriable → 直接 throw 让 caller (provider.generate) 拿到结构化错误
      //   - 其他 (network / 5xx / 未分类) → 仍按 transient 处理, log + retry
      if (err instanceof ProviderError && !err.retriable) {
        logger?.(`[${providerId}] Poll error non-retriable for task ${taskId}: ${err.message}`);
        throw err;
      }
      logger?.(`[${providerId}] Poll error for task ${taskId}: ${err.message ?? err}`);
      await sleep(intervalMs, signal);
      intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    }
  }
}

/** Sleep with AbortSignal support */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve(); // Already aborted, don't block
      return;
    }

    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      resolve(); // Resolve (not reject) so poller can check timeout
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
