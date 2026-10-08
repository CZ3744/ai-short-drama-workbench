/**
 * Element CRUD endpoints — List / Get / Create / Update / Delete / Usage.
 *
 * 2026-05-21 P1 拆分: 抽自 elementController.ts §"CRUD" 段, 实现与原文件一字不差.
 */

import { Router } from "express";
import {
  listElements,
  readElement,
  createElement,
  deleteElement,
  seriesExists,
  type ElementKind,
  type ElementData,
} from "../../../repositories/elementRepo";
import {
  listCharacters,
  createCharacter,
  updateCharacter,
  deleteCharacter,
} from "../../../repositories/characterRepo";
import {
  listScenes,
  createScene,
  updateScene,
  deleteScene,
} from "../../../repositories/sceneRepo";
import { listEpisodes, listShots } from "../seriesStore";
import {
  elementPatchToCharacterPatch,
  elementPatchToScenePatch,
} from "../../../application/element/elementAdapter";
import { ensureDefaultBriefs } from "../../../application/element/elementBriefDefaults";
import {
  readAnyElement,
  updateAnyElement,
  adaptCharacterData,
  adaptSceneData,
} from "../elementController.helpers";
import { ALL_KINDS, err, isRepoKind, mergeElementImagesWithAssetMeta } from "./_shared";

export const crudRouter = Router();

// GET /series/:slug/elements?kind=
crudRouter.get("/series/:slug/elements", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const kindParam = typeof req.query.kind === "string" ? req.query.kind : "";
    const out: ElementData[] = [];

    if (!kindParam || kindParam === "character") {
      try {
        for (const c of await listCharacters(slug)) {
          const el = await adaptCharacterData(slug, c);
          if (el) out.push(el);
        }
      } catch { /* series may have none */ }
    }
    if (!kindParam || kindParam === "scene") {
      try {
        for (const s of await listScenes(slug)) {
          const el = await adaptSceneData(slug, s);
          if (el) out.push(el);
        }
      } catch { /* none */ }
    }
    if (!kindParam || isRepoKind(kindParam)) {
      const repoKind = isRepoKind(kindParam) ? kindParam : undefined;
      for (const el of await listElements(slug, repoKind ? { kind: repoKind } : undefined)) {
        out.push(el);
      }
    }
    // 2026-05-20: 批量合并 assetMeta 单一真理源 display_name
    const merged = await Promise.all(out.map((el) => mergeElementImagesWithAssetMeta(el)));
    res.json({ elements: merged });
  } catch (e) { next(e); }
});

