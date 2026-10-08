/**
 * Asset repository — extracted from seriesStore.ts (step 1: 按聚合根拆上帝模块).
 * 零行为变更, 逐字搬运. 重复 helper 是有意为之.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { outputsRoot, pathExists, readJson, writeJson, ensureDir } from "../../../../packages/core/src/index";
import { migrateToLatest } from "../../../../packages/core/src/migrations";
import { seriesDir, assetsDir, assetIndexFile, isPathInside, DATA_ROOT, repoRoot } from "./_paths";
import { remapLegacyWorkspacePath } from "../../../../packages/core/src/workspaceMedia";

// Y2 (UP-2, 2026-07-22): 旧根 (仓库内 <repo>/data) 一次性搬家提示, 只 warn 一次不刷屏。
let _legacyRootWarned = false;
function warnLegacyRootOnce(slug: string): void {
  if (_legacyRootWarned) return;
  _legacyRootWarned = true;
  console.warn(
    `[assetRepo] 检测到存量素材仍散落在仓库内 <repo>/data/series/ (历史存储根写错遗留, 系列: ${slug})。` +
    `已通过只读兜底正常读取; 建议将 <repo>/data/series/ 下的文件迁移到 DATA_ROOT (${DATA_ROOT}) 同相对路径以彻底收口。`,
  );
}

/**
 * 解析素材相对/绝对 path → 磁盘绝对路径 (仅解析 + 越权校验, 不保证文件存在)。
 *
 * Y2 追加 (UP-2, 主 Fable 裁定 · 数据保留公理): DATA_ROOT 侧找不到实体文件时, 回查
 * 仓库内 <repo>/data/series/<slug>/<相对路径> 旧根 (历史"存储根写错"遗留的散落资产),
 * 只读兜底 + 一次性搬家提示。保证存量导入的参考图不因根迁移而 404。
 */
export function resolveAssetFilePath(slug: string, assetPath?: string | null): string | null {
  if (!assetPath || typeof assetPath !== "string") return null;

  const normalizedAssetPath = path.normalize(remapLegacyWorkspacePath(assetPath));
  const allowedRoots = [
    seriesDir(slug),
    path.join(outputsRoot, "series", slug),
    path.join(outputsRoot, slug),
  ];

  if (path.isAbsolute(normalizedAssetPath)) {
    const resolved = path.resolve(normalizedAssetPath);
    return allowedRoots.some((root) => isPathInside(root, resolved)) ? resolved : null;
  }

  const resolved = path.resolve(seriesDir(slug), normalizedAssetPath);
  if (!isPathInside(seriesDir(slug), resolved)) return null;

  // 旧根兜底: 仅当 DATA_ROOT 为外置根 (非 <repo>/data) 且 DATA_ROOT 侧文件不存在、
  // 而仓库内旧根存在时, 返回旧根路径。默认根 (DATA_ROOT === <repo>/data) 时旧根即本根, 不触发。
  const legacyDataRoot = path.join(repoRoot, "data");
  if (DATA_ROOT !== legacyDataRoot && !existsSync(resolved)) {
    const legacySeriesDir = path.join(legacyDataRoot, "series", slug);
    const legacyResolved = path.resolve(legacySeriesDir, normalizedAssetPath);
    if (isPathInside(legacySeriesDir, legacyResolved) && existsSync(legacyResolved)) {
      warnLegacyRootOnce(slug);
      return legacyResolved;
    }
  }

  return resolved;
}

// ─── Private helpers (复制自 seriesStore) ──────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

async function readJsonl(filePath: string): Promise<any[]> {
  if (!(await pathExists(filePath))) return [];
  const content = await fs.readFile(filePath, "utf8");
  const entries: any[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // E3: apply global schema version migration to each JSONL entry
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(migrateToLatest(parsed as Record<string, unknown>));
      } else {
        entries.push(parsed);
      }
    } catch { /* skip */ }
  }
  return entries;
}

// T3: in-process mutex per file path — prevents JSONL line-sticking under concurrent appends
const _appendLocks = new Map<string, Promise<void>>();

async function appendJsonl(filePath: string, entry: any): Promise<void> {
  const prev = _appendLocks.get(filePath) ?? Promise.resolve();
  let resolveLock!: () => void;
  const lock = new Promise<void>((r) => { resolveLock = r; });
  _appendLocks.set(filePath, prev.then(() => lock));
  try {
    await prev;
    await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
  } finally {
    resolveLock();
    // GC: if no more waiters, drop the entry
    if (_appendLocks.get(filePath) === lock) _appendLocks.delete(filePath);
  }
}

