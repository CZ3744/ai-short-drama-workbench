/**
 * Element cross-project import endpoint — import-from.
 *
 * 跨项目素材导入 (设计文档 §8.1: "从其他项目导入" 替代旧资源库).
 * 2026-05-21 P1 拆分: 抽自 elementController.ts §"跨项目素材导入" 段, 实现一字不差.
 */

import { Router } from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import {
  listElements,
  createElement,
  seriesExists,
  type ElementData,
  type ImageBrief,
} from "../../../repositories/elementRepo";
import {
  listCharacters,
  createCharacter,
  updateCharacter,
} from "../../../repositories/characterRepo";
import {
  listScenes,
  createScene,
  updateScene,
} from "../../../repositories/sceneRepo";
import { addAsset, readAsset, resolveAssetFilePath } from "../../../repositories/assetRepo";
import { DATA_ROOT, ensureDir } from "../../../../../../packages/core/src/index";
import {
  saveToVault,
  getVaultEntry,
  getVaultAbsolutePath,
} from "../../../../../../packages/library/src/assetVault";
import {
  elementPatchToCharacterPatch,
  elementPatchToScenePatch,
} from "../../../application/element/elementAdapter";
import {
  readAnyElement,
  updateAnyElement,
  addAnyElementImage,
  setAnyPrimaryImage,
  adaptCharacterData,
  adaptSceneData,
} from "../elementController.helpers";
import { updateAssetMeta } from "../../../repositories/assetMetaRepo";
import { cloneImageBriefs, err, remapImageBriefIds } from "./_shared";

export const importRouter = Router();

/**
 * POST /series/:slug/elements/import-from
 * body: { from_slug: string; element_id: string; name_override?: string }
 *
 * 把另一项目的 element 深拷贝到当前项目:
 *   - 名称冲突 → 用 name_override 或自动加 "(导入)" 后缀
 *   - 图片: 走 vault SHA-256 dedup; vault 命中已有则共享 vault_id, asset 仍复制到目标项目
 *   - derived_from 字段记录来源
 *   - character/scene/prop/wardrobe/reference 全 kind 支持
 */
