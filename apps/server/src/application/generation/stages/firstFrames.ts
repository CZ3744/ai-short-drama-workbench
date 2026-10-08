/**
 * firstframes stage runner.
 *
 * 从 autoPipelineRunner.ts 拆出.
 */

import { loggerSync } from "../../../../../../packages/core/src/logger";
import { orchestrator } from "../../../jobs/orchestrator";
import { listShots } from "../../../api/v2/seriesStore";
import type { AutoPipelineRecord } from "../autoPipelineRunner";
import { registerPipelineJobId } from "../autoPipelineRunner";
import { findStage, emitStage, waitAllTasksDone, autoPickGenerations } from "./shared";

export async function runFirstFramesStage(record: AutoPipelineRecord, signal: AbortSignal): Promise<void> {
  const stage = findStage(record, "firstframes");
  stage.status = "running";
  stage.started_at = new Date().toISOString();
  record.current_stage = "firstframes";

  emitStage(record, "pipeline.stage.started", { stage: "firstframes" });

  // 2026-05-21 — 补全语义: 跳过已挑了 picked_first_frame_generation_id 的 shot
  let shotIdFilter = record.options.shot_ids;
  if (!shotIdFilter || shotIdFilter.length === 0) {
    try {
      const allShots = await listShots(record.series_slug, record.episode_id);
      const needFirstFrame = allShots.filter((s) => !s.picked_first_frame_generation_id);
      if (needFirstFrame.length < allShots.length) {
        loggerSync().info(
          `[autoPipeline:firstframes] 补全语义: ${allShots.length} 镜中 ${allShots.length - needFirstFrame.length} 镜已挑首帧 (skip), 只对 ${needFirstFrame.length} 镜生首帧`,
        );
      }
      shotIdFilter = needFirstFrame.map((s) => s.id);
    } catch (err) {
      loggerSync().warn(
        `[autoPipeline:firstframes] listShots 失败, fallback 走全部 shot: ${err instanceof Error ? err.message : err}`,
      );
      shotIdFilter = undefined;
    }
  } else {
    loggerSync().info(
      `[autoPipeline:firstframes] 限定 shot_ids=[${shotIdFilter.join(",")}], 只跑这 ${shotIdFilter.length} 镜`,
    );
  }

  if (shotIdFilter && shotIdFilter.length === 0) {
    stage.status = "done";
    stage.completed = 0;
    stage.total = 0;
    stage.finished_at = new Date().toISOString();
    emitStage(record, "pipeline.stage.done", { stage: "firstframes", succeeded: 0, failed: 0, skipped_count: 0 });
    return;
  }

  const result = await orchestrator.orchestrate({
    series_slug: record.series_slug,
    episode_id: record.episode_id,
    action: "generate_first_frames",
    count_per_shot: record.options.image_count_per_shot ?? 1,
    model_ref_override: record.options.image_provider_id,
    only_shot_ids: shotIdFilter && shotIdFilter.length > 0 ? shotIdFilter : undefined,
  });
  // 2026-05-28 P0-1: 把 orchestrator 返回的 job_id 注册到 pipeline runtime, 让 abortPipeline
  // 能调 orchestrator.abortJob(jobId) 把 TaskQueue 内的真任务也 abort 掉.
  registerPipelineJobId(record.pipeline_id, result.job_id);

  const taskIds = result.tasks
    .filter((t) => t.status !== "skipped_limit" && t.status !== "task_skipped_budget")
    .map((t) => t.task_id);
  stage.total = taskIds.length;

  if (taskIds.length === 0) {
    stage.status = "done";
    stage.completed = 0;
    stage.finished_at = new Date().toISOString();
    emitStage(record, "pipeline.stage.done", { stage: "firstframes", succeeded: 0, failed: 0 });
    return;
  }

  const { done, failed } = await waitAllTasksDone(
    result.job_id,
    taskIds,
    signal,
    (completed, total) => {
      stage.completed = completed;
      emitStage(record, "pipeline.stage.progress", { stage: "firstframes", completed, total });
    },
  );

  stage.completed = done.length;
  stage.failed = failed.length;
  if (failed.length > 0) {
    const shotIds = failed
      .map((t) => (t.meta?.shot_id as string | undefined))
      .filter((sid): sid is string => typeof sid === "string");
    stage.failed_ids = Array.from(new Set(shotIds));
    // 2026-05-27 P0 修复: firstframes/videos stage 之前只填 failed_ids 不填 failed_details,
    // 前端面板"重抽这一镜"按钮永远不显示 (它检查 failed_details.length > 0).
    // 现在把 task.error 一起塞 details 让面板能渲染.
    stage.failed_details = failed.map((t) => ({
      target_id: (t.meta?.shot_id as string | undefined) ?? t.id,
      error: t.error ?? "未知错误",
      ts: t.updated_at ?? new Date().toISOString(),
    }));
  }

  const pickResult = await autoPickGenerations(
    record.series_slug, record.episode_id, "first_frame",
    record.options.auto_pick_strategy ?? "quality_score",
  );

  stage.status = "done";
  stage.finished_at = new Date().toISOString();
  emitStage(record, "pipeline.stage.done", {
    stage: "firstframes",
    succeeded: done.length,
    failed: failed.length,
    failed_ids: stage.failed_ids ?? [],
    failed_details: stage.failed_details ?? [],
    skipped_count: pickResult.skipped,
  });
}
