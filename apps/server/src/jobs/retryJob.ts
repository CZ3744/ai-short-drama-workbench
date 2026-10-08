/**
 * B5 · Retry-until-satisfied 正式化
 *
 * 持久化 retry_job record (data/retry_jobs/<id>.json)
 * 后台 interval 检查: 调 orchestrator 生成 → 读 quality_scores → 满足阈值 auto pick → completed / 超预算 / 超次数
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import { DATA_ROOT } from "../../../../packages/core/src/paths";
import { readShot, readSeries, pickGeneration, type ShotData, type ShotGeneration } from "../api/v2/seriesStore";
import { orchestrator } from "./orchestrator";
import { loggerSync } from "../../../../packages/core/src/logger";
import { budgetGuard } from "../../../../packages/providers/src/core/budgetGuard";
import { BudgetExceededError } from "../../../../packages/providers/src/core/errors";
// X1-4 (A6-4): 解析 retry 实际 provider + 判定真实付费 (预算冻结 flag 语义与 videoGenerationService 一致)
import { isRealVideoProvider } from "../../../../packages/core/src/realVideoLock";
import { isRealPaidImageProvider } from "../../../../packages/providers/src/core/realPaidImageProviders";
import { providerIdFromModelRef } from "../application/generation/modelRef";
import {
  cancelPendingJob,
  completePendingJob,
  createPendingJob,
  failPendingJob,
  getPendingJob,
  updatePendingJob,
} from "./pendingJobs";
import {
  registerPollerTask,
  runPollerTaskNow,
  startJobsPoller,
  stopJobsPollerIfIdle,
} from "./poller";

// ─── Types ──────────────────────────────────────────────────────────

export type RetryJobAction = "generate_first_frames" | "generate_videos";

export type RetryJobStatus =
  | "active"
  | "completed"
  | "max_attempts_reached"
  | "budget_exceeded"
  | "cancelled"
  | "error";

export interface RetryJobRecord {
  id: string;
  /** Linked attempt-aware queue id (Step 5 convergence). */
  attempt_id?: string;
  series_slug: string;
  episode_id: string;
  shot_id: string;
  action: RetryJobAction;
  /** 最大尝试次数 */
  max_attempts: number;
  /** 质量阈值 0-1 (四个维度的平均值) */
  quality_threshold: number;
  /** 预算上限 CNY */
  budget_cap_cny: number;
  /** 一旦有一个候选达标就停止 */
  stop_on_first_green: boolean;
  /** 完成后自动 pick 最佳候选 */
  auto_pick_best: boolean;
  /** 当前状态 */
  status: RetryJobStatus;
  /** 已执行尝试次数 */
  attempts: number;
  /** 当前最佳质量分数 */
  best_score: number;
  /** 当前最佳 generation_id */
  best_generation_id?: string;
  /** 累计花费 CNY (估算) */
  cost_spent_cny: number;
  /** 每个 attempt 的简要记录 */
  attempt_log: Array<{
    attempt: number;
    generation_id?: string;
    score?: number;
    cost_cny?: number;
    error?: string;
    at: string;
  }>;
  created_at: string;
  updated_at: string;
  /** 最后 poll 时间 */
  last_polled_at?: string;
}

export interface StartRetryJobInput {
  series_slug: string;
  episode_id: string;
  shot_id: string;
  action: RetryJobAction;
  max_attempts: number;
  quality_threshold: number;
  budget_cap_cny: number;
  stop_on_first_green: boolean;
  auto_pick_best: boolean;
}

// ─── Paths ──────────────────────────────────────────────────────────

const RETRY_JOBS_DIR = path.join(DATA_ROOT, "retry_jobs");

function jobFile(jobId: string): string {
  return path.join(RETRY_JOBS_DIR, `${jobId}.json`);
}

// ─── Central poller registration ────────────────────────────────────

const RETRY_POLLER_NAME = "retry_jobs";
const RETRY_POLL_INTERVAL_MS = 5000; // 每 5 秒检查一次
let unregisterRetryPoller: (() => void) | null = null;

// ─── Persistence ────────────────────────────────────────────────────

async function ensureDir(): Promise<void> {
  await fs.mkdir(RETRY_JOBS_DIR, { recursive: true });
}

async function saveJob(record: RetryJobRecord): Promise<void> {
  await ensureDir();
  record.updated_at = new Date().toISOString();
  await fs.writeFile(jobFile(record.id), JSON.stringify(record, null, 2), "utf8");
}

async function loadJob(jobId: string): Promise<RetryJobRecord | null> {
  try {
    const raw = await fs.readFile(jobFile(jobId), "utf8");
    return JSON.parse(raw) as RetryJobRecord;
  } catch {
    return null;
  }
}

