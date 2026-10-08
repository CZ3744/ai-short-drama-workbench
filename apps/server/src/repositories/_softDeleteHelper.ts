/**
 * _softDeleteHelper — 素材级软删公共工具
 *
 * 为 elementRepo / characterRepo / sceneRepo 提供统一的"软删 → 回收站"逻辑。
 * 遵循铁律 #6: 数据保留 > 直接删除; 90 天可恢复。
 *
 * 落盘结构:
 *   data/series/<slug>/_element_trash/<kind>/<id>__<deleted_at_ms>.json   — 原 JSON 快照
 *   data/series/<slug>/_element_trash/manifest.json                        — 索引
 *
 * kind 参数区分三类回收站: "element" | "character" | "scene"
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT, pathExists, readJson, writeJson, ensureDir } from "../../../../packages/core/src/index";

// ─── 常量 ────────────────────────────────────────────────────────────

export const ELEMENT_TRASH_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 天

export type TrashKind = "element" | "character" | "scene";

// ─── 路径 helpers ─────────────────────────────────────────────────────

export function elementTrashRoot(slug: string): string {
  return path.join(DATA_ROOT, "series", slug, "_element_trash");
}

export function elementTrashKindDir(slug: string, kind: TrashKind): string {
  return path.join(elementTrashRoot(slug), kind);
}

export function elementTrashManifestFile(slug: string): string {
  return path.join(elementTrashRoot(slug), "manifest.json");
}

// ─── Manifest 类型 ────────────────────────────────────────────────────

export interface TrashManifestEntry {
  trash_id: string;      // "<id>__<deleted_at_ms>"
  original_id: string;
  kind: TrashKind;
  name: string;          // best-effort 从原数据取
  deleted_at: string;    // ISO
  expires_at: string;    // ISO, deleted_at + 90d
}

export interface TrashManifest {
  entries: TrashManifestEntry[];
}

// ─── 读写 manifest ────────────────────────────────────────────────────

async function readManifest(slug: string): Promise<TrashManifest> {
  const f = elementTrashManifestFile(slug);
  if (!(await pathExists(f))) return { entries: [] };
  const data = await readJson<TrashManifest>(f);
  return data ?? { entries: [] };
}

async function writeManifest(slug: string, manifest: TrashManifest): Promise<void> {
  await ensureDir(elementTrashRoot(slug));
  await writeJson(elementTrashManifestFile(slug), manifest);
}

// ─── 核心函数: softDeleteItem ─────────────────────────────────────────

/**
 * 把一个元数据文件软删到 _element_trash/<kind>/<id>__<ts>.json，
 * 并在 manifest 追加一条索引。
 *
 * @param slug        系列 slug
 * @param kind        "element" | "character" | "scene"
 * @param id          实体 ID
 * @param srcFilePath 要软删的 JSON 文件绝对路径
 * @param name        显示名 (用于 manifest 展示)
 * @returns trash_id 字符串（成功时），或 null（文件不存在）
 */
export async function softDeleteItem(
  slug: string,
  kind: TrashKind,
  id: string,
  srcFilePath: string,
  name: string,
): Promise<string | null> {
  if (!(await pathExists(srcFilePath))) return null;

  const nowMs = Date.now();
  const trashId = `${id}__${nowMs}`;
  const kindDir = elementTrashKindDir(slug, kind);
  await ensureDir(kindDir);
  const destPath = path.join(kindDir, `${trashId}.json`);

  // 原子性: rename 比 copy+unlink 更安全 (同驱动器)
  try {
    await fs.rename(srcFilePath, destPath);
  } catch {
    // 跨驱动器时 rename 会失败，回退到 copy + unlink
    await fs.copyFile(srcFilePath, destPath);
    await fs.unlink(srcFilePath);
  }

  // 追加 manifest 条目
  const deletedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ELEMENT_TRASH_MAX_AGE_MS).toISOString();
  const entry: TrashManifestEntry = {
    trash_id: trashId,
    original_id: id,
    kind,
    name,
    deleted_at: deletedAt,
    expires_at: expiresAt,
  };

  const manifest = await readManifest(slug);
  manifest.entries.push(entry);
  await writeManifest(slug, manifest);

  return trashId;
}

