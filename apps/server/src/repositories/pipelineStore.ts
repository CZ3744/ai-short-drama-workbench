/**
 * pipelineStore — auto-pipeline 状态磁盘持久化 (优化 5, 2026-05-19).
 *
 * 痛点: autoPipelineRunner.ts 的 _running Map 是内存级, 服务重启 record 全丢.
 * 50 镜跑 1-2 小时崩溃只能从头, 用户无法在 ComposePage 看历史 pipeline.
 *
 * 设计:
 *   - 每条 pipeline 一个 JSON 文件 (data/pipelines/<pipeline_id>.json)
 *   - fire-and-forget 持久化: emitStage 调用时 `void persistPipeline(record)`,
 *     不阻塞主流程, 即使写盘失败 pipeline 继续跑
 *   - 进程启动时 recoverPipelinesOnStartup() 扫一遍磁盘:
 *     - status="running" 但 _running Map 没有 → 标 "aborted" + error="进程重启时丢失"
 *     - 终态 (done/failed/aborted) 保留磁盘, 让 UI 能查历史
 *   - getPipeline / listPipelines 合并内存 + 磁盘 (runner 负责)
 *
 * 不做的事:
 *   - 不"恢复 running 续跑" — fire-and-forget chain 无法跨进程
 *     (orchestrator 内已 enqueue 的 task 会被 markRunningTasksFailedOnStartup
 *     标 failed, pipeline 也只能标 aborted)
 *   - 不写 lock 文件 — 单实例工作站, _running Map 已是单写者
 *
 * Pipeline 文件大小: 单条 record 体积 < 5KB, 100 条 = 500KB 完全够用
 */

import path from "node:path";
import fs from "node:fs/promises";
import {
  DATA_ROOT,
  ensureDir,
  pathExists,
  readJson,
  writeJson,
} from "../../../../packages/core/src/index";
// type-only import 防止循环依赖 — runner 也 import 本文件, 必须用 `import type`
// 让 esbuild / tsx 在运行时 elide (TS5.0+ verbatimModuleSyntax 友好).
import type { AutoPipelineRecord } from "../application/generation/autoPipelineRunner";

export const PIPELINES_DIR = path.join(DATA_ROOT, "pipelines");

function pipelineFile(pipelineId: string): string {
  // 防御: pipeline_id 走 ulid + 固定前缀, 这里再加一层路径穿越校验
  if (
    pipelineId.includes("..") ||
    pipelineId.includes("/") ||
    pipelineId.includes("\\")
  ) {
    throw new Error(`Invalid pipeline_id: ${pipelineId}`);
  }
  return path.join(PIPELINES_DIR, `${pipelineId}.json`);
}

/**
 * Fire-and-forget 写盘. 调用方应当 `void persistPipeline(record)`, 不要 await.
 * 写盘失败只打 warn, 不抛 — pipeline 主流程比持久化重要.
 */
export async function persistPipeline(record: AutoPipelineRecord): Promise<void> {
  try {
    await ensureDir(PIPELINES_DIR);
    await writeJson(pipelineFile(record.pipeline_id), record);
  } catch (err) {
    // 故意 swallow — 别让磁盘问题中断 pipeline 主流程
    console.warn(
      `[pipelineStore] persistPipeline failed (${record.pipeline_id}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

export async function loadPipeline(
  pipelineId: string,
): Promise<AutoPipelineRecord | null> {
  const fp = pipelineFile(pipelineId);
  if (!(await pathExists(fp))) return null;
  return await readJson<AutoPipelineRecord>(fp);
}

/**
 * 列出所有持久化 pipeline (含终态). 按 started_at desc 排序.
 * 失败 (目录不存在 / 单文件坏) → 静默跳过, 返回能读出来的部分.
 */
export async function listPersistedPipelines(): Promise<AutoPipelineRecord[]> {
  if (!(await pathExists(PIPELINES_DIR))) return [];
  let entries: string[];
  try {
    entries = await fs.readdir(PIPELINES_DIR);
  } catch {
    return [];
  }
  const records = await Promise.all(
    entries
      .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"))
      .map((name) =>
        readJson<AutoPipelineRecord>(path.join(PIPELINES_DIR, name)).catch(
          () => null,
        ),
      ),
  );
  return records
    .filter((r): r is AutoPipelineRecord => r !== null && !!r.pipeline_id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/**
 * 删除单条 pipeline 持久化. 仅允许终态 (done/aborted/failed) — running 不删.
 * 返回 true=已删, false=不存在或非终态.
 */
export async function deletePipeline(pipelineId: string): Promise<boolean> {
  const rec = await loadPipeline(pipelineId);
  if (!rec) return false;
  if (rec.status === "running" || rec.status === "pending") return false;
  try {
    await fs.unlink(pipelineFile(pipelineId));
    return true;
  } catch {
    return false;
  }
}

/**
 * 进程启动时调一次: 扫磁盘, 把 status="running" 的 pipeline 全标 "aborted"
 * + error="进程重启时丢失" — 避免 UI 永远显示 running.
 *
 * 调用方负责把恢复后的 record 重新塞进 _running Map (如果还想让 abortPipeline /
 * getPipeline 命中); 但通常只是终态展示用, 不重新塞.
 *
 * 返回标记 aborted 的 pipeline_id 列表.
 */
export async function recoverPipelinesOnStartup(): Promise<{
  marked_aborted: string[];
  total_scanned: number;
}> {
  const all = await listPersistedPipelines();
  const markedAborted: string[] = [];
  for (const rec of all) {
    if (rec.status === "running" || rec.status === "pending") {
      rec.status = "aborted";
      const finishedAt = new Date().toISOString();
      rec.finished_at = finishedAt;
      // 给当前 stage 也标 aborted
      if (rec.current_stage) {
        const stage = rec.stages.find((s) => s.id === rec.current_stage);
        if (stage && (stage.status === "running" || stage.status === "pending")) {
          stage.status = "aborted";
          stage.error = "进程重启时丢失 — fire-and-forget chain 无法跨进程恢复";
          stage.finished_at = finishedAt;
        }
      }
      await persistPipeline(rec);
      markedAborted.push(rec.pipeline_id);
    }
  }
  return { marked_aborted: markedAborted, total_scanned: all.length };
}
