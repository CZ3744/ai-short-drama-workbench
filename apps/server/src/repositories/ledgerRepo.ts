/**
 * Ledger repository — extracted from seriesStore.ts (step 1: 按聚合根拆上帝模块).
 * 零行为变更, 逐字搬运. 重复 helper 是有意为之.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../../../packages/core/src/index";
import { migrateToLatest } from "../../../../packages/core/src/migrations";
import { LEDGER_ROOT } from "./_paths";

// ─── Ledger Store ───────────────────────────────────────────────

export interface LedgerEntry {
  at: string;
  series_slug: string;
  job_id: string;
  task_id: string;
  kind: string;
  provider_id: string;
  ok: boolean;
  cost?: { currency: string; amount: number; basis: string };
  duration_ms: number;
  error_code?: string;
}

// Per-month memory cache for ledger queries (TTL 60s, single-user scenario)
const LEDGER_CACHE_TTL_MS = 60_000;
const _ledgerCache = new Map<string, { entries: LedgerEntry[]; cached_at: number }>();

/**
 * Invalidate ledger cache for a specific month (format: "YYYY-MM").
 * Called externally when new ledger records are flushed to disk.
 */
export function invalidateLedgerCache(month: string): void {
  _ledgerCache.delete(month);
}

export async function queryLedger(filter?: { series_slug?: string; since?: string; until?: string }): Promise<LedgerEntry[]> {
  if (!(await pathExists(LEDGER_ROOT))) return [];
  const files = await fs.readdir(LEDGER_ROOT);
  const entries: LedgerEntry[] = [];

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const month = file.replace(".jsonl", "");

    // Check per-month cache with TTL
    const cached = _ledgerCache.get(month);
    if (cached && (Date.now() - cached.cached_at) < LEDGER_CACHE_TTL_MS) {
      entries.push(...cached.entries);
      continue;
    }

    // Read from disk and populate cache
    const content = await fs.readFile(path.join(LEDGER_ROOT, file), "utf8");
    const monthEntries: LedgerEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        // E3: apply global schema version migration to ledger entries
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          monthEntries.push(migrateToLatest(parsed as Record<string, unknown>) as unknown as LedgerEntry);
        } else {
          monthEntries.push(parsed as LedgerEntry);
        }
      } catch { /* skip */ }
    }
    _ledgerCache.set(month, { entries: monthEntries, cached_at: Date.now() });
    entries.push(...monthEntries);
  }

  // Apply optional filters in memory
  let results = entries;
  const seriesSlug = filter?.series_slug;
  const since = filter?.since;
  const until = filter?.until;
  if (seriesSlug) results = results.filter(e => e.series_slug === seriesSlug);
  if (since) results = results.filter(e => e.at >= since);
  if (until) results = results.filter(e => e.at <= until);

  return results.sort((a, b) => b.at.localeCompare(a.at));
}

export async function aggregateLedger(filter?: { series_slug?: string }): Promise<{ by_provider: Record<string, number>; total: number }> {
  const entries = await queryLedger(filter);
  const by_provider: Record<string, number> = {};
  let total = 0;
  for (const e of entries) {
    if (e.cost) {
      by_provider[e.provider_id] = (by_provider[e.provider_id] ?? 0) + e.cost.amount;
      total += e.cost.amount;
    }
  }
  return { by_provider, total };
}
