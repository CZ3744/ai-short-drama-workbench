// 来源: BACKEND_SPEC.md 10 个能力区（Script/AI/Shot/FirstFrame/Video/Post/Lock/PendingJob/Failures/Models/Settings/Batch）
// v24-batch-all · shot-centric API 薄包装层
// 所有函数调用后端 /api/v2/* 路径，后端未实现时返回 { ok: false, not_implemented: true }
import { apiGet, apiPost, apiPatch, apiPut, apiDelete, ApiError } from "./api";

export interface NotImplementedResult {
  ok: false;
  not_implemented: true;
  reason: string;
}

function notImplemented(reason: string): NotImplementedResult {
  return { ok: false, not_implemented: true, reason };
}

// Type guard — narrows union types returned by withFallback() to exclude NotImplementedResult.
// Usage: if (isNotImplemented(res)) { ...handle gracefully...; return; } / now res is the success branch.
export function isNotImplemented(value: unknown): value is NotImplementedResult {
  return (
    !!value &&
    typeof value === "object" &&
    (value as NotImplementedResult).ok === false &&
    (value as NotImplementedResult).not_implemented === true
  );
}


async function withFallback<T>(fn: () => Promise<T>, label: string): Promise<T | NotImplementedResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 501 || err.status === 404)) {
      return notImplemented(`${label}: ${err.code} · ${err.detail}`);
    }
    throw err;
  }
}

// ====================================================================
// MODELS · /api/v2/models
// ====================================================================

export interface ModelCapability {
  id: string;
  name: string;
  price: string;
  eta: string;
  note: string;
  actions: string[];
  status: "ok" | "coming";
  availability?: "ok" | "needs_key" | "coming";
  durations?: number[];
  hot?: boolean;
}

export interface ListModelsResult {
  models: ModelCapability[];
}

export async function listModels() {
  return withFallback(() => apiGet<ListModelsResult>("/api/v2/models"), "listModels");
}

// getHotPath 已删除: 后端 hot-path endpoint 是写死固定内容(铁律 #5 违规),
// ModelSplitButton 从 modelDict.ts/hotPathFor() 读静态列表,无需远程调用。

// ====================================================================
// MODEL DEFAULTS · /api/v2/settings/model-defaults
// ====================================================================

export interface ModelDefaults {
  t2i?: string;
  i2v?: string;
  t2v?: string;
  [k: string]: string | undefined;
}

export async function getModelDefaults() {
  return withFallback(() => apiGet<{ defaults: ModelDefaults }>("/api/v2/settings/model-defaults"), "getModelDefaults");
}

export async function putModelDefaults(defaults: ModelDefaults) {
  return withFallback(() => apiPut<{ ok: true; defaults: ModelDefaults }>("/api/v2/settings/model-defaults", { defaults }), "putModelDefaults");
}

// ====================================================================
// SHOT · /api/v2/shots/:sid
// ====================================================================

export interface ShotCharacterAnchor {
  id: string;
  name: string;
  lora: string;
  weight: number;
  photo: number;
  kind?: "character" | "scene";
}

export interface ShotDetail {
  sid: string;
  slug: string;
  ep_id: string;
  title: string;
  prompt: string;
  motion_prompt?: string;
  negative_prompt?: string;
  params?: Record<string, unknown>;
  action?: string;
  dialogue?: string;
  voiceover?: string;
  /**
   * 2026-05-22 — stage endpoint 已返这些字段 (shotDetailDto:239), 但 type 之前缺.
   * buildDraft 优先用 nodes derive 含 @ 短格式给 MentionTextarea, 不依赖 useShots
   * SWR 异步加载完成 (修 race: sourceShot=undefined 时 fallback 到 detail.action 丢 @).
   */
  action_nodes?: import("../../../../packages/drama/src/types").ShotTextNode[];
  dialogue_nodes?: import("../../../../packages/drama/src/types").ShotTextNode[];
  voiceover_nodes?: import("../../../../packages/drama/src/types").ShotTextNode[];
  prompt_img_nodes?: import("../../../../packages/drama/src/types").ShotTextNode[];
  prompt_vid_nodes?: import("../../../../packages/drama/src/types").ShotTextNode[];
  notes?: string;
  scene_id?: string;
  character_ids?: string[];
  element_ids?: string[];
  reference_asset_ids?: string[];
  keyframe_asset_id?: string;
  character_anchors: ShotCharacterAnchor[];
  status: string;
  locked: boolean;
  stage?: 1 | 2 | 3 | 4;
  picked_first_frame_id?: string | null;
  picked_video_id?: string | null;
  first_frame_candidates?: ShotCandidate[];
  video_candidates?: ShotCandidate[];
  trashed_candidates?: ShotCandidate[];
  updated_at: string;
}

