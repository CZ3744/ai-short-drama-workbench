/**
 * Failure scanner repository — extracted from seriesStore.ts (step 1: 按聚合根拆上帝模块).
 * T6: 增量持久化 appendFailure + 集中读 listFailures (从 jsonl 读，不扫目录).
 * T8: 类型来源改为 packages/drama/src/types (SeriesData/ShotData).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readJson, ensureDir } from "../../../../packages/core/src/index";
// T8: 类型来自 drama/types，已上移
import type { SeriesData, ShotData } from "../../../../packages/drama/src/types";
import { listTasks } from "../api/v2/seriesStore";
import { SERIES_ROOT, DATA_ROOT, seriesFile, shotsDir } from "./_paths";

// ─── Failure Scanner (C5 Failure Center) ────────────────────────────────

export interface ScannedFailure {
  id: string;
  source: "generation" | "task";
  kind?: string;
  provider?: string;
  series_slug?: string;
  series_title?: string;
  episode_id?: string;
  shot_id?: string;
  task_id?: string;
  generation_id?: string;
  job_id?: string;
  error_code?: string;
  error_message?: string;
  raw_error?: string;
  prompt_final?: string;
  prompt_snippet?: string;
  cost_cny?: number;
  created_at?: string;
  ignored?: boolean;
  retry_count?: number;
}

/**
 * Scan all series for failed ShotGenerations (status === "failed").
 * Walks data/series/<slug>/episodes/<epId>/shots/*.json across all series.
 */
export async function scanAllFailedGenerations(): Promise<ScannedFailure[]> {
  const results: ScannedFailure[] = [];
  if (!(await pathExists(SERIES_ROOT))) return results;

  const seriesDirs = await fs.readdir(SERIES_ROOT, { withFileTypes: true });
  for (const sd of seriesDirs) {
    if (!sd.isDirectory()) continue;
    const slug = sd.name;
    const sf = seriesFile(slug);
    if (!(await pathExists(sf))) continue;
    let seriesData: SeriesData | null = null;
    try { seriesData = await readJson<SeriesData>(sf); } catch { continue; }
    if (!seriesData || seriesData._deleted) continue;

    for (const epId of seriesData.episodes || []) {
      const shotsDirPath = shotsDir(slug, epId);
      if (!(await pathExists(shotsDirPath))) continue;
      let shotFiles: string[];
      try { shotFiles = await fs.readdir(shotsDirPath); } catch { continue; }

      for (const fileName of shotFiles) {
        if (!fileName.endsWith(".json")) continue;
        const shotId = fileName.replace(".json", "");
        let shot: ShotData | null = null;
        try {
          shot = await readJson<ShotData>(path.join(shotsDirPath, fileName));
        } catch { continue; }
        if (!shot) continue;

        const generations = shot.generations ?? [];
        for (const gen of generations) {
          if (gen.status !== "failed") continue;
          results.push({
            id: `gen:${gen.generation_id}`,
            source: "generation",
            kind: gen.type,
            provider: gen.provider,
            series_slug: slug,
            series_title: seriesData.title,
            episode_id: epId,
            shot_id: shotId,
            generation_id: gen.generation_id,
            error_code: gen.error_code,
            error_message: gen.error || gen.error_message,
            raw_error: gen.error || gen.error_message,
            prompt_final: gen.prompt_final,
            prompt_snippet: (shot.prompt_img as string | undefined) || (shot.prompt_vid as string | undefined) || shot.action,
            cost_cny: gen.cost_cny,
            created_at: gen.created_at,
          });
        }
      }
    }
  }
  return results;
}

/**
 * Scan all failed TaskRecords (status === "failed").
 */
export function scanAllFailedTasks(): ScannedFailure[] {
  const results: ScannedFailure[] = [];
  for (const task of listTasks()) {
    if (task.status !== "failed") continue;
    const seriesSlug =
      typeof task.meta?.series_slug === "string" ? task.meta.series_slug :
      typeof task.meta?.slug === "string" ? task.meta.slug :
      undefined;
    const episodeId =
      typeof task.meta?.episode_id === "string" ? task.meta.episode_id :
      typeof task.meta?.ep_id === "string" ? task.meta.ep_id :
      typeof task.meta?.epId === "string" ? task.meta.epId :
      undefined;
    results.push({
      id: `task:${task.id}`,
      source: "task",
      kind: task.kind,
      provider: task.provider_id,
      series_slug: seriesSlug,
      series_title: typeof task.meta?.series_title === "string" ? task.meta.series_title : undefined,
      episode_id: episodeId,
      shot_id: typeof task.meta?.shot_id === "string" ? task.meta.shot_id : undefined,
      task_id: task.id,
      job_id: task.job_id,
      error_code: task.meta?.error_code as string | undefined,
      error_message: task.error || (task.meta?.error_message as string | undefined),
      raw_error: task.error || (task.meta?.error_message as string | undefined),
      prompt_snippet: (task.meta?.prompt as string | undefined) || (task.meta?.shot_action as string | undefined),
      cost_cny: task.meta?.cost_estimate_cny as number | undefined,
      created_at: task.updated_at || task.created_at,
    });
  }
  return results;
}

