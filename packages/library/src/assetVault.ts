/**
 * AssetVault — 资产永久归档层
 *
 * 用户付费原则: provider 返回的图片/视频永不删除,只软归档到 vault。
 * 盘上布局:
 *   data/vault/
 *   ├── index.jsonl          append-only 记录 (每行带 schema_version)
 *   ├── images/<yyyy-mm>/    <ulid>.png
 *   ├── videos/<yyyy-mm>/    <ulid>.mp4
 *   ├── trash/<ulid>.json    废案记录 (带 schema_version)
 *   └── exports/             导出 zip 快照
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ulid } from "ulid";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { VAULT_ROOT, ensureDir, pathExists } from "../../core/src/index";
import { migrateToLatest } from "../../core/src/migrations.js";
import { CURRENT_SCHEMA_VERSION } from "./jsonlIndex.js";

const MAX_PATH_WARN_LENGTH = 240;

// ─── Paths ─────────────────────────────────────────────────────────────
// VAULT_ROOT imported from packages/core/src/paths.ts

const INDEX_PATH = path.join(VAULT_ROOT, "index.jsonl");
const IMAGES_DIR = path.join(VAULT_ROOT, "images");
const VIDEOS_DIR = path.join(VAULT_ROOT, "videos");
const TRASH_DIR = path.join(VAULT_ROOT, "trash");
const EXPORTS_DIR = path.join(VAULT_ROOT, "exports");
const THUMBNAILS_DIR = path.join(VAULT_ROOT, "thumbnails");

// ─── Types ─────────────────────────────────────────────────────────────

export type VaultKind = "image" | "video";
export type VaultStatus = "active" | "trashed";

export interface VaultContext {
  kind: "library_ref" | "shot_first_frame" | "shot_video" | "variant" | "inpaint" | "rough_cut" | "user_upload" | "last_frame_of" | "mood_board" | "character_ref" | "scene_ref";
  series_slug?: string;
  character_id?: string;
  scene_id?: string;
  shot_id?: string;
  prompt_digest_sha256?: string;
  parent_vault_id?: string;
  user_note?: string;
  /** 用户可改的展示名,不等于真实文件名 */
  display_name?: string;
  /** 跨项目导入来源标识，格式: <fromSlug>/<elementId>/<imageId> */
  imported_from?: string;
}

export interface VaultEntry {
  vault_id: string;
  schema_version: number;
  kind: VaultKind;
  path: string;
  bytes: number;
  mime: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  sha256: string;
  provider_id?: string;
  model_id?: string;
  cost_cny?: number;
  created_at: string;
  context: VaultContext;
  /** 用户可改的展示名,用于公共素材/废案库等跨项目场景 */
  display_name?: string;
  tags: string[];
  status: VaultStatus;
  /** ISO timestamp when moved to trash (set by moveToTrash, used by cleanupOldTrash) */
  trashed_at?: string;
  /** B2: 4-item quality scores from postGenCheck. 2026-05-18: 任一维度可能 undefined (未评分) */
  quality_scores?: {
    composition?: number;
    sharpness?: number;
    prompt_alignment?: number;
    subject_completeness?: number;
    checked_at: string;
  };
}

export interface VaultListFilter {
  kind?: VaultKind;
  series_slug?: string;
  character_id?: string;
  scene_id?: string;
  shot_id?: string;
  status?: VaultStatus;
  since?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface TrashRecord {
  vault_id: string;
  schema_version: number;
  moved_at: string;
  reason?: string;
}

export interface VaultStats {
  total: number;
  images: number;
  videos: number;
  trashed: number;
  total_bytes: number;
}

/** 2026-05-25 C1: 成本统计 — 多维聚合 vault cost_cny 字段, 给驾驶舱可视化 */
export interface VaultCostStats {
  /** 全部活跃归档累计成本 (¥) */
  total_cny: number;
  /** 全部活跃归档条目数 (cost_cny > 0 的) */
  total_paid_entries: number;
  /** 本自然月累计成本 */
  this_month_cny: number;
  /** 本自然月条目数 */
  this_month_entries: number;
  /** 按 provider 聚合, desc 排序, 仅 cost > 0 */
  by_provider: Array<{ provider_id: string; cost_cny: number; count: number }>;
  /** 按 series_slug 聚合, desc 排序, 仅 cost > 0 */
  by_series: Array<{ series_slug: string; cost_cny: number; count: number }>;
  /** 近 6 个自然月趋势, asc 排序 (旧 → 新) */
  by_month: Array<{ month: string; cost_cny: number; count: number }>;
}

export interface SaveToVaultParams {
  buffer: Buffer;
  kind: VaultKind;
  mime: string;
  context: VaultContext;
  provider_id?: string;
  model_id?: string;
  cost_cny?: number;
  width?: number;
  height?: number;
  duration_sec?: number;
  tags?: string[];
}

// ─── Simple mutex ──────────────────────────────────────────────────────

class Mutex {
  private _locked = false;
  private _queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }
    return new Promise<() => void>((resolve) => {
      this._queue.push(() => resolve(() => this._release()));
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next) { next(); } else { this._locked = false; }
  }
}