// POST /series/:slug/elements
crudRouter.post("/series/:slug/elements", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const body = req.body ?? {};
    const kind = String(body.kind || "");
    if (!ALL_KINDS.includes(kind as ElementKind)) {
      return err(res, 400, "ValidationError", `kind 必须是 ${ALL_KINDS.join("|")}`);
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
      return err(res, 400, "ValidationError", "name 必填");
    }
    if (!(await seriesExists(slug))) {
      return err(res, 404, "NotFound", `系列 ${slug} 不存在`);
    }
    if (kind === "character") {
      const patch = elementPatchToCharacterPatch({
        name: String(body.name).trim(),
        description: typeof body.description === "string" ? body.description : "",
        tags: Array.isArray(body.tags) ? body.tags : [],
        attrs: body.attrs && typeof body.attrs === "object" ? body.attrs : {},
      });
      const charName = String(patch.name ?? body.name).trim();
      const created = await createCharacter(slug, {
        name: charName,
        role: String(patch.role ?? ""),
        appearance_prompt: String(patch.appearance_prompt ?? ""),
        personality: String(patch.personality ?? ""),
        voice_id: typeof patch.voice_id === "string" ? patch.voice_id : undefined,
        voice_style_map: patch.voice_style_map as Record<string, string | undefined> | undefined,
        library_id: typeof patch.library_id === "string" ? patch.library_id : undefined,
      });
      // 2026-05-20: 手建素材自动建默认 image_briefs (character 给 2 张)
      const characterBriefs = ensureDefaultBriefs(
        Array.isArray(body.image_briefs) ? body.image_briefs : undefined,
        "character",
        charName,
        typeof patch.appearance_prompt === "string" ? patch.appearance_prompt : undefined,
      );
      // 2026-05-28 audit P1 type-safety — destructure 移除 createCharacter 已传入字段, 避免 delete (extra as any)
      const { name: _n, role: _r, appearance_prompt: _ap, personality: _p, voice_id: _vi, voice_style_map: _vsm, library_id: _lid, ...patchExtras } = patch;
      void _n; void _r; void _ap; void _p; void _vi; void _vsm; void _lid;
      const extra = { ...patchExtras, image_briefs: characterBriefs };
      const updated = await updateCharacter(slug, created.id, extra);
      const element = await adaptCharacterData(slug, updated);
      res.status(201).json({ element });
      return;
    }
    if (kind === "scene") {
      const patch = elementPatchToScenePatch({
        name: String(body.name).trim(),
        description: typeof body.description === "string" ? body.description : "",
        tags: Array.isArray(body.tags) ? body.tags : [],
        attrs: body.attrs && typeof body.attrs === "object" ? body.attrs : {},
      });
      const sceneName = String(patch.name ?? body.name).trim();
      const created = await createScene(slug, {
        name: sceneName,
        description: typeof patch.description === "string" ? patch.description : "",
        visual_style: typeof patch.visual_style === "string" ? patch.visual_style : undefined,
        location: typeof patch.location === "string" ? patch.location : undefined,
        time_of_day: typeof patch.time_of_day === "string" ? patch.time_of_day : undefined,
        mood: typeof patch.mood === "string" ? patch.mood : undefined,
        library_id: typeof patch.library_id === "string" ? patch.library_id : undefined,
      });
      // 2026-05-20: 手建素材自动建默认 image_briefs (scene 给 1 张)
      const sceneHint = [
        typeof patch.visual_style === "string" ? patch.visual_style : "",
        typeof patch.location === "string" ? patch.location : "",
      ].filter(Boolean).join("，");
      const sceneBriefs = ensureDefaultBriefs(
        Array.isArray(body.image_briefs) ? body.image_briefs : undefined,
        "scene",
        sceneName,
        sceneHint || undefined,
      );
      // 2026-05-28 audit P1 type-safety — destructure 移除 createScene 已传入字段, 避免 delete (extra as any)
      const { name: _n, description: _d, visual_style: _vs, location: _loc, time_of_day: _tod, mood: _m, library_id: _lid, ...patchExtras } = patch;
      void _n; void _d; void _vs; void _loc; void _tod; void _m; void _lid;
      const extra = { ...patchExtras, image_briefs: sceneBriefs };
      const updated = await updateScene(slug, created.id, extra) ?? created;
      const element = await adaptSceneData(slug, updated);
      res.status(201).json({ element });
      return;
    }
    // prop / wardrobe / reference / misc — repo-kind 路径
    const repoName = String(body.name).trim();
    const repoBriefs = ensureDefaultBriefs(
      Array.isArray(body.image_briefs) ? body.image_briefs : undefined,
      kind,
      repoName,
      typeof body.description === "string" ? body.description : undefined,
    );
    const element = await createElement(slug, {
      kind: kind as ElementKind,
      name: repoName,
      description: typeof body.description === "string" ? body.description : "",
      tags: Array.isArray(body.tags) ? body.tags : [],
      attrs: body.attrs && typeof body.attrs === "object" ? body.attrs : {},
      derived_from: body.derived_from,
      image_briefs: repoBriefs,
    });
    res.status(201).json({ element });
  } catch (e) { next(e); }
});

// GET /series/:slug/elements/:id
crudRouter.get("/series/:slug/elements/:id", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const element = await readAnyElement(slug, id);
    if (!element) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    // 2026-05-20: 合并 assetMeta 单一真理源 display_name
    const merged = await mergeElementImagesWithAssetMeta(element);
    res.json({ element: merged });
  } catch (e) { next(e); }
});

// PATCH /series/:slug/elements/:id
crudRouter.patch("/series/:slug/elements/:id", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const body = req.body ?? {};
    const patch: Partial<ElementData> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    if (Array.isArray(body.tags)) patch.tags = body.tags;
    if (body.attrs && typeof body.attrs === "object") patch.attrs = body.attrs as ElementData["attrs"];
    const element = await updateAnyElement(slug, id, patch);
    if (!element) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    res.json({ element });
  } catch (e) { next(e); }
});