export interface ShotCandidate {
  id: string;
  generation_id: string;
  type: "first_frame" | "video";
  url: string;
  thumbnail?: string;
  provider: string;
  seed?: number;
  prompt?: string;
  picked?: boolean;
  created_at: string;
  vault_id?: string;
  asset_id?: string;
  cost_cny?: number;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  duration_sec?: number;
  /**
   * 2026-05-20 display_name 体系统一: 用户 inline rename 写的候选名,
   * 显示在卡片底下 (默认 provider 名). 后端优先输出 display_name.
   */
  display_name?: string;
  /** B-8: 4 维度质量评分 (postGenCheck 写入) */
  quality_scores?: {
    composition: number;
    sharpness: number;
    prompt_alignment: number;
    subject_completeness: number;
    checked_at: string;
  };
}

export async function getShotDetail(sid: string) {
  return withFallback(() => apiGet<ShotDetail>(`/api/v2/shots/${encodeURIComponent(sid)}`), "getShotDetail");
}

export async function getScopedShotDetail(slug: string, epId: string, sid: string) {
  return withFallback(
    () => apiGet<ShotDetail>(`/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage`),
    "getScopedShotDetail",
  );
}

export async function putShotPrompt(sid: string, text: string) {
  return withFallback(() => apiPut<{ ok: true; shot: ShotDetail }>(`/api/v2/shots/${encodeURIComponent(sid)}/prompt`, { text }), "putShotPrompt");
}

// ====================================================================
// FIRST FRAME · /api/v2/shots/:sid/firstframe
// ====================================================================

export interface GenerateFirstFrameInput {
  count: number;
  /**
   * B5: full ModelPicker model_ref ("provider_id:model_id" or just "provider_id").
   * Backend splits this into provider id (selects adapter instance) and
   * model id (passed to adapter as request.model_id). Do NOT pre-split on
   * the frontend — the contract is to forward the ModelPicker value verbatim.
   */
  model?: string;
  seed?: number;
  ref_image_ids?: string[];
  /**
   * W3-A (2026-05-15): 审核弹窗里用户改过的完整 prompt; 优先级最高,
   * 后端会原样喂给 provider, 不再走 compiler。
   */
  prompt_override?: string;
  /**
   * W3-A: 用户额外要求 (UI 文本框输入); 后端走 compiler 拼到 full_prompt 的
   * user_extra 段, 再喂 provider。
   */
  user_extra_instruction?: string;
  /** 用候选视频作微调来源:后端抽首帧后新增一条视频候选。 */
  source_video_generation_id?: string;
}

export interface GenerateFirstFrameResult {
  ok: true;
  attempt_id: string;
  job_id?: string;
  tasks?: Array<{ task_id: string; shot_id: string; status: string }>;
  estimated_cost_cny?: number;
  estimated_duration_s?: number;
}

export async function generateFirstFrame(sid: string, input: GenerateFirstFrameInput) {
  return withFallback(
    () => apiPost<GenerateFirstFrameResult>(`/api/v2/shots/${encodeURIComponent(sid)}/firstframe/generate`, input),
    "generateFirstFrame",
  );
}

// 2026-05-14: preview the prompt that would be sent to the image provider —
// zero-cost (no provider call). Lets the user copy / download / manually
// submit elsewhere before triggering a paid generation.
export interface FirstFramePromptPreview {
  ok: true;
  shot: { sid: string; slug: string; ep_id: string };
  user_prompt: string;
  enrichments: string[];
  composed_prompt: string;
  image_model_ref: string | null;
  character_ids: string[];
  reference_asset_ids: string[];
  // 2026-05-28 audit: 后端实际返回此字段 (跟 ShotPromptPreview 对齐),
  // 前端 type 历史上漏声明, 导致 DryRunModal.tsx 走强类型转换 workaround. 现补齐声明.
  suggested_references?: Array<{ url: string; label: string; asset_id?: string }>;
  note: string;
}
export async function previewFirstFramePrompt(sid: string): Promise<FirstFramePromptPreview> {
  return apiGet<FirstFramePromptPreview>(`/api/v2/shots/${encodeURIComponent(sid)}/firstframe/preview-prompt`);
}

