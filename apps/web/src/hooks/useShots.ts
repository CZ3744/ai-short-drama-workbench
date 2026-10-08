import useSWR from "swr";
import { apiGet, apiPatch, apiPost, apiDelete, ApiError } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";
// 2026-05-21 Wave Y — 富文本节点类型 (与后端 packages/drama/src/types.ts 同步)
import type { ShotTextNode } from "../../../../packages/drama/src/types";
export type { ShotTextNode };

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ShotStatus = "draft" | "drafted" | "generating" | "ready" | "picked" | "approved" | "failed" | "needs_regen";

/** C4: Prompt 版本记录 */
export interface PromptVersion {
  version: number;
  content: string;
  created_at: string;
  created_by: "ai" | "user";
}

export interface ShotCandidate {
  id: string;
  generation_id?: string;
  url: string;
  thumbnail?: string;
  provider: string;
  seed?: number;
  prompt: string;
  prompt_used?: string;
  picked: boolean;
  rating?: number;
  created_at: string;
  vault_id?: string;
  asset_id?: string;
  status?: "pending" | "running" | "done" | "failed";
  type?: "first_frame" | "video";
  error?: string;
  display_name?: string;
  /** 本次生成成本(元),由后端在 candidate 上附加 */
  cost_cny?: number;
  /** B2: 4-item quality scores from postGenCheck */
  quality_scores?: {
    composition: number;
    sharpness: number;
    prompt_alignment: number;
    subject_completeness: number;
    checked_at: string;
  };
}

