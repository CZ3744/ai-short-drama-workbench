/**
 * Element 同源 push/pull 同步端点 — W3 (2026-05-26).
 *
 * 跨项目素材导入 (import.ts) 是"深拷贝 + 写 derived_from", 但导入后两边
 * 独立长大, 无法同步. 本文件给"同源素材"加双向同步能力:
 *
 *   GET  /series/:slug/elements/:id/derived          反查下游派生列表
 *   GET  /series/:slug/elements/:id/upstream-diff    返"我 vs 上游"字段级 diff
 *   POST /series/:slug/elements/:id/pull-from-upstream   拉上游某字段到本地
 *   POST /series/:slug/elements/:id/push-to-downstream   推本地某字段到下游
 *
 * 设计原则 (UX 铁律):
 *   - #1 用户控制权: 不全量盲拉, 用户勾选要的字段才生效
 *   - #2 可干预: 推送/拉取前 diff 完全可见
 *   - #6 数据保留: 不删本地图, 只追加上游新图 (即使用户勾"拉主图")
 *   - #9 toC 兜底: 错误消息不暴露 element_id, 用素材名翻译
 *
 * 复用 import.ts 的 saveToVault + asset 复制套路 (避免重新发明轮子).
 */

import { Router } from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import {
  listElements,
  type ElementData,
  type ElementImage,
  type ImageBrief,
  type ElementTag,
} from "../../../repositories/elementRepo";
import { addAsset, readAsset, resolveAssetFilePath } from "../../../repositories/assetRepo";
import { DATA_ROOT, ensureDir } from "../../../../../../packages/core/src/index";
import {
  saveToVault,
  getVaultEntry,
  getVaultAbsolutePath,
} from "../../../../../../packages/library/src/assetVault";
import { listSeries, readSeries } from "../../../repositories/seriesRepo";
import { listCharacters } from "../../../repositories/characterRepo";
import { listScenes } from "../../../repositories/sceneRepo";
import {
  readAnyElement,
  updateAnyElement,
  addAnyElementImage,
} from "../elementController.helpers";
import { updateAssetMeta } from "../../../repositories/assetMetaRepo";
import { err } from "./_shared";

export const syncRouter = Router();

// ─── 共享 helper ──────────────────────────────────────────────────────

/**
 * 把所有项目里属于 character/scene 的素材也拿出来做 derived_from 反查.
 * elementRepo.listElements 只覆盖 prop/wardrobe/reference/misc 4 类,
 * character / scene 走 legacy repo 但通过 adapter 也带 derived_from 信息.
 */
async function listAllElementsAcrossKinds(slug: string): Promise<ElementData[]> {
  const repo = await listElements(slug).catch(() => [] as ElementData[]);

  const characters = await listCharacters(slug).catch(() => []);
  const charAsElement: ElementData[] = characters
    .filter((c) => c.derived_from)
    .map((c) => {
      // 2026-05-28 audit P1 type-safety — Character interface 上没有 description/created_at/updated_at,
      // 但磁盘老数据可能有. unknown narrowing 替代 (c as any) 偷读.
      const rec = c as unknown as Record<string, unknown>;
      const desc = typeof rec.description === "string" ? rec.description : (c.appearance_prompt ?? "");
      const createdAt = typeof rec.created_at === "string" ? rec.created_at : new Date().toISOString();
      const updatedAt = typeof rec.updated_at === "string" ? rec.updated_at : new Date().toISOString();
      return {
        id: c.id,
        series_slug: slug,
        kind: "character",
        name: c.name,
        description: desc,
        tags: [],
        images: [],
        attrs: {},
        status: "drafted",
        created_at: createdAt,
        updated_at: updatedAt,
        derived_from: c.derived_from
          ? { series_slug: c.derived_from.series_slug, element_id: c.derived_from.character_id }
          : undefined,
      } as ElementData;
    });

  const scenes = await listScenes(slug).catch(() => []);
  const sceneAsElement: ElementData[] = scenes
    .filter((s) => s.derived_from)
    .map((s) => {
      // 2026-05-28 audit P1 type-safety — Scene interface 字段缺 created_at/updated_at, 走 unknown narrowing
      const rec = s as unknown as Record<string, unknown>;
      const createdAt = typeof rec.created_at === "string" ? rec.created_at : new Date().toISOString();
      const updatedAt = typeof rec.updated_at === "string" ? rec.updated_at : new Date().toISOString();
      return {
        id: s.id,
        series_slug: slug,
        kind: "scene",
        name: s.name,
        description: s.description ?? "",
        tags: [],
        images: [],
        attrs: {},
        status: "drafted",
        created_at: createdAt,
        updated_at: updatedAt,
        derived_from: s.derived_from
          ? { series_slug: s.derived_from.series_slug, element_id: s.derived_from.element_id }
          : undefined,
      } as ElementData;
    });

  return [...repo, ...charAsElement, ...sceneAsElement];
}

