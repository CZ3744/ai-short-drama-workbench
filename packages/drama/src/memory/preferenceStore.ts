/**
 * B4 — Preference Store (SQLite via better-sqlite3)
 *
 * Persistence layer for the "data flywheel" feature.
 * Stores per-stage user interaction events and derived user style profiles.
 *
 * Tables:
 *   events   — every LLM output + user action (adopt / redo / manual_edit / reject)
 *   profiles — aggregated per-stage user preference summaries
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────

export type UserAction =
  | "adopt"
  | "redo"
  | "manual_edit"
  | "reject"
  | "feedback_more"   // ❤️ 更多这样
  | "feedback_less"   // 👎 少一点
  | "feedback_ok";    // 😐 还行

export interface PrefEvent {
  id: string;
  stage: string;
  input_hash: string;
  output_json: string;
  user_action: UserAction;
  diff_summary?: string;
  created_at: string;
}

export interface UserProfile {
  user_key: string;
  profile_json: string;
  updated_at: string;
}

/** Minimal shape returned to callers */
export interface RecentAcceptedSample {
  output_json: string;
  created_at: string;
}

// ─── Singleton DB ──────────────────────────────────────────────

let _db: Database.Database | null = null;

/**
 * Resolve the path to data/memory.db.
 * Prefers MEMORY_DB_PATH env, falls back to <cwd>/data/memory.db
 */
function resolveDbPath(): string {
  const envPath = process.env.MEMORY_DB_PATH;
  if (envPath) return envPath;
  return path.join(process.cwd(), "data", "memory.db");
}

/**
 * Get (or create) the singleton database instance.
 * Creates the data/ directory and tables on first call.
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = resolveDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Create tables if not exist
  _db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id           TEXT PRIMARY KEY,
      stage        TEXT NOT NULL,
      input_hash   TEXT NOT NULL,
      output_json  TEXT NOT NULL,
      user_action  TEXT NOT NULL,
      diff_summary TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_stage ON events(stage);
    CREATE INDEX IF NOT EXISTS idx_events_action ON events(user_action);

    CREATE TABLE IF NOT EXISTS profiles (
      user_key    TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `);

  // Migration: add diff_summary column if missing (for existing DBs)
  try {
    const columns = _db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === "diff_summary")) {
      _db.exec("ALTER TABLE events ADD COLUMN diff_summary TEXT");
    }
  } catch { /* ignore if already exists */ }

  return _db;
}

// ─── Event CRUD ────────────────────────────────────────────────

/**
 * Hash the LLM input (prompt text) to a short hex digest for dedup / grouping.
 */
export function hashInput(promptText: string): string {
  return createHash("sha256").update(promptText).digest("hex").slice(0, 16);
}

/**
 * Record a user action on an LLM output.
 */
export function recordEvent(opts: {
  stage: string;
  input_hash: string;
  output_json: string;
  user_action: UserAction;
  diff_summary?: string;
}): PrefEvent {
  const db = getDb();
  const id = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const created_at = new Date().toISOString();

  db.prepare(
    `INSERT INTO events (id, stage, input_hash, output_json, user_action, diff_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, opts.stage, opts.input_hash, opts.output_json, opts.user_action, opts.diff_summary ?? null, created_at);

  return { id, stage: opts.stage, input_hash: opts.input_hash, output_json: opts.output_json, user_action: opts.user_action, diff_summary: opts.diff_summary, created_at };
}

/**
 * Count events for a given stage.
 */
export function countEventsByStage(stage: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM events WHERE stage = ?").get(stage) as { cnt: number };
  return row.cnt;
}

/**
 * Get the N most recent "adopt" events for a stage (for few-shot injection).
 */
export function getRecentAcceptedSamples(stage: string, limit = 3): RecentAcceptedSample[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT output_json, created_at FROM events
       WHERE stage = ? AND user_action = 'adopt'
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(stage, limit) as RecentAcceptedSample[];
}

/**
 * Get all events for a stage (used by profileBuilder).
 */
export function getEventsByStage(stage: string): PrefEvent[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM events WHERE stage = ? ORDER BY created_at ASC")
    .all(stage) as PrefEvent[];
}

// ─── Profile CRUD ──────────────────────────────────────────────

/**
 * Upsert a user profile for a stage.
 */
export function upsertProfile(userKey: string, profileJson: string): void {
  const db = getDb();
  const updated_at = new Date().toISOString();
  db.prepare(
    `INSERT INTO profiles (user_key, profile_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_key) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at`
  ).run(userKey, profileJson, updated_at);
}

/**
 * Get a user profile by key (typically "profile:<stage>").
 */
export function getProfile(userKey: string): UserProfile | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM profiles WHERE user_key = ?").get(userKey) as UserProfile | undefined;
  return row ?? null;
}

/**
 * Clear all learning data (events + profiles). For the "清除学习数据" button.
 */
export function clearAllLearningData(): void {
  const db = getDb();
  db.exec("DELETE FROM events; DELETE FROM profiles;");
}

// ─── Micro-feedback helpers ────────────────────────────────────────

/**
 * Record a micro-feedback event (from the 2-second toast after shot completion).
 * Maps emoji buttons to user_action values.
 */
export function recordFeedbackEvent(opts: {
  stage: string;
  shot_id: string;
  feedback: "more" | "less" | "ok";
}): PrefEvent {
  const actionMap: Record<string, UserAction> = {
    more: "feedback_more",
    less: "feedback_less",
    ok: "feedback_ok",
  };
  return recordEvent({
    stage: opts.stage,
    input_hash: hashInput(opts.shot_id),
    output_json: JSON.stringify({ shot_id: opts.shot_id }),
    user_action: actionMap[opts.feedback],
  });
}

/**
 * Count total events across all stages (for threshold check).
 */
export function getTotalEventCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM events").get() as { cnt: number };
  return row.cnt;
}

/**
 * Close the database (for graceful shutdown / testing).
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
