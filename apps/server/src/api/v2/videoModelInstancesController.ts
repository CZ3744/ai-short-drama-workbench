/**
 * Video Model Instances Controller — 2 级"渠道 + 自定义模型实例"REST 接口
 *
 * 用户痛点 (2026-05-18 累积 3 条):
 *   - 不强制选 "kling-3.0", 用户自填任意 model_id
 *   - 一个渠道可加多个 instance (kling 下可加 v1.6 / v2 / v3 各自一份 key 一份名)
 *   - 一次填好就和 ModelPicker 真挂上, 跳过 silent fallback
 *
 * 路由:
 *   GET    /api/v2/video-channels                    — 列 5 个 channel def
 *   GET    /api/v2/video-model-instances             — 列所有 instance (不暴露 api_key)
 *   POST   /api/v2/video-model-instances             — 加 1 个
 *   PATCH  /api/v2/video-model-instances/:id         — 改 (key 留空 = 保留旧)
 *   DELETE /api/v2/video-model-instances/:id         — 删
 *   POST   /api/v2/video-model-instances/migrate     — 一键迁 legacy env
 *
 * 错误: 用 HTTP 400 + JSON {error: {code, message}}, 不 silent fallback (红线 #1).
 */

import { Router } from "express";
import {
  listVideoChannels,
  getVideoChannel,
  listVideoModelInstances,
  getVideoModelInstancePublic,
  createVideoModelInstance,
  patchVideoModelInstance,
  deleteVideoModelInstance,
  migrateLegacyVideoInstances,
  type VideoChannelId,
} from "../../../../../packages/core/src/videoModelInstances";

export const videoModelInstancesRouter = Router();

// ─── GET /video-channels ───────────────────────────────────────────

videoModelInstancesRouter.get("/video-channels", (_req, res, next) => {
  try {
    res.json({ channels: listVideoChannels() });
  } catch (err) { next(err); }
});

// ─── GET /video-model-instances ────────────────────────────────────

videoModelInstancesRouter.get("/video-model-instances", (req, res, next) => {
  try {
    const channel = typeof req.query.channel === "string" ? req.query.channel : null;
    let instances = listVideoModelInstances();
    if (channel) instances = instances.filter((i) => i.channel === channel);
    res.json({ instances });
  } catch (err) { next(err); }
});

// ─── POST /video-model-instances ───────────────────────────────────

videoModelInstancesRouter.post("/video-model-instances", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const channel = String(body.channel ?? "").trim();
    const channelDef = getVideoChannel(channel);
    if (!channelDef) {
      res.status(400).json({
        error: {
          code: "InvalidChannel",
          message: `未知渠道 "${channel}",仅支持: kling / vidu / jimeng / minimax / aliyun_wan`,
        },
      });
      return;
    }
    const display_name = String(body.display_name ?? "").trim();
    const model_id = String(body.model_id ?? "").trim();
    const api_key = String(body.api_key ?? "").trim();
    const secret_key = body.secret_key ? String(body.secret_key).trim() : undefined;
    const api_base_url = body.api_base_url ? String(body.api_base_url).trim() : undefined;
    const region = body.region ? String(body.region).trim() : undefined;

    if (!display_name) {
      res.status(400).json({ error: { code: "ValidationError", message: "display_name 必填" } });
      return;
    }
    if (!model_id) {
      res.status(400).json({ error: { code: "ValidationError", message: "model_id 必填" } });
      return;
    }
    if (!api_key) {
      res.status(400).json({ error: { code: "ValidationError", message: "api_key 必填" } });
      return;
    }
    if (channelDef.needs_secret && !secret_key) {
      res.status(400).json({
        error: {
          code: "ValidationError",
          message: `${channelDef.label} 需要 secret_key (双 Key 鉴权)`,
        },
      });
      return;
    }

    const created = await createVideoModelInstance({
      display_name,
      channel: channelDef.id,
      model_id,
      api_base_url,
      api_key,
      secret_key,
      region,
    });
    res.status(201).json({ instance: created });
  } catch (err) { next(err); }
});

// ─── PATCH /video-model-instances/:id ──────────────────────────────

videoModelInstancesRouter.patch("/video-model-instances/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const cur = getVideoModelInstancePublic(id);
    if (!cur) {
      res.status(404).json({ error: { code: "NotFound", message: `instance "${id}" 不存在` } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof patchVideoModelInstance>[1] = {};
    if (typeof body.display_name === "string") patch.display_name = body.display_name;
    if (typeof body.model_id === "string") patch.model_id = body.model_id;
    if (body.api_base_url !== undefined) patch.api_base_url = body.api_base_url as string | null;
    if (body.region !== undefined) patch.region = body.region as string | null;
    // api_key 留空 = 保留旧, 显式非空 = 更新
    if (typeof body.api_key === "string") patch.api_key = body.api_key;
    if (typeof body.secret_key === "string") patch.secret_key = body.secret_key;

    const updated = await patchVideoModelInstance(id, patch);
    if (!updated) {
      res.status(404).json({ error: { code: "NotFound", message: `instance "${id}" 不存在` } });
      return;
    }
    res.json({ instance: updated });
  } catch (err) { next(err); }
});

// ─── DELETE /video-model-instances/:id ─────────────────────────────

videoModelInstancesRouter.delete("/video-model-instances/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const removed = await deleteVideoModelInstance(id);
    if (!removed) {
      res.status(404).json({ error: { code: "NotFound", message: `instance "${id}" 不存在` } });
      return;
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── POST /video-model-instances/migrate ───────────────────────────

videoModelInstancesRouter.post("/video-model-instances/migrate", async (_req, res, next) => {
  try {
    const result = await migrateLegacyVideoInstances();
    res.json(result);
  } catch (err) { next(err); }
});

// 类型导出, 供其他 controller 用
export type { VideoChannelId };