async function listAllJobs(): Promise<RetryJobRecord[]> {
  try {
    await ensureDir();
    const files = await fs.readdir(RETRY_JOBS_DIR);
    const jobs: RetryJobRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(RETRY_JOBS_DIR, f), "utf8");
        jobs.push(JSON.parse(raw) as RetryJobRecord);
      } catch {
        // skip corrupt files
      }
    }
    return jobs;
  } catch {
    return [];
  }
}

// ─── Cost estimation ────────────────────────────────────────────────

/**
 * 粗估单次生成成本 CNY。
 * 视频: ~0.1 CNY/sec (按 5s = 0.5 CNY), 首帧图像: ~0.05 CNY/张
 */
function estimateCost(action: RetryJobAction, durationSec?: number): number {
  if (action === "generate_videos") {
    return (durationSec ?? 5) * 0.1;
  }
  return 0.05; // image/first-frame
}

function retryPendingTarget(job: RetryJobRecord): Record<string, unknown> {
  return {
    retry_job_id: job.id,
    series_slug: job.series_slug,
    episode_id: job.episode_id,
    shot_id: job.shot_id,
    action: job.action,
    max_attempts: job.max_attempts,
    quality_threshold: job.quality_threshold,
  };
}

function retryProgress(job: RetryJobRecord): number {
  if (job.max_attempts <= 0) return 0;
  return Math.min(0.98, Math.max(0, job.attempts / job.max_attempts));
}

async function ensurePendingForRetryJob(job: RetryJobRecord): Promise<string> {
  if (job.attempt_id && getPendingJob(job.attempt_id)) {
    return job.attempt_id;
  }
  const pending = createPendingJob("shot.retry_until_satisfied", retryPendingTarget(job));
  job.attempt_id = pending.attempt_id;
  await saveJob(job);
  return pending.attempt_id;
}

async function markRetryPendingRunning(job: RetryJobRecord, eta_s?: number): Promise<void> {
  const attemptId = await ensurePendingForRetryJob(job);
  updatePendingJob(attemptId, {
    status: "running",
    progress: retryProgress(job),
    eta_s,
  });
}

async function syncRetryPendingTerminal(job: RetryJobRecord): Promise<void> {
  const attemptId = await ensurePendingForRetryJob(job);
  if (job.status === "completed") {
    completePendingJob(attemptId, {
      retry_job_id: job.id,
      best_generation_id: job.best_generation_id,
      best_score: job.best_score,
      attempts: job.attempts,
      cost_spent_cny: job.cost_spent_cny,
    });
    return;
  }
  if (job.status === "cancelled") {
    cancelPendingJob(attemptId);
    return;
  }
  const code =
    job.status === "budget_exceeded"
      ? "BudgetExceeded"
      : job.status === "max_attempts_reached"
        ? "MaxAttemptsReached"
        : "RetryJobFailed";
  failPendingJob(attemptId, {
    code,
    message: `${job.status}: attempts=${job.attempts}, best_score=${job.best_score.toFixed(3)}`,
  });
}

// ─── Quality helper ─────────────────────────────────────────────────

/**
 * 计算 quality_scores 的 overall (四个维度平均值), 无分数返回 0
 */
function computeOverallScore(scores: ShotGeneration["quality_scores"]): number {
  if (!scores) return 0;
  // 2026-05-18: 维度可能 undefined (未评分). 只算真分维度平均, 全 undefined 返 0.
  const numeric = [scores.composition, scores.sharpness, scores.prompt_alignment, scores.subject_completeness]
    .filter((v): v is number => typeof v === "number");
  if (numeric.length === 0) return 0;
  return numeric.reduce((a, b) => a + b, 0) / numeric.length;
}

// ─── Core: process one job tick ─────────────────────────────────────

