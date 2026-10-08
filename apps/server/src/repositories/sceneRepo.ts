/**
 * Scene repository — extracted from seriesStore.ts (step 1: 按聚合根拆上帝模块).
 * 零行为变更, 逐字搬运.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT, pathExists, readJson, writeJson, ensureDir, slugify } from "../../../../packages/core/src/index";
import { loggerSync } from "../../../../packages/core/src/logger";
import { readSeries } from "../api/v2/seriesStore";
import type { SeriesVariant } from "./characterRepo";
import {
  seriesFile,
  sceneFile,
  scenesDir,
  sceneVariantDir,
  sceneVariantPath,
} from "./_paths";
import {
  softDeleteItem,
  listTrashedItems,
  restoreTrashedItemToFreeSlot,
  permanentDeleteTrashedItem,
  listTrashReservedIds,
  type TrashedItemEntry,
} from "./_softDeleteHelper";
import { withWriteLock, newId, nowISO } from "./_repoCommons";

// ─── Import from Library helpers ─────────────────────────────────

/**
 * Import a scene from the global library into a series.
 * Reads meta.json + locked.png from data/library/scenes/<id>/
 * and creates a scene entry in the target series.
 */
export async function importSceneFromLibrary(slug: string, libraryId: string): Promise<any> {
  const libraryMetaPath = path.join(DATA_ROOT, "library", "scenes", libraryId, "meta.json");
  if (!(await pathExists(libraryMetaPath))) {
    loggerSync().warn(`[importSceneFromLibrary] 资源库场景 ${libraryId} 的 meta.json 不存在`);
    return null;
  }

  const meta = await readJson<any>(libraryMetaPath);
  const lockedPngPath = path.join(DATA_ROOT, "library", "scenes", libraryId, "locked.png");
  const hasLocked = await pathExists(lockedPngPath);

  const sceneName = meta.name || libraryId;
  const scene = await createScene(slug, {
    name: sceneName,
    description: meta.description,
    visual_style: meta.visual_style,
    location: meta.location,
    time_of_day: meta.time_of_day,
    mood: meta.mood,
    library_id: libraryId,
    locked_image_path: hasLocked ? lockedPngPath : undefined,
  });

  // Copy locked.png to series assets/images/
  if (hasLocked) {
    const assetsImgDir = path.join(DATA_ROOT, "series", slug, "assets", "images");
    await ensureDir(assetsImgDir);
    const destPath = path.join(assetsImgDir, `scene_${libraryId}_locked.png`);
    try {
      await fs.copyFile(lockedPngPath, destPath);
    } catch (err: unknown) {
      loggerSync().warn(`[importSceneFromLibrary] 拷贝 locked.png 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return scene;
}

// ─── Series Scene Variants ──────────────────────────────────────

/**
 * 2026-05-20 display_name 体系统一: 读老数据时把 user_note 兜底映射为 display_name.
 */
function migrateSceneVariantUserNote(v: SeriesVariant): SeriesVariant {
  if (v.display_name) return v;
  if (v.user_note !== undefined) return { ...v, display_name: v.user_note };
  return { ...v, display_name: "" };
}

export async function listSeriesSceneVariants(slug: string, sceneId: string): Promise<SeriesVariant[]> {
  const vDir = sceneVariantDir(slug, sceneId);
  if (!(await pathExists(vDir))) return [];
  const entries = await fs.readdir(vDir);
  const results: SeriesVariant[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try { const item = await readJson<SeriesVariant>(path.join(vDir, entry)); if (item) results.push(migrateSceneVariantUserNote(item)); } catch { /* skip */ }
  }
  return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function createSeriesSceneVariant(
  slug: string,
  sceneId: string,
  // 2026-05-20: 入参兼容老的 user_note, 内部统一存 display_name
  input: { label: string; category: SeriesVariant["category"]; source_vault_id?: string; display_name?: string; user_note?: string },
): Promise<SeriesVariant> {
  const varId = newId();
  const now = nowISO();
  const variant: SeriesVariant = {
    id: varId,
    label: input.label,
    category: input.category,
    vault_id: input.source_vault_id ?? "",
    parent: "locked",
    display_name: input.display_name ?? input.user_note ?? "",
    created_at: now,
  };
  await ensureDir(sceneVariantDir(slug, sceneId));
  await writeJson(sceneVariantPath(slug, sceneId, varId), variant);
  return variant;
}

export async function deleteSeriesSceneVariant(slug: string, sceneId: string, varId: string): Promise<boolean> {
  const vp = sceneVariantPath(slug, sceneId, varId);
  if (!(await pathExists(vp))) return false;
  await fs.unlink(vp);
  return true;
}

// ─── Scene CRUD ─────────────────────────────────────────────────

export interface SceneData {
  id: string;
  series_slug: string;
  name: string;
  description?: string;
  visual_style?: string;
  location?: string;
  time_of_day?: string;
  mood?: string;
  ref_image_ids?: string[];
  /**
   * Per-image metadata 字典 (key = asset_id)。
   * 同 drama/types.ts Scene.ref_image_meta，保存 prompt_snapshot / provider_id 等。
   */
  ref_image_meta?: Record<string, {
    prompt_snapshot?: string;
    provider_id?: string;
    seed?: number;
    origin?: "generated" | "i2i" | "imported";
    based_on_image_id?: string;
    created_at?: string;
  }>;
  primary_ref_image_id?: string;
  locked?: Record<string, any>;
  status?: string;
  library_id?: string;
  locked_image_path?: string;

  // ── Wave 2E 一致性三件套 ─────────────────────────────────────
  /** 多角度参考图 vault id 列表 */
  reference_image_set?: string[];
  /** 锁定 seed */
  locked_seed?: number;
  /** style_prompt 指纹 (hex hash) */
  style_prompt_fingerprint?: string;

  /** 派生来源 (从其他系列场景跨项目导入时记录) */
  derived_from?: {
    series_slug: string;
    element_id: string;
  };
  /**
   * 2026-05-19 #8: LLM 规划的「需要几张图」列表(可选),
   * 由 batchSeries 写入, autoPipelineRunner.runElementImagesStage 消费.
   */
  image_briefs?: import("../../../../packages/drama/src/types").ImageBrief[];
  /**
   * 2026-05-20 P2: 是否为 LLM 拆分镜时自动建的占位场景.
   * 替代 fragile 的 description === "auto-extracted placeholder" 字符串判断.
   */
  is_placeholder?: boolean;
}

export async function listScenes(slug: string): Promise<SceneData[]> {
  const sd = scenesDir(slug);
  if (!(await pathExists(sd))) return [];
  const entries = await fs.readdir(sd);
  const results: SceneData[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try { const item = await readJson<SceneData>(path.join(sd, entry)); if (item) results.push(item); } catch { /* skip */ }
  }
  return results;
}

export async function readScene(slug: string, sceneId: string): Promise<SceneData | null> {
  const sf = sceneFile(slug, sceneId);
  if (!(await pathExists(sf))) return null;
  return readJson<SceneData>(sf);
}

export async function createScene(slug: string, input: { name: string; description?: string; visual_style?: string; location?: string; time_of_day?: string; mood?: string; library_id?: string; locked_image_path?: string; /** 2026-05-20 P2: 是否为 LLM 自动占位场景 */ is_placeholder?: boolean }): Promise<SceneData> {
  // 2026-05-21 — id 唯一性防御 (跟 characterRepo / series.uniqueSlug 同款): 已存在加 -2/-3 后缀, 不覆盖.
  const baseSceneId = slugify(input.name);
  let sceneId = baseSceneId;
  let suffix = 2;
  await ensureDir(scenesDir(slug));
  // 2026-07-22 X6-4 (A3-2): 同 kind 回收站占用的 id 也避让, 防新场景继承被删场景身份 (串味)。
  const reservedSceneIds = await listTrashReservedIds(slug, "scene");
  while ((await pathExists(sceneFile(slug, sceneId))) || reservedSceneIds.has(sceneId)) {
    sceneId = `${baseSceneId}-${suffix}`;
    suffix++;
  }
  const data: SceneData = {
    id: sceneId,
    series_slug: slug,
    name: input.name,
    description: input.description,
    visual_style: input.visual_style,
    location: input.location,
    time_of_day: input.time_of_day,
    mood: input.mood,
    ref_image_ids: [],
    status: "drafted",
    library_id: input.library_id,
    locked_image_path: input.locked_image_path,
    ...(input.is_placeholder ? { is_placeholder: true } : {}),
  };
  await writeJson(sceneFile(slug, sceneId), data);
  const series = await readSeries(slug);
  if (series) {
    series.scene_ids.push(sceneId);
    series.updated_at = nowISO();
    await writeJson(seriesFile(slug), series);
  }
  return data;
}

export async function updateScene(slug: string, sceneId: string, patch: Partial<SceneData>): Promise<SceneData | null> {
  return withWriteLock(sceneFile(slug, sceneId), async () => {
    const existing = await readScene(slug, sceneId);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id: existing.id, series_slug: existing.series_slug };
    await writeJson(sceneFile(slug, sceneId), updated);
    return updated;
  });
}

export async function deleteScene(slug: string, sceneId: string): Promise<boolean> {
  const sf = sceneFile(slug, sceneId);
  if (!(await pathExists(sf))) return false;
  // 铁律 #6: 数据保留 > 直接删除 — 软删到回收站，90 天可恢复
  const existing = await readScene(slug, sceneId);
  const name = existing?.name ?? sceneId;
  const trashId = await softDeleteItem(slug, "scene", sceneId, sf, name);
  if (trashId === null) return false;
  // 从 series.scene_ids 移除引用（保持聚合一致性）
  const series = await readSeries(slug);
  if (series) {
    series.scene_ids = series.scene_ids.filter(s => s !== sceneId);
    series.updated_at = nowISO();
    await writeJson(seriesFile(slug), series);
  }
  return true;
}

// ─── 场景回收站 ──────────────────────────────────────────────────────

export type { TrashedItemEntry };

export async function listTrashedScenes(slug: string): Promise<TrashedItemEntry[]> {
  return listTrashedItems(slug, "scene");
}

export async function restoreTrashedScene(slug: string, trashId: string): Promise<string | null> {
  // 2026-07-22 X6-3 (A3-1): free-slot 恢复 + 内部 id 字段同步改写 (同 restoreTrashedCharacter)。
  const finalId = await restoreTrashedItemToFreeSlot(slug, "scene", trashId, (id) => sceneFile(slug, id));
  if (!finalId) return null;
  // 恢复时把**实际落盘 id** 加回 series.scene_ids
  const series = await readSeries(slug);
  if (series && !series.scene_ids.includes(finalId)) {
    series.scene_ids.push(finalId);
    series.updated_at = nowISO();
    await writeJson(seriesFile(slug), series);
  }
  return finalId;
}

export async function permanentDeleteTrashedScene(slug: string, trashId: string): Promise<boolean> {
  return permanentDeleteTrashedItem(slug, trashId);
}
