/**
 * v2 Versions Controller — W6-B 多版本管理（剧本 + 分镜）
 *
 * 解决用户痛点 #11：每次生成新剧本/分镜都新增一个版本，旧版本仍可访问、可激活、可软删。
 *
 * Endpoints (8 total):
 *   Script versions (scope = series)
 *     GET    /series/:slug/script-versions
 *     POST   /series/:slug/script-versions
 *     POST   /series/:slug/script-versions/:vid/activate
 *     DELETE /series/:slug/script-versions/:vid
 *   Storyboard versions (scope = episode)
 *     GET    /series/:slug/episodes/:epId/storyboard-versions
 *     POST   /series/:slug/episodes/:epId/storyboard-versions
 *     POST   /series/:slug/episodes/:epId/storyboard-versions/:vid/activate
 *     DELETE /series/:slug/episodes/:epId/storyboard-versions/:vid
 *
 * 注意：
 *   - POST /script-versions 默认只是"快照已有的 series.script_md"，并不会自动调 LLM。
 *     若 body.run_expand=true，则前端期望走 expand-script 端点（这里不直接代理，避免循环依赖）。
 *   - DELETE 是软删（写 _deleted=true）。如果删的是 active，自动激活剩余最新一条。
 */

import { Router } from "express";
import { z } from "zod";

import { readSeries, listShots, listEpisodes } from "./seriesStore";
import { validate } from "./validators";
import {
  listScriptVersions,
  readScriptVersion,
  createScriptVersion,
  activateScriptVersion,
  softDeleteScriptVersion,
  scriptVersionsDir,
} from "../../repositories/scriptVersionsRepo";
import {
  listStoryboardVersions,
  createStoryboardVersion,
  activateStoryboardVersion,
  softDeleteStoryboardVersion,
  storyboardVersionsDir,
} from "../../repositories/storyboardVersionsRepo";
import { readEpisode, updateSeries } from "./seriesStore";
import { listSeries } from "../../repositories/seriesRepo";
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, pathExists } from "../../../../../packages/core/src/index";

export const versionsRouter = Router();

// ─── Schemas ─────────────────────────────────────────────────────────

const CreateScriptVersionBodySchema = z.object({
  title: z.string().max(120).optional(),
  /** 当 content_md 缺省时，可选传入 use_current=true，取 series.script_md 作为快照 */
  content_md: z.string().max(150_000).optional(),
  source_inspirations: z.array(z.string().max(200)).max(50).optional(),
  user_prompt: z.string().max(5000).optional(),
  parent_version_id: z.string().max(120).optional(),
  activate: z.boolean().optional(),
});

