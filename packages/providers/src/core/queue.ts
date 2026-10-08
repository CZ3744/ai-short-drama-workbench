// P20: TaskQueue — concurrency, retry, progress, external abort
// D1: merged fallbackChain (tryWithFallback, resolveChain, FallbackChainError) into this module

import { ProviderError } from "./errors";
import { budgetGuard } from "./budgetGuard";
import { isRealPaidImageProvider } from "./realPaidImageProviders";
import { isRealVideoProvider } from "../../../core/src/realVideoLock";
import type { ProviderKind, ProviderContext, LlmProvider, LlmCompleteRequest, LlmCompleteResponse } from "./types";

/**
 * 2026-05-28 audit P0-01: sleep that respects an AbortSignal.
 * 抢先 resolve (而不是 reject) 让上层的 abort 检测在下一轮 loop 处理 — 跟 asyncJobPoller.sleep 同款.
 */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// ─── Types ──────────────────────────────────────────────────────────

export interface TaskMeta {
  series_slug: string;
  job_id: string;
  purpose: string;
  shot_id?: string;
  character_id?: string;
  scene_id?: string;
  cost_estimate_cny?: number;
  requestId?: string;
  prompt_override?: string;
  seed_override?: number;
  /** W7-real-fix: 与 TaskRecord.meta.provider_id 对齐, 让 runner 能从 meta 兜底读 provider_id */
  provider_id?: string;
}

export interface Task<TInput = unknown, TOutput = unknown> {
  id: string;
  kind: ProviderKind;
  provider_id: string;
  input: TInput;
  meta: TaskMeta;
  retries_remaining: number;
  timeout_ms: number;
}

export type TaskStatus = "queued" | "running" | "done" | "failed";

/** 按 series_slug 分组的队列统计 */
export interface SeriesStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
}

export interface TaskQueueOptions {
  max_parallel: number;
  default_retries: number;
  /** @deprecated 队列不再执行本地 timeout，仅保留兼容旧 caller 的配置形状。 */
  default_timeout_ms: number;
  on_progress?: (taskId: string, status: TaskStatus, meta?: TaskMeta) => void;
}

// ─── Internal queue entry ──────────────────────────────────────────

interface QueueEntry<TInput, TOutput> {
  task: Task<TInput, TOutput>;
  runner: (task: Task<TInput, TOutput>, ctx: ProviderContext) => Promise<TOutput>;
  resolve: (value: TOutput) => void;
  reject: (reason: unknown) => void;
  abortController: AbortController;
}

// ─── TaskQueue ──────────────────────────────────────────────────────

export class TaskQueue {
  private _maxParallel: number;
  private _defaultRetries: number;
  private _onProgress?: TaskQueueOptions["on_progress"];

  private _running = 0;
  private _queue: QueueEntry<any, any>[] = [];
  private _stats = { queued: 0, running: 0, done: 0, failed: 0 };
  private _seriesStats = new Map<string, SeriesStats>();
  private _abortControllers = new Map<string, AbortController>();
  private _jobAbortControllers = new Map<string, Set<string>>();

  constructor(opts: TaskQueueOptions) {
    this._maxParallel = opts.max_parallel;
    this._defaultRetries = opts.default_retries;
    this._onProgress = opts.on_progress;
  }

  /**
   * Enqueue a task. Returns a promise that resolves with the task output.
   */
  enqueue<I, O>(
    task: Task<I, O>,
    runner: (task: Task<I, O>, ctx: ProviderContext) => Promise<O>
  ): Promise<O> {
    // Budget preflight check (throws BudgetExceededError if over limit)
    // X1-4 (A6-4): 真实付费 provider (视频或图像) 即使估算成本为 0 (如即梦零单价 preset) 也要 preflight,
    // 否则用户把日预算显式设为 ¥0 想冻结时会被 `costEst>0` 门跳过。传 realPaidProvider 让 budgetGuard
    // 的 dailyCap<=0 冻结拦截生效 (与 videoGenerationService 权威门相同的 flag 语义, 防御纵深一致)。
    const costEst = task.meta.cost_estimate_cny ?? 0;
    const realPaidProvider = isRealVideoProvider(task.provider_id) || isRealPaidImageProvider(task.provider_id);
    if (costEst > 0 || realPaidProvider) {
      budgetGuard.preflight(costEst, task.meta.job_id, task.provider_id, { realPaidProvider });
    }

    // Apply defaults
    if (task.retries_remaining <= 0) task.retries_remaining = this._defaultRetries;

    return new Promise<O>((resolve, reject) => {
      const abortController = new AbortController();
      const entry: QueueEntry<I, O> = { task, runner, resolve, reject, abortController };

      this._abortControllers.set(task.id, abortController);
      // Track by job_id
      if (!this._jobAbortControllers.has(task.meta.job_id)) {
        this._jobAbortControllers.set(task.meta.job_id, new Set());
      }
      this._jobAbortControllers.get(task.meta.job_id)!.add(task.id);

      this._queue.push(entry);
      this._stats.queued++;
      this._bumpSeries(task.meta.series_slug, "queued");
      this._onProgress?.(task.id, "queued", task.meta);
      this._drain();
    });
  }