// ─── Asset CRUD ─────────────────────────────────────────────────

export interface AssetEntry {
  asset_id: string;
  series_slug: string;
  kind: "image" | "video" | "audio";
  tags: string[];
  path: string;
  filename: string;
  /** Y2 (UP-2): 用户可见的人话展示名 (display_name 铁律#2). 导入登记时写入, 绝不拿 asset_id 见人。 */
  display_name?: string;
  mime: string;
  size_bytes: number;
  sha256?: string;
  created_at: string;
  shot_id?: string;
  generation_id?: string;
}

export const ASSET_TRASH_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface TrashedAssetEntry {
  trash_id: string;
  asset_id: string;
  kind: AssetEntry["kind"];
  filename: string;
  original_path: string;
  trashed_path?: string;
  deleted_at: string;
  expires_at: string;
  asset: AssetEntry;
  days_remaining: number;
  expired: boolean;
}

interface AssetTrashManifestEntry {
  trash_id: string;
  asset_id: string;
  kind: AssetEntry["kind"];
  filename: string;
  original_path: string;
  trashed_path?: string;
  deleted_at: string;
  expires_at: string;
  asset: AssetEntry;
}

interface AssetTrashManifest {
  entries: AssetTrashManifestEntry[];
}

function assetTrashRoot(slug: string): string {
  return path.join(seriesDir(slug), "_asset_trash");
}

function assetTrashFilesDir(slug: string): string {
  return path.join(assetTrashRoot(slug), "files");
}

function assetTrashManifestFile(slug: string): string {
  return path.join(assetTrashRoot(slug), "manifest.json");
}

function safeTrashFileName(name: string): string {
  const base = path.basename(name || "asset.bin");
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 180) || "asset.bin";
}

async function readAssetTrashManifest(slug: string): Promise<AssetTrashManifest> {
  const file = assetTrashManifestFile(slug);
  if (!(await pathExists(file))) return { entries: [] };
  const data = await readJson<AssetTrashManifest>(file);
  return data ?? { entries: [] };
}

async function writeAssetTrashManifest(slug: string, manifest: AssetTrashManifest): Promise<void> {
  await ensureDir(assetTrashRoot(slug));
  await writeJson(assetTrashManifestFile(slug), manifest);
}

async function writeAssetIndex(slug: string, entries: AssetEntry[]): Promise<void> {
  await ensureDir(assetsDir(slug));
  const indexPath = assetIndexFile(slug);
  const tmpPath = indexPath + ".tmp";
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, indexPath);
  _assetCache.set(slug, { entries, loaded_at: Date.now() });
}

function isDeletedAsset(entry: AssetEntry): boolean {
  return Boolean((entry as AssetEntry & { deleted_at?: string }).deleted_at);
}

function resolveAssetTargetPath(slug: string, assetPath?: string | null): string | null {
  if (!assetPath || typeof assetPath !== "string") return null;

  const normalizedAssetPath = path.normalize(assetPath);
  const allowedRoots = [
    seriesDir(slug),
    path.join(outputsRoot, "series", slug),
    path.join(outputsRoot, slug),
  ];

  if (path.isAbsolute(normalizedAssetPath)) {
    const resolved = path.resolve(normalizedAssetPath);
    return allowedRoots.some((root) => isPathInside(root, resolved)) ? resolved : null;
  }

  const resolved = path.resolve(seriesDir(slug), normalizedAssetPath);
  return isPathInside(seriesDir(slug), resolved) ? resolved : null;
}

function restoredPathValue(slug: string, originalPath: string, restoredAbsPath: string): string {
  if (path.isAbsolute(path.normalize(originalPath))) return restoredAbsPath;
  return path.relative(seriesDir(slug), restoredAbsPath).replace(/\\/g, "/");
}

function avoidRestoreCollision(absPath: string): string {
  const dir = path.dirname(absPath);
  const ext = path.extname(absPath);
  const base = path.basename(absPath, ext);
  return path.join(dir, `${base}_restored_${Date.now()}${ext}`);
}

function resolveTrashFilePath(slug: string, trashedPath?: string): string | null {
  if (!trashedPath) return null;
  const resolved = path.resolve(seriesDir(slug), trashedPath);
  return isPathInside(assetTrashRoot(slug), resolved) ? resolved : null;
}

