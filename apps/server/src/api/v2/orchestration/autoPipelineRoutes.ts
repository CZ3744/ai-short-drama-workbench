/**
 * Auto-pipeline routes — 一键自动管线 (首帧 → 视频 → 合成).
 *
 *   POST   /series/:slug/episodes/:epId/auto-pipeline           — 启动
 *   GET    /auto-pipelines/:pipelineId                          — 拉状态
 *   POST   /auto-pipelines/:pipelineId/abort                    — 中断
 *   POST   /auto-pipelines/:pipelineId/retry-stage              — 从指定 stage 重跑
 *   GET    /auto-pipelines?series_slug=&episode_id=             — 列表 (筛选)
 */

import { Router } from "express";
import { z } from "zod";
import {
  startAutoPipeline,
  abortPipeline,
  retryStage,
  getPipeline,
  listPipelines,
  type AutoPipelineStage,
  type AutoPipelineOptions,
} from "../../../application/generation/autoPipelineRunner";
import { ProviderNotSelectedError } from "../../../jobs/errors";
import { readSeries } from "../../../api/v2/seriesStore";
import { isRealVideoProvider } from "../../../../../../packages/core/src/realVideoLock";
import { providerIdFromModelRef, videoInstanceIdFromModelRef } from "../../../application/generation/modelRef";
import { mapChannelToProviderId } from "../../../application/generation/videoGenerationService";
import { getVideoModelInstance } from "../../../../../../packages/core/src/videoModelInstances";

export const autoPipelineRouter = Router();

const AutoPipelineStartSchema = z.object({
  image_provider_id: z.string().max(200).optional(),
  video_provider_id: z.string().max(200).optional(),
  image_count_per_shot: z.number().int().min(1).max(5).optional(),
  video_count_per_shot: z.number().int().min(1).max(3).optional(),
  compose_settings: z.record(z.string(), z.unknown()).optional(),
  auto_pick_strategy: z.enum(["first", "quality_score"]).optional(),
  /** 2026-05-19 #8c: 跳过素材图生图阶段 (默认 false) */
  skip_element_images: z.boolean().optional(),
  /**
   * 2026-05-19 #4: 只跑 element_images stage, 跳过 firstframes/videos/compose.
   * 素材库"一键补全素材图"按钮场景用. 此模式下 preflight 跳过视频 provider 校验.
   */
  only_element_images: z.boolean().optional(),
  /**
   * 2026-05-19 #C: 只跑 element_images + firstframes, 跳过 videos/compose.
   * "整集挂机抽首帧"场景用. 同样跳过视频 provider 校验.
   */
  only_firstframes: z.boolean().optional(),
  /** 2026-05-20 Wave T S8: 只跑视频 stage, 用现有首帧重抽视频候选. */
  only_videos: z.boolean().optional(),
  /** 复用自动管线已有子集链路: 只处理这些分镜. */
  shot_ids: z.array(z.string()).max(500).optional(),
  /** 复用自动管线已有子集链路: 只处理这些素材. */
  element_ids: z.array(z.string()).max(500).optional(),
  /**
   * 2026-05-28 P1-9: 用户在 UI 弹"启动会扣费"二次确认勾完才传 true.
   * 真实视频 provider (kling / mimo / vidu / 火山 ...) 必传 true, 否则 400.
   * 本地 mock 视频不强制. 防一键按钮意外扣费.
   */
  confirmed_real_api: z.boolean().optional(),
});

const RetryStageSchema = z.object({
  stage: z.enum(["element_images", "firstframes", "videos", "compose"]),
  /**
   * 2026-05-19 优化 6: 可选 bulk-retry 子集.
   *   - shot_ids: 限定 firstframes / videos stage 只处理这些 shot
   *   - element_ids: 限定 element_images stage 只处理这些 element
   *   - 不传 → 走整 stage 全部重跑 (向后兼容)
   */
  shot_ids: z.array(z.string()).max(500).optional(),
  element_ids: z.array(z.string()).max(500).optional(),
  /** 只重抽视频, 不把视频成功后继续推到合成. */
  only_videos: z.boolean().optional(),
});

/**
 * Provider 预校验 — 启动前一次性验完, 别等 stage 跑到一半 throw.
 * 任一 provider 都没显式给, 也没 series.defaults — 直接 400.
 */
