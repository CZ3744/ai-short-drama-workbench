// T14: Public asset library CRUD — cross-project resource sharing
import * as fsSync from "node:fs";
import path from "node:path";
import { getDb } from "./database";
import { getProject, getProjectById, type ProjectRow } from "./projects";
import { projectDir, repoRoot } from "../paths";
import { safeFileName } from "../fs";
import { ulid } from "ulid";

// ── Types ──────────────────────────────────────────────────────────

export type AssetType = "character" | "scene" | "style" | "voice" | "vault";

export interface AssetRow {
  id: string;
  asset_type: AssetType;
  name: string;
  description: string;
  tags: string; // JSON array
  thumbnail_path: string | null;
  source_project_slug: string | null; // null = 原生公共库
  source_resource_id: string | null; // original resource id in source project table
  source_asset_id: string | null;
  version: number;
  major_version: number;
  minor_version: number;
  created_at: string;
  updated_at: string;
}

// ── Internal helpers ───────────────────────────────────────────────

function ensureAssetsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('character','scene','style','voice','vault')),
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      thumbnail_path TEXT,
      source_project_slug TEXT,
      source_resource_id TEXT,
      source_asset_id TEXT,
      version INTEGER DEFAULT 1,
      major_version INTEGER DEFAULT 1,
      minor_version INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
    CREATE INDEX IF NOT EXISTS idx_assets_type_updated ON assets(asset_type, updated_at DESC);
  `);
  ensureAssetColumn(db, "source_asset_id", "TEXT");
  ensureAssetColumn(db, "major_version", "INTEGER DEFAULT 1");
  ensureAssetColumn(db, "minor_version", "INTEGER DEFAULT 0");
}

function ensureAssetColumn(db: ReturnType<typeof getDb>, column: string, definition: string): void {
  const columns = db.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.prepare(`ALTER TABLE assets ADD COLUMN ${column} ${definition}`).run();
  }
}

function tagsToJson(tags: string[] | undefined | null): string {
  if (!tags || tags.length === 0) return "[]";
  return JSON.stringify(tags);
}

function rowToAsset(row: any): AssetRow {
  return row as AssetRow;
}

// ── CRUD ───────────────────────────────────────────────────────────

export function createAsset(input: {
  asset_type: AssetType;
  name: string;
  description?: string;
  tags?: string[];
  thumbnail_path?: string;
}): AssetRow {
  ensureAssetsTable();
  const db = getDb();
  const now = new Date().toISOString();
  const id = ulid();
  db.prepare(`
    INSERT INTO assets (id, asset_type, name, description, tags, thumbnail_path, version, major_version, minor_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)
  `).run(id, input.asset_type, input.name, input.description ?? "", tagsToJson(input.tags), input.thumbnail_path ?? null, now, now);
  return getAsset(id)!;
}

export function getAsset(id: string): AssetRow | undefined {
  ensureAssetsTable();
  const row = getDb().prepare("SELECT * FROM assets WHERE id = ?").get(id);
  return row ? rowToAsset(row) : undefined;
}

export function listAssets(type?: AssetType, search?: string, tags?: string[]): AssetRow[] {
  ensureAssetsTable();
  const db = getDb();
  const clauses: string[] = [];
  const params: any[] = [];

  if (type) {
    clauses.push("asset_type = ?");
    params.push(type);
  }

  if (search) {
    clauses.push("(name LIKE ? OR description LIKE ?)");
    const pattern = `%${search}%`;
    params.push(pattern, pattern);
  }

  if (tags && tags.length > 0) {
    // BUG-59: 改用 json_each 精确匹配, 替代 LIKE 模糊匹配(会误匹配子串)
    for (const tag of tags) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(assets.tags) WHERE json_each.value = ?)");
      params.push(tag);
    }
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM assets ${where} ORDER BY updated_at DESC`;
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToAsset);
}

// A-10 (2026-05-12): 之前 major_version / minor_version 在 INSERT 时设默认 1/0,
// UPDATE 路径完全不维护, 形同 dead column. 现在按语义同步:
//   - majorBump=true  → major_version++ , minor_version=0 (重大变更, e.g. 重新生成)
//   - majorBump=false → minor_version++ (默认, 元数据微调)
// version 字段仍保留为单调累加的扁平版本号 (向后兼容).
export function updateAsset(
  id: string,
  updates: {
    name?: string;
    description?: string;
    tags?: string[];
    thumbnail_path?: string | null;
    majorBump?: boolean;
  }
): AssetRow | undefined {
  ensureAssetsTable();
  const db = getDb();
  const existing = getAsset(id);
  if (!existing) return undefined;

  const now = new Date().toISOString();
  const newVersion = existing.version + 1;
  // A-10: 默认 minor bump; 调用方显式传 majorBump:true 才升 major
  const majorBump = updates.majorBump === true;
  const newMajor = majorBump ? existing.major_version + 1 : existing.major_version;
  const newMinor = majorBump ? 0 : existing.minor_version + 1;

  const merged = {
    name: updates.name ?? existing.name,
    description: updates.description ?? existing.description,
    tags: updates.tags !== undefined ? tagsToJson(updates.tags) : existing.tags,
    thumbnail_path: updates.thumbnail_path !== undefined ? updates.thumbnail_path : existing.thumbnail_path,
  };

  db.prepare(`
    UPDATE assets
    SET name = ?, description = ?, tags = ?, thumbnail_path = ?,
        version = ?, major_version = ?, minor_version = ?, updated_at = ?
    WHERE id = ?
  `).run(
    merged.name, merged.description, merged.tags, merged.thumbnail_path,
    newVersion, newMajor, newMinor, now, id,
  );

  return getAsset(id);
}

