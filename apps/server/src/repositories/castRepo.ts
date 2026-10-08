/**
 * castRepo — 跨系列 IP 角色阵容容器仓储 (W4 2026-05-26).
 *
 * 设计见 packages/drama/src/types.ts §Cast 段头注释.
 *
 * 落盘结构 (与 elementRepo 同构, 复用 ElementData 模型, 不再走 character/scene legacy):
 *   data/casts/<cast_id>/cast.json                          ← Cast 主记录
 *   data/casts/<cast_id>/elements/<element_id>.json         ← 主拷贝 ElementData
 *
 * 与 elementRepo 区别:
 *   - elementRepo 写 data/series/<slug>/elements/* (series 本地)
 *   - castRepo    写 data/casts/<cast_id>/elements/* (跨 series 共享)
 *
 * 同 series 视角的 element 合并语义见 application/cast/effectiveElements.ts:
 *   cast.elements ∪ series local elements, 同 id 时 local 覆盖上游.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  DATA_ROOT,
  pathExists,
  readJson,
  writeJson,
  ensureDir,
  slugify,
} from "../../../../packages/core/src/index";
import type {
  Cast,
  CastVoiceAsset,
  ElementData,
  ElementImage,
  ElementKind,
  ElementTag,
  ImageBrief,
} from "../../../../packages/drama/src/types";

// ─── 类型 re-export (downstream caller 可只 import 本 repo) ──────────
export type { Cast, CastVoiceAsset };

// ─── 私有 helpers ────────────────────────────────────────────────────

const _writeLocks = new Map<string, Promise<void>>();
function withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  _writeLocks.set(filePath, next);
  return prev.then(() => fn()).finally(() => release());
}

function nowISO(): string {
  return new Date().toISOString();
}

function newImageId(): string {
  return `img_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
}

function deriveElementStatus(el: ElementData): ElementData["status"] {
  if (el.primary_image_id) return "locked";
  if (el.images.length > 0) return "has_images";
  return "drafted";
}

// ─── 路径 ────────────────────────────────────────────────────────────

export const CASTS_ROOT = path.join(DATA_ROOT, "casts");

export function castDir(castId: string): string {
  return path.join(CASTS_ROOT, castId);
}

export function castFile(castId: string): string {
  return path.join(castDir(castId), "cast.json");
}

export function castElementsDir(castId: string): string {
  return path.join(castDir(castId), "elements");
}

export function castElementFile(castId: string, elementId: string): string {
  return path.join(castElementsDir(castId), `${elementId}.json`);
}

// ─── Cast CRUD ──────────────────────────────────────────────────────

/** 列全部 cast (不包含软删的). UI 在挂入选择器 / cast 管理页用. */
export async function listCasts(): Promise<Cast[]> {
  if (!(await pathExists(CASTS_ROOT))) return [];
  const entries = await fs.readdir(CASTS_ROOT);
  const results: Cast[] = [];
  for (const entry of entries) {
    const cf = castFile(entry);
    if (!(await pathExists(cf))) continue;
    try {
      const cast = await readJson<Cast>(cf);
      if (cast && !cast._deleted) results.push(cast);
    } catch {
      /* skip corrupt */
    }
  }
  return results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function readCast(castId: string): Promise<Cast | null> {
  const cf = castFile(castId);
  if (!(await pathExists(cf))) return null;
  const cast = await readJson<Cast>(cf);
  if (!cast || cast._deleted) return null;
  return cast;
}

/**
 * 创建 cast — id 默认用 slugify(name), 冲突时 -2/-3 后缀防撞.
 * 不写 series 引用 (那是 PATCH /series/:slug/cast 的事).
 */
export async function createCast(input: {
  name: string;
  description?: string;
}): Promise<Cast> {
  if (!input.name || !input.name.trim()) {
    throw new Error("cast name 必填");
  }
  const baseId = slugify(input.name, { maxLen: 60, fallbackPrefix: "cast" });
  let id = baseId;
  let n = 1;
  while (await pathExists(castDir(id))) {
    id = `${baseId}-${++n}`;
  }
  const now = nowISO();
  const cast: Cast = {
    id,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    created_at: now,
    updated_at: now,
    member_element_ids: [],
  };
  await ensureDir(castElementsDir(id));
  await writeJson(castFile(id), cast);
  return cast;
}

/** PATCH cast (改 name / description). 其他字段不可改 (id / created_at / member_element_ids 走专门 API). */
export async function updateCast(
  castId: string,
  patch: Partial<Pick<Cast, "name" | "description">>,
): Promise<Cast | null> {
  return withWriteLock(castFile(castId), async () => {
    const existing = await readCast(castId);
    if (!existing) return null;
    const merged: Cast = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description?.trim() || undefined }
        : {}),
      id: existing.id,
      created_at: existing.created_at,
      member_element_ids: existing.member_element_ids,
      updated_at: nowISO(),
    };
    await writeJson(castFile(castId), merged);
    return merged;
  });
}