const vaultMutex = new Mutex();

// ─── Memory cache ──────────────────────────────────────────────────────

let _cache: { entries: Map<string, VaultEntry>; loadedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

async function warmCache(): Promise<Map<string, VaultEntry>> {
  const now = Date.now();
  if (_cache && now - _cache.loadedAt < CACHE_TTL_MS) return _cache.entries;

  const entries = new Map<string, VaultEntry>();
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw: VaultEntry & { schema_version?: number } = JSON.parse(trimmed);
        // E3: apply global schema version migration (no-op for v1→v2, stamps version)
        const e = migrateToLatest(raw as unknown as Record<string, unknown>) as unknown as VaultEntry & { schema_version?: number };
        // Schema version check — future migrator hook
        if (e.schema_version !== undefined && e.schema_version > CURRENT_SCHEMA_VERSION) {
          console.warn(`[assetVault] skipping entry ${e.vault_id} with unsupported schema_version=${e.schema_version} (current=${CURRENT_SCHEMA_VERSION})`);
          continue;
        }
        // T7: permanently_deleted 墓碑行 (cleanupOldTrash 写入). index.jsonl 是 append-only,
        // 同一 vault_id 之前的 active/trashed 行已被 set 进 map — 这里必须显式 delete 应用删除,
        // 否则重启/重载后被永久删除的条目会"复活"成物理文件已 unlink 的废案幽灵。
        // (墓碑本身是合法 JSON 能正常 parse, 单纯 continue 只跳过墓碑行、留下旧的 trashed 版本。)
        if ((e as any).status === "permanently_deleted") {
          entries.delete(e.vault_id);
          continue;
        }
        entries.set(e.vault_id, e);
      } catch { /* skip malformed */ }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  _cache = { entries, loadedAt: now };
  return entries;
}

function invalidateCache(): void {
  _cache = null;
}

// ─── Ensure root ───────────────────────────────────────────────────────

async function ensureVaultRoot(): Promise<void> {
  if (!(await pathExists(VAULT_ROOT))) {
    await ensureDir(VAULT_ROOT);
    await ensureDir(IMAGES_DIR);
    await ensureDir(VIDEOS_DIR);
    await ensureDir(TRASH_DIR);
    await ensureDir(EXPORTS_DIR);
    // Create empty index.jsonl
    await fs.writeFile(INDEX_PATH, "", "utf-8");
  }
}

// ─── SHA256 ────────────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256Prefix(full: string): string {
  return full.slice(0, 8);
}

// ─── Path length guard ─────────────────────────────────────────────────

function warnIfLongPath(absPath: string, label: string): void {
  if (absPath.length > MAX_PATH_WARN_LENGTH) {
    console.warn(`[assetVault] ${label} path length ${absPath.length} exceeds ${MAX_PATH_WARN_LENGTH}: ${absPath}`);
  }
}

// ─── T7: Public warm-up entry point (called from server startup) ───────────────

/**
 * T7: Pre-warm the vault in-memory cache.
 * Call once at server startup (after initRealVideoLock) so the first real
 * request doesn't pay the cold-read penalty. Non-fatal on error.
 */
export async function warmupVaultCache(): Promise<void> {
  await warmCache();
}

// ─── Core operations ───────────────────────────────────────────────────