/** 并发上限 10 跑 fn — 给 derivatives 反查用 (项目数<50 总耗时可控). */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

/** 拷一段图到本地: 复用 import.ts 的 vault dedup + asset 复制套路. */
async function copyImageFromUpstream(opts: {
  fromSlug: string;
  toSlug: string;
  toElement: ElementData;
  srcImg: ElementImage;
}): Promise<{ success: boolean; new_image_id?: string; reason?: string }> {
  const { fromSlug, toSlug, toElement, srcImg } = opts;
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
  if (!buf) return { success: false, reason: "源图文件丢失" };

  const sourceDisplayName = typeof srcImg.display_name === "string" ? srcImg.display_name.trim() : "";
  const vaultEntry = await saveToVault({
    buffer: buf,
    kind: "image",
    mime,
    context: {
      kind: "variant",
      series_slug: toSlug,
      user_note: `element:${toElement.kind}:${toElement.name}`,
      display_name: sourceDisplayName || undefined,
      imported_from: `${fromSlug}/${srcImg.image_id}`,
    },
    provider_id: srcImg.provider_id ?? "upstream_sync",
    tags: [
      `element:${toElement.id}`,
      `${toElement.kind}:${toElement.id}`,
      "ref_image",
      "upstream_sync",
      `imported_from_series:${fromSlug}`,
    ],
  });

  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const filename = `synced_${toElement.id}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
  const targetAssetsDir = path.join(DATA_ROOT, "series", toSlug, "assets", "images");
  await ensureDir(targetAssetsDir);
  await fs.writeFile(path.join(targetAssetsDir, filename), buf);
  const asset = await addAsset(toSlug, {
    series_slug: toSlug,
    kind: "image",
    tags: [`element:${toElement.id}`, `${toElement.kind}:${toElement.id}`, "ref_image", "upstream_sync"],
    path: `assets/images/${filename}`,
    filename,
    mime,
    size_bytes: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  });

  const added = await addAnyElementImage(toSlug, toElement.id, {
    vault_id: vaultEntry.vault_id,
    asset_id: asset.asset_id,
    origin: srcImg.origin === "imported" ? "imported" : "generated",
    prompt_snapshot: srcImg.prompt_snapshot,
    provider_id: srcImg.provider_id,
    seed: srcImg.seed,
    url: `/api/v2/vault/${vaultEntry.vault_id}/raw`,
    mime,
    display_name: sourceDisplayName || undefined,
    note: "从上游同步",
    available_for_shot: srcImg.available_for_shot ?? false,
    is_typical: false, // 同步过来不抢主图 — 用户在本地决定
  });
  if (added && sourceDisplayName) {
    await updateAssetMeta(added.image.image_id, { display_name: sourceDisplayName });
    await updateAssetMeta(vaultEntry.vault_id, { display_name: sourceDisplayName });
  }
  return added
    ? { success: true, new_image_id: added.image.image_id }
    : { success: false, reason: "本地写入失败" };
}

/** 计算两份 tag 数组的差集 (axis+value 作 key, ref_element_id 仅辅助).
 *  导出供 __tests__/elementSync.test.ts 单测. */
export function diffTags(local: ElementTag[] | undefined, upstream: ElementTag[] | undefined): { added: ElementTag[]; removed: ElementTag[] } | undefined {
  const tagKey = (t: ElementTag) => `${t.axis}=${t.value}`;
  const a = new Set((local ?? []).map(tagKey));
  const b = new Set((upstream ?? []).map(tagKey));
  const added: ElementTag[] = (upstream ?? []).filter((t) => !a.has(tagKey(t)));
  const removed: ElementTag[] = (local ?? []).filter((t) => !b.has(tagKey(t)));
  if (added.length === 0 && removed.length === 0) return undefined;
  return { added, removed };
}

// ─── A1 GET /derived ─────────────────────────────────────────────────

/**
 * GET /series/:slug/elements/:id/derived
 *
 * 反查"哪些 series 的哪些 element 派生自我".
 * 用法: 上游素材想知道"我被多少剧用了", 也方便 push 时选目标.
 */
syncRouter.get("/series/:slug/elements/:id/derived", async (req, res, next) => {
  try {
    const sourceSlug = String(req.params.slug);
    const sourceId = String(req.params.id);
    if (!(await readAnyElement(sourceSlug, sourceId))) {
      return err(res, 404, "NotFound", "源素材不存在");
    }

    const allSeries = await listSeries({ includeInternalTestSeries: false });
    const targets = allSeries.filter((s) => s.slug !== sourceSlug);

    const derivatives: Array<{
      series_slug: string;
      series_title: string;
      element_id: string;
      element_name: string;
      element_kind: string;
      updated_at: string;
    }> = [];

    // 并发上限 10 个 series, 项目数<50 总耗时可控.
    await mapPool(targets, 10, async (series) => {
      const candidates = await listAllElementsAcrossKinds(series.slug);
      for (const el of candidates) {
        if (el.derived_from?.series_slug === sourceSlug && el.derived_from?.element_id === sourceId) {
          derivatives.push({
            series_slug: series.slug,
            series_title: series.title,
            element_id: el.id,
            element_name: el.name,
            element_kind: el.kind,
            updated_at: el.updated_at,
          });
        }
      }
    });

    derivatives.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    res.json({ derivatives });
  } catch (e) { next(e); }
});

// ─── A2 GET /upstream-diff ───────────────────────────────────────────

/**
 * GET /series/:slug/elements/:id/upstream-diff
 *
 * 返"本地 vs 上游"字段级 diff. 没 derived_from 时返 200 + diff=null.
 * 用户依据 diff 决定要 pull 哪些字段.
 */
syncRouter.get("/series/:slug/elements/:id/upstream-diff", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const local = await readAnyElement(slug, id);
    if (!local) return err(res, 404, "NotFound", "素材不存在");

    if (!local.derived_from) {
      return res.json({ source: null, current_updated_at: local.updated_at, diff: null, reason: "non_derived" });
    }
    const fromSlug = local.derived_from.series_slug;
    const fromElementId = local.derived_from.element_id;

    // 上游系列不存在 (例: 用户删了源剧)
    if (!(await readSeries(fromSlug))) {
      return res.json({
        source: { series_slug: fromSlug, element_id: fromElementId, name: "(已删除)", updated_at: "" },
        current_updated_at: local.updated_at,
        diff: null,
        reason: "upstream_series_missing",
      });
    }
    const upstream = await readAnyElement(fromSlug, fromElementId);
    if (!upstream) {
      return res.json({
        source: { series_slug: fromSlug, element_id: fromElementId, name: "(已删除)", updated_at: "" },
        current_updated_at: local.updated_at,
        diff: null,
        reason: "upstream_element_missing",
      });
    }

    // 上游 updated_at <= 本地 updated_at → 没新内容
    if (upstream.updated_at.localeCompare(local.updated_at) <= 0) {
      return res.json({
        source: {
          series_slug: fromSlug,
          element_id: fromElementId,
          name: upstream.name,
          updated_at: upstream.updated_at,
        },
        current_updated_at: local.updated_at,
        diff: null,
        reason: "up_to_date",
      });
    }

    // 计算字段 diff
    const diff: {
      description?: { from: string; to: string };
      tags?: { added: ElementTag[]; removed: ElementTag[] };
      primary_image_snapshot?: { from: string | null; to: string | null };
      image_briefs_count?: { from: number; to: number };
    } = {};

    if ((local.description ?? "") !== (upstream.description ?? "")) {
      diff.description = { from: local.description ?? "", to: upstream.description ?? "" };
    }
    const tagsDiff = diffTags(local.tags, upstream.tags);
    if (tagsDiff) diff.tags = tagsDiff;

    // primary_image_snapshot 比较: 用 prompt_snapshot 判定 (实际像素 hash 太重)
    const localPrimary = local.primary_image_id
      ? local.images.find((im) => im.image_id === local.primary_image_id) ?? null
      : null;
    const upstreamPrimary = upstream.primary_image_id
      ? upstream.images.find((im) => im.image_id === upstream.primary_image_id) ?? null
      : null;
    const localSnap = localPrimary?.prompt_snapshot ?? localPrimary?.display_name ?? null;
    const upstreamSnap = upstreamPrimary?.prompt_snapshot ?? upstreamPrimary?.display_name ?? null;
    if (localSnap !== upstreamSnap) {
      diff.primary_image_snapshot = { from: localSnap, to: upstreamSnap };
    }

    const localBriefsCount = (local.image_briefs ?? []).length;
    const upstreamBriefsCount = (upstream.image_briefs ?? []).length;
    if (localBriefsCount !== upstreamBriefsCount) {
      diff.image_briefs_count = { from: localBriefsCount, to: upstreamBriefsCount };
    }

    res.json({
      source: {
        series_slug: fromSlug,
        element_id: fromElementId,
        name: upstream.name,
        updated_at: upstream.updated_at,
      },
      current_updated_at: local.updated_at,
      diff: Object.keys(diff).length > 0 ? diff : null,
      reason: Object.keys(diff).length > 0 ? "has_diff" : "no_field_diff",
    });
  } catch (e) { next(e); }
});

// ─── A3 POST /pull-from-upstream ─────────────────────────────────────

/**
 * POST /series/:slug/elements/:id/pull-from-upstream
 * body: { apply_fields: ("description" | "tags" | "primary_image" | "image_briefs")[] }
 *
 * 按用户勾选的字段, 把上游字段拉到本地. 不删本地已有图.
 */
syncRouter.post("/series/:slug/elements/:id/pull-from-upstream", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const body = req.body ?? {};
    const fields: string[] = Array.isArray(body.apply_fields) ? body.apply_fields : [];
    const allowed = new Set(["description", "tags", "primary_image", "image_briefs"]);
    const applyFields = fields.filter((f) => allowed.has(f));
    if (applyFields.length === 0) return err(res, 400, "ValidationError", "apply_fields 必填且至少 1 项");

    const local = await readAnyElement(slug, id);
    if (!local) return err(res, 404, "NotFound", "素材不存在");
    if (!local.derived_from) return err(res, 400, "NoUpstream", "这个素材不是从原版复制来的, 无法同步");

    const fromSlug = local.derived_from.series_slug;
    const fromElementId = local.derived_from.element_id;
    if (!(await readSeries(fromSlug))) return err(res, 410, "UpstreamGone", "原版所在的剧已删除");
    const upstream = await readAnyElement(fromSlug, fromElementId);
    if (!upstream) return err(res, 410, "UpstreamGone", "原版素材已删除");

    const patch: Partial<ElementData> = {};
    const updatedFields: string[] = [];

    if (applyFields.includes("description") && (local.description ?? "") !== (upstream.description ?? "")) {
      patch.description = upstream.description ?? "";
      updatedFields.push("description");
    }
    if (applyFields.includes("tags")) {
      const td = diffTags(local.tags, upstream.tags);
      if (td) {
        patch.tags = upstream.tags ?? [];
        updatedFields.push("tags");
      }
    }
    if (applyFields.includes("image_briefs")) {
      const localCount = (local.image_briefs ?? []).length;
      const upstreamCount = (upstream.image_briefs ?? []).length;
      if (localCount !== upstreamCount && upstream.image_briefs) {
        // 拉 briefs 时清掉 image_id (不映射到上游图 id, 让用户在本地决定)
        patch.image_briefs = upstream.image_briefs.map((b) => ({
          ...b,
          image_id: undefined,
          generated: undefined,
        }));
        updatedFields.push("image_briefs");
      }
    }

    let after = local;
    if (Object.keys(patch).length > 0) {
      const updated = await updateAnyElement(slug, id, patch);
      if (updated) after = updated;
    }

    // primary_image: 拉新图作为追加, 不抢主图位置
    if (applyFields.includes("primary_image") && upstream.primary_image_id) {
      const upstreamPrimary = upstream.images.find((im) => im.image_id === upstream.primary_image_id);
      if (upstreamPrimary) {
        // 已经有同源 prompt_snapshot 的图就跳过 (vault SHA-256 dedup 仍兜底)
        const alreadyHasSameSnap = after.images.some(
          (im) => im.prompt_snapshot && im.prompt_snapshot === upstreamPrimary.prompt_snapshot,
        );
        if (!alreadyHasSameSnap) {
          const copyResult = await copyImageFromUpstream({
            fromSlug,
            toSlug: slug,
            toElement: after,
            srcImg: upstreamPrimary,
          });
          if (copyResult.success) {
            updatedFields.push("primary_image");
            const reloaded = await readAnyElement(slug, id);
            if (reloaded) after = reloaded;
          }
        }
      }
    }

    res.json({ updated_fields: updatedFields, element: after });
  } catch (e) { next(e); }
});

// ─── A4 POST /push-to-downstream ─────────────────────────────────────

/**
 * POST /series/:slug/elements/:id/push-to-downstream
 * body: { target_slug, target_element_id, apply_fields: [...] }
 *
 * 本地版本作为"上游", 推送指定字段到目标 (目标必须 derived_from 指向本地).
 */
syncRouter.post("/series/:slug/elements/:id/push-to-downstream", async (req, res, next) => {
  try {
    const sourceSlug = String(req.params.slug);
    const sourceId = String(req.params.id);
    const body = req.body ?? {};
    const targetSlug = String(body.target_slug || "").trim();
    const targetElementId = String(body.target_element_id || "").trim();
    const fields: string[] = Array.isArray(body.apply_fields) ? body.apply_fields : [];
    const allowed = new Set(["description", "tags", "primary_image", "image_briefs"]);
    const applyFields = fields.filter((f) => allowed.has(f));

    if (!targetSlug) return err(res, 400, "ValidationError", "target_slug 必填");
    if (!targetElementId) return err(res, 400, "ValidationError", "target_element_id 必填");
    if (applyFields.length === 0) return err(res, 400, "ValidationError", "apply_fields 必填且至少 1 项");
    if (targetSlug === sourceSlug) return err(res, 400, "ValidationError", "不能同步到自己");

    const source = await readAnyElement(sourceSlug, sourceId);
    if (!source) return err(res, 404, "NotFound", "源素材不存在");
    if (!(await readSeries(targetSlug))) return err(res, 404, "NotFound", "目标系列不存在");
    const target = await readAnyElement(targetSlug, targetElementId);
    if (!target) return err(res, 404, "NotFound", "目标素材不存在");

    // 防御: 目标必须 derived_from 指向源 — 没派生关系不允许互推
    if (
      !target.derived_from ||
      target.derived_from.series_slug !== sourceSlug ||
      target.derived_from.element_id !== sourceId
    ) {
      return err(res, 400, "NotDerived", "目标素材不是从当前素材复制来的, 无法同步");
    }

    const patch: Partial<ElementData> = {};
    const updatedFields: string[] = [];

    if (applyFields.includes("description") && (target.description ?? "") !== (source.description ?? "")) {
      patch.description = source.description ?? "";
      updatedFields.push("description");
    }
    if (applyFields.includes("tags")) {
      const td = diffTags(target.tags, source.tags);
      if (td) {
        patch.tags = source.tags ?? [];
        updatedFields.push("tags");
      }
    }
    if (applyFields.includes("image_briefs")) {
      const localCount = (target.image_briefs ?? []).length;
      const sourceCount = (source.image_briefs ?? []).length;
      if (localCount !== sourceCount && source.image_briefs) {
        patch.image_briefs = source.image_briefs.map((b) => ({
          ...b,
          image_id: undefined,
          generated: undefined,
        }));
        updatedFields.push("image_briefs");
      }
    }

    let after = target;
    if (Object.keys(patch).length > 0) {
      // character/scene 走对应 repo 不能用 updateAnyElement 写 description?
      // updateAnyElement 已通过 adapter 兼容, 直接用即可
      const updated = await updateAnyElement(targetSlug, targetElementId, patch);
      if (updated) after = updated;
    }

    if (applyFields.includes("primary_image") && source.primary_image_id) {
      const sourcePrimary = source.images.find((im) => im.image_id === source.primary_image_id);
      if (sourcePrimary) {
        const alreadyHasSameSnap = after.images.some(
          (im) => im.prompt_snapshot && im.prompt_snapshot === sourcePrimary.prompt_snapshot,
        );
        if (!alreadyHasSameSnap) {
          const copyResult = await copyImageFromUpstream({
            fromSlug: sourceSlug,
            toSlug: targetSlug,
            toElement: after,
            srcImg: sourcePrimary,
          });
          if (copyResult.success) {
            updatedFields.push("primary_image");
            const reloaded = await readAnyElement(targetSlug, targetElementId);
            if (reloaded) after = reloaded;
          }
        }
      }
    }

    // P1-39 (2026-05-28 audit wave 4): character/scene 的 derived_from 写在 legacy repo,
    // updateAnyElement 不会动 derived_from. 这里不动派生关系本身, 也用不上 update* —
    // 老 dead import + void 兜底已删, import 列表跟实际依赖一致.

    res.json({ updated_fields: updatedFields });
  } catch (e) { next(e); }
});
