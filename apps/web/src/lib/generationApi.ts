/**
 * generationApi.ts — 统一图像/视频生成 API 客户端 (Phase 2, Wave 2, 2026-05-16).
 *
 * 设计依据:
 *  - docs/ASSET_MANAGEMENT_REDESIGN.md §3 TargetAdapter 模式
 *  - memory feedback_decoupling.md (用户原话: "不就是接收拼接的提示词、调用模型选择器
 *    选择的模型发给 api... 为什么还没模块化?")
 *  - 后端 Phase 1 已经完成 apps/server/src/application/generation/imageGenerationOrchestrator/
 *    + videoGenerationOrchestrator/, 这里只是把它的入参契约前移到前端。
 *
 * 解耦策略:
 *  - **优先调新统一端点** `/api/v2/generate/image` / `/api/v2/generate/video`
 *    (由并行 Agent B 在 Wave 2 完成)。
 *  - **新端点不可用** (404 / 501) 自动降级到老的业务端点 (按 target.kind 路由)。
 *  - 等 Wave 3 Agent B 全部完工 + 验收无误后, 把 USE_LEGACY_FALLBACK 改成 false 即可
 *    彻底切到新端点。
 *
 * 前端不再 split provider:model — 全部传完整 model_ref, 后端 modelRef.ts 处理。
 */

import { apiPost, ApiError } from "./api";

// ─── target 契约 (与后端 types.ts 对齐) ──────────────────────────────

/** 与后端 ImageTargetKindSchema 一一对应. */
export type ImageTargetKind =
  | "shot_first_frame"
  | "shot_last_frame"
  | "element"
  | "character_ref"
  | "scene_ref"
  | "library_variant"
  | "vault_only";

export interface ImageGenerationTarget {
  kind: ImageTargetKind;
  series_slug: string;
  /** 业务对象 id (shot_id / element_id 等); vault_only 时可省 */
  target_id?: string;
  /** 例: shot 的 "first" / "last" */
  sub_target?: string;
  /** 额外业务上下文 (ep_id / category 等) */
  meta?: Record<string, unknown>;
}

/** 与后端 VideoTargetKindSchema 一一对应. */
export type VideoTargetKind = "shot_video" | "vault_only";

export interface VideoGenerationTarget {
  kind: VideoTargetKind;
  series_slug: string;
  target_id?: string;
  sub_target?: string;
  meta?: Record<string, unknown>;
}

// ─── 参考图入参 ─────────────────────────────────────────────────────

/**
 * 参考图传入方式 (与后端 ImageInputRef 对齐).
 * 5 选 1, 后端 imageGenerationService 自己解析.
 */
export type ImageReferenceInput =
  | { asset_id: string; label?: string }
  | { vault_id: string; label?: string }
  | { path: string; label?: string }
  | { data_url: string; label?: string }
  | { base64: string; mime?: string; label?: string };

// ─── 返回结构 (与后端 PersistedImage / GenerateImagesForTargetResult 对齐) ──

export interface PersistedImage {
  image_id: string;
  asset_id?: string;
  vault_id?: string;
  url: string;
  width?: number;
  height?: number;
  seed?: number;
  mime: string;
  provider_id: string;
  prompt_snapshot: string;
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
}

export interface CostInfo {
  amount: number;
  currency: string;
  note?: string;
}

export interface GenerateImageResult {
  ok: true;
  images: PersistedImage[];
  provider_id: string;
  cost?: CostInfo;
  /** 业务对象最新快照 (ElementData / ShotData / 等); vault_only 时为 undefined */
  target_state?: unknown;
}

export interface GenerateVideoResult {
  ok: true;
  video: PersistedVideo;
  provider_id: string;
  cost?: CostInfo;
  target_state?: unknown;
}

// ─── 请求入参 ────────────────────────────────────────────────────────

export interface GenerateImageInput {
  /** 业务目标 — 决定后端 adapter / 老端点 fallback 走哪条路径 */
  target: ImageGenerationTarget;

  /** 完整自包含 prompt — 由 caller 通过 promptCompiler 合成 */
  prompt: string;

  negative_prompt?: string;

  /**
   * ModelPicker 的 value, 完整 model_ref ("provider_id:model_id" 或纯 "provider_id").
   * 前端不要 split — 后端 modelRef.ts 处理。
   */
  model_ref?: string;

