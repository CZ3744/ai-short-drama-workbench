/**
 * elementApi — 统一素材 Element 的前端 API 客户端.
 *
 * 设计见 docs/ASSET_MANAGEMENT_REDESIGN.md §10.
 *
 * 刻意独立成文件 (不并入 lib/api.ts): 与素材功能强相关, 解耦; 后续改素材 API
 * 只动这一个文件. 所有 fetch 透传 caller 的 signal (严禁本地 AbortSignal.timeout).
 */

const API_BASE = "/api/v2";
const DEFAULT_TIMEOUT = 180_000;

export type ElementKind = "character" | "scene" | "prop" | "wardrobe" | "reference" | "misc";

/**
 * W8-A 角色一致性体系新增:角度槽位枚举.
 *
 * 仅在 kind=character 下使用,与「6 槽位参考集」对齐.
 *   front     正脸
 *   side      侧脸
 *   back      背面
 *   full_body 全身
 *   wardrobe  服装
 *   emotion   情绪
 *
 * 持久化策略:存在 `ElementData.attrs.image_angles: Record<image_id, ElementAngle>`,
 * 不污染 ElementImage 后端 schema;PATCH element 走 attrs 字典即可,无需改后端 repo.
 */
export type ElementAngle = "front" | "side" | "back" | "full_body" | "wardrobe" | "emotion";

export const ELEMENT_ANGLE_LABEL: Record<ElementAngle, string> = {
  front: "正脸",
  side: "侧脸",
  back: "背面",
  full_body: "全身",
  wardrobe: "服装",
  emotion: "情绪",
};

export const ELEMENT_ANGLE_ORDER: ElementAngle[] = [
  "front",
  "side",
  "back",
  "full_body",
  "wardrobe",
  "emotion",
];

/**
 * 角度提示词模板:勾选「重新生成此角度」时,自动 prefill 进 user_instruction 的中文片段.
 * 文案与生图模型对话,自包含 — 喂给空上下文模型也能理解要画什么角度.
 */
export const ELEMENT_ANGLE_PROMPT: Record<ElementAngle, string> = {
  front: "面向镜头的正脸特写,五官清晰,眼神直视镜头",
  side: "侧脸,90 度侧面视角,下颌轮廓与发型线条清晰可见",
  back: "背面视角,从角色背后拍摄,展示发型与体态轮廓",
  full_body: "全身照,从头到脚完整入镜,展示体态与身材比例",
  wardrobe: "重点展示该角色的服装造型,平铺或人台展示,服装细节清楚",
  emotion: "情绪特写,表达该角色典型情绪状态(可在指令中追加具体情绪)",
};

export interface ElementTag {
  axis: string;
  value: string;
  ref_element_id?: string;
}

/**
 * 2026-05-26 W2 — 图片维度标签 (与后端 packages/drama/src/types.ts ImageTag 同形).
 *
 * 给单张 ElementImage 打"姿态/表情/造型/光线/自由"等维度标签, 让 ReferencePicker
 * 能按维度过滤典型图(例: 老张 + 笑 + 西装 一键挑出符合的典型图作 reference).
 *
 * axis 约定 (松散字符串, 不强约束 enum 让上层快速演化):
 *   pose / expression / outfit / lighting / free
 */
export interface ImageTag {
  axis: string;
  value: string;
}

/** W2 — 5 个常用图片标签维度 (UI 列固定段落, 用户在每个维度下填一个 value chip). */
export const IMAGE_TAG_AXES: Array<{ key: string; label: string; placeholder: string }> = [
  { key: "pose", label: "姿势", placeholder: "站立 / 坐 / 走 / 躺" },
  { key: "expression", label: "表情", placeholder: "笑 / 哭 / 沉思 / 平静" },
  { key: "outfit", label: "造型", placeholder: "西装 / 运动服 / 睡衣" },
  { key: "lighting", label: "光线", placeholder: "顺光 / 逆光 / 夜景" },
  { key: "free", label: "自由备注", placeholder: "其他想标注的特征" },
];

