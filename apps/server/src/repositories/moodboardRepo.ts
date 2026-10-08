/**
 * Mood board repository — extracted from seriesStore.ts (step 1: 按聚合根拆上帝模块).
 * 零行为变更, 逐字搬运. 重复 helper 是有意为之.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readJson, writeJson, ensureDir } from "../../../../packages/core/src/index";
import { moodBoardDir, moodBoardFile, moodBoardConfigFile } from "./_paths";

// ─── Private helpers (复制自 seriesStore) ──────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Style Mood Board ────────────────────────────────────────────

export interface MoodBoardEntry {
  vault_id: string;
  weight: number;       // 1-10, default 5
  note: string;
  sort_order: number;
  added_at: string;
}

export interface MoodBoardConfig {
  enabled: boolean;
}

async function readMoodBoardConfig(slug: string): Promise<MoodBoardConfig> {
  const fp = moodBoardConfigFile(slug);
  if (!(await pathExists(fp))) return { enabled: true };
  return (await readJson<MoodBoardConfig>(fp)) ?? { enabled: true };
}

async function writeMoodBoardConfig(slug: string, config: MoodBoardConfig): Promise<void> {
  await ensureDir(moodBoardDir(slug));
  await writeJson(moodBoardConfigFile(slug), config);
}

/** List all mood board entries for a series, sorted by sort_order */
export async function listMoodBoard(slug: string): Promise<MoodBoardEntry[]> {
  const md = moodBoardDir(slug);
  if (!(await pathExists(md))) return [];
  const files = await fs.readdir(md);
  const results: MoodBoardEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file === "_config.json") continue;
    try {
      const mb = await readJson<MoodBoardEntry>(path.join(md, file)); if (mb) results.push(mb);
    } catch { /* skip corrupted */ }
  }
  return results.sort((a, b) => a.sort_order - b.sort_order);
}

/** Add a vault entry to the series mood board */
export async function addToMoodBoard(
  slug: string,
  vault_id: string,
  weight: number = 5,
  note: string = "",
): Promise<MoodBoardEntry> {
  const existing = await listMoodBoard(slug);
  if (existing.some(e => e.vault_id === vault_id)) {
    throw Object.assign(new Error("该 vault 已在风格板中"), { status: 409, code: "Conflict" });
  }
  const sortOrder = existing.length;
  const entry: MoodBoardEntry = {
    vault_id,
    weight: Math.max(1, Math.min(10, weight)),
    note,
    sort_order: sortOrder,
    added_at: nowISO(),
  };
  await ensureDir(moodBoardDir(slug));
  await writeJson(moodBoardFile(slug, vault_id), entry);
  return entry;
}

/** Remove a vault entry from the series mood board */
export async function removeFromMoodBoard(slug: string, vaultId: string): Promise<boolean> {
  const fp = moodBoardFile(slug, vaultId);
  if (!(await pathExists(fp))) return false;
  await fs.unlink(fp);
  return true;
}

/** Update mood board entry (weight, note, sort_order) */
export async function updateMoodBoardEntry(
  slug: string,
  vaultId: string,
  patch: { weight?: number; note?: string; sort_order?: number },
): Promise<MoodBoardEntry | null> {
  const fp = moodBoardFile(slug, vaultId);
  if (!(await pathExists(fp))) return null;
  const entry = await readJson<MoodBoardEntry>(fp);
  if (!entry) return null;
  if (patch.weight !== undefined) entry.weight = Math.max(1, Math.min(10, patch.weight));
  if (patch.note !== undefined) entry.note = patch.note;
  if (patch.sort_order !== undefined) entry.sort_order = patch.sort_order;
  await writeJson(fp, entry);
  return entry;
}

/** Reorder mood board (set sort_order for all provided vault IDs) */
export async function reorderMoodBoard(slug: string, order: string[]): Promise<MoodBoardEntry[]> {
  for (let i = 0; i < order.length; i++) {
    const fp = moodBoardFile(slug, order[i]);
    if (await pathExists(fp)) {
      const entry = await readJson<MoodBoardEntry>(fp);
      if (!entry) continue;
      entry.sort_order = i;
      await writeJson(fp, entry);
    }
  }
  return listMoodBoard(slug);
}

/**
 * Get top N mood board images for use as reference images.
 * Returns entries with abs_path, sorted by weight desc then sort_order asc.
 */
export async function getMoodBoardRefImages(
  slug: string,
  count: number = 3,
): Promise<Array<{ vault_id: string; abs_path: string; weight: number; note: string }>> {
  const config = await readMoodBoardConfig(slug);
  if (!config.enabled) return [];

  const entries = await listMoodBoard(slug);
  if (entries.length === 0) return [];

  const sorted = [...entries].sort((a, b) => b.weight - a.weight || a.sort_order - b.sort_order);

  const results: Array<{ vault_id: string; abs_path: string; weight: number; note: string }> = [];
  const { getVaultEntry, getVaultAbsolutePath } = await import("../../../../packages/library/src/assetVault");

  for (let i = 0; i < Math.min(count, sorted.length); i++) {
    try {
      const vaultEntry = await getVaultEntry(sorted[i].vault_id);
      if (vaultEntry) {
        const absPath = getVaultAbsolutePath(vaultEntry);
        try {
          await fs.access(absPath);
          results.push({
            vault_id: sorted[i].vault_id,
            abs_path: absPath,
            weight: sorted[i].weight / 10,
            note: sorted[i].note,
          });
        } catch { /* file not on disk */ }
      }
    } catch { /* vault entry not found */ }
  }

  return results;
}

/** Check if mood board is enabled */
export async function isMoodBoardEnabled(slug: string): Promise<boolean> {
  const config = await readMoodBoardConfig(slug);
  return config.enabled;
}

/** Enable or disable the mood board */
export async function setMoodBoardEnabled(slug: string, enabled: boolean): Promise<MoodBoardConfig> {
  const config: MoodBoardConfig = { enabled };
  await writeMoodBoardConfig(slug, config);
  return config;
}
