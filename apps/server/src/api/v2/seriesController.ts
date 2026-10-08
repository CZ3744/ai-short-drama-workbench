/**
 * v2 Series Controller — CRUD for series resource
 */

import { Router } from "express";
import { clientDisconnectSignal } from "../../middleware/clientDisconnectSignal";
import { handleValidationError } from "./validateHelpers";
import {
  listSeries, readSeries, createSeries, updateSeries, deleteSeries, duplicateSeries,
  cloneSampleFromDisk, listSamples,
  listEpisodes, applyTemplateSkeleton,
  stripGeneratedFallbackNote,
  // 2026-05-19 Wave O 致命遗留 2: 系列回收站 API
  listTrashedSeries, restoreTrashedSeries, permanentDeleteTrashedSeries,
  type SeriesData,
  type EpisodeData,
  type SeriesScriptVersion,
} from "./seriesStore";
import { validate, CreateSeriesSchema, PatchSeriesSchema } from "./validators";
// 2026-05-26 Codex P1-4 — 集卡 actual_shot_count 缺失 fallback 到 target_shot_count = LLM 拆镜目标值,
// 跟分镜板列表(走 listShots 真读)不一致. 走同一 enrich helper 保前后端数据同源.
import { enrichEpisodeWithStats } from "./episodeController";
import { scrubForClient } from "../../../../../packages/core/src/logger";
// 2026-06-01 backend-arch P2-1: mood-board 7 endpoint 拆到独立路由文件, 减少 seriesController 膨胀
import { moodBoardRouter } from "./moodBoardRoutes";
import {
  batchGenerateSeries,
  composeBatchPromptOnly,
  composeBatchPromptMultiOnly,
  BatchGenerateInputSchema,
  BatchGenerateMultiInputSchema,
  BatchMultiEnvelopeSchema,
  persistOneSeriesFromEnvelope,
} from "../../application/batchSeries/batchSeries";
import { sseBroker } from "./sseBroker";
import {
  extractElementsFromScript,
  previewExtractFromScriptPrompt,
} from "../../application/extractElementsFromScript/extractElementsFromScript";


export const seriesRouter = Router();

function firstEpisodeScript(episodes: EpisodeData[]): EpisodeData | undefined {
  return episodes.find((ep) => Boolean(ep.script_md || ep.script_path));
}

function buildSeriesScriptResponse(series: SeriesData, episodes: EpisodeData[]) {
  const fallbackEpisode = firstEpisodeScript(episodes);
  const scriptMd =
    stripGeneratedFallbackNote(series.script_md) ??
    stripGeneratedFallbackNote(fallbackEpisode?.script_md) ??
    "";

  return {
    script: {
      series_slug: series.slug,
      title: series.title,
      script_path: series.script_path ?? (series.script_md ? "script.md" : fallbackEpisode?.script_path),
      script_md: scriptMd,
      version: series.script_version ?? 0,
      versions: series.script_versions ?? [],
      updated_at: series.updated_at,
    },
    episodes,
  };
}

// GET /series
seriesRouter.get("/series", async (req, res, next) => {
  try {
    const includeInternalTestSeries = req.query.include_internal === "1" || req.query.include_internal === "true";
    const series = await listSeries({ includeInternalTestSeries });
    res.json({ series });
  } catch (err) { next(err); }
});

