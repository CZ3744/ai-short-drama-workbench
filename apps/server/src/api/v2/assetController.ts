/**
 * v2 Asset Controller — CRUD for assets + thumbnail
 *
 * C3: file-type 嗅探 + sharp 尺寸校验 + ffprobe 视频预检
 */

import { Router, type Response } from "express";
import path from "node:path";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  listAssets,
  readAsset,
  addAsset,
  softDeleteAsset,
  restoreAsset,
  permanentlyDeleteAsset,
  listTrashedAssets,
  getAssetThumbnailPath,
} from "../../repositories/assetRepo";
import { readLocalSettings } from "../../../../../packages/core/src/localSettings";
import { DATA_ROOT, pathExists } from "../../../../../packages/core/src/index";
// Y2 (UP-2, 2026-07-22): 上传落盘必须与 addAsset 登记同根 (DATA_ROOT), 不能走 process.cwd()/data.
// assetsDir(slug) = DATA_ROOT/series/<slug>/assets — 与 repositories/assetRepo.ts 的登记/读取同源。
import { assetsDir } from "../../repositories/_paths";

// C3: 安全校验常量
const MAX_IMAGE_DIMENSION = 8192; // 超过 8192×8192 拒绝
const SNIFF_BYTES = 4096; // 读前 4096 字节嗅探真实 mime
const MAX_VIDEO_DURATION_SEC = 600; // 视频最长 10 分钟
const ALLOWED_VIDEO_CODECS = new Set(["h264", "hevc", "vp8", "vp9", "av1"]);

/** C3: 读取 buffer 前 N 字节，用 file-type 判断真实 mime */
async function sniffMimeType(buffer: Buffer): Promise<{ mime: string; ext: string } | null> {
  try {
    const { fileTypeFromBuffer } = await import("file-type");
    const result = await fileTypeFromBuffer(buffer.slice(0, SNIFF_BYTES));
    return result ?? null;
  } catch {
    return null;
  }
}

/** C3: sharp 检查图片宽高，超 8192×8192 拒绝 */
async function validateImageDimensions(buffer: Buffer): Promise<{ width: number; height: number } | string> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return "无法读取图片尺寸";
    if (meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION) {
      return `图片尺寸 ${meta.width}×${meta.height} 超出限制 ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`;
    }
    return { width: meta.width, height: meta.height };
  } catch (err: unknown) {
    return `图片元数据读取失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** C5: resolve ffprobe path from config → PATH → fixed default */
function resolveFfprobePath(): string {
  try {
    const local = readLocalSettings();
    if (local.FFPROBE_PATH && local.FFPROBE_PATH.trim()) {
      return local.FFPROBE_PATH.trim();
    }
  } catch { /* ignore */ }
  // Fallback: try PATH
  if (process.platform === "win32") return "ffprobe.exe";
  return "ffprobe";
}

/** C3: ffprobe 预检视频 duration/codec */
async function validateVideoProbe(filePath: string): Promise<{ duration: number; codec: string } | string> {
  return new Promise((resolve) => {
    const ffprobePath = resolveFfprobePath();

    execFile(
      ffprobePath,
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        filePath,
      ],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          resolve(`ffprobe 预检失败: ${err.message}`);
          return;
        }
        try {
          const info = JSON.parse(stdout);
          const duration = Number(info.format?.duration ?? 0);
          const videoStream = (info.streams ?? []).find((s: any) => s.codec_type === "video");
          const codec = videoStream?.codec_name ?? "unknown";

          if (duration > MAX_VIDEO_DURATION_SEC) {
            resolve(`视频时长 ${duration.toFixed(1)}s 超出限制 ${MAX_VIDEO_DURATION_SEC}s`);
            return;
          }
          if (!ALLOWED_VIDEO_CODECS.has(codec)) {
            resolve(`视频编码 ${codec} 不受支持，允许: ${[...ALLOWED_VIDEO_CODECS].join(", ")}`);
            return;
          }
          resolve({ duration, codec });
        } catch (parseErr: any) {
          resolve(`ffprobe 输出解析失败: ${parseErr.message}`);
        }
      }
    );
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

export const assetRouter = Router();

function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendMissingThumbnail(res: Response, rawSize: number, label: string): void {
  const size = Math.max(64, Math.min(Number.isFinite(rawSize) ? rawSize : 256, 1024));
  const safeLabel = escapeSvgText(label);
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${safeLabel}">
      <rect width="${size}" height="${size}" rx="18" fill="rgb(248,246,241)"/>
      <rect x="1" y="1" width="${size - 2}" height="${size - 2}" rx="17" fill="none" stroke="rgb(221,216,209)" stroke-width="2"/>
      <path d="M${size * 0.34} ${size * 0.36}h${size * 0.32}v${size * 0.22}h-${size * 0.32}z" fill="none" stroke="rgb(141,135,128)" stroke-width="3" stroke-linejoin="round"/>
      <circle cx="${size * 0.43}" cy="${size * 0.44}" r="${size * 0.035}" fill="rgb(141,135,128)"/>
      <path d="M${size * 0.34} ${size * 0.58}l${size * 0.09}-${size * 0.08}l${size * 0.07} ${size * 0.05}l${size * 0.07}-${size * 0.07}l${size * 0.09} ${size * 0.1}" fill="none" stroke="rgb(141,135,128)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="50%" y="${size * 0.72}" text-anchor="middle" fill="rgb(106,100,93)" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="${Math.max(12, size * 0.055)}" font-weight="600">${safeLabel}</text>
    </svg>
  `.trim());
}