export const IMAGE_TAG_AXIS_LABEL: Record<string, string> = {
  pose: "姿势",
  expression: "表情",
  outfit: "造型",
  lighting: "光线",
  angle: "角度",
  free: "自由",
};

export interface ElementImage {
  image_id: string;
  vault_id?: string;
  asset_id?: string;
  origin: "generated" | "i2i" | "imported" | "from_shot" | "legacy";
  prompt_snapshot?: string;
  based_on_image_id?: string;
  provider_id?: string;
  seed?: number;
  url?: string;
  mime?: string;
  created_at: string;
  note?: string;
  display_name?: string;
  available_for_shot?: boolean;
  /** 2026-05-18 三池模型: 是否「典型代表图」(自动作 reference_images) */
  is_typical?: boolean;
  /**
   * W8-A: 该图所属角度槽位.
   *
   * 注意:此字段不在后端 ElementImage 持久化,而是从 `ElementData.attrs.image_angles`
   * 字典反查后注入到前端类型(getElement / listElements 的客户端解包阶段).
   * 标记/取消标记走 PATCH element { attrs: { image_angles: {...} } } 这条路径.
   */
  angle?: ElementAngle | null;
  /**
   * 2026-05-26 W2 — 单张图维度标签 (pose/expression/outfit/lighting/free).
   *
   * 让用户给典型图标"姿态/表情/造型", 让 ReferencePicker 按维度过滤典型图.
   * PATCH /elements/:id/images/:imageId 接受 image_tags 字段直接持久化(后端 W1 已接通).
   */
  image_tags?: ImageTag[];
}

export interface ElementData {
  id: string;
  series_slug: string;
  kind: ElementKind;
  name: string;
  description: string;
  tags: ElementTag[];
  images: ElementImage[];
  primary_image_id?: string;
  attrs: Record<string, unknown>;
  status: "drafted" | "has_images" | "locked";
  created_at: string;
  updated_at: string;
  derived_from?: { series_slug: string; element_id: string };
}

export type ElementTrashKind = "element" | "character" | "scene";

export interface ElementTrashEntry {
  trash_id: string;
  original_id: string;
  kind: ElementTrashKind;
  name: string;
  deleted_at: string;
  expires_at: string;
  days_remaining: number;
  expired: boolean;
  description?: string;
  thumbnail_url?: string;
  thumbnail_asset_id?: string;
  thumbnail_vault_id?: string;
  image_count?: number;
}

export interface ElementUsage {
  episode_id: string;
  /** P0-2 (2026-05-29): 铁律 #9 toC 兜底 — 后端多回 episode.index 让前端渲染"第 N 集"而非 ULID */
  episode_index: number;
  shot_id: string;
  shot_index: number;
  first_frame_url: string | null;
}

export interface CompiledPrompt {
  full_prompt: string;
  negative_prompt: string;
  segments: { label: string; text: string }[];
  is_i2i: boolean;
  polished: boolean;
  polish_error?: string;
}

export interface RejectItem {
  vault_id: string;
  kind: string;
  url: string;
  thumbnail: string;
  provider_id?: string;
  created_at: string;
  series_slug?: string;
  cost_cny?: number;
  element_name?: string;
  element_kind?: string;
  note?: string;
  tags: string[];
  /** 2026-05-21 — 后端透传图本身的展示名 (铁律 #2 display_name 跨页面统一) */
  display_name?: string;
  /** 后端兼容旧 user_note 字段 (老数据可能用这个) */
  user_note?: string;
}

// ─── W8-A: 角度槽位字典工具(纯前端,不碰后端 schema) ──────────────
//
// 设计:角度信息存在 `ElementData.attrs.image_angles` 这个字典里,
// 形态 `Record<image_id, ElementAngle>`. PATCH element 时只改 attrs 即可.
// getElement / listElements 自动把字典展平到每张图的 `image.angle` 字段供 UI 用.

export type ImageAnglesMap = Record<string, ElementAngle>;

export function getImageAngles(el: { attrs?: Record<string, unknown> | null }): ImageAnglesMap {
  const raw = (el.attrs ?? {})["image_angles"];
  if (!raw || typeof raw !== "object") return {};
  const out: ImageAnglesMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && (ELEMENT_ANGLE_ORDER as string[]).includes(v)) {
      out[k] = v as ElementAngle;
    }
  }
  return out;
}