/**
 * 软删 cast (不真擦盘, 走与 series 同模式的 _deleted 标记).
 * 反查 series.cast_id 留给上层 controller 兜底 (返 warning 给用户).
 */
export async function deleteCast(castId: string): Promise<boolean> {
  const cf = castFile(castId);
  if (!(await pathExists(cf))) return false;
  return withWriteLock(cf, async () => {
    const cast = await readJson<Cast>(cf);
    if (!cast) return false;
    if (cast._deleted) return true; // already deleted
    cast._deleted = true;
    cast._deleted_at = nowISO();
    cast.updated_at = nowISO();
    await writeJson(cf, cast);
    return true;
  });
}

/** 列全部已软删的 cast (回收站用). */
export async function listDeletedCasts(): Promise<Cast[]> {
  if (!(await pathExists(CASTS_ROOT))) return [];
  const entries = await fs.readdir(CASTS_ROOT);
  const results: Cast[] = [];
  for (const entry of entries) {
    const cf = castFile(entry);
    if (!(await pathExists(cf))) continue;
    try {
      const cast = await readJson<Cast>(cf);
      if (cast && cast._deleted) results.push(cast);
    } catch {
      /* skip corrupt */
    }
  }
  return results.sort((a, b) => (b._deleted_at ?? b.updated_at).localeCompare(a._deleted_at ?? a.updated_at));
}

/** 恢复已软删的 cast (清除 _deleted / _deleted_at 标记). */
export async function restoreCast(castId: string): Promise<Cast | null> {
  const cf = castFile(castId);
  if (!(await pathExists(cf))) return null;
  return withWriteLock(cf, async () => {
    const cast = await readJson<Cast>(cf);
    if (!cast || !cast._deleted) return null;
    cast._deleted = undefined;
    cast._deleted_at = undefined;
    cast.updated_at = nowISO();
    await writeJson(cf, cast);
    return cast;
  });
}

// ─── Cast Element CRUD (主拷贝, 跟 elementRepo 同模式) ───────────────

export async function listCastElements(
  castId: string,
  opts?: { kind?: ElementKind },
): Promise<ElementData[]> {
  const dir = castElementsDir(castId);
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  const results: ElementData[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const el = await readJson<ElementData>(path.join(dir, entry));
      if (el && (!opts?.kind || el.kind === opts.kind)) results.push(el);
    } catch {
      /* skip corrupt */
    }
  }
  return results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function readCastElement(
  castId: string,
  elementId: string,
): Promise<ElementData | null> {
  const f = castElementFile(castId, elementId);
  if (!(await pathExists(f))) return null;
  return readJson<ElementData>(f);
}