// GET /series/:slug/assets
assetRouter.get("/series/:slug/assets", async (req, res, next) => {
  try {
    const filter = {
      kind: req.query.kind as string | undefined,
      tags: req.query.tags ? String(req.query.tags).split(",") : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    };
    const assets = await listAssets(req.params.slug, filter);
    res.json({ assets });
  } catch (err) { next(err); }
});

// GET /series/:slug/assets-trash
assetRouter.get("/series/:slug/assets-trash", async (req, res, next) => {
  try {
    const assets = await listTrashedAssets(req.params.slug);
    res.json({ assets });
  } catch (err) { next(err); }
});

// GET /series/:slug/assets/:id
assetRouter.get("/series/:slug/assets/:id", async (req, res, next) => {
  try {
    const asset = await readAsset(req.params.slug, req.params.id);
    if (!asset) { res.status(404).json({ error: { code: "NotFound", message: "素材不存在" } }); return; }
    res.json({ asset });
  } catch (err) { next(err); }
});

// GET /series/:slug/assets/:id/thumbnail
assetRouter.get("/series/:slug/assets/:id/thumbnail", async (req, res, next) => {
  try {
    const size = Number(req.query.size) || 64;
    const asset = await readAsset(req.params.slug, req.params.id);
    if (!asset) { res.status(404).json({ error: { code: "NotFound", message: "素材不存在" } }); return; }
    const thumbPath = await getAssetThumbnailPath(req.params.slug, req.params.id, size);
    if (!thumbPath) {
      sendMissingThumbnail(res, size, asset.kind === "video" ? "视频文件缺失" : "素材文件缺失");
      return;
    }
    res.sendFile(thumbPath);
  } catch (err) { next(err); }
});

// GET /series/:slug/assets/images/:filename
// C-N1 (2026-05-12): slug 白名单 — 防 path traversal (攻击者传 slug="../../etc" 爬出 DATA_ROOT)。
// 2026-05-16 修订: 之前 ASCII-only 白名单 ^[A-Za-z0-9_\-]+$ 误伤中文 slug,
// 用户用「测试用例」这种中文项目名会被 400 拒,导致 element image url 全死(toC 默认场景)。
// 新规则:仍禁 path 分隔符 + 控制字符 + Windows 非法字符 + 父路径符号,但允许 Unicode。
// 双重保险:line 196 path.basename 校验 + line 204-212 filePath.startsWith(assetDir)。
const SLUG_FORBIDDEN_CHARS = /[/\\\x00-\x1f<>:"|?*]/;
function isValidSlug(slug: string): boolean {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 128) return false;
  if (SLUG_FORBIDDEN_CHARS.test(slug)) return false;
  if (slug.includes("..")) return false;                       // 父路径
  if (slug.startsWith(".") || slug.endsWith(".")) return false; // Windows 不允许结尾点
  if (slug.trim() !== slug) return false;                       // 前后空格
  return true;
}

