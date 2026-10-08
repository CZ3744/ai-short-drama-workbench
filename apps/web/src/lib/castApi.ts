/**
 * castApi — Cast/IP 容器与跨系列 element 共享的前端 API 客户端 (W5 2026-05-26).
 *
 * 设计与后端 castController 对齐, 见 apps/server/src/api/v2/castController.ts.
 *
 * 设计原则 (UX 铁律):
 *   - 铁律 #2 可干预: getEffectiveElements 返回 _source 字段, 前端可显示「Cast/本剧」徽章
 *   - 铁律 #9 toC 兜底: 错误消息走后端 toC-friendly message (不暴露技术 id)
 *   - 严禁本地主动 timeout (铁律 1): 全部走 fetch 透传 caller signal
 *
 * 刻意独立成 file (不并入 elementApi.ts): Cast 是另一层抽象, 解耦. 后续改 Cast API 只动这文件.
 */

import type { ElementData, ElementImage, ElementKind, ElementTag, ImageTag } from "./elementApi";

const API_BASE = "/api/v2";

// ─── 类型 ──────────────────────────────────────────────────────────

/**
 * W6 (2026-05-26) — Cast 层角色语音资产 (跨 series 共享).
 * member_element_id 指向 cast member (kind=character); 一项一个角色.
 */
