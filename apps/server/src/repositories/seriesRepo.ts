/**
 * Series Repository — extracted from v2/seriesStore.ts (step 1: split god-module by aggregate root)
 *
 * Zero behavior change. Re-imports `importCharacterFromLibrary` / `importSceneFromLibrary`
 * from seriesStore (kept in original file until later steps split character/scene out).
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathExists, readJson, writeJson, ensureDir, slugify } from "../../../../packages/core/src/index";
import { loggerSync } from "../../../../packages/core/src/logger";
import { importCharacterFromLibrary, importSceneFromLibrary } from "../api/v2/seriesStore";
import type { SeriesData, SeriesDefaults } from "../../../../packages/drama/src/types";
import {
  SERIES_ROOT,
  SAMPLES_ROOT,
  TRASH_ROOT,
  seriesDir,
  seriesFile,
  episodeDir,
  characterFile,
  charactersDir,
  sceneFile,
  scenesDir,
  assetsDir,
} from "./_paths";

// 2026-05-19: 保留期 7 天 → 90 天, 跟 ShotboardPage 删一集的提示文案对齐
// ("把这一集移到回收站(90 天可恢复)"). 用户铁律 #6: 数据保留 > 直接删除.
const TRASH_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ─── File-level write Mutex (pure JS, no npm dep) ─────────────

const _writeLocks = new Map<string, Promise<void>>();

/**
 * Serialize read-modify-write operations per entity file.
 * Prevents lost-update race conditions on updateShot/Episode/Character/Scene/Series/Trash.
 * Uses Map<path, Promise> chain — each new call waits for the previous lock on the same file.
 */
function withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeLocks.get(filePath) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>(r => { release = r; });
  _writeLocks.set(filePath, next);
  return prev
    .then(() => fn())
    .finally(() => release!());
}

// ─── Helpers ────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

/** P180 A9: 确保 slug 唯一，冲突时追加 -2/-3... */
async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let i = 2;
  while (await pathExists(seriesDir(slug))) {
    slug = `${base}-${i}`;
    i++;
  }
  return slug;
}

const GENERATED_FALLBACK_NOTE_RE =
  /(?:^|\n)\s*>?\s*注[:：]\s*LLM\s*调用链路全部失败(?:[（(][\s\S]*?[）)])?\s*[。.]?\s*请检查设置\s*→\s*Providers\s*[。.]?\s*以下为原始灵感文本[。.]?/g;

