/**
 * autoPipelineRunner — 一键自动管线 chain runner.
 *
 * 用户原话:
 *   "剧本确定后, 生成分镜检查觉得没问题, 通过自动化的按钮选一个 api,
 *    系统按顺序生成每一分镜的首帧图, 并用首帧图生成视频,
 *    为防止并发, 图像和视频都分别并行执行, 最后生成结束之后自动拼接好停在导出前界面"
 *
 * 设计:
 *   - Stage 1: 调 orchestrator.orchestrate(action="generate_first_frames") — 内部按 shot 并行
 *   - 等所有 first-frame task 跑完(轮询 listTasks filter by job_id), 失败的 shot 跳过不阻塞
 *   - 用 auto_pick_strategy 给每个 shot 挑 picked_first_frame_generation_id
 *   - Stage 2: 调 orchestrator.orchestrate(action="generate_videos") — i2v 用刚挑的首帧锚定
 *   - 等所有 video task 跑完, 自动挑 picked_video_generation_id + 标 approved
 *   - Stage 3: 调 composeEpisode — TTS + ffmpeg concat + 字幕烧录
 *   - 全程 emit pipeline.* SSE 事件; signal.aborted → 停下一 stage
 *
 * 中断契约:
 *   - 用户点中断, AbortController.abort() 触发 signal
 *   - 当前正在跑的 stage(已 enqueue 的 task)继续跑完(orchestrator 不接受外部 abort)
 *     — 下一 stage 不会启动, runner return + emit pipeline.aborted
 *
 * 重试 stage 契约:
 *   - retry-stage 接受 firstframes / videos / compose
 *   - 重新跑指定 stage, 前面 stage 跳过(用现有 picked 数据)
 *
 * Provider 决策:
 *   - image_provider_id / video_provider_id 来自 body, 不传 → orchestrator 内部读 series.defaults
 *   - 任一 provider 空 → resolveProviderId throw, runner emit pipeline.failed
 */

import { ulid } from "ulid";
import { loggerSync } from "../../../../../packages/core/src/logger";
import {
  persistPipeline,
  loadPipeline,
  listPersistedPipelines,
} from "../../repositories/pipelineStore";
import { emitStage, setStageState, findStage } from "./stages/shared";
import { runElementImagesStage } from "./stages/elementImages";
import { runFirstFramesStage } from "./stages/firstFrames";
import { runVideosStage } from "./stages/videos";
import { runComposeStage } from "./stages/compose";
import { orchestrator } from "../../jobs/orchestrator";

// ─── Types ─────────────────────────────────────────────────────────

export type AutoPipelineStage = "element_images" | "firstframes" | "videos" | "compose";
export type AutoPipelineStageStatus = "pending" | "running" | "done" | "failed" | "aborted" | "skipped";
export type AutoPipelinePickStrategy = "first" | "quality_score";

export interface AutoPipelineStageState {
  id: AutoPipelineStage;
  status: AutoPipelineStageStatus;
  total: number;
  completed: number;
  failed: number;
  error?: string;
  started_at?: string;
  finished_at?: string;
  /**
   * 2026-05-19 反馈 #2: 单 stage 内失败的目标 id 数组.
   *   - element_images stage → element_id
   *   - firstframes / videos stage → shot_id
   *   - compose stage → 不用 (单点失败)
   *
   * 前端 AutoPipelineProgressPanel 在完成态显示"重试失败的 N 项"按钮时, 拿这个数组
   * 透传到 retryStage(stage, { shot_ids|element_ids }) — 只重跑失败的部分而非整 stage.
   *
   * 不传或空数组 = 没有失败 / 或这个 stage 不支持精确 id 追踪.
   */
  failed_ids?: string[];
  /**
   * 2026-05-22 bug B 修: 单 stage 内失败的明细列表 (target_id + 子条目 + 错误信息).
   * UI 显示 "林小鹿 第 1 张「正面标准像」生成失败: 超时" 而非只看到 element_id.
   *   - element_images stage → 每条 brief 失败一条
   *   - 其他 stage 可选填(目前 firstframes / videos 走 task 走 failureRepo)
   */
  failed_details?: Array<{
    target_id: string;
    target_name?: string;
    sub_label?: string;
    sub_index?: number;
    /** 2026-05-26 单条重抽走独立 API — 前端拿 brief_id 直接调 /elements/:id/generate-image, 不打断 pipeline */
    brief_id?: string;
    error: string;
    ts: string;
  }>;
}