async function preflightProviders(
  slug: string,
  imageOverride: string | undefined,
  videoOverride: string | undefined,
  /**
   * 2026-05-19 #4 / #C: only_element_images / only_firstframes=true 时跳过视频 provider 校验
   * (那两条路径都不会跑到 videos stage).
   */
  skipVideoCheck: boolean = false,
  /** 2026-05-20 S8: only_videos=true 时不需要图像 provider. */
  skipImageCheck: boolean = false,
): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  const series = await readSeries(slug);
  if (!series) {
    return { ok: false, status: 404, body: { error: { code: "NotFound", message: `Series "${slug}" 不存在` } } };
  }
  // 取 model_ref 的 provider_id 部分 (兼容 "<provider>:<model>" 格式)
  const splitProviderId = (ref?: string): string | undefined => {
    if (!ref) return undefined;
    const idx = ref.indexOf(":");
    return idx >= 0 ? ref.slice(0, idx) : ref;
  };
  const imageId = splitProviderId(imageOverride) || series.defaults?.image_provider_id;
  const videoId = splitProviderId(videoOverride) || series.defaults?.video_provider_id;
  if (!skipImageCheck && (!imageId || !imageId.trim())) {
    return {
      ok: false, status: 400,
      body: { error: { code: "provider_not_selected", message: "请先选择图像模型, 或在设置中配置默认图像模型" } },
    };
  }
  // 2026-05-19 #4 / #C: 只生素材图 / 只跑首帧 路径都不要求视频 provider
  if (!skipVideoCheck && (!videoId || !videoId.trim())) {
    return {
      ok: false, status: 400,
      body: { error: { code: "provider_not_selected", message: "请先选择视频模型, 或在设置中配置默认视频模型" } },
    };
  }
  return { ok: true };
}

/**
 * 真实付费视频 provider id → toC 友好中文名 (铁律 #9: 弹窗文案不暴露内部 id / 下划线代号).
 * 未收录的一律回落到通用"付费视频模型".
 */
const REAL_VIDEO_PROVIDER_LABELS: Record<string, string> = {
  minimax_hailuo: "MiniMax 海螺",
  aliyun_wan_t2v: "阿里万相",
  jimeng_video_3pro: "即梦",
  jimeng_video_3_720p: "即梦 720P",
  kling_3: "可灵 AI",
  vidu_q3_ref: "Vidu",
  zhipu_cogvideox: "智谱 CogVideoX",
  baidu_qianfan_video: "百度千帆",
  tencent_hunyuan_video: "腾讯混元视频",
};
function friendlyVideoProviderLabel(id: string): string {
  return REAL_VIDEO_PROVIDER_LABELS[id] ?? "付费视频模型";
}

/**
 * 把视频 model_ref 解析成真实注册 provider id.
 * 支持 3 种形态 (与 stages/videos.ts 的 unwrap 逻辑一致):
 *   - "instance:<vmi_id>[:<model>]" → 查实例 → channel → 真实 provider id
 *   - "<provider>:<model>"          → 取冒号前 provider 段
 *   - "<provider>"                  → 原样
 * 解析不出 (空 / 实例已删) 返回 null.
 */
function resolveVideoProviderId(rawVideoRef: string | undefined): string | null {
  if (typeof rawVideoRef !== "string" || !rawVideoRef.trim()) return null;
  const instanceId = videoInstanceIdFromModelRef(rawVideoRef);
  if (instanceId) {
    const inst = getVideoModelInstance(instanceId);
    // 实例已删 → 无法确定真实 provider, 交给下游 preflight / 生成时按缺 provider 报错
    return inst ? mapChannelToProviderId(inst.channel) : null;
  }
  return providerIdFromModelRef(rawVideoRef) ?? null;
}

/**
 * 2026-07-09 audit / 2026-07-10 加固 — 真实付费视频 provider 需 UI 显式 confirmed_real_api=true
 * 才放行, 防一键 / 批量意外扣费 (CLAUDE.md §9). 单集与批量端点共用同一门, 避免安全门实现漂移.
 *
 * 关键: 必须解析"最终真实 provider" —— 之前只按 ":" 切首段, 导致两条绕过:
 *   1. "instance:vmi_xxx:model" 首段是 "instance" 不是真实 provider → 漏判 → 绕过扣费确认.
 *   2. 请求不带 video_provider_id 时走 series 默认 provider, 老逻辑直接放行 → 绕过.
 * 现在先 unwrap instance: 前缀, 缺省再回退 series 默认 provider, 再判是否真实付费.
 *
 * 返回 null = 放行; 返回真实付费 provider id = 未确认, caller 应 400 拒绝.
 */
