#!/usr/bin/env tsx
/**
 * 2026-05-22 entity-first 修复 — 存量 shot JSON 一次性迁移.
 *
 * 背景: 用户实测合成黑屏, 根因是 shot.picked_video_generation_id (entity-first 引用) 与
 * generation.picked (in-record 标志) 双真理源经常不同步, 加上老导入路径的 generation 缺 path 字段,
 * 导致 compose 端找不到视频, silent mock 黑屏冒充.
 *
 * 本迁移只动 data/series/<slug>/episodes/<epId>/shots/*.json, 对每个有 picked_*_generation_id 的 shot:
 *   1. 把对应 generation 的 picked 标志回写为 true (其它 generation 强制 picked=false, 避免歧义)
 *   2. 如 generation.path 字段缺失但 asset_id 或 vault_id 存在 — 解析对应文件的绝对路径回填.
 *      (path 字段是 legacy fallback, 主流量走 asset_id/vault_id, 但保留 path 可加速未来 compose)
 *   3. 同步处理 picked_first_frame_generation_id (首帧) + picked_generation_id (legacy 兼容字段)
 *
 * 用法:
 *   npx tsx scripts/migrate-shot-picked-video.ts --dry-run
 *   npx tsx scripts/migrate-shot-picked-video.ts
 *   npx tsx scripts/migrate-shot-picked-video.ts --series 最后一次自拍
 *
 * 输出: 扫描 N 个 shot, M 个回写 picked 标志, K 个补 path 字段, L 个 picked_id 指向不存在的 generation.
 *
 * 跨平台注意 (Windows ⊕ POSIX): __dirname 用 import.meta.dirname, 中文目录用 \u 转义防 powershell 编码错乱.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";

/**
 * 迁移脚本自己解析 asset / vault — 避免 import 生产代码导致 DATA_ROOT 被 worktree 绑死.
 * 用户在主仓库 (C:/Projects/video-studio) 跑时, --root 指向主仓库, 这里相对解析就对.
 */
interface PickedGenerationLike {
  generation_id: string;
  type: string;
  status: string;
  asset_id?: string;
  vault_id?: string;
  path?: string;
  picked?: boolean;
  created_at: string;
}

interface VaultEntryLite {
  vault_id: string;
  path: string; // relative to data/vault/
  status?: string;
}

interface AssetEntryLite {
  asset_id: string;
  path: string; // relative to data/series/<slug>/
}

// 默认 ROOT = 脚本所在的仓库根. 但 worktree 模式下用户实测数据可能在主仓库,
// 用 --root <path> 覆盖. 例: --root C:/Projects/video-studio.
const rootArgIndex = process.argv.indexOf("--root");
const ROOT_OVERRIDE =
  rootArgIndex >= 0 && rootArgIndex + 1 < process.argv.length
    ? path.resolve(process.argv[rootArgIndex + 1])
    : null;
const ROOT = ROOT_OVERRIDE ?? path.resolve(import.meta.dirname, "..");
const SERIES_ROOT = path.join(ROOT, "data", "series");
const DRY_RUN = process.argv.includes("--dry-run");
const seriesArgIndex = process.argv.indexOf("--series");
const SERIES_FILTER =
  seriesArgIndex >= 0 && seriesArgIndex + 1 < process.argv.length
    ? process.argv[seriesArgIndex + 1]
    : "";

