/**
 * Compose routes
 *
 *   POST /series/:slug/episodes/:epId/compose            — TTS + 视频 concat + 字幕对齐/烧录
 *   POST /series/:slug/episodes/:epId/realign-subtitles  — 2026-05-26 快速重对齐字幕 (不重合视频)
 *   GET  /series/:slug/episodes/:epId/compose/progress   — SSE 进度转发
 */

import { Router, type Response } from "express";

import { enqueueComposeTask } from "../../../application/compose/composeTaskQueue";
import { realignSubtitles } from "../../../application/compose/realignSubtitles";
import { episodeComposeLockKey, tryAcquireEpisodeComposeLock, releaseEpisodeComposeLock, getEpisodeComposeLockHolder, composeLockBusyMessage } from "../../../application/compose/composeLock";
import { sseBroker } from "../sseBroker";

export const composeRouter = Router();

type ComposePostResult = Awaited<ReturnType<typeof enqueueComposeTask>>;

function sendComposePostResult(res: Response, result: ComposePostResult): void {
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
  res.json(result.body);
}

composeRouter.post("/series/:slug/episodes/:epId/compose", async (req, res, next) => {
  try {
    const result = await enqueueComposeTask(
      { slug: req.params.slug, episodeId: req.params.epId, body: req.body },
      { requestLog: req.log, requestId: req.requestId },
    );
    sendComposePostResult(res, result);
  } catch (err: unknown) {
    next(err);
  }
});

// 2026-05-26 — 快速重对齐字幕 (不重合视频):
//   读 concat_list.txt 拿 vault video paths → 抽音轨 → Whisper → 写新 SRT → 重烧到 final.mp4.
//   整集 50s 视频 ~30s 完成 (取决于 Whisper 模型大小), 比整集重合成 (5+ 分钟) 快 10x.
//   先决: 必须已有 source.mp4 + concat_list.txt (即先点过一次合成). 否则 400.
composeRouter.post("/series/:slug/episodes/:epId/realign-subtitles", async (req, res, next) => {
  // 客户端断开 → 触发 AbortController, 让正在跑的 ffmpeg / Whisper 收到 SIGKILL
  // 用 res.on("close") 而非 req.on("close") (后者 body-parser 读完就 emit 不可靠)
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  // 2026-07-10 Fable 二轮验收 P1-2 — realign 也重写 final.srt + 重烧 final.mp4, 是共享文件写者,
  // 必须与整集合成/管线/单镜重合成共用同一把每集锁, 否则边合成边重对齐会互相踩坏成片/字幕.
  const lockKey = episodeComposeLockKey(req.params.slug, req.params.epId);
  const realignJobId = `realign_${Date.now().toString(36)}`;
  if (!tryAcquireEpisodeComposeLock(lockKey, { job_id: realignJobId, source: "manual", mode: "realign", started_at: new Date().toISOString() })) {
    const holder = getEpisodeComposeLockHolder(lockKey);
    res.status(409).json({ error: { code: "ComposeInProgress", message: holder ? composeLockBusyMessage(holder) : "本集正在合成中, 请等它完成后再重对齐字幕。" } });
    return;
  }
  try {
    const result = await realignSubtitles(
      { slug: req.params.slug, episodeId: req.params.epId },
      {
        progress: {
          progress: (event, data) => {
            req.log?.info({ event, ...data }, `[realign] ${event}`);
          },
        },
        signal: ac.signal,
      },
    );
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
    } else {
      res.json(result.body);
    }
  } catch (err: unknown) {
    next(err);
  } finally {
    releaseEpisodeComposeLock(lockKey, realignJobId);
  }
});

// ═══════════════════════════════════════════════════════════════════
// P170 1B: GET /series/:slug/episodes/:epId/compose/progress — SSE 进度
// 转发到 sseBroker，按 job_id 或 series:slug 订阅
// ═══════════════════════════════════════════════════════════════════

composeRouter.get("/series/:slug/episodes/:epId/compose/progress", async (req, res, next) => {
  try {
    const job_id = req.query.job_id as string | undefined;
    const series_slug = req.params.slug;
    const rawId = (req.headers["last-event-id"] as string) ?? (req.query.lastEventId as string);
    const lastEventId = rawId != null ? Number(rawId) : undefined;

    const subId = job_id || `series:${series_slug}`;
    sseBroker.subscribe(subId, res, lastEventId);
    if (job_id && lastEventId == null) {
      sseBroker.replayFromId(job_id, 0, res);
    }
  } catch (err) { next(err); }
});
