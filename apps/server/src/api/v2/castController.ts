/**
 * castController — Cast/IP 容器与跨系列 element 共享 REST API (W4 2026-05-26).
 *
 * 设计见 packages/drama/src/types.ts §Cast 与 application/cast/effectiveElements.ts.
 *
 * 端点矩阵:
 *   /api/v2/casts                        — list / create cast
 *   /api/v2/casts/:castId                — read / patch / delete cast (软删)
 *   /api/v2/casts/:castId/elements                       — list / create cast member
 *   /api/v2/casts/:castId/elements/:elementId            — read / patch cast member
 *   /api/v2/casts/:castId/elements/:elementId/images     — add image
 *   /api/v2/casts/:castId/elements/:elementId/images/:imgId — patch / delete image
 *   /api/v2/casts/:castId/elements/promote-from-series   — 把 series-local element 升级到 cast
 *   /api/v2/series/:slug/effective-elements              — series 视角合并视图
 *   /api/v2/series/:slug/cast                            — PATCH 挂入/取消挂 cast
 *
 * 设计原则 (UX 铁律):
 *   - #1 用户控制权: promote-from-series 默认不删源 (返回提示让用户后续在 series 视图看到"已晋升 cast X")
 *   - #2 可干预: GET /effective-elements 给 _source 字段, 前端可显示来源徽章
 *   - #6 数据保留: deleteCast 软删, 不真擦盘; series.cast_id 引用反查后给 warning
 *   - #9 toC 兜底: 错误消息用 cast name / element name 翻译, 不暴露技术 id
 */

import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import {
  listCasts,
  readCast,
  createCast,
  updateCast,
  deleteCast,
  listDeletedCasts,
  restoreCast,
  listCastElements,
  readCastElement,
  addCastMemberElement,
  updateCastElement,
  addCastElementImage,
  patchCastElementImageMeta,
  removeCastElementImage,
  removeCastMemberElement,
  setCastMemberVoice,
  removeCastMemberVoice,
  castDir,
} from "../../repositories/castRepo";
import {
  listSeries,
  readSeries,
  updateSeries,
} from "../../repositories/seriesRepo";
import { listEpisodes } from "../../repositories/episodeRepo";
import { listShots } from "../../repositories/shotRepo";
import {
  readElement,
  type ElementData,
  type ElementImage,
  type ElementKind,
  type ImageBrief,
} from "../../repositories/elementRepo";
import { readAsset, resolveAssetFilePath } from "../../repositories/assetRepo";
import { DATA_ROOT, ensureDir, pathExists } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import {
  saveToVault,
  getVaultEntry,
  getVaultAbsolutePath,
} from "../../../../../packages/library/src/assetVault";
import { getEffectiveElementsForSeries, normalizeSeriesCastIds } from "../../application/cast/effectiveElements";

export const castRouter = Router();