// DELETE /series/:slug/elements/:id
crudRouter.delete("/series/:slug/elements/:id", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    // V-8: 删除前扫描分镜引用，有引用时返回 warning 但不阻止删除
    const warnings: string[] = [];
    try {
      const episodes = await listEpisodes(slug);
      // 铁律 #9: 只收人话需要的 shot.index, 拼文案时翻成"第 N 镜", 不暴露 s0001 内部 id
      const refShots: Array<{ index: number }> = [];
      for (const ep of episodes) {
        const epId = ep.id;
        if (!epId) continue;
        const shots = await listShots(slug, epId).catch(() => []);
        for (const s of shots) {
          const cids: string[] = s.character_ids ?? [];
          const eids: string[] = s.element_ids ?? [];
          const sid: string = s.scene_id ?? "";
          if (cids.includes(id) || eids.includes(id) || sid === id) {
            refShots.push({ index: s.index });
          }
        }
      }
      if (refShots.length > 0) {
        // 2026-07-10 Fable 二轮验收 P2-8 — shot.index 是 1 基(addShot 首镜=1, 盘上 s0001.json index=1),
        // 直接用不 +1, 否则第 1 镜显示成"第 2 镜", 与分镜板/合成页矛盾(修掉照抄 ElementUsageList 的存量 off-by-one).
        const sample = refShots.slice(0, 3).map(s => `第 ${s.index} 镜`).join("、");
        const more = refShots.length > 3 ? ` 等共 ${refShots.length} 镜` : "";
        warnings.push(
          `该素材被 ${refShots.length} 个分镜引用 (${sample}${more})。` +
          "删除后这些分镜将丢失该素材的画面描述引用，请手动到分镜板更新。"
        );
      }
    } catch { /* 引用扫描失败不阻塞删除 */ }
    const ok = await deleteElement(slug, id)
      || await deleteCharacter(slug, id)
      || await deleteScene(slug, id);
    if (!ok) return err(res, 404, "NotFound", "素材不存在");
    res.json({ ok: true, warnings: warnings.length > 0 ? warnings : undefined });
  } catch (e) { next(e); }
});

// GET /series/:slug/elements/:id/usage — 反查出现在哪些分镜 (§7 交接契约)
crudRouter.get("/series/:slug/elements/:id/usage", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const kindHint = typeof req.query.kind === "string" ? req.query.kind : "";
    const episodes = await listEpisodes(slug);
    // P0-2 (2026-05-29): 多回 episode_index — 铁律 #9 toC 兜底, 前端用来渲染"第 N 集"而非 ULID
    const usage: Array<{ episode_id: string; episode_index: number; shot_id: string; shot_index: number; first_frame_url: string | null }> = [];

    // 2026-05-20 P1 audit Bug 5: name fallback — P0 #1 之前的脏数据可能 character_ids/scene_id 落了 name 而非 id.
    // 反查时用 element 真名作 fallback 匹配, 让 typical 重抽功能在脏数据上仍能找到引用分镜.
    const el = await readAnyElement(slug, id);
    const elName = el?.name;
    const elNameLower = elName ? elName.toLowerCase().trim() : null;

    for (const ep of episodes) {
      const shots = await listShots(slug, ep.id);
      for (const s of shots) {
        const matchesId =
          (s.character_ids && s.character_ids.includes(id)) ||
          (s.scene_id && s.scene_id === id) ||
          (Array.isArray(s.element_ids) && s.element_ids.includes(id));
        // name fallback (脏数据兜底)
        const matchesName = !!elName && (
          (Array.isArray(s.character_ids) && s.character_ids.some((c: string) =>
            c === elName || c.toLowerCase().trim() === elNameLower
          )) ||
          (!!s.scene_id && (s.scene_id === elName || s.scene_id.toLowerCase().trim() === elNameLower)) ||
          (Array.isArray(s.element_ids) && s.element_ids.some((e: string) =>
            e === elName || e.toLowerCase().trim() === elNameLower
          ))
        );
        const matched = matchesId || matchesName;
        if (!matched) continue;
        // 2026-05-19 #11: 修缩略图错位 — 优先取 picked_first_frame_generation_id 对应的图,
        // 没 picked 才 fallback 到 generations 里 type=first_frame 的第一项. 之前只取第一项导致
        // 用户挑了另一张候选时缩略图显示的还是默认第一张.
        let firstFrameUrl: string | null = null;
        const gens = s.generations;
        if (gens && gens.length) {
          const pickedId = s.picked_first_frame_generation_id;
          const picked = pickedId ? gens.find((g) => g.generation_id === pickedId) : undefined;
          const ff = picked ?? gens.find((g) => g.type === "first_frame");
          if (ff?.path) firstFrameUrl = `/api/v2/series/${slug}/${ff.path}`;
          else if (ff?.vault_id) firstFrameUrl = `/api/v2/vault/${ff.vault_id}/raw`;
        }
        // P0-2 (2026-05-29): 多传 episode_index (EpisodeData.index), 前端渲染"第 N 集 · 第 M 镜"
        usage.push({ episode_id: ep.id, episode_index: ep.index, shot_id: s.id, shot_index: s.index, first_frame_url: firstFrameUrl });
      }
    }
    res.json({ usage, total_count: usage.length, kind_hint: kindHint });
  } catch (e) { next(e); }
});