// ─── T6: 增量持久化 ─────────────────────────────────────────────────────────

/** T6: 跨项目全局索引文件，增量 append */
const GLOBAL_FAILURES_FILE = path.join(DATA_ROOT, "failures.jsonl");
const seriesTitleCache = new Map<string, string | undefined>();

/** T6: 单系列 failures.jsonl 路径 */
function seriesFailuresFile(seriesSlug: string): string {
  return path.join(SERIES_ROOT, seriesSlug, "failures.jsonl");
}

async function readSeriesTitle(seriesSlug?: string): Promise<string | undefined> {
  if (!seriesSlug) return undefined;
  if (seriesTitleCache.has(seriesSlug)) return seriesTitleCache.get(seriesSlug);
  try {
    const seriesData = await readJson<SeriesData>(seriesFile(seriesSlug));
    const title = typeof seriesData?.title === "string" && seriesData.title.trim()
      ? seriesData.title.trim()
      : undefined;
    seriesTitleCache.set(seriesSlug, title);
    return title;
  } catch {
    seriesTitleCache.set(seriesSlug, undefined);
    return undefined;
  }
}

export interface FailureRecord {
  ts: string;
  series_slug?: string;
  shot_id?: string;
  code?: string;
  message_redacted?: string;
  attempt_id?: string;
  kind?: string;
  provider?: string;
}

/**
 * T6: 追加一条失败记录到:
 *   1. data/series/<slug>/failures.jsonl  (单系列增量)
 *   2. data/failures.jsonl               (全局跨项目集中索引)
 *
 * fs.appendFile 是 OS 级 atomic append，无需额外锁。
 * 失败时 console.warn，不抛出（非阻塞）。
 */
export async function appendFailure(
  seriesSlug: string | undefined,
  failure: {
    shot_id?: string;
    code?: string;
    message?: string;
    attempt_id?: string;
    kind?: string;
    provider?: string;
  },
): Promise<void> {
  const record: FailureRecord = {
    ts: new Date().toISOString(),
    series_slug: seriesSlug,
    shot_id: failure.shot_id,
    code: failure.code,
    message_redacted: failure.message ? failure.message.slice(0, 500) : undefined,
    attempt_id: failure.attempt_id,
    kind: failure.kind,
    provider: failure.provider,
  };
  const line = JSON.stringify(record) + "\n";

  // Write to both series-local and global files (fire-and-forget, non-blocking)
  const writes: Promise<void>[] = [];

  // 1. series-local
  if (seriesSlug) {
    const seriesDir = path.join(SERIES_ROOT, seriesSlug);
    writes.push(
      ensureDir(seriesDir)
        .then(() => fs.appendFile(seriesFailuresFile(seriesSlug), line, "utf8"))
        .catch((err) => {
          console.warn("[failureRepo] failed to append series failure:", err?.message ?? err);
        }),
    );
  }

  // 2. global index
  writes.push(
    ensureDir(DATA_ROOT)
      .then(() => fs.appendFile(GLOBAL_FAILURES_FILE, line, "utf8"))
      .catch((err) => {
        console.warn("[failureRepo] failed to append global failure:", err?.message ?? err);
      }),
  );

  await Promise.all(writes);
}

/**
 * T6: 读取 failures — 优先读 data/failures.jsonl，不存在时 fallback 到目录扫描。
 * 保留旧 scanAllFailedGenerations 作 fallback。
 */
export async function listFailures(): Promise<ScannedFailure[]> {
  // Try fast path: read from global jsonl index
  if (await pathExists(GLOBAL_FAILURES_FILE)) {
    try {
      const content = await fs.readFile(GLOBAL_FAILURES_FILE, "utf8");
      const results: ScannedFailure[] = [];
      let lineNum = 0;
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lineNum++;
        try {
          const rec: FailureRecord = JSON.parse(trimmed);
          results.push({
            id: `failure:${rec.ts}:${lineNum}`,
            source: "generation",
            kind: rec.kind,
            provider: rec.provider,
            series_slug: rec.series_slug,
            series_title: await readSeriesTitle(rec.series_slug),
            shot_id: rec.shot_id,
            error_code: rec.code,
            error_message: rec.message_redacted,
            raw_error: rec.message_redacted,
            created_at: rec.ts,
          });
        } catch { /* skip malformed */ }
      }
      // Also merge in-memory task failures (always fresh)
      results.push(...scanAllFailedTasks());
      return results;
    } catch {
      // fall through to directory scan
    }
  }

  // Fallback: full directory scan (original implementation)
  const [genFailures, taskFailures] = await Promise.all([
    scanAllFailedGenerations(),
    Promise.resolve(scanAllFailedTasks()),
  ]);
  return [...genFailures, ...taskFailures];
}