const CreateStoryboardVersionBodySchema = z.object({
  name: z.string().max(120).optional(),
  script_version_id: z.string().max(120).optional(),
  /** 不传 shot_ids 时，从当前 episode 实际 shot 文件列表快照 */
  shot_ids: z.array(z.string().max(120)).max(500).optional(),
  activate: z.boolean().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────

async function ensureSeries(slug: string, res: any): Promise<boolean> {
  const s = await readSeries(slug);
  if (!s) {
    res.status(404).json({ error: { code: "NotFound", message: "系列不存在" } });
    return false;
  }
  return true;
}

async function ensureEpisode(slug: string, epId: string, res: any): Promise<boolean> {
  if (!(await ensureSeries(slug, res))) return false;
  const ep = await readEpisode(slug, epId);
  if (!ep) {
    res.status(404).json({ error: { code: "NotFound", message: "集不存在" } });
    return false;
  }
  return true;
}

// ─── Script Versions (series-scope) ──────────────────────────────────

// GET /series/:slug/script-versions
versionsRouter.get("/series/:slug/script-versions", async (req, res, next) => {
  try {
    if (!(await ensureSeries(req.params.slug, res))) return;
    const versions = await listScriptVersions(req.params.slug);
    res.json({ versions });
  } catch (err) {
    next(err);
  }
});

// POST /series/:slug/script-versions  — 显式新建（手动快照或 fork）
versionsRouter.post("/series/:slug/script-versions", async (req, res, next) => {
  try {
    if (!(await ensureSeries(req.params.slug, res))) return;
    const v = validate(CreateScriptVersionBodySchema, req.body);
    if (!v.ok) {
      res.status(v.status).json({ error: { code: "ValidationError", message: "参数无效", details: v.errors } });
      return;
    }

    let contentMd = v.data.content_md;
    if (!contentMd) {
      // 缺省时取当前 series.script_md 作为快照
      const series = await readSeries(req.params.slug);
      contentMd = series?.script_md ?? "";
    }
    if (!contentMd.trim()) {
      res.status(400).json({
        error: { code: "ValidationError", message: "content_md 为空且当前 series 没有可快照的剧本" },
      });
      return;
    }

    const created = await createScriptVersion({
      series_slug: req.params.slug,
      title: v.data.title,
      content_md: contentMd,
      source_inspirations: v.data.source_inspirations ?? [],
      user_prompt: v.data.user_prompt,
      parent_version_id: v.data.parent_version_id,
      activate: v.data.activate ?? true,
    });

    // 同步刷 series.script_md 镜像
    if (created.is_active) {
      await updateSeries(req.params.slug, { script_md: contentMd, script_path: "script.md" });
    }
    res.status(201).json({ version: created });
  } catch (err) {
    next(err);
  }
});

// POST /series/:slug/script-versions/:vid/activate
versionsRouter.post("/series/:slug/script-versions/:vid/activate", async (req, res, next) => {
  try {
    if (!(await ensureSeries(req.params.slug, res))) return;
    const target = await readScriptVersion(req.params.slug, req.params.vid);
    if (!target) {
      res.status(404).json({ error: { code: "NotFound", message: "剧本版本不存在" } });
      return;
    }
    const updated = await activateScriptVersion(req.params.slug, req.params.vid);
    // 同步刷 series.script_md 镜像（旧前端兼容）
    if (updated) {
      await updateSeries(req.params.slug, { script_md: updated.content_md, script_path: "script.md" });
    }
    res.json({ version: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /series/:slug/script-versions/:vid (soft delete)
versionsRouter.delete("/series/:slug/script-versions/:vid", async (req, res, next) => {
  try {
    if (!(await ensureSeries(req.params.slug, res))) return;
    const ok = await softDeleteScriptVersion(req.params.slug, req.params.vid);
    if (!ok) {
      res.status(404).json({ error: { code: "NotFound", message: "剧本版本不存在或已删除" } });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Storyboard Versions (episode-scope) ─────────────────────────────

// GET /series/:slug/episodes/:epId/storyboard-versions
versionsRouter.get("/series/:slug/episodes/:epId/storyboard-versions", async (req, res, next) => {
  try {
    if (!(await ensureEpisode(req.params.slug, req.params.epId, res))) return;
    const versions = await listStoryboardVersions(req.params.slug, req.params.epId);
    res.json({ versions });
  } catch (err) {
    next(err);
  }
});

// POST /series/:slug/episodes/:epId/storyboard-versions — 显式新建（快照）
versionsRouter.post("/series/:slug/episodes/:epId/storyboard-versions", async (req, res, next) => {
  try {
    if (!(await ensureEpisode(req.params.slug, req.params.epId, res))) return;
    const v = validate(CreateStoryboardVersionBodySchema, req.body);
    if (!v.ok) {
      res.status(v.status).json({ error: { code: "ValidationError", message: "参数无效", details: v.errors } });
      return;
    }

    let shotIds = v.data.shot_ids;
    if (!shotIds) {
      // 缺省时从当前 episode 的 shot 文件列表快照
      const shots = await listShots(req.params.slug, req.params.epId);
      shotIds = shots.sort((a, b) => a.index - b.index).map((s) => s.id);
    }

    const created = await createStoryboardVersion({
      series_slug: req.params.slug,
      episode_id: req.params.epId,
      name: v.data.name,
      script_version_id: v.data.script_version_id ?? "legacy",
      shot_ids: shotIds,
      activate: v.data.activate ?? true,
    });
    res.status(201).json({ version: created });
  } catch (err) {
    next(err);
  }
});

// POST .../storyboard-versions/:vid/activate
// 2026-07-22 X6-1 (A3-3): activate 现在**真搬分镜** —— 当前现行镜整套进垃圾桶(带批次标记, 可再切回),
// 目标版本 shots 从垃圾桶原子搬回。失败(快照缺失/冲突)返 409, 不改动当前分镜。
versionsRouter.post(
  "/series/:slug/episodes/:epId/storyboard-versions/:vid/activate",
  async (req, res, next) => {
    try {
      if (!(await ensureEpisode(req.params.slug, req.params.epId, res))) return;
      const outcome = await activateStoryboardVersion(req.params.slug, req.params.epId, req.params.vid);
      if (!outcome.ok) {
        const status = outcome.reason === "not_found" ? 404 : 409;
        const code =
          outcome.reason === "not_found" ? "NotFound"
          : outcome.reason === "conflict" ? "StoryboardRestoreConflict"
          : "StoryboardSnapshotMissing";
        res.status(status).json({ error: { code, message: outcome.message } });
        return;
      }
      res.json({ version: outcome.version });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE .../storyboard-versions/:vid (soft delete)
versionsRouter.delete(
  "/series/:slug/episodes/:epId/storyboard-versions/:vid",
  async (req, res, next) => {
    try {
      if (!(await ensureEpisode(req.params.slug, req.params.epId, res))) return;
      const ok = await softDeleteStoryboardVersion(req.params.slug, req.params.epId, req.params.vid);
      if (!ok) {
        res.status(404).json({ error: { code: "NotFound", message: "分镜版本不存在或已删除" } });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ─── W-3.4: 180 天过期版本自动清理 ─────────────────────────────────

const EXPIRY_DAYS = 180;
const EXPIRY_MS = EXPIRY_DAYS * 24 * 60 * 60 * 1000;

/** 扫描并永久删除超过 180 天软删的剧本/分镜版本 */
export async function cleanupExpiredVersions(): Promise<{
  scriptCleaned: number;
  storyboardCleaned: number;
}> {
  let scriptCleaned = 0;
  let storyboardCleaned = 0;
  const cutoff = Date.now() - EXPIRY_MS;

  try {
    const allSeries = await listSeries({});
    for (const s of allSeries) {
      const slug = s.slug;

      // ── Script versions ────────────────────────────────────
      const scriptVd = scriptVersionsDir(slug);
      if (await pathExists(scriptVd)) {
        const entries = await fs.readdir(scriptVd);
        for (const entry of entries) {
          if (!entry.endsWith(".json") || entry === "_index.json") continue;
          const fp = path.join(scriptVd, entry);
          try {
            const v = await readJson<{ _deleted?: boolean; _deleted_at?: string }>(fp);
            if (v?._deleted && v._deleted_at) {
              const deletedMs = new Date(v._deleted_at).getTime();
              if (!isNaN(deletedMs) && deletedMs < cutoff) {
                await fs.unlink(fp);
                scriptCleaned++;
              }
            }
          } catch { /* skip corrupted */ }
        }
      }

      // ── Storyboard versions per episode ────────────────────
      const eps = await listEpisodes(slug);
      for (const ep of eps) {
        const storyVd = storyboardVersionsDir(slug, ep.id);
        if (!(await pathExists(storyVd))) continue;
        const entries = await fs.readdir(storyVd);
        for (const entry of entries) {
          if (!entry.endsWith(".json") || entry === "_index.json") continue;
          const fp = path.join(storyVd, entry);
          try {
            const v = await readJson<{ _deleted?: boolean; _deleted_at?: string }>(fp);
            if (v?._deleted && v._deleted_at) {
              const deletedMs = new Date(v._deleted_at).getTime();
              if (!isNaN(deletedMs) && deletedMs < cutoff) {
                await fs.unlink(fp);
                storyboardCleaned++;
              }
            }
          } catch { /* skip corrupted */ }
        }
      }
    }
  } catch (err) {
    // 清理失败不抛错 — 静默返回,下轮再试
    console.warn("[cleanupExpiredVersions] 清理失败:", err);
  }

  if (scriptCleaned > 0 || storyboardCleaned > 0) {
    console.log(`[cleanupExpiredVersions] 剧本 ${scriptCleaned} + 分镜 ${storyboardCleaned} 个过期版本已永久删除`);
  }
  return { scriptCleaned, storyboardCleaned };
}
