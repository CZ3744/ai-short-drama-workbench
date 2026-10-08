/**
 * v2 Character Controller — CRUD for characters + lock + import-from-library + variants.
 *
 * Wave P (2026-05-20): /generate-refs 路由已删 — 改走 /api/v2/generate/image
 * (target.kind="character_ref"). 详见 generationController.ts.
 */

import { Router } from "express";
import multer from "multer";
import { handleValidationError } from "./validateHelpers";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import {
  readCharacter, createCharacter, updateCharacter, deleteCharacter,
  listEpisodes, listShots,
  listSeriesCharVariants, createSeriesCharVariant, deleteSeriesCharVariant,
  type SeriesVariant,
} from "./seriesStore";
import {
  validate, LockRefSchema, ImportFromLibrarySchema, ImportFromSeriesSchema,
  CreateVariantSchema, AutoPackSchema,
} from "./validators";
import { DATA_ROOT, pathExists, readJson, ensureDir } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { readAsset, resolveAssetFilePath } from "../../repositories/assetRepo";
import { resolveWorkspaceMediaFile } from "../../../../../packages/core/src/workspaceMedia";
import { getVaultEntry, getVaultAbsolutePath, saveToVault } from "../../../../../packages/library/src/assetVault";
import { getRegistry } from "./orchestrationController";
import { generateImagesForTarget } from "../../application/generation/imageGenerationOrchestrator";
import { generateImagesWithProvider } from "../../application/generation/imageGenerationService";
// Wave B-3 (2026-05-16): 角色拆分字段 → 生图描述 helper
import { resolveVisualDescription } from "../../../../../packages/drama/src/characterPrompt";

export const characterRouter = Router();

