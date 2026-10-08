/**
 * _repoCommons.ts — Repo 层公共 helper（write-lock + ID + 时间戳）
 *
 * 从 characterRepo.ts / sceneRepo.ts 抽取，逐字搬运，零行为变更。
 *
 * _writeLocks Map 按 filePath 分槽，不同 repo 的文件路径天然隔离，
 * 共享同一 Map 完全安全，无需 factory。
 *
 * 注意: slugify 已单独抽到 packages/core/src/slug.ts，不在此处重复。
 */

import crypto from "node:crypto";

// ─── 文件级写互斥（纯 JS，无 npm 依赖）─────────────────────────────

const _writeLocks = new Map<string, Promise<void>>();

/**
 * 对同一文件路径的读-改-写操作串行化，防止并发 lost-update。
 * 采用 Map<path, Promise> 链：新调用等待同一文件的上一个锁释放。
 */
export function withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  _writeLocks.set(filePath, next);
  return prev.then(() => fn()).finally(() => release());
}

// ─── 通用 helpers ─────────────────────────────────────────────────────

export function newId(): string {
  return crypto.randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}
