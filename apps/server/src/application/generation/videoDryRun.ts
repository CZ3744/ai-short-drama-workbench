/**
 * Video dry-run helper (O3) — shared between scoped and flat shotStageController endpoints.
 *
 * Builds a faux provider request payload + cost estimate without invoking the
 * provider. Used by:
 *   POST /api/v2/shots/:sid/video/generate/dry-run
 *   POST /api/v2/series/:slug/episodes/:epId/shots/:sid/generate-video/dry-run
 *
 * Safety guarantees:
 *   - never calls fetch / provider.generate
 *   - never charges budget
 *   - redacts any key field in the request preview (replaced with "****")
 *   - returns key_present boolean so UI can guide user without exposing the key
 *
 * Caller is responsible for HTTP status / response shape; this helper returns
 * a structured result and `key_present === false` for cases where the controller
 * may decide to surface HTTP 400 + `{ error: "key_missing" }`.
 */

import {
  isRealVideoProvider,
  getRealVideoLockStatus,
  estimateVideoCost,
  getKeyFor,
} from "../../../../../packages/core/src/index";
import { resolveRenderSpec } from "../../../../../packages/core/src/renderSpec";
import type { ShotData } from "../../api/v2/seriesStore";
import { modelIdFromModelRef, providerIdFromModelRef } from "./modelRef";
import { ProviderNotSelectedError } from "../../jobs/errors";

// Map provider id → setting key for "is API key present" check.
// (Read-only; never returns the key value itself.)
const PROVIDER_KEY_NAMES: Record<string, string> = {
  minimax_hailuo: "MINIMAX_API_KEY",
  aliyun_wan_t2v: "ALIYUN_DASHSCOPE_API_KEY",
  jimeng_video_3pro: "JIMENG_VOLC_ACCESS_KEY",
  jimeng_video_3_720p: "JIMENG_VOLC_ACCESS_KEY",
  kling_3: "KLING_ACCESS_KEY / KLING_SECRET_KEY",
  vidu_q3_ref: "VIDU_API_KEY",
  zhipu_cogvideox: "ZHIPU_API_KEY",
  baidu_qianfan_video: "BAIDU_QIANFAN_API_KEY",
  tencent_hunyuan_video: "TENCENT_SECRET_ID / TENCENT_SECRET_KEY",
};

export interface VideoDryRunInput {
  /** Full ModelPicker ref ("kling_3:kling-v1.6" or just "kling_3") or plain provider id. */
  model?: string;
  motion_prompt?: string;
  prompt_override?: string;
  duration_s?: number;
  count?: number;
  first_frame_id?: string;
  source_video_generation_id?: string;
  seed?: number;
}

export interface VideoDryRunResult {
  ok: boolean;
  dry_run: true;
  will_not_call_provider: true;
  provider_id: string;
  model_id: string | null;
  key_present: boolean;
  is_real_provider: boolean;
  will_acquire_real_lock: boolean;
  /** When set, indicates someone else already holds the real-video lock (advisory). */
  real_lock_held_by?: {
    provider: string;
    job_id: string;
    scene_id: string;
    age_ms?: number;
  };
  request_preview: Record<string, unknown>;
  estimated_cost_cny: number | null;
  estimated_cost_note: string;
  shot_id: string;
  /** Optional: helpful hint for UI to surface in confirmation dialog. */
  message?: string;
  /** error code for cases like missing key — controller decides http status */
  error?: "key_missing";
}

/** Strip obviously-sensitive header/body fields from a preview payload. */
function redactSensitiveFields<T extends Record<string, unknown>>(obj: T): T {
  const SENSITIVE = new Set([
    "authorization", "api_key", "apikey", "access_key", "secret_key",
    "ak", "sk", "token", "x-api-key", "bearer",
  ]);
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    if (SENSITIVE.has(k.toLowerCase())) {
      out[k] = "****";
    }
  }
  return out as T;
}