  /** 抽几张 (默认 1 — 用户铁律: 一键抽卡默认 1) */
  count?: number;

  width?: number;
  height?: number;
  seed?: number;

  reference_images?: ImageReferenceInput[];

  /** i2i 模式 — 后端用于 origin = "i2i" / based_on_image_id 标记 */
  i2i_base?: { image_id?: string; note?: string };

  /** 给 vault asset 打的额外标签 */
  extra_tags?: string[];

  /** 透传 job_id / task_id, 让 SSE 能聚合到本次操作 */
  job_id?: string;
  task_id?: string;
}

export interface GenerateImageDryRunResult {
  ok: boolean;
  dry_run: true;
  will_not_call_provider: true;
  provider_id: string;
  model_id: string | null;
  key_present: boolean;
  is_keyless: boolean;
  request_preview: Record<string, unknown>;
  full_prompt_preview: string;
  estimated_cost_cny: number | null;
  estimated_cost_note: string;
  count: number;
  message?: string;
  /** 后端用 "key_missing" 标记 Key 缺失, UI 弹去设置 */
  error?: "key_missing";
}

export interface GenerateVideoInput {
  target: VideoGenerationTarget;
  prompt: string;
  negative_prompt?: string;
  model_ref?: string;
  duration_sec?: number;
  aspect_ratio?: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
  seed?: number;
  /** 必填 (除 vault_only 外): 首帧参考 */
  first_frame?: ImageReferenceInput;
  reference_images?: ImageReferenceInput[];
  /** 用候选视频作微调来源:后端会抽该视频首帧并走现有 i2v 管线。 */
  source_video_generation_id?: string;
  /**
   * 2026-05-27 — 同时抽 N 段视频. 后端 validators.ts:330 GenerateVideoSchema 已支持
   * count(1..3). 之前 web 端 GenerateVideoInput / useVideoGeneration / ShotStagePage
   * 全部没透传, 用户选"抽 3 段"实际只抽 1 段 — toC 灾难, 视频贵.
   */
  count?: number;
  extra_tags?: string[];
  job_id?: string;
  task_id?: string;
}

export interface GenerateVideoDryRunResult {
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
  shot_id?: string;
  message?: string;
  error?: "key_missing";
}

// ─── legacy URL 路由表 — Wave 2 期间老端点 fallback ──────────────────
//
// 新统一端点 (POST /api/v2/generate/image) 由 Agent B 并行在做; 完工时间不一定早于
// 本 Agent。我们的策略是: 先调新端点, 任何 404/501 立刻降级到对应业务端点。
//
// 等 Wave 3 验收后, 把 USE_LEGACY_FALLBACK 改成 false 强制走新端点。

const USE_LEGACY_FALLBACK = true;

/** 老端点路由表: target.kind → URL builder. 仅用于 fallback. */
type LegacyUrlBuilder = (t: ImageGenerationTarget) => string;

const LEGACY_IMAGE_GENERATE_URL: Record<ImageTargetKind, LegacyUrlBuilder> = {
  element: (t) =>
    `/api/v2/series/${encodeURIComponent(t.series_slug)}/elements/${encodeURIComponent(t.target_id ?? "")}/generate-image`,
  // Wave Z-10: character_ref/scene_ref 收口到 element API (elementController 通过 readAnyElement 统一适配)
  character_ref: (t) =>
    `/api/v2/series/${encodeURIComponent(t.series_slug)}/elements/${encodeURIComponent(t.target_id ?? "")}/generate-image`,
  scene_ref: (t) =>
    `/api/v2/series/${encodeURIComponent(t.series_slug)}/elements/${encodeURIComponent(t.target_id ?? "")}/generate-image`,
  shot_first_frame: (t) =>
    `/api/v2/shots/${encodeURIComponent(t.target_id ?? "")}/firstframe/generate`,
  shot_last_frame: (t) =>
    // 后端目前没有独立的 last-frame 端点, 走 stage frame-anchor 流程;
    // 这里挂同样的 firstframe url 让后端按 sub_target 区分 — 若不支持, caller 应直接调
    // shot_first_frame 路径并在 sub_target 上区分。
    `/api/v2/shots/${encodeURIComponent(t.target_id ?? "")}/firstframe/generate`,
  library_variant: (t) =>
    `/api/v2/series/${encodeURIComponent(t.series_slug)}/library/variants/${encodeURIComponent(t.target_id ?? "")}/generate-image`,
  vault_only: () => `/api/v2/images/generate`,
};

