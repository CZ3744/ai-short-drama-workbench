/**
 * autoPipelineApi — 前端调一键自动管线 API 的客户端薄壳.
 *
 * 后端契约见 apps/server/src/api/v2/orchestration/autoPipelineRoutes.ts.
 */

import { apiGet, apiPost } from "./api";

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
   * 2026-05-19 反馈 #2: 本 stage 内失败的目标 id 数组.
   *   - element_images stage → element_id
   *   - firstframes / videos → shot_id
   * 前端"重试失败的 N 项"按钮把这数组透传到 retryStage(stage, { shot_ids|element_ids }).
   */
  failed_ids?: string[];
  /**
   * 2026-05-22 bug B: 失败明细 (UI 显示哪张 brief/什么原因). element_images stage 用.
   */
  failed_details?: Array<{
    target_id: string;
    target_name?: string;
    sub_label?: string;
    sub_index?: number;
    error: string;
    ts: string;
  }>;
  /**
   * P2: autoPickGenerations 挑选时跳过的 shot 数 (没有 candidates 可挑的分镜).
   * 由后端 pipeline.stage.done SSE event 推送 skipped_count 字段.
   */
  skipped_count?: number;
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
  final_video_path?: string;
  options: AutoPipelineStartBody;
}

export interface AutoPipelineStartBody {
  image_provider_id?: string;
  video_provider_id?: string;
  image_count_per_shot?: number;
  video_count_per_shot?: number;
  compose_settings?: Record<string, unknown>;
  auto_pick_strategy?: AutoPipelinePickStrategy;
  /** 2026-05-19 #8c: 跳过 element_images 阶段(默认 false) */
  skip_element_images?: boolean;
  /**
   * 2026-05-19 #4: 只跑 element_images stage, 不下推到 firstframes/videos/compose.
   * 用于素材库"一键补全素材图"按钮场景. 此模式下不需要 video_provider_id.
   */
  only_element_images?: boolean;
  /**
   * 2026-05-19 #C: 只跑 element_images + firstframes, 跳过 videos/compose.
   * 用于"整集挂机抽首帧"场景. 此模式下不需要 video_provider_id.
   */
  only_firstframes?: boolean;
  /**
   * 2026-05-20 Wave T S8: 只跑 videos stage, 用已有首帧重抽视频候选.
   * 用于失败中心 bulk retry 少量视频失败分镜.
   */
  only_videos?: boolean;
  /**
   * 2026-05-19 优化 6: 限定本次 firstframes / videos stage 只处理这些 shot.
   * 用法 1: bulk retry 失败子集. 用法 2: 素材 typical 换图后一键重抽引用 shot 首帧.
   */
  shot_ids?: string[];
  /**
   * 2026-05-19 优化 6: 限定本次 element_images stage 只处理这些 element.
   */
  element_ids?: string[];
  /**
   * 2026-05-28 P1-9 / 2026-07-09 audit 修复: 真实付费视频 provider 需 UI 显式勾选"我知道会扣费"才放行.
   * 之前该值只在 UI 勾选框收集却从未进请求体 → 真实 provider full 模式一律被后端 400. 现在真发.
   */
  confirmed_real_api?: boolean;
}

export interface AutoPipelineStartResponse {
  ok: boolean;
  pipeline_id: string;
  stages: Array<{ id: AutoPipelineStage; status: AutoPipelineStageStatus }>;
  record: AutoPipelineRecord;
}

export async function startAutoPipeline(
  slug: string,
  epId: string,
  body: AutoPipelineStartBody,
): Promise<AutoPipelineStartResponse> {
  return apiPost<AutoPipelineStartResponse>(
    `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/auto-pipeline`,
    body,
  );
}

export async function getAutoPipeline(pipelineId: string): Promise<{ ok: boolean; record: AutoPipelineRecord }> {
  return apiGet<{ ok: boolean; record: AutoPipelineRecord }>(
    `/api/v2/auto-pipelines/${encodeURIComponent(pipelineId)}`,
  );
}

/**
 * 2026-05-26: 列出指定 series / episode 的 pipeline records (含已完成 + 进行中).
 * ShotboardPage / ComposePage mount 时用它做 rehydrate — 离页再回来恢复进度面板.
 */
export async function listAutoPipelines(
  seriesSlug?: string,
  episodeId?: string,
): Promise<{ ok: boolean; records: AutoPipelineRecord[] }> {
  const params = new URLSearchParams();
  if (seriesSlug) params.set("series_slug", seriesSlug);
  if (episodeId) params.set("episode_id", episodeId);
  const qs = params.toString();
  return apiGet<{ ok: boolean; records: AutoPipelineRecord[] }>(
    `/api/v2/auto-pipelines${qs ? "?" + qs : ""}`,
  );
}

export async function abortAutoPipeline(pipelineId: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/api/v2/auto-pipelines/${encodeURIComponent(pipelineId)}/abort`, {});
}

export async function retryAutoPipelineStage(
  pipelineId: string,
  stage: AutoPipelineStage,
  opts?: { shot_ids?: string[]; element_ids?: string[]; only_videos?: boolean },
): Promise<{ ok: boolean; record: AutoPipelineRecord }> {
  return apiPost<{ ok: boolean; record: AutoPipelineRecord }>(
    `/api/v2/auto-pipelines/${encodeURIComponent(pipelineId)}/retry-stage`,
    {
      stage,
      // 2026-05-19 优化 6: 透传 shot_ids / element_ids 让后端只重跑子集
      ...(opts?.shot_ids && opts.shot_ids.length > 0 ? { shot_ids: opts.shot_ids } : {}),
      ...(opts?.element_ids && opts.element_ids.length > 0 ? { element_ids: opts.element_ids } : {}),
      ...(opts?.only_videos ? { only_videos: true } : {}),
    },
  );
}

// ─── 优化 1 (2026-05-19): 批量启动 — 一次给 N 部剧/集启动 pipeline ─────

export interface AutoPipelineBatchStartBody {
  series_episodes: Array<{ slug: string; ep_id: string }>;
  options?: AutoPipelineStartBody;
}

export interface AutoPipelineBatchStartResponse {
  ok: boolean;
  pipeline_ids: string[];
  total_started: number;
  total_requested: number;
  errors: Array<{ slug: string; ep_id: string; reason: string }>;
}

/**
 * 一次启动 N 部剧/集的 auto-pipeline. 服务端串行 preflight + start,
 * 失败的 (slug, ep_id) 进 errors[] 但不阻断其他.
 */
export async function startAutoPipelineBatch(
  body: AutoPipelineBatchStartBody,
): Promise<AutoPipelineBatchStartResponse> {
  return apiPost<AutoPipelineBatchStartResponse>(`/api/v2/auto-pipeline/batch`, body);
}
