/**
 * seriesCastMigration — W7 (2026-05-26) 把老 series.cast_id 单组字段迁到 cast_ids 数组.
 *
 * 启动时一次性跑. 检测每个未删的 series:
 *   - 若 cast_ids 数组缺失或空, 但 cast_id 有值 → 写 cast_ids = [cast_id]
 *   - 否则跳过 (已经迁过, 或本来就没设)
 *
 * 不动老 cast_id 字段 — 留作 normalizeSeriesCastIds 兜底, 避免单点失败.
 */

import { listSeries, readSeries, updateSeries } from "./seriesRepo";

export interface MigrationResult {
  scanned: number;
  migrated: number;
  errors: Array<{ slug: string; error: string }>;
}

export async function migrateSeriesCastIdToCastIds(): Promise<MigrationResult> {
  const result: MigrationResult = { scanned: 0, migrated: 0, errors: [] };
  const items = await listSeries({ includeInternalTestSeries: false }).catch(() => []);
  for (const item of items) {
    result.scanned += 1;
    try {
      const s = await readSeries(item.slug);
      if (!s) continue;
      const hasNewField = Array.isArray(s.cast_ids) && s.cast_ids.length > 0;
      const hasOldField = typeof s.cast_id === "string" && s.cast_id.trim().length > 0;
      if (hasNewField || !hasOldField) continue;
      const oldId: string = s.cast_id as string;
      await updateSeries(item.slug, { cast_ids: [oldId] });
      result.migrated += 1;
    } catch (e) {
      result.errors.push({
        slug: item.slug,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}
