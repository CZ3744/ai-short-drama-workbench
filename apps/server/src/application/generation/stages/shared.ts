/**
 * shared — autoPipeline stage 共享 helper.
 *
 * 从 autoPipelineRunner.ts 拆出: emitStage / setStageState / findStage /
 * waitAllTasksDone / autoPickGenerations.
 * 不依赖任何 stage runner, 不引入循环 import (类型从 autoPipelineRunner import type).
 */

import { sseBroker } from "../../../api/v2/sseBroker";
import { persistPipeline } from "../../../repositories/pipelineStore";
import { listTasks, type TaskRecord } from "../../../repositories/taskRepo";
import { listShots, pickGeneration } from "../../../api/v2/seriesStore";
import type {
  AutoPipelineRecord,
  AutoPipelineStage,
  AutoPipelineStageState,
  AutoPipelinePickStrategy,
} from "../autoPipelineRunner";

// ─── SSE emit + persist ────────────────────────────────────────────

export function emitStage(record: AutoPipelineRecord, type:
  | "pipeline.stage.started" | "pipeline.stage.progress"
  | "pipeline.stage.done"    | "pipeline.done"
  | "pipeline.failed"        | "pipeline.aborted",
  extra: Record<string, unknown> = {}): void {
  const at = new Date().toISOString();
  sseBroker.broadcast(type, {
    pipeline_id: record.pipeline_id,
    series_slug: record.series_slug,
    episode_id: record.episode_id,
    at,
    ...extra,
  });
  void persistPipeline(record);
}

// ─── Stage state helpers ───────────────────────────────────────────

export function setStageState(
  record: AutoPipelineRecord,
  stageId: AutoPipelineStage,
  patch: Partial<AutoPipelineStageState>,
): void {
  const s = record.stages.find((x) => x.id === stageId);
  if (!s) return;
  Object.assign(s, patch);
}

export function findStage(record: AutoPipelineRecord, stageId: AutoPipelineStage): AutoPipelineStageState {
  const s = record.stages.find((x) => x.id === stageId);
  if (!s) throw new Error(`unknown stage ${stageId}`);
  return s;
}

// ─── Task polling ──────────────────────────────────────────────────

/**
 * 轮询 listTasks(job_id) 等到所有 task 进入 done|failed 终态.
 */
export async function waitAllTasksDone(
  jobId: string,
  expectedTaskIds: string[],
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
): Promise<{ done: TaskRecord[]; failed: TaskRecord[] }> {
  const total = expectedTaskIds.length;
  if (total === 0) return { done: [], failed: [] };

  const expectedSet = new Set(expectedTaskIds);
  let lastCompleted = 0;

  const TICK_MS = 500;

  // eslint-disable-next-line no-constant-condition
  for (;;) {
    if (signal.aborted) {
      throw new Error("pipeline_aborted");
    }
    const tasks = listTasks({ job_id: jobId });
    const settled = tasks.filter((t) => expectedSet.has(t.id) && (t.status === "done" || t.status === "failed"));
    if (settled.length !== lastCompleted) {
      lastCompleted = settled.length;
      onProgress(lastCompleted, total);
    }
    if (settled.length >= total) {
      const done = settled.filter((t) => t.status === "done");
      const failed = settled.filter((t) => t.status === "failed");
      return { done, failed };
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

// ─── Auto pick ─────────────────────────────────────────────────────

/**
 * 按策略给每个 shot 自动挑 picked 首帧/视频.
 */
export async function autoPickGenerations(
  slug: string,
  epId: string,
  kind: "first_frame" | "video",
  strategy: AutoPipelinePickStrategy,
): Promise<{ picked: number; skipped: number }> {
  const shots = await listShots(slug, epId);
  let picked = 0;
  let skipped = 0;
  for (const shot of shots) {
    // 2026-07-10 Fable P1-5 — 自动挑选必须排除用户已废弃的候选 (generations = active+trashed 并集),
    // 否则把用户手动扔进废案箱的图选回来当首帧、还拿去生付费视频 = 自动化推翻用户显式否决 (铁律#2).
    const trashedIds = new Set((shot.trashed_generations ?? []).map((g) => g.generation_id));
    const candidates = (shot.generations || []).filter(
      (g) => g.type === kind && g.status === "done" && (g.asset_id || g.vault_id || g.path) && !trashedIds.has(g.generation_id),
    );
    if (candidates.length === 0) { skipped++; continue; }
    const pickedAlready = kind === "first_frame"
      ? shot.picked_first_frame_generation_id
      : shot.picked_video_generation_id;
    if (pickedAlready && candidates.some((g) => g.generation_id === pickedAlready)) {
      picked++;
      continue;
    }

    let chosen = candidates[0];
    if (strategy === "quality_score") {
      const scored = candidates
        .map((g) => {
          const qs = g.quality_scores;
          if (!qs) return { g, avg: -1 };
          const vals = [qs.composition, qs.sharpness, qs.prompt_alignment, qs.subject_completeness]
            .filter((v): v is number => typeof v === "number");
          const avg = vals.length === 0 ? -1 : vals.reduce((s, v) => s + v, 0) / vals.length;
          return { g, avg };
        })
        .sort((a, b) => b.avg - a.avg);
      const top = scored[0];
      if (top && top.avg >= 0) chosen = top.g;
    }

    // 2026-05-22 P0-A entity-first 双事实修复: autoPick 同时写
    //   1) shot.picked_*_generation_id (主真理源, pickedAssetResolver 读这个)
    //   2) generation.picked 标志位 (legacy 冗余信号, 兼容老 caller / 老数据)
    // 若只写 (1) → 用户老数据 generation.picked=true 残留 → 主/legacy 路径双事实矛盾.
    // 跟 shotController.pickGeneration / shotStageController video.select 的同款双写做法.
    //
    // 2026-07-10 audit 补漏 — 原子化: 之前 map(未加锁快照 shot.generations) + updateShot(patch 带
    // 绝对 generations 数组), 同镜并发 appendGeneration 追加的已扣费候选会被陈旧数组整段覆盖冲掉.
    // 改走 shotRepo.pickGeneration (锁内重读 fresh generations 再翻 picked 标志 + 写 picked 指针),
    // 双写 picked 标志 + picked 指针的语义不变.
    //
    // first_frame 自动 pick 后也翻 status (跟 firstframe.ts / 用户手动 select 对齐):
    //   · 已有 picked_video → approved
    //   · 否则 → picked
    // (之前只 video 翻 status, first_frame 漏 → 生图失败留下的 status="failed" 一直挂着,
    //  用户重抽成功后分镜板仍显示"失败"标签.)
    if (kind === "first_frame") {
      await pickGeneration(slug, epId, shot.id, chosen.generation_id, "first_frame", {
        status: shot.picked_video_generation_id ? "approved" : "picked",
      });
    } else {
      await pickGeneration(slug, epId, shot.id, chosen.generation_id, "video", {
        status: "approved",
        extraPatch: { picked_generation_id: chosen.generation_id },
      });
    }
    picked++;
  }
  return { picked, skipped };
}