export async function saveToVault(params: SaveToVaultParams): Promise<VaultEntry> {
  await ensureVaultRoot();
  const hash = sha256(params.buffer);

  // B8: 把"读 cache 查重 + 决定写"整个块包进 mutex，防止并发同 sha256 双写
  const release = await vaultMutex.acquire();
  try {
    // 去重:若已存在相同 sha256 → 直接返回（在 mutex 内检查，避免 race）
    const cache = await warmCache();
    for (const e of cache.values()) {
      if (e.sha256 === hash && e.status === "active") return e;
    }

    const vaultId = ulid();
    const now = new Date().toISOString();
    const month = now.slice(0, 7); // "2026-05"
    const ext = params.kind === "image" ? ".png" : ".mp4";
    const kindDir = params.kind === "image" ? IMAGES_DIR : VIDEOS_DIR;
    const monthDir = path.join(kindDir, month);
    await ensureDir(monthDir);

    // Naming: <ulid>.ext (no sha prefix — ulid already unique)
    const filename = `${vaultId}${ext}`;
    const filePath = path.join(monthDir, filename);
    const relativePath = path.join(params.kind === "image" ? "images" : "videos", month, filename).replace(/\\/g, "/");

    // Path length guard
    warnIfLongPath(filePath, "vault save");

    // Atomic write (file itself written outside append lock is OK — unique path per ulid)
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, params.buffer);
    await fs.rename(tmpPath, filePath);

    const entry: VaultEntry = {
      vault_id: vaultId,
      schema_version: CURRENT_SCHEMA_VERSION,
      kind: params.kind,
      path: relativePath,
      bytes: params.buffer.length,
      mime: params.mime,
      width: params.width,
      height: params.height,
      duration_sec: params.duration_sec,
      sha256: hash,
      provider_id: params.provider_id,
      model_id: params.model_id,
      cost_cny: params.cost_cny,
      created_at: now,
      context: params.context,
      tags: params.tags ?? [],
      status: "active",
    };

    // Append to index.jsonl and update cache (still within mutex)
    await fs.appendFile(INDEX_PATH, JSON.stringify(entry) + "\n", "utf-8");
    cache.set(vaultId, entry);

    return entry;
  } finally {
    release();
  }
}

export async function getVaultEntry(vaultId: string): Promise<VaultEntry | null> {
  const cache = await warmCache();
  return cache.get(vaultId) ?? null;
}

export async function listVault(filter: VaultListFilter = {}): Promise<VaultEntry[]> {
  const cache = await warmCache();
  let results = Array.from(cache.values());

  if (filter.status) {
    results = results.filter((e) => e.status === filter.status);
  } else {
    // Default: active only
    results = results.filter((e) => e.status === "active");
  }

  if (filter.kind) results = results.filter((e) => e.kind === filter.kind);
  if (filter.series_slug) results = results.filter((e) => e.context.series_slug === filter.series_slug);
  if (filter.character_id) results = results.filter((e) => e.context.character_id === filter.character_id);
  if (filter.scene_id) results = results.filter((e) => e.context.scene_id === filter.scene_id);
  if (filter.shot_id) results = results.filter((e) => e.context.shot_id === filter.shot_id);
  if (filter.since) results = results.filter((e) => e.created_at >= filter.since!);
  if (filter.tags?.length) {
    results = results.filter((e) => filter.tags!.every((t) => (e.tags ?? []).includes(t)));
  }

  // Sort newest first
  results.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? 50;
  return results.slice(offset, offset + limit);
}

export async function moveToTrash(vaultId: string, reason?: string): Promise<VaultEntry | null> {
  const entry = await getVaultEntry(vaultId);
  if (!entry || entry.status === "trashed") return null;

  const release = await vaultMutex.acquire();
  try {
    // Update in-memory cache
    entry.status = "trashed";
    entry.trashed_at = new Date().toISOString();
    _cache?.entries.set(vaultId, entry);

    // Append tombstone-style line to index.jsonl
    const updateLine = JSON.stringify(entry) + "\n";
    await fs.appendFile(INDEX_PATH, updateLine, "utf-8");

    // Write trash record
    const trashRecord: TrashRecord = {
      vault_id: vaultId,
      schema_version: CURRENT_SCHEMA_VERSION,
      moved_at: new Date().toISOString(),
      reason,
    };
    await ensureDir(TRASH_DIR);
    await fs.writeFile(
      path.join(TRASH_DIR, `${vaultId}.json`),
      JSON.stringify(trashRecord, null, 2),
      "utf-8",
    );
  } finally {
    release();
  }

  return entry;
}

