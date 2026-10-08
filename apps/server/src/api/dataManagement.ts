import fs from "node:fs/promises";
import * as fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { Archiver } from "archiver";
import {
  assetsRoot,
  projectDir,
  projectsRoot,
  repoRoot,
  type ProjectRow,
  closeDb,
  getDb,
  createProject,
  getProject,
} from "../../../../packages/core/src/index";
import { ensureDir, pathExists, safeFileName } from "../../../../packages/core/src/fs";
import { runProcess } from "../../../../packages/render/src/process";
import { createZipArchive } from "../lib/archive";

// X7-2 (A7-2, 2026-07-22): 每日自动备份从某版本起静默失效 (`archiver is not a function`).
// 根因: archiver@8 是 ESM-only 重写, 抛弃了旧的可调用工厂 `archiver("zip", opts)`,
// 只导出具名类 { ZipArchive, TarArchive, JsonArchive }. require("archiver") 拿到的是模块 namespace
// (对象, 不可调用) → 老写法运行时炸. 而 @types/archiver@7 仍描述旧工厂签名, 所以类型能过 tsc、运行时挂,
// 备份这条数据保护安全网从此静默失效 (A7 只在启动日志见 WARN, 无 UI/诊断提示 —— 见 X7-2 第二半的可见化).
// 2026-07-22 XT-T1: createZipArchive (v8 具名类 / v7 可调用工厂 / interop default 三路兜底) 抽到
// apps/server/src/lib/archive.ts 共享模块 —— exportUseCases.ts 原来有完全相同的坏写法, 现两处同源。

export interface StorageProjectUsage {
  slug: string;
  title: string;
  bytes: number;
  file_count: number;
  image_count: number;
  video_count: number;
  updated_at: string;
}

export interface StorageUsageReport {
  total_bytes: number;
  project_root_bytes: number;
  assets_root_bytes: number;
  outputs_root_bytes: number;
  config_bytes: number;
  data_bytes: number;
  projects: StorageProjectUsage[];
  generated_at: string;
}

export interface CleanupReport {
  removed_count: number;
  removed_bytes: number;
  removed_paths: string[];
  generated_at: string;
}

export interface BackupArchiveResult {
  path: string;
  filename: string;
  created_at: string;
}

export interface ProjectExportResult {
  path: string;
  filename: string;
  project: ProjectRow;
  created_at: string;
}

export interface ProjectImportResult {
  project: ProjectRow;
  imported_at: string;
  source_archive: string;
}

const BACKUP_ROOT = path.join(os.homedir(), ".video-generate-backups");

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const TEMP_EXTS = new Set([".tmp", ".part", ".bak", ".old"]);

function resolveInsideRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes root: ${target}`);
  }
  return resolvedTarget;
}

async function walkDir(dir: string): Promise<{ bytes: number; file_count: number; image_count: number; video_count: number }> {
  let bytes = 0;
  let file_count = 0;
  let image_count = 0;
  let video_count = 0;

  async function visit(current: string): Promise<void> {
    let entries: fssync.Dirent[];
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
        if (IMAGE_EXTS.has(ext)) image_count += 1;
        if (VIDEO_EXTS.has(ext)) video_count += 1;
      } catch {
        // best effort
      }
    }
  }

  await visit(dir);
  return { bytes, file_count, image_count, video_count };
}

async function writeArchive(outputPath: string, build: (archive: Archiver) => void): Promise<void> {
  await ensureDir(path.dirname(outputPath));
  await new Promise<void>((resolve, reject) => {
    const output = fssync.createWriteStream(outputPath);
    const archive = createZipArchive({ zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    build(archive);
    void archive.finalize();
  });
}

async function cleanupOldBackups(retentionDays = 7): Promise<void> {
  try {
    await ensureDir(BACKUP_ROOT);
    const entries = await fs.readdir(BACKUP_ROOT);
    const threshold = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    await Promise.all(entries.map(async (name) => {
      const full = path.join(BACKUP_ROOT, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile() && stat.mtimeMs < threshold) {
          await fs.rm(full, { force: true });
        }
      } catch {
        // best effort
      }
    }));
  } catch {
    // best effort
  }
}

async function collectProjectRowUsage(row: ProjectRow): Promise<StorageProjectUsage> {
  const dir = projectDir(row.slug);
  const stats = await walkDir(dir);
  return {
    slug: row.slug,
    title: row.title,
    bytes: stats.bytes,
    file_count: stats.file_count,
    image_count: stats.image_count,
    video_count: stats.video_count,
    updated_at: row.updated_at,
  };
}

export async function getStorageUsage(): Promise<StorageUsageReport> {
  const [projectStats, assetsStats, outputsStats, configStats, dataStats] = await Promise.all([
    walkDir(projectsRoot),
    walkDir(assetsRoot),
    walkDir(path.join(repoRoot, "outputs")),
    walkDir(path.join(repoRoot, "config")),
    walkDir(path.join(repoRoot, "data")),
  ]);

  const projects = (await Promise.all((getDb().prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as ProjectRow[]).map(collectProjectRowUsage)))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    total_bytes: projectStats.bytes + assetsStats.bytes + outputsStats.bytes + configStats.bytes + dataStats.bytes,
    project_root_bytes: projectStats.bytes,
    assets_root_bytes: assetsStats.bytes,
    outputs_root_bytes: outputsStats.bytes,
    config_bytes: configStats.bytes,
    data_bytes: dataStats.bytes,
    projects,
    generated_at: new Date().toISOString(),
  };
}

export async function cleanupStorage(): Promise<CleanupReport> {
  const removed_paths: string[] = [];
  let removed_bytes = 0;
  let removed_count = 0;
  const roots = [path.join(repoRoot, "config"), projectsRoot, assetsRoot, path.join(repoRoot, "outputs"), path.join(repoRoot, "data")];

  const removeFile = async (filePath: string) => {
    try {
      const stat = await fs.stat(filePath);
      await fs.rm(filePath, { force: true });
      removed_bytes += stat.size;
      removed_count += 1;
      removed_paths.push(filePath);
    } catch {
      // best effort
    }
  };

  async function visit(dir: string): Promise<void> {
    let entries: fssync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (TEMP_EXTS.has(ext) || entry.name.endsWith(".tmp") || entry.name.endsWith(".part") || entry.name.endsWith(".bak")) {
        await removeFile(full);
      }
    }
  }

  for (const root of roots) {
    await visit(root);
  }

  return {
    removed_count,
    removed_bytes,
    removed_paths,
    generated_at: new Date().toISOString(),
  };
}

export async function createBackupArchive(): Promise<BackupArchiveResult> {
  await cleanupOldBackups(7);
  await ensureDir(BACKUP_ROOT);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `video-generate-backup-${stamp}.zip`;
  const outputPath = path.join(BACKUP_ROOT, filename);

  await writeArchive(outputPath, (archive) => {
    const configDir = path.join(repoRoot, "config");
    const localSettings = path.join(configDir, "local-settings.json");
    const projectsDb = path.join(configDir, "projects.db");
    const wal = `${projectsDb}-wal`;
    const shm = `${projectsDb}-shm`;
    if (fssync.existsSync(localSettings)) archive.file(localSettings, { name: "config/local-settings.json" });
    if (fssync.existsSync(projectsDb)) archive.file(projectsDb, { name: "config/projects.db" });
    if (fssync.existsSync(wal)) archive.file(wal, { name: "config/projects.db-wal" });
    if (fssync.existsSync(shm)) archive.file(shm, { name: "config/projects.db-shm" });
    if (fssync.existsSync(projectsRoot)) archive.directory(projectsRoot, "projects");
    if (fssync.existsSync(assetsRoot)) archive.directory(assetsRoot, "assets");
  });

  return {
    path: outputPath,
    filename,
    created_at: new Date().toISOString(),
  };
}

async function extractArchive(archivePath: string, extractDir: string): Promise<void> {
  const result = await runProcess("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "param($zip,$dest) Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force",
    archivePath,
    extractDir,
  ], { timeoutMs: 120_000, stdoutLimitBytes: 16 * 1024, stderrLimitBytes: 16 * 1024 });
  if (result.code !== 0) {
    throw new Error(`Archive extraction failed: ${result.stderr.slice(-400)}`);
  }
}

async function findArchiveRoot(dir: string): Promise<string> {
  const directMarkers = ["config", "projects", "assets", "manifest.json"];
  const directHasMarker = await Promise.all(directMarkers.map(async (marker) => pathExists(path.join(dir, marker))));
  if (directHasMarker.some(Boolean)) return dir;
  const children = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory());
  for (const child of children) {
    const childPath = path.join(dir, child.name);
    const childHasMarker = await Promise.all(directMarkers.map(async (marker) => pathExists(path.join(childPath, marker))));
    if (childHasMarker.some(Boolean)) return childPath;
  }
  return dir;
}

async function copyTree(src: string, dst: string): Promise<void> {
  if (!(await pathExists(src))) return;
  await fs.rm(dst, { recursive: true, force: true });
  await ensureDir(path.dirname(dst));
  await fs.cp(src, dst, { recursive: true, force: true });
}

async function mergeTree(src: string, dst: string): Promise<void> {
  if (!(await pathExists(src))) return;
  await ensureDir(dst);
  await fs.cp(src, dst, { recursive: true, force: true });
}

export async function restoreBackupArchive(archivePath: string): Promise<{ restored_at: string }> {
  const absArchive = path.resolve(archivePath);
  if (!(await pathExists(absArchive))) {
    throw Object.assign(new Error(`备份文件不存在: ${archivePath}`), { status: 404 });
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-generate-restore-"));
  await extractArchive(absArchive, tempDir);
  const root = await findArchiveRoot(tempDir);

  closeDb();

  await copyTree(path.join(root, "config", "local-settings.json"), path.join(repoRoot, "config", "local-settings.json"));
  await copyTree(path.join(root, "config", "projects.db"), path.join(repoRoot, "config", "projects.db"));
  await copyTree(path.join(root, "config", "projects.db-wal"), path.join(repoRoot, "config", "projects.db-wal"));
  await copyTree(path.join(root, "config", "projects.db-shm"), path.join(repoRoot, "config", "projects.db-shm"));
  await copyTree(path.join(root, "projects"), projectsRoot);
  await copyTree(path.join(root, "assets"), assetsRoot);

  return { restored_at: new Date().toISOString() };
}

function normalizeProjectSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "imported-project";
}

function buildProjectManifest(project: ProjectRow, db: ReturnType<typeof getDb>) {
  const projectId = project.id;
  return {
    export_type: "vgproj",
    exported_at: new Date().toISOString(),
    project,
    episodes: db.prepare("SELECT * FROM episodes WHERE project_id = ? ORDER BY episode_number ASC, created_at ASC").all(projectId),
    characters: db.prepare("SELECT * FROM characters WHERE project_id = ? ORDER BY created_at ASC").all(projectId),
    scenes: db.prepare("SELECT * FROM scenes WHERE project_id = ? ORDER BY created_at ASC").all(projectId),
    styles: db.prepare("SELECT * FROM styles WHERE project_id = ? ORDER BY created_at ASC").all(projectId),
    vault_records: db.prepare("SELECT * FROM vault_records WHERE project_id = ? ORDER BY created_at ASC").all(projectId),
    assets: db.prepare("SELECT * FROM assets WHERE source_project_slug = ? OR source_resource_id IN (SELECT id FROM characters WHERE project_id = ? UNION SELECT id FROM scenes WHERE project_id = ? UNION SELECT id FROM styles WHERE project_id = ? UNION SELECT id FROM vault_records WHERE project_id = ?)")
      .all(project.slug, projectId, projectId, projectId, projectId),
  };
}

export async function createProjectExportArchive(slug: string): Promise<ProjectExportResult> {
  const project = getProject(slug);
  if (!project) {
    throw Object.assign(new Error(`项目不存在: ${slug}`), { status: 404 });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${safeFileName(project.slug)}-${stamp}.vgproj`;
  const outputPath = path.join(os.tmpdir(), filename);
  const projectPath = projectDir(project.slug);
  const db = getDb();
  const manifest = buildProjectManifest(project, db);

  await writeArchive(outputPath, (archive) => {
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    if (fssync.existsSync(projectPath)) {
      archive.directory(projectPath, "project-files");
    }
    if (fssync.existsSync(assetsRoot)) {
      archive.directory(assetsRoot, "assets");
    }
  });

  return {
    path: outputPath,
    filename,
    project,
    created_at: new Date().toISOString(),
  };
}

