/**
 * Episode & Version Repository
 *
 * Extracted from apps/server/src/api/v2/seriesStore.ts as part of step 1
 * "拆上帝模块". Zero behavior change — code copied verbatim.
 *
 * Owns: Episode CRUD, EpisodeVersion file management, ComposeVersion listing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readJson, writeJson, ensureDir } from "../../../../packages/core/src/index";
import { readSeries } from "../api/v2/seriesStore";
import type { EpisodeData } from "../../../../packages/drama/src/types";
import {
  seriesDir,
  seriesFile,
  episodeDir,
  episodeFile,
  shotsDir,
  versionsDir,
  versionFilePath,
} from "./_paths";

// ─── Private file-level write mutex (copied from seriesStore) ──

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

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Compose Versions ────────────────────────────────────────────

export interface ComposeVersion {
  /** Absolute path to the mp4 file */
  path: string;
  /** Filename only (e.g. "rough_1715900000000.mp4" or "final.mp4") */
  filename: string;
  /** Compose mode: "rough" or "full" */
  mode: "rough" | "full";
  /** File modification time as ISO string */
  created_at: string;
  /** File size in bytes */
  size_bytes: number;
}

/**
 * List completed compose outputs and numbered snapshots for an episode.
 * Intermediate source/shot segments remain on disk but are not user-facing versions.
 * Determines mode from filename: "rough_<timestamp>.mp4" = rough, "final.mp4"/"final_v<N>.mp4" = full.
 * W11 D4 (2026-05-27): 同时列出 final_v<N>.mp4 历史快照 — 用户原话"数据保留 > 直接删除" (铁律 #6).
 * Sorted newest first.
 */
export async function listComposeVersions(slug: string, epId: string): Promise<ComposeVersion[]> {
  const composeDir = path.join(episodeDir(slug, epId), "compose");
  if (!(await pathExists(composeDir))) return [];
  const entries = await fs.readdir(composeDir);
  const results: ComposeVersion[] = [];
  for (const entry of entries) {
    if (!/^(?:final(?:_v\d+)?|rough_\d+)\.mp4$/.test(entry)) continue;
    // W11 D4: 跳过 _trash 软删目录 (用户可以恢复, 但默认不出现在版本列表)
    // _trash 是子目录, readdir 不会进, 这里只是显式说明
    const fp = path.join(composeDir, entry);
    try {
      const stat = await fs.stat(fp);
      if (!stat.isFile()) continue;
      const isRough = entry.startsWith("rough_");
      results.push({
        path: fp,
        filename: entry,
        mode: isRough ? "rough" : "full",
        created_at: stat.mtime.toISOString(),
        size_bytes: stat.size,
      });
    } catch {
      // file disappeared or unreadable, skip
    }
  }
  return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ─── Episode CRUD ───────────────────────────────────────────────

export interface EpisodeVersion {
  version: number;
  created_at: string;
  source: "ai_init" | "user_edit" | "ai_revise" | "revert";
  summary?: string;
  script_md: string;
}

// Step2: EpisodeData 单源化到 packages/drama/src/types.ts。re-export 保持下游 import 不破。
export type { EpisodeData };

const GENERATED_FALLBACK_NOTE_RE =
  /(?:^|\n)\s*>?\s*注[:：]\s*LLM\s*调用链路全部失败(?:[（(][\s\S]*?[）)])?\s*[。.]?\s*请检查设置\s*→\s*Providers\s*[。.]?\s*以下为原始灵感文本[。.]?/g;

export function stripGeneratedFallbackNote(scriptMd: string | undefined): string | undefined {
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

function sanitizeEpisodeVersion(version: EpisodeVersion): EpisodeVersion {
  return {
    ...version,
    summary: stripFallbackSummary(version.summary),
    script_md: stripGeneratedFallbackNote(version.script_md) ?? version.script_md,
  };
}

function sanitizeEpisode(episode: EpisodeData): EpisodeData {
  return {
    ...episode,
    script_md: stripGeneratedFallbackNote(episode.script_md) ?? episode.script_md,
    versions: episode.versions?.map((v) => sanitizeEpisodeVersion(v)),
  };
}

// D-N1 (2026-05-12): list 端点加分页防御. 默认 1000 上限避免单 series 集数失控时
// 前端首屏拉全部. 调用方可显式传 { limit, offset } 翻页.
export async function listEpisodes(
  slug: string,
  opts?: { limit?: number; offset?: number },
): Promise<EpisodeData[]> {
  const ed = path.join(seriesDir(slug), "episodes");
  if (!(await pathExists(ed))) return [];
  const entries = await fs.readdir(ed, { withFileTypes: true });
  const results: EpisodeData[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ef = episodeFile(slug, entry.name);
    if (await pathExists(ef)) {
      try { const ep = await readJson<EpisodeData>(ef); if (ep) results.push(sanitizeEpisode(ep)); } catch { /* skip */ }
    }
  }
  const sorted = results.sort((a, b) => a.index - b.index);
  const offset = Math.max(0, opts?.offset ?? 0);
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, 1000));
  return sorted.slice(offset, offset + limit);
}

