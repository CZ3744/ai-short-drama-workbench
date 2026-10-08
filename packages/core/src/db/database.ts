// T13: SQLite database layer for multi-project data model
import Database from "better-sqlite3";
import path from "node:path";
import { repoRoot } from "../paths";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = path.join(repoRoot, "config", "projects.db");
  // 2026-05-25: db 走 repoRoot, 每个 worktree 各一份 db. 启 dev 在 worktree 里会看到空 db
  // 误以为"系列丢了". 检测到 worktree 启动时 warn 一下, 不改路径(避免影响 e2e/单测).
  if (repoRoot.includes(path.sep + ".claude" + path.sep + "worktrees" + path.sep)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[db] 警告: 当前在 git worktree 中启动 (${repoRoot}). db 走 worktree 自己的 config/projects.db,` +
      ` 不是原工作目录的数据库。如果看不到原有系列，请从保存作品的项目目录启动。`,
    );
  }
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  // B-N1 (2026-05-12): 之前没设 busy_timeout, 高并发 (SSE 推 + reconcile + 后台 job 写)
  // 容易 SQLITE_BUSY 抛错. 给 5 秒重试窗口, 让正常的小冲突自愈而非抛上去.
  _db.pragma("busy_timeout = 5000");
  // B-N1: synchronous = NORMAL 在 WAL 模式下是官方推荐值, 比默认 FULL 快很多且不丢数据.
  _db.pragma("synchronous = NORMAL");
  ensureSchema(_db);
  // A-13: 接入正式 migration runner.
  runPendingMigrations(_db);
  // B-N2 (2026-05-12): 定期 checkpoint 防止 WAL 文件膨胀. 5 分钟一次, PASSIVE 不阻塞.
  scheduleWalCheckpoint(_db);
  return _db;
}

// B-N2: WAL checkpoint 调度器
let _checkpointTimer: ReturnType<typeof setInterval> | null = null;
function scheduleWalCheckpoint(db: Database.Database): void {
  if (_checkpointTimer) return;
  const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
  _checkpointTimer = setInterval(() => {
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // checkpoint 失败不致命, 下次再试
    }
  }, CHECKPOINT_INTERVAL_MS);
  // 让 timer 不阻塞 Node 退出
  if (typeof _checkpointTimer.unref === "function") _checkpointTimer.unref();
}

// ── A-13 migration system ────────────────────────────────────────────────────
interface NumberedMigration {
  id: string;                 // 单调递增 id, 如 "0001_add_deleted_at"
  description: string;
  up: (db: Database.Database) => void;
}

const NUMBERED_MIGRATIONS: NumberedMigration[] = [
  // A-7 配套: projects.deleted_at (软删时间戳). projects.ts ensureDeletedAtColumn 也写,
  // 这里做正式记录. 重复 ADD COLUMN 已 try/catch 保护.
  {
    id: "0001_projects_deleted_at",
    description: "A-7 soft delete: add projects.deleted_at TEXT",
    up: (db) => {
      try {
        db.prepare("ALTER TABLE projects ADD COLUMN deleted_at TEXT").run();
      } catch { /* exists */ }
    },
  },
  // A-7 配套: 索引帮助 listProjects 过滤 archived=0
  {
    id: "0002_projects_archived_idx",
    description: "A-7 listProjects fast-path index",
    up: (db) => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived)");
    },
  },
  // B-N5 (2026-05-12): task_queue 经常按 status + priority 查询 (popNext / listQueueTasks),
  // 之前无复合索引, 大队列时 full scan. 加索引让 enqueue / popNext 都走 b-tree.
  {
    id: "0003_task_queue_status_priority_idx",
    description: "B-N5 task_queue.status + priority composite index",
    up: (db) => {
      // New installs initialize task_queue later. Its initializer creates these same
      // indexes; this migration only upgrades queues that already exist.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_queue'").get()) return;
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_queue_status_priority ON task_queue(status, priority ASC, created_at ASC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_queue_project ON task_queue(project_id)");
    },
  },
  // B-N7 (2026-05-12): assets 用 source_project_slug 跨项目查找;之前 list 全表扫.
  {
    id: "0004_assets_source_project_idx",
    description: "B-N7 assets.source_project_slug index for cross-project lookup",
    up: (db) => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_assets_source_project ON assets(source_project_slug)");
    },
  },
];

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT
    );
  `);
}