  /**
   * Abort a specific task by id.
   */
  abort(taskId: string): void {
    const controller = this._abortControllers.get(taskId);
    if (controller) {
      controller.abort();
    }
  }

  /**
   * Abort all tasks belonging to a job_id.
   */
  abortJob(jobId: string): void {
    const taskIds = this._jobAbortControllers.get(jobId);
    if (taskIds) {
      for (const tid of taskIds) {
        this.abort(tid);
      }
    }
  }

  /**
   * Get current queue stats.
   */
  stats(): { queued: number; running: number; done: number; failed: number } {
    return { ...this._stats };
  }

  /**
   * Get queue stats grouped by series_slug.
   */
  statsBySeries(): Record<string, SeriesStats> {
    const result: Record<string, SeriesStats> = {};
    for (const [slug, s] of this._seriesStats) {
      result[slug] = { ...s };
    }
    return result;
  }

  // ─── internals ──────────────────────────────────────────────────

  private _drain(): void {
    while (this._running < this._maxParallel && this._queue.length > 0) {
      const entry = this._queue.shift()!;
      this._stats.queued--;
      this._bumpSeries(entry.task.meta.series_slug, "queued", -1);
      this._running++;
      this._stats.running++;
      this._bumpSeries(entry.task.meta.series_slug, "running");
      this._onProgress?.(entry.task.id, "running", entry.task.meta);
      this._execute(entry);
    }
  }

  private async _execute(entry: QueueEntry<any, any>): Promise<void> {
    const { task, runner, resolve, reject, abortController } = entry;
    let lastError: unknown;

    for (let attempt = 0; attempt <= task.retries_remaining; attempt++) {
      if (abortController.signal.aborted) {
        this._finish(task, "failed");
        reject(new ProviderError({
          message: `Task ${task.id} aborted`,
          code: "timeout",
          provider_id: task.provider_id,
          retriable: false,
        }));
        return;
      }

      const ctx: ProviderContext = {
        series_slug: task.meta.series_slug,
        job_id: task.meta.job_id,
        task_id: task.id,
        log: (_level, _msg) => { /* logging is provider's responsibility */ },
        signal: abortController.signal,
      };

      try {
        const result = await runner(task, ctx);
        this._finish(task, "done");
        resolve(result);
        return;
      } catch (err) {
        lastError = err;
        const isRetriable = err instanceof ProviderError ? err.retriable : false;

        if (!isRetriable || attempt >= task.retries_remaining) {
          this._finish(task, "failed");
          reject(err);
          return;
        }
        // 2026-05-28 audit P0-01: backoff 接 abort — 之前 setTimeout 不听 abortController.signal,
        // 用户点"中止"后还要等完一个 backoff 周期 (最多几秒) 才真停, retry 期间用户感觉卡死.
        const backoffMs = 200 * Math.pow(2, attempt);
        await sleepWithSignal(backoffMs, abortController.signal);
      }
    }

    // Should not reach here, but just in case
    this._finish(task, "failed");
    reject(lastError);
  }

  private _finish(task: Task, status: TaskStatus): void {
    this._running--;
    this._stats.running--;
    this._bumpSeries(task.meta.series_slug, "running", -1);
    if (status === "done") {
      this._stats.done++;
      this._bumpSeries(task.meta.series_slug, "done");
    } else {
      this._stats.failed++;
      this._bumpSeries(task.meta.series_slug, "failed");
    }
    this._abortControllers.delete(task.id);
    const jobSet = this._jobAbortControllers.get(task.meta.job_id);
    if (jobSet) {
      jobSet.delete(task.id);
      if (jobSet.size === 0) this._jobAbortControllers.delete(task.meta.job_id);
    }
    this._onProgress?.(task.id, status, task.meta);
    this._drain();
  }

  /** 增减某个 series_slug 的某项统计 */
  private _bumpSeries(slug: string, key: "queued" | "running" | "done" | "failed", delta = 1): void {
    if (!slug) return;
    let s = this._seriesStats.get(slug);
    if (!s) {
      s = { queued: 0, running: 0, done: 0, failed: 0 };
      this._seriesStats.set(slug, s);
    }
    s[key] = Math.max(0, s[key] + delta);
  }

}

// ─── Fallback Chain (merged from fallbackChain.ts in D1) ───────────

export interface FallbackEvent {
  from: string;
  to: string;
  reason: string;
}

export type OnFallback = (event: FallbackEvent) => void;

export class FallbackChainError extends Error {
  readonly errors: ProviderError[];

  constructor(errors: ProviderError[]) {
    super(
      `All LLM providers failed: ${errors.map(e => `${e.provider_id}: ${e.message}`).join("; ")}`
    );
    this.name = "FallbackChainError";
    this.errors = errors;
  }

