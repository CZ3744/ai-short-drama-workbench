/**
 * Vault Controller — annotations CRUD routes
 *
 * POST   /:id/annotations           — add annotation
 * GET    /:id/annotations           — list annotations
 * DELETE /:id/annotations/:annId    — remove annotation
 */

import { Router } from "express";
import crypto from "node:crypto";
import { getVaultEntry } from "../../../../../../packages/library/src/assetVault";
import { validate, VaultAnnotationSchema } from "../validators";
import { handleValidationError } from "../validateHelpers";
import { readAnnotations, writeAnnotations, type Annotation } from "./_shared";

export const annotationsRouter = Router();

// POST /api/v2/vault/:id/annotations — add annotation
annotationsRouter.post("/:id/annotations", async (req, res, next) => {
  try {
    const v = validate(VaultAnnotationSchema, req.body);
    if (handleValidationError(res, v)) return;
    const vaultId = req.params.id;
    const entry = await getVaultEntry(vaultId);
    if (!entry) { res.status(404).json({ error: { code: "NotFound", message: "归档条目不存在" } }); return; }

    const ann: Annotation = {
      id: `ann_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      type: v.data.type,
      coords: v.data.coords,
      note: v.data.note,
      created_at: new Date().toISOString(),
    };
    const existing = await readAnnotations(vaultId);
    existing.push(ann);
    await writeAnnotations(vaultId, existing);
    res.json({ ok: true, annotation: ann });
  } catch (err) { next(err); }
});

// GET /api/v2/vault/:id/annotations — list annotations
annotationsRouter.get("/:id/annotations", async (req, res, next) => {
  try {
    const vaultId = req.params.id;
    const entry = await getVaultEntry(vaultId);
    if (!entry) { res.status(404).json({ error: { code: "NotFound", message: "归档条目不存在" } }); return; }
    const annotations = await readAnnotations(vaultId);
    res.json({ annotations });
  } catch (err) { next(err); }
});

// DELETE /api/v2/vault/:id/annotations/:annId — remove annotation
annotationsRouter.delete("/:id/annotations/:annId", async (req, res, next) => {
  try {
    const vaultId = req.params.id;
    const annId = req.params.annId;
    const existing = await readAnnotations(vaultId);
    const idx = existing.findIndex(a => a.id === annId);
    if (idx === -1) {
      res.status(404).json({ error: { code: "NotFound", message: "批注不存在" } });
      return;
    }
    existing.splice(idx, 1);
    await writeAnnotations(vaultId, existing);
    res.json({ ok: true, deleted: annId });
  } catch (err) { next(err); }
});