/** V-15: 通用分镜提示词预览 — 支持 image/video kind */
export interface ShotPromptPreview {
  composed_prompt: string;
  image_model_ref?: string | null;
  video_model_ref?: string | null;
  suggested_references?: Array<{ url: string; label: string; asset_id?: string }>;
  note?: string;
}
export async function previewShotPrompt(sid: string, kind: "image" | "video"): Promise<ShotPromptPreview> {
  return apiGet<ShotPromptPreview>(`/api/v2/shots/${encodeURIComponent(sid)}/stage/prompt-preview?kind=${kind}`);
}

// 2026-05-14: upload a user-supplied image (e.g. generated externally with the
// preview prompt) and register it as a candidate.
export interface ImportFirstFrameResult {
  ok: true;
  generation_id: string;
  vault_id: string;
  message: string;
}
export async function importFirstFrameImage(
  sid: string,
  payload: { image_base64: string; mime?: string; note?: string },
): Promise<ImportFirstFrameResult> {
  return apiPost<ImportFirstFrameResult>(
    `/api/v2/shots/${encodeURIComponent(sid)}/firstframe/import-image`,
    payload,
  );
}

export async function generateScopedFirstFrame(slug: string, epId: string, sid: string, input: GenerateFirstFrameInput) {
  return withFallback(
    () => apiPost<GenerateFirstFrameResult>(
      `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/firstframe/generate`,
      input,
    ),
    "generateScopedFirstFrame",
  );
}

// W3-A: input 新增 extra_instruction?: string — 用户对废案的微调意见
//        (后端用废案图作为 i2i 参考 + 此意见再喂 compiler)
export async function regenFromReject(sid: string, cid: string, input: { count: number; prompt_override?: string; model?: string; mix_with?: string[]; extra_instruction?: string; compact_mode?: boolean }) {
  return withFallback(
    () => apiPost<GenerateFirstFrameResult>(`/api/v2/shots/${encodeURIComponent(sid)}/firstframe/regen-from-reject/${encodeURIComponent(cid)}`, input),
    "regenFromReject",
  );
}

export async function patchFirstFrameCandidate(sid: string, cid: string, action: "select" | "reject" | "restore", reason?: string) {
  return withFallback(
    () => apiPatch<{ ok: true }>(`/api/v2/shots/${encodeURIComponent(sid)}/firstframe/candidate/${encodeURIComponent(cid)}`, { action, reason }),
    "patchFirstFrameCandidate",
  );
}

export async function patchScopedFirstFrameCandidate(
  slug: string,
  epId: string,
  sid: string,
  cid: string,
  action: "select" | "reject" | "restore" | "rename",
  reason?: string,
  label?: string,
) {
  return withFallback(
    () => apiPatch<{ ok: true }>(
      `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/firstframe/candidate/${encodeURIComponent(cid)}`,
      { action, reason, label },
    ),
    "patchScopedFirstFrameCandidate",
  );
}

// ====================================================================
// VIDEO · /api/v2/shots/:sid/video
// ====================================================================

export interface GenerateShotVideoInput {
  first_frame_id: string;
  last_frame_id?: string;
  motion_prompt: string;
  duration_s: number;
  count?: number;
  camera_move?: string[];
  pace?: "slow" | "medium" | "fast";
  /**
   * B5: full ModelPicker model_ref ("provider_id:model_id" or just "provider_id").
   * See note on GenerateFirstFrameInput.model. Do NOT pre-split.
   */
  model?: string;
  /**
   * W3-A (2026-05-15): 审核弹窗里用户改过的完整 motion_prompt; 优先级最高。
   */
  prompt_override?: string;
  /**
   * W3-A: 用户额外要求, 后端走 compiler 拼到 full_prompt 的 user_extra 段。
   */
  user_extra_instruction?: string;
}

