/**
 * Log Query API — 日志查询与摘要端点
 */
import type { Request, Response } from "express";
import fsp from "node:fs/promises";
import { dailyLogFile, readRecentErrors } from "../../../../../packages/core/src/logger";

export async function queryLogs(req: Request, res: Response): Promise<void> {
  const { requestId, level, since, until, kind, providerId, limit, offset } = req.query;
  const logFile = dailyLogFile();
  let entries: any[] = [];

  try {
    const content = await fsp.readFile(logFile, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (requestId && obj.requestId !== requestId) continue;
        if (level) {
          const levelNum: Record<string, number> = { error: 50, warn: 40, info: 30, debug: 20 };
          const target = levelNum[level as string] ?? 30;
          if (obj.level !== target) continue;
        }
        if (since && new Date(obj.time) < new Date(since as string)) continue;
        if (until && new Date(obj.time) > new Date(until as string)) continue;
        if (kind && obj.kind !== kind) continue;
        if (providerId && obj.providerId !== providerId) continue;
        entries.push(obj);
      } catch { /* skip malformed */ }
    }
  } catch {
    res.json({ entries: [], total: 0 });
    return;
  }

  const off = parseInt(offset as string) || 0;
  const lim = parseInt(limit as string) || 50;
  const paged = entries.slice(off, off + lim);

  res.json({
    total: entries.length,
    offset: off,
    limit: lim,
    entries: paged,
  });
}

export async function getLogSummary(req: Request, res: Response): Promise<void> {
  const errors = await readRecentErrors(500);
  const byRequestId = new Map<string, any[]>();
  for (const e of errors) {
    const rid = e.requestId || "unknown";
    if (!byRequestId.has(rid)) byRequestId.set(rid, []);
    byRequestId.get(rid)!.push(e);
  }

  const sorted = [...byRequestId.entries()]
    .map(([requestId, entries]) => ({
      requestId,
      count: entries.length,
      lastAt: entries[0].timestamp,
      entries: entries.slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  res.json({ groups: sorted, total_errors: errors.length });
}
