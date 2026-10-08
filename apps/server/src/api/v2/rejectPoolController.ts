import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  readShot,
  appendGeneration,
  removeGenerationFromPools,
  setFrameAnchor,
  type ShotGeneration,
} from "./seriesStore";
import {
  getVaultEntry,
  listVault,
  tagVaultEntry,
} from "../../../../../packages/library/src/assetVault";

export const rejectPoolRouter = Router();

function err(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

rejectPoolRouter.post("/series/:slug/episodes/:epId/shots/:sid/stage/reject-pool/promote", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const generationId = req.body?.generation_id;
    const target = req.body?.target;
    if (typeof generationId !== "string" || !generationId) {
      return err(res, 400, "ValidationError", "generation_id 必填");
    }
    if (target !== "project" && target !== "public") {
      return err(res, 400, "ValidationError", "target 必须是 project|public");
    }

    const shot = await readShot(slug, epId, sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    const trashedBase = shot.trashed_generations ?? [];
    const activeBase = shot.active_generations ?? (shot.generations ?? []);
    const generation = activeBase.find((g) => g.generation_id === generationId)
      ?? trashedBase.find((g) => g.generation_id === generationId);
    if (!generation) return err(res, 404, "NotFound", `generation ${generationId} 未找到`);
    if (!generation.vault_id) {
      return err(res, 400, "ValidationError", "该候选无 vault 记录，无法升级到共享废案库");
    }

    const tagged = await tagVaultEntry(
      generation.vault_id,
      target === "project" ? ["reject_pool:project"] : ["reject_pool:public"],
    );
    if (!tagged) return err(res, 404, "NotFound", `vault ${generation.vault_id} 未找到`);

    // 2026-07-10 audit 补漏 — 锁内重读移除, 防并发 appendGeneration 追加的已扣费候选被陈旧快照绝对覆盖冲掉.
    const removed = await removeGenerationFromPools(slug, epId, sid, generationId);
    if (!removed.ok) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// V-11: demote — 撤销 promote 的 reject_pool tag
rejectPoolRouter.post("/reject-pool/demote", async (req: Request, res: Response, next) => {
  try {
    const vaultId = req.body?.vault_id;
    if (typeof vaultId !== "string" || !vaultId) {
      return err(res, 400, "ValidationError", "vault_id 必填");
    }
    const entry = await getVaultEntry(vaultId);
    if (!entry) return err(res, 404, "NotFound", `vault ${vaultId} 未找到`);
    const currentTags = entry.tags ?? [];
    const nextTags = currentTags.filter(
      (t) => t !== "reject_pool:project" && t !== "reject_pool:public"
    );
    if (nextTags.length === currentTags.length) {
      // 没有 reject_pool tag 可移除
      return err(res, 400, "ValidationError", "该条目不在废案库中");
    }
    await tagVaultEntry(vaultId, nextTags);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

rejectPoolRouter.get("/reject-pool", async (req: Request, res: Response, next) => {
  try {
    const tier = req.query.tier;
    if (tier !== "project" && tier !== "public") {
      return err(res, 400, "ValidationError", "tier 必须是 project|public");
    }

    let entries;
    if (tier === "project") {
      if (typeof req.query.slug !== "string" || !req.query.slug) {
        return err(res, 400, "ValidationError", "project tier 需要 slug");
      }
      entries = await listVault({
        tags: ["reject_pool:project"],
        series_slug: req.query.slug,
        status: "active",
        limit: 200,
      });
    } else {
      entries = await listVault({
        tags: ["reject_pool:public"],
        status: "active",
        limit: 200,
      });
    }

    res.json({
      items: entries.map((e) => ({
        vault_id: e.vault_id,
        kind: e.kind,
        url: `/api/v2/vault/${e.vault_id}/raw`,
        thumbnail: `/api/v2/vault/${e.vault_id}/thumbnail`,
        provider_id: e.provider_id,
        created_at: e.created_at,
        series_slug: e.context.series_slug,
        cost_cny: e.cost_cny,
        tags: e.tags,
        // 2026-05-21 — 透传 display_name 给前端 (铁律 #2 display_name 跨页面统一).
        // 之前 RejectPoolStrip 显示 "${kind} · ${element_name}" 是元数据不是图本身的名字,
        // 用户原话 5/20: "复用 InlineLabel 组件接到所有显示图片名的地方".
        display_name: e.display_name,
      })),
    });
  } catch (e) { next(e); }
});

rejectPoolRouter.post("/series/:slug/episodes/:epId/shots/:sid/stage/reject-pool/import", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const vaultId = req.body?.vault_id;
    const asAnchor = req.body?.as_anchor;
    if (typeof vaultId !== "string" || !vaultId) {
      return err(res, 400, "ValidationError", "vault_id 必填");
    }
    if (asAnchor !== undefined && asAnchor !== "first") {
      return err(res, 400, "ValidationError", "as_anchor 只支持 first");
    }

    const entry = await getVaultEntry(vaultId);
    if (!entry) return err(res, 404, "NotFound", `vault ${vaultId} 未找到`);
    const shot = await readShot(slug, epId, sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    const generationId = crypto.randomUUID();
    const generation: ShotGeneration = {
      generation_id: generationId,
      type: "first_frame",
      provider: "reject_pool_import",
      vault_id: vaultId,
      asset_id: vaultId,
      status: "done",
      created_at: new Date().toISOString(),
      picked: false,
      cost_cny: 0,
    };

    // 2026-07-10 audit 补漏 — 原子追加: 之前 readShot(锁外, line 152)+updateShot(绝对 generations
    // 数组). 同镜并发落盘(废案库导入与另一路首帧生成/重抽同时写)各自锁外读到同一基线, 各自整段
    // updateShot → 后写覆盖先写冲掉已扣费候选. 改用 shotRepo.appendGeneration 锁内重读+append+write.
    const updated = await appendGeneration(slug, epId, sid, generation);
    if (!updated) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    if (asAnchor === "first") {
      await setFrameAnchor(slug, epId, sid, {
        role: "first",
        generation_id: generationId,
        vault_id: vaultId,
        asset_id: vaultId,
      });
    }

    res.json({ ok: true, generation_id: generationId });
  } catch (e) { next(e); }
});
