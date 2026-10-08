/**
 * seriesCoverFallbackController — 2026-07-22 Y6 UP-9(b)
 *
 * "系列卡封面自动取该系列任意已有图" — StudioHome 系列卡 cover_vault_id 缺失时(用户没显式点过
 * "生成封面"), 不再只有渐变占位, 从系列已有素材/首帧候选里挑一张真实图片顶上。
 *
 * 设计: 只做一个 302 重定向端点, 复用既有的 raw 图片服务(vault raw / series asset raw),
 * 不重新实现文件读流。前端 <img src=".../cover-fallback"> 天然懒加载(loading="lazy") +
 * onError 兜底回渐变占位, 不需要额外一轮"先查有没有图再决定渲染什么"的往返请求。
 *
 * 解析优先级(找到第一个就返回, 不追求穷举):
 *   1) listAssets(slug, {kind:"image"}) 的第一条 —— 覆盖角色/场景参考图(它们导入时也走
 *      assets/index.jsonl 登记, 见 assetRepo.ts) + 用户手动上传/导入的候选图.
 *   2) 各集分镜里第一个可解析的首帧生成记录(picked 优先, 否则第一个 type=first_frame 且
 *      status=done) —— 覆盖"生成过首帧但还没导入/登记成正式素材"的系列。
 * 都没有 → 404, 前端 <img onError> 接住, 保持渐变占位(诚实反映"这系列还没有任何图").
 *
 * 范围说明: 未合并 character/scene 的 "primary_image" 完整适配层(elementController 里那套
 * readAnyElement/characterToElement) —— 那些角色主图在正常导入流程下已经会落进
 * assets/index.jsonl(第 1 层覆盖), 为控制本轮改动面只做两层，非详尽合并全部图源。
 */

import { Router } from "express";
import { listAssets } from "../../repositories/assetRepo";
import { listEpisodes } from "../../repositories/episodeRepo";
import { listShots } from "../../repositories/shotRepo";

export const seriesCoverFallbackRouter = Router();

function assetRawUrl(slug: string, path: string): string {
  // asset.path 已经是 "assets/images/xxx.png" 这种相对路径, 直接拼进
  // GET /api/v2/series/:slug/assets/:kind/:filename 这条既有路由的 URL 形态.
  return `/api/v2/series/${encodeURIComponent(slug)}/${path}`;
}

function vaultRawUrl(vaultId: string): string {
  return `/api/v2/vault/${encodeURIComponent(vaultId)}/raw`;
}

/** 从一个分镜的生成记录里找"能直接给用户看"的首帧图 URL(picked 优先). */
function resolveShotFirstFrameUrl(
  slug: string,
  shot: { generations?: Array<{ type: string; status: string; vault_id?: string; path?: string; generation_id: string }>; active_generations?: Array<{ type: string; status: string; vault_id?: string; path?: string; generation_id: string }>; picked_first_frame_generation_id?: string | null },
): string | null {
  const gens = (shot.active_generations && shot.active_generations.length > 0)
    ? shot.active_generations
    : (shot.generations ?? []);
  const firstFrameGens = gens.filter((g) => g.type === "first_frame" && g.status === "done");
  if (firstFrameGens.length === 0) return null;
  const picked = shot.picked_first_frame_generation_id
    ? firstFrameGens.find((g) => g.generation_id === shot.picked_first_frame_generation_id)
    : undefined;
  const gen = picked ?? firstFrameGens[0];
  if (gen.vault_id) return vaultRawUrl(gen.vault_id);
  if (gen.path) return assetRawUrl(slug, gen.path);
  return null;
}

// GET /api/v2/series/:slug/cover-fallback — 302 到系列任意已有真实图片, 没有则 404.
seriesCoverFallbackRouter.get("/series/:slug/cover-fallback", async (req, res, next) => {
  try {
    const slug = req.params.slug;

    // 第 1 层: 素材库(角色/场景参考图 + 手动导入图片) —— 覆盖面最广, 优先.
    const assets = await listAssets(slug, { kind: "image", limit: 1 });
    if (assets.length > 0) {
      res.redirect(302, assetRawUrl(slug, assets[0].path));
      return;
    }

    // 第 2 层: 扫各集分镜找第一个已完成的首帧生成(哪怕还没被登记成正式素材).
    // 提前退出 —— 找到第一张就返回, 不是"数一遍全系列图"这种重量级统计.
    const episodes = await listEpisodes(slug);
    for (const ep of episodes) {
      const shots = await listShots(slug, ep.id);
      for (const shot of shots) {
        const url = resolveShotFirstFrameUrl(slug, shot);
        if (url) {
          res.redirect(302, url);
          return;
        }
      }
    }

    res.status(404).json({ error: { code: "NotFound", message: "该系列还没有任何图片" } });
  } catch (err) { next(err); }
});
