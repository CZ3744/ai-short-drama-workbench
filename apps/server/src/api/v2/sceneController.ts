/**
 * v2 Scene Controller — CRUD for scenes + import-from-library (structure mirrors characterController)
 */

import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import {
  readScene, createScene, updateScene, deleteScene,
  listEpisodes, listShots,
  listSeriesSceneVariants, createSeriesSceneVariant, deleteSeriesSceneVariant,
  type SeriesVariant,
} from "./seriesStore";
import {
  validate, LockRefSchema, ImportFromLibrarySchema,
  CreateVariantSchema, AutoPackSchema,
} from "./validators";
import { DATA_ROOT, pathExists, readJson, ensureDir } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { saveToVault } from "../../../../../packages/library/src/assetVault";
import { getRegistry } from "./orchestrationController";
import { generateImagesForTarget } from "../../application/generation/imageGenerationOrchestrator";

export const sceneRouter = Router();

// Wave Z-10: GET / POST / GET :sceneId / PATCH :sceneId 纯 CRUD 重复 → 删.
// 前端已收口到 element API (GET/POST/PATCH/DELETE /api/v2/series/:slug/elements).
// elementController 通过 adaptSceneData / updateAnyElement 统一适配 scene CRUD.

// DELETE /series/:slug/scenes/:sceneId
sceneRouter.delete("/series/:slug/scenes/:sceneId", async (req, res, next) => {
  try {
    const ok = await deleteScene(req.params.slug, req.params.sceneId);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "场景不存在" } }); return; }
    res.json({ ok: true, message: "场景已删除" });
  } catch (err) { next(err); }
});

// Wave P (2026-05-20) — 删除 POST /series/:slug/scenes/:sceneId/generate-refs.
// 前端 0 caller; 后端 test/e2e-smoke 已切到 /api/v2/generate/image (target.kind="scene_ref").
// 删除后端 53 行 prompt 拼装 + orchestrator 调用 — 全部下沉到 generationController.

