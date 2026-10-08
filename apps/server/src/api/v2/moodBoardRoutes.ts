/**
 * v2 Mood Board Routes — Style mood board CRUD for a series
 *
 * Extracted from seriesController.ts (2026-06-01 backend-arch P2-1) to reduce
 * controller bloat. Path behaviour is unchanged; mounted via seriesRouter.use()
 * so all existing URL paths remain valid.
 */

import { Router } from "express";
import multer from "multer";
import {
  listMoodBoard, addToMoodBoard, removeFromMoodBoard, updateMoodBoardEntry,
  reorderMoodBoard, isMoodBoardEnabled, setMoodBoardEnabled,
} from "./seriesStore";
import { saveToVault, ensureThumbnailsDir, saveThumbnailBuffer } from "../../../../../packages/library/src/assetVault";
import { scrubForClient } from "../../../../../packages/core/src/logger";

const moodBoardUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件类型: ${file.mimetype}。仅接受 PNG/JPEG/WEBP 格式。`));
    }
  },
});

export const moodBoardRouter = Router({ mergeParams: true });

// GET /series/:slug/mood-board
moodBoardRouter.get("/series/:slug/mood-board", async (req, res, next) => {
  try {
    const entries = await listMoodBoard(req.params.slug);
    const enabled = await isMoodBoardEnabled(req.params.slug);
    res.json({ entries, enabled });
  } catch (err) { next(err); }
});

// POST /series/:slug/mood-board
moodBoardRouter.post("/series/:slug/mood-board", async (req, res, next) => {
  try {
    const { vault_id, weight, note } = req.body;
    if (!vault_id || typeof vault_id !== "string") {
      res.status(400).json({ error: { code: "ValidationError", message: "缺少 vault_id" } });
      return;
    }
    const entry = await addToMoodBoard(req.params.slug, vault_id, weight ?? 5, note ?? "");
    res.status(201).json({ entry });
  } catch (err: unknown) {
    if (err instanceof Error && (err as Error & { status?: number }).status === 409) {
      res.status(409).json({ error: { code: "Conflict", message: scrubForClient(err.message) } });
      return;
    }
    next(err);
  }
});

// DELETE /series/:slug/mood-board/:vaultId
moodBoardRouter.delete("/series/:slug/mood-board/:vaultId", async (req, res, next) => {
  try {
    const ok = await removeFromMoodBoard(req.params.slug, req.params.vaultId);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "风格板条目不存在" } }); return; }
    res.json({ ok: true, message: "已从风格板移除" });
  } catch (err) { next(err); }
});

// PATCH /series/:slug/mood-board/:vaultId — update weight/note
moodBoardRouter.patch("/series/:slug/mood-board/:vaultId", async (req, res, next) => {
  try {
    const entry = await updateMoodBoardEntry(req.params.slug, req.params.vaultId, req.body);
    if (!entry) { res.status(404).json({ error: { code: "NotFound", message: "风格板条目不存在" } }); return; }
    res.json({ entry });
  } catch (err) { next(err); }
});

// PUT /series/:slug/mood-board/reorder — reorder all entries
moodBoardRouter.put("/series/:slug/mood-board/reorder", async (req, res, next) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      res.status(400).json({ error: { code: "ValidationError", message: "缺少 order 数组" } });
      return;
    }
    const entries = await reorderMoodBoard(req.params.slug, order);
    res.json({ entries });
  } catch (err) { next(err); }
});

// POST /series/:slug/mood-board/upload — multipart upload
moodBoardRouter.post("/series/:slug/mood-board/upload", moodBoardUpload.array("files", 10), async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: { code: "ValidationError", message: "请上传至少一个文件" } });
      return;
    }
    const slug = req.params.slug as string;

    // Pre-validate all files with sharp metadata check
    const sharpModule = (await import("sharp")).default;
    for (const file of files) {
      const metadata = await sharpModule(file.buffer).metadata();
      if (!metadata.width || !metadata.height) {
        res.status(400).json({ error: { code: "ValidationError", message: `无法读取图片 "${file.originalname}" 的尺寸` } });
        return;
      }
      if (metadata.width > 8192 || metadata.height > 8192) {
        res.status(400).json({ error: { code: "ValidationError", message: `图片 "${file.originalname}" 尺寸过大 (${metadata.width}x${metadata.height})，最大允许 8192x8192` } });
        return;
      }
      if (metadata.width < 64 || metadata.height < 64) {
        res.status(400).json({ error: { code: "ValidationError", message: `图片 "${file.originalname}" 尺寸过小 (${metadata.width}x${metadata.height})，最小要求 64x64` } });
        return;
      }
    }

    // All files validated — save originals + thumbnails
    const results: any[] = [];
    for (const file of files) {
      // Save original to vault
      const vaultEntry = await saveToVault({
        buffer: file.buffer,
        kind: "image",
        mime: file.mimetype || "image/png",
        context: { kind: "user_upload", series_slug: slug },
      });

      // Generate thumbnail webp@q85
      const thumbBuffer = await sharpModule(file.buffer).webp({ quality: 85 }).toBuffer();
      await ensureThumbnailsDir();
      await saveThumbnailBuffer(vaultEntry.vault_id, thumbBuffer);

      const entry = await addToMoodBoard(slug, vaultEntry.vault_id, 5, "");
      results.push({ vault_id: vaultEntry.vault_id, entry });
    }
    res.status(201).json({ ok: true, count: results.length, results });
  } catch (err) { next(err); }
});

// PUT /series/:slug/mood-board/config — enable/disable
moodBoardRouter.put("/series/:slug/mood-board/config", async (req, res, next) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: { code: "ValidationError", message: "缺少 enabled (boolean)" } });
      return;
    }
    const config = await setMoodBoardEnabled(req.params.slug, enabled);
    res.json({ config });
  } catch (err) { next(err); }
});