// vault_only: 无 dry-run 端点 (后端从未注册过 /api/v2/images/generate/dry-run),
// 且全仓库找不到任何构造 target.kind:"vault_only" 的调用点 —— 2026-07-22 X8-2
// (A4-16) 删除这条指向不存在路由的死映射。类型改 Partial, 命中该分支时下面
// `if (!urlBuilder) throw` 的既有兜底会给出明确报错, 而不是悄悄拼一个会 404 的 URL。
const LEGACY_IMAGE_DRY_RUN_URL: Partial<Record<ImageTargetKind, LegacyUrlBuilder>> = {
  element: (t) =>
    `/api/v2/series/${encodeURIComponent(t.series_slug)}/elements/${encodeURIComponent(t.target_id ?? "")}/generate-image/dry-run`,
  character_ref: (t) =>
    `/api/v2/series/${encodeURIComponent(t.series_slug)}/elements/${encodeURIComponent(t.target_id ?? "")}/generate-image/dry-run`,
  scene_ref: (t) =>
    `/api/v2/series/${encodeURIComponent(t.series_slug)}/elements/${encodeURIComponent(t.target_id ?? "")}/generate-image/dry-run`,
  shot_first_frame: (t) =>
    `/api/v2/shots/${encodeURIComponent(t.target_id ?? "")}/firstframe/generate/dry-run`,
  shot_last_frame: (t) =>
    `/api/v2/shots/${encodeURIComponent(t.target_id ?? "")}/firstframe/generate/dry-run`,
  library_variant: (t) =>
    `/api/v2/series/${encodeURIComponent(t.series_slug)}/library/variants/${encodeURIComponent(t.target_id ?? "")}/generate-image/dry-run`,
};

const LEGACY_VIDEO_GENERATE_URL: Record<VideoTargetKind, (t: VideoGenerationTarget) => string> = {
  shot_video: (t) =>
    `/api/v2/shots/${encodeURIComponent(t.target_id ?? "")}/video/generate`,
  vault_only: () => `/api/v2/videos/generate`,
};

// vault_only: 同上, /api/v2/videos/generate/dry-run 后端未注册 + 0 构造点, 删死映射。
const LEGACY_VIDEO_DRY_RUN_URL: Partial<Record<VideoTargetKind, (t: VideoGenerationTarget) => string>> = {
  shot_video: (t) =>
    `/api/v2/shots/${encodeURIComponent(t.target_id ?? "")}/video/generate/dry-run`,
};

// ─── 新端点 URLs ─────────────────────────────────────────────────────

const NEW_IMAGE_URL = "/api/v2/generate/image";
const NEW_IMAGE_DRY_RUN_URL = "/api/v2/generate/image/dry-run";
const NEW_VIDEO_URL = "/api/v2/generate/video";
const NEW_VIDEO_DRY_RUN_URL = "/api/v2/generate/video/dry-run";

// ─── 老端点 body 适配 ────────────────────────────────────────────────
//
// 不同业务端点收的字段名不一样 (image_model_ref / model / provider_override...).
// fallback 时按 target.kind 把统一 input 翻成对应业务字段。

function buildLegacyImageBody(input: GenerateImageInput): Record<string, unknown> {
  const kind = input.target.kind;
  // 公共部分
  const base: Record<string, unknown> = {
    full_prompt: input.prompt,
    prompt: input.prompt,
    negative_prompt: input.negative_prompt,
    count: input.count,
    width: input.width,
    height: input.height,
    seed: input.seed,
    job_id: input.job_id,
    task_id: input.task_id,
    extra_tags: input.extra_tags,
  };

  // i2i_base / reference_images 兼容
  if (input.i2i_base?.image_id) {
    base.i2i_base_image_id = input.i2i_base.image_id;
  }
  if (input.reference_images && input.reference_images.length > 0) {
    base.reference_images = input.reference_images;
  }

  // model_ref 字段名按业务区分
  switch (kind) {
    case "element":
    case "character_ref":
    case "scene_ref":
    case "library_variant":
      base.image_model_ref = input.model_ref;
      break;
    case "shot_first_frame":
    case "shot_last_frame":
      base.model = input.model_ref;
      // shot 接口习惯把 "原始用户意图" 放 prompt_override / user_extra_instruction
      // 而把 caller 已经编译好的 prompt 透传过去, 也能 work — 后端 W3-A: 有 prompt_override
      // 则优先用。
      base.prompt_override = input.prompt;
      break;
    case "vault_only":
      base.model_ref = input.model_ref;
      break;
  }

  return base;
}