export async function generateShotVideo(sid: string, input: GenerateShotVideoInput) {
  return withFallback(
    () => apiPost<GenerateFirstFrameResult>(`/api/v2/shots/${encodeURIComponent(sid)}/video/generate`, input),
    "generateShotVideo",
  );
}

export async function generateScopedShotVideo(slug: string, epId: string, sid: string, input: GenerateShotVideoInput) {
  return withFallback(
    () => apiPost<GenerateFirstFrameResult>(
      `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/video/generate`,
      input,
    ),
    "generateScopedShotVideo",
  );
}

export async function patchVideoCandidate(sid: string, vid: string, action: "select" | "reject" | "restore", reason?: string) {
  return withFallback(
    () => apiPatch<{ ok: true }>(`/api/v2/shots/${encodeURIComponent(sid)}/video/candidate/${encodeURIComponent(vid)}`, { action, reason }),
    "patchVideoCandidate",
  );
}

export async function patchScopedVideoCandidate(
  slug: string,
  epId: string,
  sid: string,
  vid: string,
  action: "select" | "reject" | "restore" | "rename",
  reason?: string,
  label?: string,
) {
  return withFallback(
    () => apiPatch<{ ok: true }>(
      `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/video/candidate/${encodeURIComponent(vid)}`,
      { action, reason, label },
    ),
    "patchScopedVideoCandidate",
  );
}

// ====================================================================
// FAILURES · /api/v2/shots/:sid/failures
// ====================================================================

export interface ShotFailure {
  attempt_id: string;
  at: string;
  stage: string;
  model?: string;
  code: string;
  message: string;
  request_json?: unknown;
  response_json?: unknown;
  suggested_model?: string;
}

export async function listShotFailures(sid: string, slug?: string, epId?: string) {
  // 2026-05-26 walkthrough fix: shotId 全局不唯一 (多 series 都有 s0001) →
  // 必须带 slug+epId 显式定位, 否则会拿到其他 series 同名 shot 的失败计数.
  const qs = slug && epId
    ? `?slug=${encodeURIComponent(slug)}&epId=${encodeURIComponent(epId)}`
    : "";
  return withFallback(
    () => apiGet<{ failures: ShotFailure[] }>(`/api/v2/shots/${encodeURIComponent(sid)}/failures${qs}`),
    "listShotFailures",
  );
}

export async function retryFailure(sid: string, aid: string) {
  return withFallback(
    () => apiPost<GenerateFirstFrameResult>(`/api/v2/shots/${encodeURIComponent(sid)}/failures/${encodeURIComponent(aid)}/retry`),
    "retryFailure",
  );
}

export async function retryWithModel(sid: string, aid: string, model: string) {
  return withFallback(
    () => apiPost<GenerateFirstFrameResult>(`/api/v2/shots/${encodeURIComponent(sid)}/failures/${encodeURIComponent(aid)}/retry-with-model`, { model }),
    "retryWithModel",
  );
}

export async function dismissFailure(sid: string, aid: string) {
  return withFallback(() => apiDelete<{ ok: true }>(`/api/v2/shots/${encodeURIComponent(sid)}/failures/${encodeURIComponent(aid)}`), "dismissFailure");
}

// ====================================================================
// AI · /api/v2/ai
// ====================================================================

export interface AiAskInput {
  context: string;
  question: string;
  scope?: { kind: "script" | "shot" | "prompt"; id: string };
  /** 可选: 让用户在请求时选择 LLM provider; 不传则走后端默认链 */
  llm_provider_id?: string;
}

export async function aiAsk(input: AiAskInput) {
  return withFallback(
    () => apiPost<{ ok: true; answer: string; cost_cny?: number }>("/api/v2/ai/ask", input),
    "aiAsk",
  );
}

export interface AiSuggestInput {
  context: string;
  instruction: string;
  scope?: { kind: "script" | "shot" | "prompt"; id: string };
  /** 可选: 让用户在请求时选择 LLM provider; 不传则走后端默认链 */
  llm_provider_id?: string;
}