export interface AutoPipelineRecord {
  pipeline_id: string;
  series_slug: string;
  episode_id: string;
  status: "pending" | "running" | "done" | "failed" | "aborted";
  current_stage: AutoPipelineStage | null;
  stages: AutoPipelineStageState[];
  started_at: string;
  finished_at?: string;
  /** compose 完成后的 final.mp4 相对路径 */
  final_video_path?: string;
  options: AutoPipelineOptions;
}

export interface AutoPipelineOptions {
  image_provider_id?: string;
  video_provider_id?: string;
  image_count_per_shot?: number;
  video_count_per_shot?: number;
  /** 透传到 composeEpisode 的 body. 不传走 episode 默认. */
  compose_settings?: Record<string, unknown>;
  auto_pick_strategy?: AutoPipelinePickStrategy;
  /**
   * 2026-05-19 #8c: 跳过 "为每个 element 按 image_briefs 生图" 阶段.
   * 默认 false (即默认会跑此阶段).
   * 当 series 内所有 element 都没有 image_briefs 时, 这一 stage 自动 status="skipped".
   */
  skip_element_images?: boolean;
  /**
   * 2026-05-19 #4 反向开关: 只跑 element_images stage, 跳过 firstframes/videos/compose.
   * 用于素材库"一键补全素材图"按钮 — 用户进列表页一键补全所有 image_briefs, 不下推后面阶段.
   * 默认 false (走全链路). 与 skip_element_images 互斥 (only=true 时 skip 自动失效).
   * 此模式下也不要求 video_provider_id (preflight 跳过视频校验).
   */
  only_element_images?: boolean;
  /**
   * 2026-05-19 #C: 只跑 element_images + firstframes 两 stage, 跳过 videos/compose.
   * 用于"整集挂机抽首帧"场景 — 用户只想看首帧成果再决定要不要往下推视频/合成.
   * 默认 false (全链路). 与 only_element_images 互斥 (后者只跑 element_images).
   * 此模式下也不要求 video_provider_id (preflight 跳过视频校验).
   */
  only_firstframes?: boolean;
  /**
   * 2026-05-20 Wave T S8: 只跑 videos stage, 不重抽素材图 / 首帧 / 合成.
   * 用于失败中心多选少量视频失败镜头后,只重抽这些镜的视频候选.
   */
  only_videos?: boolean;
  /**
   * 2026-05-19 优化 6: 限定本次 firstframes / videos stage 只处理这些 shot.
   *
   * 用法 1: bulk retry 失败 — 失败中心多选 N 镜重抽 → 只跑这 N 镜不是整集 50 镜.
   * 用法 2: 素材 typical 换了 (优化 3) — 反查 usage 拿引用 shot_ids → 只重抽这些首帧.
   *
   * 不传或空数组 → 走现有逻辑全部 shot (行为不变, 向后兼容).
   * 不影响 element_images stage (它用 element_ids 维度, 见下).
   *
   * 透传到 orchestrator.orchestrate 的 only_shot_ids — 已有 filter 逻辑, 直接复用.
   */
  shot_ids?: string[];
  /**
   * 2026-05-19 优化 6: 限定本次 element_images stage 只处理这些 element.
   *
   * 用法: 单个 element 手动补全 image_briefs / bulk retry element 失败.
   * 不传或空数组 → 走现有逻辑全部 element.
   */
  element_ids?: string[];
}

