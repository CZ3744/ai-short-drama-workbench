/**
 * Element trash endpoints — list trash / restore / permanent-delete.
 *
 * 铁律 #6: 数据保留 > 直接删除，90 天可恢复.
 * 2026-05-21 P1 拆分: 抽自 elementController.ts §"回收站 API" 段, 实现一字不差.
 */

import { Router } from "express";
import {
  listTrashedElements,
  restoreTrashedElement,
  permanentDeleteTrashedElement,
} from "../../../repositories/elementRepo";
import {
  listTrashedCharacters,
  restoreTrashedCharacter,
  permanentDeleteTrashedCharacter,
} from "../../../repositories/characterRepo";
import {
  listTrashedScenes,
  restoreTrashedScene,
  permanentDeleteTrashedScene,
} from "../../../repositories/sceneRepo";
import { err } from "./_shared";

export const trashRouter = Router();

// GET /series/:slug/elements-trash
// query: kind=element|character|scene (不传则返回全部三类)
trashRouter.get("/series/:slug/elements-trash", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const kindFilter = typeof req.query.kind === "string" ? req.query.kind : undefined;

    let items;
    if (kindFilter === "element") {
      items = await listTrashedElements(slug);
    } else if (kindFilter === "character") {
      items = await listTrashedCharacters(slug);
    } else if (kindFilter === "scene") {
      items = await listTrashedScenes(slug);
    } else {
      // 返回全部三类，合并后按删除时间倒序
      const [elements, characters, scenes] = await Promise.all([
        listTrashedElements(slug),
        listTrashedCharacters(slug),
        listTrashedScenes(slug),
      ]);
      items = [...elements, ...characters, ...scenes]
        .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
    }

    res.json({ items, total: items.length });
  } catch (e) { next(e); }
});

// POST /series/:slug/elements-trash/:trashId/restore
trashRouter.post("/series/:slug/elements-trash/:trashId/restore", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const trashId = String(req.params.trashId);

    // trashId 格式 "<id>__<ts>"，根据最后两个下划线前缀推断原 kind（读 manifest 即可）
    // 先尝试 element，再 character，再 scene
    let restoredId = await restoreTrashedElement(slug, trashId);
    if (restoredId === null) restoredId = await restoreTrashedCharacter(slug, trashId);
    if (restoredId === null) restoredId = await restoreTrashedScene(slug, trashId);

    if (restoredId === null) {
      return err(res, 404, "NotFound", "回收站中找不到该条目");
    }
    res.json({ ok: true, restored_id: restoredId });
  } catch (e) { next(e); }
});

// DELETE /series/:slug/elements-trash/:trashId
trashRouter.delete("/series/:slug/elements-trash/:trashId", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const trashId = String(req.params.trashId);

    const ok = await permanentDeleteTrashedElement(slug, trashId)
      || await permanentDeleteTrashedCharacter(slug, trashId)
      || await permanentDeleteTrashedScene(slug, trashId);

    if (!ok) return err(res, 404, "NotFound", "回收站中找不到该条目");
    res.json({ ok: true });
  } catch (e) { next(e); }
});