function buildLegacyVideoBody(input: GenerateVideoInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    motion_prompt: input.prompt,
    prompt_override: input.prompt,
    negative_prompt: input.negative_prompt,
    model: input.model_ref,
    model_ref: input.model_ref,
    duration_s: input.duration_sec,
    duration_sec: input.duration_sec,
    aspect_ratio: input.aspect_ratio,
    seed: input.seed,
    // 2026-05-27 — count 透传 (1..3 clamp), 老 sync/dry-run 路径之前漏字段, ShotStage
    // "抽 N 段" 也走 dry-run 预估费, 不传 count dry-run 估的就是 1 段费用 → 误导.
    count: Math.min(Math.max(1, Number(input.count) || 1), 3),
    job_id: input.job_id,
    task_id: input.task_id,
    extra_tags: input.extra_tags,
    source_video_generation_id: input.source_video_generation_id,
  };
  if (input.first_frame) {
    // shot_video 老端点收 first_frame_id (asset_id / vault_id / generation_id)
    if ("asset_id" in input.first_frame) base.first_frame_id = input.first_frame.asset_id;
    else if ("vault_id" in input.first_frame) base.first_frame_id = input.first_frame.vault_id;
    else base.first_frame = input.first_frame;
  }
  if (input.reference_images && input.reference_images.length > 0) {
    base.reference_images = input.reference_images;
  }
  return base;
}

// ─── 老端点返回 → 统一格式 ────────────────────────────────────────────
//
// 老端点的返回结构各异 (ElementController 返 element + images, ShotController 返
// attempt_id + tasks[])。统一收敛到 GenerateImageResult。caller 拿到统一格式即可,
// 不需要管底层走的哪条路。

interface LegacyImageResponse {
  ok?: boolean;
  provider_id?: string;
  images?: PersistedImage[];
  element?: unknown;
  character?: unknown;
  scene?: unknown;
  shot?: unknown;
  target_state?: unknown;
  cost?: CostInfo;
  /** 老 ShotController 风格: 返 task 列表后续靠 SSE 拿真实结果 */
  tasks?: Array<{ task_id: string; shot_id?: string; status?: string }>;
  attempt_id?: string;
  job_id?: string;
}

function normalizeLegacyImageResponse(
  raw: LegacyImageResponse,
  target: ImageGenerationTarget,
): GenerateImageResult {
  // 把不同 controller 的 alias 字段 (element / character / scene / shot) 都 fold 到
  // target_state 字段。
  const targetState =
    raw.target_state ??
    (target.kind === "element" ? raw.element : undefined) ??
    (target.kind === "character_ref" ? raw.character : undefined) ??
    (target.kind === "scene_ref" ? raw.scene : undefined) ??
    ((target.kind === "shot_first_frame" || target.kind === "shot_last_frame") ? raw.shot : undefined);

  return {
    ok: true,
    images: raw.images ?? [],
    provider_id: raw.provider_id ?? "",
    cost: raw.cost,
    target_state: targetState,
  };
}

interface LegacyVideoResponse {
  ok?: boolean;
  provider_id?: string;
  video?: PersistedVideo;
  shot?: unknown;
  target_state?: unknown;
  cost?: CostInfo;
  tasks?: Array<{ task_id: string; shot_id?: string; status?: string }>;
  attempt_id?: string;
  job_id?: string;
}

