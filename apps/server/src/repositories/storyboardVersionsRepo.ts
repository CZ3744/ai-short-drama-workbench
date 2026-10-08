/**
 * Storyboard Versions Repository — W6-B 多版本管理基础设施
 *
 * 解决用户痛点 #11：每个剧本版本对应的分集分镜也要能分别管理。
 *
 * 落盘结构：
 *   data/series/<slug>/episodes/<ep>/storyboard_versions/<id>.json
 *
 * 重要约定：
 *   - 每个 StoryboardVersion 通过 script_version_id 关联到具体剧本版本。
 *   - shot_ids 仍按现有 shotRepo 的 shot 文件存储（每个 shot 一份 JSON），
 *     storyboard version 只保存"哪些 shot id 组成这版分镜 + 顺序"。
 *   - 一份系列可以同时有 v1/v2/v3 三个剧本，每个剧本可挂 0..N 个分镜版本。
 *   - 旧 episodes/<ep>/storyboard.json 继续作为"当前激活版本的镜像"。
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { ensureDir, pathExists, readJson, writeJson } from "../../../../packages/core/src/index";
import { loggerSync } from "../../../../packages/core/src/logger";
import type { StoryboardVersion } from "../../../../packages/drama/src/types";
import { episodeDir } from "./_paths";
import {
  trashEpisodeShotFiles,
  restoreTrashedShotsByBatch,
  hasTrashedShotsInBatch,
} from "./shotRepo";

/**
 * 2026-07-22 X6-1 (A3-3): 版本自带"落停批次"字段 parked_batch_id —— 该版本的 shots 被换下后
 * 停放在垃圾桶的批次 id, 供"回滚到本版本"时按批搬回。语义区别于现有 trashed_batch_id
 * (= 创建本版本时把**上一版**旧分镜挤走的批次)。
 *
 * 未污染共享 StoryboardVersion 类型 (packages/drama/src/types.ts 不在本施工包 file ownership 内),
 * 仅在本 repo 落盘/读取时用本地扩展类型承载; JSON 写入 spread 保留该字段, 读取时按需 cast。
 */
type StoryboardVersionRec = StoryboardVersion & { parked_batch_id?: string };

/** 分镜版本"激活/回滚"结果 (X6-1: 从只翻布尔升级为真搬分镜, 需向路由回传冲突/快照缺失等失败原因)。 */
export type ActivateStoryboardOutcome =
  | { ok: true; version: StoryboardVersion; moved: boolean }
  | { ok: false; reason: "not_found" | "no_snapshot" | "conflict"; message: string };

// ─── File-level write lock ──────────────────────────────────────────

const _writeLocks = new Map<string, Promise<void>>();

function withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeLocks.get(filePath) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  _writeLocks.set(filePath, next);
  return prev.then(() => fn()).finally(() => release!());
}

// ─── Paths ──────────────────────────────────────────────────────────

export function storyboardVersionsDir(slug: string, epId: string): string {
  return path.join(episodeDir(slug, epId), "storyboard_versions");
}

function storyboardVersionFile(slug: string, epId: string, id: string): string {
  return path.join(storyboardVersionsDir(slug, epId), `${id}.json`);
}

// ─── Helpers ────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `sbv_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

// ─── Public API ─────────────────────────────────────────────────────

export interface CreateStoryboardVersionInput {
  series_slug: string;
  episode_id: string;
  name?: string;
  script_version_id: string;
  shot_ids: string[];
  /**
   * 2026-07-10 Fable P0-1 — 本次重拆把上一版旧分镜整批移入垃圾桶的批次 id.
   * 记进版本条目, 让"回滚"能把那批文件从垃圾桶搬回(减配版快照).
   */
  trashed_batch_id?: string;
  /** 是否自动激活（默认 true） */
  activate?: boolean;
}

/**
 * 列出某 episode 的所有未删除分镜版本，按 created_at 升序。
 */
