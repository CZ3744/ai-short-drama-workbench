import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { migrateToLatest } from "./migrations";

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Atomic write: write to .tmp first, then rename (POSIX atomic rename,
 * approximate atomic on Windows). Prevents readers from seeing partial data.
 */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await ensureDir(path.dirname(filePath));
  try {
    await fs.writeFile(tmpPath, data, "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmpPath, filePath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows scanners/readers can briefly hold the destination. Keep the
        // old complete file intact and stop retrying after 775 ms total wait.
        if ((code !== "EPERM" && code !== "EBUSY") || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  } finally {
    // Each writer owns its temp file; a concurrent writer must never lose theirs.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

export async function writeJson(filePath: string, value: unknown) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    // E3: apply global schema version migration for all persisted JSON
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return migrateToLatest(parsed as Record<string, unknown>) as unknown as T;
    }
    return parsed as T;
  } catch (err: any) {
    console.warn(`[readJson] corrupted or unreadable file: ${filePath} — ${err.message}`);
    return null;
  }
}

export async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
]);

export function safeFileName(name: string) {
  let safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, "_").slice(0, 120);
  const base = safe.split(".")[0]?.toUpperCase() ?? "";
  if (WINDOWS_RESERVED.has(base)) {
    safe = `_${safe}`;
  }
  return safe;
}