async function tickJob(job: RetryJobRecord): Promise<void> {
  if (job.status !== "active") return;

  const now = new Date().toISOString();
  job.last_polled_at = now;
  await markRetryPendingRunning(job);

  // Check max_attempts
  if (job.attempts >= job.max_attempts) {
    job.status = "max_attempts_reached";
    // If auto_pick_best and we have a best, pick it
    if (job.auto_pick_best && job.best_generation_id) {
      await autoPick(job);
    }
    await saveJob(job);
    await syncRetryPendingTerminal(job);
    loggerSync().info(`[retryJob] ${job.id}: max_attempts_reached (${job.attempts}/${job.max_attempts})`);
    return;
  }

  // Check budget
  if (job.budget_cap_cny > 0 && job.cost_spent_cny >= job.budget_cap_cny) {
    job.status = "budget_exceeded";
    if (job.auto_pick_best && job.best_generation_id) {
      await autoPick(job);
    }
    await saveJob(job);
    await syncRetryPendingTerminal(job);
    loggerSync().info(`[retryJob] ${job.id}: budget_exceeded (spent=${job.cost_spent_cny.toFixed(2)}, cap=${job.budget_cap_cny})`);
    return;
  }

  // Estimate cost for this attempt
  let durationSec: number | undefined;
  // X1-4 (A6-4): 解析这次 retry 实际会用的 provider (与 orchestrate 的 resolveProviderId 同源:
  // series.defaults), 用于 budgetGuard preflight 的 per-provider cap + realPaidProvider 冻结 flag。
  let resolvedProviderId: string | undefined;
  try {
    const shot = await readShot(job.series_slug, job.episode_id, job.shot_id);
    durationSec = shot?.duration_sec;
    const series = await readSeries(job.series_slug);
    const rawRef = job.action === "generate_videos"
      ? series?.defaults?.video_provider_id
      : series?.defaults?.image_provider_id;
    resolvedProviderId = providerIdFromModelRef(rawRef ?? undefined);
  } catch {
    // best-effort: 解析不到 provider 就退回原行为 (thisCost>0 仍会触发日预算冻结)
  }
  const thisCost = estimateCost(job.action, durationSec);

  // Check if this attempt would exceed budget
  if (job.budget_cap_cny > 0 && job.cost_spent_cny + thisCost > job.budget_cap_cny) {
    job.status = "budget_exceeded";
    if (job.auto_pick_best && job.best_generation_id) {
      await autoPick(job);
    }
    await saveJob(job);
    await syncRetryPendingTerminal(job);
    loggerSync().info(`[retryJob] ${job.id}: budget_exceeded (would spend ${(job.cost_spent_cny + thisCost).toFixed(2)} > ${job.budget_cap_cny})`);
    return;
  }

  // S3: 全局预算 preflight — 受 budgetGuard 统一约束，防止并发 retry job 超支
  // X1-4 (A6-4): 补传 providerId (启用 per-provider cap) + realPaidProvider 冻结 flag,
  // 与 videoGenerationService 权威门相同语义。resolvedProviderId 为空 (解析失败) 时退回原行为。
  const realPaidProvider = resolvedProviderId
    ? (isRealVideoProvider(resolvedProviderId) || isRealPaidImageProvider(resolvedProviderId))
    : false;
  try {
    budgetGuard.preflight(thisCost, job.id, resolvedProviderId, { realPaidProvider });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      job.status = "budget_exceeded";
      await saveJob(job);
      await syncRetryPendingTerminal(job);
      loggerSync().info(`[retryJob] ${job.id}: budget_exceeded by budgetGuard — ${err.message}`);
      return;
    }
    throw err;
  }

  // Start a new generation
  job.attempts++;
  const attemptNum = job.attempts;
  await markRetryPendingRunning(job, 300);
  const logEntry: RetryJobRecord["attempt_log"][0] = {
    attempt: attemptNum,
    at: now,
  };

  try {
    // Call orchestrator to generate 1 candidate
    const result = await orchestrator.orchestrate({
      series_slug: job.series_slug,
      episode_id: job.episode_id,
      action: job.action,
      count_per_shot: 1,
      only_shot_ids: [job.shot_id],
    });

    // Wait for generation to complete (poll shot record)
    let generatedCandidate: ShotGeneration | null = null;
    for (let poll = 0; poll < 60; poll++) {
      // max 5 minutes wait
      // FIX 2026-05-15 (B18): 给 setTimeout handle 加 .unref(), 防止 graceful
      // shutdown 时被这个 sleep 钉住. (类型守卫兼容 SSR/edge runtime 缺失场景.)
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, 5000);
        if (typeof (t as NodeJS.Timeout).unref === "function") (t as NodeJS.Timeout).unref();
      });
      const freshShot = await readShot(job.series_slug, job.episode_id, job.shot_id);
      const allGens = freshShot?.active_generations ?? freshShot?.generations ?? [];
      const targetType = job.action === "generate_first_frames" ? "first_frame" : "video";
      // Find the most recent done generation of the correct type
      const candidate = allGens
        .filter(g => g.type === targetType && g.status === "done")
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (candidate && candidate.created_at >= now) {
        generatedCandidate = candidate;
        break;
      }
      // Also check for failed
      const failedCandidate = allGens
        .filter(g => g.type === targetType && g.status === "failed")
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (failedCandidate && failedCandidate.created_at >= now) {
        logEntry.error = failedCandidate.error ?? "generation failed";
        logEntry.generation_id = failedCandidate.generation_id;
        break;
      }
    }

    if (generatedCandidate) {
      logEntry.generation_id = generatedCandidate.generation_id;
      logEntry.cost_cny = thisCost;
      job.cost_spent_cny += thisCost;

      // 2026-07-09 audit C20: 删掉这里的 budgetGuard.recordCharge(thisCost, job.id)。
      // 本次生成是通过上面的 orchestrator.orchestrate 跑的, orchestrator 已在生成成功后按 provider
      // 真实成本 recordCharge 过一次 (orchestrator.ts:1159)。retry job 再叠加一条估算值 (thisCost)
      // = 同一次生成重复记账 → 日账虚高 (真实¥2 + 估算¥0.5), 跑多 attempt 后其他任务 preflight 提前
      // 抛 BudgetExceededError 误拦, 且 budget_charges.jsonl 审计账本失真。
      // 保留 job.cost_spent_cny(上面那行)—— 那是 retry job 自己的估算内部预算上限 (line 268/290 检查),
      // 与全局 budgetGuard 账本独立, 不受影响。

      // Compute quality score
      const score = computeOverallScore(generatedCandidate.quality_scores);
      logEntry.score = score;

      if (score > job.best_score) {
        job.best_score = score;
        job.best_generation_id = generatedCandidate.generation_id;
      }

      // Check if this meets the threshold
      if (score >= job.quality_threshold) {
        if (job.stop_on_first_green) {
          // Stop immediately on first green
          job.status = "completed";
          if (job.auto_pick_best) {
            await autoPick(job);
          }
          loggerSync().info(`[retryJob] ${job.id}: completed (score=${score.toFixed(2)} >= threshold=${job.quality_threshold})`);
        } else {
          // Continue to find better, unless max_attempts reached
          if (job.attempts >= job.max_attempts) {
            job.status = "completed";
            if (job.auto_pick_best) {
              await autoPick(job);
            }
          }
          loggerSync().info(`[retryJob] ${job.id}: green at attempt ${attemptNum} (score=${score.toFixed(2)}), stop_on_first_green=false so continuing`);
        }
      }

      // If no green and max_attempts reached
      if (job.status === "active" && job.attempts >= job.max_attempts) {
        job.status = "max_attempts_reached";
        if (job.auto_pick_best && job.best_generation_id) {
          await autoPick(job);
        }
      }
    } else if (!logEntry.error) {
      logEntry.error = "timeout waiting for generation";
    }
  } catch (err) {
    logEntry.error = err instanceof Error ? err.message : String(err);
    loggerSync().error(`[retryJob] ${job.id}: tick error — ${logEntry.error}`);
  }

  job.attempt_log.push(logEntry);
  await saveJob(job);
  if (job.status === "active") {
    await markRetryPendingRunning(job);
  } else {
    await syncRetryPendingTerminal(job);
  }
}

