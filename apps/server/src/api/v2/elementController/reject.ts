/**
 * Element reject (废案库) endpoints — reject / list / promote / import.
 *
 * 三级废案库 (element / project / public) — 见设计文档 §2.2 §8.5.
 * 2026-05-21 P1 拆分: 抽自 elementController.ts §"三级废案库" 段, 实现一字不差.
 */

import { Router } from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { addAsset } from "../../../repositories/assetRepo";
import { DATA_ROOT, ensureDir } from "../../../../../../packages/core/src/index";
import {
  getVaultEntry,
  listVault,
  tagVaultEntry,
  getVaultAbsolutePath,
} from "../../../../../../packages/library/src/assetVault";
import {
  readAnyElement,
  addAnyElementImage,
  removeAnyElementImage,
  ensureVaultFromImage,
} from "../elementController.helpers";
import { err } from "./_shared";

export const rejectRouter = Router();

function rejectTag(tier: "element" | "project" | "public", slug?: string, elementId?: string): string {
  if (tier === "element") return `reject:element:${slug}:${elementId}`;
  if (tier === "project") return `reject:project:${slug}`;
  return "reject:public";
}

// POST /series/:slug/elements/:id/reject  body: { image_id }
// 把一张候选图移入「该元素的废案库」: 从 element.images 移除 + vault 打 reject tag (携带初始信息)
rejectRouter.post("/series/:slug/elements/:id/reject", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const imageId = req.body?.image_id;
    if (typeof imageId !== "string" || !imageId) return err(res, 400, "ValidationError", "image_id 必填");
    const el = await readAnyElement(slug, id);
    if (!el) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    const image = el.images.find((im) => im.image_id === imageId);
    if (!image) return err(res, 404, "NotFound", `图片 ${imageId} 不在图库`);
    const vaultId = await ensureVaultFromImage(slug, el, image);
    if (!vaultId) return err(res, 400, "ValidationError", "该图无 vault 或 asset 记录, 无法入废案库");

    // 携带初始信息: 用 tag 标明「这是谁的废案」, vault context.user_note 已有 element 名
    await tagVaultEntry(vaultId, [
      rejectTag("element", slug, id),
      `reject_element_name:${el.name}`,
      `reject_element_kind:${el.kind}`,
    ]);
    const updated = await removeAnyElementImage(slug, id, imageId);
    res.json({ ok: true, element: updated, rejected_vault_id: vaultId });
  } catch (e) { next(e); }
});

// GET /reject?tier=element|project|public&slug=&element_id=
rejectRouter.get("/reject", async (req, res, next) => {
  try {
    const tierRaw = req.query.tier;
    const tier: "element" | "project" | "public" | null =
      tierRaw === "element" || tierRaw === "project" || tierRaw === "public" ? tierRaw : null;
    if (!tier) {
      return err(res, 400, "ValidationError", "tier 必须是 element|project|public");
    }
    const slug = typeof req.query.slug === "string" ? req.query.slug : undefined;
    const elementId = typeof req.query.element_id === "string" ? req.query.element_id : undefined;
    if (tier === "element" && (!slug || !elementId)) {
      return err(res, 400, "ValidationError", "element tier 需要 slug 和 element_id");
    }
    if (tier === "project" && !slug) {
      return err(res, 400, "ValidationError", "project tier 需要 slug");
    }
    const tag = rejectTag(tier, slug, elementId);
    const entries = await listVault({
      tags: [tag],
      series_slug: tier === "public" ? undefined : slug,
      status: "active",
      limit: 200,
    });
    res.json({
      items: entries.map((e) => ({
        vault_id: e.vault_id,
        kind: e.kind,
        // 2026-05-16 PM 反馈修复: 旧 url=/file 路径未注册导致破图,真路由是 /:id/raw (vaultController:188)
        url: `/api/v2/vault/${e.vault_id}/raw`,
        thumbnail: `/api/v2/vault/${e.vault_id}/thumbnail`,
        provider_id: e.provider_id,
        created_at: e.created_at,
        series_slug: e.context?.series_slug,
        cost_cny: e.cost_cny,
        // 携带的初始信息 (PM 强需求: 废案不是裸图)
        element_name: (e.tags || []).find((t) => t.startsWith("reject_element_name:"))?.slice(20),
        element_kind: (e.tags || []).find((t) => t.startsWith("reject_element_kind:"))?.slice(20),
        note: e.context?.user_note,
        tags: e.tags,
      })),
    });
  } catch (e) { next(e); }
});