/** 把 attrs.image_angles 字典展平到 element.images[*].angle,纯函数. */
function decorateImagesWithAngles<T extends ElementData>(el: T): T {
  const angles = getImageAngles(el);
  return {
    ...el,
    images: el.images.map((im) => ({ ...im, angle: angles[im.image_id] ?? null })),
  };
}

async function req<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
  // 删 AbortSignal.timeout(timeout). timeout 参数保留 backward-compat 但不再生效.
  const { timeout: _timeout = DEFAULT_TIMEOUT, ...rest } = init ?? {};
  void _timeout;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const msg = json?.error?.message || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return json as T;
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function listElements(slug: string, kind?: ElementKind) {
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const r = await req<{ elements: ElementData[] }>(`/series/${slug}/elements${q}`, { timeout: 30_000 });
  return { ...r, elements: r.elements.map(decorateImagesWithAngles) };
}

export async function getElement(slug: string, id: string) {
  const r = await req<{ element: ElementData }>(`/series/${slug}/elements/${id}`, { timeout: 30_000 });
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

export function createElement(
  slug: string,
  body: { kind: ElementKind; name: string; description?: string; tags?: ElementTag[]; attrs?: Record<string, unknown> },
) {
  return req<{ element: ElementData }>(`/series/${slug}/elements`, {
    method: "POST",
    body: JSON.stringify(body),
    timeout: 30_000,
  });
}

export async function patchElement(
  slug: string,
  id: string,
  patch: { name?: string; description?: string; tags?: ElementTag[]; attrs?: Record<string, unknown> },
) {
  const r = await req<{ element: ElementData }>(`/series/${slug}/elements/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    timeout: 30_000,
  });
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

/**
 * W8-A: 给一张图打 / 取消角度标签.
 * 通过 PATCH element 的 attrs.image_angles 字典实现,不碰后端 ElementImage schema.
 */
export async function setElementImageAngle(
  slug: string,
  id: string,
  imageId: string,
  angle: ElementAngle | null,
  currentAttrs: Record<string, unknown>,
) {
  const prev = getImageAngles({ attrs: currentAttrs });
  const next = { ...prev };
  if (angle === null) delete next[imageId];
  else next[imageId] = angle;
  return patchElement(slug, id, {
    attrs: { ...currentAttrs, image_angles: next },
  });
}

export function deleteElement(slug: string, id: string) {
  // warnings: 后端删除前扫描分镜引用返回的人话提醒 (铁律#9 "第 N 镜", 不含内部 id), 前端 toast.warning 展示
  return req<{ ok: boolean; warnings?: string[] }>(`/series/${slug}/elements/${id}`, { method: "DELETE", timeout: 30_000 });
}

export function listElementTrash(slug: string, kind?: ElementTrashKind) {
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return req<{ items: ElementTrashEntry[]; total: number }>(
    `/series/${slug}/elements-trash${q}`,
    { timeout: 30_000 },
  );
}

export function restoreElementTrash(slug: string, trashId: string) {
  return req<{ ok: boolean; restored_id: string }>(
    `/series/${slug}/elements-trash/${encodeURIComponent(trashId)}/restore`,
    { method: "POST", timeout: 30_000 },
  );
}

export function permanentDeleteElementTrash(slug: string, trashId: string) {
  return req<{ ok: boolean }>(
    `/series/${slug}/elements-trash/${encodeURIComponent(trashId)}`,
    { method: "DELETE", timeout: 30_000 },
  );
}

export function getElementUsage(slug: string, id: string, kind?: ElementKind) {
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return req<{ usage: ElementUsage[]; total_count: number }>(
    `/series/${slug}/elements/${id}/usage${q}`,
    { timeout: 30_000 },
  );
}

/**
 * 跨项目导入素材 (设计文档 §8.1).
 * 把 from_slug 项目的 element_id 深拷贝到当前 toSlug 项目.
 *   - 名称冲突: 提供 name_override 否则后端加 "(导入)" 后缀
 *   - 图片走 vault SHA-256 dedup, asset 在目标项目新建
 */
export function importElementFrom(
  toSlug: string,
  body: { from_slug: string; element_id: string; name_override?: string },
) {
  return req<{
    ok: boolean;
    element: ElementData;
    copied_images: number;
    total_images: number;
    errors?: string[];
    source_series: string;
    source_element_id: string;
  }>(`/series/${toSlug}/elements/import-from`, {
    method: "POST",
    body: JSON.stringify(body),
    timeout: 120_000,
  });
}

// ─── CrossSeriesImportDialog 所用接口 (Task 1, 2026-05-19 #12) ──────

export interface ImportFromOtherSeriesRequest {
  from_slug: string;
  element_id: string;
  name_override?: string;
}

export interface ImportFromOtherSeriesResponse {
  element: ElementData;
  imported_from: { series_slug: string; element_id: string };
}

/**
 * 跨项目素材导入 — importElementFrom 的语义别名,供 CrossSeriesImportDialog 使用.
 * 后端同一端点: POST /api/v2/series/:toSlug/elements/import-from
 * 返回格式向 ImportFromOtherSeriesResponse 对齐 (前端映射).
 */
export async function importElementFromOtherSeries(
  toSlug: string,
  body: ImportFromOtherSeriesRequest,
): Promise<ImportFromOtherSeriesResponse> {
  const r = await importElementFrom(toSlug, body);
  return {
    element: r.element,
    imported_from: { series_slug: body.from_slug, element_id: body.element_id },
  };
}

/** 列出所有项目 (用于跨项目导入弹窗的"选项目"). */
export function listAllSeries() {
  return req<{ series: Array<{ slug: string; title: string; updated_at?: string }> }>(
    `/series`,
    { timeout: 30_000 },
  );
}

// ─── W3 (2026-05-26) — 同源素材 push/pull 同步 ─────────────────────

/** 一条派生关系: 别的项目里某 element 派生自当前 element. */
export interface DerivativeEntry {
  series_slug: string;
  series_title: string;
  element_id: string;
  element_name: string;
  element_kind: string;
  updated_at: string;
}

/** 反查"哪些项目/素材派生自我". */
export function listDerivatives(slug: string, elementId: string) {
  return req<{ derivatives: DerivativeEntry[] }>(
    `/series/${slug}/elements/${elementId}/derived`,
  );
}

/** 上游 diff 响应. */
export interface UpstreamDiffResponse {
  source: { series_slug: string; element_id: string; name: string; updated_at: string } | null;
  current_updated_at: string;
  diff: {
    description?: { from: string; to: string };
    tags?: { added: ElementTag[]; removed: ElementTag[] };
    primary_image_snapshot?: { from: string | null; to: string | null };
    image_briefs_count?: { from: number; to: number };
  } | null;
  reason?: string;
}

/** 取本地 vs 上游字段级 diff. 无上游或上游已同步时 diff=null. */
export function getUpstreamDiff(slug: string, elementId: string) {
  return req<UpstreamDiffResponse>(`/series/${slug}/elements/${elementId}/upstream-diff`);
}

/** push/pull 应用的字段集合. */
export type SyncField = "description" | "tags" | "primary_image" | "image_briefs";

/** 从上游拉用户勾选的字段到本地. 不删本地图. */
export function pullFromUpstream(slug: string, elementId: string, applyFields: SyncField[]) {
  return req<{ updated_fields: SyncField[]; element: ElementData }>(
    `/series/${slug}/elements/${elementId}/pull-from-upstream`,
    {
      method: "POST",
      body: JSON.stringify({ apply_fields: applyFields }),
    },
  );
}

/** 把本地版本推送到指定下游 (目标必须派生自当前素材). */
export function pushToDownstream(
  slug: string,
  elementId: string,
  targetSlug: string,
  targetElementId: string,
  applyFields: SyncField[],
) {
  return req<{ updated_fields: SyncField[] }>(
    `/series/${slug}/elements/${elementId}/push-to-downstream`,
    {
      method: "POST",
      body: JSON.stringify({
        target_slug: targetSlug,
        target_element_id: targetElementId,
        apply_fields: applyFields,
      }),
    },
  );
}

// ─── 图片: 导入 / 编译提示词 / 生图 / 主图 / 删图 ──────────────────

export async function importElementImage(
  slug: string,
  id: string,
  body: {
    image_base64: string;
    mime?: string;
    filename?: string;
    note?: string;
    display_name?: string;
    available_for_shot?: boolean;
  },
) {
  const r = await req<{ ok: boolean; element: ElementData; image: ElementImage }>(
    `/series/${slug}/elements/${id}/import-image`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

export async function patchElementImage(
  slug: string,
  id: string,
  imageId: string,
  patch: {
    display_name?: string;
    available_for_shot?: boolean;
    is_typical?: boolean;
    /** 2026-05-26 W2 — 维度标签 (pose/expression/outfit/lighting/free). */
    image_tags?: ImageTag[];
  },
) {
  const r = await req<{ ok: boolean; element: ElementData }>(
    `/series/${slug}/elements/${id}/images/${imageId}`,
    { method: "PATCH", body: JSON.stringify(patch), timeout: 30_000 },
  );
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

/**
 * 2026-05-18 三池模型批量端点 wrapper.
 * 一次性把 N 张图全部标 is_typical (+ available_for_shot) 一致状态.
 * UI 场景: 用户在 ElementImageGrid 多选 N 张 → 一次点"批量标为典型" / "批量移出真池".
 */
export async function batchSetElementImagesPoolState(
  slug: string,
  id: string,
  body: { image_ids: string[]; is_typical?: boolean; available_for_shot?: boolean },
) {
  const r = await req<{ ok: boolean; element: ElementData; updated_count: number }>(
    `/series/${slug}/elements/${id}/images/batch-pool-state`,
    { method: "POST", body: JSON.stringify(body), timeout: 30_000 },
  );
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

export function compileElementPrompt(
  slug: string,
  id: string,
  body: {
    user_instruction?: string;
    i2i_base_image_id?: string;
    llm_model_ref?: string;
    polish?: boolean;
    aspect_hint?: string;
    extra_negative?: string;
  },
) {
  return req<CompiledPrompt & { ok: boolean }>(`/series/${slug}/elements/${id}/compile-prompt`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── 2026-05-19 反馈 #2: LLM 智能填表 ─────────────────────────────
//
// 用户原话:"素材创作界面也要允许做一个基于用户输入生成角色详情 json 的功能"
// 设计:解耦 — 同一组 API 给两种调用方用:
//   1) ElementWorkbench 编辑既有素材 (直接拿 fields 走 patchElement)
//   2) 未来"新建素材"流程预填字段 (无 id, 走 kind 参数)
// "复制完整提示词" 走 preview-prompt 端点, 与真发送的 prompt 一字不差.

export interface AutofillElementResponse {
  ok: boolean;
  /** 字段名 → LLM 解析出的字符串值, 用户没提到的填空字符串 */
  fields: Record<string, string>;
  /** LLM 实际命中的 provider (fallback 后真值) */
  provider_id: string;
  /** LLM 原始文本回复 (debug 用) */
  raw_llm_output: string;
  /** 完整提示词 (system + user 拼好), 给 "复制完整提示词" 按钮 */
  prompt_used: string;
}

/** AI 一键填字段 — 把用户自然语言描述发给 LLM 解析出结构化字段. */
export function autofillElementFromText(
  slug: string,
  elementKind: ElementKind,
  body: {
    raw_text: string;
    model_ref?: string;
  },
) {
  return req<AutofillElementResponse>(
    `/series/${slug}/elements/${encodeURIComponent(elementKind)}/autofill-from-text`,
    {
      method: "POST",
      body: JSON.stringify(body),
      timeout: 90_000,
    },
  );
}

export interface AutofillPromptPreviewResponse {
  ok: boolean;
  system: string;
  user: string;
  /** "[SYSTEM]\n...\n\n[USER]\n..." 拼好字符串, 直接给 "复制完整提示词" 按钮 */
  combined: string;
}

/** 零成本预览 autofill 提示词 — 不调 LLM, 用于"复制完整提示词"按钮走外部 AI 后再手动导入. */
export function previewAutofillPrompt(slug: string, elementKind: ElementKind, rawText: string) {
  const qs = new URLSearchParams({ raw_text: rawText }).toString();
  return req<AutofillPromptPreviewResponse>(
    `/series/${slug}/elements/${encodeURIComponent(elementKind)}/autofill-from-text/preview-prompt?${qs}`,
    { timeout: 15_000 },
  );
}

export async function generateElementImage(
  slug: string,
  id: string,
  body: {
    full_prompt: string;
    negative_prompt?: string;
    image_model_ref?: string;
    count?: number;
    i2i_base_image_id?: string;
    width?: number;
    height?: number;
  },
) {
  const r = await req<{
    ok: boolean;
    provider_id: string;
    images: ElementImage[];
    element: ElementData;
    prompt_snapshot: string;
  }>(`/series/${slug}/elements/${id}/generate-image`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

export interface ImageDryRunResponse {
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
  error?: "key_missing";
}

/** dry-run 预览生图 (批次 4.3): 不调 provider, 返回 request_preview + 估费. */
export function dryRunElementImage(
  slug: string,
  id: string,
  body: {
    full_prompt?: string;
    negative_prompt?: string;
    image_model_ref?: string;
    count?: number;
    i2i_base_image_id?: string;
    width?: number;
    height?: number;
  },
) {
  return req<ImageDryRunResponse>(
    `/series/${slug}/elements/${id}/generate-image/dry-run`,
    { method: "POST", body: JSON.stringify(body), timeout: 30_000 },
  );
}

export async function setPrimaryImage(slug: string, id: string, imageId: string) {
  const r = await req<{ ok: boolean; element: ElementData }>(
    `/series/${slug}/elements/${id}/images/${imageId}/set-primary`,
    { method: "POST" },
  );
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

/** 取消主图锚定 — 图片保留, 仅清空 primary_image_id (铁律 #6). */
export async function clearPrimaryImage(slug: string, id: string) {
  const r = await req<{ ok: boolean; element: ElementData }>(
    `/series/${slug}/elements/${id}/clear-primary`,
    { method: "POST" },
  );
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

export async function deleteElementImage(slug: string, id: string, imageId: string) {
  const r = await req<{ ok: boolean; element: ElementData }>(
    `/series/${slug}/elements/${id}/images/${imageId}`,
    { method: "DELETE" },
  );
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

// ─── 三级废案库 ─────────────────────────────────────────────────────

export async function rejectElementImage(slug: string, id: string, imageId: string) {
  const r = await req<{ ok: boolean; element: ElementData; rejected_vault_id: string }>(
    `/series/${slug}/elements/${id}/reject`,
    { method: "POST", body: JSON.stringify({ image_id: imageId }) },
  );
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

export function listRejects(opts: { tier: "element" | "project" | "public"; slug?: string; element_id?: string }) {
  const params = new URLSearchParams({ tier: opts.tier });
  if (opts.slug) params.set("slug", opts.slug);
  if (opts.element_id) params.set("element_id", opts.element_id);
  return req<{ items: RejectItem[] }>(`/reject?${params.toString()}`, { timeout: 30_000 });
}

export function promoteReject(body: { vault_id: string; to: "project" | "public"; slug?: string }) {
  return req<{ ok: boolean }>(`/reject/promote`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * 2026-05-16 五件 UX: 废案库"彻底清理"按钮的真实落点.
 *
 * 路由走 POST /api/v2/vault/:id/trash — 真把归档条目移入 vault 内置回收站 (90 天后系统清掉文件),
 * 不直接物理删除文件 (项目 design principle #1 付费资产永不删除红线).
 *
 * UI 文案对用户说"彻底清理 (90 天后自动删源文件)" — 符合用户原话"彻底删除", 又留 90 天反悔窗口.
 */
export function trashRejectVaultEntry(vaultId: string, reason?: string) {
  return req<{ ok: boolean }>(`/vault/${encodeURIComponent(vaultId)}/trash`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? "user_purge_from_reject_pool" }),
    timeout: 30_000,
  });
}

export async function importRejectToElement(slug: string, id: string, vaultId: string) {
  const r = await req<{ ok: boolean; element: ElementData; image: ElementImage }>(
    `/series/${slug}/elements/${id}/reject/import`,
    { method: "POST", body: JSON.stringify({ vault_id: vaultId }) },
  );
  return { ...r, element: decorateImagesWithAngles(r.element) };
}

// ─── W8-A: 角色一致性体检 ─────────────────────────────────────────────
//
// 后端端点: GET /api/v2/series/:slug/characters/:charId/consistency-check?threshold=0.65
// 返回 packages/drama/src/consistency/consistencyCheck.ts 的 ConsistencyReport.
//
// 注:Element 概念里的「角色」(kind=character) 通过 elementController 适配到 characterRepo,
// 这里前端用 elementId 当 charId 调用. UI 文案不出现「cosine」「相似度 0.73」「CLIP」
// 等技术词,只展示 0-100 百分比和「相似 / 漂移」二元色彩(铁律 #9 toC 兜底).
//
// drift_threshold 默认 0.65(任务规约). UI 展示百分比 65%.

/** 单对图片的相似度记录 — 与后端 PairwiseSimilarity 同形,但 UI 层不使用 method 字段. */
export interface ConsistencyPair {
  asset_a_id: string;
  asset_b_id: string;
  /** 0-1 区间内部数值 — UI 只取 *100 显示百分比,不暴露原值. */
  similarity: number;
  method?: string;
}

export interface ConsistencyDriftWarning {
  asset_a_id: string;
  asset_b_id: string;
  similarity: number;
  message: string;
}

export interface ConsistencyReport {
  status: "evaluated" | "insufficient_assets";
  method?: string;
  character_id: string;
  checked_at: string;
  total_assets: number;
  avg_similarity: number | null;
  min_similarity: number | null;
  max_similarity: number | null;
  drift_count: number;
  drift_threshold: number;
  pairs: ConsistencyPair[];
  scatter_data: Array<{
    x: number;
    y: number;
    value: number;
    is_drift: boolean;
    asset_a_id: string;
    asset_b_id: string;
    method?: string;
  }>;
  drift_warnings: ConsistencyDriftWarning[];
}

/**
 * 调用一致性体检后端.
 * 仅 kind=character 的素材有意义(scene/prop/wardrobe/reference 不走这条路径).
 *
 * @param slug 项目 slug
 * @param charId 角色 element id(elementController 已把 character 适配过)
 * @param threshold 漂移阈值,默认 0.65 — UI 文案不暴露此值,只展示百分比
 */
export function getConsistencyCheck(slug: string, charId: string, threshold: number = 0.65) {
  const q = `?threshold=${encodeURIComponent(String(threshold))}`;
  return req<{ report: ConsistencyReport }>(
    `/series/${slug}/characters/${charId}/consistency-check${q}`,
    { timeout: 120_000 },
  );
}

// ─── 工具: File → base64 (本地导入用, 浏览器原生文件选择器) ─────────

export { fileToBase64 } from "./fileBase64";

export const ELEMENT_KIND_LABEL: Record<ElementKind, string> = {
  character: "角色",
  scene: "场景",
  prop: "物品",
  wardrobe: "服装造型",
  reference: "参考照片",
  misc: "杂物",
};

export function displayNameOfImage(image: Pick<ElementImage, "display_name" | "note" | "image_id">): string {
  // 2026-05-20 Wave T — 不返回 image_id(文件名 hash 看着丑且无意义).
  // caller 应传 fallback prop(例如 "{element.name} #{N}").没传时兜底"未命名图片".
  return image.display_name?.trim() || image.note?.trim() || "未命名图片";
}

export function cardAspectByKind(kind: ElementKind): string {
  if (kind === "character" || kind === "wardrobe") return "aspect-[3/4]";
  if (kind === "scene") return "aspect-video";
  return "aspect-square";
}

export function aspectRatioByKind(kind: ElementKind | "reject"): string {
  if (kind === "scene") return "16 / 9";
  if (kind === "character" || kind === "wardrobe") return "3 / 4";
  return "1 / 1";
}
