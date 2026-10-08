/**
 * v24-batch-all · 模型能力清单
 *
 * GET /api/v2/models                          · 返回所有模型 + availability (结合 local-settings keys)
 *
 * TODO(pm): MODEL_DICT 目前在前端 modelDict.ts + 此处做镜像, 未来是否迁到 db?
 */

import { Router, type Request, type Response } from "express";
import path from "node:path";
import { readJson, pathExists, repoRoot } from "../../../../../packages/core/src/index";

export const modelsRouter = Router();

interface ModelEntry {
  id: string;
  name: string;
  price: string;
  eta: string;
  note: string;
  actions: string[];
  status: "ok" | "coming";
  durations?: number[];
  hot?: boolean;
  requires_key?: string;
}

const MODELS: ModelEntry[] = [
  { id: "local_card_image",    name: "本地卡片",       price: "¥0 / 张",    eta: "约 1s",  note: "无 Key 可跑通链路，适合草稿占位",       actions: ["t2i"],            status: "ok", hot: true },
  { id: "local_sdxl_openclaw", name: "本地 SDXL",      price: "本地算力",   eta: "约 20s", note: "适合本机生图与离线草稿",             actions: ["t2i"],            status: "ok" },
  { id: "jimeng_image_4",      name: "即梦 Image 4.0", price: "按 API 计费", eta: "约 6s",  note: "中文人物与短剧风格首帧",             actions: ["t2i"],            status: "ok", requires_key: "jimeng" },
  { id: "openai_gpt_image_2",  name: "OpenAI Image",   price: "按 API 计费", eta: "约 10s", note: "通用图像生成，适合概念与海报",       actions: ["t2i"],            status: "ok", requires_key: "openai" },
  { id: "local_mock_video",    name: "本地 Mock 视频", price: "¥0 / 条",    eta: "约 1s",  note: "无 Key 可跑通视频候选与合成流程",     actions: ["i2v", "t2v"], durations: [5, 10], status: "ok", hot: true },
  { id: "aliyun_wan_t2v",      name: "通义万相 / Wan", price: "按 API 计费", eta: "约 70s", note: "中文运镜词稳定，支持文生/图生视频",   actions: ["i2v", "t2v"], durations: [5, 10], status: "ok", requires_key: "aliyun_wan" },
  { id: "minimax_hailuo",      name: "MiniMax 海螺",   price: "按 API 计费", eta: "约 60s", note: "运动幅度大，适合动作与情绪推进",      actions: ["i2v", "t2v"], durations: [6, 10], status: "ok", requires_key: "minimax" },
  { id: "jimeng_video_3pro",   name: "即梦视频 3 Pro", price: "按 API 计费", eta: "约 60s", note: "短剧风格与中文画面提示词友好",        actions: ["i2v", "t2v"], durations: [5, 10], status: "ok", requires_key: "jimeng" },
  { id: "wan_i2v_endframe",    name: "Wan 首尾帧",     price: "按 API 计费", eta: "约 95s", note: "首尾帧引导，过渡平滑（接入中）",      actions: ["i2v"], durations: [5], status: "coming", requires_key: "aliyun_wan" },
];

async function readKeyPresence(): Promise<Record<string, boolean>> {
  const settingsFile = path.join(repoRoot, "config", "local-settings.json");
  // 2026-05-28 audit: 文件不存在合理 (新装机), JSON 损坏不能 silent return {} (= UI 看上去
  // 所有 key 都缺, 用户以为新填一遍, 反而把损坏 settings 覆盖).
  if (!(await pathExists(settingsFile))) return {};
  const raw = await readJson<any>(settingsFile);
  const keys = (raw?.providers ?? raw?.secrets ?? {}) as Record<string, any>;
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(keys)) {
    const v = keys[k];
    const has = typeof v === "string" ? v.length > 0 : Boolean(v && (v.api_key || v.apiKey || v.key));
    out[k.toLowerCase()] = has;
  }
  return out;
}

modelsRouter.get("/models", async (_req: Request, res: Response) => {
  const keyMap = await readKeyPresence();
  const models = MODELS.map((m) => {
    const needs = m.requires_key ? !keyMap[m.requires_key] : false;
    let availability: "ok" | "needs_key" | "coming" = "ok";
    if (m.status === "coming") availability = "coming";
    else if (needs) availability = "needs_key";
    return { ...m, availability };
  });
  res.json({ models });
});

// hot-path endpoint 已删除:
// 该 endpoint 返回写死的固定 TOP 3 内容骗前端(铁律 #5 违规)。
// 前端 ModelSplitButton 实际从 lib/modelDict.ts 的 hotPathFor() 读取静态列表,
// 没有任何组件真正调用过此 endpoint(getHotPath 是孤儿函数)。