async function moveAssetFileToTrash(slug: string, asset: AssetEntry, trashId: string): Promise<string | undefined> {
  const srcPath = resolveAssetFilePath(slug, asset.path);
  if (!srcPath || !(await pathExists(srcPath))) return undefined;

  await ensureDir(assetTrashFilesDir(slug));
  const filename = safeTrashFileName(asset.filename || asset.path || asset.asset_id);
  const destPath = path.join(assetTrashFilesDir(slug), `${trashId}__${filename}`);
  try {
    await fs.rename(srcPath, destPath);
  } catch {
    await fs.copyFile(srcPath, destPath);
    await fs.unlink(srcPath);
  }
  return path.relative(seriesDir(slug), destPath).replace(/\\/g, "/");
}

function findTrashedAsset(manifest: AssetTrashManifest, idOrTrashId: string): AssetTrashManifestEntry | undefined {
  return manifest.entries.find((e) => e.trash_id === idOrTrashId || e.asset_id === idOrTrashId);
}

// ─── Asset Cache ──────────────────────────────────────────────────

const _assetCache = new Map<string, { entries: AssetEntry[]; loaded_at: number }>();
const ASSET_CACHE_TTL = 30_000; // 30 seconds

async function getCachedAssets(slug: string): Promise<AssetEntry[]> {
  const cached = _assetCache.get(slug);
  if (cached && (Date.now() - cached.loaded_at) < ASSET_CACHE_TTL) {
    return cached.entries;
  }
  const entries = await readJsonl(assetIndexFile(slug));
  _assetCache.set(slug, { entries, loaded_at: Date.now() });
  return entries;
}

export async function listAssets(slug: string, filter?: { kind?: string; tags?: string[]; limit?: number; offset?: number }): Promise<AssetEntry[]> {
  const entries = await getCachedAssets(slug);
  let results = entries.filter((e) => !isDeletedAsset(e));
  if (filter?.kind) results = results.filter(e => e.kind === filter.kind);
  if (filter?.tags && filter.tags.length > 0) {
    results = results.filter(e => filter.tags!.some(t => e.tags?.includes(t)));
  }
  const offset = filter?.offset ?? 0;
  const limit = filter?.limit ?? 100;
  return results.slice(offset, offset + limit);
}

export async function readAsset(slug: string, assetId: string): Promise<AssetEntry | null> {
  const entries = await getCachedAssets(slug);
  return entries.find(e => e.asset_id === assetId && !isDeletedAsset(e)) ?? null;
}

export async function addAsset(slug: string, entry: Omit<AssetEntry, "asset_id" | "created_at">): Promise<AssetEntry> {
  const full: AssetEntry = {
    ...entry,
    asset_id: `asset_${Date.now()}_${crypto.randomUUID().slice(0, 12)}`,
    created_at: nowISO(),
  };
  await ensureDir(assetsDir(slug));
  await appendJsonl(assetIndexFile(slug), full);
  // Update cache: append to cached entries if present
  const cached = _assetCache.get(slug);
  if (cached) {
    cached.entries.push(full);
    cached.loaded_at = Date.now();
  }
  return full;
}

export async function listTrashedAssets(slug: string): Promise<TrashedAssetEntry[]> {
  await cleanupAssetTrash(slug).catch(() => {});
  const manifest = await readAssetTrashManifest(slug);
  const now = Date.now();
  return manifest.entries
    .map((entry) => {
      const expiresMs = new Date(entry.expires_at).getTime();
      const remainingMs = expiresMs - now;
      return {
        ...entry,
        days_remaining: Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))),
        expired: remainingMs <= 0,
      };
    })
    .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
}

export async function softDeleteAsset(slug: string, assetId: string): Promise<TrashedAssetEntry | null> {
  await cleanupAssetTrash(slug).catch(() => {});
  const entries = await readJsonl(assetIndexFile(slug));
  const idx = entries.findIndex(e => e.asset_id === assetId && !isDeletedAsset(e));
  if (idx === -1) return null;
  const removed = entries.splice(idx, 1)[0];
  const nowMs = Date.now();
  const trashId = `${assetId}__${nowMs}`;
  const trashedPath = await moveAssetFileToTrash(slug, removed, trashId);
  const deletedAt = new Date(nowMs).toISOString();
  const manifestEntry: AssetTrashManifestEntry = {
    trash_id: trashId,
    asset_id: assetId,
    kind: removed.kind,
    filename: removed.filename,
    original_path: removed.path,
    trashed_path: trashedPath,
    deleted_at: deletedAt,
    expires_at: new Date(nowMs + ASSET_TRASH_MAX_AGE_MS).toISOString(),
    asset: removed,
  };

  await writeAssetIndex(slug, entries);
  const manifest = await readAssetTrashManifest(slug);
  manifest.entries.push(manifestEntry);
  await writeAssetTrashManifest(slug, manifest);

  const remainingMs = new Date(manifestEntry.expires_at).getTime() - Date.now();
  return {
    ...manifestEntry,
    days_remaining: Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))),
    expired: remainingMs <= 0,
  };
}

