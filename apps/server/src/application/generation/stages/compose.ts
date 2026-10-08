/**
 * compose stage runner.
 *
 * 从 autoPipelineRunner.ts 拆出.
 */

import { composeEpisode, type ComposeEpisodeResult } from "../../compose/composeEpisode";
import type { AutoPipelineRecord } from "../autoPipelineRunner";
import { findStage, emitStage } from "./shared";
import { appendFailure } from "../../../repositories/failureRepo";
import {
  episodeComposeLockKey,
  tryAcquireEpisodeComposeLock,
  releaseEpisodeComposeLock,
  getEpisodeComposeLockHolder,
  composeLockBusyMessage,
} from "../../compose/composeLock";

export async function runComposeStage(record: AutoPipelineRecord, signal: AbortSignal): Promise<void> {
  const stage = findStage(record, "compose");
  stage.status = "running";
  stage.started_at = new Date().toISOString();
  stage.total = 1;
  record.current_stage = "compose";

  emitStage(record, "pipeline.stage.started", { stage: "compose" });

  if (signal.aborted) throw new Error("pipeline_aborted");

  const composeBody = record.options.compose_settings ?? {};

  // P1-2: 管线 compose 阶段绕过队列直调 composeEpisode, 必须与手动合成共用同一把每集互斥锁,
  // 否则用户此刻手点合成(或另一条管线的 compose 阶段)会与本阶段两个 ffmpeg 并发写同一批
  // compose 文件。拿不到锁 → 失败本阶段 + 写失败中心(用户可等当前合成完成后重试 compose 阶段),
  // 绝不静默并发。管线被 abort 时 composeEpisode 抛错, finally 一样释放锁。
  const lockKey = episodeComposeLockKey(record.series_slug, record.episode_id);
  const composeJobId = `pipeline_compose_${record.pipeline_id}`;
  const modeRaw = (composeBody as { mode?: unknown }).mode;
  const acquired = tryAcquireEpisodeComposeLock(lockKey, {
    job_id: composeJobId,
    pipeline_id: record.pipeline_id,
    source: "pipeline",
    mode: typeof modeRaw === "string" ? modeRaw : "full",
    started_at: new Date().toISOString(),
  });
  if (!acquired) {
    const holder = getEpisodeComposeLockHolder(lockKey);
    const errMsg = holder
      ? composeLockBusyMessage(holder)
      : "本集正在合成中，请等它完成后再重试合成阶段。";
    stage.status = "failed";
    stage.failed = 1;
    stage.error = errMsg;
    stage.finished_at = new Date().toISOString();
    await appendFailure(record.series_slug, {
      kind: "compose",
      code: "ComposeInProgress",
      message: errMsg,
      provider: "compose",
    });
    throw new Error(errMsg);
  }

  try {
    // 拿锁后再抹一次 abort 窗口(拿锁与开跑之间用户可能已中止管线)
    if (signal.aborted) throw new Error("pipeline_aborted");

    const result: ComposeEpisodeResult = await composeEpisode(
      { slug: record.series_slug, episodeId: record.episode_id, body: composeBody },
      {
        signal,
        progress: { progress: () => {} },
      },
    );

    if (result.kind === "validation" || result.kind === "error") {
      const errMsg = result.kind === "validation"
        ? `compose validation failed: ${result.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`
        : `compose error: ${JSON.stringify(result.body)}`;
      stage.status = "failed";
      stage.failed = 1;
      stage.error = errMsg;
      stage.finished_at = new Date().toISOString();
      // 2026-05-28 P0-3 Auto-pipeline: compose stage 失败也写 FailureCenter, 用户能在
      // 失败中心看到 "compose stage 出错" + 详细 message, 而不是只在 pipeline.failed SSE
      // 一闪而过 toast. failureRepo.appendFailure 是 fire-and-forget, 不会阻塞 throw.
      await appendFailure(record.series_slug, {
        kind: "compose",
        code: result.kind === "validation" ? "ValidationError" : "ComposeError",
        message: errMsg,
        provider: "compose",
      });
      throw new Error(errMsg);
    }

    const body = result.body as { final_video_path?: string; final_video?: string };
    record.final_video_path = body.final_video_path ?? body.final_video ?? undefined;

    stage.status = "done";
    stage.completed = 1;
    stage.finished_at = new Date().toISOString();
    emitStage(record, "pipeline.stage.done", { stage: "compose", succeeded: 1, failed: 0 });
  } finally {
    // 成功/失败/被 abort 都释放锁, 让下一次手动合成或管线能拿到本集。
    releaseEpisodeComposeLock(lockKey, composeJobId);
  }
}