// Candidate pools store asset.path as assets/images/<filename>. Serve that path safely.
assetRouter.get("/series/:slug/assets/:kind/:filename", async (req, res, next) => {
  try {
    const { slug, kind, filename } = req.params;
    // C-N1: 严格 slug 白名单, 防 path traversal
    if (!isValidSlug(slug)) {
      res.status(400).json({ error: { code: "ValidationError", message: "slug 含非法字符" } });
      return;
    }
    if (!["images", "videos", "audio", "voices"].includes(kind)) {
      res.status(404).json({ error: { code: "NotFound", message: "素材分类不存在" } });
      return;
    }
    if (filename !== path.basename(filename)) {
      res.status(403).json({ error: { code: "Forbidden", message: "路径非法" } });
      return;
    }

    const dataRootResolved = path.resolve(DATA_ROOT);
    const assetDir = path.resolve(dataRootResolved, "series", slug, "assets", kind);
    // C-N1: 双重保险 — assetDir 本身必须仍在 DATA_ROOT 内 (即使 slug 白名单已通过)
    if (!assetDir.startsWith(`${dataRootResolved}${path.sep}`) && assetDir !== dataRootResolved) {
      res.status(403).json({ error: { code: "Forbidden", message: "路径非法" } });
      return;
    }
    const filePath = path.resolve(assetDir, filename);
    if (!filePath.startsWith(`${assetDir}${path.sep}`)) {
      res.status(403).json({ error: { code: "Forbidden", message: "路径非法" } });
      return;
    }
    if (!(await pathExists(filePath))) {
      res.status(404).json({ error: { code: "NotFound", message: "素材文件不存在" } });
      return;
    }
    res.sendFile(filePath);
  } catch (err) { next(err); }
});