export function deleteAsset(id: string): boolean {
  ensureAssetsTable();
  const result = getDb().prepare("DELETE FROM assets WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── Import / Export ────────────────────────────────────────────────

export function importFromProject(
  projectSlug: string,
  assetType: AssetType,
  resourceId: string,
  newName?: string
): AssetRow {
  ensureAssetsTable();
  const db = getDb();
  const project = getProject(projectSlug);
  if (!project) throw Object.assign(new Error(`项目 "${projectSlug}" 不存在`), { status: 404 });

  // Look up the resource in the appropriate project-scoped table.
  let sourceRow: any;
  let sourceName: string;
  let sourceDesc: string;
  let sourceTags: string[];
  let sourceThumb: string | null;

  switch (assetType) {
    case "character": {
      sourceRow = db
        .prepare("SELECT * FROM characters WHERE id = ? AND project_id = ?")
        .get(resourceId, project.id);
      if (!sourceRow) throw Object.assign(new Error(`角色 "${resourceId}" 在项目 "${projectSlug}" 中不存在`), { status: 404 });
      sourceName = sourceRow.name;
      sourceDesc = sourceRow.description ?? "";
      sourceTags = JSON.parse(sourceRow.tags || "[]");
      sourceThumb = sourceRow.thumbnail_path ?? null;
      break;
    }
    case "scene": {
      sourceRow = db
        .prepare("SELECT * FROM scenes WHERE id = ? AND project_id = ?")
        .get(resourceId, project.id);
      if (!sourceRow) throw Object.assign(new Error(`场景 "${resourceId}" 在项目 "${projectSlug}" 中不存在`), { status: 404 });
      sourceName = sourceRow.name;
      sourceDesc = sourceRow.description ?? "";
      sourceTags = JSON.parse(sourceRow.tags || "[]");
      sourceThumb = sourceRow.thumbnail_path ?? null;
      break;
    }
    case "style": {
      sourceRow = db
        .prepare("SELECT * FROM styles WHERE id = ? AND project_id = ?")
        .get(resourceId, project.id);
      if (!sourceRow) throw Object.assign(new Error(`风格 "${resourceId}" 在项目 "${projectSlug}" 中不存在`), { status: 404 });
      sourceName = sourceRow.name;
      sourceDesc = sourceRow.description ?? "";
      sourceTags = JSON.parse(sourceRow.keywords || "[]");
      sourceThumb = sourceRow.reference_board_path ?? null;
      break;
    }
    case "voice": {
      // Voice data lives on the characters table (voice_provider / voice_id etc.)
      sourceRow = db
        .prepare("SELECT * FROM characters WHERE id = ? AND project_id = ? AND voice_provider IS NOT NULL AND voice_id IS NOT NULL")
        .get(resourceId, project.id);
      if (!sourceRow) throw Object.assign(new Error(`语音 "${resourceId}" 在项目 "${projectSlug}" 中不存在或缺少 voice 配置`), { status: 404 });
      sourceName = sourceRow.name;
      sourceDesc = `Voice: ${sourceRow.voice_provider ?? "unknown"} / ${sourceRow.voice_id ?? "unknown"}`;
      sourceTags = JSON.parse(sourceRow.tags || "[]");
      sourceThumb = sourceRow.thumbnail_path ?? null;
      break;
    }
    case "vault": {
      sourceRow = db
        .prepare("SELECT * FROM vault_records WHERE id = ? AND project_id = ?")
        .get(resourceId, project.id);
      if (!sourceRow) throw Object.assign(new Error(`素材 "${resourceId}" 在项目 "${projectSlug}" 中不存在`), { status: 404 });
      sourceName = sourceRow.prompt ? sourceRow.prompt.slice(0, 80) : `Vault ${resourceId.slice(0, 8)}`;
      sourceDesc = sourceRow.prompt ?? "";
      sourceTags = JSON.parse(sourceRow.tags || "[]");
      sourceThumb = sourceRow.thumbnail_path ?? null;
      break;
    }
    default:
      throw Object.assign(new Error(`不支持的资源类型: ${assetType}`), { status: 400 });
  }

  const now = new Date().toISOString();
  const id = ulid();

  db.prepare(`
    INSERT INTO assets (id, asset_type, name, description, tags, thumbnail_path, source_project_slug, source_resource_id, source_asset_id, version, major_version, minor_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 1, 0, ?, ?)
  `).run(
    id,
    assetType,
    newName || sourceName,
    sourceDesc,
    tagsToJson(sourceTags),
    sourceThumb,
    projectSlug,
    resourceId,
    now,
    now
  );

  return getAsset(id)!;
}

function copyAssetPathToProject(assetPath: string | null, targetProjectSlug: string, assetType: AssetType, resourceId: string): string | null {
  if (!assetPath) return null;
  const resolved = path.isAbsolute(assetPath) ? assetPath : path.resolve(repoRoot, assetPath);
  if (!resolved || !fsSync.existsSync(resolved)) return null;
  const fileName = safeFileName(path.basename(resolved));
  const destDir = path.join(projectDir(targetProjectSlug), "assets", "imported", assetType, resourceId);
  fsSync.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, fileName);
  fsSync.copyFileSync(resolved, destPath);
  return path.relative(repoRoot, destPath).replace(/\\/g, "/");
}

export function importFromAsset(
  assetId: string,
  targetProjectSlug: string,
  newName?: string
): { ok: boolean } {
  ensureAssetsTable();
  const db = getDb();

  const asset = getAsset(assetId);
  if (!asset) throw Object.assign(new Error(`素材 "${assetId}" 不存在`), { status: 404 });

  const targetProject = getProject(targetProjectSlug);
  if (!targetProject) throw Object.assign(new Error(`目标项目 "${targetProjectSlug}" 不存在`), { status: 404 });

  const now = new Date().toISOString();
  const id = ulid();
  const name = newName || asset.name;
  const tags = asset.tags;
  const copiedThumb = copyAssetPathToProject(asset.thumbnail_path, targetProjectSlug, asset.asset_type, id) ?? asset.thumbnail_path;

  switch (asset.asset_type) {
    case "character": {
      db.prepare(`
        INSERT INTO characters (id, project_id, asset_library_id, source_asset_id, name, description, tags, thumbnail_path, major_version, minor_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
      `).run(id, targetProject.id, asset.id, asset.id, name, asset.description, tags, copiedThumb, now, now);
      break;
    }
    case "scene": {
      db.prepare(`
        INSERT INTO scenes (id, project_id, asset_library_id, source_asset_id, name, description, tags, thumbnail_path, major_version, minor_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
      `).run(id, targetProject.id, asset.id, asset.id, name, asset.description, tags, copiedThumb, now, now);
      break;
    }
    case "style": {
      db.prepare(`
        INSERT INTO styles (id, project_id, asset_library_id, source_asset_id, name, description, keywords, reference_board_path, major_version, minor_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
      `).run(id, targetProject.id, asset.id, asset.id, name, asset.description, tags, copiedThumb, now, now);
      break;
    }
    case "voice": {
      // Voice assets: create a minimal character entry holding voice metadata.
      // No voice_provider / voice_id columns are filled since the asset only
      // carries name/description/tags — downstream code can enrich later.
      db.prepare(`
        INSERT INTO characters (id, project_id, asset_library_id, source_asset_id, name, description, tags, thumbnail_path, major_version, minor_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
      `).run(id, targetProject.id, asset.id, asset.id, name, asset.description, tags, copiedThumb, now, now);
      break;
    }
    case "vault": {
      const yearMonth = now.slice(0, 7);
      db.prepare(`
        INSERT INTO vault_records (id, project_id, asset_library_id, source_asset_id, record_type, thumbnail_path, file_path, prompt, status, tags, year_month, major_version, minor_version, created_at)
        VALUES (?, ?, ?, ?, 'image', ?, ?, ?, 'unused', ?, ?, 1, 0, ?)
      `).run(id, targetProject.id, asset.id, asset.id, copiedThumb, copiedThumb, asset.description, tags, yearMonth, now);
      break;
    }
    default:
      throw Object.assign(new Error(`不支持的资源类型: ${asset.asset_type}`), { status: 400 });
  }

  return { ok: true };
}

export function exportToProject(assetId: string, targetProjectSlug: string, newName?: string): { ok: boolean } {
  return importFromAsset(assetId, targetProjectSlug, newName);
}

// ── Schematic helpers (for list rendering hints) ───────────────────

/** Human-readable labels used by the frontend asset browser. */
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  character: "角色",
  scene: "场景",
  style: "风格",
  voice: "语音",
  vault: "素材库",
};

export const ASSET_TYPES: readonly AssetType[] = ["character", "scene", "style", "voice", "vault"] as const;