/**
 * 在 cast 直接建 element (新建场景: cast 管理页 / 接收 promote-from-series).
 *
 * 注意 series_slug 字段语义:
 *   ElementData 类型要求 series_slug 必填 (历史原因 — 老 elementRepo 强 1:1 绑 series).
 *   cast member 没有所属 series, 这里写一个 sentinel 字符串 "__cast__" 标识,
 *   caller / UI 看到 series_slug === "__cast__" 知道 "这是 cast member 不是 series local".
 *   effectiveElements 合并时会把 cast member 的 _source 标 "cast", series local 标 "local".
 */
export async function addCastMemberElement(
  castId: string,
  input: {
    kind: ElementKind;
    name: string;
    description?: string;
    tags?: ElementTag[];
    attrs?: Record<string, unknown>;
    derived_from?: ElementData["derived_from"];
    image_briefs?: ImageBrief[];
    is_placeholder?: boolean;
    /** 显式 id (promote-from-series 时保留原 id 利于 series-side 引用透明迁移) */
    id?: string;
  },
): Promise<ElementData> {
  if (!(await readCast(castId))) {
    throw new Error(`cast ${castId} 不存在`);
  }
  await ensureDir(castElementsDir(castId));

  // id 计算: 显式传 id 优先; 否则 slugify(name) + 冲突 -2/-3 防撞
  let id = input.id?.trim() || slugify(input.name, { maxLen: 60, fallbackPrefix: "el" });
  if (!input.id) {
    let n = 1;
    while (await pathExists(castElementFile(castId, id))) {
      id = `${slugify(input.name, { maxLen: 60, fallbackPrefix: "el" })}-${++n}`;
    }
  } else if (await pathExists(castElementFile(castId, id))) {
    throw new Error(`cast ${castId} 已存在 element ${id}`);
  }

  const now = nowISO();
  const data: ElementData = {
    id,
    series_slug: "__cast__",
    kind: input.kind,
    name: input.name,
    description: input.description ?? "",
    tags: input.tags ?? [],
    images: [],
    attrs: input.attrs ?? {},
    status: "drafted",
    created_at: now,
    updated_at: now,
    derived_from: input.derived_from,
    image_briefs:
      input.image_briefs && input.image_briefs.length > 0 ? input.image_briefs : undefined,
    ...(input.is_placeholder ? { is_placeholder: true } : {}),
  };
  await writeJson(castElementFile(castId, id), data);

  // 在 cast.member_element_ids 登记 (维护倒排索引便于审计)
  await withWriteLock(castFile(castId), async () => {
    const cast = await readCast(castId);
    if (!cast) return;
    if (!cast.member_element_ids.includes(id)) {
      cast.member_element_ids.push(id);
      cast.updated_at = nowISO();
      await writeJson(castFile(castId), cast);
    }
  });

  return data;
}

/** PATCH cast element (改 name / description / tags / attrs / primary_image_id / images / image_briefs / is_placeholder). */
export async function updateCastElement(
  castId: string,
  elementId: string,
  patch: Partial<
    Pick<
      ElementData,
      | "name"
      | "description"
      | "tags"
      | "attrs"
      | "primary_image_id"
      | "images"
      | "image_briefs"
      | "is_placeholder"
    >
  >,
): Promise<ElementData | null> {
  return withWriteLock(castElementFile(castId, elementId), async () => {
    const existing = await readCastElement(castId, elementId);
    if (!existing) return null;
    const merged: ElementData = {
      ...existing,
      ...patch,
      id: existing.id,
      series_slug: existing.series_slug,
      kind: existing.kind,
      created_at: existing.created_at,
      updated_at: nowISO(),
    };
    merged.status = deriveElementStatus(merged);
    await writeJson(castElementFile(castId, elementId), merged);
    return merged;
  });
}

/**
 * 软删 cast member (从 cast.member_element_ids 移除 + 在 element 文件标 _deleted-like).
 *
 * 这里没用 _trash 物理迁移, 因为 ElementData 类型本身没有 _deleted 字段 (是 Cast 才有).
 * 简化处理: 直接 unlink element 文件 + 从 member_element_ids 移除.
 * 如果未来要"软删 → 可恢复", 走 _softDeleteHelper 那条路径.
 */