// POST /series/:slug/scenes/import-from-library
sceneRouter.post("/series/:slug/scenes/import-from-library", async (req, res, next) => {
  try {
    const v = validate(ImportFromLibrarySchema, req.body);
    if (!v.ok) { res.status(v.status).json({ error: { code: "ValidationError", message: "请求体校验失败", details: v.errors } }); return; }

    const { library_id, name_alias } = v.data;
    const slug = req.params.slug;

    const libraryMetaPath = path.join(DATA_ROOT, "library", "scenes", library_id, "meta.json");
    if (!(await pathExists(libraryMetaPath))) {
      res.status(404).json({ error: { code: "NotFound", message: "资源库场景不存在" } });
      return;
    }

    const meta = await readJson<any>(libraryMetaPath);
    const lockedPngPath = path.join(DATA_ROOT, "library", "scenes", library_id, "locked.png");
    const hasLocked = await pathExists(lockedPngPath);

    const sceneName = name_alias || meta.name || library_id;
    const scene = await createScene(slug, {
      name: sceneName,
      description: meta.description,
      visual_style: meta.visual_style,
      location: meta.location,
      time_of_day: meta.time_of_day,
      mood: meta.mood,
      library_id,
      locked_image_path: hasLocked ? lockedPngPath : undefined,
    });

    // Copy locked.png to series assets/images/
    if (hasLocked) {
      const assetsDir = path.join(DATA_ROOT, "series", slug, "assets", "images");
      await ensureDir(assetsDir);
      const destPath = path.join(assetsDir, `scene_${library_id}_locked.png`);
      try {
        await fs.copyFile(lockedPngPath, destPath);
      } catch (err: unknown) {
        loggerSync().warn(`[import-from-library] 拷贝场景 locked.png 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    res.status(201).json({ scene });
  } catch (err) { next(err); }
});

// POST /series/:slug/scenes/:sceneId/lock
sceneRouter.post("/series/:slug/scenes/:sceneId/lock", async (req, res, next) => {
  try {
    const v = validate(LockRefSchema, req.body);
    if (!v.ok) { res.status(v.status).json({ error: { code: "ValidationError", message: "请求体校验失败", details: v.errors } }); return; }

    const updated = await updateScene(req.params.slug, req.params.sceneId, {
      primary_ref_image_id: v.data.asset_id,
      locked: { ref_image: v.data.asset_id, locked_at: new Date().toISOString() },
      status: "locked",
    });
    if (!updated) { res.status(404).json({ error: { code: "NotFound", message: "场景不存在" } }); return; }

    res.json({ ok: true, scene: updated });
  } catch (err) { next(err); }
});

// ── C8: 反向引用 — 场景出现在哪些镜头 ─────────────────────────────────────
// GET /series/:slug/scenes/:sceneId/usage
sceneRouter.get("/series/:slug/scenes/:sceneId/usage", async (req, res, next) => {
  try {
    const { slug, sceneId } = req.params;
    const scene = await readScene(slug, sceneId);
    if (!scene) { res.status(404).json({ error: { code: "NotFound", message: "场景不存在" } }); return; }

    const episodes = await listEpisodes(slug);
    const shots: Array<{ episode_id: string; shot_id: string; shot_index: number; first_frame_url: string | null }> = [];

    for (const ep of episodes) {
      const epShots = await listShots(slug, ep.id);
      for (const shot of epShots) {
        if (shot.scene_id === sceneId) {
          // Resolve first_frame_url from generations
          let firstFrameUrl: string | null = null;
          const pickedId = shot.picked_generation_id;
          if (shot.generations && shot.generations.length > 0) {
            const picked = pickedId
              ? shot.generations.find(g => g.generation_id === pickedId && g.type === "first_frame")
              : undefined;
            const firstFrame = picked || shot.generations.find(g => g.type === "first_frame");
            if (firstFrame?.path) {
              firstFrameUrl = `/api/v2/series/${slug}/${firstFrame.path}`;
            } else if (firstFrame?.vault_id) {
              firstFrameUrl = `/api/v2/vault/${firstFrame.vault_id}/raw`;
            }
          }
          shots.push({
            episode_id: ep.id,
            shot_id: shot.id,
            shot_index: shot.index,
            first_frame_url: firstFrameUrl,
          });
        }
      }
    }

    res.json({ shots, total_count: shots.length });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// Series Scene Variants
// ═══════════════════════════════════════════════════════════════════

// GET /series/:slug/scenes/:sceneId/variants
sceneRouter.get("/series/:slug/scenes/:sceneId/variants", async (req, res, next) => {
  try {
    const variants = await listSeriesSceneVariants(req.params.slug, req.params.sceneId);
    res.json({ variants });
  } catch (err) { next(err); }
});

// POST /series/:slug/scenes/:sceneId/variants
sceneRouter.post("/series/:slug/scenes/:sceneId/variants", async (req, res, next) => {
  try {
    const v = validate(CreateVariantSchema, req.body);
    if (!v.ok) { res.status(v.status).json({ error: { code: "ValidationError", message: "请求体校验失败", details: v.errors } }); return; }

    const variant = await createSeriesSceneVariant(req.params.slug, req.params.sceneId, {
      label: v.data.label,
      category: v.data.category,
      source_vault_id: v.data.source_vault_id,
      // 2026-05-20: 优先 display_name (新 caller), fallback user_note (老 caller)
      display_name: v.data.display_name,
      user_note: v.data.user_note,
    });
    res.status(201).json({ variant });
  } catch (err) { next(err); }
});

// DELETE /series/:slug/scenes/:sceneId/variants/:varId
sceneRouter.delete("/series/:slug/scenes/:sceneId/variants/:varId", async (req, res, next) => {
  try {
    const ok = await deleteSeriesSceneVariant(req.params.slug, req.params.sceneId, req.params.varId);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "变体不存在" } }); return; }
    res.json({ ok: true, message: "变体已删除" });
  } catch (err) { next(err); }
});

// POST /series/:slug/scenes/:sceneId/variants/auto-pack
sceneRouter.post("/series/:slug/scenes/:sceneId/variants/auto-pack", async (req, res, next) => {
  try {
    const v = validate(AutoPackSchema, req.body);
    if (!v.ok) { res.status(v.status).json({ error: { code: "ValidationError", message: "请求体校验失败", details: v.errors } }); return; }

    const scene = await readScene(req.params.slug, req.params.sceneId);
    if (!scene) { res.status(404).json({ error: { code: "NotFound", message: "场景不存在" } }); return; }

    const registry = getRegistry();

    // Build base prompt from scene data
    const basePrompt = [scene.description, scene.visual_style, scene.location, scene.time_of_day, scene.mood]
      .filter(Boolean).join(", ") || scene.name;

    // Find locked.png for reference_image
    const { slug, sceneId } = req.params;
    let referenceAssetId: string | undefined;
    const lockedPathCandidates = [
      scene.locked_image_path,
      path.join(DATA_ROOT, slug, "assets", "images", `scene_${sceneId}_locked.png`),
      path.join(DATA_ROOT, slug, "assets", "images", `scene_${scene.library_id ?? sceneId}_locked.png`),
    ].filter(Boolean) as string[];

    for (const lp of lockedPathCandidates) {
      try {
        if (await pathExists(lp)) {
          const buf = await fs.readFile(lp);
          const vaultEntry = await saveToVault({
            buffer: buf,
            kind: "image",
            mime: "image/png",
            context: { kind: "variant", series_slug: slug, scene_id: sceneId, user_note: "locked_reference" },
            width: 1024,
            height: 1024,
          });
          referenceAssetId = vaultEntry.vault_id;
          break;
        }
      } catch { /* try next */ }
    }

    // 6 variants: 时段×2, 天气×2, 季节×1, 灯光×1
    const packs: Array<{ label: string; category: SeriesVariant["category"]; prompt_suffix: string }> = [
      { label: "白天·晴", category: "time_of_day", prompt_suffix: "晴朗的白天，阳光明媚，光影清晰" },
      { label: "黄昏·阴", category: "time_of_day", prompt_suffix: "阴天的黄昏，天色昏暗，氛围沉静" },
      { label: "夜晚·雨", category: "weather", prompt_suffix: "雨夜的场景，雨水落下，路面反光" },
      { label: "雪景", category: "weather", prompt_suffix: "雪景覆盖，白雪皑皑，空气清冷" },
      { label: "秋日红叶", category: "other", prompt_suffix: "深秋时节，红叶满枝，暖色调" },
      { label: "霓虹夜色", category: "other", prompt_suffix: "夜晚霓虹灯灯光氛围，赛博质感" },
    ];

    const settled = await Promise.allSettled(
      packs.map(async (pack) => {
        const prompt = `${basePrompt}, ${pack.prompt_suffix}`;
        // W8 Phase 1: library_variant adapter 收敛 saveToVault 调用.
        const result = await generateImagesForTarget(
          {
            prompt,
            provider_id: v.data.provider_id,
            model_ref: v.data.provider_id,
            width: 1024,
            height: 1024,
            count: 1,
            reference_images: referenceAssetId ? [{ vault_id: referenceAssetId }] : undefined,
            strict_reference_images: false,
            target: {
              kind: "library_variant",
              series_slug: slug,
              target_id: sceneId,
              meta: {
                vault_context_kind: "variant",
                scene_id: sceneId,
                category: pack.category,
                user_note: `auto-pack: ${pack.label}`,
              },
            },
            extra_tags: [`scene:${sceneId}`, "auto_pack", `category:${pack.category}`],
          },
          { registry },
        );
        const vaultId = result.images[0]?.vault_id;
        if (!vaultId) {
          console.error("[autoPack] library_variant adapter 未返回 vault_id");
          throw new Error("自动生图失败，请稍后重试");
        }

        return await createSeriesSceneVariant(slug, sceneId, {
          label: pack.label,
          category: pack.category,
          source_vault_id: vaultId,
          user_note: `auto-pack: ${pack.label}`,
        });
      }),
    );

    const variants: any[] = [];
    let succeeded = 0;
    let failed = 0;
    for (const r of settled) {
      if (r.status === "fulfilled") {
        variants.push(r.value);
        succeeded++;
      } else {
        console.warn(`[series scene auto-pack] 单张变体生成失败: ${r.reason?.message ?? r.reason}`);
        failed++;
      }
    }

    res.json({ ok: true, succeeded, failed, variants });
  } catch (err) { next(err); }
});