function insertRowsForProject(table: string, rows: Record<string, unknown>[], projectId: string): void {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const db = getDb();
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));
  const now = new Date().toISOString();
  const insertColumns = columns.map((c) => c.name);
  const placeholders = insertColumns.map(() => "?").join(", ");
  const sql = `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES (${placeholders})`;
  const stmt = db.prepare(sql);

  for (const row of rows) {
    const payload: Record<string, unknown> = {};
    for (const col of insertColumns) {
      if (col === "project_id") {
        payload[col] = projectId;
      } else if (col === "id") {
        payload[col] = typeof row.id === "string" && row.id ? `${row.id}_${crypto.randomUUID()}` : crypto.randomUUID();
      } else if (col === "created_at" || col === "updated_at") {
        payload[col] = typeof row[col] === "string" ? row[col] : now;
      } else if (col in row) {
        payload[col] = row[col];
      } else {
        payload[col] = null;
      }
    }
    stmt.run(...insertColumns.map((col) => payload[col] ?? null));
  }
}

function insertAssetsRows(rows: Record<string, unknown>[]): void {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>;
  const insertColumns = columns.map((c) => c.name);
  const placeholders = insertColumns.map(() => "?").join(", ");
  const sql = `INSERT OR IGNORE INTO assets (${insertColumns.join(", ")}) VALUES (${placeholders})`;
  const stmt = db.prepare(sql);
  const now = new Date().toISOString();

  for (const row of rows) {
    const payload: Record<string, unknown> = {};
    for (const col of insertColumns) {
      if (col === "created_at" || col === "updated_at") {
        payload[col] = typeof row[col] === "string" ? row[col] : now;
      } else if (col in row) {
        payload[col] = row[col];
      } else {
        payload[col] = null;
      }
    }
    stmt.run(...insertColumns.map((col) => payload[col] ?? null));
  }
}

