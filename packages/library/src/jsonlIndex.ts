import fs from "node:fs/promises";
import path from "node:path";
import type { Asset, IndexSnapshot, JsonlOp } from "./types.js";
import { CURRENT_SCHEMA_VERSION as CORE_SCHEMA_VERSION, migrateToLatest } from "../../core/src/migrations.js";

/** Current schema version for all JSONL/JSON index files. */
export const CURRENT_SCHEMA_VERSION = CORE_SCHEMA_VERSION;

/**
 * Simple promise-based mutex (single-process, no external dep).
 */
class Mutex {
  private _locked = false;
  private _queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }
    return new Promise<() => void>((resolve) => {
      this._queue.push(() => resolve(() => this._release()));
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }
}

const jsonlMutex = new Mutex();

/**
 * Append one JSONL operation to the index file.
 * Uses a mutex so concurrent appends within the same process are serialised.
 * Automatically injects `schema_version: CURRENT_SCHEMA_VERSION` into each line.
 */
export async function appendOp(jsonlPath: string, op: Omit<JsonlOp, "schema_version">): Promise<void> {
  const release = await jsonlMutex.acquire();
  try {
    const versioned = { ...op, schema_version: CURRENT_SCHEMA_VERSION };
    const line = JSON.stringify(versioned) + "\n";
    await fs.appendFile(jsonlPath, line, "utf-8");
  } finally {
    release();
  }
}

/**
 * Read all ops from a JSONL file. Skips blank lines.
 * Checks schema_version on each line; logs warning for unsupported versions.
 */
export async function readOps(jsonlPath: string): Promise<JsonlOp[]> {
  let raw: string;
  try {
    raw = await fs.readFile(jsonlPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const ops: JsonlOp[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry: JsonlOp & { schema_version?: number } = JSON.parse(trimmed);
      // E3: apply global schema version migration (no-op for v1→v2, stamps version)
      const parsed = migrateToLatest(entry as unknown as Record<string, unknown>) as unknown as JsonlOp;
      // Schema version check — future migrator hook
      if (parsed.schema_version !== undefined && parsed.schema_version > CURRENT_SCHEMA_VERSION) {
        console.warn(`[jsonlIndex] skipping line with unsupported schema_version=${parsed.schema_version} (current=${CURRENT_SCHEMA_VERSION}) in ${jsonlPath}`);
        continue;
      }
      ops.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return ops;
}

/**
 * Read the full snapshot (index.json) if it exists.
 * Checks schema_version; returns null if version is unsupported (future migrator hook).
 */
export async function readSnapshot(jsonPath: string): Promise<IndexSnapshot | null> {
  try {
    const raw = await fs.readFile(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as IndexSnapshot;
    // Migrate legacy `version` field to `schema_version` if needed
    if ((parsed as any).version !== undefined && parsed.schema_version === undefined) {
      parsed.schema_version = (parsed as any).version;
      delete (parsed as any).version;
    }
    // E3: apply global schema version migration (no-op for v1→v2, stamps version)
    const snapshot = migrateToLatest(parsed as unknown as Record<string, unknown>) as unknown as IndexSnapshot;
    // Schema version check — future migrator hook
    if (snapshot.schema_version !== undefined && snapshot.schema_version > CURRENT_SCHEMA_VERSION) {
      console.warn(`[jsonlIndex] snapshot has unsupported schema_version=${snapshot.schema_version} (current=${CURRENT_SCHEMA_VERSION}) in ${jsonPath}`);
      return null;
    }
    return snapshot;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write the full snapshot atomically (write to .tmp then rename).
 * Ensures `schema_version` is set to CURRENT_SCHEMA_VERSION.
 */
export async function writeSnapshot(jsonPath: string, snapshot: IndexSnapshot): Promise<void> {
  const versioned: IndexSnapshot = { ...snapshot, schema_version: CURRENT_SCHEMA_VERSION };
  const tmpPath = jsonPath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(versioned, null, 2), "utf-8");
  await fs.rename(tmpPath, jsonPath);
}

/**
 * Replay strategy:
 * 1. Read index.json snapshot (if exists)
 * 2. Replay index.jsonl ops with `at` > snapshot.generated_at
 * Returns (assetsById, sha256ToId).
 */
export async function loadIndex(
  assetsRoot: string
): Promise<{ assetsById: Map<string, Asset>; sha256ToId: Map<string, string> }> {
  const jsonPath = path.join(assetsRoot, "index.json");
  const jsonlPath = path.join(assetsRoot, "index.jsonl");

  const snapshot = await readSnapshot(jsonPath);
  const assetsById = new Map<string, Asset>();
  const sha256ToId = new Map<string, string>();

  // Load snapshot
  if (snapshot) {
    for (const [id, asset] of Object.entries(snapshot.assets)) {
      assetsById.set(id, asset);
    }
    for (const [sha, id] of Object.entries(snapshot.sha256_to_id)) {
      sha256ToId.set(sha, id);
    }
  }

  // Replay JSONL ops after snapshot
  const cutoff = snapshot?.generated_at ?? "1970-01-01T00:00:00Z";
  const ops = await readOps(jsonlPath);
  for (const op of ops) {
    if (op.at <= cutoff) continue;
    switch (op.op) {
      case "add": {
        assetsById.set(op.asset.id, op.asset);
        sha256ToId.set(op.asset.sha256, op.asset.id);
        break;
      }
      case "tombstone": {
        const existing = assetsById.get(op.id);
        if (existing) {
          existing.deleted_at = op.at;
        }
        break;
      }
      case "retag": {
        const existing = assetsById.get(op.id);
        if (existing) {
          existing.tags = op.tags;
        }
        break;
      }
    }
  }

  return { assetsById, sha256ToId };
}
