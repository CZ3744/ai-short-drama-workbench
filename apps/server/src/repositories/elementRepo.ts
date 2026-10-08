/**
 * elementRepo — 统一「素材元素 (Element)」聚合根仓储.
 *
 * 设计见 docs/ASSET_MANAGEMENT_REDESIGN.md §1 §2 §3.1.
 *
 * 一个 Element = 角色 / 场景 / 物品 / 服装 / 参考照片 里的「一个独立小单元」,
 * 用同一套方法管理 (名称 / 描述 / 多图 / 标签 / 主图锁定). 类别只是 `kind` 字段.
 *
 * 落盘: data/series/<slug>/elements/<id>.json , 与 characterRepo / sceneRepo 同构.
 *
 * 过渡策略 (见设计文档 §3.1): 本仓储只服务 kind = prop|wardrobe|reference 这些
 * 「新类别」. kind = character|scene 由 elementController 适配到现有
 * characterRepo / sceneRepo, 不在这里重复存储. 后续可把 character/scene 真正并入,
 * 那是纯后端内部重构, 前端零感知.
 *
 * 类型来自 packages/drama/src/types.ts, 本文件 re-export 保持下游 import 不破.
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
import { readSeries } from "../api/v2/seriesStore";
import { seriesFile } from "./_paths";
import {
  softDeleteItem,
  listTrashedItems,
  restoreTrashedItemToFreeSlot,
  permanentDeleteTrashedItem,
  listTrashReservedIds,
  type TrashedItemEntry,
} from "./_softDeleteHelper";
import type {
  ElementData,
  ElementImage,
  ElementKind,
  ElementTag,
  ImageBrief,
} from "../../../../packages/drama/src/types";

// ─── 类型契约 (单一数据源, 见设计文档 §2.1) ─────────────────────────

export type { ElementData, ElementImage, ElementKind, ElementTag, ImageBrief };

/** elementRepo 本体只负责这些「新类别」; character/scene 走旧 repo + 适配器 */
export const ELEMENT_REPO_KINDS: ElementKind[] = ["prop", "wardrobe", "reference", "misc"];

// ─── 私有 helpers ───────────────────────────────────────────────────

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

// ─── 路径 (inline, 避免改 _paths.ts) ────────────────────────────────

function elementsDir(slug: string): string {
  return path.join(DATA_ROOT, "series", slug, "elements");
}

function elementFile(slug: string, id: string): string {
  return path.join(elementsDir(slug), `${id}.json`);
}