// ─── Voice clone sample upload (W6 2026-05-26) ─────────────────────────
// cast 层 voice 样本: data/casts/<castId>/assets/voices/<sha10>_<basename>.<ext>
// 跨 series 共享 — 一次配置, 所有挂本 cast 的剧统一用. 与 character-level voice-clone-sample
// 端点 (series/<slug>/assets/voices) 并存, cast-level 优先级更高 (见 tts.ts resolveEffectiveVoiceForCharacter).
const CAST_VOICE_MIME_WHITELIST = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/wave", "audio/x-wav",
  "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac",
  "audio/webm", "audio/ogg", "audio/x-ogg",
  "application/octet-stream",
]);
const CAST_VOICE_EXT_WHITELIST = new Set([".mp3", ".wav", ".m4a", ".aac", ".webm", ".ogg"]);
const castVoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (CAST_VOICE_MIME_WHITELIST.has(file.mimetype) || CAST_VOICE_EXT_WHITELIST.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的语音样本格式: ${file.mimetype} (${file.originalname})`));
    }
  },
});

function castVoicesDir(castId: string): string {
  return path.join(castDir(castId), "assets", "voices");
}

// ─── 共享 helpers ─────────────────────────────────────────────────────

const ALL_KINDS: ElementKind[] = [
  "character",
  "scene",
  "prop",
  "wardrobe",
  "reference",
  "misc",
];

function err(
  res: Parameters<typeof castRouter.use>[0] extends never ? never : any,
  status: number,
  code: string,
  message: string,
) {
  res.status(status).json({ error: { code, message } });
}

/** 计算"哪些系列引用了这个 cast" — UI 给 cast 列表展示引用数, 删 cast 时也用. */
async function countSeriesReferencingCast(castId: string): Promise<number> {
  const all = await listSeries({ includeInternalTestSeries: false }).catch(() => []);
  let count = 0;
  for (const item of all) {
    const s = await readSeries(item.slug).catch(() => null);
    const ids = normalizeSeriesCastIds(s);
    if (ids.includes(castId)) count += 1;
  }
  return count;
}

// ─── /api/v2/casts ──────────────────────────────────────────────────

/** GET /casts — 列全部 cast (含 series 引用数). */
castRouter.get("/casts", async (_req, res, next) => {
  try {
    const casts = await listCasts();
    const enriched = await Promise.all(
      casts.map(async (c) => {
        const referencingSeriesCount = await countSeriesReferencingCast(c.id);
        return { ...c, referencing_series_count: referencingSeriesCount };
      }),
    );
    res.json({ casts: enriched });
  } catch (e) {
    next(e);
  }
});

/** POST /casts — 建 cast. */
castRouter.post("/casts", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return err(res, 400, "ValidationError", "name 必填");
    const description = typeof body.description === "string" ? body.description : undefined;
    const cast = await createCast({ name, description });
    res.status(201).json({ cast });
  } catch (e) {
    next(e);
  }
});

/** GET /casts/deleted — 列全部已软删的 cast (回收站). 必须在 /casts/:castId 之前注册. */
castRouter.get("/casts/deleted", async (_req, res, next) => {
  try {
    const casts = await listDeletedCasts();
    const enriched = await Promise.all(
      casts.map(async (c) => {
        const referencingSeriesCount = await countSeriesReferencingCast(c.id);
        return { ...c, referencing_series_count: referencingSeriesCount };
      }),
    );
    res.json({ casts: enriched });
  } catch (e) {
    next(e);
  }
});

/** GET /casts/:castId. */
castRouter.get("/casts/:castId", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const cast = await readCast(castId);
    if (!cast) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);
    const referencingSeriesCount = await countSeriesReferencingCast(castId);
    res.json({ cast: { ...cast, referencing_series_count: referencingSeriesCount } });
  } catch (e) {
    next(e);
  }
});

/** PATCH /casts/:castId — 改 name / description. */
castRouter.patch("/casts/:castId", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const body = req.body ?? {};
    const patch: { name?: string; description?: string } = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    const cast = await updateCast(castId, patch);
    if (!cast) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);
    res.json({ cast });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /casts/:castId — 软删 cast.
 * 不阻塞 series 引用 — 引用的 series 会自动降级走 local-only (effectiveElements 容错).
 * 返 warning 告诉用户 N 个 series 受影响.
 */
castRouter.delete("/casts/:castId", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const cast = await readCast(castId);
    if (!cast) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);
    const refCount = await countSeriesReferencingCast(castId);
    const ok = await deleteCast(castId);
    if (!ok) return err(res, 500, "DeleteFailed", "删除失败");
    const warnings: string[] = [];
    if (refCount > 0) {
      warnings.push(
        `IP 容器「${cast.name}」当前被 ${refCount} 部系列引用, 删除后这些系列将看不到来自此容器的素材, 但仍保留各自的本剧专属素材.`,
      );
    }
    res.json({ ok: true, warnings: warnings.length ? warnings : undefined });
  } catch (e) {
    next(e);
  }
});

/** POST /casts/:castId/restore — 恢复已软删的 cast. */
castRouter.post("/casts/:castId/restore", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const cast = await restoreCast(castId);
    if (!cast) return err(res, 404, "NotFound", `找不到已删除的素材组 ${castId}`);
    const referencingSeriesCount = await countSeriesReferencingCast(castId);
    res.json({ cast: { ...cast, referencing_series_count: referencingSeriesCount } });
  } catch (e) {
    next(e);
  }
});

// ─── /api/v2/casts/:castId/elements ──────────────────────────────────

/** GET /casts/:castId/elements?kind= — 列 cast members. */
castRouter.get("/casts/:castId/elements", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    if (!(await readCast(castId))) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);
    const kindParam = typeof req.query.kind === "string" ? req.query.kind : "";
    const kind = ALL_KINDS.includes(kindParam as ElementKind)
      ? (kindParam as ElementKind)
      : undefined;
    const elements = await listCastElements(castId, kind ? { kind } : undefined);
    res.json({ elements });
  } catch (e) {
    next(e);
  }
});

/** POST /casts/:castId/elements — 在 cast 直接建 element. */
castRouter.post("/casts/:castId/elements", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    if (!(await readCast(castId))) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);

    const body = req.body ?? {};
    const kind = String(body.kind || "");
    if (!ALL_KINDS.includes(kind as ElementKind)) {
      return err(res, 400, "ValidationError", `kind 必须是 ${ALL_KINDS.join("|")}`);
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
      return err(res, 400, "ValidationError", "name 必填");
    }
    const created = await addCastMemberElement(castId, {
      kind: kind as ElementKind,
      name: String(body.name).trim(),
      description: typeof body.description === "string" ? body.description : "",
      tags: Array.isArray(body.tags) ? body.tags : [],
      attrs: body.attrs && typeof body.attrs === "object" ? body.attrs : {},
      image_briefs: Array.isArray(body.image_briefs)
        ? (body.image_briefs as ImageBrief[])
        : undefined,
    });
    res.status(201).json({ element: created });
  } catch (e) {
    next(e);
  }
});

/** GET /casts/:castId/elements/:elementId. */
castRouter.get("/casts/:castId/elements/:elementId", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const elementId = String(req.params.elementId);
    const el = await readCastElement(castId, elementId);
    if (!el) return err(res, 404, "NotFound", `剧组 ${castId} 里找不到素材 ${elementId}`);
    res.json({ element: el });
  } catch (e) {
    next(e);
  }
});

/** PATCH /casts/:castId/elements/:elementId. */
castRouter.patch("/casts/:castId/elements/:elementId", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const elementId = String(req.params.elementId);
    const body = req.body ?? {};
    const patch: Partial<ElementData> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    if (Array.isArray(body.tags)) patch.tags = body.tags;
    if (body.attrs && typeof body.attrs === "object") patch.attrs = body.attrs;
    if (Array.isArray(body.image_briefs)) {
      patch.image_briefs = body.image_briefs as ImageBrief[];
    }
    const el = await updateCastElement(castId, elementId, patch);
    if (!el) return err(res, 404, "NotFound", `剧组 ${castId} 里找不到素材 ${elementId}`);
    res.json({ element: el });
  } catch (e) {
    next(e);
  }
});

// ─── Cast Element Image 端点 ──────────────────────────────────────────

/**
 * POST /casts/:castId/elements/:elementId/images
 * body: ElementImage 的字段子集 (origin / prompt_snapshot / vault_id / asset_id / url / mime / note / display_name ...)
 *
 * 简化模型: body 直接对应 ElementImage 字段 (跟 addElementImage 同套路).
 * 没做 vault dedup 逻辑 — caller 负责传 vault_id (已经在 vault 里的图) 或 asset_id.
 */
castRouter.post("/casts/:castId/elements/:elementId/images", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const elementId = String(req.params.elementId);
    const body = req.body ?? {};
    if (!body.origin) return err(res, 400, "ValidationError", "origin 必填");

    const result = await addCastElementImage(castId, elementId, body as Omit<
      ElementImage,
      "image_id" | "created_at"
    > & Partial<Pick<ElementImage, "image_id" | "created_at">>);
    if (!result) return err(res, 404, "NotFound", `剧组 ${castId} 里找不到素材 ${elementId}`);
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

/** PATCH /casts/:castId/elements/:elementId/images/:imgId — 改 image meta (display_name / available_for_shot / is_typical / image_tags). */
castRouter.patch("/casts/:castId/elements/:elementId/images/:imgId", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const elementId = String(req.params.elementId);
    const imgId = String(req.params.imgId);
    const body = req.body ?? {};
    const patch: Parameters<typeof patchCastElementImageMeta>[3] = {};
    if (typeof body.display_name === "string") patch.display_name = body.display_name;
    if (typeof body.available_for_shot === "boolean") patch.available_for_shot = body.available_for_shot;
    if (typeof body.is_typical === "boolean") patch.is_typical = body.is_typical;
    if (Array.isArray(body.image_tags)) patch.image_tags = body.image_tags;
    const el = await patchCastElementImageMeta(castId, elementId, imgId, patch);
    if (!el) return err(res, 404, "NotFound", "素材或图片不存在");
    res.json({ element: el });
  } catch (e) {
    next(e);
  }
});

/** DELETE /casts/:castId/elements/:elementId/images/:imgId. */
castRouter.delete("/casts/:castId/elements/:elementId/images/:imgId", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const elementId = String(req.params.elementId);
    const imgId = String(req.params.imgId);
    const el = await removeCastElementImage(castId, elementId, imgId);
    if (!el) return err(res, 404, "NotFound", "素材或图片不存在");
    res.json({ element: el });
  } catch (e) {
    next(e);
  }
});

// ─── promote-from-series ─────────────────────────────────────────────

/**
 * POST /casts/:castId/elements/promote-from-series
 * body: { from_slug, element_id, name_override? }
 *
 * 把 series-local element 升级到 cast (主拷贝迁到 data/casts/<cast>/elements/).
 * 复用 import.ts 套路: vault dedup + asset 复制, 不删源 (用户可选后续手动清理).
 *
 * 决策: 默认不删源 — 用户原话 (作风对齐 #6 数据保留 > 直接删除):
 *   "我先试试效果, 不行再撤回" → 删源会让"撤回"困难, 保留源是 UX 更安全的默认.
 *   未来加 ?delete_source=true 参数显式删源.
 */
castRouter.post("/casts/:castId/elements/promote-from-series", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const cast = await readCast(castId);
    if (!cast) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);

    const body = req.body ?? {};
    const fromSlug = String(body.from_slug || "").trim();
    const fromElementId = String(body.element_id || "").trim();
    const nameOverride = typeof body.name_override === "string" && body.name_override.trim()
      ? body.name_override.trim()
      : undefined;

    if (!fromSlug) return err(res, 400, "ValidationError", "from_slug 必填");
    if (!fromElementId) return err(res, 400, "ValidationError", "element_id 必填");
    if (!(await readSeries(fromSlug))) {
      return err(res, 404, "NotFound", `来源系列 ${fromSlug} 不存在`);
    }

    // 仅支持升级 elementRepo 4 kind (prop/wardrobe/reference/misc).
    // character/scene 的 promote 走另一条路径 (后续 W5 前端加, 复杂度高 — 涉及 ref_image_meta 迁移).
    const source = await readElement(fromSlug, fromElementId);
    if (!source) {
      return err(
        res,
        404,
        "NotFound",
        `来源素材 ${fromElementId} 不存在 (注: 当前仅支持 prop/wardrobe/reference/misc 4 类升级, character/scene 暂走本剧专属)`,
      );
    }

    const targetName = nameOverride ?? source.name;

    // 在 cast 建 element 外壳 (保留源 id, 便于 series 现有引用透明指向 cast member)
    let createdElement: ElementData;
    try {
      createdElement = await addCastMemberElement(castId, {
        kind: source.kind,
        name: targetName,
        description: source.description,
        tags: source.tags,
        attrs: source.attrs ?? {},
        derived_from: { series_slug: fromSlug, element_id: fromElementId },
        image_briefs: source.image_briefs ? source.image_briefs.map((b) => ({ ...b })) : undefined,
        id: source.id, // 复用源 id, 让 series 现有引用透明指向 cast
      });
    } catch (e) {
      // id 撞了 → fallback 走自动 id
      createdElement = await addCastMemberElement(castId, {
        kind: source.kind,
        name: targetName,
        description: source.description,
        tags: source.tags,
        attrs: source.attrs ?? {},
        derived_from: { series_slug: fromSlug, element_id: fromElementId },
        image_briefs: source.image_briefs ? source.image_briefs.map((b) => ({ ...b })) : undefined,
      });
    }

    // 复制 images 到 cast (复用 import.ts 的 vault dedup + asset 复制套路, 但 asset
    // 写在 data/series/<source_slug>/assets 不动 — cast member 直接引用 vault_id 即可).
    let copiedCount = 0;
    const importErrors: string[] = [];
    for (const srcImg of source.images) {
      try {
        let buf: Buffer | null = null;
        let mime = srcImg.mime || "image/png";
        if (srcImg.vault_id) {
          const entry = await getVaultEntry(srcImg.vault_id);
          if (entry) {
            buf = await fs.readFile(getVaultAbsolutePath(entry));
            mime = entry.mime || mime;
          }
        }
        if (!buf && srcImg.asset_id) {
          const asset = await readAsset(fromSlug, srcImg.asset_id);
          const abs = asset ? resolveAssetFilePath(fromSlug, asset.path) : null;
          if (abs) {
            buf = await fs.readFile(abs);
            mime = asset?.mime || mime;
          }
        }
        if (!buf) {
          importErrors.push(`image ${srcImg.image_id}: 无法读取源图`);
          continue;
        }

        // 写 vault (SHA-256 dedup 内置, 命中已有 entry 直接返)
        const vaultEntry = await saveToVault({
          buffer: buf,
          kind: "image",
          mime,
          context: {
            kind: "variant",
            series_slug: fromSlug,
            user_note: `cast:${cast.name}:${createdElement.name}`,
          },
          provider_id: srcImg.provider_id ?? "cast_promote",
          tags: [
            `cast:${castId}`,
            `cast_element:${createdElement.id}`,
            "promoted_to_cast",
          ],
        });

        // 在 cast member 加 image (使用源 image_id 让 series 现有引用透明)
        const added = await addCastElementImage(castId, createdElement.id, {
          image_id: srcImg.image_id,
          vault_id: vaultEntry.vault_id,
          asset_id: undefined, // cast member 不绑 series asset
          origin: srcImg.origin,
          prompt_snapshot: srcImg.prompt_snapshot,
          provider_id: srcImg.provider_id,
          seed: srcImg.seed,
          url: `/api/v2/vault/${vaultEntry.vault_id}/raw`,
          mime,
          display_name: srcImg.display_name,
          note: srcImg.note ?? "从系列升级到 IP 容器",
          available_for_shot: srcImg.available_for_shot,
          is_typical: srcImg.is_typical,
          based_on_image_id: srcImg.based_on_image_id,
          image_tags: srcImg.image_tags,
          created_at: srcImg.created_at,
        });
        if (added) {
          copiedCount += 1;
          createdElement = added.element;
        }
      } catch (imgErr) {
        importErrors.push(
          `image ${srcImg.image_id}: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`,
        );
      }
    }

    // 复制 primary_image_id
    if (source.primary_image_id) {
      const matched = createdElement.images.find((im) => im.image_id === source.primary_image_id);
      if (matched) {
        const updated = await updateCastElement(castId, createdElement.id, {
          primary_image_id: source.primary_image_id,
        });
        if (updated) createdElement = updated;
      }
    }

    res.status(201).json({
      ok: true,
      element: createdElement,
      copied_images: copiedCount,
      total_images: source.images.length,
      errors: importErrors.length ? importErrors : undefined,
      source_series: fromSlug,
      source_element_id: fromElementId,
      // UX: 提示用户源未删, 可选去 series 视图手动清理
      hint:
        "源系列的本剧专属素材未被删除. 如确认 IP 容器版本满意, 可去原系列素材页手动删除以避免本剧专属版本覆盖 IP 容器版本.",
    });
  } catch (e) {
    next(e);
  }
});

// ─── /api/v2/series/:slug/effective-elements ─────────────────────────

/**
 * GET /series/:slug/effective-elements?kind=
 *
 * 返 series 视角合并视图 (cast + local 合并, 含 _source 标记).
 * 前端 ElementListPage 可以替代 listElements 拿全图.
 */
castRouter.get("/series/:slug/effective-elements", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    if (!(await readSeries(slug))) return err(res, 404, "NotFound", `系列 ${slug} 不存在`);
    const kindParam = typeof req.query.kind === "string" ? req.query.kind : "";
    const kind = ALL_KINDS.includes(kindParam as ElementKind)
      ? (kindParam as ElementKind)
      : undefined;
    const elements = await getEffectiveElementsForSeries(slug, kind ? { kind } : undefined);
    res.json({ elements });
  } catch (e) {
    next(e);
  }
});

// ─── /api/v2/series/:slug/cast ───────────────────────────────────────

/**
 * PATCH /series/:slug/cast (W4 单组遗留, W7 起请用 /cast-ids)
 * body: { cast_id: string | null }
 *
 * 兼容老前端: 把 cast_id 写到 cast_ids = [cast_id] (null 清空).
 */
castRouter.patch("/series/:slug/cast", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    if (!(await readSeries(slug))) return err(res, 404, "NotFound", `系列 ${slug} 不存在`);
    const body = req.body ?? {};
    const castIdRaw = body.cast_id;
    let castId: string | undefined;
    if (castIdRaw === null || castIdRaw === undefined || castIdRaw === "") {
      castId = undefined;
    } else if (typeof castIdRaw === "string" && castIdRaw.trim()) {
      castId = castIdRaw.trim();
    } else {
      return err(res, 400, "ValidationError", "cast_id 必须是 string 或 null");
    }
    if (castId) {
      const cast = await readCast(castId);
      if (!cast) return err(res, 404, "NotFound", `找不到素材组 ${castId}`);
    }
    // W7: 兼容写到新字段 cast_ids 数组; 老字段 cast_id 同步留空(给 migration 兜底)
    const nextCastIds = castId ? [castId] : [];
    const updated = await updateSeries(slug, { cast_id: undefined, cast_ids: nextCastIds });
    if (!updated) return err(res, 404, "NotFound", `系列 ${slug} 不存在`);
    res.json({
      ok: true,
      series: { slug: updated.slug, cast_id: nextCastIds[0] ?? null, cast_ids: nextCastIds },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * W7: PATCH /series/:slug/cast-ids — 设置 series 共享的多个素材组.
 * body: { cast_ids: string[] }
 *
 * 用户在 SeriesHeader 多选 chip 切换素材组, 前端拼好完整 cast_ids 数组发来.
 * 空数组 = 退出所有素材组 (变回本剧专属). 不动 series local 素材.
 */
castRouter.patch("/series/:slug/cast-ids", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    if (!(await readSeries(slug))) return err(res, 404, "NotFound", `系列 ${slug} 不存在`);
    const body = req.body ?? {};
    const raw = body.cast_ids;
    if (!Array.isArray(raw)) {
      return err(res, 400, "ValidationError", "cast_ids 必须是数组");
    }
    // 去重 + 校验每个 id 存在
    const ids: string[] = [];
    for (const r of raw) {
      if (typeof r !== "string" || !r.trim()) continue;
      const id = r.trim();
      if (ids.includes(id)) continue;
      const cast = await readCast(id);
      if (!cast) return err(res, 404, "NotFound", `找不到素材组 ${id}`);
      ids.push(id);
    }
    // 老 cast_id 字段一起清空, 让 cast_ids 成为唯一真相源
    const updated = await updateSeries(slug, { cast_id: undefined, cast_ids: ids });
    if (!updated) return err(res, 404, "NotFound", `系列 ${slug} 不存在`);
    res.json({
      ok: true,
      series: { slug: updated.slug, cast_id: ids[0] ?? null, cast_ids: ids },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * W7: POST /series/:slug/elements/:elementId/share-to-groups
 * body: { cast_ids: string[] }
 *
 * 把 series local 素材共享到指定素材组列表 (走 promote-from-series 套路).
 * 调用语义:
 *   - 已在的组: no-op (跳过)
 *   - 未在的组: promote (复制 element + images 到 cast)
 *   - 没列出但当前 element 已在的组: 不动 (用户要 "取消共享" 走 DELETE /casts/:castId/elements/:elementId)
 *
 * 共享后 element 在每个目标 cast 里有独立主拷贝 (id 复用源 id, 走 promote-from-series 现成路径).
 */
castRouter.post("/series/:slug/elements/:elementId/share-to-groups", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const elementId = String(req.params.elementId);
    if (!(await readSeries(slug))) return err(res, 404, "NotFound", `系列 ${slug} 不存在`);
    const source = await readElement(slug, elementId);
    if (!source) {
      return err(
        res,
        404,
        "NotFound",
        `素材 ${elementId} 不存在 (注: 仅支持 prop/wardrobe/reference/misc 4 类共享)`,
      );
    }
    const body = req.body ?? {};
    const raw = body.cast_ids;
    if (!Array.isArray(raw)) {
      return err(res, 400, "ValidationError", "cast_ids 必须是数组");
    }
    const ids: string[] = [];
    for (const r of raw) {
      if (typeof r !== "string" || !r.trim()) continue;
      const id = r.trim();
      if (!ids.includes(id)) ids.push(id);
    }

    type PromoteOutcome = { cast_id: string; status: "added" | "already" | "error"; message?: string };
    const results: PromoteOutcome[] = [];

    for (const castId of ids) {
      const cast = await readCast(castId);
      if (!cast) {
        results.push({ cast_id: castId, status: "error", message: "素材组不存在" });
        continue;
      }
      // 已在: 跳过 (id 完全相等才算同一个)
      const existing = await readCastElement(castId, elementId).catch(() => null);
      if (existing) {
        results.push({ cast_id: castId, status: "already" });
        continue;
      }
      // 走 promote-from-series 套路 (新建 + 复制 images)
      try {
        // 调用方就是上面 castController POST /casts/:castId/elements/promote-from-series 的内部逻辑
        // 复用避免 fetch 自己, 这里抄关键链路:
        const created = await addCastMemberElement(castId, {
          kind: source.kind,
          name: source.name,
          description: source.description,
          tags: source.tags,
          attrs: source.attrs ?? {},
          derived_from: { series_slug: slug, element_id: elementId },
          image_briefs: source.image_briefs ? source.image_briefs.map((b) => ({ ...b })) : undefined,
          id: source.id, // 复用源 id 让 series-side 引用透明
        });
        // 复制 images
        for (const srcImg of source.images) {
          try {
            let buf: Buffer | null = null;
            let mime = srcImg.mime || "image/png";
            if (srcImg.vault_id) {
              const entry = await getVaultEntry(srcImg.vault_id);
              if (entry) {
                buf = await fs.readFile(getVaultAbsolutePath(entry));
                mime = entry.mime || mime;
              }
            }
            if (!buf && srcImg.asset_id) {
              const asset = await readAsset(slug, srcImg.asset_id);
              const abs = asset ? resolveAssetFilePath(slug, asset.path) : null;
              if (abs) {
                buf = await fs.readFile(abs);
                mime = asset?.mime || mime;
              }
            }
            if (!buf) continue;
            const vaultEntry = await saveToVault({
              buffer: buf,
              kind: "image",
              mime,
              context: { kind: "variant", series_slug: slug, user_note: `cast:${cast.name}:${created.name}` },
              provider_id: srcImg.provider_id ?? "share_to_group",
              tags: [`cast:${castId}`, `cast_element:${created.id}`, "shared_to_group"],
            });
            await addCastElementImage(castId, created.id, {
              image_id: srcImg.image_id,
              vault_id: vaultEntry.vault_id,
              asset_id: undefined,
              origin: srcImg.origin,
              prompt_snapshot: srcImg.prompt_snapshot,
              provider_id: srcImg.provider_id,
              seed: srcImg.seed,
              url: `/api/v2/vault/${vaultEntry.vault_id}/raw`,
              mime,
              display_name: srcImg.display_name,
              note: srcImg.note ?? "从素材库共享到素材组",
              available_for_shot: srcImg.available_for_shot,
              is_typical: srcImg.is_typical,
              based_on_image_id: srcImg.based_on_image_id,
              image_tags: srcImg.image_tags,
              created_at: srcImg.created_at,
            });
          } catch {
            /* 单图失败不阻塞 */
          }
        }
        // 复制 primary_image_id
        if (source.primary_image_id) {
          const refreshed = await readCastElement(castId, created.id);
          const matched = refreshed?.images.find((im) => im.image_id === source.primary_image_id);
          if (matched) {
            await updateCastElement(castId, created.id, { primary_image_id: source.primary_image_id });
          }
        }
        results.push({ cast_id: castId, status: "added" });
      } catch (e) {
        results.push({
          cast_id: castId,
          status: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    next(e);
  }
});

/**
 * W7: DELETE /casts/:castId/elements/:elementId — 从素材组里移除该素材.
 * 软删, 物理走 removeCastMemberElement (unlink 文件 + member_element_ids 摘除).
 * 不影响 series local 同 id 素材 (它们是独立文件).
 */
castRouter.delete("/casts/:castId/elements/:elementId", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const elementId = String(req.params.elementId);
    const cast = await readCast(castId);
    if (!cast) return err(res, 404, "NotFound", `找不到素材组 ${castId}`);
    const member = await readCastElement(castId, elementId);
    if (!member) return err(res, 404, "NotFound", `素材组里没有这个素材`);
    const ok = await removeCastMemberElement(castId, elementId);
    if (!ok) return err(res, 500, "DeleteFailed", "移除失败");
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ─── Cast 层 Voice 资产端点 (W6 2026-05-26) ───────────────────────────
//
// 设计:
//   - voice-sample 文件落 data/casts/<castId>/assets/voices/<sha10>_<basename>.<ext>
//   - 返回的 "voice_sample_vault_id" 是 cast-relative 标识符 (非 vault index 的 entry id),
//     格式 "cast:<castId>:assets/voices/<filename>" — 让 caller 能 round-trip 解析读盘.
//     (assetVault 仅支持 image/video 不支持 audio, 走 cast 本地目录是范围内最干净方案)
//   - 旧 sample 若存在且是本端点写的, 清理旧文件 (避免堆积)

/**
 * GET /casts/:castId/assets/voices/:filename — 静态回放 cast voice 样本.
 * 给前端 audio 元素直接 src 用. 注意防路径穿越 (filename 只允许 [a-zA-Z0-9._-]+).
 */
castRouter.get("/casts/:castId/assets/voices/:filename", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const filename = String(req.params.filename);
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      return err(res, 400, "ValidationError", "非法文件名");
    }
    const filePath = path.join(castVoicesDir(castId), filename);
    if (!(await pathExists(filePath))) {
      return err(res, 404, "NotFound", "样本文件不存在");
    }
    // 简易 mime 推断
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
      ".aac": "audio/aac", ".webm": "audio/webm", ".ogg": "audio/ogg",
    };
    res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=300");
    const stream = (await import("node:fs")).createReadStream(filePath);
    stream.on("error", () => res.status(500).end());
    stream.pipe(res);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /casts/:castId/elements/:elementId/voice-sample
 * multipart form: file=<audio>
 *
 * 上传 .wav/.mp3 等音频作角色克隆样本. 写入 cast 目录 + setCastMemberVoice 更新 voice_sample_vault_id.
 * 校验: 该 element 必须是 cast member 且 kind=character.
 */
castRouter.post(
  "/casts/:castId/elements/:elementId/voice-sample",
  castVoiceUpload.single("file"),
  async (req, res, next) => {
    try {
      const castId = String(req.params.castId);
      const elementId = String(req.params.elementId);
      const file = req.file;
      if (!file?.buffer?.length) {
        return err(res, 400, "ValidationError", "缺少文件字段 file");
      }
      const cast = await readCast(castId);
      if (!cast) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);
      const member = await readCastElement(castId, elementId);
      if (!member) return err(res, 404, "NotFound", `剧组里找不到角色 ${elementId}`);
      if (member.kind !== "character") {
        return err(res, 400, "ValidationError", `只能给角色绑定配音, 当前 ${member.name} 是 ${member.kind}`);
      }

      const origExt = path.extname(file.originalname).toLowerCase();
      const safeExt = CAST_VOICE_EXT_WHITELIST.has(origExt) ? origExt : ".mp3";
      const sha = crypto.createHash("sha256").update(file.buffer).digest("hex").slice(0, 10);
      const filename = `${elementId}_${Date.now()}_${sha}${safeExt}`;
      const voicesDir = castVoicesDir(castId);
      await ensureDir(voicesDir);
      const destPath = path.join(voicesDir, filename);
      await fs.writeFile(destPath, file.buffer);

      // cast-relative 标识符 — caller 走 resolveCastVoiceSamplePath 反解读盘
      const sampleId = `cast:${castId}:assets/voices/${filename}`;

      // 清理旧样本 (避免堆积) — 仅清本端点写的 (前缀检查)
      const prevAsset = cast.voice_assets?.find((v) => v.member_element_id === elementId);
      const prevId = prevAsset?.voice_sample_vault_id;
      if (prevId && prevId.startsWith(`cast:${castId}:assets/voices/`)) {
        const prevRel = prevId.slice(`cast:${castId}:`.length);
        const prevAbs = path.join(castDir(castId), prevRel);
        if (await pathExists(prevAbs)) {
          try { await fs.unlink(prevAbs); } catch (e) {
            loggerSync().warn(`[cast voice] 清理旧样本失败 ${prevAbs}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      const updated = await setCastMemberVoice(castId, elementId, {
        voice_sample_vault_id: sampleId,
      });
      if (!updated) return err(res, 500, "InternalError", "更新 cast voice_assets 失败");
      res.status(201).json({
        ok: true,
        voice_sample_vault_id: sampleId,
        bytes: file.buffer.length,
        cast: updated,
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * PATCH /casts/:castId/elements/:elementId/voice
 * body: { provider_voice_ids?, voice_style_map? }
 *
 * 更新非样本字段 (provider voice_ids 字典 / 情绪映射). 不动 voice_sample_vault_id.
 */
castRouter.patch(
  "/casts/:castId/elements/:elementId/voice",
  async (req, res, next) => {
    try {
      const castId = String(req.params.castId);
      const elementId = String(req.params.elementId);
      const cast = await readCast(castId);
      if (!cast) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);
      const member = await readCastElement(castId, elementId);
      if (!member) return err(res, 404, "NotFound", `剧组里找不到角色 ${elementId}`);
      if (member.kind !== "character") {
        return err(res, 400, "ValidationError", `只能给角色配置配音字段`);
      }
      const body = req.body ?? {};
      const patch: { provider_voice_ids?: Record<string, string>; voice_style_map?: Record<string, string> } = {};
      if (body.provider_voice_ids && typeof body.provider_voice_ids === "object") {
        // 仅接受 string -> string
        const sanitized: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.provider_voice_ids)) {
          if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
            sanitized[k.trim()] = v.trim();
          }
        }
        patch.provider_voice_ids = sanitized;
      }
      if (body.voice_style_map && typeof body.voice_style_map === "object") {
        const sanitized: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.voice_style_map)) {
          if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
            sanitized[k.trim()] = v.trim();
          }
        }
        patch.voice_style_map = sanitized;
      }
      // 保留已存在的 voice_sample_vault_id (不被本接口动)
      const existingAsset = cast.voice_assets?.find((v) => v.member_element_id === elementId);
      const updated = await setCastMemberVoice(castId, elementId, {
        ...patch,
        voice_sample_vault_id: existingAsset?.voice_sample_vault_id,
      });
      if (!updated) return err(res, 500, "InternalError", "更新失败");
      res.json({ ok: true, cast: updated });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * DELETE /casts/:castId/elements/:elementId/voice
 * 移除整个 voice_asset 项. 不删 vault 中样本文件 (其他角色 / 其他 cast 可能引用同 sha).
 * 但因为 cast voice sample 落在 cast 目录内 (非全局 vault), 本端点这里直接清理本 cast 的样本文件.
 */