// ─── 列出回收站 ───────────────────────────────────────────────────────

/**
 * 列出某系列回收站中指定 kind（或全部）的已删条目。
 * 过期条目保留在 manifest 直到 cleanupElementTrash 运行，
 * 但 days_remaining = 0 时前端显示"已过期，等待清除"。
 */
export interface TrashedItemEntry extends TrashManifestEntry {
  days_remaining: number;
  expired: boolean;
  description?: string;
  thumbnail_url?: string;
  thumbnail_asset_id?: string;
  thumbnail_vault_id?: string;
  image_count?: number;
}

async function readTrashSummary(slug: string, entry: TrashManifestEntry): Promise<Pick<TrashedItemEntry, "description" | "thumbnail_url" | "thumbnail_asset_id" | "thumbnail_vault_id" | "image_count">> {
  const file = path.join(elementTrashKindDir(slug, entry.kind), `${entry.trash_id}.json`);
  if (!(await pathExists(file))) return {};
  try {
    const snapshot = await readJson<Record<string, any>>(file);
    if (!snapshot) return {};
    const images = Array.isArray(snapshot.images) ? snapshot.images : [];
    const primaryImage = images.find((im: any) => im?.image_id === snapshot.primary_image_id) ?? images[0];
    const refIds = Array.isArray(snapshot.ref_image_ids) ? snapshot.ref_image_ids : [];
    const primaryRefId = snapshot.primary_ref_image_id ?? refIds[0];
    const description = [
      snapshot.description,
      snapshot.appearance,
      snapshot.outfit,
      snapshot.visual_style,
      snapshot.location,
      snapshot.mood,
    ].filter((v) => typeof v === "string" && v.trim()).join(" · ");
    return {
      description: description || undefined,
      thumbnail_url: typeof primaryImage?.url === "string" ? primaryImage.url : undefined,
      thumbnail_asset_id: typeof primaryImage?.asset_id === "string"
        ? primaryImage.asset_id
        : typeof primaryRefId === "string"
          ? primaryRefId
          : undefined,
      thumbnail_vault_id: typeof primaryImage?.vault_id === "string" ? primaryImage.vault_id : undefined,
      image_count: images.length || refIds.length || undefined,
    };
  } catch {
    return {};
  }
}

export async function listTrashedItems(
  slug: string,
  kind?: TrashKind,
): Promise<TrashedItemEntry[]> {
  const manifest = await readManifest(slug);
  const now = Date.now();

  const items = await Promise.all(manifest.entries
    .filter((e) => !kind || e.kind === kind)
    .map(async (e) => {
      const expiresMs = new Date(e.expires_at).getTime();
      const msRemaining = expiresMs - now;
      const daysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
      const summary = await readTrashSummary(slug, e);
      return {
        ...e,
        ...summary,
        days_remaining: daysRemaining,
        expired: msRemaining <= 0,
      };
    }));
  return items.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
}

// ─── 恢复 ─────────────────────────────────────────────────────────────

/** 从 trashId ("<id>__<ts>") 取出原始 id (双下划线前). */
export function trashIdToOriginalId(trashId: string): string {
  const underscoreIdx = trashId.lastIndexOf("__");
  return underscoreIdx !== -1 ? trashId.slice(0, underscoreIdx) : trashId;
}