// POST /series
seriesRouter.post("/series", async (req, res, next) => {
  try {
    const v = validate(CreateSeriesSchema, req.body);
    if (handleValidationError(res, v)) return;
    const series = await createSeries({
      title: v.data.title,
      synopsis: v.data.synopsis,
      defaults: v.data.defaults,
      libraryCharacterIds: v.data.library_character_ids,
      librarySceneIds: v.data.library_scene_ids,
    });
    res.status(201).json({ series });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// 2026-05-19 反馈 #9: 批量 AI 生成系列 (一站式 LLM 生 N 集剧本+分镜)
// 必须放在 :slug 路由之前注册 — 否则 "batch-generate" 会被当 slug 吃掉
// ═══════════════════════════════════════════════════════════════════

// POST /series/batch-generate — 真调用 LLM 一站式生成系列
// 支持两种 body 形态:
//   - { projects: [{...}, {...}], global?: {...} } → 多项目模式 (2026-05-19 后续)
//   - { inspiration, episode_count, ... }          → 旧 single 模式 (向后兼容)
seriesRouter.post("/series/batch-generate", async (req, res, next) => {
  try {
    const result = await batchGenerateSeries(req.body ?? {}, {
      requestId: req.requestId,
    });
    if (result.kind === "validation") {
      res.status(result.status).json({
        error: { code: "invalid_request", message: "批量生成参数校验失败", details: result.errors },
      });
      return;
    }
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }
    // ok + ok-multi 都返 201
    res.status(201).json(result.body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: { code: "BatchGenerateFailed", message: scrubForClient(`批量生成失败: ${msg}`) },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2026-05-19 后续: 导入外部 AI 生成的多剧 JSON, 一键创建 N 部剧
//
// 用户原话: "点击导入外部 json 之后,提示我自己去创建项目,这是不好的,
//             我的意思是在这里导入系统自动解析传入的 json 就能直接帮我创建好
//             所有项目和里面的剧本、分集、分镜、素材、所需调用关系"
//
// 复用约束:
//   - schema 复用 BatchMultiEnvelopeSchema (同 LLM 输出契约)
//   - 落盘复用 persistOneSeriesFromEnvelope (跟 batch-generate 同份逻辑)
//   - 不调 LLM, 因此零成本; 没填 LLM key 也能用
// ═══════════════════════════════════════════════════════════════════
seriesRouter.post("/series/batch-import-multi", async (req, res, next) => {
  try {
    const startedAt = Date.now();

    // 1. zod 校验整体 envelope (projects 数组结构)
    const parsed = BatchMultiEnvelopeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "invalid_request",
          message:
            "JSON 格式不符合预期 — 期望: { projects: [{ series: {...}, episodes: [{ title, shots: [...] }] }, ...] }",
          details: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
      return;
    }

    // 2. 循环每个 project 复用落盘 helper (跟 LLM 真生成走同一份逻辑)
    const created: Array<{
      series_slug: string;
      series_title: string;
      episodes_created: number;
      total_shots: number;
      characters_created: number;
      scenes_created: number;
      pending_image_briefs: number;
    }> = [];

    for (let i = 0; i < parsed.data.projects.length; i++) {
      const envelope = parsed.data.projects[i];
      try {
        const result = await persistOneSeriesFromEnvelope(
          envelope,
          {}, // projectParams: 外部导入没用户参数, 全用 envelope.series.title + 默认 16:9/bilibili
          `[batch-import-multi] 外部 AI 生成 JSON 导入 · project #${i + 1}`,
          "external_import",
        );
        created.push({
          series_slug: result.series_slug,
          series_title: result.series_title,
          episodes_created: result.episodes_created,
          total_shots: result.total_shots,
          characters_created: result.characters_created,
          scenes_created: result.scenes_created,
          pending_image_briefs: result.pending_image_briefs,
        });
        sseBroker.broadcast("batch-series.done", {
          series_slug: result.series_slug,
          series_title: result.series_title,
          episodes_created: result.episodes_created,
          total_shots: result.total_shots,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // 一部失败不中止其余, 但记录错误
        created.push({
          series_slug: `__failed_${i}`,
          series_title: envelope.series.title + " (导入失败)",
          episodes_created: 0,
          total_shots: 0,
          characters_created: 0,
          scenes_created: 0,
          pending_image_briefs: 0,
        });
        // 继续循环
        // eslint-disable-next-line no-console
        console.warn(`[batch-import-multi] project #${i + 1} failed:`, msg);
      }
    }

    const success = created.filter((c) => !c.series_slug.startsWith("__failed_"));
    if (success.length === 0) {
      res.status(500).json({
        error: {
          code: "all_projects_failed",
          message: "所有项目落盘均失败 — 请检查 JSON 内容或磁盘权限",
        },
      });
      return;
    }

    res.status(201).json({
      ok: true,
      mode: "import-multi" as const,
      projects_created: success.length,
      projects_failed: created.length - success.length,
      total_episodes: success.reduce((n, c) => n + c.episodes_created, 0),
      total_shots: success.reduce((n, c) => n + c.total_shots, 0),
      total_characters: success.reduce((n, c) => n + c.characters_created, 0),
      total_scenes: success.reduce((n, c) => n + c.scenes_created, 0),
      total_pending_image_briefs: success.reduce((n, c) => n + c.pending_image_briefs, 0),
      series_slugs: success.map((c) => c.series_slug),
      series: created,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: {
        code: "BatchImportMultiFailed",
        message: scrubForClient(`批量导入失败: ${msg}`),
      },
    });
    next(err);
  }
});

// POST /series/batch-generate/preview-prompt — 零成本: 只返完整 prompt 给前端复制
// 支持 single + multi 两种 body schema, 自动 dispatch
seriesRouter.post("/series/batch-generate/preview-prompt", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    // multi 模式判定: body 有 projects 数组
    if (Array.isArray((body as { projects?: unknown }).projects)) {
      const parsedMulti = BatchGenerateMultiInputSchema.safeParse(body);
      if (!parsedMulti.success) {
        res.status(400).json({
          error: {
            code: "invalid_request",
            message: "preview-prompt (multi) 参数校验失败",
            details: parsedMulti.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        });
        return;
      }
      const result = composeBatchPromptMultiOnly(parsedMulti.data);
      res.json(result);
      return;
    }
    // single fallback (向后兼容)
    const parsed = BatchGenerateInputSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "invalid_request",
          message: "preview-prompt 参数校验失败",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    const result = composeBatchPromptOnly(parsed.data);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2026-05-19: 一键从剧本生成素材 (LLM 分析剧本输出 characters/scenes/props + image_briefs)
// ═══════════════════════════════════════════════════════════════════

// POST /series/:slug/extract-elements-from-script — 真调用 LLM 分析剧本 → 落盘素材
seriesRouter.post("/series/:slug/extract-elements-from-script", async (req, res, next) => {
  try {
    const result = await extractElementsFromScript(req.params.slug, req.body ?? {}, {
      requestId: req.requestId,
      // 2026-05-20 P1 铁律 #1: 透传 req.signal 让客户端断开能真 abort 元素抽取
      signal: clientDisconnectSignal(req, res),
    });
    if (result.kind === "validation") {
      res.status(result.status).json({
        error: { code: "invalid_request", message: "参数校验失败", details: result.errors },
      });
      return;
    }
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }
    res.status(201).json(result.body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: { code: "ExtractFromScriptFailed", message: scrubForClient(`从剧本生成素材失败: ${msg}`) },
    });
    next(err);
  }
});

// POST /series/:slug/extract-elements-from-script/preview-prompt — 零成本: 返完整 prompt 给前端复制
seriesRouter.post("/series/:slug/extract-elements-from-script/preview-prompt", async (req, res, next) => {
  try {
    const result = await previewExtractFromScriptPrompt(req.params.slug);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /series/:slug/apply-template — apply built-in template skeleton
seriesRouter.post("/series/:slug/apply-template", async (req, res, next) => {
  try {
    const { template_id, character_bindings, scene_bindings } = req.body;
    if (!template_id || typeof template_id !== "string") {
      res.status(400).json({ error: { code: "ValidationError", message: "缺少 template_id" } });
      return;
    }
    const result = await applyTemplateSkeleton(
      req.params.slug,
      template_id,
      character_bindings,
      scene_bindings,
    );
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// GET /series/:slug
seriesRouter.get("/series/:slug", async (req, res, next) => {
  try {
    const series = await readSeries(req.params.slug);
    if (!series) { res.status(404).json({ error: { code: "NotFound", message: "系列不存在" } }); return; }
    const episodes = await listEpisodes(req.params.slug);
    // 2026-05-26 Codex P1-4 — 走 enrichEpisodeWithStats 把 actual_shot_count / picked_video_count /
    // picked_video_total_duration_sec 注入,让集卡跟分镜板列表读同一真理源.
    const enriched = await Promise.all(
      episodes.map((ep) => enrichEpisodeWithStats(req.params.slug, ep)),
    );
    res.json({
      series: {
        ...series,
        episode_count: series.episodes.length,
        total_cost: 0,
      },
      episodes: enriched,
    });
  } catch (err) { next(err); }
});

// GET /series/:slug/script — series-level script, not bound to an episode
seriesRouter.get("/series/:slug/script", async (req, res, next) => {
  try {
    const series = await readSeries(req.params.slug);
    if (!series) { res.status(404).json({ error: { code: "NotFound", message: "系列不存在" } }); return; }
    const episodes = await listEpisodes(req.params.slug);
    res.json(buildSeriesScriptResponse(series, episodes));
  } catch (err) { next(err); }
});

// PATCH /series/:slug/script — autosave series-level script
seriesRouter.patch("/series/:slug/script", async (req, res, next) => {
  try {
    const series = await readSeries(req.params.slug);
    if (!series) { res.status(404).json({ error: { code: "NotFound", message: "系列不存在" } }); return; }

    const scriptMd = typeof req.body?.script_md === "string" ? req.body.script_md : "";
    if (scriptMd.length > 150_000) {
      res.status(400).json({ error: { code: "ValidationError", message: "剧本文本过长" } });
      return;
    }

    const nextVersion = (series.script_version ?? 0) + 1;
    const version: SeriesScriptVersion = {
      version: nextVersion,
      created_at: new Date().toISOString(),
      source: "user_edit",
      summary: "用户编辑系列剧本",
      script_md: scriptMd,
    };
    const versions = [...(series.script_versions ?? []), version].slice(-50);
    const updated = await updateSeries(req.params.slug, {
      script_path: "script.md",
      script_md: scriptMd,
      script_version: nextVersion,
      script_versions: versions,
    });
    if (!updated) { res.status(404).json({ error: { code: "NotFound", message: "系列不存在" } }); return; }

    const episodes = await listEpisodes(req.params.slug);
    res.json(buildSeriesScriptResponse(updated, episodes));
  } catch (err) { next(err); }
});

// PATCH /series/:slug
seriesRouter.patch("/series/:slug", async (req, res, next) => {
  try {
    const v = validate(PatchSeriesSchema, req.body);
    if (handleValidationError(res, v)) return;
    const series = await updateSeries(req.params.slug, v.data);
    if (!series) { res.status(404).json({ error: { code: "NotFound", message: "系列不存在" } }); return; }
    res.json({ series });
  } catch (err) { next(err); }
});

// 2026-05-21 — 系列封面生成 (首页 StudioHome 卡片显示用)
// Read-only preview uses the same compiler and inputs as generation.
seriesRouter.post("/series/:slug/generate-cover/preview", async (req, res, next) => {
  try {
    const { generateSeriesCover } = await import("../../application/series/generateSeriesCover");
    const result = await generateSeriesCover({ slug: req.params.slug, body: req.body }, { preview: true });
    if (result.kind === "error") { res.status(result.status).json(result.body); return; }
    if (result.kind === "validation") {
      res.status(result.status).json({ error: { code: "ValidationError", message: "参数校验失败", details: result.errors } });
      return;
    }
    res.json(result.body);
  } catch (err) { next(err); }
});

// POST /series/:slug/generate-cover { provider_id?, style?, title_text? }
seriesRouter.post("/series/:slug/generate-cover", async (req, res, next) => {
  try {
    const { generateSeriesCover } = await import("../../application/series/generateSeriesCover");
    const result = await generateSeriesCover({
      slug: req.params.slug,
      body: req.body,
    }, { requestId: req.requestId });
    if (result.kind === "error") { res.status(result.status).json(result.body); return; }
    if (result.kind === "validation") {
      res.status(result.status).json({ error: { code: "ValidationError", message: "参数校验失败", details: result.errors } });
      return;
    }
    res.json(result.body);
  } catch (err) { next(err); }
});

// DELETE /series/:slug (soft delete)
seriesRouter.delete("/series/:slug", async (req, res, next) => {
  try {
    const ok = await deleteSeries(req.params.slug);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "系列不存在" } }); return; }
    res.json({ ok: true, message: "系列已移至回收站" });
  } catch (err) { next(err); }
});

// 2026-05-19 Wave O 致命遗留 2: 系列回收站 UI 后端 API
// GET /series-trash — 列出 _trash 里所有被删系列
seriesRouter.get("/series-trash", async (_req, res, next) => {
  try {
    const records = await listTrashedSeries();
    res.json({ ok: true, records });
  } catch (err) { next(err); }
});

// POST /series-trash/:trashId/restore — 恢复系列
seriesRouter.post("/series-trash/:trashId/restore", async (req, res, next) => {
  try {
    const result = await restoreTrashedSeries(req.params.trashId);
    if (!result) {
      res.status(404).json({ error: { code: "NotFound", message: "回收站记录不存在或已过期" } });
      return;
    }
    res.json({ ok: true, slug: result.slug, message: `系列已恢复` });
  } catch (err) { next(err); }
});

// DELETE /series-trash/:trashId — 永久删除 (不可恢复)
seriesRouter.delete("/series-trash/:trashId", async (req, res, next) => {
  try {
    const ok = await permanentDeleteTrashedSeries(req.params.trashId);
    if (!ok) {
      res.status(404).json({ error: { code: "NotFound", message: "回收站记录不存在" } });
      return;
    }
    res.json({ ok: true, message: "已永久删除" });
  } catch (err) { next(err); }
});

// POST /series/:slug/duplicate
seriesRouter.post("/series/:slug/duplicate", async (req, res, next) => {
  try {
    const series = await duplicateSeries(req.params.slug);
    if (!series) { res.status(404).json({ error: { code: "NotFound", message: "源系列不存在" } }); return; }
    res.status(201).json({ series });
  } catch (err) { next(err); }
});

// GET /series/samples — list available samples
seriesRouter.get("/series/samples", async (_req, res, next) => {
  try {
    const samples = await listSamples();
    res.json({ samples });
  } catch (err) { next(err); }
});

// POST /series/clone-sample — clone a sample into a new series
seriesRouter.post("/series/clone-sample", async (req, res, next) => {
  try {
    const { sample_id } = req.body;
    if (!sample_id || typeof sample_id !== "string") {
      res.status(400).json({ error: { code: "ValidationError", message: "缺少 sample_id" } });
      return;
    }
    const series = await cloneSampleFromDisk(sample_id);
    if (!series) {
      res.status(404).json({ error: { code: "NotFound", message: `示例 "${sample_id}" 不存在` } });
      return;
    }
    res.status(201).json({ series });
  } catch (err) { next(err); }
});

// ─── Style Mood Board ─── delegated to moodBoardRoutes.ts ────────
seriesRouter.use(moodBoardRouter);