function stripGeneratedFallbackNote(scriptMd: string | undefined): string | undefined {
  if (scriptMd === undefined) return undefined;
  return scriptMd
    .replace(GENERATED_FALLBACK_NOTE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripFallbackSummary(summary?: string): string | undefined {
  if (!summary) return summary;
  if (summary.startsWith("LLM 调用链路全部失败（")) return "LLM 生成失败，已保留原始灵感文本";
  return summary;
}

function sanitizeSeriesScriptVersion(version: SeriesScriptVersion): SeriesScriptVersion {
  return {
    ...version,
    summary: stripFallbackSummary(version.summary),
    script_md: stripGeneratedFallbackNote(version.script_md) ?? version.script_md,
  };
}

// ─── Series CRUD ────────────────────────────────────────────────

export interface SeriesScriptVersion {
  version: number;
  created_at: string;
  source: "ai_init" | "user_edit" | "ai_revise" | "revert";
  summary?: string;
  script_md: string;
}

// Step2: SeriesData / SeriesDefaults 单源化到 packages/drama/src/types.ts。
// 此处仅 re-export 保持下游 import 不破 (seriesStore barrel 链路).
export type { SeriesData, SeriesDefaults };

export type SeriesListItem = SeriesData & {
  episode_count: number;
  total_cost: number;
};

export interface ListSeriesOptions {
  includeInternalTestSeries?: boolean;
}

const INTERNAL_TEST_SERIES_SLUG_PATTERNS = [
  /^orchestrator-测试系列(?:-\d+)?$/u,
  /^pa5测试系列(?:-\d+)?$/u,
  /^p180-mock-full-chain-/u,
  /^p185-smoke-test(?:-\d+)?$/u,
  /^v5-mock-v5test-/u,
];

export function isInternalTestSeries(data: Pick<SeriesData, "slug" | "title">): boolean {
  return INTERNAL_TEST_SERIES_SLUG_PATTERNS.some((pattern) => pattern.test(data.slug));
}

/**
 * 2026-05-21 — 系统/备份目录过滤模式. data/series/ 下不算"用户系列"的目录:
 *   - _trash / _backup / _migrate 开头: 系统内部目录 (软删 / migrate 备份)
 *   - <slug>_backup_<timestamp>: 用户/脚本手动备份 (例如 migrate-shot-action-to-nodes 跑前备份)
 *   - .* 开头: 隐藏目录 (macOS .DS_Store / Windows .git 等)
 * 避免这些误显示成"重复系列"卡片.
 */
const NON_USER_SERIES_DIR_PATTERNS = [
  /^_/,                       // _trash, _backup, _migrate, ...
  /\./,                       // .git, .DS_Store, hidden dirs (any "." anywhere is also suspect for series slug)
  /_backup_\d{8}_\d{6}$/,     // <slug>_backup_YYYYMMDD_HHMMSS (cp -r 时间戳备份)
  /_backup$/,                 // <slug>_backup (无时间戳)
  /\.bak$/,                   // <slug>.bak
];

export function isNonUserSeriesDir(dirname: string): boolean {
  return NON_USER_SERIES_DIR_PATTERNS.some((re) => re.test(dirname));
}

export async function listSeries(options: ListSeriesOptions = {}): Promise<SeriesListItem[]> {
  if (!(await pathExists(SERIES_ROOT))) return [];
  const entries = await fs.readdir(SERIES_ROOT, { withFileTypes: true });
  const results: SeriesListItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 2026-05-21 — 过滤系统/备份目录, 防 "<slug>_backup_*" 等显示成重复卡片
    if (isNonUserSeriesDir(entry.name)) continue;
    const sf = seriesFile(entry.name);
    if (await pathExists(sf)) {
      try {
        const data = await readJson<SeriesData>(sf);
        if (data && !data._deleted) {
          if (!options.includeInternalTestSeries && isInternalTestSeries(data)) {
            continue;
          }
          results.push({
            ...data,
            episode_count: data.episodes.length,
            total_cost: 0, // computed from ledger if needed later
          });
        }
      } catch { /* skip corrupted */ }
    }
  }
  // 2026-05-21 — slug 去重防御 (即使 NON_USER_SERIES_DIR_PATTERNS 没拦住, 同 slug 出现 2 次也只保留最新的).
  // 同 slug 时按 updated_at 取最新, 避免备份/老拷贝跟当前真数据并存.
  const dedup = new Map<string, SeriesListItem>();
  for (const item of results) {
    const existing = dedup.get(item.slug);
    if (!existing || item.updated_at.localeCompare(existing.updated_at) > 0) {
      dedup.set(item.slug, item);
    }
  }
  return Array.from(dedup.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * 2026-05-26 audit #9 修复 — 兼容新旧 provider 字段名.
 *
 * 用户在 CreateSeriesDialog 高级参数里填的 `default_llm` / `default_image` / `default_video`
 * 会原样存到 series.defaults JSON. 但下游 10+ 处代码 (orchestrator / preflight /
 * generateAllFirstFrames / batchPreviewPrompts / elementImages / generateSeriesCover 等)
 * 都从 `series.defaults.llm_provider_id` / `image_provider_id` / `video_provider_id`
 * 读. 我们在 readSeries 一次性投射, 让下游不用改:
 *   - 老字段非空 → 优先用 (向后兼容老数据 / overrides)
 *   - 老字段空 + 新字段非空 → 用新字段
 *   - 都空 → undefined
 *
 * 注: 只做读时规范化, 写回时仍保留两套字段, 不删除用户的 default_* 原值.
 */
function normalizeProviderDefaults(data: SeriesData): SeriesData {
  if (!data.defaults) return data;
  const d = data.defaults as Record<string, any>;
  const merged = { ...d };
  if (!merged.llm_provider_id && typeof d.default_llm === "string" && d.default_llm.trim()) {
    merged.llm_provider_id = d.default_llm.trim();
  }
  if (!merged.image_provider_id && typeof d.default_image === "string" && d.default_image.trim()) {
    merged.image_provider_id = d.default_image.trim();
  }
  if (!merged.video_provider_id && typeof d.default_video === "string" && d.default_video.trim()) {
    merged.video_provider_id = d.default_video.trim();
  }
  return { ...data, defaults: merged as SeriesDefaults };
}

export async function readSeries(slug: string): Promise<SeriesData | null> {
  const sf = seriesFile(slug);
  if (!(await pathExists(sf))) return null;
  const data = await readJson<SeriesData>(sf);
  if (!data) return null;
  if (data._deleted) return null;
  return normalizeProviderDefaults(data);
}

export async function createSeries(input: {
  title: string;
  synopsis?: string;
  defaults?: Partial<SeriesDefaults>;
  libraryCharacterIds?: string[];
  librarySceneIds?: string[];
}): Promise<SeriesData> {
  const baseSlug = slugify(input.title);
  const slug = await uniqueSlug(baseSlug);
  const now = nowISO();
  const data: SeriesData = {
    id: newId(),
    slug,
    title: input.title,
    synopsis: input.synopsis || "",
    created_at: now,
    updated_at: now,
    defaults: {
      platform: "bilibili",
      aspect_ratio: "16:9",
      max_retake_per_shot: 5,
      max_video_seconds_per_job: 300,
      max_parallel_tasks: 3,
      ...input.defaults,
    },
    episodes: [],
    character_ids: [],
    scene_ids: [],
    target_platform: input.defaults?.platform || "bilibili",
  };
  await ensureDir(seriesDir(slug));
  await writeJson(seriesFile(slug), data);
  await ensureDir(assetsDir(slug));
  await ensureDir(path.join(assetsDir(slug), "images"));
  await ensureDir(path.join(assetsDir(slug), "videos"));
  await ensureDir(path.join(assetsDir(slug), "audio"));

  // Import characters from library
  if (input.libraryCharacterIds && input.libraryCharacterIds.length > 0) {
    for (const libId of input.libraryCharacterIds) {
      try {
        await importCharacterFromLibrary(slug, libId);
      } catch (err) {
        loggerSync().warn(`[createSeries] 导入资源库角色失败 (${libId}):`, err instanceof Error ? err.message : err);
      }
    }
  }

  // Import scenes from library
  if (input.librarySceneIds && input.librarySceneIds.length > 0) {
    for (const libId of input.librarySceneIds) {
      try {
        await importSceneFromLibrary(slug, libId);
      } catch (err) {
        loggerSync().warn(`[createSeries] 导入资源库场景失败 (${libId}):`, err instanceof Error ? err.message : err);
      }
    }
  }

  return data;
}

export async function updateSeries(slug: string, patch: Partial<SeriesData>): Promise<SeriesData | null> {
  return withWriteLock(seriesFile(slug), async () => {
    const existing = await readSeries(slug);
    if (!existing) return null;
    const sanitizedPatch: Partial<SeriesData> = { ...patch };
    if (patch.script_md !== undefined) {
      sanitizedPatch.script_md = stripGeneratedFallbackNote(patch.script_md) ?? patch.script_md;
    }
    if (patch.script_versions !== undefined) {
      sanitizedPatch.script_versions = patch.script_versions.map((v) => sanitizeSeriesScriptVersion(v));
    }
    const updated = { ...existing, ...sanitizedPatch, slug: existing.slug, id: existing.id, updated_at: nowISO() };
    if (patch.defaults) {
      updated.defaults = { ...existing.defaults, ...patch.defaults };
    }
    await writeJson(seriesFile(slug), updated);
    return updated;
  });
}

export async function deleteSeries(slug: string): Promise<boolean> {
  const existing = await readSeries(slug);
  if (!existing) return false;
  // Soft delete: move to _trash
  await ensureDir(TRASH_ROOT);
  const trashDest = path.join(TRASH_ROOT, `${slug}_${Date.now()}`);
  await fs.rename(seriesDir(slug), trashDest);
  // Clean up old trash entries (fire-and-forget)
  // FIX 2026-05-14: 加 .catch() 防止 unhandled rejection. cleanupTrash 内
  // await fs.readdir 在罕见 perm 错误时会向外抛, 否则 Node 22+ 会发 unhandledRejection.
  cleanupTrash().catch((err) => {
    loggerSync().warn("[deleteSeries] fire-and-forget cleanupTrash failed:", err instanceof Error ? err.message : err);
  });
  return true;
}

/**
 * 2026-05-19 Wave O 致命遗留 2: 系列回收站 UI 后端 API.
 *
 * 列出 _trash 下所有已删系列, 给前端 /trash/series 页面渲染.
 * 每条返回: trash_id (目录名: slug_timestamp), 原 slug, 删除时间, 剩余天数 (90 - 已过去),
 * 还有当时的 series.json 元数据 (title / episode_count / total_cost), 让用户清楚知道删的是哪个.
 */
export interface TrashedSeriesEntry {
  trash_id: string;
  original_slug: string;
  trashed_at: string;        // ISO
  expires_at: string;         // ISO, trashed_at + TRASH_MAX_AGE_MS
  days_remaining: number;     // 距离永久删除还有几天
  // Best-effort 读 series.json 拿元数据, 读不到时为 undefined
  title?: string;
  synopsis?: string;
  episode_count?: number;
  total_cost?: number;
}

export async function listTrashedSeries(): Promise<TrashedSeriesEntry[]> {
  if (!(await pathExists(TRASH_ROOT))) return [];
  const entries = await fs.readdir(TRASH_ROOT, { withFileTypes: true });
  const now = Date.now();
  const result: TrashedSeriesEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lastUnderscore = entry.name.lastIndexOf("_");
    if (lastUnderscore === -1) continue;
    const tsStr = entry.name.slice(lastUnderscore + 1);
    const ts = parseInt(tsStr, 10);
    if (isNaN(ts)) continue;
    const originalSlug = entry.name.slice(0, lastUnderscore);
    const expiresAt = ts + TRASH_MAX_AGE_MS;
    const daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));

    const item: TrashedSeriesEntry = {
      trash_id: entry.name,
      original_slug: originalSlug,
      trashed_at: new Date(ts).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      days_remaining: daysRemaining,
    };

    // Best-effort 读 series.json 元数据
    try {
      const seriesJsonPath = path.join(TRASH_ROOT, entry.name, "series.json");
      const raw = await fs.readFile(seriesJsonPath, "utf-8");
      const data = JSON.parse(raw) as Partial<SeriesData> & {
        title?: string;
        synopsis?: string;
        episodes?: string[];
        total_cost?: number;
      };
      item.title = data.title;
      item.synopsis = data.synopsis;
      item.episode_count = Array.isArray(data.episodes) ? data.episodes.length : 0;
      item.total_cost = typeof data.total_cost === "number" ? data.total_cost : 0;
    } catch {
      // 读不到元数据不影响列出
    }

    result.push(item);
  }

  // 按删除时间倒序 (最新的先)
  result.sort((a, b) => b.trashed_at.localeCompare(a.trashed_at));
  return result;
}