function runPendingMigrations(db: Database.Database): void {
  ensureMigrationTable(db);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>).map((r) => r.id),
  );
  const now = new Date().toISOString();
  for (const m of NUMBERED_MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations (id, applied_at, description) VALUES (?, ?, ?)")
        .run(m.id, now, m.description);
    });
    try {
      tx();
    } catch (err: any) {
      // migration 失败 → 不写 schema_migrations, 下次启动会再试.
      // 重要: 不 throw, 否则后端起不来. 让用户从日志看到失败.
      // BUG-57: 若同一 migration 反复失败, 会在每次启动时无限重试.
      // 这里加显式标记帮助排障, 后续可扩展 retry_count 列做 MAX_RETRIES 检查.
      // eslint-disable-next-line no-console
      console.error(`[migration ${m.id}] FAILED (will retry on next startup): ${err?.message || String(err)}`);
    }
  }
}

/** 测试 / 排障用: 列出已应用的 migration */
export function listAppliedMigrations(): Array<{ id: string; applied_at: string; description: string }> {
  const db = getDb();
  ensureMigrationTable(db);
  return db.prepare("SELECT id, applied_at, description FROM schema_migrations ORDER BY id").all() as Array<{ id: string; applied_at: string; description: string }>;
}

export function closeDb(): void {
  if (_db) {
    // B-N6 (2026-05-12): close 前强制 wal_checkpoint(TRUNCATE) — TRUNCATE 模式会把
    // WAL 写回主库并清空 -wal 文件. 之前进程被 kill 时 WAL 可能很大, 下次启动 sqlite
    // 自动 recover 但耗时. 这里给一个干净退出.
    try {
      _db.pragma("wal_checkpoint(TRUNCATE)");
    } catch { /* ignore */ }
    if (_checkpointTimer) {
      clearInterval(_checkpointTimer);
      _checkpointTimer = null;
    }
    _db.close();
    _db = null;
  }
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      cover_path TEXT,
      aspect_ratio TEXT DEFAULT '16:9',
      resolution TEXT DEFAULT '1920x1080',
      default_style TEXT DEFAULT 'auto',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      episode_number INTEGER DEFAULT 1,
      status TEXT DEFAULT 'draft',
      job_id TEXT,
      aspect_ratio TEXT DEFAULT '16:9',
      resolution TEXT DEFAULT '1920x1080',
      style TEXT DEFAULT 'auto',
      major_version INTEGER DEFAULT 1,
      minor_version INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      asset_library_id TEXT,
      name TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      description TEXT DEFAULT '',
      age_range TEXT,
      gender TEXT,
      role_type TEXT DEFAULT 'main',
      tags TEXT DEFAULT '[]',
      thumbnail_path TEXT,
      reference_images TEXT DEFAULT '[]',
      lora_model TEXT,
      style_description TEXT,
      voice_provider TEXT,
      voice_id TEXT,
      voice_clone_sample_url TEXT,
      voice_speech_rate REAL DEFAULT 1.0,
      voice_pitch REAL DEFAULT 0,
      voice_emotion_baseline TEXT DEFAULT 'neutral',
      source_asset_id TEXT,
      major_version INTEGER DEFAULT 1,
      minor_version INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      asset_library_id TEXT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      location_type TEXT DEFAULT 'indoor',
      time_of_day TEXT DEFAULT 'day',
      weather TEXT DEFAULT 'clear',
      lighting TEXT DEFAULT 'natural',
      tags TEXT DEFAULT '[]',
      thumbnail_path TEXT,
      reference_images TEXT DEFAULT '[]',
      source_asset_id TEXT,
      major_version INTEGER DEFAULT 1,
      minor_version INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS styles (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      asset_library_id TEXT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      color_palette TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      mood TEXT DEFAULT 'neutral',
      reference_board_path TEXT,
      source_asset_id TEXT,
      major_version INTEGER DEFAULT 1,
      minor_version INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vault_records (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      asset_library_id TEXT,
      source_shot_id TEXT,
      source_project_id TEXT,
      record_type TEXT NOT NULL DEFAULT 'image',
      thumbnail_path TEXT,
      file_path TEXT,
      prompt TEXT,
      seed INTEGER,
      params TEXT DEFAULT '{}',
      provider TEXT,
      model TEXT,
      cost_cny REAL DEFAULT 0,
      status TEXT DEFAULT 'unused',
      tags TEXT DEFAULT '[]',
      year_month TEXT NOT NULL,
      source_asset_id TEXT,
      major_version INTEGER DEFAULT 1,
      minor_version INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shot_refs (
      shot_stable_id TEXT NOT NULL,
      ref_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      PRIMARY KEY (shot_stable_id, ref_type, ref_id)
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_project_episode_number ON episodes(project_id, episode_number);
    CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);
    CREATE INDEX IF NOT EXISTS idx_characters_project_name ON characters(project_id, name);
    CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id);
    CREATE INDEX IF NOT EXISTS idx_scenes_project_name ON scenes(project_id, name);
    CREATE INDEX IF NOT EXISTS idx_styles_project ON styles(project_id);
    CREATE INDEX IF NOT EXISTS idx_styles_project_name ON styles(project_id, name);
    CREATE INDEX IF NOT EXISTS idx_vault_project ON vault_records(project_id);
    CREATE INDEX IF NOT EXISTS idx_vault_ym ON vault_records(year_month);
    CREATE INDEX IF NOT EXISTS idx_vault_records_project_created ON vault_records(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vault_records_type_status ON vault_records(record_type, status);
    CREATE INDEX IF NOT EXISTS idx_vault_records_asset_library ON vault_records(asset_library_id);
    CREATE INDEX IF NOT EXISTS idx_shot_refs_shot ON shot_refs(shot_stable_id);
    CREATE INDEX IF NOT EXISTS idx_shot_refs_ref ON shot_refs(ref_type, ref_id);
    CREATE INDEX IF NOT EXISTS idx_shot_refs_type_ref ON shot_refs(ref_type, shot_stable_id);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('character','scene','style','voice','vault')),
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      thumbnail_path TEXT,
      source_project_slug TEXT,
      source_resource_id TEXT,
      version INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
    CREATE INDEX IF NOT EXISTS idx_assets_type_updated ON assets(asset_type, updated_at DESC);
  `);

  ensureColumn(db, "episodes", "major_version", "INTEGER DEFAULT 1");
  ensureColumn(db, "episodes", "minor_version", "INTEGER DEFAULT 0");
  ensureColumn(db, "characters", "source_asset_id", "TEXT");
  ensureColumn(db, "characters", "major_version", "INTEGER DEFAULT 1");
  ensureColumn(db, "characters", "minor_version", "INTEGER DEFAULT 0");
  ensureColumn(db, "scenes", "source_asset_id", "TEXT");
  ensureColumn(db, "scenes", "major_version", "INTEGER DEFAULT 1");
  ensureColumn(db, "scenes", "minor_version", "INTEGER DEFAULT 0");
  ensureColumn(db, "styles", "source_asset_id", "TEXT");
  ensureColumn(db, "styles", "major_version", "INTEGER DEFAULT 1");
  ensureColumn(db, "styles", "minor_version", "INTEGER DEFAULT 0");
  ensureColumn(db, "vault_records", "source_asset_id", "TEXT");
  ensureColumn(db, "vault_records", "major_version", "INTEGER DEFAULT 1");
  ensureColumn(db, "vault_records", "minor_version", "INTEGER DEFAULT 0");
}

// BUG-48: 白名单校验防止 SQL 注入
const ALLOWED_TABLES = new Set(["projects", "episodes", "characters", "scenes", "styles", "vault_records", "shot_refs", "assets", "task_queue"]);

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Unexpected table: ${table}`);
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error(`Invalid column: ${column}`);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}
