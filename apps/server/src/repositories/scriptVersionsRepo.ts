/**
 * Script Versions Repository — W6-B 多版本管理基础设施
 *
 * 解决用户痛点 #11：剧本可以生产多个版本（并行存在，不互相覆盖）。
 *
 * 落盘结构：
 *   data/series/<slug>/script_versions/<id>.json   — 每个版本一份独立文件
 *   data/series/<slug>/script_versions/_index.json — 轻量索引（id → 文件名 + active）
 *
 * 与旧 series.script_md / series.script_versions 的关系：
 *   - 旧字段继续保留作"当前激活版本的镜像"。
 *   - expandScript 成功时同时写：旧 script_md（旧前端兼容） + 新 ScriptVersion 文件。
 *   - 任意 activate 会把目标版本的 content_md 同步刷到 series.script_md。
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { ensureDir, pathExists, readJson, writeJson } from "../../../../packages/core/src/index";
import type { ScriptVersion } from "../../../../packages/drama/src/types";
import { seriesDir } from "./_paths";

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

export function scriptVersionsDir(slug: string): string {
  return path.join(seriesDir(slug), "script_versions");
}

function scriptVersionFile(slug: string, id: string): string {
  return path.join(scriptVersionsDir(slug), `${id}.json`);
}

// ─── Helpers ────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `sv_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function summarizeFirstLine(md: string): string {
  const trimmed = md.trim().replace(/^#+\s*/, "");
  const firstLine = trimmed.split(/\n/, 1)[0] ?? "";
  return firstLine.slice(0, 40);
}

// ─── Public API ─────────────────────────────────────────────────────

export interface CreateScriptVersionInput {
  series_slug: string;
  title?: string;
  content_md: string;
  source_inspirations: string[];
  user_prompt?: string;
  parent_version_id?: string;
  /** 是否自动激活（默认 true 表示用户最新生成的就是 active） */
  activate?: boolean;
}

/**
 * 列出某 series 的所有未删除剧本版本，按 created_at 升序。
 */
export async function listScriptVersions(slug: string): Promise<ScriptVersion[]> {
  const dir = scriptVersionsDir(slug);
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  const results: ScriptVersion[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (entry.startsWith("_")) continue; // skip _index.json etc
    try {
      const data = await readJson<ScriptVersion>(path.join(dir, entry));
      if (data && !data._deleted) results.push(data);
    } catch {
      /* skip corrupted */
    }
  }
  return results.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function readScriptVersion(slug: string, id: string): Promise<ScriptVersion | null> {
  const fp = scriptVersionFile(slug, id);
  if (!(await pathExists(fp))) return null;
  const data = await readJson<ScriptVersion>(fp);
  if (!data || data._deleted) return null;
  return data;
}

/**
 * 创建一个新的剧本版本并落盘。
 * activate=true 时自动把其余版本的 is_active 设为 false。
 */
export async function createScriptVersion(input: CreateScriptVersionInput): Promise<ScriptVersion> {
  const id = newId();
  const dir = scriptVersionsDir(input.series_slug);
  await ensureDir(dir);

  const existing = await listScriptVersions(input.series_slug);
  const versionNumber = existing.length + 1;
  const defaultTitle = `剧本 v${versionNumber}${summarizeFirstLine(input.content_md) ? ` — ${summarizeFirstLine(input.content_md)}` : ""}`;

  const record: ScriptVersion = {
    id,
    series_slug: input.series_slug,
    title: input.title?.trim() || defaultTitle,
    content_md: input.content_md,
    source_inspirations: input.source_inspirations.slice(0, 50),
    user_prompt: input.user_prompt?.slice(0, 5000),
    created_at: nowISO(),
    is_active: input.activate ?? true,
    parent_version_id: input.parent_version_id,
  };

  // 落盘：先写新版本（避免被并发 activate 冲掉），再批量更新其他版本
  await writeJson(scriptVersionFile(input.series_slug, id), record);

  if (record.is_active) {
    await deactivateOthers(input.series_slug, id);
  }

  return record;
}

/**
 * 把目标版本置为 active，其余设为 inactive。
 */
export async function activateScriptVersion(slug: string, id: string): Promise<ScriptVersion | null> {
  const target = await readScriptVersion(slug, id);
  if (!target) return null;

  await deactivateOthers(slug, id);

  const updated: ScriptVersion = { ...target, is_active: true };
  await writeJson(scriptVersionFile(slug, id), updated);
  return updated;
}

async function deactivateOthers(slug: string, exceptId: string): Promise<void> {
  const all = await listScriptVersions(slug);
  for (const v of all) {
    if (v.id === exceptId) continue;
    if (!v.is_active) continue;
    const fp = scriptVersionFile(slug, v.id);
    await withWriteLock(fp, async () => {
      const fresh = await readJson<ScriptVersion>(fp);
      if (fresh && !fresh._deleted) {
        await writeJson(fp, { ...fresh, is_active: false });
      }
    });
  }
}

/**
 * 软删指定版本。如果删的是 active，自动激活最新的剩余版本。
 */
export async function softDeleteScriptVersion(slug: string, id: string): Promise<boolean> {
  const fp = scriptVersionFile(slug, id);
  if (!(await pathExists(fp))) return false;
  const existing = await readJson<ScriptVersion>(fp);
  if (!existing || existing._deleted) return false;

  await withWriteLock(fp, async () => {
    await writeJson(fp, { ...existing, _deleted: true, _deleted_at: new Date().toISOString(), is_active: false });
  });

  if (existing.is_active) {
    const remaining = await listScriptVersions(slug);
    if (remaining.length > 0) {
      const latest = remaining[remaining.length - 1];
      await activateScriptVersion(slug, latest.id);
    }
  }

  return true;
}

/**
 * 取当前激活版本（用于 expandScript 后同步刷 series.script_md 等场景）。
 */
export async function getActiveScriptVersion(slug: string): Promise<ScriptVersion | null> {
  const all = await listScriptVersions(slug);
  return all.find((v) => v.is_active) ?? null;
}