async function unconfirmedRealVideoProvider(
  opts: {
    video_provider_id?: string;
    confirmed_real_api?: boolean;
    only_element_images?: boolean;
    only_firstframes?: boolean;
  },
  seriesSlug: string,
): Promise<string | null> {
  const skipVideo = opts.only_element_images === true || opts.only_firstframes === true;
  if (skipVideo) return null;
  if (opts.confirmed_real_api === true) return null;
  // 显式 provider 优先; 没传就取 series 默认 (与 preflightProviders 同源, 关掉"走默认绕过").
  let effectiveRef = opts.video_provider_id?.trim() ? opts.video_provider_id : undefined;
  if (!effectiveRef) {
    const series = await readSeries(seriesSlug);
    effectiveRef = series?.defaults?.video_provider_id;
  }
  const realId = resolveVideoProviderId(effectiveRef);
  return realId && isRealVideoProvider(realId) ? realId : null;
}

// ─── Routes ─────────────────────────────────────────────────────────

autoPipelineRouter.post("/series/:slug/episodes/:epId/auto-pipeline", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const parsed = AutoPipelineStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "ValidationError",
          message: "请求体校验失败",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    const opts = parsed.data;

    // Provider preflight — 启动前别假信任, 任一 provider 不行直接 400
    // 2026-05-19 #4 / #C: only_element_images / only_firstframes 时不要求视频 provider
    const skipVideoCheck = opts.only_element_images === true || opts.only_firstframes === true;
    const skipImageCheck = opts.only_videos === true;
    const pre = await preflightProviders(
      slug,
      opts.image_provider_id,
      opts.video_provider_id,
      skipVideoCheck,
      skipImageCheck,
    );
    if (!pre.ok) {
      res.status(pre.status).json(pre.body);
      return;
    }

    // 2026-05-28 P1-9 / 2026-07-09 audit: 真实付费视频 provider 要求 UI 显式 confirmed_real_api=true.
    // 一键管线启动一次 = N 镜 video 调用, 是付费扣费最大单点. 与批量端点共用同一门 (见 unconfirmedRealVideoProvider).
    const unconfirmedSingle = await unconfirmedRealVideoProvider(opts, slug);
    if (unconfirmedSingle) {
      res.status(400).json({
        error: {
          code: "RealApiNotConfirmed",
          message: `${friendlyVideoProviderLabel(unconfirmedSingle)}是付费视频模型, 启动一键管线会按镜次扣费. 请先在弹窗勾选"我知道这次会扣费"再启动.`,
        },
      });
      return;
    }

    const record = startAutoPipeline(slug, epId, opts as AutoPipelineOptions);
    res.json({
      ok: true,
      pipeline_id: record.pipeline_id,
      stages: record.stages.map((s) => ({ id: s.id, status: s.status })),
      record,
    });
  } catch (err) {
    if (err instanceof ProviderNotSelectedError) {
      res.status(400).json({
        error: { code: "provider_not_selected", message: err.message },
      });
      return;
    }
    next(err);
  }
});

autoPipelineRouter.get("/auto-pipelines/:pipelineId", async (req, res, next) => {
  try {
    const record = await getPipeline(String(req.params.pipelineId));
    if (!record) {
      res.status(404).json({ error: { code: "NotFound", message: "pipeline 不存在或已 GC" } });
      return;
    }
    res.json({ ok: true, record });
  } catch (e) { next(e); }
});

autoPipelineRouter.get("/auto-pipelines", async (req, res, next) => {
  try {
    const seriesSlug = typeof req.query.series_slug === "string" ? req.query.series_slug : undefined;
    const episodeId  = typeof req.query.episode_id  === "string" ? req.query.episode_id  : undefined;
    const records = await listPipelines({ series_slug: seriesSlug, episode_id: episodeId });
    res.json({ ok: true, records });
  } catch (e) { next(e); }
});