interface MigratedShot {
  slug: string;
  epId: string;
  shotId: string;
  pickedFlagsFixed: number;
  pathsBackfilled: number;
  brokenPickedIds: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listDir(p: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

interface ShotJson {
  id: string;
  series_slug?: string;
  episode_id?: string;
  duration_sec?: number;
  picked_first_frame_generation_id?: string | null;
  picked_video_generation_id?: string | null;
  picked_generation_id?: string | null;
  generations?: PickedGenerationLike[];
  active_generations?: PickedGenerationLike[];
  trashed_generations?: PickedGenerationLike[];
  [key: string]: unknown;
}

function isVideoOrFirstFrame(g: PickedGenerationLike): boolean {
  return g.type === "video" || g.type === "first_frame";
}

/**
 * 对一个 generation 数组里指定 id 的项标 picked=true, 其余同 type 的标 picked=false.
 * 这样老的 `find(g => g.picked === true)` 路径 (兼容旧 hook / 视图) 也能正确解析.
 */
function setPickedFlag(
  arr: PickedGenerationLike[] | undefined,
  pickedId: string,
  forType: "video" | "first_frame",
): { changed: number; foundTarget: boolean } {
  if (!arr) return { changed: 0, foundTarget: false };
  let changed = 0;
  let foundTarget = false;
  for (const g of arr) {
    if (g.type !== forType) continue;
    const shouldBePicked = g.generation_id === pickedId;
    if (shouldBePicked) foundTarget = true;
    if (shouldBePicked && g.picked !== true) {
      g.picked = true;
      changed += 1;
    } else if (!shouldBePicked && g.picked === true) {
      g.picked = false;
      changed += 1;
    }
  }
  return { changed, foundTarget };
}

// ─── Vault / Asset index 读取 (跨平台, 解析相对 ROOT) ───────────────

let _vaultIndexCache: Map<string, VaultEntryLite> | null = null;
async function loadVaultIndex(): Promise<Map<string, VaultEntryLite>> {
  if (_vaultIndexCache) return _vaultIndexCache;
  const indexPath = path.join(ROOT, "data", "vault", "index.jsonl");
  const map = new Map<string, VaultEntryLite>();
  if (!(await exists(indexPath))) {
    _vaultIndexCache = map;
    return map;
  }
  const content = await fs.readFile(indexPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as VaultEntryLite;
      if (entry.vault_id) map.set(entry.vault_id, entry); // append-only: 后写覆盖前写
    } catch { /* skip malformed */ }
  }
  _vaultIndexCache = map;
  return map;
}

const _assetIndexCache = new Map<string, Map<string, AssetEntryLite>>();
async function loadAssetIndex(slug: string): Promise<Map<string, AssetEntryLite>> {
  if (_assetIndexCache.has(slug)) return _assetIndexCache.get(slug)!;
  const indexPath = path.join(ROOT, "data", "series", slug, "assets", "index.jsonl");
  const map = new Map<string, AssetEntryLite>();
  if (!(await exists(indexPath))) {
    _assetIndexCache.set(slug, map);
    return map;
  }
  const content = await fs.readFile(indexPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as AssetEntryLite;
      if (entry.asset_id) map.set(entry.asset_id, entry);
    } catch { /* skip */ }
  }
  _assetIndexCache.set(slug, map);
  return map;
}

async function backfillGenerationPath(
  slug: string,
  _baseDir: string,
  generation: PickedGenerationLike,
): Promise<boolean> {
  if (generation.path && generation.path.length > 0) return false;
  if (!generation.asset_id && !generation.vault_id) return false;

  // 1. asset
  if (generation.asset_id) {
    const idx = await loadAssetIndex(slug);
    const a = idx.get(generation.asset_id);
    if (a) {
      const abs = path.join(ROOT, "data", "series", slug, a.path);
      if (await exists(abs)) {
        generation.path = abs;
        return true;
      }
    }
  }
  // 2. vault
  if (generation.vault_id) {
    const idx = await loadVaultIndex();
    const v = idx.get(generation.vault_id);
    if (v && (v.status === "active" || v.status === undefined)) {
      const abs = path.join(ROOT, "data", "vault", v.path);
      if (await exists(abs)) {
        generation.path = abs;
        return true;
      }
    }
  }
  return false;
}

async function migrateShotFile(
  shotFile: string,
  slug: string,
  epId: string,
): Promise<MigratedShot | null> {
  let shot: ShotJson;
  try {
    shot = JSON.parse(await fs.readFile(shotFile, "utf8")) as ShotJson;
  } catch (err) {
    console.warn(`  ! 跳过 ${path.relative(ROOT, shotFile)}: JSON 解析失败 (${(err as Error).message})`);
    return null;
  }

  const result: MigratedShot = {
    slug,
    epId,
    shotId: shot.id || path.basename(shotFile, ".json"),
    pickedFlagsFixed: 0,
    pathsBackfilled: 0,
    brokenPickedIds: [],
  };

  const baseDir = path.dirname(path.dirname(shotFile)); // .../episodes/<epId>

  // 1. picked flag 同步 — video / first_frame 两种 kind
  for (const [pickedIdField, kind] of [
    ["picked_video_generation_id", "video"],
    ["picked_first_frame_generation_id", "first_frame"],
  ] as const) {
    const pickedId = shot[pickedIdField];
    if (!pickedId) continue;
    const flagged = setPickedFlag(shot.generations, pickedId, kind);
    result.pickedFlagsFixed += flagged.changed;
    setPickedFlag(shot.active_generations, pickedId, kind); // 同步 active 数组但不计数 (避免重复算)
    if (!flagged.foundTarget) {
      result.brokenPickedIds.push(`${pickedIdField}=${pickedId}`);
    }
  }

  // 2. picked_generation_id (legacy 单一字段, 跟 picked_video_generation_id 经常是同值)
  // 同样兜底 — 但只在它指向 video 类 generation 时处理 (first_frame 已被上面处理)
  if (shot.picked_generation_id && shot.picked_generation_id !== shot.picked_video_generation_id) {
    const candidate = shot.generations?.find((g) => g.generation_id === shot.picked_generation_id);
    if (candidate?.type === "video") {
      const flagged = setPickedFlag(shot.generations, shot.picked_generation_id, "video");
      result.pickedFlagsFixed += flagged.changed;
    }
  }

  // 3. path 补全 — 仅对 picked 的 generation 处理 (避免污染 trashed / 老废案)
  const pickedGenIds = new Set<string>(
    [
      shot.picked_video_generation_id,
      shot.picked_first_frame_generation_id,
      shot.picked_generation_id,
    ].filter((x): x is string => typeof x === "string" && x.length > 0),
  );

  for (const arrName of ["generations", "active_generations"] as const) {
    const arr = shot[arrName];
    if (!arr) continue;
    for (const g of arr) {
      if (!pickedGenIds.has(g.generation_id)) continue;
      if (!isVideoOrFirstFrame(g)) continue;
      const filled = await backfillGenerationPath(slug, baseDir, g);
      if (filled && arrName === "generations") {
        result.pathsBackfilled += 1;
      }
    }
  }

  const dirty = result.pickedFlagsFixed > 0 || result.pathsBackfilled > 0;
  if (!dirty && result.brokenPickedIds.length === 0) return null;

  if (!DRY_RUN && dirty) {
    await fs.writeFile(shotFile, `${JSON.stringify(shot, null, 2)}\n`, "utf8");
  }
  return result;
}

