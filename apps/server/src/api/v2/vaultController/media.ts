/**
 * Vault Controller — media routes (raw download + thumbnail)
 *
 * GET /:id/raw                  — download original (supports HTTP Range for video seek)
 * GET /:id/thumbnail?size=256   — thumbnail (sharp webp for images, ffmpeg for videos)
 */

import { Router } from "express";
import fs from "node:fs/promises";
import { getVaultEntry, getVaultBuffer, getVaultAbsolutePath } from "../../../../../../packages/library/src/assetVault";
import { pathExists } from "../../../../../../packages/core/src/index";
import { sendMissingThumbnail } from "./_shared";

export const mediaRouter = Router();

// GET /api/v2/vault/:id/raw — download original
// 2026-05-17 修视频首帧不显示: 支持 HTTP Range request.
// <video src="X#t=0.1"> 浏览器发 Range: bytes=0-1023 等小范围拉首帧 metadata 解码,
// 之前 res.send(buffer) 全量返回不识别 Range, 浏览器认为不支持 seek 就放弃显示首帧 → 占位图标.
// 现在用 fs.createReadStream + Range 解析 + Accept-Ranges: bytes 头, video 标签真能 seek 显示首帧.
mediaRouter.get("/:id/raw", async (req, res, next) => {
  try {
    const entry = await getVaultEntry(req.params.id);
    if (!entry) { res.status(404).json({ error: { code: "NotFound", message: "文件不存在" } }); return; }
    const absPath = getVaultAbsolutePath(entry);
    if (!(await pathExists(absPath))) {
      res.status(404).json({ error: { code: "NotFound", message: "文件不存在" } });
      return;
    }

    const fileSize = entry.bytes;
    const range = req.headers.range;

    res.setHeader("Content-Type", entry.mime);
    res.setHeader("Accept-Ranges", "bytes");
    const safeId = String(req.params.id).replace(/["\\]/g, '_');
    res.setHeader("Content-Disposition", `inline; filename="${safeId}"`);

    if (!range) {
      // 整段下载 — 走 stream 而非 buffer load 全量到内存
      res.setHeader("Content-Length", fileSize);
      const { createReadStream } = await import("node:fs");
      const stream = createReadStream(absPath);
      stream.on("error", (err) => { if (!res.headersSent) next(err); else res.end(); });
      stream.pipe(res);
      return;
    }

    // Range request — 解析 "bytes=start-end"
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (!m) {
      res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
      res.end();
      return;
    }
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= fileSize || end >= fileSize || start > end) {
      res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", end - start + 1);
    const { createReadStream } = await import("node:fs");
    const stream = createReadStream(absPath, { start, end });
    stream.on("error", (err) => { if (!res.headersSent) next(err); else res.end(); });
    stream.pipe(res);
  } catch (err) { next(err); }
});

// GET /api/v2/vault/:id/thumbnail?size=256 — thumbnail (sharp webp)
mediaRouter.get("/:id/thumbnail", async (req, res, next) => {
  try {
    const size = Math.min(Number(req.query.size) || 256, 1024);
    const entry = await getVaultEntry(req.params.id);
    if (!entry) { res.status(404).json({ error: { code: "NotFound", message: "归档条目不存在" } }); return; }

    const absPath = getVaultAbsolutePath(entry);
    if (!(await pathExists(absPath))) {
      sendMissingThumbnail(res, size, entry.kind === "video" ? "视频文件缺失" : "素材文件缺失");
      return;
    }

    if (entry.kind === "video") {
      // 2026-05-17 修真首帧: 用 ffmpeg 抽视频第 0.5 秒帧 → 缓存到 vault 旁 .thumb.jpg → 返真画面
      // 之前返写死的 SVG 播放图标占位 = 用户报告"视频缩略图丢失"的真因(backend 假实现).
      const thumbPath = `${absPath}.thumb.jpg`;
      let thumbExists = await pathExists(thumbPath);
      if (!thumbExists) {
        try {
          const { spawn } = await import("node:child_process");
          await new Promise<void>((resolve, reject) => {
            const child = spawn("ffmpeg", [
              "-y", "-ss", "0.5", "-i", absPath,
              "-frames:v", "1", "-q:v", "5",
              "-vf", `scale='min(${size},iw)':-2`,
              thumbPath,
            ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
            const killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 15_000);
            child.on("close", (code) => { clearTimeout(killTimer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
            child.on("error", (err) => { clearTimeout(killTimer); reject(err); });
          });
          thumbExists = await pathExists(thumbPath);
        } catch {
          /* ffmpeg 失败 → fallback 占位 */
        }
      }
      if (thumbExists) {
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=86400");
        const { createReadStream } = await import("node:fs");
        const stream = createReadStream(thumbPath);
        stream.on("error", (err) => { if (!res.headersSent) next(err); else res.end(); });
        stream.pipe(res);
        return;
      }
      // ffmpeg 不可用 / 抽帧失败 → 仍返 SVG 占位 (toC 兜底)
      res.setHeader("Content-Type", "image/svg+xml");
      res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect fill="#1a1a2e" width="${size}" height="${size}"/><polygon points="${size*0.35},${size*0.25} ${size*0.75},${size*0.5} ${size*0.35},${size*0.75}" fill="#e0e0e0"/></svg>`);
      return;
    }

    // Try sharp for image thumbnails
    try {
      const sharp = (await import("sharp")).default;
      const thumb = await sharp(absPath)
        .resize(size, size, { fit: "cover" })
        .webp({ quality: 80 })
        .toBuffer();
      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Content-Length", thumb.length);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(thumb);
    } catch {
      // Fallback: serve original
      const buf = await fs.readFile(absPath);
      res.setHeader("Content-Type", entry.mime);
      res.setHeader("Content-Length", buf.length);
      res.send(buf);
    }
  } catch (err) { next(err); }
});
