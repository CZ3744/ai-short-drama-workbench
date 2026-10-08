/**
 * Element image endpoints — import / patch / batch / set/clear-primary / delete.
 *
 * 2026-05-21 P1 拆分: 抽自 elementController.ts §"图片" 段, 实现一字不差.
 */

import { Router } from "express";
import type { ElementImage } from "../../../repositories/elementRepo";
import { importImageToSeries } from "../imageImportHelpers";
import { loggerSync } from "../../../../../../packages/core/src/logger";
import { updateAssetMeta } from "../../../repositories/assetMetaRepo";
import {
  readAnyElement,
  addAnyElementImage,
  patchAnyElementImageMeta,
  removeAnyElementImage,
  setAnyPrimaryImage,
  clearAnyPrimaryImage,
  ensureVaultFromImage,
} from "../elementController.helpers";
import {
  err,
  findImageUsageInShots,
  mergeElementImagesWithAssetMeta,
} from "./_shared";

export const imagesRouter = Router();

// POST /series/:slug/elements/:id/import-image — 本地图片导入 (Windows 文件选择器 → base64)
imagesRouter.post("/series/:slug/elements/:id/import-image", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const el = await readAnyElement(slug, id);
    if (!el) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    const body = req.body ?? {};
    if (typeof body.image_base64 !== "string" || body.image_base64.length < 32) {
      return err(res, 400, "ValidationError", "image_base64 缺失或太短");
    }
    const result = await importImageToSeries({
      slug,
      payload: { image_base64: body.image_base64, mime: body.mime, filename: body.filename },
      context: { kind: "element_image", element_id: id, element_kind: el.kind },
      tags: [`element:${id}`, `element_kind:${el.kind}`, "element_imported"],
    });
    const added = await addAnyElementImage(slug, id, {
      vault_id: result.vault_id,
      asset_id: result.asset_id,
      origin: "imported",
      url: `/api/v2/vault/${result.vault_id}/raw`,
      note: body.note,
      display_name: typeof body.display_name === "string" ? body.display_name.trim() : undefined,
      available_for_shot: typeof body.available_for_shot === "boolean" ? body.available_for_shot : undefined,
    });
    if (!added) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    res.status(201).json({ ok: true, element: added.element, image: added.image });
  } catch (e) { next(e); }
});