export async function listStoryboardVersions(slug: string, epId: string): Promise<StoryboardVersion[]> {
  const dir = storyboardVersionsDir(slug, epId);
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  const results: StoryboardVersion[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (entry.startsWith("_")) continue;
    try {
      const data = await readJson<StoryboardVersion>(path.join(dir, entry));
      if (data && !data._deleted) results.push(data);
    } catch {
      /* skip corrupted */
    }
  }
  return results.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function readStoryboardVersion(
  slug: string,
  epId: string,
  id: string,
): Promise<StoryboardVersion | null> {
  const fp = storyboardVersionFile(slug, epId, id);
  if (!(await pathExists(fp))) return null;
  const data = await readJson<StoryboardVersion>(fp);
  if (!data || data._deleted) return null;
  return data;
}

export async function createStoryboardVersion(
  input: CreateStoryboardVersionInput,
): Promise<StoryboardVersion> {
  const id = newId();
  const dir = storyboardVersionsDir(input.series_slug, input.episode_id);
  await ensureDir(dir);

  const existing = await listStoryboardVersions(input.series_slug, input.episode_id);
  const defaultName = `分镜 v${existing.length + 1}`;

  const record: StoryboardVersion = {
    id,
    series_slug: input.series_slug,
    episode_id: input.episode_id,
    name: input.name?.trim() || defaultName,
    script_version_id: input.script_version_id,
    shot_ids: [...input.shot_ids],
    created_at: nowISO(),
    is_active: input.activate ?? true,
    ...(input.trashed_batch_id ? { trashed_batch_id: input.trashed_batch_id } : {}),
  };

  await writeJson(storyboardVersionFile(input.series_slug, input.episode_id, id), record);

  if (record.is_active) {
    await deactivateOthers(input.series_slug, input.episode_id, id);
  }

  return record;
}

/**
 * 只翻 is_active 指针, **不动 shots/ 目录** (供 softDelete 删除活跃版本后自动补位, 以及内部兜底)。
 * 这是历史 activateStoryboardVersion 的行为; X6-1 把用户显式的"激活/回滚"升级为真搬分镜后, 保留
 * 这条纯指针路径给"删除当前版本→自动激活剩余最新一条"这种**不应该扰动用户当前分镜**的场景。
 */
async function markStoryboardVersionActivePointer(
  slug: string,
  epId: string,
  id: string,
): Promise<StoryboardVersion | null> {
  const target = await readStoryboardVersion(slug, epId, id);
  if (!target) return null;
  await deactivateOthers(slug, epId, id);
  const updated: StoryboardVersionRec = { ...(target as StoryboardVersionRec), is_active: true };
  await writeJson(storyboardVersionFile(slug, epId, id), updated);
  return updated;
}

/** 写 parked_batch_id 到指定版本 (锁内重读再写, 不覆盖并发改的其它字段)。 */
async function setVersionParkedBatch(
  slug: string,
  epId: string,
  id: string,
  batchId: string | undefined,
): Promise<void> {
  const fp = storyboardVersionFile(slug, epId, id);
  await withWriteLock(fp, async () => {
    const fresh = await readJson<StoryboardVersionRec>(fp);
    if (!fresh || fresh._deleted) return;
    await writeJson(fp, { ...fresh, parked_batch_id: batchId });
  });
}

/**
 * 2026-07-22 X6-1 (A3-3) — 激活/回滚到某分镜版本 = **真正把该版本的分镜从垃圾桶搬回**, 当前现行镜
 * 整套停放进垃圾桶带批次标记 (可再切回)。原子换挡, 绝不半套落盘。
 *
 * 旧实现只翻 is_active 布尔, 完全不碰 shots/ 目录 → 用户点"回滚到旧分镜版本"后版本标记变了, 但分镜板
 * 仍是当前那套 (状态撒谎, 违反公理 B; 旧版本 shots 还躺在 _trash 无人搬回)。
 *
 * 换挡步骤 (见 A3-3 设计):
 *   a. 目标已激活 → 幂等返回。
 *   b. 定位目标版本 shots 的落停批次 restoreBatch: 优先 target.parked_batch_id; 老数据兼容取"created_at
 *      紧邻其后的版本"的 trashed_batch_id (当初把 target 挤走的批次 = target shots 落停处)。都没有 → no_snapshot 拒绝。
 *   c. 停放前预检批次非空 (已被永久清理=0 文件则拒绝, 不白park当前分镜)。
 *   d. trashEpisodeShotFiles 把当前现行镜整套搬进垃圾桶 (批次 parkedBatch), 记到**当前活跃版本**的
 *      parked_batch_id 上 (供日后换回)。
 *   e. restoreTrashedShotsByBatch(restoreBatch) 把目标版本 shots 搬回。有 conflict → 整体回滚 (把 d 步
 *      parked 批次搬回) + 报 conflict, 绝不半套落盘。
 *   f. 全部成功后翻 is_active。
 */
export async function activateStoryboardVersion(
  slug: string,
  epId: string,
  id: string,
): Promise<ActivateStoryboardOutcome> {
  const target = (await readStoryboardVersion(slug, epId, id)) as StoryboardVersionRec | null;
  if (!target) return { ok: false, reason: "not_found", message: "分镜版本不存在" };
  // a. 幂等: 已经是激活版本 → 不搬分镜, 直接返回。
  if (target.is_active) return { ok: true, version: target, moved: false };

  const allVersions = (await listStoryboardVersions(slug, epId)) as StoryboardVersionRec[];
  const activeBefore = allVersions.find((v) => v.is_active) ?? null;

  // b. 定位目标版本 shots 的落停批次。
  let restoreBatch = target.parked_batch_id;
  if (!restoreBatch) {
    const laterSorted = allVersions
      .filter((v) => v.created_at > target.created_at)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    restoreBatch = laterSorted[0]?.trashed_batch_id;
  }
  if (!restoreBatch) {
    return {
      ok: false,
      reason: "no_snapshot",
      // 2026-07-22 U-fix1: 老版本(在"一键回滚"能力上线前创建, 或本就是最初那一版)没有留下镜头快照,
      // 无法一键切回。人话说明缘由 + 明确"当前分镜没动"(不是静默失败), 并给出可行的下一步。
      message: "这个分镜版本是在“一键回滚”功能上线之前创建的(或本就是最初那一版), 系统里没有它的镜头快照, 无法一键切回这一版。你的当前分镜没有任何改动; 之后新建或重新导入的分镜版本都支持一键切换。",
    };
  }

  // c. 预检: 批次在垃圾桶里确实有文件, 否则拒绝 (绝不白park当前分镜换来空分镜板)。
  if (!(await hasTrashedShotsInBatch(slug, epId, restoreBatch))) {
    return {
      ok: false,
      reason: "no_snapshot",
      message: "这个分镜版本的镜头快照已被永久清理(不在分镜垃圾桶里了), 无法一键切回这一版。你的当前分镜没有任何改动。",
    };
  }

  // d. 停放当前现行镜整套进垃圾桶, 批次记到当前活跃版本上 (供日后换回)。
  const parked = await trashEpisodeShotFiles(slug, epId);
  if (activeBefore) {
    await setVersionParkedBatch(slug, epId, activeBefore.id, parked.batch_id);
  } else {
    loggerSync().warn(
      `[activateStoryboardVersion] ${slug}/${epId} 无活跃版本, 停放批次 ${parked.batch_id} 未挂到任何版本 (当前分镜仍安全在垃圾桶, 可单镜恢复)`,
    );
  }

  // e. 搬回目标版本 shots。有冲突 → 整体回滚 (把 d 步 parked 批次搬回) + 报 conflict。
  const { conflicts } = await restoreTrashedShotsByBatch(slug, epId, restoreBatch);
  if (conflicts.length > 0) {
    // 回滚: 把刚停放的当前镜搬回 (restoreTrashedShotsByBatch 原子失败时不会动目标批次, 故当前只需还原 parked)。
    await restoreTrashedShotsByBatch(slug, epId, parked.batch_id).catch((e) =>
      loggerSync().error(`[activateStoryboardVersion] 回滚停放批次 ${parked.batch_id} 失败:`, e),
    );
    if (activeBefore) await setVersionParkedBatch(slug, epId, activeBefore.id, activeBefore.parked_batch_id);
    return {
      ok: false,
      reason: "conflict",
      message: `回滚时发现 ${conflicts.length} 个镜头位已被占用, 为避免覆盖已整体撤销, 当前分镜未改动。请先清理冲突镜头后重试。`,
    };
  }

  // f. 全部成功 → 翻 is_active。目标版本被换回后其 shots 已在 shots/, parked_batch_id 已消费, 清空之。
  await deactivateOthers(slug, epId, id);
  const updated: StoryboardVersionRec = { ...target, is_active: true, parked_batch_id: undefined };
  await writeJson(storyboardVersionFile(slug, epId, id), updated);
  return { ok: true, version: updated, moved: true };
}

async function deactivateOthers(slug: string, epId: string, exceptId: string): Promise<void> {
  const all = await listStoryboardVersions(slug, epId);
  for (const v of all) {
    if (v.id === exceptId) continue;
    if (!v.is_active) continue;
    const fp = storyboardVersionFile(slug, epId, v.id);
    await withWriteLock(fp, async () => {
      const fresh = await readJson<StoryboardVersion>(fp);
      if (fresh && !fresh._deleted) {
        await writeJson(fp, { ...fresh, is_active: false });
      }
    });
  }
}

export async function softDeleteStoryboardVersion(
  slug: string,
  epId: string,
  id: string,
): Promise<boolean> {
  const fp = storyboardVersionFile(slug, epId, id);
  if (!(await pathExists(fp))) return false;
  const existing = await readJson<StoryboardVersion>(fp);
  if (!existing || existing._deleted) return false;

  await withWriteLock(fp, async () => {
    await writeJson(fp, { ...existing, _deleted: true, _deleted_at: new Date().toISOString(), is_active: false });
  });

  if (existing.is_active) {
    const remaining = await listStoryboardVersions(slug, epId);
    if (remaining.length > 0) {
      const latest = remaining[remaining.length - 1];
      // 2026-07-22 X6-1: 删除活跃版本后的自动补位走**纯指针**路径, 不搬分镜 —— 删一个版本条目不应
      // 悄悄把用户当前分镜换成另一套 (且前端只在非活跃版本上给删除按钮, 此路径实为防御性)。
      await markStoryboardVersionActivePointer(slug, epId, latest.id);
    }
  }

  return true;
}

export async function getActiveStoryboardVersion(
  slug: string,
  epId: string,
): Promise<StoryboardVersion | null> {
  const all = await listStoryboardVersions(slug, epId);
  return all.find((v) => v.is_active) ?? null;
}