export async function restoreAsset(slug: string, idOrTrashId: string): Promise<AssetEntry | null> {
  const manifest = await readAssetTrashManifest(slug);
  const entry = findTrashedAsset(manifest, idOrTrashId);
  if (!entry) return null;

  const active = await readAsset(slug, entry.asset_id);
  if (active) {
    manifest.entries = manifest.entries.filter((e) => e.trash_id !== entry.trash_id);
    await writeAssetTrashManifest(slug, manifest);
    return active;
  }

  let restoredAsset = { ...entry.asset };
  const trashFilePath = resolveTrashFilePath(slug, entry.trashed_path);
  const targetPath = resolveAssetTargetPath(slug, entry.original_path);
  if (trashFilePath && targetPath && await pathExists(trashFilePath)) {
    let finalTargetPath = targetPath;
    if (await pathExists(finalTargetPath)) finalTargetPath = avoidRestoreCollision(finalTargetPath);
    await ensureDir(path.dirname(finalTargetPath));
    try {
      await fs.rename(trashFilePath, finalTargetPath);
    } catch {
      await fs.copyFile(trashFilePath, finalTargetPath);
      await fs.unlink(trashFilePath);
    }
    restoredAsset = { ...restoredAsset, path: restoredPathValue(slug, entry.original_path, finalTargetPath) };
  }

  const entries = await readJsonl(assetIndexFile(slug));
  if (!entries.some((e) => e.asset_id === restoredAsset.asset_id && !isDeletedAsset(e))) {
    entries.push(restoredAsset);
    await writeAssetIndex(slug, entries);
  }
  manifest.entries = manifest.entries.filter((e) => e.trash_id !== entry.trash_id);
  await writeAssetTrashManifest(slug, manifest);
  return restoredAsset;
}

export async function permanentlyDeleteAsset(slug: string, idOrTrashId: string): Promise<boolean> {
  const manifest = await readAssetTrashManifest(slug);
  const entry = findTrashedAsset(manifest, idOrTrashId);
  if (!entry) return false;

  const trashFilePath = resolveTrashFilePath(slug, entry.trashed_path);
  if (trashFilePath && isPathInside(assetTrashRoot(slug), trashFilePath)) {
    await fs.unlink(trashFilePath).catch(() => {});
  }
  manifest.entries = manifest.entries.filter((e) => e.trash_id !== entry.trash_id);
  await writeAssetTrashManifest(slug, manifest);
  return true;
}

export async function cleanupAssetTrash(slug: string): Promise<number> {
  const manifest = await readAssetTrashManifest(slug);
  const now = Date.now();
  const keep: AssetTrashManifestEntry[] = [];
  let removed = 0;

  for (const entry of manifest.entries) {
    if (new Date(entry.expires_at).getTime() > now) {
      keep.push(entry);
      continue;
    }
    const trashFilePath = resolveTrashFilePath(slug, entry.trashed_path);
    if (trashFilePath && isPathInside(assetTrashRoot(slug), trashFilePath)) {
      await fs.unlink(trashFilePath).catch(() => {});
    }
    removed += 1;
  }

  if (removed > 0) {
    await writeAssetTrashManifest(slug, { entries: keep });
  }
  return removed;
}

export async function deleteAsset(slug: string, assetId: string): Promise<boolean> {
  return (await softDeleteAsset(slug, assetId)) !== null;
}

export async function getAssetThumbnailPath(slug: string, assetId: string, size: number): Promise<string | null> {
  const asset = await readAsset(slug, assetId);
  if (!asset) return null;
  // For now, return the original path (thumbnail generation is future work)
  const fullPath = resolveAssetFilePath(slug, asset.path);
  return (fullPath && await pathExists(fullPath)) ? fullPath : null;
}