export interface Shot {
  id: string;
  ep_id: string;
  index: number;
  duration_sec: number;
  character_ids: string[];
  scene_id?: string;
  element_ids?: string[];
  /**
   * 2026-05-26 W2 组合性 — 本镜出场角色穿的服装造型 element id (kind=wardrobe).
   * 优先级: shot.wardrobe_id 显式 > character.wardrobe_element_ids[0] 默认 > character.outfit 文本 fallback.
   * 与后端 packages/drama/src/types.ts Shot.wardrobe_id 同形.
   */
  wardrobe_id?: string;
  /**
   * 2026-05-26 W2 组合性 — 本镜额外出现的道具 element id 列表 (kind=prop).
   * 与 character.prop_element_ids union 后得到本镜真实出现道具集.
   */
  prop_ids?: string[];
  scene_name?: string;
  character_names?: string[];
  first_frame_candidates: ShotCandidate[];
  video_candidates: ShotCandidate[];
  /** Wave 1C: 废案箱中的候选 */
  trashed_candidates?: ShotCandidate[];
  picked_first_frame_id?: string | null;
  picked_video_id?: string | null;
  status: ShotStatus;
  title?: string;
  action?: string;
  action_description: string;
  dialogue: string;
  voiceover: string;
  shot_type: string;
  camera_movement: string;
  prompt_img: string;
  prompt_vid?: string;
  /**
   * 2026-05-27 — 负向提示词 / 排除元素. orchestrator 真读这字段发模型作 negative,
   * 之前 web 端 Shot type 漏列, ShotStagePage buildDraft 会 ts error.
   */
  negative_prompt?: string;
  notes?: string;
  style?: string;
  time_of_day?: string;
  lighting?: string;
  mood?: string;
  reference_asset_ids?: string[];
  reference_notes?: Record<string, string>;
  /**
   * 2026-05-19 Wave O Entity-first Case B: 单镜级 reference 图 override.
   * 当某素材有多张 typical 图时, 用户在 ShotStage 显式选"本镜用第 N 张"写入这里.
   * orchestrator 拼 reference_images 时, 该 element 的 reference 用 image_id 那张
   * 而不是 primary_image_id 默认那张 (铁律 #4 就近决策).
   */
  reference_overrides?: Array<{
    element_id: string;
    image_id: string;
  }>;
  keyframe_asset_id?: string;
  image_model_ref?: string;
  video_model_ref?: string;
  error_detail?: string;
  failures?: Array<{ at: string; stage: string; error: string }>;
  created_at: string;
  updated_at: string;
  /** Wave 3B: 是否使用上一镜末帧作为参考 */
  use_prev_last_frame?: boolean;
  /** Wave 3B: 是否已从上一镜末帧生成 */
  first_frame_from_prev?: boolean;
  /** Wave 3B: 本镜视频末帧的 vault_id */
  last_frame_vault_id?: string;
  /** Wave 1C: 视频生成模式 i2v / t2v */
  video_mode?: "i2v" | "t2v";
  /** C4: Prompt 版本历史 */
  prompt_img_versions?: PromptVersion[];
  prompt_vid_versions?: PromptVersion[];
  /**
   * 2026-05-21 Wave Y — 5 个文本字段的富文本节点数组 (主存储, 替代纯文本 + @ token 老架构).
   * 老 string 字段保留作 derived plain text 兼容 (TTS / 字幕 / 老 caller 直读),
   * 前端 ShotStage 优先用 nodesToShortText(*_nodes) derive 出含 @ 短格式字符串喂给
   * MentionTextarea, 让 chip 渲染基于结构化引用而不是字符串 parser 兜底.
   */
  action_nodes?: ShotTextNode[];
  dialogue_nodes?: ShotTextNode[];
  voiceover_nodes?: ShotTextNode[];
  prompt_img_nodes?: ShotTextNode[];
  prompt_vid_nodes?: ShotTextNode[];
  /** T2 v26: 分镜情绪（角色情绪基调，进提示词） */
  emotion?: string;
  /** T2 v26: 前置过渡（从上一镜如何切入） */
  transition_in?: string;
  /** P1-1: 单镜转场持续时间(秒,默认 0.5;与 transition_in 配合使用) */
  transition_duration?: number;
  /** W7 Phase 4: 单镜入帧裁剪起点(秒,默认 0;留空 = 不裁) */
  trim_start_sec?: number;
  /** W7 Phase 4: 单镜出帧裁剪终点(秒,默认 = duration_sec;留空 = 不裁) */
  trim_end_sec?: number;
  /**
   * @deprecated 2026-05-26 W8 双阶段提交锁已下线 — 字段保留兼容老数据,
   * 前端不再读写, 设了首帧立即可生视频. 见 packages/drama/src/types.ts.
   */
  ready_for_video?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Fetcher                                                            */
/* ------------------------------------------------------------------ */

const fetchShots = (slug: string, epId: string) =>
  apiGet<{ shots: Shot[] }>(`/api/v2/series/${slug}/episodes/${epId}/shots`).then((r) => r.shots);

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

/**
 * 2026-05-19 紧急 bug 修复 (用户原话:"在分镜创作页面点击鼠标上的返回键,报错 Maximum update depth exceeded"):
 *
 * 之前 `data ?? []` 每次渲染都创建新 `[]` 引用,当 `data` 为 undefined 时(初次挂载 / SWR
 * 重新校验间隙 / key=null 时)会导致下游 useEffect([shots]) 反复触发:
 *   1. 渲染 → shots = data ?? [] = NEW []
 *   2. useEffect([shots]) 触发 → setLocalOrder([...].map(...)) = NEW []
 *   3. 状态变化 → 重新渲染 → shots = data ?? [] = NEW []
 *   4. useEffect([shots]) 再次触发(因为 ref 不同)→ infinite loop
 *
 * 修法: 用 module-level 共享的稳定空数组 + useMemo 兜底,确保 `data === undefined` 时
 * 永远返回同一个引用,useEffect deps 比较稳定.
 */
const EMPTY_SHOTS: Shot[] = [];

export function useShots(slug: string | undefined, epId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<Shot[]>(
    slug && epId ? `shots:${slug}:${epId}` : null,
    () => fetchShots(slug!, epId!),
    {
      revalidateOnFocus: false,
      dedupingInterval: 3000,
      onError: (err) => {
        showErrorToast(err);
      },
    }
  );

  return {
    shots: data ?? EMPTY_SHOTS,
    isLoading,
    error,
    refresh: mutate,
  };
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export async function patchShot(slug: string, epId: string, shotId: string, payload: Partial<Shot>) {
  return apiPatch<{ shot: Shot }>(`/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}`, payload);
}

export async function approveShot(slug: string, epId: string, shotId: string) {
  return apiPost<{ ok: boolean }>(`/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}/approve`);
}

export async function retakeShot(slug: string, epId: string, shotId: string) {
  return apiPost<{ ok: boolean }>(`/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}/retake`);
}

/** Wave 3B: 批量开关"续上镜末帧" */
export async function batchToggleLastFrame(slug: string, epId: string, usePrevLastFrame: boolean) {
  return apiPost<{ ok: boolean; updated_count: number; use_prev_last_frame: boolean }>(
    `/api/v2/series/${slug}/episodes/${epId}/shots/batch-toggle-last-frame`,
    { use_prev_last_frame: usePrevLastFrame },
  );
}

/** Wave 1C: 将候选移入废案箱 */
export async function trashGeneration(slug: string, epId: string, shotId: string, genId: string) {
  return apiPost<{ ok: boolean }>(`/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}/generations/${genId}/trash`);
}

/** Wave 1C: 从废案箱恢复候选 */
export async function restoreGeneration(slug: string, epId: string, shotId: string, genId: string) {
  return apiPost<{ ok: boolean }>(`/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}/generations/${genId}/restore`);
}

/** Wave 1C: 永久删除废案候选 */
export async function deleteGenerationForever(slug: string, epId: string, shotId: string, genId: string) {
  return apiDelete(`/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}/generations/${genId}`);
}

/** B5: Retry-until-satisfied 正式化 */

export interface RetryJobData {
  id: string;
  series_slug: string;
  episode_id: string;
  shot_id: string;
  action: "generate_first_frames" | "generate_videos";
  max_attempts: number;
  quality_threshold: number;
  budget_cap_cny: number;
  stop_on_first_green: boolean;
  auto_pick_best: boolean;
  status: "active" | "completed" | "max_attempts_reached" | "budget_exceeded" | "cancelled" | "error";
  attempts: number;
  best_score: number;
  best_generation_id?: string;
  cost_spent_cny: number;
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
  last_polled_at?: string;
}

export interface RetryUntilSatisfiedInput {
  max_attempts?: number;
  quality_threshold?: number;
  budget_cap_cny?: number;
  stop_on_first_green?: boolean;
  auto_pick_best?: boolean;
  action?: string;
}

export async function retryUntilSatisfied(
  slug: string, epId: string, shotId: string,
  options: RetryUntilSatisfiedInput = {},
) {
  return apiPost<{ ok: boolean; job_id: string; status: string; message: string }>(
    `/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}/retry-until-satisfied`,
    options,
  );
}

/** B5: 查询 shot 的 retry job 列表 */
export async function getRetryJobStatus(slug: string, epId: string, shotId: string) {
  return apiGet<{ jobs: RetryJobData[] }>(
    `/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}/retry-job`,
  );
}

/** B5: 取消 retry job */
export async function cancelRetryJob(slug: string, epId: string, shotId: string, jobId: string) {
  return apiPost<{ ok: boolean; job: RetryJobData }>(
    `/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}/retry-job/${jobId}/cancel`,
  );
}

/** Wave 1C: 设置视频生成模式 */
export async function setVideoMode(slug: string, epId: string, shotId: string, mode: "i2v" | "t2v") {
  return apiPatch<{ shot: Shot }>(`/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}`, { video_mode: mode });
}

/** U8: 软删除分镜 */
export async function deleteShot(slug: string, epId: string, shotId: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/series/${slug}/episodes/${epId}/shots/${shotId}`);
}

/* ------------------------------------------------------------------ */
/*  Create Shot                                                        */
/* ------------------------------------------------------------------ */

export interface CreateShotInput {
  title?: string;
  action?: string;
  prompt_img?: string;
  prompt_vid?: string;
  video_mode?: "i2v" | "t2v";
  duration_sec?: number;
  aspect_ratio?: string;
  shot_type?: string;
  camera_movement?: string;
  dialogue?: string;
  voiceover?: string;
  notes?: string;
  style?: string;
  time_of_day?: string;
  lighting?: string;
  mood?: string;
  reference_asset_ids?: string[];
  reference_notes?: Record<string, string>;
  reference_overrides?: Array<{
    element_id: string;
    image_id: string;
  }>;
  keyframe_asset_id?: string;
  image_model_ref?: string;
  video_model_ref?: string;
  character_ids?: string[];
  scene_id?: string;
  index?: number;
}

export async function createShot(slug: string, epId: string, payload: CreateShotInput = {}) {
  return apiPost<{ shot: Shot }>(`/api/v2/series/${slug}/episodes/${epId}/shots`, payload);
}
