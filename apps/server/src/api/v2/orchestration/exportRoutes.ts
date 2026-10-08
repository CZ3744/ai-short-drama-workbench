/**
 * v2 Orchestration — Export & Version routes
 *
 *   POST /series/:slug/episodes/:epId/export
 *   GET  /series/:slug/episodes/:epId/final.mp4
 *   GET  /series/:slug/episodes/:epId/compose-versions
 *   GET  /series/:slug/episodes/:epId/compose-file/:filename
 *   POST /series/:slug/episodes/:epId/versions
 *   POST /series/:slug/episodes/:epId/revert
 */

import path from "node:path";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import { Router, type Response } from "express";

import {
  exportEpisode,
  getComposeFile,
  deleteComposeFile,
  getFinalMp4,
  listEpisodeComposeVersions,
  listEpisodeVersions,
  type ExportUseCaseResult,
} from "../../../application/export/exportUseCases";
import { makeResProgressSink } from "./_shared/progressSink";
import { episodeBase } from "./_shared/paths";

export const exportRouter = Router();

function sendExportResult(res: Response, result: ExportUseCaseResult): void {
  if (result.kind === "validation") {
    res.status(result.status).json({
      error: {
        code: "ValidationError",
        message: "请求体校验失败",
        details: result.errors,
      },
    });
    return;
  }
  if (result.kind === "error") {
    res.status(result.status).json(result.body);
    return;
  }
  if (result.kind === "file") {
    res.sendFile(result.path);
    return;
  }
  res.json(result.body);
}

// ═══════════════════════════════════════════════════════════════════
// 5. POST /series/:slug/episodes/:epId/export
// ═══════════════════════════════════════════════════════════════════

exportRouter.post("/series/:slug/episodes/:epId/export", async (req, res, next) => {
  // 2026-05-27 — req.on("close") 改 res.on("close"). CLAUDE.md §7 明确:
  // IncomingMessage 的 close 在 body 被 body-parser 读完时 emit (几毫秒后), 不代表
  // 客户端断开 → AbortController 立即触发 → 后续 trimEpisodeMp4 启动的 ffmpeg
  // 一秒内被 KILL, 用户看到导出莫名失败. ServerResponse 的 close 才是连接真正断开.
  // 同时去掉 finally 块的 ac.abort() — 正常完成时不该 abort 还在排队的 cleanup spawn.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on("close", onClose);

  try {
    const result = await exportEpisode(
      { slug: req.params.slug, episodeId: req.params.epId, body: req.body },
      { progress: makeResProgressSink(res), signal: ac.signal },
    );
    sendExportResult(res, result);
  } catch (err: unknown) {
    next(err);
  } finally {
    res.off("close", onClose);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5B. GET /series/:slug/episodes/:epId/final.mp4 — compose 产物直取
// ═══════════════════════════════════════════════════════════════════

exportRouter.get("/series/:slug/episodes/:epId/final.mp4", async (req, res, next) => {
  try {
    sendExportResult(res, await getFinalMp4(req.params.slug, req.params.epId));
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// 5B-2. POST /series/:slug/episodes/:epId/compose/reveal — 2026-05-22
// 在系统文件管理器里打开 compose 目录 (final.mp4 就在里面).
// 用户原话: "本地文件已经有 mp4 了, 为什么我只能导出 zip 才能跳转到文件夹" —
// 跳转文件夹不该绑死在 zip 导出流程上, 合成完成就能直接看成片所在目录.
// ═══════════════════════════════════════════════════════════════════

exportRouter.post("/series/:slug/episodes/:epId/compose/reveal", async (req, res, next) => {
  try {
    const composeDir = path.resolve(episodeBase(req.params.slug, req.params.epId), "compose");
    if (!existsSync(composeDir)) {
      res.status(404).json({
        error: { code: "NotFound", message: "还没有合成成片，先点合成再查看文件夹" },
      });
      return;
    }
    // execFile (argv 数组, 不走 shell) 防命令注入; explorer 即使成功也可能返非零 exit code,
    // 只把 ENOENT (无法 spawn) 当真失败.
    const cmd = process.platform === "win32" ? "explorer.exe" : "open";
    execFile(cmd, [composeDir], { timeout: 5000 }, (err) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(500).json({ error: { code: "InternalError", message: "无法打开文件管理器" } });
        return;
      }
      res.json({ ok: true, message: "已在文件管理器打开成片目录", dir: composeDir });
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// 5C. GET /series/:slug/episodes/:epId/compose-versions — Wave 4A: 列出所有 compose 产物
// ═══════════════════════════════════════════════════════════════════

exportRouter.get("/series/:slug/episodes/:epId/compose-versions", async (req, res, next) => {
  try {
    sendExportResult(res, await listEpisodeComposeVersions(req.params.slug, req.params.epId));
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// 5D. GET /series/:slug/episodes/:epId/compose-file/:filename — Wave 4A: 获取指定 compose 产物文件
// ═══════════════════════════════════════════════════════════════════

exportRouter.get("/series/:slug/episodes/:epId/compose-file/:filename", async (req, res, next) => {
  try {
    sendExportResult(res, await getComposeFile(req.params.slug, req.params.epId, req.params.filename));
  } catch (err) { next(err); }
});

// 2026-05-25: DELETE 历史版本文件 (audit 续集 P0 #1, 让用户清理堆积旧版)
exportRouter.delete("/series/:slug/episodes/:epId/compose-file/:filename", async (req, res, next) => {
  try {
    sendExportResult(res, await deleteComposeFile(req.params.slug, req.params.epId, req.params.filename));
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// 6. POST /series/:slug/episodes/:epId/versions — 版本历史 (file-based)
// ═══════════════════════════════════════════════════════════════════

exportRouter.post("/series/:slug/episodes/:epId/versions", async (req, res, next) => {
  try {
    sendExportResult(res, await listEpisodeVersions(req.params.slug, req.params.epId));
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// 7. POST /series/:slug/episodes/:epId/revert
//    2026-07-22 X3-2 (A4-15): 此路由曾与 episodeController.ts 的 revert 重复注册, 且因
//    episodeRouter 在 index.ts 里先注册而被 Express 永久遮蔽(死代码). 已去重: 统一由
//    episodeController.ts 的 revert 路由承接, 内部委托 revertEpisodeVersion(磁盘版超集)
//    并补写 episode.script_md 元数据. 此处不再重复注册, 避免维护期歧义.
// ═══════════════════════════════════════════════════════════════════
