// P20: CostLedger — JSONL cost tracking per provider call

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CostInfo, ProviderKind } from "./types";

// ─── Types ──────────────────────────────────────────────────────────

export interface LedgerEntry {
  at: string;              // ISO timestamp
  series_slug: string;
  job_id: string;
  task_id: string;
  kind: ProviderKind;
  provider_id: string;
  ok: boolean;
  params_digest: string;   // short hash of request params
  cost?: CostInfo;
  duration_ms: number;
  error_code?: string;
}

export interface LedgerFilter {
  series_slug?: string;
  since?: string;          // ISO date or timestamp
  until?: string;
  kind?: ProviderKind;
}

export interface AggregateResult {
  by_provider: Record<string, number>;
  total: number;
}

// ─── CostLedger ─────────────────────────────────────────────────────

export class CostLedger {
  private dir: string;
  private _buffer: LedgerEntry[] = [];
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _onFlush?: (month: string) => void;

  constructor(dataDir: string, onFlush?: (month: string) => void) {
    this.dir = path.join(dataDir, "cost_ledger");
    this._onFlush = onFlush;
  }

  /**
   * Record a provider call result. Writes are batched to JSONL.
   */
  record(entry: LedgerEntry): void {
    this._buffer.push(entry);
    this._scheduleFlush();
  }

  /**
   * Query entries from on-disk JSONL files matching the filter.
   * Also includes any buffered (not-yet-flushed) entries.
   */
  async query(filter: LedgerFilter): Promise<LedgerEntry[]> {
    const entries = await this._readAll();
    return entries.filter((e) => this._matches(e, filter));
  }

  /**
   * Aggregate cost amounts grouped by provider_id.
   */
  async aggregate(filter: LedgerFilter): Promise<AggregateResult> {
    const entries = await this.query(filter);
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

  /**
   * Flush buffered entries to disk immediately.
   */
  async flush(): Promise<void> {
    if (this._buffer.length === 0) return;
    const batch = this._buffer.splice(0);
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const filename = `${month}.jsonl`;
    const filePath = path.join(this.dir, filename);
    await fsp.mkdir(this.dir, { recursive: true });
    const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fsp.appendFile(filePath, lines, "utf8");
    // Invalidate affected month's cache so next query picks up new entries
    this._onFlush?.(month);
  }

  // ─── internals ──────────────────────────────────────────────────

  private _scheduleFlush(): void {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch((err) => {
        console.error("[CostLedger] flush error:", err);
      });
    }, 500);
  }

  private async _readAll(): Promise<LedgerEntry[]> {
    const entries: LedgerEntry[] = [];
    // Include buffered entries
    entries.push(...this._buffer);
    // Read from disk
    try {
      const files = await fsp.readdir(this.dir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(this.dir, file);
        const content = await fsp.readFile(filePath, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            entries.push(JSON.parse(trimmed));
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch {
      // directory may not exist yet
    }
    return entries;
  }

  private _matches(entry: LedgerEntry, filter: LedgerFilter): boolean {
    if (filter.series_slug && entry.series_slug !== filter.series_slug) return false;
    if (filter.kind && entry.kind !== filter.kind) return false;
    if (filter.since && entry.at < filter.since) return false;
    if (filter.until && entry.at > filter.until) return false;
    return true;
  }
}

/**
 * Generate a short digest of request parameters for the ledger.
 */
export function paramsDigest(params: Record<string, unknown>): string {
  const str = JSON.stringify(params, Object.keys(params).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(8, "0");
}
