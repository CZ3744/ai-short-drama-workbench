import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

async function withFreshInstallation(check: (root: string, database: any) => Promise<void>, seed?: (db: Database.Database) => void) {
  // Copy only schema code into a fresh nested installation; never remove or reuse a real database.
  assert.equal(path.resolve(process.env.VIDEO_GENERATE_TEST_FIXTURE ?? ""), process.cwd());
  const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp", "database-startup-"));
  let database: any;
  try {
    await fs.mkdir(path.join(root, "packages/core/src/db"), { recursive: true });
    await fs.mkdir(path.join(root, "config"));
    for (const file of ["db/database.ts", "db/taskQueue.ts", "paths.ts"]) {
      await fs.copyFile(path.join(process.cwd(), "packages/core/src", file), path.join(root, "packages/core/src", file));
    }
    if (seed) {
      const db = new Database(path.join(root, "config/projects.db"));
      try { seed(db); } finally { db.close(); }
    }
    database = await import(pathToFileURL(path.join(root, "packages/core/src/db/database.ts")).href);
    await check(root, database);
  } finally {
    database?.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("project database first startup", () => {
  it("opens a clean installation without false migration errors, then creates usable queue indexes", async () => {
    await withFreshInstallation(async (root, database) => {
      const errors: unknown[][] = [];
      const originalError = console.error;
      console.error = (...args) => { errors.push(args); };
      try {
        const db = database.getDb();
        assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_queue'").get(), undefined);
        assert.ok(database.listAppliedMigrations().some((item: { id: string }) => item.id === "0003_task_queue_status_priority_idx"));
        const queue = await import(pathToFileURL(path.join(root, "packages/core/src/db/taskQueue.ts")).href);
        queue.ensureTaskQueueTable();
        const indexes = db.prepare("PRAGMA index_list(task_queue)").all().map((item: { name: string }) => item.name);
        assert.ok(indexes.includes("idx_task_queue_status_priority"));
        assert.ok(indexes.includes("idx_task_queue_project"));
        const task = queue.enqueueTask({ project_id: "fixture-project", task_type: "generate_image", provider: "fixture" });
        assert.equal(queue.popNext().id, task.id);
        database.closeDb();
        assert.ok(database.getDb().prepare("SELECT 1 FROM task_queue WHERE id = ?").get(task.id));
        assert.deepEqual(errors, []);
      } finally {
        console.error = originalError;
      }
    });
  });

  it("adds missing indexes to an existing queue without changing queued records", async () => {
    await withFreshInstallation(async (_root, database) => {
      const db = database.getDb();
      const indexes = db.prepare("PRAGMA index_list(task_queue)").all().map((item: { name: string }) => item.name);
      assert.ok(indexes.includes("idx_task_queue_status_priority"));
      assert.ok(indexes.includes("idx_task_queue_project"));
      assert.deepEqual(db.prepare("SELECT * FROM task_queue").get(), {
        id: "keep-task", project_id: "fixture-project", status: "queued", priority: 3, created_at: "2026-01-01T00:00:00Z",
      });
    }, db => {
      db.exec("CREATE TABLE task_queue (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, priority INTEGER, created_at TEXT)");
      db.prepare("INSERT INTO task_queue VALUES (?, ?, ?, ?, ?)").run("keep-task", "fixture-project", "queued", 3, "2026-01-01T00:00:00Z");
    });
  });
});
