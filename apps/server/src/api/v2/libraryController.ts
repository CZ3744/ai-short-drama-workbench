/**
 * v2 Library Controller — Global resource library CRUD + lock + variants
 *
 * Routes (mounted under /api/v2/library):
 *   GET    /characters              — list
 *   GET    /characters/:id          — detail
 *   POST   /characters              — create
 *   PATCH  /characters/:id          — update
 *   DELETE /characters/:id          — soft-delete
 *   POST   /characters/:id/lock     — lock ref as standard image
 *   GET    /characters/:id/locked.png      — serve locked.png
 *   GET    /characters/:id/refs/:ref_id     — serve ref image
 *   Scenes endpoints follow same pattern.
 *
 * Wave P (2026-05-20): /characters/:id/generate-refs + /scenes/:id/generate-refs 已删,
 * 改走 /api/v2/generate/image (target.kind="library_variant").
 */

import { Router } from "express";
import { handleValidationError } from "./validateHelpers";
import {
  listLibraryCharacters, getLibraryCharacter, createLibraryCharacter,
  updateLibraryCharacter, deleteLibraryCharacter,
  lockLibraryCharacter,
  getLibraryCharacterLockedPng, getLibraryCharacterRefBuffer,
  listLibraryScenes, getLibraryScene, createLibraryScene,
  updateLibraryScene, deleteLibraryScene,
  lockLibraryScene,
  getLibrarySceneLockedPng, getLibrarySceneRefBuffer,
  listCharacterVariants, createCharacterVariant, deleteCharacterVariant, autoPackCharacterVariants,
  listSceneVariants, createSceneVariant, deleteSceneVariant, autoPackSceneVariants,
  type GenerateFn,
} from "../../../../../packages/library/src/globalLibrary";
import {
  validate,
  CreateLibraryCharacterSchema, PatchLibraryCharacterSchema,
  CreateLibrarySceneSchema, PatchLibrarySceneSchema,
  LibraryLockSchema,
  CreateVariantSchema, AutoPackSchema,
} from "./validators";
import { getRegistry } from "./orchestrationController";
import { saveToVault, getVaultStats, listVault } from "../../../../../packages/library/src/assetVault";
import { generateImagesWithProvider } from "../../application/generation/imageGenerationService";

export const libraryRouter = Router();

// ─── Route prefix ─────────────────────────────────────────────────

// All routes are prefixed with /library — mount as v2Router.use("/library", libraryRouter)
// but this controller's routes are relative to the mount point.

// ─────────────────────────────────────────────────────────────────
// Characters
// ─────────────────────────────────────────────────────────────────

// GET /characters
libraryRouter.get("/characters", async (_req, res, next) => {
  try {
    const characters = await listLibraryCharacters();
    res.json({ characters });
  } catch (err) { next(err); }
});

// POST /characters
libraryRouter.post("/characters", async (req, res, next) => {
  try {
    const v = validate(CreateLibraryCharacterSchema, req.body);
    if (handleValidationError(res, v)) return;
    const character = await createLibraryCharacter(v.data);
    res.status(201).json({ character });
  } catch (err) { next(err); }
});

// GET /characters/:id
libraryRouter.get("/characters/:id", async (req, res, next) => {
  try {
    const char = await getLibraryCharacter(req.params.id);
    if (!char) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }
    // Also return vault entries associated with this character (for remix/variant features)
    const vaultEntries = await listVault({ character_id: req.params.id, kind: "image" });
    res.json({ character: char, vault_refs: vaultEntries.map(e => e.vault_id) });
  } catch (err) { next(err); }
});

// PATCH /characters/:id
libraryRouter.patch("/characters/:id", async (req, res, next) => {
  try {
    const v = validate(PatchLibraryCharacterSchema, req.body);
    if (handleValidationError(res, v)) return;
    const character = await updateLibraryCharacter(req.params.id, v.data);
    if (!character) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }
    res.json({ character });
  } catch (err) { next(err); }
});

// DELETE /characters/:id
libraryRouter.delete("/characters/:id", async (req, res, next) => {
  try {
    const ok = await deleteLibraryCharacter(req.params.id);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }
    res.json({ ok: true, message: "角色已删除" });
  } catch (err) { next(err); }
});

// Wave P (2026-05-20) — 删除 POST /characters/:id/generate-refs.
// 前端 0 caller (Wave 4-D 已切走), 后端 test/e2e-smoke 不依赖. 改走 /api/v2/generate/image
// target.kind="library_variant". generateLibraryRefs lib 函数同步删 (孤儿).

