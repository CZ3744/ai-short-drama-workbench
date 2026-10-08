import fs from "node:fs/promises";
import path from "node:path";
import type { Asset, IndexSnapshot } from "./types.js";
import { loadIndex, writeSnapshot, CURRENT_SCHEMA_VERSION } from "./jsonlIndex.js";

// ── compact ─────────────────────────────────────────────────────────────

/**
 * Rebuild index.json from the current state (snapshot + replayed JSONL).
 * After compact, the JSONL can be truncated (we do NOT truncate automatically
 * to avoid data loss; caller can archive the old JSONL manually).
 */
export async function compact(assetsRoot: string): Promise<{ assetCount: number; shaCount: number }> {
  const { assetsById, sha256ToId } = await loadIndex(assetsRoot);

  // Remove tombstoned assets from snapshot
  const liveAssets: Record<string, Asset> = {};
  const liveSha: Record<string, string> = {};

  for (const [id, asset] of assetsById) {
    if (!asset.deleted_at) {
      liveAssets[id] = asset;
    }
  }
  for (const [sha, id] of sha256ToId) {
    if (liveAssets[id]) {
      liveSha[sha] = id;
    }
  }

  const snapshot: IndexSnapshot = {
    schema_version: CURRENT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    assets: liveAssets,
    sha256_to_id: liveSha,
  };

  await writeSnapshot(path.join(assetsRoot, "index.json"), snapshot);

  return { assetCount: Object.keys(liveAssets).length, shaCount: Object.keys(liveSha).length };
}

// ── gc (garbage collect) ────────────────────────────────────────────────

/**
 * Delete files on disk that have no live reference in the index.
 * Returns the list of deleted file paths.
 */
export async function gc(assetsRoot: string): Promise<string[]> {
  const { assetsById } = await loadIndex(assetsRoot);
  const livePaths = new Set<string>();
  for (const asset of assetsById.values()) {
    if (!asset.deleted_at) {
      livePaths.add(path.resolve(assetsRoot, asset.file_path));
    }
  }

  const deleted: string[] = [];
  const mediaDirs = ["images", "videos", "audio", "docs"];
  for (const dir of mediaDirs) {
    const absDir = path.join(assetsRoot, dir);
    try {
      const entries = await fs.readdir(absDir);
      for (const entry of entries) {
        const absEntry = path.join(absDir, entry);
        const stat = await fs.stat(absEntry);
        if (stat.isFile() && !livePaths.has(absEntry)) {
          // W-3.1: 孤儿文件移到 _orphan_trash/ 而非直接删除 (铁律 #6 数据保留)
          const orphanTrashDir = path.join(assetsRoot, "_orphan_trash");
          await fs.mkdir(orphanTrashDir, { recursive: true });
          const dest = path.join(orphanTrashDir, entry);
          await fs.rename(absEntry, dest);
          deleted.push(absEntry);
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }

  return deleted;
}

// ── verify ──────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  issues: string[];
  checked: number;
}

/**
 * Check consistency between index and disk:
 * 1. Every live asset in index has its file on disk
 * 2. File size matches
 * 3. No orphan files on disk (files not referenced by any live asset)
 */
export async function verify(assetsRoot: string): Promise<VerifyResult> {
  const { assetsById } = await loadIndex(assetsRoot);
  const issues: string[] = [];
  let checked = 0;

  // Check each live asset
  for (const asset of assetsById.values()) {
    if (asset.deleted_at) continue;
    checked++;
    const absPath = path.resolve(assetsRoot, asset.file_path);
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) {
        issues.push(`[${asset.id}] path is not a file: ${asset.file_path}`);
      } else if (stat.size !== asset.file_size_bytes) {
        issues.push(`[${asset.id}] size mismatch: index=${asset.file_size_bytes} disk=${stat.size}`);
      }
    } catch {
      issues.push(`[${asset.id}] file missing on disk: ${asset.file_path}`);
    }
  }

  // Check for orphan files
  const livePaths = new Set(
    Array.from(assetsById.values())
      .filter((a) => !a.deleted_at)
      .map((a) => path.resolve(assetsRoot, a.file_path))
  );

  const mediaDirs = ["images", "videos", "audio", "docs"];
  for (const dir of mediaDirs) {
    const absDir = path.join(assetsRoot, dir);
    try {
      const entries = await fs.readdir(absDir);
      for (const entry of entries) {
        const absEntry = path.resolve(absDir, entry);
        const stat = await fs.stat(absEntry);
        if (stat.isFile() && !livePaths.has(absEntry)) {
          issues.push(`[orphan] unreferenced file: ${dir}/${entry}`);
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }

  return { ok: issues.length === 0, issues, checked };
}
