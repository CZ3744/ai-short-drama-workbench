/**
 * Character repository — extracted from seriesStore.ts (step 1: 按聚合根拆上帝模块).
 * 零行为变更, 逐字搬运.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT, pathExists, readJson, writeJson, ensureDir, slugify } from "../../../../packages/core/src/index";
import { loggerSync } from "../../../../packages/core/src/logger";
import { readSeries } from "../api/v2/seriesStore";
import type { CharacterData } from "../../../../packages/drama/src/types";
import {
  seriesFile,
  characterFile,
  charactersDir,
  charVariantDir,
  charVariantPath,
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
 * Import a character from the global library into a series.
 * Reads meta.json + locked.png from data/library/characters/<id>/
 * and creates a character entry in the target series.
 */
export async function importCharacterFromLibrary(slug: string, libraryId: string): Promise<any> {
  const libraryMetaPath = path.join(DATA_ROOT, "library", "characters", libraryId, "meta.json");
  if (!(await pathExists(libraryMetaPath))) {
    loggerSync().warn(`[importCharacterFromLibrary] 资源库角色 ${libraryId} 的 meta.json 不存在`);
    return null;
  }

  const meta = await readJson<any>(libraryMetaPath);
  const lockedPngPath = path.join(DATA_ROOT, "library", "characters", libraryId, "locked.png");
  const hasLocked = await pathExists(lockedPngPath);

  const charName = meta.name || libraryId;
  // Wave B-3 (2026-05-16): 同步写 appearance / outfit 拆分字段(若 library meta 有则透传)
  const character = await createCharacter(slug, {
    name: charName,
    role: meta.personality || "导入角色",
    appearance_prompt: meta.appearance || "",
    appearance: meta.appearance || undefined,
    outfit: meta.outfit || undefined,
    personality: meta.personality || "",
    library_id: libraryId,
    locked_image_path: hasLocked ? lockedPngPath : undefined,
  });

  // Copy locked.png to series assets/images/
  if (hasLocked) {
    const assetsImgDir = path.join(DATA_ROOT, "series", slug, "assets", "images");
    await ensureDir(assetsImgDir);
    const destPath = path.join(assetsImgDir, `char_${libraryId}_locked.png`);
    try {
      await fs.copyFile(lockedPngPath, destPath);
    } catch (err: unknown) {
      loggerSync().warn(`[importCharacterFromLibrary] 拷贝 locked.png 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return character;
}

// ─── Character CRUD ─────────────────────────────────────────────

// Step2: CharacterData 单源化到 packages/drama/src/types.ts。re-export 保持下游 import 不破。
export type { CharacterData };

// D-N1: 同 listEpisodes — 加分页 cap.
export async function listCharacters(
  slug: string,
  opts?: { limit?: number; offset?: number },
): Promise<CharacterData[]> {
  const cd = charactersDir(slug);
  if (!(await pathExists(cd))) return [];
  const entries = await fs.readdir(cd);
  const results: CharacterData[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try { const item = await readJson<CharacterData>(path.join(cd, entry)); if (item) results.push(item); } catch { /* skip */ }
  }
  const offset = Math.max(0, opts?.offset ?? 0);
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, 1000));
  return results.slice(offset, offset + limit);
}

export async function readCharacter(slug: string, charId: string): Promise<CharacterData | null> {
  const cf = characterFile(slug, charId);
  if (!(await pathExists(cf))) return null;
  return readJson<CharacterData>(cf);
}

export async function createCharacter(
  slug: string,
  input: {
    name: string;
    role: string;
    appearance_prompt?: string;
    personality: string;
    /** Wave B-3 (2026-05-16): 拆分字段, 可选(向后兼容 — 老调用方仅传 appearance_prompt 也工作) */
    appearance?: string;
    outfit?: string;
    voice_id?: string;
    voice_style_map?: Record<string, string | undefined>;
    library_id?: string;
    locked_image_path?: string;
    /** 2026-05-20 P2: 是否为 LLM 自动占位角色 */
    is_placeholder?: boolean;
    /** 2026-05-26 W1: 角色绑定的服装造型 element id 列表 (kind=wardrobe) */
    wardrobe_element_ids?: string[];
    /** 2026-05-26 W1: 角色常带的道具 element id 列表 (kind=prop) */
    prop_element_ids?: string[];
  },
): Promise<CharacterData> {
  // 2026-05-21 — id 唯一性防御 (跟 series.uniqueSlug 同款):
  // 历史 bug: createCharacter 用 slugify(name) 作 id, 同 name 直接覆盖现有角色文件 →
  // batchSeries / 跨项目导入时 silent 覆盖现有角色, 老角色的 ref_image_ids / appearance 全丢.
  // 修法: 已存在则加 -2/-3 后缀生成新 id, 不覆盖.
  const baseCharId = slugify(input.name);
  let charId = baseCharId;
  let suffix = 2;
  await ensureDir(charactersDir(slug));
  // 2026-07-22 X6-4 (A3-2): 除活跃目录外, 同 kind 回收站占用的 id 也要避让 —— 否则新建同名角色会
  // 拿到被删角色的 id, 让 shot.character_ids 静默改指向新人 (entity-first 串味, 违反铁律 0)。
  const reservedCharIds = await listTrashReservedIds(slug, "character");
  while ((await pathExists(characterFile(slug, charId))) || reservedCharIds.has(charId)) {
    charId = `${baseCharId}-${suffix}`;
    suffix++;
  }
  const data: CharacterData = {
    id: charId,
    series_slug: slug,
    name: input.name,
    role: input.role,
    appearance_prompt: input.appearance_prompt,
    // Wave B-3: 拆分字段 — 若 caller 没传也不写空字符串(undefined 优于 "" 不污染 JSON)。
    ...(input.appearance ? { appearance: input.appearance } : {}),
    ...(input.outfit ? { outfit: input.outfit } : {}),
    personality: input.personality,
    voice_id: input.voice_id,
    voice_style_map: input.voice_style_map,
    ref_image_ids: [],
    status: "drafted",
    library_id: input.library_id,
    locked_image_path: input.locked_image_path,
    ...(input.is_placeholder ? { is_placeholder: true } : {}),
    ...(input.wardrobe_element_ids && input.wardrobe_element_ids.length > 0
      ? { wardrobe_element_ids: input.wardrobe_element_ids } : {}),
    ...(input.prop_element_ids && input.prop_element_ids.length > 0
      ? { prop_element_ids: input.prop_element_ids } : {}),
  };
  await writeJson(characterFile(slug, charId), data);
  const series = await readSeries(slug);
  if (series) {
    series.character_ids.push(charId);
    series.updated_at = nowISO();
    await writeJson(seriesFile(slug), series);
  }
  return data;
}

export async function updateCharacter(slug: string, charId: string, patch: Partial<CharacterData>): Promise<CharacterData | null> {
  return withWriteLock(characterFile(slug, charId), async () => {
    const existing = await readCharacter(slug, charId);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id: existing.id, series_slug: existing.series_slug };
    await writeJson(characterFile(slug, charId), updated);
    return updated;
  });
}

export async function deleteCharacter(slug: string, charId: string): Promise<boolean> {
  const cf = characterFile(slug, charId);
  if (!(await pathExists(cf))) return false;
  // 铁律 #6: 数据保留 > 直接删除 — 软删到回收站，90 天可恢复
  const existing = await readCharacter(slug, charId);
  const name = existing?.name ?? charId;
  const trashId = await softDeleteItem(slug, "character", charId, cf, name);
  if (trashId === null) return false;
  // 从 series.character_ids 移除引用（保持聚合一致性）
  const series = await readSeries(slug);
  if (series) {
    series.character_ids = series.character_ids.filter(c => c !== charId);
    series.updated_at = nowISO();
    await writeJson(seriesFile(slug), series);
  }
  return true;
}

// ─── 角色回收站 ──────────────────────────────────────────────────────

export type { TrashedItemEntry };

export async function listTrashedCharacters(slug: string): Promise<TrashedItemEntry[]> {
  return listTrashedItems(slug, "character");
}

export async function restoreTrashedCharacter(slug: string, trashId: string): Promise<string | null> {
  // 2026-07-22 X6-3 (A3-1): 走 free-slot 恢复 —— 冲突时挑空闲 id (循环加后缀, 不再只试一个 -restored
  // 而静默覆盖), 且 restoreTrashedItem 会把快照内部 id 字段同步改写为实际落盘 id, 消除列表重复 id。
  const finalId = await restoreTrashedItemToFreeSlot(slug, "character", trashId, (id) => characterFile(slug, id));
  if (!finalId) return null;
  // 恢复时把**实际落盘 id** 加回 series.character_ids (与内部 id 字段一致, 引用不悬空)
  const series = await readSeries(slug);
  if (series && !series.character_ids.includes(finalId)) {
    series.character_ids.push(finalId);
    series.updated_at = nowISO();
    await writeJson(seriesFile(slug), series);
  }
  return finalId;
}

export async function permanentDeleteTrashedCharacter(slug: string, trashId: string): Promise<boolean> {
  return permanentDeleteTrashedItem(slug, trashId);
}

// ─── Series Character Variants ───────────────────────────────────

export interface SeriesVariant {
  id: string;
  label: string;
  category: "outfit" | "emotion" | "pose" | "other" | "time_of_day" | "weather";
  vault_id: string;
  parent: "locked" | string;
  /**
   * 2026-05-20: 字段名从 user_note 改为 display_name (display_name 体系统一).
   * 历史 user_note 数据由 listSeriesCharVariants/listSeriesSceneVariants 读时映射进 display_name.
   */
  display_name: string;
  /** @deprecated 2026-05-20 兼容老数据: 读时映射到 display_name, 不再新写. */
  user_note?: string;
  created_at: string;
}

/**
 * 2026-05-20 display_name 体系统一: 读老数据时把 user_note 兜底映射为 display_name.
 */
function migrateVariantUserNote(v: SeriesVariant): SeriesVariant {
  if (v.display_name) return v;
  // 老数据只有 user_note, 没有 display_name
  if (v.user_note !== undefined) return { ...v, display_name: v.user_note };
  return { ...v, display_name: "" };
}

export async function listSeriesCharVariants(slug: string, charId: string): Promise<SeriesVariant[]> {
  const vDir = charVariantDir(slug, charId);
  if (!(await pathExists(vDir))) return [];
  const entries = await fs.readdir(vDir);
  const results: SeriesVariant[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try { const item = await readJson<SeriesVariant>(path.join(vDir, entry)); if (item) results.push(migrateVariantUserNote(item)); } catch { /* skip */ }
  }
  return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function createSeriesCharVariant(
  slug: string,
  charId: string,
  // 2026-05-20: 入参兼容老的 user_note (向后兼容 caller), 内部统一存 display_name
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
  await ensureDir(charVariantDir(slug, charId));
  await writeJson(charVariantPath(slug, charId, varId), variant);
  return variant;
}

export async function deleteSeriesCharVariant(slug: string, charId: string, varId: string): Promise<boolean> {
  const vp = charVariantPath(slug, charId, varId);
  if (!(await pathExists(vp))) return false;
  await fs.unlink(vp);
  return true;
}