// POST /characters/:id/lock
libraryRouter.post("/characters/:id/lock", async (req, res, next) => {
  try {
    const v = validate(LibraryLockSchema, req.body);
    if (handleValidationError(res, v)) return;

    const result = await lockLibraryCharacter(req.params.id, v.data.ref_id);
    res.json({ ok: true, locked: result });
  } catch (err) { next(err); }
});

// GET /characters/:id/locked.png
libraryRouter.get("/characters/:id/locked.png", async (req, res, next) => {
  try {
    const buf = await getLibraryCharacterLockedPng(req.params.id);
    if (!buf) { res.status(404).json({ error: { code: "NotFound", message: "标准像不存在" } }); return; }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (err) { next(err); }
});

// GET /characters/:id/refs/:refId
libraryRouter.get("/characters/:id/refs/:refId", async (req, res, next) => {
  try {
    const buf = await getLibraryCharacterRefBuffer(req.params.id, req.params.refId);
    if (!buf) { res.status(404).json({ error: { code: "NotFound", message: "参考图不存在" } }); return; }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// Scenes
// ─────────────────────────────────────────────────────────────────

// GET /scenes
libraryRouter.get("/scenes", async (_req, res, next) => {
  try {
    const scenes = await listLibraryScenes();
    res.json({ scenes });
  } catch (err) { next(err); }
});

// POST /scenes
libraryRouter.post("/scenes", async (req, res, next) => {
  try {
    const v = validate(CreateLibrarySceneSchema, req.body);
    if (handleValidationError(res, v)) return;
    const scene = await createLibraryScene(v.data);
    res.status(201).json({ scene });
  } catch (err) { next(err); }
});

// GET /scenes/:id
libraryRouter.get("/scenes/:id", async (req, res, next) => {
  try {
    const scene = await getLibraryScene(req.params.id);
    if (!scene) { res.status(404).json({ error: { code: "NotFound", message: "场景不存在" } }); return; }
    const vaultEntries = await listVault({ scene_id: req.params.id, kind: "image" });
    res.json({ scene, vault_refs: vaultEntries.map(e => e.vault_id) });
  } catch (err) { next(err); }
});

// PATCH /scenes/:id
libraryRouter.patch("/scenes/:id", async (req, res, next) => {
  try {
    const v = validate(PatchLibrarySceneSchema, req.body);
    if (handleValidationError(res, v)) return;
    const scene = await updateLibraryScene(req.params.id, v.data);
    if (!scene) { res.status(404).json({ error: { code: "NotFound", message: "场景不存在" } }); return; }
    res.json({ scene });
  } catch (err) { next(err); }
});

// DELETE /scenes/:id
libraryRouter.delete("/scenes/:id", async (req, res, next) => {
  try {
    const ok = await deleteLibraryScene(req.params.id);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "场景不存在" } }); return; }
    res.json({ ok: true, message: "场景已删除" });
  } catch (err) { next(err); }
});

// Wave P (2026-05-20) — 删除 POST /scenes/:id/generate-refs.
// 前端 0 caller; 后端 test/e2e-smoke 不依赖. 改走 /api/v2/generate/image
// target.kind="library_variant". generateLibrarySceneRefs lib 函数同步删 (孤儿).

// POST /scenes/:id/lock
libraryRouter.post("/scenes/:id/lock", async (req, res, next) => {
  try {
    const v = validate(LibraryLockSchema, req.body);
    if (handleValidationError(res, v)) return;

    const result = await lockLibraryScene(req.params.id, v.data.ref_id);
    res.json({ ok: true, locked: result });
  } catch (err) { next(err); }
});