/**
 * 从回收站恢复一条记录到原位置。
 *
 * @param slug      系列 slug
 * @param kind      被删实体的原 kind ("element" | "character" | "scene")。
 *                  只在该 kind 对应的回收站子目录里找源文件 —— 严禁跨 kind 恢复:
 *                  角色/场景各自的 repo restore 才知道正确的落盘目录与 series 关联,
 *                  若跨 kind 搜到别 kind 的文件会被还原进错误目录 (如角色落进 elements/) 而损坏。
 * @param trashId   "<id>__<ts>" 格式
 * @param destPath  恢复目标路径（由各 repo 提供，因为它们知道最终落盘位置）
 * @returns         恢复后**实际落盘的 id**（可能因冲突改名带后缀），或 null（该 kind 回收站里无此 trash_id）
 *
 * 2026-07-22 X6-3 (A3-1): 恢复到冲突改名路径 (destPath 落 `<id>-restored`) 时, 文件名 stem 与
 * 快照内部 `id` 字段不再一致 → listCharacters/listScenes/listElements 会返回两条内部 id 相同的实体
 * (React key 撞车 / 互相遮盖 / entity-first 引用歧义: shot.character_ids:["foo"] 指向不定)。
 * 修法: 纯 rename 之后, 若落盘文件名 stem ≠ 快照原 id, 把快照内部 `id` 字段一并改写为 stem, 并校正
 * `series_slug`, 恢复"文件名 == 内部 id"不变量。返回值改为**真实落盘 id**(而非无脑取 trashId 前缀),
 * caller 据此更新 series 聚合链 (character_ids/scene_ids) 才不会指向不存在的 id。
 */
export async function restoreTrashedItem(
  slug: string,
  kind: TrashKind,
  trashId: string,
  destPath: string,
): Promise<string | null> {
  // 只在与调用方 kind 匹配的子目录里找 —— 不跨 kind, 避免角色/场景被还原到 elements/ 而串位。
  const srcPath = path.join(elementTrashKindDir(slug, kind), `${trashId}.json`);
  if (!(await pathExists(srcPath))) return null;

  // 防覆盖：目标落盘路径的 free-slot 由 caller (restoreTrashedItemToFreeSlot) 负责,
  // 这里仅恢复文件本身。
  await ensureDir(path.dirname(destPath));
  try {
    await fs.rename(srcPath, destPath);
  } catch {
    await fs.copyFile(srcPath, destPath);
    await fs.unlink(srcPath);
  }

  // X6-3 (A3-1): 落盘文件名 stem 与快照原 id 不一致 (冲突改名) → 同步改写内部 id + series_slug,
  // 保证"文件名 == 内部 id"不变量, 消除列表重复 id / React key 撞车。
  const originalId = trashIdToOriginalId(trashId);
  const finalId = path.basename(destPath, ".json");
  if (finalId !== originalId) {
    try {
      const snapshot = await readJson<Record<string, unknown>>(destPath);
      if (snapshot && typeof snapshot === "object") {
        snapshot.id = finalId;
        snapshot.series_slug = slug;
        await writeJson(destPath, snapshot);
      }
    } catch {
      // 内容改写失败不阻断恢复本身 (文件已落到正确路径); X6-5 只读扫描脚本可检出这类残留。
    }
  }

  // 从 manifest 移除该条目（按 trash_id + kind 精确匹配，只清掉刚恢复的这条）
  const manifest = await readManifest(slug);
  manifest.entries = manifest.entries.filter((e) => !(e.trash_id === trashId && e.kind === kind));
  await writeManifest(slug, manifest);

  return finalId;
}

/**
 * 2026-07-22 X6-3 — restore 的高阶封装: 自动挑一个"空位" id 再恢复。
 *
 * 旧各 repo restore 只试一个 `<id>-restored` 后缀 —— 若 `<id>` 与 `<id>-restored` 都已被占用,
 * restoreTrashedItem 的 fs.rename 会**静默覆盖** `<id>-restored` 现有实体 (数据丢失)。这里改为
 * 循环挑到真正空闲的 id (`<id>` → `<id>-restored` → `<id>-restored-2` → ...), 再交给 restoreTrashedItem
 * (它会在改名时同步改写内部 id 字段, 见 X6-3)。
 *
 * @param fileForId  由各 repo 提供的 "id → 落盘绝对路径" 映射 (characterFile/sceneFile/elementFile)
 * @returns          实际落盘的最终 id, 或 null (该 kind 回收站无此 trashId)
 */