export interface AiSuggestPatch {
  id?: string;
  kind: "modify" | "insert" | "rewrite" | "delete";
  path: string;
  title: string;
  before?: string;
  after?: string;
  is_field?: boolean;
  is_new?: boolean;
  affect?: string;
}

export interface AiSuggestResult {
  ok: true;
  suggestion_id: string;
  patches: AiSuggestPatch[];
  cost_cny?: number;
}

export async function aiSuggest(input: AiSuggestInput) {
  return withFallback(() => apiPost<AiSuggestResult>("/api/v2/ai/suggest", input), "aiSuggest");
}

export async function acceptSuggest(
  sid: string,
  patch_ids?: string[],
  apply?: { slug?: string; series_slug?: string; episode_id?: string; epId?: string },
) {
  return withFallback(
    () => apiPost<{ ok: true; applied?: unknown }>(
      `/api/v2/ai/suggest/${encodeURIComponent(sid)}/accept`,
      { patch_ids, ...apply },
    ),
    "acceptSuggest",
  );
}

export async function rejectSuggest(sid: string, patch_ids?: string[]) {
  return withFallback(() => apiPost<{ ok: true }>(`/api/v2/ai/suggest/${encodeURIComponent(sid)}/reject`, { patch_ids }), "rejectSuggest");
}

// ====================================================================
// BATCH · /api/v2/batch
// ====================================================================

export interface BatchTarget {
  sid: string;
  action: "firstframe" | "video" | "subtitle_burn" | "compose";
  params?: Record<string, unknown>;
}

export interface BatchDryRunResult {
  ok: true;
  total_estimated_cost_cny: number;
  total_estimated_duration_s: number;
  per_target: Array<{ sid: string; estimated_cost_cny: number; estimated_duration_s: number; warnings?: string[] }>;
}

export interface BatchExecuteResult {
  ok: true;
  batch_id: string;
  attempt_id?: string;
  results?: Array<{
    sid: string;
    action: BatchTarget["action"];
    ok: boolean;
    error?: string;
  }>;
}

export async function batchDryRun(targets: BatchTarget[]) {
  return withFallback(
    () => apiPost<BatchDryRunResult>("/api/v2/batch/dry-run", { targets }),
    "batchDryRun",
  );
}

export async function batchExecute(targets: BatchTarget[]) {
  return withFallback(
    () => apiPost<BatchExecuteResult>("/api/v2/batch/execute", { targets }),
    "batchExecute",
  );
}

export async function batchCancel(batch_id: string) {
  return withFallback(
    () => apiPost<{ ok: true }>(`/api/v2/batch/${encodeURIComponent(batch_id)}/cancel`, {}),
    "batchCancel",
  );
}

// ====================================================================
// SHOT STAGE API — 来自原 shotStageApi.ts（Wave4 合并，保持向后兼容）
// 以下内容对应后端: shotStageController.ts + rejectPoolController.ts
// ====================================================================

// ─── 关于 model 字段约定 ────────────────────────────────────────
// 所有 shotStage 相关的 generate / dry-run 接口的 `model` 参数都接收
// **完整 model_ref**, 格式 `<provider_id>:<model_id>` 或纯 `<provider_id>`
// (后者意味着 "用 provider 实例的默认 model")。后端 modelRef.ts 内的
// providerIdFromModelRef / modelIdFromModelRef 会自动 split 并把
// model_id 作为 request.model_id 传到 provider adapter。
// 前端不要再砍冒号; 直接传 ModelPicker 的 value。

// ─── 帧锚点 ──────────────────────────────────────────────────────
export interface FrameAnchor {
  id: string;
  role: "first" | "end" | "key";
  position: number;
  vault_id?: string;
  asset_id?: string;
  generation_id?: string;
  created_at: string;
}

export interface FrameAnchorInput {
  role: "first" | "end" | "key";
  position?: number;
  vault_id?: string;
  asset_id?: string;
  generation_id?: string;
}

export async function setFrameAnchor(slug: string, epId: string, sid: string, input: FrameAnchorInput) {
  return apiPost<{ ok: true; frame_anchors: FrameAnchor[] }>(
    `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/frame-anchor`,
    input,
  );
}

