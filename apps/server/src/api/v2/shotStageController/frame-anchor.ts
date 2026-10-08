/**
 * Frame anchor (首/尾/关键帧锚点) endpoints — 拆自原 shotStageController.ts。
 *
 * 覆盖 3 个 endpoint:
 *   - POST   /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/frame-anchor
 *   - DELETE /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/frame-anchor/:anchorId
 *   - PATCH  /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/frame-anchor/reorder
 */

import { Router, type Request, type Response } from "express";
import {
  setFrameAnchor,
  removeFrameAnchor,
  reorderFrameAnchors,
} from "../seriesStore";
import { err } from "./shared";

export const frameAnchorRouter = Router();

frameAnchorRouter.post("/series/:slug/episodes/:epId/shots/:sid/stage/frame-anchor", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const role = req.body?.role;
    if (role !== "first" && role !== "end" && role !== "key") {
      return err(res, 400, "ValidationError", "role 必须是 first|end|key");
    }
    const input: Parameters<typeof setFrameAnchor>[3] = { role };
    if (req.body?.position !== undefined) {
      const position = req.body.position;
      if (typeof position !== "number" || position < 0 || position > 1) {
        return err(res, 400, "ValidationError", "position 必须是 0..1 的数字");
      }
      input.position = position;
    }
    if (req.body?.vault_id !== undefined) {
      if (typeof req.body.vault_id !== "string") return err(res, 400, "ValidationError", "vault_id 必须是字符串");
      input.vault_id = req.body.vault_id;
    }
    if (req.body?.asset_id !== undefined) {
      if (typeof req.body.asset_id !== "string") return err(res, 400, "ValidationError", "asset_id 必须是字符串");
      input.asset_id = req.body.asset_id;
    }
    if (req.body?.generation_id !== undefined) {
      if (typeof req.body.generation_id !== "string") return err(res, 400, "ValidationError", "generation_id 必须是字符串");
      input.generation_id = req.body.generation_id;
    }

    const updated = await setFrameAnchor(slug, epId, sid, input);
    if (!updated.ok) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    res.json({ ok: true, frame_anchors: updated.shot?.frame_anchors ?? [] });
  } catch (e) { next(e); }
});

frameAnchorRouter.delete("/series/:slug/episodes/:epId/shots/:sid/stage/frame-anchor/:anchorId", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const anchorId = String(req.params.anchorId);
    const updated = await removeFrameAnchor(slug, epId, sid, anchorId);
    if (!updated.ok) return err(res, 404, "NotFound", `frame anchor ${anchorId} 未找到`);
    res.json({ ok: true, frame_anchors: updated.shot?.frame_anchors ?? [] });
  } catch (e) { next(e); }
});

// W7-stage-reorg (2026-05-16): 批量重排关键帧锚点顺序
// body: { order: string[] }  // anchor_id 数组(只动 role === "key" 的)
frameAnchorRouter.patch("/series/:slug/episodes/:epId/shots/:sid/stage/frame-anchor/reorder", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const order = req.body?.order;
    if (!Array.isArray(order) || !order.every((x) => typeof x === "string")) {
      return err(res, 400, "ValidationError", "order 必须是字符串数组 (anchor_id list)");
    }
    const updated = await reorderFrameAnchors(slug, epId, sid, order);
    if (!updated.ok) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    res.json({ ok: true, frame_anchors: updated.shot?.frame_anchors ?? [] });
  } catch (e) { next(e); }
});