/**
 * Auto-pick the best generation: mark it as picked in the shot record.
 */
async function autoPick(job: RetryJobRecord): Promise<void> {
  if (!job.best_generation_id) return;
  try {
    const pickKind = job.action === "generate_first_frames" ? "first_frame" : "video";
    // X1-5 (A6-1): 改走 pickGeneration 咽喉 — 自带"拒废案"(用户扔进废案箱的候选绝不被自动挑回,
    // 废案是与 picked 同级的用户负向决策数据) + 锁内重读原子写 (防同镜并发 append 的已扣费候选被
    // 锁外陈旧快照绝对数组覆盖丢失)。删掉旧的 readShot + map(generations) 翻 picked + updateShot
    // 绝对数组写法 (非原子 + 不校验 trashed, 会把已废弃的 best 自动挑回 → 合成页显"就绪"、真合成爆废案错)。
    const result = await pickGeneration(
      job.series_slug,
      job.episode_id,
      job.shot_id,
      job.best_generation_id,
      pickKind,
      { status: "approved", extraPatch: { picked_generation_id: job.best_generation_id } },
    );
    if (!result.ok) {
      loggerSync().warn(
        `[retryJob] ${job.id}: auto_pick_best 跳过 — 候选 ${job.best_generation_id} ${result.reason === "trashed" ? "已被用户废弃, 不自动挑回" : "不存在或已被移除"}`,
      );
      return;
    }
    loggerSync().info(`[retryJob] ${job.id}: auto_pick_best → generation ${job.best_generation_id} (score=${job.best_score.toFixed(2)})`);
  } catch (err) {
    loggerSync().error(`[retryJob] ${job.id}: auto_pick failed:`, err instanceof Error ? err.message : err);
  }
}