autoPipelineRouter.post("/auto-pipelines/:pipelineId/abort", async (req, res, next) => {
  try {
    const result = await abortPipeline(String(req.params.pipelineId));
    if (!result.ok) {
      const status = result.reason === "pipeline_not_found" ? 404 : 409;
      res.status(status).json({ error: { code: result.reason, message: `中断失败: ${result.reason}` } });
      return;
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

autoPipelineRouter.post("/auto-pipelines/:pipelineId/retry-stage", async (req, res, next) => {
  try {
    const parsed = RetryStageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "ValidationError",
          message: "请求体校验失败",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    // 2026-05-19 优化 6: 透传 shot_ids / element_ids — bulk retry 失败子集场景用
    const result = await retryStage(
      String(req.params.pipelineId),
      parsed.data.stage as AutoPipelineStage,
      { shot_ids: parsed.data.shot_ids, element_ids: parsed.data.element_ids, only_videos: parsed.data.only_videos },
    );
    if (!result.ok) {
      const status = result.reason === "pipeline_not_found" ? 404 : 409;
      res.status(status).json({ error: { code: result.reason, message: `重试失败: ${result.reason}` } });
      return;
    }
    res.json({ ok: true, record: result.record });
  } catch (e) { next(e); }
});

// ─── 优化 1 (2026-05-19): 批量启动 — 一次给 N 部剧/集启动 pipeline ─────
//
// 用户痛点: BatchSeriesDialog 一次创建 N 部剧, 但跑完只产剧本+分镜跳 StudioHome,
// 用户必须逐部进 ShotboardPage 各点一次"一键自动生成全集" × N. 批量优势消失.
//
// 这个 endpoint 接收 series_episodes 数组 + 共用 options, 串行启动 N 个 pipeline
// (每个 pipeline 内部还是 fire-and-forget 异步执行, 启动顺序串行只是为了 preflight
// 一致性 + 错误归集). 返回 pipeline_ids 列表 + 单条失败原因.
//
// 错误策略: 任一 episode preflight 失败 → 该条 errors 数组+1, 继续启动其他;
// 整体 status 200 + ok=true, 让前端能 partial-success 提示 "已启动 X/Y 个".

const BatchStartSchema = z.object({
  series_episodes: z.array(z.object({
    slug: z.string().min(1).max(200),
    ep_id: z.string().min(1).max(200),
  })).min(1).max(50),
  options: AutoPipelineStartSchema.optional(),
});

autoPipelineRouter.post("/auto-pipeline/batch", async (req, res, next) => {
  try {
    const parsed = BatchStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "ValidationError",
          message: "请求体校验失败 (series_episodes 必填非空数组, 上限 50)",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    const { series_episodes, options } = parsed.data;
    const opts = options ?? {};
    const skipVideoCheck = opts.only_element_images === true || opts.only_firstframes === true;
    const skipImageCheck = opts.only_videos === true;

    // 2026-07-09 audit 修复 / 2026-07-10 加固 — 批量端点原本完全没有 confirmed_real_api 付费确认门
    // (单集端点有), 真实付费 provider 批量启动会 N 集 × M 镜扣费却不需确认. 补上与单集同一门.
    // 每部剧可能各自走不同的 series 默认 provider, 故按去重后的 slug 逐个解析真实 provider, 任一未确认即拒.
    if (opts.confirmed_real_api !== true) {
      const seenSlugs = new Set<string>();
      for (const { slug } of series_episodes) {
        if (seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);
        const unconfirmedBatch = await unconfirmedRealVideoProvider(opts, slug);
        if (unconfirmedBatch) {
          res.status(400).json({
            error: {
              code: "RealApiNotConfirmed",
              message: `${friendlyVideoProviderLabel(unconfirmedBatch)}是付费视频模型, 批量启动一键管线会按镜次 × 集数扣费. 请先勾选"我知道这次会扣费"再启动.`,
            },
          });
          return;
        }
      }
    }

    const pipelineIds: string[] = [];
    const errors: Array<{ slug: string; ep_id: string; reason: string }> = [];

    for (const { slug, ep_id } of series_episodes) {
      const pre = await preflightProviders(
        slug,
        opts.image_provider_id,
        opts.video_provider_id,
        skipVideoCheck,
        skipImageCheck,
      );
      if (!pre.ok) {
        const errBody = pre.body as { error?: { code?: string; message?: string } };
        errors.push({
          slug,
          ep_id,
          reason: errBody.error?.message ?? errBody.error?.code ?? "preflight_failed",
        });
        continue;
      }
      try {
        const record = startAutoPipeline(slug, ep_id, opts as AutoPipelineOptions);
        pipelineIds.push(record.pipeline_id);
      } catch (e) {
        errors.push({
          slug,
          ep_id,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    res.status(201).json({
      ok: true,
      pipeline_ids: pipelineIds,
      total_started: pipelineIds.length,
      total_requested: series_episodes.length,
      errors,
    });
  } catch (err) { next(err); }
});
