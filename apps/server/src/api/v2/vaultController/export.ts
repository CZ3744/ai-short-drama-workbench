/**
 * Vault Controller — export routes
 *
 * POST /export               — export selected entries to zip
 * GET  /export/:filename     — download exported zip
 */

import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { exportToZip } from "../../../../../../packages/library/src/assetVault";
import { pathExists } from "../../../../../../packages/core/src/index";

export const exportRouter = Router();

// POST /api/v2/vault/export
exportRouter.post("/export", async (req, res, next) => {
  try {
    const ids: string[] = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: { code: "ValidationError", message: "请提供要导出的条目 ID 列表" } });
      return;
    }
    if (ids.length > 100) {
      res.status(400).json({ error: { code: "ValidationError", message: "单次最多导出 100 个条目" } });
      return;
    }
    const result = await exportToZip(ids);
    res.json({ ok: true, zip_path: result.zipPath, exported_count: result.count });
  } catch (err) { next(err); }
});

// GET /api/v2/vault/export/:filename — download exported zip
exportRouter.get("/export/:filename", async (req, res, next) => {
  try {
    const safeName = req.params.filename.replace(/[<>:"/\\|?*]/g, "_");
    const filePath = path.join(
      path.join(require("../../../../../../packages/core/src/index").DATA_ROOT, "vault", "exports"),
      safeName,
    );
    if (!(await pathExists(filePath))) {
      res.status(404).json({ error: { code: "NotFound", message: "导出文件不存在" } });
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    const buf = await fs.readFile(filePath);
    res.send(buf);
  } catch (err) { next(err); }
});