interface RuntimeEntry {
  record: AutoPipelineRecord;
  abort: AbortController;
  /**
   * 2026-05-28 P0-1: pipeline 各 stage 通过 orchestrator.orchestrate 启动的 jobId 列表.
   * abortPipeline 时不只 abort.abort() signal, 还要遍历 jobIds 调 orchestrator.abortJob(jobId)
   * 让 TaskQueue 内的 task 也接收 abort signal, 否则远端 fetch 仍在 fire-and-forget 跑.
   * stage runner 调用 orchestrator.orchestrate 后 push result.job_id 到这里.
   */
  jobIds: string[];
}

/**
 * 2026-05-28 P0-1: 给 stage runner 用的注册 helper. firstFrames / videos stage 调
 * orchestrator.orchestrate 拿到 job_id 后调一次, abortPipeline 才能传播 abort 到 TaskQueue.
 */
export function registerPipelineJobId(pipelineId: string, jobId: string): void {
  const entry = _running.get(pipelineId);
  if (!entry || !jobId) return;
  if (!entry.jobIds.includes(jobId)) {
    entry.jobIds.push(jobId);
  }
}

// ─── Runtime registry ──────────────────────────────────────────────
//
// 内存级 registry. 单实例工作站够用, 不持久化. 进程重启所有 in-flight pipeline 自动消失
// — orchestrator 写入的 shot.generations / picked_* 已落盘, 用户可手动到合成页继续.

const _running = new Map<string, RuntimeEntry>();

/**
 * 取单条 pipeline. 先查内存 _running (含 running / 刚跑完的), 没有再查磁盘
 * (历史终态 / 进程重启前的 record).
 * 优化 5 (2026-05-19): 加磁盘 fallback, 让用户重启后还能查历史 pipeline.
 */
export async function getPipeline(pipelineId: string): Promise<AutoPipelineRecord | null> {
  const mem = _running.get(pipelineId)?.record;
  if (mem) return mem;
  return await loadPipeline(pipelineId);
}

/**
 * 列出 pipeline. 合并内存 + 磁盘, 同 pipeline_id 优先用内存版 (最新状态).
 * 优化 5 (2026-05-19): 加磁盘合并, 让 UI 看到完整历史.
 */
export async function listPipelines(
  filter?: { series_slug?: string; episode_id?: string },
): Promise<AutoPipelineRecord[]> {
  const memRecords = Array.from(_running.values()).map((e) => e.record);
  const memIds = new Set(memRecords.map((r) => r.pipeline_id));
  const diskRecords = (await listPersistedPipelines()).filter(
    (r) => !memIds.has(r.pipeline_id),
  );
  const all = [...memRecords, ...diskRecords];
  if (!filter) return all;
  return all.filter((r) =>
    (!filter.series_slug || r.series_slug === filter.series_slug) &&
    (!filter.episode_id || r.episode_id === filter.episode_id),
  );
}