// POST /reject/promote  body: { vault_id, to: "project"|"public", slug? }
// 把一张废案升级到更高一级的废案库 (element → project → public)
rejectRouter.post("/reject/promote", async (req, res, next) => {
  try {
    const vaultId = req.body?.vault_id;
    const to = req.body?.to;
    const slug = typeof req.body?.slug === "string" ? req.body.slug : undefined;
    if (typeof vaultId !== "string" || !vaultId) return err(res, 400, "ValidationError", "vault_id 必填");
    if (to !== "project" && to !== "public") return err(res, 400, "ValidationError", "to 必须是 project|public");
    if (to === "project" && !slug) return err(res, 400, "ValidationError", "升级到项目废案库需要 slug");
    const entry = await getVaultEntry(vaultId);
    if (!entry) return err(res, 404, "NotFound", `vault ${vaultId} 不存在`);
    const tagged = await tagVaultEntry(vaultId, [rejectTag(to, slug)]);
    if (!tagged) return err(res, 404, "NotFound", `vault ${vaultId} 打标签失败`);
    res.json({ ok: true, vault_id: vaultId, promoted_to: to });
  } catch (e) { next(e); }
});

// POST /series/:slug/elements/:id/reject/import  body: { vault_id }
// 从任意一级废案库, 把一张图导入回当前元素的图库 (作为候选, origin=from_shot 复用语义)
rejectRouter.post("/series/:slug/elements/:id/reject/import", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const vaultId = req.body?.vault_id;
    if (typeof vaultId !== "string" || !vaultId) return err(res, 400, "ValidationError", "vault_id 必填");
    const el = await readAnyElement(slug, id);
    if (!el) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    const entry = await getVaultEntry(vaultId);
    if (!entry) return err(res, 404, "NotFound", `vault ${vaultId} 不存在`);
    // 拷一份到本系列 assets, 便于候选池可见
    let assetId: string | undefined;
    try {
      const abs = getVaultAbsolutePath(entry);
      const buf = await fs.readFile(abs);
      const assetsDir = path.join(DATA_ROOT, "series", slug, "assets", "images");
      await ensureDir(assetsDir);
      const ext = entry.mime === "image/jpeg" ? "jpg" : entry.mime === "image/webp" ? "webp" : "png";
      const filename = `element_${id}_import_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
      const assetPath = `assets/images/${filename}`;
      await fs.writeFile(path.join(assetsDir, filename), buf);
      const asset = await addAsset(slug, {
        series_slug: slug,
        kind: "image",
        tags: [`element:${id}`, `${el.kind}:${id}`, "ref_image", "reject_import"],
        path: assetPath,
        filename,
        mime: entry.mime,
        size_bytes: buf.length,
        sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      });
      assetId = asset.asset_id;
    } catch { /* 拷贝失败不阻塞: vault_id 已够前端展示 */ }
    const added = await addAnyElementImage(slug, id, {
      vault_id: vaultId,
      asset_id: assetId,
      origin: "from_shot",
      url: `/api/v2/vault/${vaultId}/raw`,
      mime: entry.mime,
      note: "从废案库导入",
    });
    if (!added) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    res.status(201).json({ ok: true, element: added.element, image: added.image });
  } catch (e) { next(e); }
});
