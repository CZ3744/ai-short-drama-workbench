// T13: Project CRUD operations
import fs from "node:fs/promises";
import path from "node:path";
import { getDb } from "./database";
import { projectDir, projectsRoot } from "../paths";
import { ulid } from "ulid";

export interface ProjectRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  cover_path: string | null;
  aspect_ratio: string;
  resolution: string;
  default_style: string;
  created_at: string;
  updated_at: string;
  archived: number;
}

export interface ProjectDeleteSummary {
  slug: string;
  title: string;
  project_dir: string;
  exists_on_disk: boolean;
  bytes: number;
  file_count: number;
  image_count: number;
  video_count: number;
  database_counts: Record<string, number>;
}

export function createProject(input: {
  slug: string;
  title: string;
  description?: string;
  aspect_ratio?: string;
  resolution?: string;
  default_style?: string;
}): ProjectRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = ulid();
  db.prepare(`
    INSERT INTO projects (id, slug, title, description, aspect_ratio, resolution, default_style, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.slug, input.title, input.description ?? "", input.aspect_ratio ?? "16:9", input.resolution ?? "1920x1080", input.default_style ?? "auto", now, now);
  return getProject(input.slug)!;
}

export function getProject(slug: string): ProjectRow | undefined {
  return getDb().prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as ProjectRow | undefined;
}

export function getProjectById(id: string): ProjectRow | undefined {
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

export function listProjects(includeArchived = false): ProjectRow[] {
  const sql = includeArchived ? "SELECT * FROM projects ORDER BY created_at DESC" : "SELECT * FROM projects WHERE archived = 0 ORDER BY created_at DESC";
  return getDb().prepare(sql).all() as ProjectRow[];
}

export function updateProject(slug: string, updates: Partial<Pick<ProjectRow, "title" | "description" | "cover_path" | "aspect_ratio" | "resolution" | "default_style" | "archived">>): ProjectRow | undefined {
  const db = getDb();
  const existing = getProject(slug);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const merged = { ...existing, ...updates, updated_at: now };
  db.prepare(`
    UPDATE projects SET title=?, description=?, cover_path=?, aspect_ratio=?, resolution=?, default_style=?, updated_at=?, archived=?
    WHERE slug=?
  `).run(merged.title, merged.description, merged.cover_path, merged.aspect_ratio, merged.resolution, merged.default_style, merged.updated_at, merged.archived, slug);
  return getProject(slug);
}

export function deleteProject(slug: string): boolean {
  const result = getDb().prepare("DELETE FROM projects WHERE slug = ?").run(slug);
  return result.changes > 0;
}

async function collectDirSummary(dir: string): Promise<{ bytes: number; file_count: number; image_count: number; video_count: number }> {
  let bytes = 0;
  let file_count = 0;
  let image_count = 0;
  let video_count = 0;
  const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);
  const videoExts = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(full);
        bytes += stat.size;
        file_count += 1;
        const ext = path.extname(entry.name).toLowerCase();
        if (imageExts.has(ext)) image_count += 1;
        if (videoExts.has(ext)) video_count += 1;
      } catch {
        // best effort
      }
    }
  }

  await visit(dir);
  return { bytes, file_count, image_count, video_count };
}

// BUG-52: 白名单校验防止 SQL 注入 (同 BUG-48)
const ALLOWED_COUNT_TABLES = new Set(["projects", "episodes", "characters", "scenes", "styles", "vault_records", "shot_refs", "assets", "task_queue"]);

function countTableRows(table: string, column: string, value: string): number {
  if (!ALLOWED_COUNT_TABLES.has(table)) return 0;
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) return 0;
  try {
    const row = getDb().prepare(`SELECT COUNT(*) as count FROM ${table} WHERE ${column} = ?`).get(value) as { count?: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function summarizeProjectDeletion(slug: string): Promise<ProjectDeleteSummary> {
  const project = getProject(slug);
  if (!project) {
    throw Object.assign(new Error("项目不存在"), { status: 404 });
  }
  const dir = projectDir(slug);
  const existsOnDisk = await fs.stat(dir).then((stat) => stat.isDirectory()).catch(() => false);
  const dirSummary = existsOnDisk ? await collectDirSummary(dir) : { bytes: 0, file_count: 0, image_count: 0, video_count: 0 };
  const database_counts = {
    episodes: countTableRows("episodes", "project_id", project.id),
    characters: countTableRows("characters", "project_id", project.id),
    scenes: countTableRows("scenes", "project_id", project.id),
    styles: countTableRows("styles", "project_id", project.id),
    vault_records: countTableRows("vault_records", "project_id", project.id),
    task_queue: countTableRows("task_queue", "project_id", project.id),
  };
  return {
    slug: project.slug,
    title: project.title,
    project_dir: dir,
    exists_on_disk: existsOnDisk,
    bytes: dirSummary.bytes,
    file_count: dirSummary.file_count,
    image_count: dirSummary.image_count,
    video_count: dirSummary.video_count,
    database_counts,
  };
}

// A-7 (2026-05-12): 之前 deleteProjectCascade 直接 DELETE FROM + fs.rm 物理删, 无 deleted_at,
// 误删无救. 现在改成回收站模式:
//   1. 项目目录 mv 到 <projectsRoot>/.trash/<slug>__<deleteTs>/ (7 天保留)
//   2. 数据库行不 DELETE, 仅 UPDATE archived=1 + 新字段 deleted_at (兼容旧 schema)
//   3. 真正物理删交给 startup 时的 cleanupTrash (sweep 7 天前的 trash 目录)
// 调用方完全不感知: 返回值不变, summary 也仍然是删除前的快照.
// 如要恢复, 把 .trash/<slug>__<ts>/ 改名回 <projectsRoot>/<slug>/, 并 UPDATE archived=0.
const TRASH_RETENTION_DAYS = 7;

function ensureDeletedAtColumn(): void {
  // SQLite IF NOT EXISTS 风格: 已有则忽略错误
  try {
    getDb().prepare("ALTER TABLE projects ADD COLUMN deleted_at TEXT").run();
  } catch { /* column already exists */ }
}

export async function deleteProjectCascade(slug: string): Promise<{ ok: boolean; summary: ProjectDeleteSummary; trash_path: string }> {
  if (slug === "default") {
    throw Object.assign(new Error("不能删除默认项目"), { status: 400 });
  }
  const project = getProject(slug);
  if (!project) {
    throw Object.assign(new Error("项目不存在"), { status: 404 });
  }
  const summary = await summarizeProjectDeletion(slug);
  ensureDeletedAtColumn();

  const db = getDb();
  const now = new Date().toISOString();
  // A-7: 仅 archive, 不 DELETE FROM. task_queue 留着不动, 由 cleanupTrash 周期清理.
  const tx = db.transaction(() => {
    db.prepare("UPDATE projects SET archived = 1, deleted_at = ? WHERE id = ?").run(now, project.id);
  });
  tx();

  // A-7: 项目目录搬到 .trash/<slug>__<unix_ms>/
  const dir = projectDir(slug);
  const trashRoot = path.join(projectsRoot, ".trash");
  const trashStamp = `${slug}__${Date.now()}`;
  const trashPath = path.join(trashRoot, trashStamp);
  try {
    await fs.mkdir(trashRoot, { recursive: true });
    // dir 可能不存在 (项目只在 DB, 磁盘已被人手动清掉) — 这种情况跳过 rename.
    const dirExists = await fs.stat(dir).then(() => true).catch(() => false);
    if (dirExists) {
      await fs.rename(dir, trashPath);
    }
  } catch (err: any) {
    // rename 失败 (跨盘 / 权限) → 回滚 archive 状态
    db.prepare("UPDATE projects SET archived = 0, deleted_at = NULL WHERE id = ?").run(project.id);
    throw Object.assign(
      new Error(`删除项目失败 (无法搬到回收站): ${err?.message || String(err)}`),
      { status: 500 },
    );
  }

  return { ok: true, summary, trash_path: trashPath };
}

/**
 * A-7: 启动时调用, 清理 .trash/ 下超过 TRASH_RETENTION_DAYS 的目录.
 * 同时把对应 project 行硬删 (此时已过保留期, 用户没要求恢复, 视为彻底放弃).
 */
export async function cleanupProjectTrash(): Promise<{ removed: number; bytes: number }> {
  const trashRoot = path.join(projectsRoot, ".trash");
  let removed = 0;
  let bytes = 0;
  // P1-NEW: definite assignment 兼容 strict 模式
  let entries: string[] = [];
  try {
    entries = await fs.readdir(trashRoot);
  } catch {
    return { removed, bytes };
  }
  if (entries.length === 0) return { removed, bytes };
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  ensureDeletedAtColumn();
  const db = getDb();
  for (const entry of entries) {
    // 命名: <slug>__<ms>
    const m = entry.match(/^(.+)__(\d+)$/);
    if (!m) continue;
    const [, slug, msStr] = m;
    const ms = Number(msStr);
    if (!Number.isFinite(ms) || ms > cutoff) continue;
    const fullPath = path.join(trashRoot, entry);
    try {
      const size = await collectDirSummary(fullPath);
      bytes += size.bytes;
      await fs.rm(fullPath, { recursive: true, force: true });
      // 过保留期后才真删 DB 行
      // BUG-53: 先清理 shot_refs (通过 episodes → shots 的 shot_stable_id 关联)
      db.prepare("DELETE FROM shot_refs WHERE shot_stable_id IN (SELECT id FROM episodes WHERE project_id = (SELECT id FROM projects WHERE slug = ?))").run(slug);
      db.prepare("DELETE FROM task_queue WHERE project_id = (SELECT id FROM projects WHERE slug = ?)").run(slug);
      db.prepare("DELETE FROM projects WHERE slug = ? AND archived = 1").run(slug);
      removed += 1;
    } catch {
      // skip on error, 下一次还会试
    }
  }
  return { removed, bytes };
}

/**
 * A-7: 恢复一个被软删的项目: 把 .trash/<slug>__<ts>/ 改名回 <projectsRoot>/<slug>/.
 * 调用方传 trash_path (从 deleteProjectCascade 返回的) 或 slug.
 */
export async function restoreProjectFromTrash(slug: string): Promise<{ ok: boolean }> {
  const project = getProject(slug);
  if (!project || project.archived !== 1) {
    throw Object.assign(new Error("项目未被删除或不存在"), { status: 404 });
  }
  const trashRoot = path.join(projectsRoot, ".trash");
  const entries = await fs.readdir(trashRoot).catch(() => [] as string[]);
  // BUG-55: slug 本身可能含 "__"，用 lastIndexOf 分割而非 split('__').pop()
  const prefix = `${slug}__`;
  const candidates = entries
    .filter((e) => e.startsWith(prefix))
    .map((e) => {
      const tsStr = e.slice(e.lastIndexOf("__") + 2);
      return { name: e, ts: Number(tsStr) || 0 };
    })
    .sort((a, b) => b.ts - a.ts);
  if (candidates.length === 0) {
    throw Object.assign(new Error("回收站中找不到该项目"), { status: 404 });
  }
  const src = path.join(trashRoot, candidates[0].name);
  const dst = projectDir(slug);
  // BUG-55: rename 前确保目标父目录存在
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
  getDb().prepare("UPDATE projects SET archived = 0, deleted_at = NULL WHERE id = ?").run(project.id);
  return { ok: true };
}

export function ensureDefaultProject(): ProjectRow {
  const existing = getProject("default");
  if (existing) return existing;
  return createProject({ slug: "default", title: "默认项目", description: "自动迁移的旧任务" });
}
