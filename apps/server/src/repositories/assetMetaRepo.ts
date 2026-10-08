/**
 * assetMetaRepo — 全局 asset-level display_name 单一真理源 (2026-05-20).
 *
 * 背景: 同一 asset 在 ElementImage / ShotCandidate / Variant / VaultEntry 四种实体里
 * 各自存了一份 display_name, 用户改一处其他位置不同步, 导致 "图片底下名称不一致" 反馈.
 *
 * 设计 (CLAUDE.md 解耦信仰: 单一真理源, 所有 caller 读它):
 *   - 数据结构: Map<asset_id, { display_name?: string; updated_at: string }>
 *   - 落盘: data/asset_meta.json (全局, 跨 series)
 *   - asset_id 可以是 ElementImage.image_id / VaultEntry.vault_id / ShotGeneration.generation_id
 *     (是 caller 决定 key 含义, repo 只是个 KV)
 *   - 读 (getAssetMeta): 任何 caller 序列化时先查 assetMetaRepo, 命中就盖过 entity 本地字段;
 *     不命中 fallback 到 entity.display_name (向后兼容老数据)
 *   - 写 (updateAssetMeta): 任何 rename API 同时写 entity.display_name + assetMetaRepo (双写一致)
 *
 * 并发: 简单 mutex (单用户本机, 不需 file lock)
 * 持久化: 每次写后整个 JSON 覆写 (条目数 < 几万, 性能可接受)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, ensureDir, DATA_ROOT } from "../../../../packages/core/src/index";
import { loggerSync } from "../../../../packages/core/src/logger";

// ─── Paths ───────────────────────────────────────────────────────

const ASSET_META_FILE = path.join(DATA_ROOT, "asset_meta.json");

// ─── Types ───────────────────────────────────────────────────────

export interface AssetMeta {
  /** 用户可改的展示名,不等于真实文件名 */
  display_name?: string;
  updated_at: string;
}

interface AssetMetaStore {
  schema_version: number;
  entries: Record<string, AssetMeta>;
}

// ─── In-memory cache + write mutex ──────────────────────────────

let _cache: Map<string, AssetMeta> | null = null;
let _lockChain: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const wait = _lockChain;
  _lockChain = next;
  return wait
    .then(() => fn())
    .finally(() => release!());
}

function nowISO(): string {
  return new Date().toISOString();
}

async function loadCache(): Promise<Map<string, AssetMeta>> {
  if (_cache) return _cache;
  if (!(await pathExists(ASSET_META_FILE))) {
    _cache = new Map();
    return _cache;
  }
  try {
    const raw = await fs.readFile(ASSET_META_FILE, "utf-8");
    const parsed = JSON.parse(raw) as AssetMetaStore;
    const map = new Map<string, AssetMeta>();
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (v && typeof v === "object") map.set(k, v as AssetMeta);
      }
    }
    _cache = map;
    return map;
  } catch (e) {
    loggerSync().warn(`[assetMetaRepo] load 失败, 使用空缓存: ${e instanceof Error ? e.message : String(e)}`);
    _cache = new Map();
    return _cache;
  }
}

async function persistCache(): Promise<void> {
  if (!_cache) return;
  const store: AssetMetaStore = {
    schema_version: 1,
    entries: Object.fromEntries(_cache.entries()),
  };
  await ensureDir(path.dirname(ASSET_META_FILE));
  await fs.writeFile(ASSET_META_FILE, JSON.stringify(store, null, 2), "utf-8");
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * 读单个 asset 的 meta. 不存在返 null (caller 据此 fallback 到 entity.display_name).
 * 不允许 silent 用 image_id — 让 caller 决定 fallback (铁律: 无 silent fallback).
 */
export async function getAssetMeta(assetId: string): Promise<AssetMeta | null> {
  if (!assetId) return null;
  const cache = await loadCache();
  return cache.get(assetId) ?? null;
}

/**
 * 批量读 (减少 N 次调用). 返回 Map (含命中的项, 没命中的 key 不出现).
 */
export async function listAssetMeta(assetIds: string[]): Promise<Map<string, AssetMeta>> {
  const cache = await loadCache();
  const out = new Map<string, AssetMeta>();
  for (const id of assetIds) {
    if (!id) continue;
    const meta = cache.get(id);
    if (meta) out.set(id, meta);
  }
  return out;
}

/**
 * 更新单 asset 的 meta. 当前只支持 display_name.
 * patch.display_name === undefined → 清除该条 (回到 entity fallback)
 * patch.display_name === "" → 同上 (空串视为清除)
 * patch.display_name === string → 写入
 *
 * 触发场景: rename API 双写一致 (调 entity write + 调本函数).
 */
export async function updateAssetMeta(
  assetId: string,
  patch: { display_name?: string | undefined },
): Promise<AssetMeta | null> {
  if (!assetId) return null;
  return withLock(async () => {
    const cache = await loadCache();
    const existing = cache.get(assetId);
    const cleaned = patch.display_name?.trim();
    if (!cleaned) {
      // 空 / undefined → 清除条目
      if (existing) cache.delete(assetId);
      await persistCache();
      return null;
    }
    const merged: AssetMeta = {
      display_name: cleaned,
      updated_at: nowISO(),
    };
    cache.set(assetId, merged);
    await persistCache();
    return merged;
  });
}

/**
 * 重置缓存 (测试用).
 */
export function _resetCacheForTest(): void {
  _cache = null;
}