function normalizeLegacyVideoResponse(
  raw: LegacyVideoResponse,
  target: VideoGenerationTarget,
): GenerateVideoResult {
  // 视频老端点几乎都返 tasks[] 走 SSE 等结果, 真 PersistedVideo 等 SSE done 后才有。
  // 此处保持兼容: 没有 video 字段就构造一个 placeholder, caller (useVideoGeneration) 通过
  // SSE 等真结果。
  const targetState =
    raw.target_state ??
    (target.kind === "shot_video" ? raw.shot : undefined);

  const fallback: PersistedVideo = {
    generation_id: raw.tasks?.[0]?.task_id ?? "",
    url: "",
    duration_sec: 0,
    mime: "video/mp4",
    provider_id: raw.provider_id ?? "",
    prompt_snapshot: "",
  };

  return {
    ok: true,
    video: raw.video ?? fallback,
    provider_id: raw.provider_id ?? "",
    cost: raw.cost,
    target_state: targetState,
  };
}

// ─── 检测错误是否是 "新端点不存在" ───────────────────────────────────
//
// 我们的 fallback 触发条件: 后端 404 / 501 / 503 (新端点尚未挂载)。其他错误
// (400 invalid params, 401 unauthorized, 500 真 server bug) 不 fallback,
// 让用户看到真错误。

function isEndpointMissingError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.status === 404 || err.status === 501 || err.status === 503;
}

// ─── 公共导出 ────────────────────────────────────────────────────────

/**
 * 调一次生图. 优先调统一端点, 不可用时降级。
 *
 * 调用方一般是 useImageGeneration hook, 它在外面包了 toast / SSE / tasksStore。
 *
 * @throws ApiError (校验 / Key 缺失 / 后端错误) — caller 应 catch 后 toast。
 */
export async function generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
  // 走新统一端点
  try {
    return await apiPost<GenerateImageResult>(NEW_IMAGE_URL, input);
  } catch (err) {
    if (!USE_LEGACY_FALLBACK || !isEndpointMissingError(err)) {
      throw err;
    }
    // 新端点尚未挂, 降级到老业务端点
  }

  const urlBuilder = LEGACY_IMAGE_GENERATE_URL[input.target.kind];
  if (!urlBuilder) {
    throw new Error(`未知 image target.kind: ${input.target.kind}`);
  }
  const url = urlBuilder(input.target);
  const body = buildLegacyImageBody(input);
  const raw = await apiPost<LegacyImageResponse>(url, body);
  return normalizeLegacyImageResponse(raw, input.target);
}

/**
 * 调一次生图 dry-run (预估费用, 不调 provider, 不扣费).
 *
 * 用法: 用户点了"抽 N 张" (N ≥ 2 时强制 dry-run), 弹"预估费用 ¥X, 确认?"
 *
 * @throws ApiError 同上
 */
export async function generateImageDryRun(input: GenerateImageInput): Promise<GenerateImageDryRunResult> {
  try {
    return await apiPost<GenerateImageDryRunResult>(NEW_IMAGE_DRY_RUN_URL, input);
  } catch (err) {
    if (!USE_LEGACY_FALLBACK || !isEndpointMissingError(err)) {
      throw err;
    }
  }

  const urlBuilder = LEGACY_IMAGE_DRY_RUN_URL[input.target.kind];
  if (!urlBuilder) {
    throw new Error(`未知 image target.kind: ${input.target.kind}`);
  }
  const url = urlBuilder(input.target);
  const body = buildLegacyImageBody(input);
  return await apiPost<GenerateImageDryRunResult>(url, body);
}

/**
 * 调一次生视频。
 *
 * @throws ApiError 同上
 */
export async function generateVideo(input: GenerateVideoInput): Promise<GenerateVideoResult> {
  try {
    return await apiPost<GenerateVideoResult>(NEW_VIDEO_URL, input);
  } catch (err) {
    if (!USE_LEGACY_FALLBACK || !isEndpointMissingError(err)) {
      throw err;
    }
  }

  const urlBuilder = LEGACY_VIDEO_GENERATE_URL[input.target.kind];
  if (!urlBuilder) {
    throw new Error(`未知 video target.kind: ${input.target.kind}`);
  }
  const url = urlBuilder(input.target);
  const body = buildLegacyVideoBody(input);
  const raw = await apiPost<LegacyVideoResponse>(url, body);
  return normalizeLegacyVideoResponse(raw, input.target);
}

/**
 * 视频 dry-run — 真实 provider 必须先 dry-run 拿估费 + 锁状态。
 */