function deriveStatus(el: ElementData): ElementData["status"] {
  if (el.primary_image_id) return "locked";
  if (el.images.length > 0) return "has_images";
  return "drafted";
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function listElements(
  slug: string,
  opts?: { kind?: ElementKind },
): Promise<ElementData[]> {
  const dir = elementsDir(slug);
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  const results: ElementData[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const item = await readJson<ElementData>(path.join(dir, entry));
      if (item && (!opts?.kind || item.kind === opts.kind)) results.push(item);
    } catch {
      /* skip corrupt */
    }
  }
  return results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function readElement(
  slug: string,
  id: string,
): Promise<ElementData | null> {
  const f = elementFile(slug, id);
  if (!(await pathExists(f))) return null;
  return readJson<ElementData>(f);
}

export async function createElement(
  slug: string,
  input: {
    kind: ElementKind;
    name: string;
    description?: string;
    tags?: ElementTag[];
    attrs?: Record<string, unknown>;
    derived_from?: ElementData["derived_from"];
    /** 2026-05-19 #8: LLM 规划的「需要几张图」列表(可选) */
    image_briefs?: ImageBrief[];
    /** 2026-05-20 P2: 是否为 LLM 自动占位素材 */
    is_placeholder?: boolean;
  },
): Promise<ElementData> {
  const baseId = slugify(input.name, { maxLen: 60, fallbackPrefix: "el" });
  // 防撞: 同 slug 已存在则加后缀
  // 2026-07-22 X6-4 (A3-2): 同 kind 回收站占用的 id 也避让, 防新素材继承被删素材身份 (串味)。
  const reservedElementIds = await listTrashReservedIds(slug, "element");
  let id = baseId;
  let n = 1;
  while ((await pathExists(elementFile(slug, id))) || reservedElementIds.has(id)) {
    id = `${baseId}-${++n}`;
  }
  const now = nowISO();
  const data: ElementData = {
    id,
    series_slug: slug,
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
    image_briefs: input.image_briefs && input.image_briefs.length > 0 ? input.image_briefs : undefined,
    ...(input.is_placeholder ? { is_placeholder: true } : {}),
  };
  await ensureDir(elementsDir(slug));
  await writeJson(elementFile(slug, id), data);
  return data;
}

export async function updateElement(
  slug: string,
  id: string,
  patch: Partial<
    Pick<ElementData, "name" | "description" | "tags" | "attrs" | "primary_image_id" | "images" | "image_briefs" | "is_placeholder">
  >,
): Promise<ElementData | null> {
  return withWriteLock(elementFile(slug, id), async () => {
    const existing = await readElement(slug, id);
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
    merged.status = deriveStatus(merged);
    await writeJson(elementFile(slug, id), merged);
    return merged;
  });
}

export async function deleteElement(slug: string, id: string): Promise<boolean> {
  const f = elementFile(slug, id);
  if (!(await pathExists(f))) return false;
  // 铁律 #6: 数据保留 > 直接删除 — 软删到回收站，90 天可恢复
  const existing = await readElement(slug, id);
  const name = existing?.name ?? id;
  const trashId = await softDeleteItem(slug, "element", id, f, name);
  return trashId !== null;
}

// ─── 元素回收站 ──────────────────────────────────────────────────────

export type { TrashedItemEntry };

export async function listTrashedElements(slug: string): Promise<TrashedItemEntry[]> {
  return listTrashedItems(slug, "element");
}

export async function restoreTrashedElement(slug: string, trashId: string): Promise<string | null> {
  // 2026-07-22 X6-3 (A3-1): free-slot 恢复 + 内部 id 字段同步改写。element 无 series 聚合列表
  // (靠 readdir 枚举), 故直接返回落盘 id。旧实现只试一个 -restored 且返回原 id (与实际落盘不符,
  // 冲突时前端会拿到错 id 无法打开) —— 一并修正。
  return restoreTrashedItemToFreeSlot(slug, "element", trashId, (id) => elementFile(slug, id));
}

export async function permanentDeleteTrashedElement(slug: string, trashId: string): Promise<boolean> {
  return permanentDeleteTrashedItem(slug, trashId);
}

// ─── 图片管理 ───────────────────────────────────────────────────────

export async function addElementImage(
  slug: string,
  id: string,
  image: Omit<ElementImage, "image_id" | "created_at"> &
    Partial<Pick<ElementImage, "image_id" | "created_at">>,
): Promise<{ element: ElementData; image: ElementImage } | null> {
  return withWriteLock(elementFile(slug, id), async () => {
    const existing = await readElement(slug, id);
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
    merged.status = deriveStatus(merged);
    await writeJson(elementFile(slug, id), merged);
    return { element: merged, image: full };
  });
}

export async function removeElementImage(
  slug: string,
  id: string,
  imageId: string,
): Promise<ElementData | null> {
  return withWriteLock(elementFile(slug, id), async () => {
    const existing = await readElement(slug, id);
    if (!existing) return null;
    const images = existing.images.filter((im) => im.image_id !== imageId);
    const merged: ElementData = {
      ...existing,
      images,
      primary_image_id:
        existing.primary_image_id === imageId
          ? undefined
          : existing.primary_image_id,
      updated_at: nowISO(),
    };
    merged.status = deriveStatus(merged);
    await writeJson(elementFile(slug, id), merged);
    return merged;
  });
}

export async function patchElementImageMeta(
  slug: string,
  id: string,
  imageId: string,
  patch: Partial<Pick<ElementImage, "display_name" | "available_for_shot" | "is_typical" | "image_tags">>,
): Promise<ElementData | null> {
  return withWriteLock(elementFile(slug, id), async () => {
    const existing = await readElement(slug, id);
    if (!existing) return null;
    let touched = false;
    const images = existing.images.map((im) => {
      if (im.image_id !== imageId) return im;
      touched = true;
      // 2026-05-18 三池模型语义保障:
      // typical 必然 in_pool(典型属于真池子集) — 改 is_typical=true 时自动确保 available_for_shot=true.
      const merged = { ...im, ...patch };
      if (patch.is_typical === true) merged.available_for_shot = true;
      return merged;
    });
    if (!touched) return null;
    const next: ElementData = {
      ...existing,
      images,
      updated_at: nowISO(),
    };
    next.status = deriveStatus(next);
    await writeJson(elementFile(slug, id), next);
    return next;
  });
}

/**
 * 2026-05-18 三池模型批量晋升:把多张图一次性标 is_typical / available_for_shot.
 * UI 场景:用户在 ElementImageGrid 多选 N 张图 → 一次点"标为典型/加入真池"按钮.
 * 也支持降级(value=false).
 */
export async function setElementImagesPoolState(
  slug: string,
  id: string,
  imageIds: string[],
  patch: { is_typical?: boolean; available_for_shot?: boolean },
): Promise<ElementData | null> {
  return withWriteLock(elementFile(slug, id), async () => {
    const existing = await readElement(slug, id);
    if (!existing) return null;
    const idSet = new Set(imageIds);
    const images = existing.images.map((im) => {
      if (!idSet.has(im.image_id)) return im;
      const merged = { ...im, ...patch };
      // typical=true → 强制 available_for_shot=true (典型必属真池).
      if (patch.is_typical === true) merged.available_for_shot = true;
      // available_for_shot=false → 强制 is_typical=false (移出真池则不可能是典型).
      if (patch.available_for_shot === false) merged.is_typical = false;
      return merged;
    });
    const next: ElementData = {
      ...existing,
      images,
      updated_at: nowISO(),
    };
    next.status = deriveStatus(next);
    await writeJson(elementFile(slug, id), next);
    return next;
  });
}

export async function setPrimaryImage(
  slug: string,
  id: string,
  imageId: string | null,
): Promise<ElementData | null> {
  return withWriteLock(elementFile(slug, id), async () => {
    const existing = await readElement(slug, id);
    if (!existing) return null;
    // imageId=null 表示取消主图; imageId 有值时校验图片存在
    if (imageId !== null && !existing.images.some((im) => im.image_id === imageId)) return null;
    // 2026-05-18 三池模型:设置主图时同步标 is_typical=true(主图必然属于典型代表)
    // 防止用户设了主图但 implicitReferenceCollector 找不到 typical 图作 reference.
    const images = imageId
      ? existing.images.map((im) =>
          im.image_id === imageId ? { ...im, is_typical: true, available_for_shot: true } : im,
        )
      : existing.images;
    const next: ElementData = {
      ...existing,
      images,
      primary_image_id: imageId ?? undefined,
      updated_at: nowISO(),
    };
    next.status = deriveStatus(next);
    await writeJson(elementFile(slug, id), next);
    return next;
  });
}

/**
 * 2026-05-18 三池模型读取 helper:
 * 拿到一个 element 的「典型代表图集合」用于 implicitReferenceCollector / ReferencePicker 默认勾选.
 *
 * 回退策略 (向后兼容历史数据):
 * 1. 优先返回所有 is_typical=true 的图
 * 2. 如果一张都没有 → fallback 到 primary_image_id 指向的单张图
 * 3. 都没有 → 返回空数组 (不自动作 reference)
 */
export function resolveTypicalImages(element: ElementData): ElementImage[] {
  const typical = element.images.filter((im) => im.is_typical === true);
  if (typical.length > 0) return typical;
  if (element.primary_image_id) {
    const fallback = element.images.find((im) => im.image_id === element.primary_image_id);
    if (fallback) return [fallback];
  }
  return [];
}

/** 给 controller 用: 确认 series 存在 (创建 element 前校验) */
export async function seriesExists(slug: string): Promise<boolean> {
  if (!(await pathExists(seriesFile(slug)))) return false;
  const s = await readSeries(slug).catch(() => null);
  return !!s;
}