export async function restoreTrashedItemToFreeSlot(
  slug: string,
  kind: TrashKind,
  trashId: string,
  fileForId: (id: string) => string,
): Promise<string | null> {
  const originalId = trashIdToOriginalId(trashId);
  let finalId = originalId;
  if (await pathExists(fileForId(finalId))) {
    finalId = `${originalId}-restored`;
    let n = 2;
    while (await pathExists(fileForId(finalId))) {
      finalId = `${originalId}-restored-${n}`;
      n++;
    }
  }
  return restoreTrashedItem(slug, kind, trashId, fileForId(finalId));
}

/**
 * 2026-07-22 X6-4 (A3-2) — 返回某 kind 回收站里所有"占用中"的 original_id 集合。
 *
 * 新建实体走 slugify(name) 生成 id, 旧代码只避让**活跃目录**已存在的 id, 不避让回收站。后果:
 * 软删角色 foo (文件进 trash, 活跃目录不占位) → 新建另一个同名不同人角色 → 也拿到 id `foo` →
 * 此前所有 `shot.character_ids:["foo"]` 静默改指向新角色 (违反铁律 0 跨分镜一致性 / entity-first 串味)。
 * 修法: createCharacter/createScene/createElement 生成 id 时把本 kind 回收站占用的 id 一并避让,
 * 让新实体拿 `foo-2`, 把 `foo` 命名空间留给被删实体日后恢复, 保证一个 slug id 全生命周期只属一个逻辑实体。
 */
export async function listTrashReservedIds(
  slug: string,
  kind: TrashKind,
): Promise<Set<string>> {
  const manifest = await readManifest(slug);
  const reserved = new Set<string>();
  for (const e of manifest.entries) {
    if (e.kind === kind) reserved.add(e.original_id);
  }
  return reserved;
}

// ─── 永久删除 ─────────────────────────────────────────────────────────

/**
 * 永久删除回收站里一条记录（不可恢复）。
 */
export async function permanentDeleteTrashedItem(
  slug: string,
  trashId: string,
): Promise<boolean> {
  const kinds: TrashKind[] = ["element", "character", "scene"];
  let deleted = false;

  for (const k of kinds) {
    const candidate = path.join(elementTrashKindDir(slug, k), `${trashId}.json`);
    if (await pathExists(candidate)) {
      await fs.unlink(candidate);
      deleted = true;
      break;
    }
  }

  if (!deleted) return false;

  // 从 manifest 移除
  const manifest = await readManifest(slug);
  manifest.entries = manifest.entries.filter((e) => e.trash_id !== trashId);
  await writeManifest(slug, manifest);
  return true;
}

// ─── 清理过期条目 ─────────────────────────────────────────────────────

/**
 * 删除超过 90 天的 trash 文件 + 清理 manifest 对应条目。
 * 可在 server startup 调用（fire-and-forget）。
 */
export async function cleanupElementTrash(slug: string): Promise<{ removed: number }> {
  const trashRoot = elementTrashRoot(slug);
  if (!(await pathExists(trashRoot))) return { removed: 0 };

  const manifest = await readManifest(slug);
  const now = Date.now();
  let removed = 0;
  const surviving: TrashManifestEntry[] = [];

  for (const entry of manifest.entries) {
    const expiresMs = new Date(entry.expires_at).getTime();
    if (now > expiresMs) {
      // 尝试删除文件
      const candidate = path.join(elementTrashKindDir(slug, entry.kind), `${entry.trash_id}.json`);
      try {
        if (await pathExists(candidate)) {
          await fs.unlink(candidate);
        }
        removed++;
      } catch {
        surviving.push(entry); // 删除失败保留
        continue;
      }
    } else {
      surviving.push(entry);
    }
  }

  if (removed > 0) {
    manifest.entries = surviving;
    await writeManifest(slug, manifest);
  }

  return { removed };
}