export async function removeFrameAnchor(slug: string, epId: string, sid: string, anchorId: string) {
  return apiDelete<{ ok: true; frame_anchors: FrameAnchor[] }>(
    `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/frame-anchor/${encodeURIComponent(anchorId)}`,
  );
}

/**
 * W7-stage-reorg (2026-05-16): 批量重排关键帧锚点顺序。
 * 只动 role === "key" 的锚点; first / end 自动保留在 0 / 1 位置。
 *
 * @param order anchor_id 数组(新顺序)
 */
export async function reorderKeyAnchors(
  slug: string,
  epId: string,
  sid: string,
  order: string[],
) {
  return apiPatch<{ ok: true; frame_anchors: FrameAnchor[] }>(
    `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/frame-anchor/reorder`,
    { order },
  );
}

// ─── 提示词拼接预览 ──────────────────────────────────────────────
export interface PromptPreviewSegment {
  label: string;
  text: string;
}
export interface PromptPreviewAsset {
  id: string;
  kind: "character" | "scene" | "reference";
  name: string;
}
/**
 * Wave B-2 (2026-05-16): 系统从分镜引用的素材主图自动收集的"建议参考图".
 * 与后端 implicitReferenceCollector.SuggestedReference 同形.
 *
 * 前端用法:
 *  1. 在 PromptReviewModal 显示缩略图列表 + source label
 *  2. 用户可单张取消(铁律 #2)
 *  3. trigger 时, 用户最终确认的 implicit refs 与手选的 reference_asset_ids 合并(去重)
 *     → 一起传 reference_images
 */
export interface SuggestedReference {
  /** 后端 ImageInputRef 用 — 真定位 vault/asset 的 key */
  asset_id: string;
  /** 缩略图 URL — modal 缩略图列表用 */
  url: string;
  /** 小尺寸缩略图 URL — 列表 chip 用 */
  thumbnail_url?: string;
  /** 人类可读标签 — 例: "角色「小明」主图" */
  label: string;
  /** 来源种类 — 前端按 source 分组渲染时用
   * 2026-05-28 P1#15+40: 扩 character_wardrobe / character_prop / shot_prop —
   * 后端 implicitReferenceCollector 已经在产这几种 source, 前端 enum 没接 →
   * label 落到默认分组 "未知来源", 用户看不出哪些是服装哪些是道具.
   */
  source:
    | "character_primary"
    | "scene_primary"
    | "element_primary"
    | "character_wardrobe"
    | "character_prop"
    | "shot_prop";
  /** 来源对象 id */
  source_id: string;
  /** 来源对象人类可读名 */
  source_name: string;
}
export interface PromptPreview {
  ok: true;
  kind: "image" | "video";
  base: string;
  segments: PromptPreviewSegment[];
  connected_assets: PromptPreviewAsset[];
  composed_prompt: string;
  /** W3-A: compiler 产出的负向提示词, 给 UI 一并展示 */
  negative_prompt?: string;
  /** Wave B-2: 系统建议附加的参考图(角色主图 / 场景主图 / 素材主图) — 仅 image kind */
  suggested_references?: SuggestedReference[];
}

export async function getPromptPreview(
  slug: string,
  epId: string,
  sid: string,
  kind: "image" | "video",
  opts?: { userExtra?: string },
) {
  const qsExtra = opts?.userExtra
    ? `&user_extra=${encodeURIComponent(opts.userExtra)}`
    : "";
  return apiGet<PromptPreview>(
    `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/prompt-preview?kind=${kind}${qsExtra}`,
  );
}

// ─── 三级废案库 ──────────────────────────────────────────────────
export type RejectPoolTier = "shot" | "project" | "public";

export interface RejectPoolItem {
  vault_id: string;
  kind: "image" | "video";
  url: string;
  thumbnail: string;
  provider_id?: string;
  created_at: string;
  series_slug?: string;
  cost_cny?: number;
  tags: string[];
  /** 2026-05-21 — 后端透传图本身的展示名 (铁律 #2 display_name 跨页面统一) */
  display_name?: string;
  /** 后端兼容旧 user_note 字段 */
  user_note?: string;
  /** 后端 element_kind / element_name (UI 显示"来自哪个素材") */
  element_kind?: string;
  element_name?: string;
}