castRouter.delete(
  "/casts/:castId/elements/:elementId/voice",
  async (req, res, next) => {
    try {
      const castId = String(req.params.castId);
      const elementId = String(req.params.elementId);
      const cast = await readCast(castId);
      if (!cast) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);

      // 清理 cast-local 样本文件
      const prev = cast.voice_assets?.find((v) => v.member_element_id === elementId);
      const prevId = prev?.voice_sample_vault_id;
      if (prevId && prevId.startsWith(`cast:${castId}:assets/voices/`)) {
        const prevRel = prevId.slice(`cast:${castId}:`.length);
        const prevAbs = path.join(castDir(castId), prevRel);
        if (await pathExists(prevAbs)) {
          try { await fs.unlink(prevAbs); } catch (e) {
            loggerSync().warn(`[cast voice] 清理样本失败 ${prevAbs}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      const updated = await removeCastMemberVoice(castId, elementId);
      if (!updated) return err(res, 500, "InternalError", "删除失败");
      res.json({ ok: true, cast: updated });
    } catch (e) {
      next(e);
    }
  },
);

// ─── Cast Dashboard 端点 (W6 2026-05-26 持续 IP 台账) ──────────────────
//
// 给"老头们"这种 IP 一个总览: N 部剧用, M 集 K 镜 T 分钟, 每个 member 被几集/几镜用过.
// 让创作者一眼看到这个 IP 的"工作量" + 哪些 member 在过度使用 / 哪些被冷落.

/**
 * GET /casts/:castId/dashboard
 *
 * 聚合: 所有挂本 cast 的 series → 遍 episodes → 遍 shots → 命中 member id 计数.
 *
 * 命中规则 (per shot):
 *   - shot.character_ids 包含 member_id
 *   - shot.scene_id === member_id
 *   - shot.wardrobe_id === member_id
 *   - shot.element_ids 包含 member_id
 *   - shot.prop_ids 包含 member_id
 *
 * 性能: 单 IP 一般 < 10 部剧 × < 50 集 × < 30 镜 = 15000 shot 级,  内存 O(shots × members).
 *      没做缓存, dashboard 一般打开次数少, 实时算够用.
 */
castRouter.get("/casts/:castId/dashboard", async (req, res, next) => {
  try {
    const castId = String(req.params.castId);
    const cast = await readCast(castId);
    if (!cast) return err(res, 404, "NotFound", `找不到剧组 ${castId}`);

    // 1) 拉所有挂本 cast 的 series (兼容老 cast_id 单字段 + 新 cast_ids 多组)
    const allSeries = await listSeries({ includeInternalTestSeries: false }).catch(() => []);
    const referencingSeries: Array<{ slug: string; title: string }> = [];
    for (const item of allSeries) {
      const s = await readSeries(item.slug).catch(() => null);
      const ids = normalizeSeriesCastIds(s);
      if (s && ids.includes(castId)) referencingSeries.push({ slug: s.slug, title: s.title });
    }

    // 2) 拉 cast members (含 kind / name / primary image)
    const members = await listCastElements(castId).catch(() => []);
    const memberById = new Map(members.map((m) => [m.id, m]));

    // 3) 遍 episodes & shots 聚合
    type SeriesAgg = { series_slug: string; series_title: string; episode_count: number; total_shot_count: number };
    type MemberAgg = {
      member_element_id: string;
      member_name: string;
      member_kind: ElementKind;
      series_set: Set<string>;
      episode_set: Set<string>;
      shot_count: number;
      total_seconds: number;
      last_used_at: string | null;
    };
    const seriesSummary: SeriesAgg[] = [];
    const memberAgg = new Map<string, MemberAgg>();
    for (const m of members) {
      memberAgg.set(m.id, {
        member_element_id: m.id,
        member_name: m.name,
        member_kind: m.kind,
        series_set: new Set(),
        episode_set: new Set(),
        shot_count: 0,
        total_seconds: 0,
        last_used_at: null,
      });
    }

    let grandTotalShots = 0;
    let grandTotalEpisodes = 0;
    let grandTotalSeconds = 0;

    for (const sref of referencingSeries) {
      const episodes = await listEpisodes(sref.slug).catch(() => []);
      let seriesShotCount = 0;
      for (const ep of episodes) {
        const shots = await listShots(sref.slug, ep.id).catch(() => []);
        seriesShotCount += shots.length;
        grandTotalShots += shots.length;
        for (const shot of shots) {
          grandTotalSeconds += (shot.duration_sec || 0);
          // 命中检查
          const hits = new Set<string>();
          for (const cid of shot.character_ids ?? []) if (memberById.has(cid)) hits.add(cid);
          if (shot.scene_id && memberById.has(shot.scene_id)) hits.add(shot.scene_id);
          if (shot.wardrobe_id && memberById.has(shot.wardrobe_id)) hits.add(shot.wardrobe_id);
          for (const eid of shot.element_ids ?? []) if (memberById.has(eid)) hits.add(eid);
          for (const pid of shot.prop_ids ?? []) if (memberById.has(pid)) hits.add(pid);

          for (const hit of hits) {
            const agg = memberAgg.get(hit);
            if (!agg) continue;
            agg.series_set.add(sref.slug);
            agg.episode_set.add(`${sref.slug}/${ep.id}`);
            agg.shot_count += 1;
            agg.total_seconds += (shot.duration_sec || 0);
            // 镜头没有 updated_at 字段 (Shot 类型不带), 退而用 ep 更新时间近似
            // 2026-05-28 audit P1 type-safety — Episode interface 未声明 updated_at, 走 unknown narrowing
            const epRec = ep as unknown as Record<string, unknown>;
            const epUpdated = typeof epRec.updated_at === "string" ? epRec.updated_at : null;
            if (epUpdated && (!agg.last_used_at || epUpdated > agg.last_used_at)) {
              agg.last_used_at = epUpdated;
            }
          }
        }
      }
      grandTotalEpisodes += episodes.length;
      seriesSummary.push({
        series_slug: sref.slug,
        series_title: sref.title,
        episode_count: episodes.length,
        total_shot_count: seriesShotCount,
      });
    }

    // 4) 输出 — Set → number, 按 series_count 降序
    const memberUsage = Array.from(memberAgg.values())
      .map((a) => ({
        member_element_id: a.member_element_id,
        member_name: a.member_name,
        member_kind: a.member_kind,
        series_count: a.series_set.size,
        episode_count: a.episode_set.size,
        shot_count: a.shot_count,
        total_seconds: Number(a.total_seconds.toFixed(2)),
        last_used_at: a.last_used_at,
      }))
      .sort((x, y) => y.series_count - x.series_count || y.shot_count - x.shot_count);

    res.json({
      cast,
      series_count: referencingSeries.length,
      total_episode_count: grandTotalEpisodes,
      total_shot_count: grandTotalShots,
      total_seconds: Number(grandTotalSeconds.toFixed(2)),
      series_summary: seriesSummary,
      member_usage: memberUsage,
    });
  } catch (e) {
    next(e);
  }
});