// ─── Poll loop ──────────────────────────────────────────────────────

async function pollActiveJobs(): Promise<void> {
  const all = await listAllJobs();
  const active = all.filter(j => j.status === "active");
  if (active.length === 0) return;

  loggerSync().info(`[retryJob] polling ${active.length} active job(s)`);
  for (const job of active) {
    try {
      await tickJob(job);
    } catch (err) {
      loggerSync().error(`[retryJob] ${job.id}: tick failed:`, err instanceof Error ? err.message : err);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * 启动新的 retry-until-satisfied job。
 * 创建持久化 record, 加入后台轮询。
 */
export async function startRetryJob(input: StartRetryJobInput): Promise<RetryJobRecord> {
  const id = ulid();
  const now = new Date().toISOString();
  const pending = createPendingJob("shot.retry_until_satisfied", {
    retry_job_id: id,
    series_slug: input.series_slug,
    episode_id: input.episode_id,
    shot_id: input.shot_id,
    action: input.action,
    max_attempts: input.max_attempts,
    quality_threshold: input.quality_threshold,
  });

  const record: RetryJobRecord = {
    id,
    attempt_id: pending.attempt_id,
    series_slug: input.series_slug,
    episode_id: input.episode_id,
    shot_id: input.shot_id,
    action: input.action,
    max_attempts: input.max_attempts,
    quality_threshold: input.quality_threshold,
    budget_cap_cny: input.budget_cap_cny,
    stop_on_first_green: input.stop_on_first_green,
    auto_pick_best: input.auto_pick_best,
    status: "active",
    attempts: 0,
    best_score: 0,
    cost_spent_cny: 0,
    attempt_log: [],
    created_at: now,
    updated_at: now,
  };

  await saveJob(record);
  updatePendingJob(pending.attempt_id, { status: "running", progress: 0, eta_s: 5 });
  ensurePollLoop();

  loggerSync().info(`[retryJob] ${id}: started (shot=${input.shot_id}, action=${input.action}, max=${input.max_attempts}, threshold=${input.quality_threshold})`);

  return record;
}

/**
 * 取消一个 retry job。
 */
export async function cancelRetryJob(jobId: string): Promise<RetryJobRecord | null> {
  const job = await loadJob(jobId);
  if (!job) return null;
  if (job.status !== "active") return job;

  job.status = "cancelled";
  await saveJob(job);
  if (job.attempt_id) cancelPendingJob(job.attempt_id);
  loggerSync().info(`[retryJob] ${jobId}: cancelled by user`);
  return job;
}

/**
 * 查询 retry job 状态。
 */
export function getRetryJob(jobId: string): Promise<RetryJobRecord | null> {
  return loadJob(jobId);
}

/**
 * 列出所有 retry jobs (可按 shot_id / status 筛选)
 */
export async function listRetryJobs(filter?: {
  series_slug?: string;
  shot_id?: string;
  status?: RetryJobStatus;
}): Promise<RetryJobRecord[]> {
  let all = await listAllJobs();
  if (filter?.series_slug) {
    all = all.filter(j => j.series_slug === filter.series_slug);
  }
  if (filter?.shot_id) {
    all = all.filter(j => j.shot_id === filter.shot_id);
  }
  if (filter?.status) {
    all = all.filter(j => j.status === filter.status);
  }
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * 确保后台轮询已启动。
 */
function ensurePollLoop(): void {
  if (!unregisterRetryPoller) {
    unregisterRetryPoller = registerPollerTask(RETRY_POLLER_NAME, pollActiveJobs, {
      intervalMs: RETRY_POLL_INTERVAL_MS,
    });
    loggerSync().info("[retryJob] registered central poller task (interval=5s)");
  }
  startJobsPoller();
}

/**
 * 启动后台轮询 (server startup 调用)。
 * 同时触发一次立即 poll 来处理断电/重启后残留的 active jobs。
 */
export function startPollLoop(): void {
  ensurePollLoop();
  setImmediate(() => {
    runPollerTaskNow(RETRY_POLLER_NAME).catch(err => {
      loggerSync().error("[retryJob] initial poll error:", err);
    });
  });
}

/**
 * 停止后台轮询。
 */
export function stopPollLoop(): void {
  if (unregisterRetryPoller) {
    unregisterRetryPoller();
    unregisterRetryPoller = null;
    stopJobsPollerIfIdle();
    loggerSync().info("[retryJob] poll loop stopped");
  }
}