// POST /series/:slug/assets (multipart upload)
// C3: file-type 嗅探 + sharp 尺寸校验 + ffprobe 视频预检
assetRouter.post("/series/:slug/assets", upload.array("files", 10), async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: { code: "ValidationError", message: "请上传至少一个文件" } });
      return;
    }

    const slug = String(req.params.slug);
    // Y2 主修 (UP-2): 落盘根 = DATA_ROOT/series/<slug>/assets (与 addAsset 登记同根)。
    // 旧代码用字面 "data/series/..." + process.cwd() 把文件写进仓库内 <repo>/data/,
    // 而登记/读取走 DATA_ROOT (外置 video-generate-data/) → 两棵树 → 视频引用读不到文件。
    const seriesAssetsDir = assetsDir(slug);

    // tags 每个文件一致 (来自 req.body), 循环前算一次 + 判定人话名类型。
    const assetTags: string[] = req.body.tags
      ? (Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags).split(","))
      : [];
    // "单镜首帧候选导入" = 带 shot:<id> + reference 标签 (journey F 段就是这条路)。
    const isShotReferenceImport =
      assetTags.some((t) => t === "reference") && assetTags.some((t) => t.startsWith("shot:"));
    const isReferenceImport = assetTags.some((t) => t === "reference");

    const results = [];
    let importSeq = 0;

    for (const file of files) {
      importSeq += 1;
      // ── C3 Step 1: file-type 嗅探真实 mime ──────────────────────────
      const sniffed = await sniffMimeType(file.buffer);
      const realMime = sniffed?.mime ?? file.mimetype;
      const realExt = sniffed?.ext ? `.${sniffed.ext}` : path.extname(file.originalname) || ".bin";

      // 用嗅探结果重新判断 kind（不再信任 client mimetype）
      const kind = realMime.startsWith("image/") ? "images" :
                   realMime.startsWith("video/") ? "videos" :
                   realMime.startsWith("audio/") ? "audio" : "images";

      // ── C3 Step 2: 图片宽高校验 ────────────────────────────────────
      if (kind === "images") {
        const dimResult = await validateImageDimensions(file.buffer);
        if (typeof dimResult === "string") {
          res.status(400).json({ error: { code: "ValidationError", message: dimResult } });
          return;
        }
      }

      const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 12)}${realExt}`;

      // Ensure directory exists — 落盘走 DATA_ROOT (seriesAssetsDir), 与登记的 asset.path 同根。
      const absDir = path.join(seriesAssetsDir, kind);
      await fs.mkdir(absDir, { recursive: true });
      const absFilePath = path.join(absDir, filename);
      await fs.writeFile(absFilePath, file.buffer);

      // ── C3 Step 3: 视频 ffprobe 预检 ───────────────────────────────
      if (kind === "videos") {
        const probeResult = await validateVideoProbe(absFilePath);
        if (typeof probeResult === "string") {
          // 校验失败，删除已写入的文件
          try {
            await fs.unlink(absFilePath);
          } catch (unlinkErr: any) {
            console.error(`[assetController] 校验失败后清理临时文件失败: ${absFilePath}`, unlinkErr);
          }
          res.status(400).json({ error: { code: "ValidationError", message: probeResult } });
          return;
        }
      }

      const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");

      const assetKind: "image" | "video" | "audio" = kind === "images" ? "image" : kind === "videos" ? "video" : "audio";

      // Y2 人话名 (UP-2, display_name 铁律#2): 登记素材必须有人话展示名, 绝不拿 asset_ULID
      // / 落盘文件名见人。单镜首帧候选导入 → "首帧导入 · 第 N 张"; 其它参考图导入 →
      // "参考图 · 第 N 张"; 普通用户上传 → 保留原始文件名 (本身即人话)。
      const humanName = isShotReferenceImport
        ? `首帧导入 · 第 ${importSeq} 张`
        : isReferenceImport
          ? `参考图 · 第 ${importSeq} 张`
          : String(file.originalname);

      const entry = {
        series_slug: slug as string,
        kind: assetKind as "image" | "video" | "audio",
        tags: assetTags as string[],
        path: `assets/${kind}/${filename}` as string,
        filename: String(file.originalname),
        display_name: humanName,
        mime: realMime, // 使用嗅探到的 mime，而非 client 声明
        size_bytes: Number(file.size),
        sha256: sha256 as string | undefined,
      };

      // Y2 原子一致 (UP-2): "文件落盘 + 记录登记"同生共死。登记失败回删已落盘文件, 杜绝孤儿文件。
      let asset;
      try {
        asset = await addAsset(slug, entry);
      } catch (registerErr) {
        await fs.unlink(absFilePath).catch(() => {});
        throw registerErr;
      }

      results.push(asset);
    }

    res.status(201).json({ ok: true, assets: results });
  } catch (err) { next(err); }
});

// DELETE /series/:slug/assets/:id
assetRouter.delete("/series/:slug/assets/:id", async (req, res, next) => {
  try {
    const trashed = await softDeleteAsset(req.params.slug, req.params.id);
    if (!trashed) { res.status(404).json({ error: { code: "NotFound", message: "素材不存在" } }); return; }
    res.json({ ok: true, message: "素材已移入回收站，90 天内可恢复", asset: trashed });
  } catch (err) { next(err); }
});

// POST /series/:slug/assets/:id/restore
assetRouter.post("/series/:slug/assets/:id/restore", async (req, res, next) => {
  try {
    const asset = await restoreAsset(req.params.slug, req.params.id);
    if (!asset) { res.status(404).json({ error: { code: "NotFound", message: "回收站素材不存在" } }); return; }
    res.json({ ok: true, asset });
  } catch (err) { next(err); }
});

// DELETE /series/:slug/assets/:id/permanent
assetRouter.delete("/series/:slug/assets/:id/permanent", async (req, res, next) => {
  try {
    const ok = await permanentlyDeleteAsset(req.params.slug, req.params.id);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "回收站素材不存在" } }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});