export async function abortPipeline(pipelineId: string): Promise<{ ok: boolean; reason?: string }> {
  const entry = _running.get(pipelineId);
  if (!entry) {
    // 优化 5 (2026-05-19): 内存里没有 — 看磁盘上有没有(可能是重启前的 running 已被
    // recoverPipelinesOnStartup 标 aborted, 也可能是历史终态). 返 not_found / 终态原因.
    const disk = await loadPipeline(pipelineId);
    if (!disk) return { ok: false, reason: "pipeline_not_found" };
    if (disk.status === "running" || disk.status === "pending") {
      // 异常: 磁盘 running 但内存没 — 兜底标 aborted (startup recover 漏了)
      disk.status = "aborted";
      disk.finished_at = new Date().toISOString();
      await persistPipeline(disk);
      return { ok: true };
    }
    return { ok: false, reason: `pipeline_already_${disk.status}` };
  }
  if (entry.record.status === "done" || entry.record.status === "failed" || entry.record.status === "aborted") {
    return { ok: false, reason: `pipeline_already_${entry.record.status}` };
  }
  entry.abort.abort();
  // 2026-05-28 P0-1: abort 还要传播到 orchestrator 让 TaskQueue 内的 task 接收 abort.
  // 之前只 entry.abort.abort() 触发 signal, 但 in-flight fetch (实际跑视频的 task) 不感知
  // pipeline 级 signal — 远端 fetch 仍在 fire-and-forget 跑, 用户付费扣完才停.
  for (const jobId of entry.jobIds) {
    try {
      orchestrator.abortJob(jobId);
    } catch (e) {
      loggerSync().warn(`[autoPipeline:abort] orchestrator.abortJob(${jobId}) 失败: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { ok: true };
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * 启动一条新管线, fire-and-forget 异步执行. 立即返回 record.
 * 调用方拿 pipeline_id 后订阅 SSE / 轮询 GET 看进度.
 */
export function startAutoPipeline(
  slug: string,
  episodeId: string,
  options: AutoPipelineOptions,
): AutoPipelineRecord {
  // 2026-05-19 反馈 #3 (核心 bug):
  //   用户原话: "我重新点一键补全结果队列里有两个任务. 这个按钮应该自动检测还有哪些图片
  //   没补全, 一定不要重新生成覆盖已经生成过的"
  //
  //   后端的 element_images stage 内部已经按 brief.generated 过滤未生成的(见 line 447-450),
  //   所以同一 pipeline 内"不重新生成已生成的"逻辑是对的.
  //   但用户重新点"一键补全"按钮 = 启动了**新一条 pipeline**, 这条新 pipeline 跟旧 pipeline
  //   并发跑, 队列里同时出现两个任务 — 这才是用户看到的 bug.
  //
  //   修复: 启动新 pipeline 前, 把同 series + 同 episode + 同 mode 的旧 running pipeline abort 掉.
  //   不删 _running entry, 让用户还能 retry 它.
  //   "同 mode" 用 only_element_images 区分:
  //     - 用户从素材库"一键补全"两次 → 都 only_element_images=true → 后点的 abort 前面的
  //     - 用户先跑全链路, 再去素材库点"一键补全" → mode 不同, 不互相 abort
  //
  //   2026-05-26 修 "批量启动整部剧后只有最后一集在跑": 之前只看 slug + mode 没区分 episode,
  //   导致 batch 启动 ep1-5 时, 后启动的把前面的全 abort 了, 只剩 ep5 running.
  //   现在加 episode_id 判断 — 不同集的 pipeline 互不影响.
  const sameModeRunning = Array.from(_running.values()).filter((entry) =>
    entry.record.series_slug === slug &&
    entry.record.episode_id === episodeId &&
    entry.record.status === "running" &&
    (!!entry.record.options.only_element_images === !!options.only_element_images) &&
    (!!entry.record.options.only_firstframes === !!options.only_firstframes) &&
    (!!entry.record.options.only_videos === !!options.only_videos),
  );
  for (const stale of sameModeRunning) {
    loggerSync().info(
      `[autoPipeline] 新 pipeline 启动前 abort 同集同 mode 老 pipeline ${stale.record.pipeline_id} (slug=${slug}, ep=${episodeId}, only_element_images=${!!options.only_element_images}, only_firstframes=${!!options.only_firstframes})`,
    );
    stale.abort.abort();
    // 2026-07-09 audit C2: 对齐 abortPipeline(244-250) — 只 abort signal 不够,
    // in-flight 付费 fetch(实际跑视频/图像的 orchestrator task)仍 fire-and-forget 跑到完成扣费 + 落盘。
    // 用户"以为卡住再点一次"会双扣费, 且新旧两管线并发对同一批 shot 抢写 generation。
    // 必须把 abort 传播到 orchestrator 让 TaskQueue 内的真任务也收到 signal。
    for (const jobId of stale.jobIds) {
      try {
        orchestrator.abortJob(jobId);
      } catch (e) {
        loggerSync().warn(`[autoPipeline] stale abortJob(${jobId}) 失败: ${e instanceof Error ? e.message : e}`);
      }
    }
    // 不删 _running entry, 让 retry 还能查 / 让用户在 UI 看到中断状态
  }

  const pipeline_id = `pipeline_${ulid()}`;
  // 2026-05-19 #4 / #C + 2026-05-20 S8: only_* 时 stages 数组裁掉无意义的后续 stage,
  // 让进度面板不显示后面的 pending stage(否则 UI 上"看起来还有 videos 待跑").
  const onlyElements = options.only_element_images === true;
  // only_firstframes 优先级低于 only_element_images (后者更窄). 同时 true 时 only_element_images 生效.
  const onlyFirstframes = !onlyElements && options.only_firstframes === true;
  const onlyVideos = !onlyElements && !onlyFirstframes && options.only_videos === true;
  let initialStages: AutoPipelineStageState[];
  if (onlyElements) {
    initialStages = [{ id: "element_images", status: "pending", total: 0, completed: 0, failed: 0 }];
  } else if (onlyFirstframes) {
    initialStages = [
      { id: "element_images", status: "pending", total: 0, completed: 0, failed: 0 },
      { id: "firstframes",    status: "pending", total: 0, completed: 0, failed: 0 },
    ];
  } else if (onlyVideos) {
    initialStages = [{ id: "videos", status: "pending", total: 0, completed: 0, failed: 0 }];
  } else {
    initialStages = [
      { id: "element_images", status: "pending", total: 0, completed: 0, failed: 0 },
      { id: "firstframes",    status: "pending", total: 0, completed: 0, failed: 0 },
      { id: "videos",         status: "pending", total: 0, completed: 0, failed: 0 },
      { id: "compose",        status: "pending", total: 0, completed: 0, failed: 0 },
    ];
  }
  const record: AutoPipelineRecord = {
    pipeline_id,
    series_slug: slug,
    episode_id: episodeId,
    status: "running",
    current_stage: null,
    started_at: new Date().toISOString(),
    options,
    stages: initialStages,
  };
  const abort = new AbortController();
  _running.set(pipeline_id, { record, abort, jobIds: [] });

  // 2026-05-28 P0-2: pipeline 跑到终态 (done/failed/aborted) 后 60s 清 _running entry,
  // 防止内存堆积 (单实例工作台跑了几天 _running 越来越大). 终态后 record 已 persistPipeline
  // 落盘, loadPipeline 仍能拿到, getPipeline 内存优先磁盘兜底.
  function scheduleCleanup(pid: string) {
    setTimeout(() => {
      const e = _running.get(pid);
      if (e && (e.record.status === "done" || e.record.status === "failed" || e.record.status === "aborted")) {
        _running.delete(pid);
      }
    }, 60_000);
  }

  // fire-and-forget chain
  (async () => {
    try {
      if (onlyVideos) {
        await runVideosStage(record, abort.signal);
        if (abort.signal.aborted) throw new Error("pipeline_aborted");
        record.status = "done";
        record.current_stage = null;
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.done", { only_videos: true });
        return;
      }

      await runElementImagesStage(record, abort.signal);
      if (abort.signal.aborted) throw new Error("pipeline_aborted");

      // 2026-05-19 #4: only_element_images 模式 — 跑完 element_images stage 就退出.
      // 用于素材库"一键补全素材图"按钮 (不下推到 firstframes/videos/compose).
      if (onlyElements) {
        record.status = "done";
        record.current_stage = null;
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.done", { only_element_images: true });
        return;
      }

      await runFirstFramesStage(record, abort.signal);
      if (abort.signal.aborted) throw new Error("pipeline_aborted");

      // 2026-05-19 #C: only_firstframes 模式 — 跑完 firstframes stage 退出, 不下推 videos/compose.
      if (onlyFirstframes) {
        record.status = "done";
        record.current_stage = null;
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.done", { only_firstframes: true });
        return;
      }

      await runVideosStage(record, abort.signal);
      if (abort.signal.aborted) throw new Error("pipeline_aborted");
      await runComposeStage(record, abort.signal);

      record.status = "done";
      record.current_stage = null;
      record.finished_at = new Date().toISOString();
      emitStage(record, "pipeline.done", { final_video_path: record.final_video_path });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stageId = record.current_stage;
      // 2026-05-26: pipeline.aborted / pipeline.failed 事件带 failed_details / failed_ids,
      // 否则 stage 跑到一半被 abort 时, 前端 reducer 看到的 details 是截断前那部分,
      // SSE 再不补就丢了. 现在 catch 块也读 stage 上的 failed 数据一起 broadcast.
      const currentStage = stageId ? record.stages.find((s) => s.id === stageId) : undefined;
      const failedPayload = currentStage ? {
        failed: currentStage.failed,
        failed_ids: currentStage.failed_ids ?? [],
        failed_details: currentStage.failed_details ?? [],
      } : {};
      if (errMsg === "pipeline_aborted") {
        record.status = "aborted";
        if (stageId) {
          setStageState(record, stageId, { status: "aborted", finished_at: new Date().toISOString() });
        }
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.aborted", { ...(stageId ? { stage: stageId } : {}), ...failedPayload });
        loggerSync().info(`[autoPipeline] ${pipeline_id} aborted at stage ${stageId ?? "n/a"}`);
      } else {
        record.status = "failed";
        if (stageId) {
          setStageState(record, stageId, { status: "failed", error: errMsg, finished_at: new Date().toISOString() });
        }
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.failed", { stage: stageId ?? "element_images", error: errMsg, ...failedPayload });
        loggerSync().error(`[autoPipeline] ${pipeline_id} failed at stage ${stageId ?? "n/a"}: ${errMsg}`);
      }
    } finally {
      // P0-2: 终态 60s 后清 _running entry
      scheduleCleanup(pipeline_id);
    }
  })();

  return record;
}

/**
 * 从指定 stage 重跑. 前面 stage 跳过(用现有 picked 数据).
 * 复用同一 pipeline_id, stages 状态重置.
 *
 * 2026-05-19 优化 6: 可选 options.shot_ids / options.element_ids — 限定本次重跑的子集.
 *   - 不传 → 走原行为(整 stage 重跑全部 shot/element)
 *   - 传了 → patch 到 record.options, 让 stage runner 内部读出来 filter
 *   - 这里只对"本次重试"生效, 不污染下一次 retry: fire-and-forget 末尾还原 record.options
 */
export async function retryStage(
  pipelineId: string,
  stage: AutoPipelineStage,
  options?: { shot_ids?: string[]; element_ids?: string[]; only_videos?: boolean },
): Promise<{ ok: boolean; reason?: string; record?: AutoPipelineRecord }> {
  let entry = _running.get(pipelineId);
  if (!entry) {
    // 优化 5 (2026-05-19): 内存没 entry — 尝试从磁盘加载历史 record, 重建 RuntimeEntry.
    // 这让用户重启进程后还能 retry 历史 pipeline.
    const disk = await loadPipeline(pipelineId);
    if (!disk) return { ok: false, reason: "pipeline_not_found" };
    // 2026-05-19 zombie 检测 #1: 磁盘 status=running 但内存无 entry,一定是进程重启/异常退出留下的残留.
    // 没人在跑这个 pipeline (内存中没 RuntimeEntry/AbortController),直接当 failed 状态对待并允许 retry.
    // 跟 stopPipeline 的兜底标 aborted 同一思路 (line 207).
    if (disk.status === "running") {
      loggerSync().warn(
        `[autoPipeline:retry] ${pipelineId} 磁盘 status=running 但内存无 entry → 视为残留 zombie (进程重启?),force retry`,
      );
      disk.status = "failed";
      disk.finished_at = disk.finished_at ?? new Date().toISOString();
    }
    entry = { record: disk, abort: new AbortController(), jobIds: [] };
    _running.set(pipelineId, entry);
  }
  // 2026-05-19 zombie 检测 #2: 内存 entry 中 record.status="running" 不一定真在跑.
  // 用户报告: 磁盘已 finished_at, status=done; 内存 record.status 仍是 "running" — 状态不一致.
  // 也可能是: 删除所有本地 timeout 后, 远端 fetch 永远 hang, fire-and-forget 永不返回, status 永不复位.
  // 策略: 任何 "running" 状态都先 abort 旧任务、wait 一下让 in-flight 接到 signal, 再启动新 retry.
  // 用户点重试按钮的明确意图就是"放弃旧的、重新跑",所以 force-abort 不违背用户预期.
  if (entry.record.status === "running") {
    const hasFinishedAt = !!entry.record.finished_at;
    const abortAlreadyTriggered = entry.abort.signal.aborted;
    if (hasFinishedAt || abortAlreadyTriggered) {
      loggerSync().warn(
        `[autoPipeline:retry] ${pipelineId} 检测到 zombie running (finished_at=${entry.record.finished_at ?? "n/a"}, abortAlreadyTriggered=${abortAlreadyTriggered}),直接 force retry`,
      );
    } else {
      loggerSync().warn(
        `[autoPipeline:retry] ${pipelineId} 仍在 running 状态,用户点重试 → force abort 旧任务后重新启动`,
      );
      entry.abort.abort();
      // 2026-07-10 audit: 对齐 abortPipeline(244-250) / startAutoPipeline(300-306) —
      // 只 abort signal 不够, in-flight 付费 fetch(orchestrator TaskQueue 内实际跑视频/图像的 task)
      // 仍 fire-and-forget 跑到扣费完才停。必须把 abort 传播到 orchestrator 取消在途 job,
      // 否则用户点"重试"会与旧任务并发双扣费 + 抢写同一批 shot 的 generation。
      for (const jobId of entry.jobIds) {
        try {
          orchestrator.abortJob(jobId);
        } catch (e) {
          loggerSync().warn(`[autoPipeline:retry] orchestrator.abortJob(${jobId}) 失败: ${e instanceof Error ? e.message : e}`);
        }
      }
      // 2026-05-26 删 hardcoded sleep(200) — 违反铁律 1 (禁本地 timeout).
      // abort signal 已 propagate, in-flight fetch/spawn 收到 signal 自然中止,
      // 不需要 hardcoded wait. 新 pipeline 在 line 487 await fire-and-forget 启动,
      // 跟旧任务自然分离.
    }
  }

  const record = entry.record;
  record.status = "running";
  record.finished_at = undefined;

  // 2026-05-19 优化 6: 把本次重试的 shot_ids / element_ids 写入 record.options.
  // 用 snapshot 保存原值, fire-and-forget 末尾恢复, 不污染下一次 retry / SSE 推送.
  const optionsSnapshot = {
    shot_ids: record.options.shot_ids,
    element_ids: record.options.element_ids,
    only_videos: record.options.only_videos,
  };
  if (options?.shot_ids !== undefined) {
    record.options.shot_ids = options.shot_ids.length > 0 ? options.shot_ids : undefined;
  }
  if (options?.element_ids !== undefined) {
    record.options.element_ids = options.element_ids.length > 0 ? options.element_ids : undefined;
  }
  if (options?.only_videos !== undefined) {
    record.options.only_videos = options.only_videos === true ? true : undefined;
  }

  // 跳过前面的 stage, 重置当前 + 后面的
  const order: AutoPipelineStage[] = ["element_images", "firstframes", "videos", "compose"];
  const startIdx = order.indexOf(stage);
  if (startIdx < 0) return { ok: false, reason: "invalid_stage" };

  // 2026-05-19 修复: only_element_images / only_firstframes 模式下 record.stages 不一定有全 4 个 stage.
  // 之前用 findStage throw 会让 retry 返 INTERNAL_ERROR "unknown stage videos" — 用户看到的现象就是
  // "点重试没反应". 改用 record.stages.find 容忍缺失, 缺失则跳过 (该 stage 本来就不在 pipeline 范围内).
  for (let i = 0; i < order.length; i++) {
    const st = record.stages.find((x) => x.id === order[i]);
    if (!st) continue;
    if (i < startIdx) {
      // 前面的 stage 保持 done(或之前 final state), 不重置
      if (st.status !== "done") st.status = "skipped";
    } else {
      // 当前 + 后面 重置 pending
      st.status = "pending";
      st.completed = 0;
      st.failed = 0;
      st.total = 0;
      st.error = undefined;
      st.started_at = undefined;
      st.finished_at = undefined;
      // 2026-05-19 反馈 #2: 重试时清空旧的 failed_ids, 让新 stage 跑出来的 failed_ids 干净
      st.failed_ids = undefined;
      // 2026-05-26 Bug 修: 同样清 failed_details, 否则用户点"重试失败的 N 项" 后
      // 进度归零但下面失败明细行不更新, 让人困惑"是不是重抽了".
      st.failed_details = undefined;
    }
  }

  // 新 AbortController(老的可能已 abort)
  // P0-1: retry 启动新 chain, 老 jobIds 已结算 (cancel 过), 重置数组让本次重试只收集新 jobId
  const newAbort = new AbortController();
  _running.set(pipelineId, { record, abort: newAbort, jobIds: [] });

  // 2026-05-19 #4 / #C: retry 也尊重 only_element_images / only_firstframes — 跑完对应 stage 就退出
  const onlyElementsRetry = record.options.only_element_images === true;
  const onlyFirstframesRetry = !onlyElementsRetry && record.options.only_firstframes === true;
  const onlyVideosRetry = !onlyElementsRetry && !onlyFirstframesRetry && record.options.only_videos === true;

  // fire-and-forget
  (async () => {
    try {
      if (startIdx <= 0) await runElementImagesStage(record, newAbort.signal);
      if (newAbort.signal.aborted) throw new Error("pipeline_aborted");

      if (onlyElementsRetry) {
        record.status = "done";
        record.current_stage = null;
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.done", { only_element_images: true });
        return;
      }

      if (startIdx <= 1) await runFirstFramesStage(record, newAbort.signal);
      if (newAbort.signal.aborted) throw new Error("pipeline_aborted");

      if (onlyFirstframesRetry) {
        record.status = "done";
        record.current_stage = null;
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.done", { only_firstframes: true });
        return;
      }

      if (startIdx <= 2) await runVideosStage(record, newAbort.signal);
      if (newAbort.signal.aborted) throw new Error("pipeline_aborted");
      if (onlyVideosRetry) {
        const compose = record.stages.find((x) => x.id === "compose");
        if (compose && compose.status === "pending") compose.status = "skipped";
        record.status = "done";
        record.current_stage = null;
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.done", { only_videos: true });
        return;
      }
      if (startIdx <= 3) await runComposeStage(record, newAbort.signal);

      record.status = "done";
      record.current_stage = null;
      record.finished_at = new Date().toISOString();
      emitStage(record, "pipeline.done", { final_video_path: record.final_video_path });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stageId = record.current_stage;
      if (errMsg === "pipeline_aborted") {
        record.status = "aborted";
        if (stageId) setStageState(record, stageId, { status: "aborted", finished_at: new Date().toISOString() });
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.aborted", stageId ? { stage: stageId } : {});
      } else {
        record.status = "failed";
        if (stageId) setStageState(record, stageId, { status: "failed", error: errMsg, finished_at: new Date().toISOString() });
        record.finished_at = new Date().toISOString();
        emitStage(record, "pipeline.failed", { stage: stageId ?? stage, error: errMsg });
      }
    } finally {
      // 2026-05-19 优化 6: 还原 shot_ids / element_ids 到 retry 调用前的值,
      // 让 record.options 在 SSE 推送 / GET /auto-pipelines/:id 看到的是原 pipeline 配置,
      // 不污染下一次 retry (用户再点 retry 不带 shot_ids 走整 stage).
      record.options.shot_ids = optionsSnapshot.shot_ids;
      record.options.element_ids = optionsSnapshot.element_ids;
      record.options.only_videos = optionsSnapshot.only_videos;
      // P0-2: retry 终态后 60s 清 _running
      setTimeout(() => {
        const e = _running.get(pipelineId);
        if (e && (e.record.status === "done" || e.record.status === "failed" || e.record.status === "aborted")) {
          _running.delete(pipelineId);
        }
      }, 60_000);
    }
  })();

  return { ok: true, record };
}