export interface CastVoiceAsset {
  member_element_id: string;
  /** "cast:<castId>:assets/voices/<filename>" 格式; undefined = 无样本 */
  voice_sample_vault_id?: string;
  /** TTS provider id → voice_id 字典 (例: { minimax_t2a: "xxx" }) */
  provider_voice_ids?: Record<string, string>;
  /** 情绪 → voice_id 映射 (default / crying / angry / cold / laugh ...) */
  voice_style_map?: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/** Cast/IP 容器 — 跨系列复用的角色/场景/服装/道具集合. */
export interface Cast {
  id: string;
  name: string;
  description?: string;
  /** Cast 内所有 element id (含全部 kind, 不分类). 后端维护. */
  member_element_ids: string[];
  /** W6: cast 层角色 voice 资产 (跨 series 共享) */
  voice_assets?: CastVoiceAsset[];
  created_at: string;
  updated_at: string;
  _deleted?: boolean;
  _deleted_at?: string;
}

/** W6: Cast Dashboard 后端聚合数据. */
export interface CastDashboardData {
  cast: CastWithUsage;
  series_count: number;
  total_episode_count: number;
  total_shot_count: number;
  total_seconds: number;
  series_summary: Array<{
    series_slug: string;
    series_title: string;
    episode_count: number;
    total_shot_count: number;
  }>;
  member_usage: Array<{
    member_element_id: string;
    member_name: string;
    member_kind: ElementKind;
    series_count: number;
    episode_count: number;
    shot_count: number;
    total_seconds: number;
    last_used_at: string | null;
  }>;
}

/** 列表接口附带的 Cast (含引用数, 后端给 referencing_series_count). */
export interface CastWithUsage extends Cast {
  /** 当前挂在这个 Cast 上的 series 数量 (用于 UI 显示"引用 N 部剧"). */
  referencing_series_count: number;
}

/** GET /series/:slug/effective-elements 返回的合并视图条目. */
export type EffectiveElement = ElementData & { _source: "cast" | "local" };

// ─── 通用 req helper (透传 caller signal, 不设本地 timeout) ───────────

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
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

// ─── Cast CRUD ───────────────────────────────────────────────────────

export function listCasts() {
  return req<{ casts: CastWithUsage[] }>(`/casts`);
}

export function readCast(castId: string) {
  return req<{ cast: CastWithUsage }>(`/casts/${encodeURIComponent(castId)}`);
}

export function createCast(input: { name: string; description?: string }) {
  return req<{ cast: Cast }>(`/casts`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function patchCast(castId: string, patch: { name?: string; description?: string }) {
  return req<{ cast: Cast }>(`/casts/${encodeURIComponent(castId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteCast(castId: string) {
  return req<{ ok: true; warnings?: string[] }>(`/casts/${encodeURIComponent(castId)}`, {
    method: "DELETE",
  });
}

/** 列全部已软删的 cast (回收站). */
export function listDeletedCasts() {
  return req<{ casts: CastWithUsage[] }>(`/casts/deleted`);
}

/** 恢复已软删的 cast. */
export function restoreCast(castId: string) {
  return req<{ cast: CastWithUsage }>(`/casts/${encodeURIComponent(castId)}/restore`, {
    method: "POST",
  });
}

// ─── Cast Members (素材) ─────────────────────────────────────────────

export function listCastElements(castId: string, opts?: { kind?: ElementKind }) {
  const q = opts?.kind ? `?kind=${encodeURIComponent(opts.kind)}` : "";
  return req<{ elements: ElementData[] }>(`/casts/${encodeURIComponent(castId)}/elements${q}`);
}

export function readCastElement(castId: string, elementId: string) {
  return req<{ element: ElementData }>(
    `/casts/${encodeURIComponent(castId)}/elements/${encodeURIComponent(elementId)}`,
  );
}

export function createCastElement(
  castId: string,
  input: {
    kind: ElementKind;
    name: string;
    description?: string;
    tags?: ElementTag[];
    attrs?: Record<string, unknown>;
  },
) {
  return req<{ element: ElementData }>(`/casts/${encodeURIComponent(castId)}/elements`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function patchCastElement(
  castId: string,
  elementId: string,
  patch: {
    name?: string;
    description?: string;
    tags?: ElementTag[];
    attrs?: Record<string, unknown>;
  },
) {
  return req<{ element: ElementData }>(
    `/casts/${encodeURIComponent(castId)}/elements/${encodeURIComponent(elementId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
}

// ─── Cast Member Images ──────────────────────────────────────────────

export function addCastElementImage(
  castId: string,
  elementId: string,
  body: Partial<ElementImage> & { origin: ElementImage["origin"] },
) {
  return req<{ element: ElementData; image: ElementImage }>(
    `/casts/${encodeURIComponent(castId)}/elements/${encodeURIComponent(elementId)}/images`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function patchCastElementImage(
  castId: string,
  elementId: string,
  imgId: string,
  patch: {
    display_name?: string;
    available_for_shot?: boolean;
    is_typical?: boolean;
    image_tags?: ImageTag[];
  },
) {
  return req<{ element: ElementData }>(
    `/casts/${encodeURIComponent(castId)}/elements/${encodeURIComponent(elementId)}/images/${encodeURIComponent(imgId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export function deleteCastElementImage(castId: string, elementId: string, imgId: string) {
  return req<{ element: ElementData }>(
    `/casts/${encodeURIComponent(castId)}/elements/${encodeURIComponent(elementId)}/images/${encodeURIComponent(imgId)}`,
    { method: "DELETE" },
  );
}

// ─── promote-from-series ────────────────────────────────────────────

/**
 * 把 series-local element 升级 (拷) 到 Cast.
 * 默认不删源 — 用户可自行清理 (UX 铁律 #6 数据保留).
 *
 * 当前后端仅支持 prop/wardrobe/reference/misc 4 类升级 (character/scene 走另一条路径).
 */
export function promoteSeriesElementToCast(
  castId: string,
  fromSlug: string,
  elementId: string,
  nameOverride?: string,
) {
  return req<{
    ok: true;
    element: ElementData;
    copied_images: number;
    total_images: number;
    errors?: string[];
    source_series: string;
    source_element_id: string;
    hint?: string;
  }>(`/casts/${encodeURIComponent(castId)}/elements/promote-from-series`, {
    method: "POST",
    body: JSON.stringify({
      from_slug: fromSlug,
      element_id: elementId,
      ...(nameOverride ? { name_override: nameOverride } : {}),
    }),
  });
}

// ─── Series 视角合并视图 ─────────────────────────────────────────────

/**
 * GET /series/:slug/effective-elements — Cast 成员 + 本剧专属合并视图.
 * 返 ElementData 列表, 每条带 _source: "cast" | "local" 让前端打来源徽章.
 */
export function getEffectiveElements(slug: string, opts?: { kind?: ElementKind }) {
  const q = opts?.kind ? `?kind=${encodeURIComponent(opts.kind)}` : "";
  return req<{ elements: EffectiveElement[] }>(
    `/series/${encodeURIComponent(slug)}/effective-elements${q}`,
  );
}

/**
 * PATCH /series/:slug/cast — 挂入/取消挂 Cast (老单组接口, 兼容用).
 * castId=null 取消挂 (本剧只保留 local 素材).
 */
export function patchSeriesCast(slug: string, castId: string | null) {
  return req<{ ok: true; series: { slug: string; cast_id: string | null; cast_ids: string[] } }>(
    `/series/${encodeURIComponent(slug)}/cast`,
    { method: "PATCH", body: JSON.stringify({ cast_id: castId }) },
  );
}

/**
 * W7: PATCH /series/:slug/cast-ids — 设置 series 加入的多个素材组.
 * castIds=[] 退出所有素材组.
 */
export function patchSeriesCastIds(slug: string, castIds: string[]) {
  return req<{ ok: true; series: { slug: string; cast_id: string | null; cast_ids: string[] } }>(
    `/series/${encodeURIComponent(slug)}/cast-ids`,
    { method: "PATCH", body: JSON.stringify({ cast_ids: castIds }) },
  );
}

/**
 * W7: 把 series local 素材共享到指定素材组列表.
 * castIds=[] 表示"全都取消" (按需走 DELETE /casts/:castId/elements/:elementId 单组移除).
 */
export function shareElementToGroups(slug: string, elementId: string, castIds: string[]) {
  return req<{
    ok: true;
    results: Array<{ cast_id: string; status: "added" | "already" | "error"; message?: string }>;
  }>(
    `/series/${encodeURIComponent(slug)}/elements/${encodeURIComponent(elementId)}/share-to-groups`,
    { method: "POST", body: JSON.stringify({ cast_ids: castIds }) },
  );
}

/** W7: 从素材组里移除该素材 (不影响 series local 同 id). */
export function removeCastElement(castId: string, elementId: string) {
  return req<{ ok: true }>(
    `/casts/${encodeURIComponent(castId)}/elements/${encodeURIComponent(elementId)}`,
    { method: "DELETE" },
  );
}

// ─── W6 (2026-05-26): Cast 层 Voice 资产 + Dashboard ────────────────

/**
 * 上传 cast member 的语音克隆样本 (multipart).
 * file 字段名固定 "file", 服务端从 req.file 取.
 * 返 voice_sample_vault_id ("cast:<castId>:assets/voices/...") + 更新后的 cast.
 */
export async function uploadCastVoiceSample(
  castId: string,
  memberElementId: string,
  file: File,
) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(
    `${API_BASE}/casts/${encodeURIComponent(castId)}/elements/${encodeURIComponent(memberElementId)}/voice-sample`,
    { method: "POST", body: form },
  );
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
  if (!res.ok) {
    throw new Error(json?.error?.message || `${res.status} ${res.statusText}`);
  }
  return json as { ok: true; voice_sample_vault_id: string; bytes: number; cast: Cast };
}

/**
 * 更新 voice 非样本字段 (provider_voice_ids / voice_style_map).
 * 字典传 {} 等同清空 (不增量合并, caller 自负拼接).
 */
export function patchCastVoice(
  castId: string,
  memberElementId: string,
  patch: {
    provider_voice_ids?: Record<string, string>;
    voice_style_map?: Record<string, string>;
  },
) {
  return req<{ ok: true; cast: Cast }>(
    `/casts/${encodeURIComponent(castId)}/elements/${encodeURIComponent(memberElementId)}/voice`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

/** 删除整个 voice asset 项 (含 cast-local sample 文件). */
export function removeCastVoice(castId: string, memberElementId: string) {
  return req<{ ok: true; cast: Cast }>(
    `/casts/${encodeURIComponent(castId)}/elements/${encodeURIComponent(memberElementId)}/voice`,
    { method: "DELETE" },
  );
}

/** Cast 跨剧 IP 台账 — series 引用 / 集 / 镜 / member 用量聚合. */
export function readCastDashboard(castId: string) {
  return req<CastDashboardData>(`/casts/${encodeURIComponent(castId)}/dashboard`);
}