export async function restoreFromTrash(vaultId: string): Promise<VaultEntry | null> {
  const entry = await getVaultEntry(vaultId);
  if (!entry || entry.status !== "trashed") return null;

  const release = await vaultMutex.acquire();
  try {
    entry.status = "active";
    _cache?.entries.set(vaultId, entry);

    const updateLine = JSON.stringify(entry) + "\n";
    await fs.appendFile(INDEX_PATH, updateLine, "utf-8");

    // Remove trash record
    const trashPath = path.join(TRASH_DIR, `${vaultId}.json`);
    try { await fs.unlink(trashPath); } catch { /* ignore */ }
  } finally {
    release();
  }

  return entry;
}

/**
 * T7: 清理超过 daysOld 天的废案。
 * - 遍历 index.jsonl 中 status="trashed" 且 trashed_at 超过阈值的条目
 * - 删除物理文件 + trash/*.json 记录
 * - 在 index.jsonl 追加 permanently_deleted 标记行
 * - 返回清理的条目数
 */
export async function cleanupOldTrash(daysOld: number = 90): Promise<number> {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
  const cache = await warmCache();

  let removed = 0;

  for (const [vaultId, entry] of cache) {
    if (entry.status !== "trashed") continue;
    if (!entry.trashed_at || entry.trashed_at > cutoff) continue;

    // 删除物理文件
    const absPath = path.join(VAULT_ROOT, entry.path);
    try {
      if (await pathExists(absPath)) {
        await fs.unlink(absPath);
      }
    } catch (err: unknown) {
      console.warn(`[vault-cleanup] failed to delete file for ${vaultId}:`, (err as Error).message);
    }

    // 删除 trash 记录 JSON
    const trashPath = path.join(TRASH_DIR, `${vaultId}.json`);
    try {
      await fs.unlink(trashPath);
    } catch { /* ignore if already gone */ }

    // 在 index.jsonl 追加 permanently_deleted 标记行
    const release = await vaultMutex.acquire();
    try {
      const tombstone = JSON.stringify({
        vault_id: vaultId,
        schema_version: CURRENT_SCHEMA_VERSION,
        status: "permanently_deleted",
        trashed_at: entry.trashed_at,
        deleted_at: new Date().toISOString(),
      }) + "\n";
      await fs.appendFile(INDEX_PATH, tombstone, "utf-8");
      // 从内存缓存移除。后续 warmCache 冷读到该墓碑行时会显式 entries.delete(vault_id)
      // 把删除应用到旧的 active/trashed 版本(见 warmCache 的 permanently_deleted 分支),
      // 不再复活为文件缺失的废案幽灵。
      cache.delete(vaultId);
    } finally {
      release();
    }

    removed++;
  }

  if (removed > 0) {
    console.log(`[vault-cleanup] removed ${removed} trashed entries older than ${daysOld}d`);
  }

  return removed;
}

export async function getVaultBuffer(vaultId: string): Promise<{ buffer: Buffer; entry: VaultEntry } | null> {
  const entry = await getVaultEntry(vaultId);
  if (!entry) return null;
  const absPath = path.join(VAULT_ROOT, entry.path);
  warnIfLongPath(absPath, "vault read");
  if (!(await pathExists(absPath))) return null;
  const buffer = await fs.readFile(absPath);
  return { buffer, entry };
}