export async function generateVideoDryRun(input: GenerateVideoInput): Promise<GenerateVideoDryRunResult> {
  try {
    return await apiPost<GenerateVideoDryRunResult>(NEW_VIDEO_DRY_RUN_URL, input);
  } catch (err) {
    if (!USE_LEGACY_FALLBACK || !isEndpointMissingError(err)) {
      throw err;
    }
  }

  const urlBuilder = LEGACY_VIDEO_DRY_RUN_URL[input.target.kind];
  if (!urlBuilder) {
    throw new Error(`未知 video target.kind: ${input.target.kind}`);
  }
  const url = urlBuilder(input.target);
  const body = buildLegacyVideoBody(input);
  return await apiPost<GenerateVideoDryRunResult>(url, body);
}

// ────────────────────────────────────────────────────────────────────
// ASYNC 模式 (Wave 4-B) — 返 task_id, 真结果通过 SSE 推 (task.done)
// ────────────────────────────────────────────────────────────────────
//
// 与 sync 模式的差异:
//  - sync: 调统一 endpoint, 后端调 provider 完了才返结果 (单元素 / vault 用)
//  - async: 调 scoped endpoint, 后端塞 orchestrator 队列立即返 task_id (主流量 shot 用)
//
// async 模式只支持 target.kind = "shot_first_frame" / "shot_last_frame" / "shot_video";
// element / character_ref / scene_ref / library_variant / vault_only 不允许 async
// (它们本来就是 thin sync 调用, 不走 orchestrator 队列).
//
// 后端 scoped endpoint 形如:
//   POST /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/firstframe/generate
//   POST /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/video/generate
// 返回:
//   { ok: true, attempt_id, job_id, tasks: [{ task_id, shot_id, status }] }
//
// SSE 通过 buildTaskEventHandlers 把 task.done / task.failed 自动同步到 tasksStore,
// hook 负责 task.done 时拉新业务对象 (target_state) 通过 onSuccess 回调给 caller。

/** async 模式返回结构 — 与 ShotStagePage.handleDrawFirstFrame 看到的 res 同构 */
export interface AsyncGenerationAck {
  ok: true;
  attempt_id?: string;
  job_id?: string;
  tasks: Array<{ task_id: string; shot_id?: string; status?: string }>;
  /** 后端给的预估等待秒数 (兜底用) */
  estimated_duration_s?: number;
  /** 后端给的预估费用 (展示用, 不阻塞) */
  estimated_cost_cny?: number;
  /**
   * 2026-05-27 — 后端 resolveMentionsToAssetIds 找不到的 @ mention 列表.
   * 之前 silent skip 用户无感. hook 检测到非空时 toast 提示"@xxx 这个素材没找到".
   */
  skipped_mentions?: Array<{
    name: string;
    kind: "character" | "scene" | "element";
    reason: string;
  }>;
}

/** async image 路由 — caller 在 hook 里调, 不直接给 UI 用 */
function buildAsyncImageUrl(target: ImageGenerationTarget): string {
  const sid = encodeURIComponent(target.target_id ?? "");
  const slug = encodeURIComponent(target.series_slug);
  const epId = encodeURIComponent(
    typeof target.meta?.ep_id === "string" ? (target.meta.ep_id as string) : "",
  );
  switch (target.kind) {
    case "shot_first_frame":
    case "shot_last_frame":
      // 优先 scoped (经过 stage controller, 与 ShotStagePage 一致); 没传 ep_id 退化到 flat
      if (epId) {
        return `/api/v2/series/${slug}/episodes/${epId}/shots/${sid}/stage/firstframe/generate`;
      }
      return `/api/v2/shots/${sid}/firstframe/generate`;
    default:
      throw new Error(
        `async 模式仅支持 shot_first_frame / shot_last_frame, 不支持 target.kind="${target.kind}"`,
      );
  }
}

function buildAsyncVideoUrl(target: VideoGenerationTarget): string {
  const sid = encodeURIComponent(target.target_id ?? "");
  const slug = encodeURIComponent(target.series_slug);
  const epId = encodeURIComponent(
    typeof target.meta?.ep_id === "string" ? (target.meta.ep_id as string) : "",
  );
  switch (target.kind) {
    case "shot_video":
      if (epId) {
        return `/api/v2/series/${slug}/episodes/${epId}/shots/${sid}/stage/video/generate`;
      }
      return `/api/v2/shots/${sid}/video/generate`;
    default:
      throw new Error(`async 模式仅支持 shot_video, 不支持 target.kind="${target.kind}"`);
  }
}

