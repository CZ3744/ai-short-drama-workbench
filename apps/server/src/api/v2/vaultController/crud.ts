/**
 * Vault Controller — CRUD routes
 *
 * GET    /              — list + stats
 * GET    /stats         — stats only
 * GET    /cost-stats    — cost statistics aggregation
 * GET    /:id           — single entry metadata
 * PATCH  /:id           — update display_name
 * POST   /:id/trash     — soft move to trash
 * POST   /:id/restore   — restore from trash
 */

import { Router } from "express";
import {
  listVault, getVaultEntry, moveToTrash, restoreFromTrash,
  getVaultStats, getVaultCostStats, updateVaultEntry,
  type VaultListFilter,
} from "../../../../../../packages/library/src/assetVault";
import { loggerSync } from "../../../../../../packages/core/src/logger";
import { updateAssetMeta } from "../../../repositories/assetMetaRepo";
import { mergeVaultEntryWithAssetMeta, mergeVaultEntriesWithAssetMeta } from "./_shared";

export const crudRouter = Router();

// GET /api/v2/vault — list with optional filters
crudRouter.get("/", async (req, res, next) => {
  try {
    const filter: VaultListFilter = {};
    if (req.query.kind === "image" || req.query.kind === "video") filter.kind = req.query.kind;
    if (typeof req.query.series_slug === "string") filter.series_slug = req.query.series_slug;
    if (typeof req.query.character_id === "string") filter.character_id = req.query.character_id;
    if (typeof req.query.scene_id === "string") filter.scene_id = req.query.scene_id;
    if (typeof req.query.shot_id === "string") filter.shot_id = req.query.shot_id;
    if (typeof req.query.status === "string" && (req.query.status === "active" || req.query.status === "trashed")) {
      filter.status = req.query.status;
    }
    if (typeof req.query.since === "string") filter.since = req.query.since;
    // P0-1 (2026-05-29): 去掉旧的 Math.min(..., 200) 硬截上限 — 之前 limit:1000 被截成 200
    // 导致数据无声消失. 改为: 接受合理上限 2000 (本机单用户不会有性能压力), 同时返回
    // has_more / total 让前端能感知到是否还有更多数据.
    const requestedLimit = Number(req.query.limit) || 50;
    const pageLimit = Math.min(requestedLimit, 2000);
    filter.limit = pageLimit;
    filter.offset = Number(req.query.offset) || 0;

    // 2026-05-26 Codex P1-6 — stats 同样按 series_slug 过滤, 让 "本系列 X 项" 数字真实.
    const stats = await getVaultStats({ series_slug: filter.series_slug });
    const entries = await listVault(filter);
    // 2026-05-20: 合并 assetMeta 单一真理源 display_name
    const merged = await mergeVaultEntriesWithAssetMeta(entries);

    // 判断是否还有更多: 如果 entries.length == pageLimit, 则可能有后续页
    const hasMore = merged.length === pageLimit;
    // total 来自 stats, 诚实反映真实条目总数
    res.json({ entries: merged, stats, has_more: hasMore, offset: filter.offset, limit: pageLimit });
  } catch (err) { next(err); }
});

// GET /api/v2/vault/stats
crudRouter.get("/stats", async (_req, res, next) => {
  try {
    const stats = await getVaultStats();
    res.json({ stats });
  } catch (err) { next(err); }
});

// 2026-05-25 C1: GET /api/v2/vault/cost-stats — 成本统计聚合, 给驾驶舱用
// 接受 ?series_slug=&since=&until= 三个过滤参数, 默认全部活跃 + 全部时间.
// 返回 VaultCostStats {total_cny / this_month_cny / by_provider / by_series / by_month}
crudRouter.get("/cost-stats", async (req, res, next) => {
  try {
    const series_slug = typeof req.query.series_slug === "string" ? req.query.series_slug : undefined;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const until = typeof req.query.until === "string" ? req.query.until : undefined;
    const stats = await getVaultCostStats({ series_slug, since, until });
    res.json({ stats });
  } catch (err) { next(err); }
});

// GET /api/v2/vault/:id — metadata
crudRouter.get("/:id", async (req, res, next) => {
  try {
    const entry = await getVaultEntry(req.params.id);
    if (!entry) { res.status(404).json({ error: { code: "NotFound", message: "归档条目不存在" } }); return; }
    // 2026-05-20: 合并 assetMeta 单一真理源 display_name
    const merged = await mergeVaultEntryWithAssetMeta(entry);
    res.json({ entry: merged });
  } catch (err) { next(err); }
});

// PATCH /api/v2/vault/:id — 2026-05-20 display_name 体系统一: 支持改 vault entry 的展示名
// Body: { display_name?: string (1-50 char) }
// 不改文件真实路径, 只改 metadata. 同步写入 assetMetaRepo (单一真理源).
crudRouter.patch("/:id", async (req, res, next) => {
  try {
    const vaultId = String(req.params.id);
    const entry = await getVaultEntry(vaultId);
    if (!entry) { res.status(404).json({ error: { code: "NotFound", message: "归档条目不存在" } }); return; }

    const body = req.body ?? {};
    const patch: { display_name?: string } = {};

    if (Object.prototype.hasOwnProperty.call(body, "display_name")) {
      if (typeof body.display_name !== "string") {
        res.status(400).json({ error: { code: "ValidationError", message: "展示名必须是文字" } });
        return;
      }
      const displayName = body.display_name.trim();
      // 允许空串 = 清除展示名回 fallback 行为, 与 elementController 一致
      if (displayName.length > 50) {
        res.status(400).json({ error: { code: "ValidationError", message: "展示名长度必须不超过 50 个字" } });
        return;
      }
      if (/[\\/]/.test(displayName)) {
        res.status(400).json({ error: { code: "ValidationError", message: "展示名不能包含路径分隔符" } });
        return;
      }
      patch.display_name = displayName || undefined;
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: { code: "ValidationError", message: "没有可更新的字段" } });
      return;
    }

    // 同步写 vault entry + asset_meta (单一真理源)
    const updated = await updateVaultEntry(vaultId, patch);
    if (!updated) {
      res.status(500).json({ error: { code: "InternalError", message: "更新失败" } });
      return;
    }

    // 同步到 assetMetaRepo (Step 3 单一真理源)
    try {
      await updateAssetMeta(vaultId, { display_name: patch.display_name });
    } catch (e) {
      loggerSync().warn(`[vault PATCH] assetMetaRepo 同步失败 (非致命): ${e instanceof Error ? e.message : String(e)}`);
    }

    // 合并返回值, 确保前端拿到最新 display_name
    const merged = await mergeVaultEntryWithAssetMeta(updated);
    res.json({ ok: true, entry: merged });
  } catch (err) { next(err); }
});

// POST /api/v2/vault/:id/trash
crudRouter.post("/:id/trash", async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const entry = await moveToTrash(req.params.id, reason);
    if (!entry) { res.status(404).json({ error: { code: "NotFound", message: "归档条目不存在或已在废案箱" } }); return; }
    res.json({ ok: true, entry });
  } catch (err) { next(err); }
});

// POST /api/v2/vault/:id/restore
crudRouter.post("/:id/restore", async (req, res, next) => {
  try {
    const entry = await restoreFromTrash(req.params.id);
    if (!entry) { res.status(404).json({ error: { code: "NotFound", message: "归档条目不在废案箱中" } }); return; }
    res.json({ ok: true, entry });
  } catch (err) { next(err); }
});