// GET /scenes/:id/locked.png
libraryRouter.get("/scenes/:id/locked.png", async (req, res, next) => {
  try {
    const buf = await getLibrarySceneLockedPng(req.params.id);
    if (!buf) { res.status(404).json({ error: { code: "NotFound", message: "标准像不存在" } }); return; }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (err) { next(err); }
});

// GET /scenes/:id/refs/:refId
libraryRouter.get("/scenes/:id/refs/:refId", async (req, res, next) => {
  try {
    const buf = await getLibrarySceneRefBuffer(req.params.id, req.params.refId);
    if (!buf) { res.status(404).json({ error: { code: "NotFound", message: "参考图不存在" } }); return; }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// Character Variants
// ═══════════════════════════════════════════════════════════════════

// GET /characters/:id/variants
libraryRouter.get("/characters/:id/variants", async (req, res, next) => {
  try {
    const variants = await listCharacterVariants(req.params.id);
    res.json({ variants });
  } catch (err) { next(err); }
});

// POST /characters/:id/variants
libraryRouter.post("/characters/:id/variants", async (req, res, next) => {
  try {
    const v = validate(CreateVariantSchema, req.body);
    if (handleValidationError(res, v)) return;

    // 铁律#3: 缺模型不 silent 回退假图 — 明确 400 引导用户先选模型再生成
    if (!v.data.provider_id) {
      res.status(400).json({ error: { code: "MissingProvider", message: "请先选择用于生成变体图的模型，再创建变体。" } });
      return;
    }
    const providerId = v.data.provider_id;
    const registry = getRegistry();
    const genFn: GenerateFn = async (prompt: string, count: number): Promise<Buffer[]> => {
      const result = await generateImagesWithProvider({
        provider_id: providerId,
        prompt,
        width: 1024,
        height: 1024,
        count,
        series_slug: "library",
      }, { registry });
      return result.images.map((img) => img.buffer);
    };

    const variant = await createCharacterVariant(req.params.id, {
      label: v.data.label,
      category: v.data.category,
      source_vault_id: v.data.source_vault_id,
      // 2026-05-20: 优先 display_name (新 caller), fallback user_note (老 caller)
      display_name: v.data.display_name,
      user_note: v.data.user_note,
      provider_id: v.data.provider_id,
      generateFn: genFn,
    });
    res.status(201).json({ variant });
  } catch (err) { next(err); }
});

// 2026-05-21 X-5: character variant dry-run — 不扣费, 返回即将发送的 prompt 预览
libraryRouter.post("/characters/:id/variants/dry-run", async (req, res, next) => {
  try {
    const v = validate(CreateVariantSchema, req.body);
    if (handleValidationError(res, v)) return;

    const char = await getLibraryCharacter(req.params.id);
    if (!char) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }

    const prompt = v.data.label || `角色 ${char.name} 的变体图`;
    res.json({
      kind: "image",
      full_prompt: prompt,
      target_provider: v.data.provider_id || "未指定",
      estimated_cost: v.data.provider_id ? { note: "实际费用取决于 provider 单价" } : undefined,
    });
  } catch (err) { next(err); }
});

// DELETE /characters/:id/variants/:varId
libraryRouter.delete("/characters/:id/variants/:varId", async (req, res, next) => {
  try {
    const ok = await deleteCharacterVariant(req.params.id, req.params.varId);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "变体不存在" } }); return; }
    res.json({ ok: true, message: "变体已删除" });
  } catch (err) { next(err); }
});