export function buildVideoDryRunResult(
  shot: ShotData,
  input: VideoDryRunInput,
  opts: { fallbackVideoModelRef?: string } = {},
): VideoDryRunResult {
  // ── Resolve provider + model ──
  // W7-sweep (2026-05-16): 不再 silent fallback 到 "local_mock_video" — 红线 #1。
  // 之前 dry-run 在用户没选视频模型时假装"将使用 local_mock_video, 不会扣费",
  // 用户以为他已选了某个视频模型,实际预估的是 mock provider 的零成本 — 极端误导。
  // 改:三层都空(input.model / opts.fallbackVideoModelRef / shot.video_model_ref)
  // → throw ProviderNotSelectedError("generate_videos"),error middleware 自动转 400。
  const inputModelRef = (typeof input.model === "string" && input.model.trim())
    ? input.model.trim()
    : undefined;
  const fallbackFromOpts = typeof opts.fallbackVideoModelRef === "string" && opts.fallbackVideoModelRef.trim()
    ? opts.fallbackVideoModelRef.trim()
    : undefined;
  const fallbackFromShot = typeof shot.video_model_ref === "string" && shot.video_model_ref.trim()
    ? shot.video_model_ref.trim()
    : undefined;

  const rawModelRef = inputModelRef ?? fallbackFromOpts ?? fallbackFromShot;
  if (!rawModelRef) throw new ProviderNotSelectedError("generate_videos");

  const providerId = providerIdFromModelRef(rawModelRef);
  if (!providerId) throw new ProviderNotSelectedError("generate_videos");
  const modelId = modelIdFromModelRef(rawModelRef) ?? null;

  const isReal = isRealVideoProvider(providerId);

  // ── Key presence check (no actual key exposed) ──
  const keyEnv = PROVIDER_KEY_NAMES[providerId];
  const keyPresent = isReal
    ? !!getKeyFor(providerId)
    : true; // mock / local providers never need a key

  // ── Real-video lock advisory ──
  const lockStatus = getRealVideoLockStatus();
  const realLockHeldBy = isReal && lockStatus.locked && lockStatus.holder
    ? {
        provider: lockStatus.holder.provider,
        job_id: lockStatus.holder.jobId,
        scene_id: lockStatus.holder.sceneId,
        age_ms: lockStatus.age_ms,
      }
    : undefined;

  // ── Build request preview ──
  const renderSpec = resolveRenderSpec(shot.aspect_ratio);
  const duration = Number(input.duration_s) || shot.duration_sec || 5;
  const promptText = input.prompt_override
    ?? input.motion_prompt
    ?? shot.prompt_vid
    ?? shot.action
    ?? "";

  const requestPreview: Record<string, unknown> = redactSensitiveFields({
    provider_id: providerId,
    model_id: modelId ?? "(provider default)",
    prompt: promptText,
    negative_prompt: shot.negative_prompt ?? "",
    duration_sec: duration,
    aspect_ratio: renderSpec.aspect_ratio,
    width: renderSpec.width,
    height: renderSpec.height,
    fps: renderSpec.fps,
    first_frame_id: input.first_frame_id ?? null,
    source_video_generation_id: input.source_video_generation_id ?? null,
    seed: typeof input.seed === "number" ? input.seed : undefined,
    count: Math.max(1, Math.min(Number(input.count) || 1, 4)),
    // Mock the header redaction — Authorization would be filled at runtime.
    headers_preview: { authorization: "****", "content-type": "application/json" },
  });

  // ── Cost estimate (zero for mock) ──
  const cost = estimateVideoCost({
    provider: providerId,
    model: modelId ?? "",
    duration,
  });

  // Missing key on a real provider → controller surfaces HTTP 400.
  if (isReal && !keyPresent) {
    return {
      ok: false,
      dry_run: true,
      will_not_call_provider: true,
      provider_id: providerId,
      model_id: modelId,
      key_present: false,
      is_real_provider: true,
      will_acquire_real_lock: false,
      request_preview: requestPreview,
      estimated_cost_cny: cost.estimated_cny,
      estimated_cost_note: cost.note,
      shot_id: shot.id,
      error: "key_missing",
      message: `provider ${providerId} 需要的 API Key (${keyEnv ?? "API Key"}) 未配置`,
    };
  }

  return {
    ok: true,
    dry_run: true,
    will_not_call_provider: true,
    provider_id: providerId,
    model_id: modelId,
    key_present: keyPresent,
    is_real_provider: isReal,
    will_acquire_real_lock: isReal,
    real_lock_held_by: realLockHeldBy,
    request_preview: requestPreview,
    estimated_cost_cny: cost.estimated_cny,
    estimated_cost_note: cost.note,
    shot_id: shot.id,
    message: isReal
      ? `将调用 ${providerId} 真实视频接口,预估 ¥${(cost.estimated_cny ?? 0).toFixed(2)}`
      : `${providerId} 为本地/Mock provider,不会扣费`,
  };
}