/**
 * Async 模式生图 — 立即返 task_id, 真结果靠 SSE.
 *
 * 仅支持 shot_first_frame / shot_last_frame.
 * @throws Error 当 target.kind 不支持 async / 后端 5xx
 */
export async function generateImageAsync(input: GenerateImageInput): Promise<AsyncGenerationAck> {
  const url = buildAsyncImageUrl(input.target);

  // ShotStagePage 的 generateScopedFirstFrame 用的字段命名: count / model / prompt_override /
  // ref_image_ids — 与 ShotStagePage 现行调用对齐, 与 shotStageController 兼容。
  const body: Record<string, unknown> = {
    count: input.count ?? 1,
    model: input.model_ref,
    prompt_override: input.prompt,
    negative_prompt: input.negative_prompt,
    seed: input.seed,
    width: input.width,
    height: input.height,
    extra_tags: input.extra_tags,
    job_id: input.job_id,
    task_id: input.task_id,
  };
  if (input.target.sub_target) body.sub_target = input.target.sub_target;
  // reference_images 兼容: 后端 shotStageController 习惯 ref_image_ids (asset_id 列表)
  if (input.reference_images && input.reference_images.length > 0) {
    body.reference_images = input.reference_images;
    const assetIds: string[] = [];
    for (const ref of input.reference_images) {
      if ("asset_id" in ref && ref.asset_id) assetIds.push(ref.asset_id);
    }
    if (assetIds.length > 0) body.ref_image_ids = assetIds;
  }
  if (input.i2i_base?.image_id) {
    body.i2i_base_image_id = input.i2i_base.image_id;
  }
  return apiPost<AsyncGenerationAck>(url, body);
}

/**
 * Async 模式生视频 — 立即返 task_id, 真结果靠 SSE.
 *
 * 仅支持 shot_video.
 * @throws Error 当 target.kind 不支持 async / 后端 5xx
 */
export async function generateVideoAsync(input: GenerateVideoInput): Promise<AsyncGenerationAck> {
  const url = buildAsyncVideoUrl(input.target);

  // ShotStagePage 的 generateScopedShotVideo 字段: first_frame_id / motion_prompt / duration_s / count / model
  // 2026-05-27 — count 改读 input.count (1..3), 之前写死 1 让 ShotStage 的"抽 N 段"选择器
  // 完全是装饰. 后端 validators.ts:330 GenerateVideoSchema 支持 1..3.
  const body: Record<string, unknown> = {
    motion_prompt: input.prompt,
    prompt_override: input.prompt,
    negative_prompt: input.negative_prompt,
    model: input.model_ref,
    duration_s: input.duration_sec,
    aspect_ratio: input.aspect_ratio,
    seed: input.seed,
    count: Math.min(Math.max(1, Number(input.count) || 1), 3),
    job_id: input.job_id,
    task_id: input.task_id,
    extra_tags: input.extra_tags,
    source_video_generation_id: input.source_video_generation_id,
  };
  if (input.first_frame) {
    if ("asset_id" in input.first_frame) {
      body.first_frame_id = input.first_frame.asset_id;
    } else if ("vault_id" in input.first_frame) {
      body.first_frame_id = input.first_frame.vault_id;
    } else {
      body.first_frame = input.first_frame;
    }
  }
  if (input.reference_images && input.reference_images.length > 0) {
    body.reference_images = input.reference_images;
  }
  return apiPost<AsyncGenerationAck>(url, body);
}

// ─── 小工具 ─────────────────────────────────────────────────────────

/**
 * 解析 model_ref ("chatgpt_codex_image:gpt-image-2") → { provider_id, model_id }.
 *
 * 主要给 PromptReviewButton 展示 target_provider/target_model 用 — 前端展示层用,
 * 真发请求不要前端 split (后端 modelRef.ts 自己 split)。
 */
export function parseModelRef(ref: string | null | undefined): { provider_id: string; model_id?: string } | null {
  if (!ref) return null;
  const idx = ref.indexOf(":");
  if (idx < 0) return { provider_id: ref };
  return { provider_id: ref.slice(0, idx), model_id: ref.slice(idx + 1) };
}
