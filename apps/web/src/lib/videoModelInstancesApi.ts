/**
 * 2026-05-18: 5 真实视频渠道二级架构 — 前端 API 客户端.
 *
 * 配套后端 apps/server/src/api/v2/videoModelInstancesController.ts.
 */

import { apiGet, apiPost, apiPatch, apiDelete } from "./api";

// ─── Channel def (后端写死, 5 个) ───────────────────────────────────

export type VideoChannelId =
  | "kling"
  | "vidu"
  | "jimeng"
  | "minimax"
  | "aliyun_wan"
  // 2026-05-20 Wave T S25 — 3 个 builtin 升 instance 架构
  | "zhipu"
  | "baidu_qianfan"
  | "tencent_hunyuan";

export type VideoAuthType =
  | "bearer"
  | "jwt_aksk"
  | "volc_aksk_signed"
  | "tencent_tc3_signed";

export interface VideoChannelDef {
  id: VideoChannelId;
  label: string;
  default_base_url: string;
  auth: VideoAuthType;
  needs_secret: boolean;
  suggested_models: string[];
  doc_url: string;
  hint?: string;
}

export interface VideoModelInstance {
  id: string;
  display_name: string;
  channel: VideoChannelId;
  model_id: string;
  api_base_url?: string;
  region?: string;
  created_at: string;
  updated_at: string;
  api_key_present: boolean;
  secret_key_present: boolean;
}

// ─── API calls ─────────────────────────────────────────────────────

export function listVideoChannels(): Promise<{ channels: VideoChannelDef[] }> {
  return apiGet<{ channels: VideoChannelDef[] }>("/api/v2/video-channels");
}

export function listVideoModelInstances(channel?: VideoChannelId): Promise<{ instances: VideoModelInstance[] }> {
  const qs = channel ? `?channel=${encodeURIComponent(channel)}` : "";
  return apiGet<{ instances: VideoModelInstance[] }>(`/api/v2/video-model-instances${qs}`);
}

export interface CreateVideoModelInstanceInput {
  display_name: string;
  channel: VideoChannelId;
  model_id: string;
  api_key: string;
  secret_key?: string;
  api_base_url?: string;
  region?: string;
}

export function createVideoModelInstance(input: CreateVideoModelInstanceInput): Promise<{ instance: VideoModelInstance }> {
  return apiPost<{ instance: VideoModelInstance }>("/api/v2/video-model-instances", input);
}

export interface PatchVideoModelInstanceInput {
  display_name?: string;
  model_id?: string;
  api_base_url?: string | null;
  /** 留空 = 保留旧 */
  api_key?: string;
  secret_key?: string;
  region?: string | null;
}

export function patchVideoModelInstance(id: string, patch: PatchVideoModelInstanceInput): Promise<{ instance: VideoModelInstance }> {
  return apiPatch<{ instance: VideoModelInstance }>(`/api/v2/video-model-instances/${id}`, patch);
}

export function deleteVideoModelInstance(id: string): Promise<void> {
  return apiDelete<void>(`/api/v2/video-model-instances/${id}`);
}

export function migrateLegacyVideoInstances(): Promise<{ migrated: VideoChannelId[]; skipped: VideoChannelId[] }> {
  return apiPost<{ migrated: VideoChannelId[]; skipped: VideoChannelId[] }>("/api/v2/video-model-instances/migrate");
}