export async function importProjectArchive(archivePath: string): Promise<ProjectImportResult> {
  const absArchive = path.resolve(archivePath);
  if (!(await pathExists(absArchive))) {
    throw Object.assign(new Error(`导入文件不存在: ${archivePath}`), { status: 404 });
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-generate-import-"));
  await extractArchive(absArchive, tempDir);
  const root = await findArchiveRoot(tempDir);
  const manifestPath = path.join(root, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw Object.assign(new Error("manifest.json 不存在，无法识别 .vgproj 包"), { status: 400 });
  }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch {
    throw Object.assign(new Error("manifest.json 格式损坏，无法解析"), { status: 400 });
  }
  const sourceProject = manifest.project as ProjectRow | undefined;
  if (!sourceProject?.slug) {
    throw Object.assign(new Error("manifest 中缺少 project 信息"), { status: 400 });
  }

  const baseSlug = normalizeProjectSlug(sourceProject.slug);
  let slug = baseSlug;
  let suffix = 1;
  while (getProject(slug)) {
    slug = `${baseSlug}-${suffix++}`;
  }
  const project = createProject({
    slug,
    title: sourceProject.title || slug,
    description: sourceProject.description || "",
    aspect_ratio: sourceProject.aspect_ratio || "16:9",
    resolution: sourceProject.resolution || "1920x1080",
    default_style: sourceProject.default_style || "auto",
  });

  const db = getDb();
  const tx = db.transaction(() => {
    insertAssetsRows(Array.isArray(manifest.assets) ? manifest.assets : []);
    return {
      episodes: insertRowsForProject("episodes", Array.isArray(manifest.episodes) ? manifest.episodes : [], project.id),
      characters: insertRowsForProject("characters", Array.isArray(manifest.characters) ? manifest.characters : [], project.id),
      scenes: insertRowsForProject("scenes", Array.isArray(manifest.scenes) ? manifest.scenes : [], project.id),
      styles: insertRowsForProject("styles", Array.isArray(manifest.styles) ? manifest.styles : [], project.id),
      vault_records: insertRowsForProject("vault_records", Array.isArray(manifest.vault_records) ? manifest.vault_records : [], project.id),
    };
  });
  tx();

  const projectFiles = path.join(root, "project-files");
  if (await pathExists(projectFiles)) {
    await copyTree(projectFiles, projectDir(project.slug));
  }
  const assetsFiles = path.join(root, "assets");
  if (await pathExists(assetsFiles)) {
    await mergeTree(assetsFiles, assetsRoot);
  }

  return {
    project,
    imported_at: new Date().toISOString(),
    source_archive: absArchive,
  };
}

/**
 * 2026-07-22 U-fix1 (X7-2 收尾): 判定某目录下"今天是否已有一份 *非空* 备份"。
 *
 * 旧 ensureDailyBackup 只按"今日文件名前缀"判定已备份, 不看大小 —— archiver 曾静默失效
 * (`archiver is not a function`) 留下的 0 字节空壳会命中前缀被误判为"今天已备份", 于是 return null
 * 跳过重建, 启动路径据此把 lastBackupStatus 记成 ok:true → /healthz "绿而空" (报 ok 却磁盘无有效备份)。
 *
 * 这里命中今日 zip 时校验 size>0, 返回第一份非空备份名; 全是空壳(或没有)则返回 null, 视同今日未备份需重建。
 * (导出为可测: 见 execution/UFIX1 的隔离验证 —— 传入临时目录 + 0字节/非空文件断言 size 判定。)
 */
export function findNonEmptyTodayBackup(root: string, todayPrefix: string): string | null {
  if (!fssync.existsSync(root)) return null;
  let names: string[];
  try {
    names = fssync.readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith(`video-generate-backup-${todayPrefix}`) || !name.endsWith(".zip")) continue;
    try {
      const st = fssync.statSync(path.join(root, name));
      if (st.isFile() && st.size > 0) return name;
    } catch {
      // 读不到就跳过, 不把它当作有效备份 (宁可重建也不误判"绿而空")
    }
  }
  return null;
}

export async function ensureDailyBackup(): Promise<BackupArchiveResult | null> {
  await cleanupOldBackups(7);
  const todayPrefix = new Date().toISOString().slice(0, 10);
  // U-fix1: 只有"今天已有一份非空备份"才跳过; 命中 0 字节空壳视同今日未备份, 重新生成一份真备份。
  if (findNonEmptyTodayBackup(BACKUP_ROOT, todayPrefix)) return null;
  return createBackupArchive();
}