export async function removeCastMemberElement(
  castId: string,
  elementId: string,
): Promise<boolean> {
  const f = castElementFile(castId, elementId);
  if (!(await pathExists(f))) return false;
  await fs.unlink(f);
  await withWriteLock(castFile(castId), async () => {
    const cast = await readCast(castId);
    if (!cast) return;
    const next = cast.member_element_ids.filter((id) => id !== elementId);
    if (next.length !== cast.member_element_ids.length) {
      cast.member_element_ids = next;
      cast.updated_at = nowISO();
      await writeJson(castFile(castId), cast);
    }
  });
  return true;
}

// ─── Cast Element Image 管理 (与 elementRepo 同模式, addImage/patch/remove/setPrimary) ──

export async function addCastElementImage(
  castId: string,
  elementId: string,
  image: Omit<ElementImage, "image_id" | "created_at"> &
    Partial<Pick<ElementImage, "image_id" | "created_at">>,
): Promise<{ element: ElementData; image: ElementImage } | null> {
  return withWriteLock(castElementFile(castId, elementId), async () => {
    const existing = await readCastElement(castId, elementId);
    if (!existing) return null;
    const full: ElementImage = {
      ...image,
      image_id: image.image_id ?? newImageId(),
      created_at: image.created_at ?? nowISO(),
    };
    const merged: ElementData = {
      ...existing,
      images: [...existing.images, full],
      updated_at: nowISO(),
    };
    merged.status = deriveElementStatus(merged);
    await writeJson(castElementFile(castId, elementId), merged);
    return { element: merged, image: full };
  });
}

export async function patchCastElementImageMeta(
  castId: string,
  elementId: string,
  imageId: string,
  patch: Partial<
    Pick<ElementImage, "display_name" | "available_for_shot" | "is_typical" | "image_tags">
  >,
): Promise<ElementData | null> {
  return withWriteLock(castElementFile(castId, elementId), async () => {
    const existing = await readCastElement(castId, elementId);
    if (!existing) return null;
    let touched = false;
    const images = existing.images.map((im) => {
      if (im.image_id !== imageId) return im;
      touched = true;
      const m = { ...im, ...patch };
      // 三池模型: typical=true → 强制 available_for_shot=true
      if (patch.is_typical === true) m.available_for_shot = true;
      // available_for_shot=false → 强制 is_typical=false
      if (patch.available_for_shot === false) m.is_typical = false;
      return m;
    });
    if (!touched) return null;
    const next: ElementData = { ...existing, images, updated_at: nowISO() };
    next.status = deriveElementStatus(next);
    await writeJson(castElementFile(castId, elementId), next);
    return next;
  });
}

export async function removeCastElementImage(
  castId: string,
  elementId: string,
  imageId: string,
): Promise<ElementData | null> {
  return withWriteLock(castElementFile(castId, elementId), async () => {
    const existing = await readCastElement(castId, elementId);
    if (!existing) return null;
    const images = existing.images.filter((im) => im.image_id !== imageId);
    const merged: ElementData = {
      ...existing,
      images,
      primary_image_id:
        existing.primary_image_id === imageId ? undefined : existing.primary_image_id,
      updated_at: nowISO(),
    };
    merged.status = deriveElementStatus(merged);
    await writeJson(castElementFile(castId, elementId), merged);
    return merged;
  });
}

export async function setCastElementPrimaryImage(
  castId: string,
  elementId: string,
  imageId: string | null,
): Promise<ElementData | null> {
  return withWriteLock(castElementFile(castId, elementId), async () => {
    const existing = await readCastElement(castId, elementId);
    if (!existing) return null;
    if (imageId !== null && !existing.images.some((im) => im.image_id === imageId)) return null;
    const images = imageId
      ? existing.images.map((im) =>
          im.image_id === imageId
            ? { ...im, is_typical: true, available_for_shot: true }
            : im,
        )
      : existing.images;
    const next: ElementData = {
      ...existing,
      images,
      primary_image_id: imageId ?? undefined,
      updated_at: nowISO(),
    };
    next.status = deriveElementStatus(next);
    await writeJson(castElementFile(castId, elementId), next);
    return next;
  });
}

