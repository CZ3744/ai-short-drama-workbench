/**
 * 视频侧 TargetAdapter 模式 · 类型契约 (Wave 1, 2026-05-16).
 *
 * 对称 imageGenerationOrchestrator. 视频 target 比较少, 只有 shot_video / vault_only 两种.
 */

import { z } from "zod";
import type { CostInfo, GeneratedVideo } from "../../../../../../packages/providers/src/core/types";
import type { VideoInputRef } from "../videoGenerationService";

// ─── Target ──────────────────────────────────────────────────────────

export type VideoTargetKind =
  /** shot.generations / video_candidates (orchestrator 路径暂不接入, 见说明) */
  | "shot_video"
  /** 只写 vault, 不绑业务对象 (raw /videos/generate) */
  | "vault_only";

export interface VideoGenerationTarget {
  kind: VideoTargetKind;
  series_slug: string;
  target_id?: string;
  sub_target?: string;
  meta?: Record<string, unknown>;
}

// ─── Request / Result ───────────────────────────────────────────────

export interface GenerateVideoForTargetRequest {
  prompt: string;
  negative_prompt?: string;
  provider_id?: string;
  model_ref?: string;
  duration_sec?: number;
  aspect_ratio?: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
  seed?: number;
  first_frame?: VideoInputRef;
  reference_images?: VideoInputRef[];
  strict_reference_images?: boolean;
  default_provider_id?: string;
  job_id?: string;
  task_id?: string;
  timeout_ms?: number;
  target: VideoGenerationTarget;
  extra_tags?: string[];
  /**
   * Wave 4-A (2026-05-16): 业务后处理产生的额外字段, adapter 把这些字段一并写入 shot.generations.
   * 见 imageGenerationOrchestrator/types.ts 同款 generation_extras 注释.
   */
  generation_extras?: VideoGenerationExtras;
}

/** 见 image 侧 ShotGenerationExtras 同款语义. 视频不需要 quality_scores(那是图像专属). */
export interface VideoGenerationExtras {
  prompt_version?: number;
  provider_job_id?: string;
  provider_file_id?: string;
  model_id?: string;
  request_payload_digest?: string;
  prompt_final?: string;
  prompt_used?: string;
  negative_prompt?: string;
  duration_sec_requested?: number;
  duration_sec_actual?: number;
  fps?: number;
  cost_cny?: number;
  submitted_at?: string;
  completed_at?: string;
  downloaded_at?: string;
  /** orchestrator ffmpeg 抽末帧后传入, adapter 写到 shot.last_frame_vault_id */
  last_frame_vault_id?: string;
  /** orchestrator 预生成的 generation_id, 传入后 adapter 不再自己 random 生成. */
  generation_id?: string;
}

export interface PersistedVideo {
  generation_id: string;
  asset_id?: string;
  vault_id?: string;
  url: string;
  width?: number;
  height?: number;
  duration_sec: number;
  mime: string;
  provider_id: string;
  prompt_snapshot: string;
  /**
   * Wave 4-A (2026-05-16): 落盘绝对路径. orchestrator 视频任务需要拿它做 ffmpeg 末帧抽取
   * + ffprobe 校验. 轻量 endpoint / vault_only adapter 可忽略.
   */
  abs_path?: string;
}

export interface GenerateVideoForTargetResult {
  video: PersistedVideo;
  provider_id: string;
  cost?: CostInfo;
  target_state?: unknown;
}

// ─── VideoTargetAdapter 接口 ──────────────────────────────────────────

export interface AdapterPersistVideoInput {
  video: GeneratedVideo;
  target: VideoGenerationTarget;
  provider_id: string;
  request: GenerateVideoForTargetRequest;
}

export interface VideoTargetAdapter {
  persist(input: AdapterPersistVideoInput): Promise<PersistedVideo>;
  readState(target: VideoGenerationTarget): Promise<unknown>;
}

// ─── zod schema ───────────────────────────────────────────────────────

// Phase 3 (Wave 2): zod v4 toC 兜底 — 见 image 侧同款.
export const VideoTargetKindSchema = z.enum(
  ["shot_video", "vault_only"],
  { error: (issue) => issue.input === undefined
    ? "target.kind 必填"
    : "target.kind 必须是以下之一: shot_video / vault_only" },
);

/**
 * Phase 3 (Wave 2): 统一生成端点 body 校验. 见 image 侧 SLUG_PATH_SAFE 同款注释 —
 * Unicode-safe, 仅防 path traversal 与文件路径分隔符.
 */
const SLUG_PATH_SAFE = (s: string): boolean => !s.includes("..") && !/[/\\]/.test(s);

export const VideoGenerationTargetSchema = z.object({
  kind: VideoTargetKindSchema,
  series_slug: z.string()
    .min(1, "series_slug 不可为空")
    .max(128, "series_slug 不可超过 128 字符")
    .refine(SLUG_PATH_SAFE, "series_slug 不可含路径分隔符 / \\ 或父目录符 .."),
  target_id: z.string().max(256).optional(),
  sub_target: z.string().max(64).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