export async function exportToZip(vaultIds: string[], zipName?: string): Promise<{ zipPath: string; count: number }> {
  await ensureDir(EXPORTS_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = zipName ?? `vault-export-${ts}.zip`;
  const zipPath = path.join(EXPORTS_DIR, name);

  // Dynamic import of archiver to avoid initializing it unless export is requested.
  let ZipArchive: any;
  try {
    ({ ZipArchive } = await import("archiver") as any);
  } catch {
    // Fallback: copy files to a directory instead
    const dirPath = path.join(EXPORTS_DIR, `vault-export-${ts}`);
    await ensureDir(dirPath);
    let count = 0;
    for (const vid of vaultIds) {
      const result = await getVaultBuffer(vid);
      if (result) {
        const ext = result.entry.kind === "image" ? ".png" : ".mp4";
        await fs.writeFile(path.join(dirPath, `${vid}${ext}`), result.buffer);
        count++;
      }
    }
    // Write manifest
    const manifest = vaultIds.map((vid) => {
      const e = _cache?.entries.get(vid);
      return e ? { vault_id: vid, kind: e.kind, path: e.path, bytes: e.bytes, mime: e.mime } : { vault_id: vid, error: "not found" };
    });
    await fs.writeFile(path.join(dirPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    return { zipPath: dirPath, count };
  }

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.pipe(output);
    let count = 0;

    const addFiles = async () => {
      for (const vid of vaultIds) {
        const result = await getVaultBuffer(vid);
        if (result) {
          const ext = result.entry.kind === "image" ? ".png" : ".mp4";
          archive.append(result.buffer, { name: `${vid}${ext}` });
          count++;
        }
      }
      archive.finalize();
    };

    output.on("close", () => resolve({ zipPath, count }));
    archive.on("error", reject);
    addFiles().catch((e) => { console.warn("[assetVault] addFiles failed:", (e as Error)?.message ?? e); reject(e); });
  });
}

// 2026-05-26 Codex P1-6 — stats 接受可选 series_slug 过滤. scope=series 时只统计该系列条目,
// 让用户看到"本系列 X 项"而不是全局"96 项". 不传 filter 时行为同旧.
export async function getVaultStats(filter: { series_slug?: string } = {}): Promise<VaultStats> {
  const cache = await warmCache();
  let total = 0, images = 0, videos = 0, trashed = 0, total_bytes = 0;
  for (const e of cache.values()) {
    if (filter.series_slug && e.context.series_slug !== filter.series_slug) continue;
    total++;
    if (e.kind === "image") images++;
    else videos++;
    if (e.status === "trashed") trashed++;
    total_bytes += e.bytes;
  }
  return { total, images, videos, trashed, total_bytes };
}

/**
 * 2026-05-25 C1: 成本统计聚合 — 用户掏钱用 API, 需要看累计成本 / 本月 / Top Provider/Series.
 * 仅统计 status="active" + cost_cny > 0 的条目 (trashed / 免费 mock 不算).
 *
 * @param filter.series_slug  仅统计该系列 (默认全部)
 * @param filter.since        ISO date 起点 (默认无限早)
 * @param filter.until        ISO date 终点 (默认现在)
 */
export async function getVaultCostStats(
  filter: { series_slug?: string; since?: string; until?: string } = {},
): Promise<VaultCostStats> {
  const cache = await warmCache();
  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const sinceTs = filter.since ? Date.parse(filter.since) : 0;
  const untilTs = filter.until ? Date.parse(filter.until) : now.getTime() + 1;

  let total_cny = 0;
  let total_paid_entries = 0;
  let this_month_cny = 0;
  let this_month_entries = 0;
  const providerMap = new Map<string, { cost_cny: number; count: number }>();
  const seriesMap = new Map<string, { cost_cny: number; count: number }>();
  const monthMap = new Map<string, { cost_cny: number; count: number }>();

  for (const e of cache.values()) {
    if (e.status !== "active") continue;
    const cost = e.cost_cny ?? 0;
    if (cost <= 0) continue;
    if (filter.series_slug && e.context?.series_slug !== filter.series_slug) continue;
    const ts = Date.parse(e.created_at);
    if (Number.isNaN(ts)) continue;
    if (ts < sinceTs || ts > untilTs) continue;

    total_cny += cost;
    total_paid_entries++;

    // by month (YYYY-MM)
    const d = new Date(ts);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const monthCur = monthMap.get(monthKey) ?? { cost_cny: 0, count: 0 };
    monthCur.cost_cny += cost;
    monthCur.count++;
    monthMap.set(monthKey, monthCur);

    if (monthKey === thisMonthKey) {
      this_month_cny += cost;
      this_month_entries++;
    }

    // by provider
    const providerId = e.provider_id ?? "unknown";
    const pCur = providerMap.get(providerId) ?? { cost_cny: 0, count: 0 };
    pCur.cost_cny += cost;
    pCur.count++;
    providerMap.set(providerId, pCur);

    // by series
    const seriesSlug = e.context?.series_slug ?? "(无项目)";
    const sCur = seriesMap.get(seriesSlug) ?? { cost_cny: 0, count: 0 };
    sCur.cost_cny += cost;
    sCur.count++;
    seriesMap.set(seriesSlug, sCur);
  }

  // 排序 + top N
  const by_provider = Array.from(providerMap.entries())
    .map(([provider_id, v]) => ({ provider_id, cost_cny: v.cost_cny, count: v.count }))
    .sort((a, b) => b.cost_cny - a.cost_cny);

  const by_series = Array.from(seriesMap.entries())
    .map(([series_slug, v]) => ({ series_slug, cost_cny: v.cost_cny, count: v.count }))
    .sort((a, b) => b.cost_cny - a.cost_cny);

  // 近 6 月趋势 — 含没成本的月也补 0, 让 UI 柱状图连续
  const by_month: Array<{ month: string; cost_cny: number; count: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const v = monthMap.get(key) ?? { cost_cny: 0, count: 0 };
    by_month.push({ month: key, cost_cny: v.cost_cny, count: v.count });
  }

  return {
    total_cny: Math.round(total_cny * 100) / 100,
    total_paid_entries,
    this_month_cny: Math.round(this_month_cny * 100) / 100,
    this_month_entries,
    by_provider,
    by_series,
    by_month,
  };
}

/**
 * Get the absolute file system path for a vault entry.
 */
export function getVaultAbsolutePath(entry: VaultEntry): string {
  const absPath = path.join(VAULT_ROOT, entry.path);
  warnIfLongPath(absPath, "vault absolute path");
  return absPath;
}

/**
 * Update specific fields on an existing vault entry.
 * Uses append-only JSONL: the latest entry for a given vault_id wins.
 *
 * @param vaultId - The vault entry to update
 * @param patch   - Partial fields to merge into the entry
 * @returns The updated entry, or null if not found
 */
export async function updateVaultEntry(
  vaultId: string,
  patch: Partial<Pick<VaultEntry, "quality_scores" | "tags" | "status" | "cost_cny" | "display_name">>,
): Promise<VaultEntry | null> {
  const cache = await warmCache();
  const existing = cache.get(vaultId);
  if (!existing) return null;

  const updated: VaultEntry = { ...existing, ...patch };

  const release = await vaultMutex.acquire();
  try {
    await fs.appendFile(INDEX_PATH, JSON.stringify(updated) + "\n", "utf-8");
    cache.set(vaultId, updated);
  } finally {
    release();
  }

  return updated;
}

export async function tagVaultEntry(vaultId: string, addTags: string[]): Promise<VaultEntry | null> {
  const entry = await getVaultEntry(vaultId);
  if (!entry) return null;
  const merged = Array.from(new Set([...(entry.tags ?? []), ...addTags]));
  return updateVaultEntry(vaultId, { tags: merged });
}

export async function untagVaultEntry(vaultId: string, removeTags: string[]): Promise<VaultEntry | null> {
  const entry = await getVaultEntry(vaultId);
  if (!entry) return null;
  const removeSet = new Set(removeTags);
  const tags = (entry.tags ?? []).filter((tag) => !removeSet.has(tag));
  return updateVaultEntry(vaultId, { tags });
}

// ─── Thumbnails ───────────────────────────────────────────────────────

export async function ensureThumbnailsDir(): Promise<void> {
  await ensureDir(THUMBNAILS_DIR);
}

export async function saveThumbnailBuffer(vaultId: string, thumbnailBuffer: Buffer): Promise<string> {
  await ensureThumbnailsDir();
  const thumbPath = path.join(THUMBNAILS_DIR, `${vaultId}.webp`);
  await fs.writeFile(thumbPath, thumbnailBuffer);
  return thumbPath;
}

export function getThumbnailAbsolutePath(vaultId: string): string {
  return path.join(THUMBNAILS_DIR, `${vaultId}.webp`);
}