async function collectEpisodes(): Promise<Array<{ slug: string; epId: string; shotsDir: string }>> {
  if (!(await exists(SERIES_ROOT))) {
    throw new Error(`找不到 data/series 目录: ${SERIES_ROOT}`);
  }
  const seriesDirs = SERIES_FILTER
    ? [{ name: SERIES_FILTER, path: path.join(SERIES_ROOT, SERIES_FILTER) }]
    : (await listDir(SERIES_ROOT))
        .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
        .map((e) => ({ name: e.name, path: path.join(SERIES_ROOT, e.name) }));

  const out: Array<{ slug: string; epId: string; shotsDir: string }> = [];
  for (const series of seriesDirs) {
    if (!(await exists(series.path))) continue;
    const episodesDir = path.join(series.path, "episodes");
    const epEntries = await listDir(episodesDir);
    for (const ep of epEntries) {
      if (!ep.isDirectory()) continue;
      const shotsDir = path.join(episodesDir, ep.name, "shots");
      if (!(await exists(shotsDir))) continue;
      out.push({ slug: series.name, epId: ep.name, shotsDir });
    }
  }
  return out;
}

async function main() {
  console.log(`[migrate] entity-first shot picked 迁移 — root=${ROOT}`);
  if (SERIES_FILTER) console.log(`[migrate] 限定系列: ${SERIES_FILTER}`);
  if (DRY_RUN) console.log("[migrate] DRY-RUN 模式, 不写盘");

  const episodes = await collectEpisodes();
  console.log(`[migrate] 找到 ${episodes.length} 个 episode`);

  let totalShots = 0;
  let touchedShots = 0;
  let totalFlagsFixed = 0;
  let totalPathsBackfilled = 0;
  const brokenLog: MigratedShot[] = [];

  for (const ep of episodes) {
    const shotFiles = (await listDir(ep.shotsDir))
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(ep.shotsDir, e.name));
    for (const shotFile of shotFiles) {
      totalShots += 1;
      const result = await migrateShotFile(shotFile, ep.slug, ep.epId);
      if (!result) continue;
      touchedShots += 1;
      totalFlagsFixed += result.pickedFlagsFixed;
      totalPathsBackfilled += result.pathsBackfilled;
      if (result.brokenPickedIds.length > 0) brokenLog.push(result);
      console.log(
        `  ${result.slug}/${result.epId}/${result.shotId}: ` +
          `+${result.pickedFlagsFixed} flag, +${result.pathsBackfilled} path` +
          (result.brokenPickedIds.length > 0
            ? `, ⚠ 失效 picked_id: ${result.brokenPickedIds.join(", ")}`
            : ""),
      );
    }
  }

  console.log("");
  console.log(`[migrate] 扫描 shot: ${totalShots}, 变更 shot: ${touchedShots}`);
  console.log(`[migrate] picked flag 同步: ${totalFlagsFixed}`);
  console.log(`[migrate] generation.path 回填: ${totalPathsBackfilled}`);
  if (brokenLog.length > 0) {
    console.log(`[migrate] ⚠ ${brokenLog.length} 个 shot 的 picked_*_generation_id 指向不存在的 generation, 需要手动重新选片/生成:`);
    for (const item of brokenLog) {
      for (const id of item.brokenPickedIds) {
        console.log(`  - ${item.slug}/${item.epId}/${item.shotId}: ${id}`);
      }
    }
  }
  if (DRY_RUN) console.log("[migrate] DRY-RUN, 未写盘 — 去掉 --dry-run 真正执行");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