importRouter.post("/series/:slug/elements/import-from", async (req, res, next) => {
  try {
    const toSlug = String(req.params.slug);
    const body = req.body ?? {};
    const fromSlug = String(body.from_slug || "").trim();
    const fromElementId = String(body.element_id || "").trim();
    const nameOverride = typeof body.name_override === "string" && body.name_override.trim()
      ? body.name_override.trim() : undefined;

    if (!fromSlug) return err(res, 400, "ValidationError", "from_slug 必填");
    if (!fromElementId) return err(res, 400, "ValidationError", "element_id 必填");
    if (fromSlug === toSlug) return err(res, 400, "ValidationError", "不能从自己导入");
    if (!(await seriesExists(toSlug))) return err(res, 404, "NotFound", `目标系列 ${toSlug} 不存在`);
    if (!(await seriesExists(fromSlug))) return err(res, 404, "NotFound", `来源系列 ${fromSlug} 不存在`);

    const source = await readAnyElement(fromSlug, fromElementId);
    if (!source) return err(res, 404, "NotFound", `来源素材 ${fromElementId} 不存在`);

    // 名称冲突处理
    let targetName = nameOverride ?? source.name;
    const existing = await listElements(toSlug).catch(() => [] as ElementData[]);
    const legacyChar = source.kind === "character" ? await listCharacters(toSlug).catch(() => []) : [];
    const legacyScene = source.kind === "scene" ? await listScenes(toSlug).catch(() => []) : [];
    const usedNames = new Set<string>([
      ...existing.map((e) => e.name),
      ...legacyChar.map((c) => c.name),
      ...legacyScene.map((s) => s.name),
    ]);
    if (!nameOverride && usedNames.has(targetName)) {
      let suffix = 1;
      let candidate = `${source.name}(导入)`;
      while (usedNames.has(candidate)) {
        suffix += 1;
        candidate = `${source.name}(导入${suffix})`;
      }
      targetName = candidate;
    }

    const derivedFrom = { series_slug: fromSlug, element_id: fromElementId };
    const sourceImageBriefs = cloneImageBriefs(source.image_briefs);

    // 创建目标素材外壳 (按 kind 走对应 repo)
    let createdElement: ElementData | null = null;
    if (source.kind === "character") {
      const patch = elementPatchToCharacterPatch({
        name: targetName,
        description: source.description,
        tags: source.tags,
        attrs: source.attrs ?? {},
      });
      const created = await createCharacter(toSlug, {
        name: String(patch.name ?? targetName).trim(),
        role: String(patch.role ?? ""),
        appearance_prompt: String(patch.appearance_prompt ?? ""),
        personality: String(patch.personality ?? ""),
        voice_id: typeof patch.voice_id === "string" ? patch.voice_id : undefined,
        voice_style_map: patch.voice_style_map as Record<string, string | undefined> | undefined,
        library_id: typeof patch.library_id === "string" ? patch.library_id : undefined,
      });
      // 2026-05-28 audit P1 type-safety — destructure 移除 createCharacter 已传入字段, 避免 delete (extra as any)
      const { name: _n, role: _r, appearance_prompt: _ap, personality: _p, voice_id: _vi, voice_style_map: _vsm, library_id: _lid, ...patchExtras } = patch;
      void _n; void _r; void _ap; void _p; void _vi; void _vsm; void _lid;
      const extra: typeof patchExtras & { image_briefs?: ImageBrief[] } = { ...patchExtras };
      if (sourceImageBriefs !== undefined) {
        extra.image_briefs = sourceImageBriefs;
      }
      const updated = Object.keys(extra).length > 0
        ? await updateCharacter(toSlug, created.id, extra)
        : created;
      createdElement = await adaptCharacterData(toSlug, updated);
    } else if (source.kind === "scene") {
      const patch = elementPatchToScenePatch({
        name: targetName,
        description: source.description,
        tags: source.tags,
        attrs: source.attrs ?? {},
      });
      const created = await createScene(toSlug, {
        name: String(patch.name ?? targetName).trim(),
        description: typeof patch.description === "string" ? patch.description : "",
        visual_style: typeof patch.visual_style === "string" ? patch.visual_style : undefined,
        location: typeof patch.location === "string" ? patch.location : undefined,
        time_of_day: typeof patch.time_of_day === "string" ? patch.time_of_day : undefined,
        mood: typeof patch.mood === "string" ? patch.mood : undefined,
        library_id: typeof patch.library_id === "string" ? patch.library_id : undefined,
      });
      // 2026-05-28 audit P1 type-safety — destructure 移除 createScene 已传入字段, 避免 delete (extra as any)
      const { name: _n, description: _d, visual_style: _vs, location: _loc, time_of_day: _tod, mood: _m, library_id: _lid, ...patchExtras } = patch;
      void _n; void _d; void _vs; void _loc; void _tod; void _m; void _lid;
      const extra: typeof patchExtras & { image_briefs?: ImageBrief[] } = { ...patchExtras };
      if (sourceImageBriefs !== undefined) {
        extra.image_briefs = sourceImageBriefs;
      }
      const updated = Object.keys(extra).length > 0
        ? await updateScene(toSlug, created.id, extra)
        : created;
      createdElement = await adaptSceneData(toSlug, updated);
    } else {
      createdElement = await createElement(toSlug, {
        kind: source.kind,
        name: targetName,
        description: source.description,
        tags: source.tags,
        attrs: source.attrs ?? {},
        derived_from: derivedFrom,
        image_briefs: sourceImageBriefs,
      });
    }

    if (!createdElement) return err(res, 500, "ImportFailed", "目标素材创建失败");

    // 复制图片: 优先 vault dedup (SHA-256 命中共享 vault_id), asset 总是目标项目新建
    let copiedCount = 0;
    const imageIdMap = new Map<string, string>();
    const importErrors: string[] = [];
    for (const srcImg of source.images) {
      try {
        let buf: Buffer | null = null;
        let mime = srcImg.mime || "image/png";
        const promptSnapshot = srcImg.prompt_snapshot;
        const sourceDisplayName = typeof srcImg.display_name === "string" ? srcImg.display_name.trim() : "";
        const sourceNote = typeof srcImg.note === "string" ? srcImg.note : undefined;

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
        if (!buf) { importErrors.push(`image ${srcImg.image_id}: 无法读取源图`); continue; }

        // saveToVault — SHA-256 dedup 内置, 命中返回已有 entry
        const vaultEntry = await saveToVault({
          buffer: buf,
          kind: "image",
          mime,
          context: {
            kind: "variant",
            series_slug: toSlug,
            user_note: sourceNote?.trim() || `element:${createdElement.kind}:${createdElement.name}`,
            display_name: sourceDisplayName || undefined,
            imported_from: `${fromSlug}/${fromElementId}/${srcImg.image_id}`,
          },
          provider_id: srcImg.provider_id ?? "cross_project_import",
          tags: [
            `element:${createdElement.id}`,
            `${createdElement.kind}:${createdElement.id}`,
            "ref_image",
            "cross_project_import",
            `imported_from_series:${fromSlug}`,
          ],
        });

        // 写一份 asset 到目标项目
        const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
        const filename = `imported_${createdElement.id}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
        const targetAssetsDir = path.join(DATA_ROOT, "series", toSlug, "assets", "images");
        await ensureDir(targetAssetsDir);
        await fs.writeFile(path.join(targetAssetsDir, filename), buf);
        const asset = await addAsset(toSlug, {
          series_slug: toSlug,
          kind: "image",
          tags: [
            `element:${createdElement.id}`,
            `${createdElement.kind}:${createdElement.id}`,
            "ref_image",
            "cross_project_import",
          ],
          path: `assets/images/${filename}`,
          filename,
          mime,
          size_bytes: buf.length,
          sha256: crypto.createHash("sha256").update(buf).digest("hex"),
        });

        const added = await addAnyElementImage(toSlug, createdElement.id, {
          vault_id: vaultEntry.vault_id,
          asset_id: asset.asset_id,
          origin: srcImg.origin === "imported" ? "imported" : "generated",
          prompt_snapshot: promptSnapshot,
          provider_id: srcImg.provider_id,
          seed: srcImg.seed,
          url: `/api/v2/vault/${vaultEntry.vault_id}/raw`,
          mime,
          display_name: sourceDisplayName || undefined,
          note: sourceNote ?? "跨项目导入",
          available_for_shot: srcImg.available_for_shot ?? false,
          is_typical: false, // V-33: 跨项目导入不继承源项目标记
        });
        if (added) {
          if (sourceDisplayName) {
            await updateAssetMeta(added.image.image_id, { display_name: sourceDisplayName });
            await updateAssetMeta(vaultEntry.vault_id, { display_name: sourceDisplayName });
          }
          copiedCount += 1;
          imageIdMap.set(srcImg.image_id, added.image.image_id);
          createdElement = added.element;
        }
      } catch (imgError) {
        importErrors.push(`image ${srcImg.image_id}: ${imgError instanceof Error ? imgError.message : String(imgError)}`);
      }
    }

    // 源有主图 → 在目标也锁定同一张.
    // 2026-07-09 audit C14 — 弃用 index 对齐: 前面某张源图复制失败(vault 已删/asset 读不到 →
    // continue 跳过)会让 target images 数组整体前移, 按下标对齐会锁错代表图, 且导入图 is_typical
    // 全为 false → resolveTypicalImages 回落到 primary_image_id → 该角色对所有引用分镜喂错参考图
    // (跨分镜一致性崩, 铁律 #0). 改用 imageIdMap(源 image_id → 目标新 image_id)稳定映射:
    // 主图复制成功 → 精确锁到它的新 id; 主图本身复制失败 → get 返 undefined → 跳过不乱锁.
    if (source.primary_image_id && createdElement) {
      const newPrimaryId = imageIdMap.get(source.primary_image_id);
      if (newPrimaryId) {
        const promoted = await setAnyPrimaryImage(toSlug, createdElement.id, newPrimaryId);
        if (promoted) createdElement = promoted;
      }
    }

    // 复制 image_briefs: 保留 LLM/用户规划,并把已生成 brief 的 image_id 改成目标项目新图 id.
    if (createdElement && sourceImageBriefs !== undefined) {
      const remappedBriefs = remapImageBriefIds(sourceImageBriefs, imageIdMap);
      const updatedWithBriefs = await updateAnyElement(toSlug, createdElement.id, {
        image_briefs: remappedBriefs,
      } as Partial<ElementData>);
      if (updatedWithBriefs) createdElement = updatedWithBriefs;
    }

    // 写盘 derived_from — character/scene 走各自 legacy repo, element 4 kind 已在 createElement 时落盘
    if (createdElement && source.kind === "character") {
      // character legacy schema 用 character_id 而不是 element_id; 2026-05-28 audit P1: 看 CharacterData.derived_from 字段类型决定
      await updateCharacter(toSlug, createdElement.id, { derived_from: { series_slug: derivedFrom.series_slug, character_id: derivedFrom.element_id } });
      createdElement = { ...createdElement, derived_from: derivedFrom };
    } else if (createdElement && source.kind === "scene") {
      await updateScene(toSlug, createdElement.id, { derived_from: derivedFrom });
      createdElement = { ...createdElement, derived_from: derivedFrom };
    }

    res.status(201).json({
      ok: true,
      element: createdElement,
      copied_images: copiedCount,
      total_images: source.images.length,
      errors: importErrors.length ? importErrors : undefined,
      source_series: fromSlug,
      source_element_id: fromElementId,
    });
  } catch (e) { next(e); }
});