  /**
   * 2026-05-28 audit P1-19: 加 status getter — 之前 FallbackChainError 没 status,
   * Express 全局错误中间件 (apps/server/src/index.ts getHttpStatus) 走 error.status ?? error.statusCode,
   * 缺则默认 500. 但全链路 missing_key 的 case 应该是 400 (用户配 Key 就好), 不是 500.
   * 全是 missing_key → 400; 否则按最严重的 ProviderError code 映射, fallback 502.
   */
  get status(): number {
    if (this.errors.length === 0) return 502;
    const codes = new Set(this.errors.map(e => e.code));
    if (codes.size === 1 && codes.has("missing_key")) return 400;
    // 取最严重的一个 (最后一个 retriable 失败的)
    const lastErr = this.errors[this.errors.length - 1];
    return lastErr.status;
  }

  get statusCode(): number {
    return this.status;
  }

  /** Returns summary suitable for SSE / toast, with per-provider reason */
  summary(): string {
    if (this.errors.length === 0) return "未知错误：fallback 链为空";
    const total = this.errors.length;
    const details = this.errors
      .map((e, i) => {
        const label = i === 0 ? e.provider_id : `备选${i}/${total - 1} ${e.provider_id}`;
        const reason = codeLabel(e.code);
        return `${label}:${reason}`;
      })
      .join("，");
    return `LLM 调用链路全部失败（${details}）。请检查设置 → Providers`;
  }

  /** Returns user-actionable suggestion */
  suggestion(): string {
    const codes = new Set(this.errors.map(e => e.code));
    if (codes.has("missing_key")) return "请检查是否至少配置了一个 LLM provider 的 API Key。点击设置 → 模型服务";
    if (codes.size === 1 && codes.has("rate_limit")) return "所有 provider 均触发频率限制，请稍后重试";
    if (codes.size === 1 && codes.has("timeout")) return "所有 provider 均超时，请检查网络连接或 base_url 是否可达";
    return "请打开设置检查各 provider 的 API Key 和连接状态";
  }
}

/** 将 error code 翻译为中文短标签 */
function codeLabel(code: string): string {
  switch (code) {
    case "missing_key": return "Key 未配置";
    case "rate_limit": return "频率限制";
    case "timeout": return "超时";
    case "server": return "服务器错误";
    case "invalid_request": return "请求参数错误";
    case "content_filter": return "内容审核拦截";
    case "insufficient_balance": return "余额不足";
    default: return code;
  }
}

const RETRIABLE_CODES = new Set(["rate_limit", "timeout", "server"]);

export async function tryWithFallback(
  providerIds: string[],
  getProvider: (id: string) => LlmProvider,
  request: LlmCompleteRequest,
  ctx: ProviderContext,
  onFallback?: OnFallback,
): Promise<LlmCompleteResponse> {
  const errors: ProviderError[] = [];

  for (let i = 0; i < providerIds.length; i++) {
    const id = providerIds[i];
    try {
      const llm = getProvider(id);
      const result = await llm.complete(request, ctx);
      // Success — notify if we switched from the first candidate
      if (i > 0 && onFallback) {
        onFallback({ from: providerIds[0], to: id, reason: "previous_providers_failed" });
      }
      return result;
    } catch (err) {
      if (err instanceof ProviderError) {
        // V-30: missing_key 不重试 — 缺 Key 是配置问题,换 provider 也未必解决,直接抛出引导用户配置
        if (err.code === "missing_key") {
          throw err;
        }
        if (RETRIABLE_CODES.has(err.code)) {
          errors.push(err);
          if (i < providerIds.length - 1 && onFallback) {
            onFallback({ from: id, to: providerIds[i + 1], reason: err.code });
          }
          continue; // try next provider in chain
        }
      }
      // Non-retriable error — stop immediately, do NOT fall through
      throw err;
    }
  }

  throw new FallbackChainError(errors);
}

/**
 * Resolve the LLM provider chain from config or compute a sensible default.
 *
 * Priority:
 * 1. LLM_PROVIDER_CHAIN from local-settings (JSON string array)
 * 2. GLOBAL_MODEL_PROVIDER as lead, then all known LLM providers with keys
 * 3. All registered LLM providers
 */
export function resolveChain(
  globalModelProvider: string,
  allLlmProviderIds: string[],
  hasKey: (id: string) => boolean,
  explicitChainJson?: string,
): string[] {
  // 1. Explicit chain from config
  if (explicitChainJson) {
    try {
      const parsed = JSON.parse(explicitChainJson);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x: unknown) => typeof x === "string")) {
        return parsed as string[];
      }
    } catch {
      // ignore invalid JSON — fall through to defaults
    }
  }

  // 2. GLOBAL_MODEL_PROVIDER as lead + all other providers with keys
  const result: string[] = [];
  if (globalModelProvider && allLlmProviderIds.includes(globalModelProvider)) {
    result.push(globalModelProvider);
  }
  for (const id of allLlmProviderIds) {
    if (id !== globalModelProvider && hasKey(id)) {
      result.push(id);
    }
  }

  // 3. Fallback: include ALL registered providers (even without keys, for user visibility)
  if (result.length === 0) {
    return allLlmProviderIds;
  }

  return result;
}
