/**
 * videos stage runner.
 *
 * 从 autoPipelineRunner.ts 拆出.
 */

import { loggerSync } from "../../../../../../packages/core/src/logger";
import { orchestrator } from "../../../jobs/orchestrator";
import { listShots } from "../../../api/v2/seriesStore";
import type { AutoPipelineRecord } from "../autoPipelineRunner";
import { registerPipelineJobId } from "../autoPipelineRunner";
import { findStage, emitStage, waitAllTasksDone, autoPickGenerations } from "./shared";
import { providerIdFromModelRef, videoInstanceIdFromModelRef } from "../modelRef";
import { getVideoModelInstance } from "../../../../../../packages/core/src/videoModelInstances";
import { mapChannelToProviderId } from "../videoGenerationService";

export async function runVideosStage(record: AutoPipelineRecord, signal: AbortSignal): Promise<void> {
  const stage = findStage(record, "videos");
  stage.status = "running";
  stage.started_at = new Date().toISOString();
  record.current_stage = "videos";

  emitStage(record, "pipeline.stage.started", { stage: "videos" });

  // 2026-05-21 — 补全语义: 跳过已挑了 picked_video_generation_id 的 shot
  let shotIdFilter = record.options.shot_ids;
  if (!shotIdFilter || shotIdFilter.length === 0) {
    try {
      const allShots = await listShots(record.series_slug, record.episode_id);
      const needVideo = allShots.filter((s) => !s.picked_video_generation_id);
      if (needVideo.length < allShots.length) {
        loggerSync().info(
          `[autoPipeline:videos] 补全语义: ${allShots.length} 镜中 ${allShots.length - needVideo.length} 镜已挑视频 (skip), 只对 ${needVideo.length} 镜生视频`,
        );
      }
      shotIdFilter = needVideo.map((s) => s.id);
    } catch (err) {
      loggerSync().warn(
        `[autoPipeline:videos] listShots 失败, fallback 走全部 shot: ${err instanceof Error ? err.message : err}`,
      );
      shotIdFilter = undefined;
    }
  } else {
    loggerSync().info(
      `[autoPipeline:videos] 限定 shot_ids=[${shotIdFilter.join(",")}], 只跑这 ${shotIdFilter.length} 镜`,
    );
  }

  if (shotIdFilter && shotIdFilter.length === 0) {
    stage.status = "done";
    stage.completed = 0;
    stage.total = 0;
    stage.finished_at = new Date().toISOString();
    emitStage(record, "pipeline.stage.done", { stage: "videos", succeeded: 0, failed: 0 });
    return;
  }

  // 2026-05-27 P0 — autoPipeline 视频 stage 同款 instance: prefix unwrap. 之前
  // orchestrator _resolveTargets 也用 providerIdFromModelRef 取首段, "instance"
  // 字符串扔给 registry 找不到. 现在显式 unwrap 后传真 provider_override.
  const rawVideoRef = record.options.video_provider_id;
  let providerOverride: string | undefined;
  if (typeof rawVideoRef === "string" && rawVideoRef.trim()) {
    const instanceId = videoInstanceIdFromModelRef(rawVideoRef);
    if (instanceId) {
      const inst = getVideoModelInstance(instanceId);
      if (inst) providerOverride = mapChannelToProviderId(inst.channel);
    }
    if (!providerOverride) providerOverride = providerIdFromModelRef(rawVideoRef);
  }

  const result = await orchestrator.orchestrate({
    series_slug: record.series_slug,
    episode_id: record.episode_id,
    action: "generate_videos",
    count_per_shot: record.options.video_count_per_shot ?? 1,
    provider_override: providerOverride,
    model_ref_override: rawVideoRef,
    only_shot_ids: shotIdFilter && shotIdFilter.length > 0 ? shotIdFilter : undefined,
  });
  // 2026-05-28 P0-1: 注册 job_id, abortPipeline 才能传播到 TaskQueue.
  registerPipelineJobId(record.pipeline_id, result.job_id);

  const taskIds = result.tasks
    .filter((t) => t.status !== "skipped_limit" && t.status !== "task_skipped_budget")
    .map((t) => t.task_id);
  stage.total = taskIds.length;

  if (taskIds.length === 0) {
    stage.status = "done";
    stage.completed = 0;
    stage.finished_at = new Date().toISOString();
    emitStage(record, "pipeline.stage.done", { stage: "videos", succeeded: 0, failed: 0 });
    return;
  }

  const { done, failed } = await waitAllTasksDone(
    result.job_id,
    taskIds,
    signal,
    (completed, total) => {
      stage.completed = completed;
      emitStage(record, "pipeline.stage.progress", { stage: "videos", completed, total });
    },
  );

  stage.completed = done.length;
  stage.failed = failed.length;
  if (failed.length > 0) {
    const shotIds = failed
      .map((t) => (t.meta?.shot_id as string | undefined))
      .filter((sid): sid is string => typeof sid === "string");
    stage.failed_ids = Array.from(new Set(shotIds));
    // 2026-05-27 P0 修复同款 firstframes — videos stage 也必须填 failed_details,
    // 否则前端"重抽这一镜"按钮看不到.
    stage.failed_details = failed.map((t) => ({
      target_id: (t.meta?.shot_id as string | undefined) ?? t.id,
      error: t.error ?? "未知错误",
      ts: t.updated_at ?? new Date().toISOString(),
    }));
  }

  const pickResultVideo = await autoPickGenerations(
    record.series_slug, record.episode_id, "video",
    record.options.auto_pick_strategy ?? "quality_score",
  );

  stage.status = "done";
  stage.finished_at = new Date().toISOString();
  emitStage(record, "pipeline.stage.done", {
    stage: "videos",
    succeeded: done.length,
    failed: failed.length,
    failed_ids: stage.failed_ids ?? [],
    failed_details: stage.failed_details ?? [],
    skipped_count: pickResultVideo.skipped,
  });
}