/**
 * 从回收站恢复一个系列. trash_id 是目录名 (slug_timestamp).
 *
 * 如果原 slug 已被新建占用 (用户删完老 X 又新建了 X), restore 时改成 slug-restored-N
 * 防覆盖. 返回最终 slug 给前端导航.
 */
export async function restoreTrashedSeries(trashId: string): Promise<{ slug: string } | null> {
  const trashDir = path.join(TRASH_ROOT, trashId);
  if (!(await pathExists(trashDir))) return null;
  const lastUnderscore = trashId.lastIndexOf("_");
  if (lastUnderscore === -1) return null;
  const originalSlug = trashId.slice(0, lastUnderscore);

  // 防覆盖: 如果 originalSlug 已存在 (用户删完又新建同名), 改成 slug-restored
  const targetSlug = await uniqueSlug(originalSlug);
  const targetDir = seriesDir(targetSlug);
  await fs.rename(trashDir, targetDir);

  // 如果改了 slug, 还要把 series.json 内部的 slug 字段也改
  if (targetSlug !== originalSlug) {
    try {
      const seriesJsonPath = seriesFile(targetSlug);
      const raw = await fs.readFile(seriesJsonPath, "utf-8");
      const data = JSON.parse(raw) as SeriesData;
      data.slug = targetSlug;
      data.updated_at = nowISO();
      await writeJson(seriesJsonPath, data);
    } catch (err) {
      loggerSync().warn(`[restoreTrashedSeries] 改 series.json 失败 (${trashId}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return { slug: targetSlug };
}

/**
 * 永久删除回收站里一条记录. 不可恢复.
 */
export async function permanentDeleteTrashedSeries(trashId: string): Promise<boolean> {
  const trashDir = path.join(TRASH_ROOT, trashId);
  if (!(await pathExists(trashDir))) return false;
  await fs.rm(trashDir, { recursive: true, force: true });
  return true;
}

/**
 * Clean up _trash directories older than 90 days.
 * Called on server startup and after each deleteSeries.
 * Directory naming format: <slug>_<timestamp_ms>
 */
export async function cleanupTrash(): Promise<{ removed: number }> {
  if (!(await pathExists(TRASH_ROOT))) return { removed: 0 };

  const entries = await fs.readdir(TRASH_ROOT, { withFileTypes: true });
  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Parse the timestamp from the directory name (last underscore)
    const lastUnderscore = entry.name.lastIndexOf("_");
    if (lastUnderscore === -1) continue;
    const tsStr = entry.name.slice(lastUnderscore + 1);
    const ts = parseInt(tsStr, 10);
    if (isNaN(ts)) continue;

    if (now - ts > TRASH_MAX_AGE_MS) {
      try {
        await fs.rm(path.join(TRASH_ROOT, entry.name), { recursive: true, force: true });
        removed++;
      } catch (err) {
        loggerSync().warn(`[cleanupTrash] failed to remove ${entry.name}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  if (removed > 0) {
    loggerSync().info(`[cleanupTrash] removed ${removed} expired trash director${removed === 1 ? "y" : "ies"}`);
  }

  return { removed };
}

export async function duplicateSeries(slug: string): Promise<SeriesData | null> {
  const existing = await readSeries(slug);
  if (!existing) return null;
  const newSlug = await uniqueSlug(`${slug}-copy`);
  const now = nowISO();
  const newData: SeriesData = {
    ...existing,
    id: newId(),
    slug: newSlug,
    title: `${existing.title} (副本)`,
    created_at: now,
    updated_at: now,
    episodes: [],
    character_ids: [],
    scene_ids: [],
  };
  await ensureDir(seriesDir(newSlug));
  await writeJson(seriesFile(newSlug), newData);
  // Copy characters
  for (const charId of existing.character_ids) {
    const src = characterFile(slug, charId);
    if (await pathExists(src)) {
      const charData = await readJson<any>(src);
      charData.series_slug = newSlug;
      await ensureDir(charactersDir(newSlug));
      await writeJson(characterFile(newSlug, charId), charData);
      newData.character_ids.push(charId);
    }
  }
  // Copy scenes
  for (const sceneId of existing.scene_ids) {
    const src = sceneFile(slug, sceneId);
    if (await pathExists(src)) {
      const sceneData = await readJson<any>(src);
      sceneData.series_slug = newSlug;
      await ensureDir(scenesDir(newSlug));
      await writeJson(sceneFile(newSlug, sceneId), sceneData);
      newData.scene_ids.push(sceneId);
    }
  }
  await writeJson(seriesFile(newSlug), newData);
  return newData;
}

// ─── Clone Sample From Disk ──────────────────────────────────────

/** 递归复制目录 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/** 列出可用示例 */
export async function listSamples(): Promise<string[]> {
  try {
    const entries = await fs.readdir(SAMPLES_ROOT, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * 从 data/samples/<sampleId> 克隆到 data/series/sample-<timestamp>
 * 返回新的 series slug
 */
export async function cloneSampleFromDisk(sampleId: string): Promise<SeriesData | null> {
  const sampleDir = path.join(SAMPLES_ROOT, sampleId);
  if (!(await pathExists(sampleDir))) return null;

  const newSlug = await uniqueSlug(`sample-${sampleId}`);
  const now = nowISO();

  // 复制整个目录树
  await copyDirRecursive(sampleDir, seriesDir(newSlug));

  // 读取并修补 series.json
  const seriesData = await readJson<any>(seriesFile(newSlug));
  seriesData.id = newId();
  seriesData.slug = newSlug;
  seriesData.created_at = now;
  seriesData.updated_at = now;
  // 替换所有 series_slug 引用
  if (seriesData.character_ids) {
    for (const charId of seriesData.character_ids) {
      const cf = path.join(charactersDir(newSlug), `${charId}.json`);
      if (await pathExists(cf)) {
        const cd = await readJson<any>(cf);
        cd.series_slug = newSlug;
        await writeJson(cf, cd);
      }
    }
  }
  if (seriesData.scene_ids) {
    for (const sceneId of seriesData.scene_ids) {
      const sf = path.join(scenesDir(newSlug), `${sceneId}.json`);
      if (await pathExists(sf)) {
        const sd = await readJson<any>(sf);
        sd.series_slug = newSlug;
        await writeJson(sf, sd);
      }
    }
  }
  if (seriesData.episodes) {
    for (const epId of seriesData.episodes) {
      const ef = path.join(episodeDir(newSlug, epId), "episode.json");
      if (await pathExists(ef)) {
        const ed = await readJson<any>(ef);
        ed.series_slug = newSlug;
        await writeJson(ef, ed);
      }
      // Fix shots
      const shots = path.join(episodeDir(newSlug, epId), "shots");
      try {
        const shotFiles = await fs.readdir(shots);
        for (const sf of shotFiles) {
          if (!sf.endsWith(".json")) continue;
          const sData = await readJson<any>(path.join(shots, sf));
          sData.series_slug = newSlug;
          await writeJson(path.join(shots, sf), sData);
        }
      } catch { /* no shots dir */ }
      // Fix storyboard
      const sbFile = path.join(episodeDir(newSlug, epId), "storyboard.json");
      if (await pathExists(sbFile)) {
        const sb = await readJson<any>(sbFile);
        sb.series_slug = newSlug;
        await writeJson(sbFile, sb);
      }
    }
  }
  await writeJson(seriesFile(newSlug), seriesData);
  return seriesData as SeriesData;
}