export async function readEpisode(slug: string, epId: string): Promise<EpisodeData | null> {
  const ef = episodeFile(slug, epId);
  if (!(await pathExists(ef))) return null;
  const episode = await readJson<EpisodeData>(ef);
  return episode ? sanitizeEpisode(episode) : null;
}

export async function createEpisode(slug: string, input: { title?: string; index?: number; overrides?: Record<string, any> }): Promise<EpisodeData> {
  // 2026-05-18 EVE-6: 修 id collision bug — 旧逻辑 epId = `ep${existing.length+1}`,
  // 软删某集后 listEpisodes 长度减一,新 epId 撞已存在 ep05 → writeJson 覆盖 + series.episodes
  // 重复 push → 前端报"集不存在"(因为新 id 实际指向旧 episode 但数据被搞乱)
  //
  // 修复: 用 series.episodes 数组里所有 ep id (含历史) + ep dir 实际存在的目录(防孤儿目录)
  //       双重去重, 取最大数字 +1 直到找到不冲突 id
  const existing = await listEpisodes(slug);
  const series = await readSeries(slug);
  const seriesEpisodeIds = new Set(series?.episodes ?? []);
  const dirEpisodeIds = new Set(existing.map((e) => e.id));
  // 综合 series 列表 + 物理目录, 取所有用过的 ep id
  const usedIds = new Set([...seriesEpisodeIds, ...dirEpisodeIds]);
  const maxNum = Array.from(usedIds).reduce((max, id) => {
    const m = id.match(/^ep(\d+)$/);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  let nextNum = Math.max(maxNum + 1, existing.length + 1);
  let epId = `ep${String(nextNum).padStart(2, "0")}`;
  // 双保险: 如果 epId 仍冲突(罕见, 历史脏数据), 递增直到不冲突
  while (usedIds.has(epId) || await pathExists(episodeFile(slug, epId))) {
    nextNum += 1;
    epId = `ep${String(nextNum).padStart(2, "0")}`;
    if (nextNum > 10000) throw new Error("Episode id allocation runaway");
  }
  const data: EpisodeData = {
    id: epId,
    series_slug: slug,
    index: input.index ?? nextNum,
    title: input.title ?? `第${nextNum}集`,
    status: "drafted",
    overrides: input.overrides,
  };
  await ensureDir(episodeDir(slug, epId));
  await ensureDir(shotsDir(slug, epId));
  await writeJson(episodeFile(slug, epId), data);
  // Update series (复用上面读到的 series, 避免再读一遍)
  if (series) {
    // 防止重复 push (软删后又新建,旧 id 可能在 series.episodes 但目录已 .trash)
    if (!series.episodes.includes(epId)) {
      series.episodes.push(epId);
    }
    series.updated_at = nowISO();
    await writeJson(seriesFile(slug), series);
  }
  return data;
}

export async function updateEpisode(slug: string, epId: string, patch: Partial<EpisodeData>): Promise<EpisodeData | null> {
  return withWriteLock(episodeFile(slug, epId), async () => {
    const existing = await readEpisode(slug, epId);
    if (!existing) return null;
    const updated = sanitizeEpisode({
      ...existing,
      ...patch,
      id: existing.id,
      series_slug: existing.series_slug,
      script_md: patch.script_md !== undefined ? stripGeneratedFallbackNote(patch.script_md) ?? patch.script_md : existing.script_md,
      versions: patch.versions !== undefined
        ? patch.versions.map((v) => sanitizeEpisodeVersion(v))
        : existing.versions,
    });
    await writeJson(episodeFile(slug, epId), updated);
    return updated;
  });
}

/**
 * 2026-05-19 #14 软删 — 用户原话"删除走二次确认 + 软删到垃圾桶, 可恢复".
 * 铁律 #6 数据保留 > 直接删除. 之前 fs.rm recursive force 是硬删除, 违反铁律.
 *
 * 行为:
 *   - 把 episode 目录 rename 到 .trash/<epId>_<timestamp>
 *   - series.episodes 列表移除 epId (前端就看不到了)
 *   - 90 天后可加扫描脚本清理 .trash (TODO 单独工程)
 */
export async function deleteEpisode(slug: string, epId: string): Promise<boolean> {
  const ed = episodeDir(slug, epId);
  if (!(await pathExists(ed))) return false;
  // 软删: rename 到 .trash/<epId>_<unix-ts>
  const series = await readSeries(slug);
  const trashRoot = ed.replace(/[/\\]([^/\\]+)$/, ""); // episodes 目录
  const trashDir = `${trashRoot}/.trash`;
  await fs.mkdir(trashDir, { recursive: true });
  const timestamp = Date.now();
  const trashTarget = `${trashDir}/${epId}_${timestamp}`;
  try {
    await fs.rename(ed, trashTarget);
  } catch (renameErr) {
    // Windows 偶发 EBUSY/EPERM — fallback 复制 + 删除(确保不丢数据)
    try {
      await fs.cp(ed, trashTarget, { recursive: true, force: false });
      await fs.rm(ed, { recursive: true, force: true });
    } catch (cpErr) {
      const msg = renameErr instanceof Error ? renameErr.message : String(renameErr);
      const msg2 = cpErr instanceof Error ? cpErr.message : String(cpErr);
      throw new Error(`移到回收站失败: ${msg} / ${msg2}`);
    }
  }
  if (series) {
    series.episodes = series.episodes.filter(e => e !== epId);
    series.updated_at = nowISO();
    await writeJson(seriesFile(slug), series);
  }
  return true;
}

// ─── 分集回收站 (2026-07-22 X6-2 / A3-8) ─────────────────────────
// deleteEpisode 把 episodes/<epId> 整目录 rename 到 episodes/.trash/<epId>_<ts>, 但历史**只有删无恢复** →
// 前端"90 天可恢复"是空头承诺 (公理 B: 状态不许撒谎 + 铁律 #6: 软删必须真能恢复)。这里补 list/restore/permanent
// 三件套, 让误删一集能一键搬回 (整份分镜 + picked 指针 + 版本历史 + 合成索引随目录整体回来)。

/** episodes/.trash 目录 (deleteEpisode 的落盘处)。 */
function episodesTrashDir(slug: string): string {
  return path.join(seriesDir(slug), "episodes", ".trash");
}

/** 从 trash 目录名 "<epId>_<ts>" 取出原 epId (剥尾部 _<纯数字>)。 */
function trashDirToEpisodeId(trashDirName: string): string {
  return trashDirName.replace(/_\d+$/, "");
}

/** 路径遍历防御: trashId 必须是单层安全段名 (无分隔符/无 ..)。用户传入前置校验。 */
function isSafeTrashSegment(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("..") && path.basename(id) === id;
}

export interface TrashedEpisodeEntry {
  trash_id: string;      // "<epId>_<ts>" — 目录名
  episode_id: string;    // 原 epId
  title?: string;
  index?: number;
  trashed_at: string;    // ISO (从目录名尾部时间戳)
  shot_count: number;    // best-effort (数 shots/*.json)
}

/** 列出该系列回收站里的分集 (按 trashed_at desc)。 */
export async function listTrashedEpisodes(slug: string): Promise<TrashedEpisodeEntry[]> {
  const trashRoot = episodesTrashDir(slug);
  if (!(await pathExists(trashRoot))) return [];
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(trashRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: TrashedEpisodeEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const trashId = d.name;
    const m = trashId.match(/^(.+)_(\d+)$/);
    if (!m) continue;
    const episodeId = m[1];
    const ts = Number(m[2]);
    let title: string | undefined;
    let index: number | undefined;
    try {
      const ep = await readJson<EpisodeData>(path.join(trashRoot, trashId, "episode.json"));
      if (ep) { title = ep.title; index = ep.index; }
    } catch { /* 读不出用兜底 */ }
    let shotCount = 0;
    try {
      const shotFiles = await fs.readdir(path.join(trashRoot, trashId, "shots"));
      shotCount = shotFiles.filter((f) => f.endsWith(".json")).length;
    } catch { /* 无 shots 目录 */ }
    results.push({
      trash_id: trashId,
      episode_id: episodeId,
      title,
      index,
      trashed_at: Number.isFinite(ts) ? new Date(ts).toISOString() : new Date(0).toISOString(),
      shot_count: shotCount,
    });
  }
  return results.sort((a, b) => b.trashed_at.localeCompare(a.trashed_at));
}

/**
 * 恢复一集: episodes/.trash/<trashId> → episodes/<epId>, 并把 epId 加回 series.episodes。
 * 防覆盖: 原 epId 已被新集占用(编号复用)→ 报 conflict, 绝不静默盖 (A3-8)。
 */
export async function restoreTrashedEpisode(
  slug: string, trashId: string,
): Promise<{ ok: boolean; episode_id?: string; reason?: "not_found" | "conflict" }> {
  if (!isSafeTrashSegment(trashId)) return { ok: false, reason: "not_found" };
  const trashRoot = episodesTrashDir(slug);
  const srcDir = path.join(trashRoot, trashId);
  if (!(await pathExists(srcDir))) return { ok: false, reason: "not_found" };
  const epId = trashDirToEpisodeId(trashId);
  const destDir = episodeDir(slug, epId);
  // 防覆盖: 原 epId 已被新集占用 → conflict (别静默盖掉新集)。
  if (await pathExists(destDir)) return { ok: false, reason: "conflict" };
  try {
    await fs.rename(srcDir, destDir);
  } catch {
    // Windows EBUSY/EPERM fallback: cp + rm (确保不丢数据)
    try {
      await fs.cp(srcDir, destDir, { recursive: true, force: false });
      await fs.rm(srcDir, { recursive: true, force: true });
    } catch {
      return { ok: false, reason: "not_found" };
    }
  }
  // 把 epId 加回 series.episodes (防重复 push)。
  const series = await readSeries(slug);
  if (series && !series.episodes.includes(epId)) {
    series.episodes.push(epId);
    series.updated_at = nowISO();
    await writeJson(seriesFile(slug), series);
  }
  return { ok: true, episode_id: epId };
}

/** 永久删除回收站里的一集 (物理删除, 不可恢复)。 */
export async function permanentDeleteTrashedEpisode(slug: string, trashId: string): Promise<boolean> {
  if (!isSafeTrashSegment(trashId)) return false;
  const srcDir = path.join(episodesTrashDir(slug), trashId);
  if (!(await pathExists(srcDir))) return false;
  try {
    await fs.rm(srcDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ─── Version File Management ─────────────────────────────────────

/**
 * Save a single version record as a file on disk.
 * Path: episodes/<epId>/versions/v<N>.json
 */
export async function saveVersionFile(slug: string, epId: string, record: EpisodeVersion): Promise<void> {
  await ensureDir(versionsDir(slug, epId));
  await writeJson(versionFilePath(slug, epId, record.version), record);
}

/**
 * Load all version files from disk for an episode, sorted by version ascending.
 */
export async function loadVersionFiles(slug: string, epId: string): Promise<EpisodeVersion[]> {
  const vd = versionsDir(slug, epId);
  if (!(await pathExists(vd))) return [];
  const entries = await fs.readdir(vd);
  const records: EpisodeVersion[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const item = await readJson<EpisodeVersion>(path.join(vd, entry)); if (item) records.push(sanitizeEpisodeVersion(item));
    } catch { /* skip corrupted */ }
  }
  return records.sort((a, b) => a.version - b.version);
}

/**
 * Read a single version file by version number.
 */
export async function readVersionFile(slug: string, epId: string, version: number): Promise<EpisodeVersion | null> {
  const fp = versionFilePath(slug, epId, version);
  if (!(await pathExists(fp))) return null;
  const record = await readJson<EpisodeVersion>(fp);
  return record ? sanitizeEpisodeVersion(record) : null;
}

/**
 * Create a new version: save version file to disk + update episode metadata.
 * Returns the newly created version record.
 */
export async function createVersion(
  slug: string,
  epId: string,
  script_md: string,
  source: EpisodeVersion["source"],
  summary?: string,
): Promise<EpisodeVersion> {
  const episode = await readEpisode(slug, epId);
  const currentVersion = episode?.version ?? 0;
  const newVersion = currentVersion + 1;

  const record: EpisodeVersion = {
    version: newVersion,
    created_at: nowISO(),
    source,
    summary: stripFallbackSummary(summary),
    script_md: stripGeneratedFallbackNote(script_md) ?? script_md,
  };

  // Save as file on disk
  await saveVersionFile(slug, epId, record);

  // Update episode metadata (inline array + version counter)
  if (episode) {
    if (!episode.versions) episode.versions = [];
    episode.versions.push(record);
    episode.version = newVersion;
    await updateEpisode(slug, epId, { version: newVersion, versions: episode.versions });
  }

  return record;
}