/** 把候选升级到项目 / 公共废案库 */
export async function promoteToRejectPool(
  slug: string,
  epId: string,
  sid: string,
  generationId: string,
  target: "project" | "public",
) {
  return apiPost<{ ok: true }>(
    `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/reject-pool/promote`,
    { generation_id: generationId, target },
  );
}

/** 列出某一级废案库 (project 需要 slug) */
export async function listRejectPool(tier: "project" | "public", slug?: string) {
  const q = tier === "project" && slug ? `?tier=project&slug=${encodeURIComponent(slug)}` : `?tier=${tier}`;
  return apiGet<{ items: RejectPoolItem[] }>(`/api/v2/reject-pool${q}`);
}

/** 从废案库导入一张作为本镜候选 */
export async function importFromRejectPool(
  slug: string,
  epId: string,
  sid: string,
  vaultId: string,
  asAnchor?: "first",
) {
  return apiPost<{ ok: true; generation_id: string }>(
    `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/reject-pool/import`,
    asAnchor ? { vault_id: vaultId, as_anchor: asAnchor } : { vault_id: vaultId },
  );
}

// ─── 本地图片直接导入为候选 ──────────────────────────────────────
export async function importLocalImageAsCandidate(
  sid: string,
  payload: { image_base64: string; mime?: string; note?: string; as_anchor?: "first" },
) {
  return apiPost<{ ok: true; generation_id: string; vault_id: string }>(
    `/api/v2/shots/${encodeURIComponent(sid)}/firstframe/import-image`,
    payload,
  );
}

// ─── 2026-05-18: 本地视频直接导入为候选 ──────────────────────────────
// 用户原话"复制完整提示词到外部 AI 生成之后导入回来"的 video 路径补全.
// 用户在外部 AI (Kling / Sora / Runway / Pika) 生成 mp4 后, 拖回 shot.video_candidates 池.
export async function importLocalVideoAsCandidate(
  sid: string,
  payload: { video_base64: string; mime?: string; note?: string; duration_sec?: number; width?: number; height?: number },
) {
  return apiPost<{ ok: true; generation_id: string; vault_id: string }>(
    `/api/v2/shots/${encodeURIComponent(sid)}/video/import-local`,
    payload,
  );
}

// ─── O3: Video dry-run (零扣费预览) ─────────────────────────────────
// 返回 will_acquire_real_lock / is_real_provider / estimated_cost_cny / request_preview,
// 用于在真实 provider 上弹"是否继续"二级确认。response body 见后端
// videoDryRun.ts 的 VideoDryRunResult。
export interface VideoDryRunInput {
  model?: string;            // 完整 model_ref (provider:model 或纯 provider)
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
  real_lock_held_by?: { provider: string; job_id: string; scene_id: string; age_ms?: number };
  request_preview: Record<string, unknown>;
  estimated_cost_cny: number | null;
  estimated_cost_note: string;
  shot_id: string;
  message?: string;
  error?: "key_missing";
}

/** Scoped 路径 dry-run (推荐 — 与 generateScopedShotVideo 路径对齐) */
export async function dryRunVideo(slug: string, epId: string, sid: string, body: VideoDryRunInput) {
  return apiPost<VideoDryRunResult>(
    `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(sid)}/stage/video/generate/dry-run`,
    body,
  );
}

/** Flat 路径 dry-run (仅 shot id, 与 /shots/:sid/video/generate 路径对齐) */
export async function dryRunVideoFlat(sid: string, body: VideoDryRunInput) {
  return apiPost<VideoDryRunResult>(
    `/api/v2/shots/${encodeURIComponent(sid)}/video/generate/dry-run`,
    body,
  );
}

// ─── D-P1: AI 润色提示词 ───────────────────────────────────────
export interface PolishPromptResult {
  ok: true;
  polished_prompt: string;
  cost_cny?: number;
}

export async function polishPrompt(sid: string, mode: "image" | "video", llmProviderId?: string) {
  return apiPost<PolishPromptResult>(
    `/api/v2/shots/${encodeURIComponent(sid)}/stage/polish-prompt`,
    { mode, llm_provider_id: llmProviderId },
  );
}

/** 读 File 为去掉 data: 前缀的 base64 */
export { fileToRawBase64 as fileToBase64 } from "./fileBase64";