// POST /characters/:id/variants/auto-pack
libraryRouter.post("/characters/:id/variants/auto-pack", async (req, res, next) => {
  try {
    const v = validate(AutoPackSchema, req.body);
    if (handleValidationError(res, v)) return;

    const registry = getRegistry();

    // Read locked.png and ensure it's in vault for reference_image
    const lockedBuf = await getLibraryCharacterLockedPng(req.params.id);
    let referenceAssetId: string | undefined;
    if (lockedBuf) {
      try {
        const vaultEntry = await saveToVault({
          buffer: lockedBuf,
          kind: "image",
          mime: "image/png",
          context: { kind: "variant", character_id: req.params.id, user_note: "locked_reference" },
          width: 1024,
          height: 1024,
        });
        referenceAssetId = vaultEntry.vault_id;
      } catch (e: unknown) {
        console.warn(`[library auto-pack] locked.png 入 vault 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const generateFn: GenerateFn = async (p: string, c: number): Promise<Buffer[]> => {
      const result = await generateImagesWithProvider({
        provider_id: v.data.provider_id,
        prompt: p,
        width: 1024,
        height: 1024,
        count: c,
        reference_images: referenceAssetId ? [{ vault_id: referenceAssetId }] : undefined,
        series_slug: "library",
      }, { registry });
      return result.images.map((img) => img.buffer);
    };

    const result = await autoPackCharacterVariants(req.params.id, v.data.provider_id, generateFn);
    res.json({ ok: true, succeeded: result.succeeded, failed: result.failed, variants: result.variants });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// Scene Variants
// ═══════════════════════════════════════════════════════════════════

// GET /scenes/:id/variants
libraryRouter.get("/scenes/:id/variants", async (req, res, next) => {
  try {
    const variants = await listSceneVariants(req.params.id);
    res.json({ variants });
  } catch (err) { next(err); }
});

// POST /scenes/:id/variants
libraryRouter.post("/scenes/:id/variants", async (req, res, next) => {
  try {
    const v = validate(CreateVariantSchema, req.body);
    if (handleValidationError(res, v)) return;

    // 铁律#3: 缺模型不 silent 回退假图 — 明确 400 引导用户先选模型再生成
    if (!v.data.provider_id) {
      res.status(400).json({ error: { code: "MissingProvider", message: "请先选择用于生成变体图的模型，再创建变体。" } });
      return;
    }
    const providerId = v.data.provider_id;
    const registry = getRegistry();
    const genFn: GenerateFn = async (prompt: string, count: number): Promise<Buffer[]> => {
      const result = await generateImagesWithProvider({
        provider_id: providerId,
        prompt,
        width: 1024,
        height: 1024,
        count,
        series_slug: "library",
      }, { registry });
      return result.images.map((img) => img.buffer);
    };

    const variant = await createSceneVariant(req.params.id, {
      label: v.data.label,
      category: v.data.category,
      source_vault_id: v.data.source_vault_id,
      // 2026-05-20: 优先 display_name (新 caller), fallback user_note (老 caller)
      display_name: v.data.display_name,
      user_note: v.data.user_note,
      provider_id: v.data.provider_id,
      generateFn: genFn,
    });
    res.status(201).json({ variant });
  } catch (err) { next(err); }
});

// 2026-05-21 X-5: scene variant dry-run — 不扣费, 返回即将发送的 prompt 预览
libraryRouter.post("/scenes/:id/variants/dry-run", async (req, res, next) => {
  try {
    const v = validate(CreateVariantSchema, req.body);
    if (handleValidationError(res, v)) return;

    const scene = await getLibraryScene(req.params.id);
    if (!scene) { res.status(404).json({ error: { code: "NotFound", message: "场景不存在" } }); return; }

    const prompt = v.data.label || `场景 ${scene.name} 的变体图`;
    res.json({
      kind: "image",
      full_prompt: prompt,
      target_provider: v.data.provider_id || "未指定",
      estimated_cost: v.data.provider_id ? { note: "实际费用取决于 provider 单价" } : undefined,
    });
  } catch (err) { next(err); }
});

// DELETE /scenes/:id/variants/:varId
libraryRouter.delete("/scenes/:id/variants/:varId", async (req, res, next) => {
  try {
    const ok = await deleteSceneVariant(req.params.id, req.params.varId);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "变体不存在" } }); return; }
    res.json({ ok: true, message: "变体已删除" });
  } catch (err) { next(err); }
});

// POST /scenes/:id/variants/auto-pack
libraryRouter.post("/scenes/:id/variants/auto-pack", async (req, res, next) => {
  try {
    const v = validate(AutoPackSchema, req.body);
    if (handleValidationError(res, v)) return;

    const registry = getRegistry();

    // Read locked.png and ensure it's in vault for reference_image
    const lockedBuf = await getLibrarySceneLockedPng(req.params.id);
    let referenceAssetId: string | undefined;
    if (lockedBuf) {
      try {
        const vaultEntry = await saveToVault({
          buffer: lockedBuf,
          kind: "image",
          mime: "image/png",
          context: { kind: "variant", scene_id: req.params.id, user_note: "locked_reference" },
          width: 1024,
          height: 1024,
        });
        referenceAssetId = vaultEntry.vault_id;
      } catch (e: unknown) {
        console.warn(`[library auto-pack scene] locked.png 入 vault 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const generateFn: GenerateFn = async (p: string, c: number): Promise<Buffer[]> => {
      const result = await generateImagesWithProvider({
        provider_id: v.data.provider_id,
        prompt: p,
        width: 1024,
        height: 1024,
        count: c,
        reference_images: referenceAssetId ? [{ vault_id: referenceAssetId }] : undefined,
        series_slug: "library",
      }, { registry });
      return result.images.map((img) => img.buffer);
    };

    const result = await autoPackSceneVariants(req.params.id, v.data.provider_id, generateFn);
    res.json({ ok: true, succeeded: result.succeeded, failed: result.failed, variants: result.variants });
  } catch (err) { next(err); }
});