// ── voice-clone-sample upload ────────────────────────────────────────
// 接受用户上传的语音克隆参考音频(mp3 / wav / m4a / webm / ogg). 大小上限 10MB.
// 文件写到 series/<slug>/assets/voices/, character 的 voice_clone_sample_url 指向相对路径.
const VOICE_CLONE_MIME_WHITELIST = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/webm",
  "audio/ogg",
  "audio/x-ogg",
  "application/octet-stream", // 浏览器有时不带 mime, 走后缀白名单
]);
const VOICE_CLONE_EXT_WHITELIST = new Set([".mp3", ".wav", ".m4a", ".aac", ".webm", ".ogg"]);
const voiceCloneUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (VOICE_CLONE_MIME_WHITELIST.has(file.mimetype) || VOICE_CLONE_EXT_WHITELIST.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的语音样本格式: ${file.mimetype} (${file.originalname})`));
    }
  },
});

// Wave Z-10: GET / POST / GET :charId / PATCH :charId 纯 CRUD 重复 → 删.
// 前端已收口到 element API (GET/POST/PATCH/DELETE /api/v2/series/:slug/elements).
// elementController 通过 adaptCharacterData / updateAnyElement 统一适配 character CRUD.

// DELETE /series/:slug/characters/:charId
characterRouter.delete("/series/:slug/characters/:charId", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const charId = String(req.params.charId);

    // 1. 先把角色上的语音克隆样本读出来 (它指向 series/<slug>/assets/voices/...)
    let voiceCloneSamplePath: string | undefined;
    try {
      const char = await readCharacter(slug, charId);
      if (char?.voice_clone_sample_url && char.voice_clone_sample_url.startsWith("assets/voices/")) {
        voiceCloneSamplePath = path.join(DATA_ROOT, "series", slug, char.voice_clone_sample_url);
      }
    } catch {
      // 读不到不阻塞删除主流程
    }

    const ok = await deleteCharacter(slug, charId);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }

    // 2. 删完角色再清孤儿样本文件 + 任何残留的 <charId>_*.* 文件 (防万一未追踪到的)
    const voicesDir = path.join(DATA_ROOT, "series", slug, "assets", "voices");
    if (voiceCloneSamplePath) {
      try {
        if (await pathExists(voiceCloneSamplePath)) await fs.unlink(voiceCloneSamplePath);
      } catch (err: unknown) {
        loggerSync().warn(`[deleteCharacter] 清理 voice_clone_sample 失败 ${voiceCloneSamplePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (await pathExists(voicesDir)) {
      try {
        const entries = await fs.readdir(voicesDir);
        for (const entry of entries) {
          // 命名格式: <charId>_<timestamp>_<sha10>.<ext>
          if (entry.startsWith(`${charId}_`)) {
            const orphanPath = path.join(voicesDir, entry);
            try {
              await fs.unlink(orphanPath);
            } catch (err: unknown) {
              loggerSync().warn(`[deleteCharacter] 清理孤儿语音样本失败 ${orphanPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      } catch (err: unknown) {
        loggerSync().warn(`[deleteCharacter] 扫描 voices/ 目录失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    res.json({ ok: true, message: "角色已删除" });
  } catch (err) { next(err); }
});

// POST /series/:slug/characters/:charId/import-image — 用户从外部 (例如 ChatGPT 网页)
// 生图后导入。B1 (2026-05-14): 与 firstframe/import-image 走同一套底层 helper。
characterRouter.post("/series/:slug/characters/:charId/import-image", async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const charId = req.params.charId;
    const char = await readCharacter(slug, charId);
    if (!char) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }

    const { importImageToSeries } = await import("./imageImportHelpers");
    const result = await importImageToSeries({
      slug,
      payload: req.body ?? {},
      context: { kind: "character_ref", character_id: charId },
      tags: [`character:${charId}`, "ref_image"],
    });
    // 把新 asset_id 追加进 character.ref_image_ids
    await updateCharacter(slug, charId, {
      ref_image_ids: [...(char.ref_image_ids || []), result.asset_id],
    });
    res.json({ ok: true, ...result, message: "已导入,加入角色参考图池" });
  } catch (err) { next(err); }
});

// Wave P (2026-05-20) — 删除 POST /series/:slug/characters/:charId/generate-refs.
// 前端 0 caller (Wave 4-D 之后已统一切到 /api/v2/generate/image + target.kind="character_ref"),
// 后端 test/e2e-smoke-drama 已同步改写. 历史 53 行 prompt 构建 + orchestrator 调用
// 全部下沉到 generationController.ts (POST /api/v2/generate/image). 不再保留兼容路径.

// POST /series/:slug/characters/import-from-library
// 支持两种模式:
// 1. library_id: 从公共资源库导入(原有流程)
// 2. source_series_slug + source_character_id: 跨项目导入(含修改意见)
characterRouter.post("/series/:slug/characters/import-from-library", async (req, res, next) => {
  try {
    const v = validate(ImportFromSeriesSchema, req.body);
    if (handleValidationError(res, v)) return;

    const { library_id, source_series_slug, source_character_id, name_alias, modifications } = v.data;
    const slug = req.params.slug;

    // ── 模式 1: 从公共资源库导入(library_id) ──
    if (library_id && !source_series_slug) {
      const libraryMetaPath = path.join(DATA_ROOT, "library", "characters", library_id, "meta.json");
      if (!(await pathExists(libraryMetaPath))) {
        res.status(404).json({ error: { code: "NotFound", message: "资源库角色不存在" } });
        return;
      }

      const meta = await readJson<any>(libraryMetaPath);
      const lockedPngPath = path.join(DATA_ROOT, "library", "characters", library_id, "locked.png");
      const hasLocked = await pathExists(lockedPngPath);

      const charName = name_alias || meta.name || library_id;
      // Wave B-3 (2026-05-16): 资源库 meta.appearance 字段语义就是"外貌", 同时写新字段;
      // legacy appearance_prompt 也写一份保持向后兼容(老前端读 appearance_prompt).
      const character = await createCharacter(slug, {
        name: charName,
        role: meta.role || meta.personality || "导入角色",
        appearance_prompt: meta.appearance || "",
        appearance: meta.appearance || undefined,
        outfit: meta.outfit || undefined,
        personality: meta.personality || "",
        library_id,
        locked_image_path: hasLocked ? lockedPngPath : undefined,
      });

      // Copy locked.png to series assets/images/
      if (hasLocked) {
        const assetsDir = path.join(DATA_ROOT, "series", slug, "assets", "images");
        await ensureDir(assetsDir);
        const destPath = path.join(assetsDir, `char_${library_id}_locked.png`);
        try {
          await fs.copyFile(lockedPngPath, destPath);
        } catch (err: unknown) {
          loggerSync().warn(`[import-from-library] 拷贝 locked.png 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      res.status(201).json({ character });
      return;
    }

    // ── 模式 2: 跨项目导入 ──
    if (source_series_slug && source_character_id) {
      // P1-NEW (2026-05-12): body 里的 source_series_slug 不在 :slug 路径参数, 手动验白名单防 path traversal.
      const { isValidSlug } = await import("./index");
      if (!isValidSlug(source_series_slug)) {
        res.status(400).json({ error: { code: "ValidationError", message: "source_series_slug 含非法字符" } });
        return;
      }
      // a. 读取源角色
      const sourceChar = await readCharacter(source_series_slug, source_character_id);
      if (!sourceChar) {
        res.status(404).json({ error: { code: "NotFound", message: "源系列角色不存在" } });
        return;
      }

      const charName = name_alias || sourceChar.name;
      const charId = sourceChar.id; // 保持 id 一致性

      // b. 确定 locked.png 的来源
      let lockedPngSrc: string | null = null;
      let hasSourceLocked = false;

      if (sourceChar.locked_image_path) {
        lockedPngSrc = sourceChar.locked_image_path;
        if (await pathExists(lockedPngSrc)) hasSourceLocked = true;
      } else {
        // 尝试从系列目录查找
        const srcDir = path.join(DATA_ROOT, "series", source_series_slug, "assets", "images");
        const possibleLocked = path.join(srcDir, `char_${source_character_id}_locked.png`);
        if (await pathExists(possibleLocked)) {
          lockedPngSrc = possibleLocked;
          hasSourceLocked = true;
        }
      }

      // c. 拷贝 locked.png 到目标系列
      let destLockedPath: string | undefined;
      let savedVaultId: string | undefined;

      if (hasSourceLocked && lockedPngSrc) {
        const assetsDir = path.join(DATA_ROOT, "series", slug, "assets", "images");
        await ensureDir(assetsDir);
        destLockedPath = path.join(assetsDir, `char_${source_character_id}_locked.png`);
        try {
          await fs.copyFile(lockedPngSrc, destLockedPath);

          // 同时入 vault
          const buf = await fs.readFile(lockedPngSrc);
          const vaultEntry = await saveToVault({
            buffer: buf,
            kind: "image",
            mime: "image/png",
            context: {
              kind: "library_ref",
              series_slug: slug,
              character_id: source_character_id,
            },
            provider_id: modifications?.provider_id,
          }).catch((err) => {
            loggerSync().warn(`[import-from-series] saveToVault 失败: ${err.message}`);
            return null;
          });
          if (vaultEntry) savedVaultId = vaultEntry.vault_id;
        } catch (err: unknown) {
          loggerSync().warn(`[import-from-series] 拷贝 locked.png 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // d. 创建目标角色
      // Wave B-3 (2026-05-16): 透传 appearance / outfit 拆分字段(若 source 没有,自动为 undefined,
      // 不污染 JSON)。
      let character = await createCharacter(slug, {
        name: charName,
        role: sourceChar.role,
        appearance_prompt: sourceChar.appearance_prompt,
        appearance: sourceChar.appearance,
        outfit: sourceChar.outfit,
        personality: sourceChar.personality,
        library_id: sourceChar.library_id,
        locked_image_path: destLockedPath,
      });

      // e. 若 modifications.auto_generate_locked: 需要真实 provider 生成新图
      let remixResult: any = null;
      if (modifications?.auto_generate_locked) {
        throw new Error("自动生图未配置 provider，请先在设置中配置图像生成 provider");
      }

      // f. 记录 derived_from
      await updateCharacter(slug, character.id, {
        derived_from: {
          series_slug: source_series_slug,
          character_id: source_character_id,
          vault_id: savedVaultId,
        },
      });

      // 重新读取最终状态
      const finalChar = await readCharacter(slug, character.id);

      res.status(201).json({
        character: finalChar,
        remix: remixResult,
      });
      return;
    }

    // 缺少必要参数
    res.status(400).json({ error: { code: "ValidationError", message: "请提供 library_id 或 (source_series_slug + source_character_id)" } });
  } catch (err) { next(err); }
});

// POST /series/:slug/characters/:charId/lock
characterRouter.post("/series/:slug/characters/:charId/lock", async (req, res, next) => {
  try {
    const v = validate(LockRefSchema, req.body);
    if (handleValidationError(res, v)) return;

    const char = await readCharacter(req.params.slug, req.params.charId);
    if (!char) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }

    // ── B4: 构建一致性字段 ──
    const patchData: Record<string, any> = {
      primary_ref_image_id: v.data.asset_id,
      locked: {
        ref_image: v.data.asset_id,
        locked_at: new Date().toISOString(),
        seed: v.data.locked_seed,
      },
      status: "locked",
    };

    // reference_image_set: 如果用户传了就用, 否则自动把主图作为唯一参考
    if (v.data.reference_image_set && v.data.reference_image_set.length > 0) {
      // 确保主图在集合中
      const refSet = [...new Set([v.data.asset_id, ...v.data.reference_image_set])];
      patchData.reference_image_set = refSet.slice(0, 5);
    } else {
      patchData.reference_image_set = [v.data.asset_id];
    }

    // locked_seed
    if (v.data.locked_seed !== undefined) {
      patchData.locked_seed = v.data.locked_seed;
    }

    // style_prompt_fingerprint: 如果没传, 基于当前视觉描述生成
    // Wave B-3 (2026-05-16): 用 resolveVisualDescription 合并 appearance+outfit, 新数据稳定,
    // 老数据 fallback 到 appearance_prompt(向后兼容)。
    if (v.data.style_prompt_fingerprint) {
      patchData.style_prompt_fingerprint = v.data.style_prompt_fingerprint;
    } else {
      const visualForFingerprint = resolveVisualDescription(char);
      if (visualForFingerprint) {
        const crypto = await import("node:crypto");
        patchData.style_prompt_fingerprint = crypto
          .createHash("md5")
          .update(visualForFingerprint)
          .digest("hex")
          .slice(0, 16);
      }
    }

    // lora_path (v2 占位)
    if (v.data.lora_path) {
      patchData.lora_path = v.data.lora_path;
    }

    const updated = await updateCharacter(req.params.slug, req.params.charId, patchData);
    if (!updated) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }

    res.json({ ok: true, character: updated });
  } catch (err) { next(err); }
});

// ── B4: 一致性体检 ──────────────────────────────────────────────────────
// GET /series/:slug/characters/:charId/consistency-check
characterRouter.get("/series/:slug/characters/:charId/consistency-check", async (req, res, next) => {
  try {
    const { slug, charId } = req.params;
    const char = await readCharacter(slug, charId);
    if (!char) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }

    const driftThreshold = req.query.threshold === undefined ? 0.65 : Number(req.query.threshold);
    if (!Number.isFinite(driftThreshold) || driftThreshold < 0 || driftThreshold > 1) {
      res.status(400).json({ error: { code: "ValidationError", message: "一致性阈值应在 0 到 1 之间" } }); return;
    }

    // 收集该角色所有历史产物 (ref_image_ids + reference_image_set)
    const allAssetIds = [
      ...new Set([
        ...(char.ref_image_ids || []),
        ...(char.reference_image_set || []),
        ...(char.primary_ref_image_id ? [char.primary_ref_image_id] : []),
      ]),
    ];

    // 构建 ConsistencyAsset 列表
    const assets = await Promise.all(allAssetIds.map(async id => {
      const asset = await readAsset(slug, id);
      const vault = asset ? null : await getVaultEntry(id);
      const file = asset ? resolveAssetFilePath(slug, asset.path) : vault ? getVaultAbsolutePath(vault) : null;
      try {
        if (!file) throw new Error("missing reference");
        return { id, image_url: resolveWorkspaceMediaFile(file), created_at: asset?.created_at ?? vault?.created_at ?? "" };
      } catch {
        throw Object.assign(new Error("部分参考图无法读取，请重新选择角色参考图"), { code: "ConsistencyScorerUnavailable", status: 503 });
      }
    }));

    // 动态导入 consistency 模块
    const { runConsistencyCheck } = await import("../../../../../packages/drama/src/consistency/consistencyCheck");
    const report = await runConsistencyCheck(charId, assets, driftThreshold);

    res.json({ report });
  } catch (err) { next(err); }
});

// POST /series/:slug/characters/:charId/voice-clone-sample
// multipart form: file=<audio>
// 写到 series/<slug>/assets/voices/<charId>_<timestamp>.<ext> 并 PATCH 角色字段
characterRouter.post(
  "/series/:slug/characters/:charId/voice-clone-sample",
  voiceCloneUpload.single("file"),
  async (req, res, next) => {
    try {
      const slug = String(req.params.slug);
      const charId = String(req.params.charId);
      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        res.status(400).json({ error: { code: "ValidationError", message: "缺少文件字段 file" } });
        return;
      }

      const char = await readCharacter(slug, charId);
      if (!char) {
        res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } });
        return;
      }

      // 用扩展名兜底; 浏览器经常发 octet-stream 不可信
      const origExt = path.extname(file.originalname).toLowerCase();
      const safeExt = VOICE_CLONE_EXT_WHITELIST.has(origExt) ? origExt : ".mp3";
      const sha = crypto.createHash("sha256").update(file.buffer).digest("hex").slice(0, 10);
      const filename = `${charId}_${Date.now()}_${sha}${safeExt}`;

      const voicesDir = path.join(DATA_ROOT, "series", slug, "assets", "voices");
      await ensureDir(voicesDir);
      const destPath = path.join(voicesDir, filename);
      await fs.writeFile(destPath, file.buffer);

      // series-relative 路径; 前端通过 /api/v2/series/:slug/assets/... 之类的静态接口读
      const relPath = `assets/voices/${filename}`;

      // 旧样本如果是本接口写的, 顺手清理(避免堆积)
      const prev = char.voice_clone_sample_url;
      if (prev && typeof prev === "string" && prev.startsWith("assets/voices/")) {
        const prevAbs = path.join(DATA_ROOT, "series", slug, prev);
        if (await pathExists(prevAbs)) {
          try {
            await fs.unlink(prevAbs);
          } catch (err: unknown) {
            loggerSync().warn(`[voice-clone-sample] 清理旧样本失败 ${prevAbs}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      const updated = await updateCharacter(slug, charId, { voice_clone_sample_url: relPath });
      if (!updated) {
        res.status(500).json({ error: { code: "InternalError", message: "更新角色 voice_clone_sample_url 失败" } });
        return;
      }

      res.status(201).json({
        ok: true,
        voice_clone_sample_url: relPath,
        bytes: file.buffer.length,
        character: updated,
      });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /series/:slug/characters/:charId/voice-clone-sample — 清除当前样本
characterRouter.delete("/series/:slug/characters/:charId/voice-clone-sample", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const charId = String(req.params.charId);
    const char = await readCharacter(slug, charId);
    if (!char) {
      res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } });
      return;
    }
    const prev = char.voice_clone_sample_url;
    if (prev && typeof prev === "string" && prev.startsWith("assets/voices/")) {
      const prevAbs = path.join(DATA_ROOT, "series", slug, prev);
      if (await pathExists(prevAbs)) {
        try {
          await fs.unlink(prevAbs);
        } catch (err: unknown) {
          loggerSync().warn(`[voice-clone-sample DELETE] 删除文件失败 ${prevAbs}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const updated = await updateCharacter(slug, charId, { voice_clone_sample_url: undefined });
    res.json({ ok: true, character: updated });
  } catch (err) {
    next(err);
  }
});

// POST /series/:slug/characters/:charId/train-lora (v2 占位)
characterRouter.post("/series/:slug/characters/:charId/train-lora", async (req, res, next) => {
  try {
    const { slug, charId } = req.params;
    const char = await readCharacter(slug, charId);
    if (!char) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }

    const { trainCharacterLoRA } = await import("../../../../../packages/drama/src/consistency/consistencyCheck");
    const trainingImages = [
      ...(char.ref_image_ids || []),
      ...(char.reference_image_set || []),
    ];
    const result = await trainCharacterLoRA(charId, trainingImages);

    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── C8: 反向引用 — 角色出现在哪些镜头 ─────────────────────────────────────
// GET /series/:slug/characters/:charId/usage
characterRouter.get("/series/:slug/characters/:charId/usage", async (req, res, next) => {
  try {
    const { slug, charId } = req.params;
    const char = await readCharacter(slug, charId);
    if (!char) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }

    const episodes = await listEpisodes(slug);
    const shots: Array<{ episode_id: string; shot_id: string; shot_index: number; first_frame_url: string | null }> = [];

    for (const ep of episodes) {
      const epShots = await listShots(slug, ep.id);
      for (const shot of epShots) {
        if (shot.character_ids?.includes(charId)) {
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
// Series Character Variants
// ═══════════════════════════════════════════════════════════════════

// GET /series/:slug/characters/:charId/variants
characterRouter.get("/series/:slug/characters/:charId/variants", async (req, res, next) => {
  try {
    const variants = await listSeriesCharVariants(req.params.slug, req.params.charId);
    res.json({ variants });
  } catch (err) { next(err); }
});

// POST /series/:slug/characters/:charId/variants
characterRouter.post("/series/:slug/characters/:charId/variants", async (req, res, next) => {
  try {
    const v = validate(CreateVariantSchema, req.body);
    if (handleValidationError(res, v)) return;

    const variant = await createSeriesCharVariant(req.params.slug, req.params.charId, {
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

// DELETE /series/:slug/characters/:charId/variants/:varId
characterRouter.delete("/series/:slug/characters/:charId/variants/:varId", async (req, res, next) => {
  try {
    const ok = await deleteSeriesCharVariant(req.params.slug, req.params.charId, req.params.varId);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "变体不存在" } }); return; }
    res.json({ ok: true, message: "变体已删除" });
  } catch (err) { next(err); }
});

// POST /series/:slug/characters/:charId/variants/auto-pack
characterRouter.post("/series/:slug/characters/:charId/variants/auto-pack", async (req, res, next) => {
  try {
    const v = validate(AutoPackSchema, req.body);
    if (handleValidationError(res, v)) return;

    const char = await readCharacter(req.params.slug, req.params.charId);
    if (!char) { res.status(404).json({ error: { code: "NotFound", message: "角色不存在" } }); return; }

    const registry = getRegistry();

    // Determine basePrompt from character data
    // Wave B-3 (2026-05-16): 用 resolveVisualDescription 合并 appearance+outfit(老数据 fallback)
    const basePrompt = [resolveVisualDescription(char), char.personality].filter(Boolean).join(", ") || char.name;

    // Find locked.png and ensure it's in vault for reference_image
    const { slug, charId } = req.params;
    let referenceAssetId: string | undefined;
    const lockedPathCandidates = [
      char.locked_image_path,
      path.join(DATA_ROOT, "series", slug, "assets", "images", `char_${charId}_locked.png`),
      path.join(DATA_ROOT, "series", slug, "assets", "images", `char_${char.library_id ?? charId}_locked.png`),
    ].filter(Boolean) as string[];

    for (const lp of lockedPathCandidates) {
      try {
        if (await pathExists(lp)) {
          const buf = await fs.readFile(lp);
          const vaultEntry = await saveToVault({
            buffer: buf,
            kind: "image",
            mime: "image/png",
            context: { kind: "variant", series_slug: slug, character_id: charId, user_note: "locked_reference" },
            width: 1024,
            height: 1024,
          });
          referenceAssetId = vaultEntry.vault_id;
          break;
        }
      } catch { /* try next */ }
    }

    // 6 variants: 服装×2, 情绪×2, 时段×1, 天气×1
    const packs: Array<{ label: string; category: SeriesVariant["category"]; prompt_suffix: string }> = [
      { label: "商务正装", category: "outfit", prompt_suffix: "穿着正式商务正装，干练专业" },
      { label: "休闲便装", category: "outfit", prompt_suffix: "穿着舒适休闲便装，轻松自然" },
      { label: "微笑", category: "emotion", prompt_suffix: "微笑着，温暖的表情，眼神柔和" },
      { label: "悲伤", category: "emotion", prompt_suffix: "悲伤的表情，眼中含泪，情绪低落" },
      { label: "黄昏时分", category: "time_of_day", prompt_suffix: "黄昏时分，暖金色的夕阳光线洒落" },
      { label: "雨天氛围", category: "weather", prompt_suffix: "下雨天，阴雨绵绵的氛围，伞下凝望" },
    ];

    const settled = await Promise.allSettled(
      packs.map(async (pack) => {
        const prompt = `${basePrompt}, ${pack.prompt_suffix}`;
        // W8 Phase 1: 走 library_variant adapter (saveToVault 入口收敛). createSeriesCharVariant
        // 仍由 controller 负责 — 它是 series 内 variant 索引, 不是 vault entry.
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
              target_id: charId,
              meta: {
                vault_context_kind: "variant",
                character_id: charId,
                category: pack.category,
                user_note: `auto-pack: ${pack.label}`,
              },
            },
            extra_tags: [`character:${charId}`, "auto_pack", `category:${pack.category}`],
          },
          { registry },
        );
        const vaultId = result.images[0]?.vault_id;
        if (!vaultId) {
          console.error("[autoPack] library_variant adapter 未返回 vault_id");
          throw new Error("自动生图失败，请稍后重试");
        }

        return await createSeriesCharVariant(slug, charId, {
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
        console.warn(`[series char auto-pack] 单张变体生成失败: ${r.reason?.message ?? r.reason}`);
        failed++;
      }
    }

    res.json({ ok: true, succeeded, failed, variants });
  } catch (err) { next(err); }
});