/** 内部 util: 列出"哪些 cast 引用了这个 element" — 给反查 / 调试用. */
export async function listCastsContainingElement(
  elementId: string,
): Promise<Cast[]> {
  const casts = await listCasts();
  return casts.filter((c) => c.member_element_ids.includes(elementId));
}

// ─── Cast 角色 Voice 资产管理 (W6 2026-05-26 跨 series 复用) ─────────

/**
 * pure helper — 从已读出的 Cast 对象拿某角色的 voice asset (不读盘).
 *
 * 用例: tts.ts 解析 voice 时, 已经一次性 readCast 了, 复用对象不再 IO.
 * 找不到返 undefined (上层走 character.voice_* fallback).
 */
export function getCastMemberVoice(
  cast: Cast | null | undefined,
  memberElementId: string,
): CastVoiceAsset | undefined {
  if (!cast?.voice_assets || !memberElementId) return undefined;
  return cast.voice_assets.find((v) => v.member_element_id === memberElementId);
}

/**
 * 创建/更新 cast.voice_assets 数组中某角色的 voice 资产.
 *
 * patch 字段语义:
 *   - voice_sample_vault_id: 显式传 undefined / 空字符串 = 清除样本绑定 (不删 vault, 让 vault GC 后续处理)
 *   - provider_voice_ids: 显式传 {} = 清空字典; partial 不增量合并 (caller 自负拼接)
 *   - voice_style_map: 同上
 *
 * 不存在 member_element_id 不强校验 (cast 列表里没这个 member 仍允许写, 让 caller 决定),
 * 但 controller 层会校验该 member 存在 + kind=character.
 */
export async function setCastMemberVoice(
  castId: string,
  memberElementId: string,
  patch: Partial<Omit<CastVoiceAsset, "member_element_id" | "created_at" | "updated_at">>,
): Promise<Cast | null> {
  return withWriteLock(castFile(castId), async () => {
    const existing = await readCast(castId);
    if (!existing) return null;
    const now = nowISO();
    const arr = [...(existing.voice_assets ?? [])];
    const idx = arr.findIndex((v) => v.member_element_id === memberElementId);
    if (idx >= 0) {
      arr[idx] = {
        ...arr[idx],
        ...patch,
        member_element_id: memberElementId,
        updated_at: now,
      };
    } else {
      arr.push({
        member_element_id: memberElementId,
        voice_sample_vault_id: patch.voice_sample_vault_id,
        provider_voice_ids: patch.provider_voice_ids,
        voice_style_map: patch.voice_style_map,
        created_at: now,
        updated_at: now,
      });
    }
    const merged: Cast = {
      ...existing,
      voice_assets: arr,
      updated_at: now,
    };
    await writeJson(castFile(castId), merged);
    return merged;
  });
}

/**
 * 移除某 cast member 的 voice 资产.
 *
 * 注意: 不删 vault 中样本文件 — 多 cast/series 可能引用同一 vault_id (SHA-256 dedup),
 *       让 vault GC 在没人引用时统一清理.
 */
export async function removeCastMemberVoice(
  castId: string,
  memberElementId: string,
): Promise<Cast | null> {
  return withWriteLock(castFile(castId), async () => {
    const existing = await readCast(castId);
    if (!existing) return null;
    const arr = (existing.voice_assets ?? []).filter(
      (v) => v.member_element_id !== memberElementId,
    );
    const merged: Cast = {
      ...existing,
      voice_assets: arr.length > 0 ? arr : undefined,
      updated_at: nowISO(),
    };
    await writeJson(castFile(castId), merged);
    return merged;
  });
}