// PATCH /series/:slug/elements/:id/images/:imageId — 更新图片展示名 / 分镜可用状态
imagesRouter.patch("/series/:slug/elements/:id/images/:imageId", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const imageId = String(req.params.imageId);
    const el = await readAnyElement(slug, id);
    if (!el) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    if (!el.images.some((im) => im.image_id === imageId)) {
      return err(res, 404, "NotFound", `图片 ${imageId} 不存在`);
    }

    const body = req.body ?? {};
    const patch: Partial<Pick<ElementImage, "display_name" | "available_for_shot" | "is_typical" | "image_tags">> = {};
    if (Object.prototype.hasOwnProperty.call(body, "display_name")) {
      if (typeof body.display_name !== "string") {
        return err(res, 400, "ValidationError", "展示名必须是文字");
      }
      const displayName = body.display_name.trim();
      if (displayName.length < 1 || displayName.length > 50) {
        return err(res, 400, "ValidationError", "展示名长度必须是 1-50 个字");
      }
      if (/[\\/]/.test(displayName)) {
        return err(res, 400, "ValidationError", "展示名不能包含路径分隔符");
      }
      const duplicate = el.images.some((im) => im.image_id !== imageId && im.display_name?.trim() === displayName);
      if (duplicate) {
        return err(res, 400, "ValidationError", "同一素材内已有同名图片");
      }
      patch.display_name = displayName;
    }
    if (Object.prototype.hasOwnProperty.call(body, "available_for_shot")) {
      if (typeof body.available_for_shot !== "boolean") {
        return err(res, 400, "ValidationError", "可用状态必须是真/假");
      }
      patch.available_for_shot = body.available_for_shot;
    }
    // 2026-05-18 三池模型: is_typical 标志
    if (Object.prototype.hasOwnProperty.call(body, "is_typical")) {
      if (typeof body.is_typical !== "boolean") {
        return err(res, 400, "ValidationError", "典型标志必须是真/假");
      }
      patch.is_typical = body.is_typical;
    }
    // 2026-05-26 W2 — 单张图维度标签 (pose/expression/outfit/lighting/free etc.).
    // 让用户给典型图打"姿态/表情/造型"等标签, ReferencePicker 按 axis 过滤.
    if (Object.prototype.hasOwnProperty.call(body, "image_tags")) {
      const raw = body.image_tags;
      if (!Array.isArray(raw)) {
        return err(res, 400, "ValidationError", "维度标签必须是数组格式");
      }
      if (raw.length > 50) {
        return err(res, 400, "ValidationError", "维度标签最多 50 条");
      }
      const clean: Array<{ axis: string; value: string }> = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const axis = typeof rec.axis === "string" ? rec.axis.trim() : "";
        const value = typeof rec.value === "string" ? rec.value.trim() : "";
        if (!axis || !value) continue;
        if (axis.length > 30 || value.length > 60) {
          return err(res, 400, "ValidationError", "维度标签的 axis ≤30 字, value ≤60 字");
        }
        clean.push({ axis, value });
      }
      patch.image_tags = clean;
    }
    if (Object.keys(patch).length === 0) {
      return err(res, 400, "ValidationError", "没有可更新的图片字段");
    }

    const updated = await patchAnyElementImageMeta(slug, id, imageId, patch);
    if (!updated) return err(res, 404, "NotFound", "素材或图片不存在");

    // display_name 体系: rename 只写 image_id-keyed asset_meta (本系列本地标识).
    // 铁律#0 防串味: 不写共享 vault_id-keyed — 跨系列 SHA 去重共用同一 vault_id,
    // 写它会把本系列改名泄漏到源系列同一张图 (串味). vault 条目改名走 vaultController 自己的端点.
    if (Object.prototype.hasOwnProperty.call(patch, "display_name")) {
      try {
        await updateAssetMeta(imageId, { display_name: patch.display_name });
      } catch (e) {
        loggerSync().warn(`[element image PATCH] assetMetaRepo 同步失败 (非致命): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 合并 assetMeta 单一真理源后返回
    const merged = await mergeElementImagesWithAssetMeta(updated);
    res.json({ ok: true, element: merged });
  } catch (e) { next(e); }
});

// 2026-05-18 三池模型批量端点
// POST /series/:slug/elements/:id/images/batch-pool-state
// body: { image_ids: string[], is_typical?: boolean, available_for_shot?: boolean }
// 一次批量晋升/降级多张图. UI 场景: 用户多选 N 张 → 一次"标为典型" / "加入真池" / "移回原始"
imagesRouter.post("/series/:slug/elements/:id/images/batch-pool-state", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const body = req.body ?? {};
    const imageIds = Array.isArray(body.image_ids) ? body.image_ids.filter((x: unknown): x is string => typeof x === "string") : null;
    if (!imageIds || imageIds.length === 0) {
      return err(res, 400, "ValidationError", "image_ids 必须是非空字符串数组");
    }
    if (imageIds.length > 200) {
      return err(res, 400, "ValidationError", "一次批量最多 200 张图");
    }
    const patch: { is_typical?: boolean; available_for_shot?: boolean } = {};
    if (Object.prototype.hasOwnProperty.call(body, "is_typical")) {
      if (typeof body.is_typical !== "boolean") return err(res, 400, "ValidationError", "is_typical 必须是真/假");
      patch.is_typical = body.is_typical;
    }
    if (Object.prototype.hasOwnProperty.call(body, "available_for_shot")) {
      if (typeof body.available_for_shot !== "boolean") return err(res, 400, "ValidationError", "available_for_shot 必须是真/假");
      patch.available_for_shot = body.available_for_shot;
    }
    if (Object.keys(patch).length === 0) {
      return err(res, 400, "ValidationError", "至少要设置 is_typical 或 available_for_shot 其一");
    }

    // 串行调单条 patch 复用语义保障逻辑 (typical=true → 自动 in_pool=true 等).
    // 单 element 通常 ≤ 几十张图, 串行可接受. 后续如需提速可批 elementRepo.setElementImagesPoolState.
    let lastElement: Awaited<ReturnType<typeof patchAnyElementImageMeta>> = null;
    let updatedCount = 0;
    for (const imageId of imageIds) {
      const updated = await patchAnyElementImageMeta(slug, id, imageId, patch);
      if (updated) {
        lastElement = updated;
        updatedCount += 1;
      }
    }
    if (!lastElement) return err(res, 404, "NotFound", "素材或所有图片不存在");
    res.json({ ok: true, element: lastElement, updated_count: updatedCount });
  } catch (e) { next(e); }
});

// POST /series/:slug/elements/:id/images/:imageId/set-primary
imagesRouter.post("/series/:slug/elements/:id/images/:imageId/set-primary", async (req, res, next) => {
  try {
    const el = await setAnyPrimaryImage(String(req.params.slug), String(req.params.id), String(req.params.imageId));
    if (!el) return err(res, 404, "NotFound", "素材或图片不存在");
    res.json({ ok: true, element: el });
  } catch (e) { next(e); }
});

// POST /series/:slug/elements/:id/clear-primary
// 取消主图锚定 — 把 primary_image_id 置空, 图片本身保留 (铁律 #6 数据保留)
imagesRouter.post("/series/:slug/elements/:id/clear-primary", async (req, res, next) => {
  try {
    const el = await clearAnyPrimaryImage(String(req.params.slug), String(req.params.id));
    if (!el) return err(res, 404, "NotFound", "素材不存在");
    res.json({ ok: true, element: el });
  } catch (e) { next(e); }
});

// DELETE /series/:slug/elements/:id/images/:imageId
imagesRouter.delete("/series/:slug/elements/:id/images/:imageId", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const imageId = String(req.params.imageId);
    const el = await readAnyElement(slug, id);
    if (!el) return err(res, 404, "NotFound", "素材不存在");
    const image = el.images.find((im) => im.image_id === imageId);
    if (!image) return err(res, 404, "NotFound", "图片不存在");
    if (image.is_typical) {
      return err(
        res,
        409,
        "ImageInUse",
        "该图片已标记为典型图，正被用作分镜参考。请先把其他图设为典型，或先撤销典型标记，再删除。",
      );
    }

    const refs = await findImageUsageInShots(slug, image);
    if (refs.length > 0) {
      return err(
        res,
        409,
        "ImageInUse",
        `该图片被 ${refs.length} 个分镜显式引用作参考，请先撤销那些引用再删除。`,
      );
    }

    const vaultId = image.vault_id ?? await ensureVaultFromImage(slug, el, image);
    if (!vaultId) {
      return err(res, 409, "ImageNotArchived", "该图片尚未归档到资料柜，无法安全删除。请先重新导入或生成可归档版本。");
    }

    const updated = await removeAnyElementImage(slug, id, imageId);
    if (!updated) return err(res, 404, "NotFound", "删除失败");
    res.json({ ok: true, element: updated });
  } catch (e) { next(e); }
});
