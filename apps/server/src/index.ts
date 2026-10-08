import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import crypto from "node:crypto";
import { router } from "./api/routes";
import { v2Router } from "./api/v2";
import { getLastBackupStatus, setLastBackupStatus } from "./api/backupStatus";
import { getAppLogger, closeAppLogger, scrubForClient } from "../../../packages/core/src/logger";
import { requestLogging } from "./middleware/requestLogging";
import { localRequestGuard } from "./middleware/localRequestGuard";
// X7-4: 优雅退出时树杀所有登记在册的活跃 ffmpeg/whisper/python 子进程 (render/process.ts 极轻, 只依赖 node:child_process)。
import { killAllTrackedProcesses, activeChildProcessCount } from "../../../packages/render/src/process";

dotenv.config();

const app = express();
const port = Number(process.env.SERVER_PORT || 8788);
const origin = process.env.WEB_ORIGIN || "http://127.0.0.1:5173";
const isDev = process.env.NODE_ENV !== "production";

// X7-2 (A7-2, 2026-07-22): 每日自动备份状态 —— 之前备份失败只在启动 dev 终端刷一条 WARN, 无任何 UI/诊断可见性
// (archiver 坏了半天没人发现). 启动/cron 备份的调用点记录最近一次结果, 由 /healthz 暴露, `curl /healthz` 即可看。
// 2026-07-22 U-fix1: 状态挪到 ./api/backupStatus 共享持有者, 手动 POST /api/backup/create 也写它 (routes.ts),
// 三条备份路径同步 healthz, 不再各说各话 (EVIDENCE-api 项 6 尾注: 手动备份后 healthz 与实际脱节)。

// 请求上下文与访问日志共用可独立测试的 HTTP 中间件。
app.use(requestLogging({ verbose: isDev }));
// Reject foreign browser requests before parsing bodies or invoking any paid/data mutation route.
app.use(localRequestGuard(origin));

// C-N4 (2026-05-12): CORS methods 列表加 OPTIONS / PUT (PUT 给将来 idempotent 写预留;
// OPTIONS preflight cors 中间件本身处理, 但显式声明更清楚).
// Last-Event-ID 是 SSE 重连必需 header, 之前 allowedHeaders 漏了, 浏览器会被 CORS 拦.
app.use(cors({
  origin: true, // localRequestGuard has validated the origin, including localhost aliases.
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Request-Id", "Last-Event-ID"]
}));
// P180 A10 + 2026-05-14 (per PM): /api/v2/vault 路由使用 50MB parser
// (inpaint/remix 大图 + 用户手动导入外部生图; 50MB 够大多数 PNG/WEBP/JPEG)
// 必须在全局 2mb parser 之前挂载,否则大请求会被全局 parser 先拒绝。
// 同一 limit 也用于 shotStage 的 /firstframe/import-image 等需要 base64 上传的端点。
const largeBodyParser = express.json({ limit: "50mb" });
app.use("/api/v2/vault", largeBodyParser);
app.use("/api/v2/images", largeBodyParser);
app.use("/api/v2/shots", largeBodyParser);
app.use("/api/v2/series", largeBodyParser);

app.use(express.json({ limit: "2mb" }));
app.use((_req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});
app.use("/api", router);
app.use("/api/v2", v2Router);

// C-N2 (2026-05-12): 根级 /healthz endpoint, 零依赖, 用于监控 probe.
// /api/v2/health 也有, 但要求 v2Router 完整 boot; /healthz 即使 v2 出问题也活.
app.get("/healthz", (_req, res) => {
  // X7-2: 附带最近一次每日备份状态 (ok=null 表示本次进程还没跑过备份). 备份失败时 ok=false + error 可见。
  res.json({ ok: true, ts: new Date().toISOString(), last_backup: getLastBackupStatus() });
});

// C-N3 (2026-05-12): 全局 404 fallback, 返回 JSON 而不是 Express 默认 HTML.
// 必须放在所有路由 use 之后, error handler 之前.
app.use((req, res) => {
  res.status(404).json({
    error: { code: "NotFound", message: `路由不存在: ${req.method} ${req.path}` },
  });
});

function getHttpStatus(error: unknown): number {
  if (error && typeof error === "object") {
    const e = error as { status?: unknown; statusCode?: unknown };
    const raw = e.status ?? e.statusCode;
    if (typeof raw === "number" && raw >= 400 && raw <= 599) return raw;
  }
  return 500;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// 2026-05-20 P0 #6 安全 silent regression 修复:
//   原本地版漏 `Token <key>`(Vidu)+ `api-key/x-api-key` header 兜底两条 regex,
//   顶层 express error handler 用的是本地版,Vidu Token + header dump 不被 redact。
//   改用 packages/core/src/logger.ts:211 canonical 版(多上面 2 条 + 顺序保证幂等)。
// scrubForClient 从 logger import,见顶部

// malformed JSON → 400 (catches SyntaxError from express.json() before generic error handler)
app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error instanceof SyntaxError && (error as SyntaxError & { type?: unknown }).type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "BAD_JSON", message: "请求体 JSON 格式错误" } });
    return;
  }
  next(error);
});

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = req.requestId || crypto.randomUUID();
  const status = getHttpStatus(error);
  const message = scrubForClient(safeErrorMessage(error));
  const log = req.log;
  if (log) {
    log.error({ err: error instanceof Error ? error : new Error(String(error)), status }, `HTTP ${status}`);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[${requestId}] HTTP ${status}:`, error instanceof Error ? error.stack ?? error.message : error);
  }
  const rawDetail = isDev ? message : (status < 500 ? message : "Internal server error");
  const safeDetail = scrubForClient(rawDetail);
  // 如果 error 自带稳定的 `code` 字段(如 ProviderNotSelectedError.code = "provider_not_selected"),
  // 优先用它,前端 ErrorTranslator 可按 code 精确分支;否则回退到 HTTP_XXX 通用码。
  const errCodeRaw = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const errorCode = typeof errCodeRaw === "string" && /^[a-z][a-z0-9_]*$/i.test(errCodeRaw)
    ? errCodeRaw
    : (status >= 500 ? "INTERNAL_ERROR" : `HTTP_${status}`);
  res.status(status).json({
    error: {
      code: status >= 500 ? "INTERNAL_ERROR" : errorCode,
      message: status >= 500 ? "Internal server error" : safeDetail,
    },
    request_id: requestId,
  });
});

const server = app.listen(port, "127.0.0.1", async () => {
  const log = await getAppLogger();
  log.info(`ScriptForge server listening on http://127.0.0.1:${port}`);
  // v0.2.4: sweep orphaned "generating" scenes from any previous crash.
  // Async, non-blocking; if it fails we log and move on — the server
  // itself must stay up so the user can still open the UI and recover.
  void (async () => {
    try {
      const { reconcileOrphanedGeneratingScenes } = await import("./jobs/store");
      const result = await reconcileOrphanedGeneratingScenes();
      if (result.scenesRecovered > 0) {
        log.info(`[startup] reconciled ${result.scenesRecovered} orphaned "generating" scene(s) across ${result.jobsScanned} job(s)`);
      }

      // 4.D: Recover SQLite task_queue after a server restart. Running tasks
      // cannot be trusted after the process died, so fail them visibly and
      // atomically promote the next queued item.
      try {
        const { ensureTaskQueueTable, markRunningTasksFailedOnStartup, popNext } = await import("../../../packages/core/src/db/taskQueue");
        const { sseBroker } = await import("./api/v2/sseBroker");
        ensureTaskQueueTable();
        const failed = markRunningTasksFailedOnStartup("server_restart");
        for (const task of failed) {
          sseBroker.emit({
            type: "task.failed",
            job_id: task.episode_id || task.project_id || "__global__",
            task_id: task.id,
            data: { ...task, failed_reason: "server_restart" },
            at: new Date().toISOString()
          });
        }
        if (failed.length > 0) {
          log.info(`[startup] marked ${failed.length} running task_queue task(s) failed_reason=server_restart`);
        }
        const nextTask = popNext();
        if (nextTask) {
          sseBroker.emit({
            type: "task.running",
            job_id: nextTask.episode_id || nextTask.project_id || "__global__",
            task_id: nextTask.id,
            data: nextTask as unknown as Record<string, unknown>,
            at: new Date().toISOString()
          });
          log.info(`[startup] task_queue popNext promoted ${nextTask.id}`);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] task_queue recovery failed (non-fatal)`);
      }

      // T13: auto-migrate legacy outputs/ to projects/default/episodes/
      try {
        const { ensureMigration } = await import("../../../packages/core/src/migrate");
        const migResult = await ensureMigration();
        if (migResult.migrated.length > 0) {
          log.info(`[startup] T13 migration: ${migResult.migrated.length} job(s) migrated to projects/default/`);
        }
        if (migResult.errors.length > 0) {
          for (const e of migResult.errors) log.warn(`[startup] T13 migration error: ${e.jobId} — ${e.error}`);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] T13 migration failed (non-fatal)`);
      }

      // v2.1: restore task records from disk persistence
      const { restoreTasks, cleanupTrash } = await import("./api/v2/seriesStore");
      const taskResult = await restoreTasks();
      if (taskResult.restored > 0) {
        log.info(`[startup] restored ${taskResult.restored} task record(s) from disk${taskResult.rotated > 0 ? ` (rotated out ${taskResult.rotated})` : ""}`);
      }

      // v2.5: clean up expired trash directories on startup
      const trashResult = await cleanupTrash();
      if (trashResult.removed > 0) {
        log.info(`[startup] cleaned up ${trashResult.removed} expired trash director${trashResult.removed === 1 ? "y" : "ies"}`);
      }

      // A-7 (2026-05-12): 项目级回收站 (deleteProjectCascade 软删) 周期清理.
      // .trash/<slug>__<ts>/ 超过 7 天的物理删 + DB 行硬删.
      try {
        const { cleanupProjectTrash } = await import("../../../packages/core/src/db/projects");
        const projTrash = await cleanupProjectTrash();
        if (projTrash.removed > 0) {
          log.info(`[startup] cleaned up ${projTrash.removed} expired project(s) from .trash/ (freed ${projTrash.bytes} bytes)`);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] project trash cleanup failed (non-fatal)`);
      }

      // Periodic trash cleanup every 6 hours
      // FIX 2026-05-14: 加 unref() 让 graceful shutdown 不被这个 timer 卡住.
      const TRASH_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
      const trashCronTimer = setInterval(async () => {
        try {
          const { cleanupTrash: ct } = await import("./api/v2/seriesStore");
          const r = await ct();
          if (r.removed > 0) log.info(`[cron] cleaned up ${r.removed} expired trash director${r.removed === 1 ? "y" : "ies"}`);
        } catch (err) {
          log.warn("[cron] trash cleanup failed:", err instanceof Error ? err.message : err);
        }
      }, TRASH_CLEANUP_INTERVAL_MS);
      if (typeof trashCronTimer.unref === "function") trashCronTimer.unref();

      // W7 (2026-05-26): 把老 series.cast_id 单组字段迁到 cast_ids 数组. 一次性, 跑完即满足.
      // 不动 cast_id 老字段(留作回退兜底), 后续写操作只动 cast_ids.
      try {
        const { migrateSeriesCastIdToCastIds } = await import("./repositories/seriesCastMigration");
        const migr = await migrateSeriesCastIdToCastIds();
        if (migr.migrated > 0) {
          log.info(`[startup] W7 migration: ${migr.migrated} series 的素材组字段已升级 (老 cast_id → 新 cast_ids 数组)`);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] W7 series cast_ids migration failed (non-fatal)`);
      }

      // W7-real-fix (2026-05-15): EAGER 初始化 ProviderRegistry,注入 orchestrator。
      // 否则任何 image/video task 走 createFallbackMockRunner → 6ms 假装完成 +
      // 写空 0 字节 asset + 标记 generation done(用户看到"素材文件缺失"占位)。
      // 之前 getRegistry() 只在某些 controller(library/element/ai)被调时 lazy init,
      // 直接走 ShotStage → /firstframe/generate 路径根本不经过任何 getRegistry caller。
      try {
        const { getRegistry } = await import("./api/v2/orchestrationController");
        const reg = getRegistry();
        log.info(`[startup] ProviderRegistry eager-init OK, orchestrator now uses real provider runner (not mock)`);
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : err }, `[startup] ProviderRegistry eager-init FAILED — orchestrator will fall back to mock runner!`);
      }

      // 优化 5 (2026-05-19): 扫磁盘 pipelineStore — 把上次进程崩溃时 status="running"
      // 的 pipeline 标 "aborted" + error="进程重启时丢失", 避免 UI 永远显示 running.
      // 不"恢复 running 续跑" — fire-and-forget chain 无法跨进程, orchestrator 内
      // 已 enqueue 的 task 早已被 markRunningTasksFailedOnStartup 标 failed.
      try {
        const { recoverPipelinesOnStartup } = await import("./repositories/pipelineStore");
        const r = await recoverPipelinesOnStartup();
        if (r.marked_aborted.length > 0) {
          log.info(`[startup] auto-pipeline recover: marked ${r.marked_aborted.length} stale running pipeline(s) as aborted (scanned ${r.total_scanned} total)`);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] auto-pipeline recover failed (non-fatal)`);
      }

      // 2026-05-28 P1-50: compose task 启动恢复 — 重启后内存 activeComposeTasks 空,
      // 但 jsonl 里 compose task 还显 queued/running, 用户调 abort 会 silent fail.
      // 全部翻 failed + emit SSE 通知前端.
      try {
        const { recoverComposeTasksOnStartup } = await import("./application/compose/composeTaskQueue");
        const r = await recoverComposeTasksOnStartup();
        if (r.marked_failed > 0) {
          log.info(`[startup] compose task recover: ${r.marked_failed} stale compose task(s) marked failed`);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] compose task recover failed (non-fatal)`);
      }

      // 2026-05-28 P0-17: library export 目标目录启动检查 — 用户配 LIBRARY_VIDEO_DIR
      // env 但目录不存在时 throw, 避免 export 写到不存在路径 silent 失败.
      try {
        const { assertLibraryVideoDirOnStartup } = await import("./application/export/exportUseCases");
        await assertLibraryVideoDirOnStartup();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : err }, `[startup] LIBRARY_VIDEO_DIR 配置错误`);
      }

      // P180 B6: Resume inflight video tasks from previous session
      // Each inflight record contains provider_job_id + context for recovery.
      // On success: download video, save to vault, update shot generation.
      try {
        const { loadAllInflight, removeInflight, handleInflightResumeFailure } = await import("../../../packages/providers/src/core/inflightStore");
        const { getRegistry } = await import("./api/v2/orchestrationController");
        const inflightRecords = await loadAllInflight();
        if (inflightRecords.length > 0) {
          log.info(`[startup] found ${inflightRecords.length} inflight task(s), attempting resume...`);
          const reg = getRegistry();
          // 2026-07-10 audit — resume 成功要补记这笔"重启前已提交、钱已花"的费用到预算账本 (见下).
          // 先确保账本已从磁盘加载, 否则记账基线为空会把日账算错. loadCharges 幂等: 下方 budget 块再调是 no-op.
          // 加载失败 (budgetReady=false) 时跳过补记, 防基线错乱导致的重复计数 (账本 jsonl 才是最终真相, 下次启动会正确读入).
          const { budgetGuard } = await import("../../../packages/providers/src/core/budgetGuard");
          let budgetReady = false;
          try {
            await budgetGuard.loadCharges();
            budgetReady = true;
          } catch (budgetLoadErr) {
            log.warn(`[startup] budget ledger load before resume failed (记账将跳过, 视频恢复继续): ${budgetLoadErr instanceof Error ? budgetLoadErr.message : String(budgetLoadErr)}`);
          }
          for (const record of inflightRecords) {
            try {
              // X7-6 (2026-07-22): 图像 inflight 分流 —— 走图像 provider.resumePoll 把已扣费的图捞回归档柜(vault)。
              // 之前 resume 循环只 reg.getVideo()、只处理 videoRes.video.buffer, 图像 inflight 是 silent 审计死账
              // (X1-2 已在阿里万相图像 post-submit 失败时保留 inflight+context, 只差这条启动侧续取)。
              // 降级说明(SPEC 允许): 图像落盘只做 saveToVault(kind:"image") 到归档柜(用户可见可复用 + 补记扣费),
              // 不硬写 shot 生成记录 —— image shot-generation 是"候选数组 + picked 指针 + display_name"的复杂结构,
              // 重启侧无原始请求上下文, 硬塞有串味风险; 落到归档柜是安全且不丢已扣费资产的最小正确路径。
              if (record.context?.kind === "image") {
                let imgProvider;
                try { imgProvider = reg.getImage(record.provider_id); } catch { imgProvider = undefined; }
                if (imgProvider?.resumePoll) {
                  log.info(`[startup] resuming image ${record.provider_id} task ${record.provider_job_id}...`);
                  try {
                    const imgRes = await imgProvider.resumePoll(record.provider_job_id);
                    const images = imgRes?.images ?? [];
                    const savedIds: string[] = [];
                    if (images.length > 0) {
                      const { saveToVault } = await import("../../../packages/library/src/assetVault");
                      for (const img of images) {
                        try {
                          const entry = await saveToVault({
                            buffer: img.buffer,
                            kind: "image",
                            mime: img.mime || "image/png",
                            context: {
                              kind: "variant",
                              series_slug: record.context?.series_slug,
                              display_name: `恢复的图 ${record.provider_job_id}`,
                            },
                            provider_id: record.provider_id,
                            width: img.width,
                            height: img.height,
                            tags: ["resumed", "image-recovered", `job:${record.provider_job_id}`],
                          });
                          savedIds.push(entry.vault_id);
                        } catch (vErr: unknown) {
                          log.warn(`[startup] inflight ${record.inflight_id} image vault save failed: ${vErr instanceof Error ? vErr.message : String(vErr)}`);
                        }
                      }
                      log.info(`[startup] inflight ${record.inflight_id} 恢复图像 ${savedIds.length}/${images.length} 张到归档柜 (归档柜按 "resumed" 标签可找到)`);
                    }
                    // 补记已扣费 (与视频路径同口径: real cost 优先, 回退 inflight 估算)。
                    if (budgetReady && savedIds.length > 0) {
                      try {
                        let chargeCny = 0;
                        let chargeCurrency: "CNY" | "USD" = "CNY";
                        if (imgRes?.cost && typeof imgRes.cost.amount === "number" && imgRes.cost.amount > 0) {
                          chargeCny = imgRes.cost.amount;
                          chargeCurrency = imgRes.cost.currency === "USD" ? "USD" : "CNY";
                        } else if (typeof record.context?.cost_estimate === "number" && record.context.cost_estimate > 0) {
                          chargeCny = record.context.cost_estimate;
                        }
                        if (chargeCny > 0) {
                          budgetGuard.recordCharge(chargeCny, record.context?.job_id, record.provider_id, chargeCurrency);
                          log.info(`[startup] inflight ${record.inflight_id} 已补记已扣费 ¥${chargeCny.toFixed(2)} 到预算账本`);
                        }
                      } catch (cErr: unknown) {
                        log.warn(`[startup] inflight ${record.inflight_id} image recordCharge failed: ${cErr instanceof Error ? cErr.message : String(cErr)}`);
                      }
                    }
                    if (budgetReady) {
                      await removeInflight(record.inflight_id);
                      log.info(`[startup] inflight image task ${record.inflight_id} completed and removed`);
                    } else {
                      log.warn(`[startup] inflight ${record.inflight_id} 图像已恢复但账本未就绪, 保留 inflight 待下次补记扣费`);
                    }
                  } catch (err: unknown) {
                    // X7-5: 图像 resume 失败 → 归档策略 (连续 ≥3 或超龄 abandoned, 否则保留重试)。
                    const outcome = await handleInflightResumeFailure(record, err instanceof Error ? err.message : String(err));
                    if (outcome.outcome === "abandoned") {
                      log.info(`[startup] inflight image ${record.inflight_id} 归档为 abandoned (${outcome.reason}); 已扣费凭证保留 data/inflight/abandoned/`);
                    } else {
                      log.warn(`[startup] inflight image ${record.inflight_id} resume 失败 (第 ${outcome.attempts} 次, 保留待重试): ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }
                } else {
                  // X7-5: 图像 provider 不可用 / 无 resumePoll → 归档策略。
                  const outcome = await handleInflightResumeFailure(record, `图像 provider ${record.provider_id} 不可用或无 resumePoll 能力`);
                  if (outcome.outcome === "abandoned") {
                    log.info(`[startup] inflight image ${record.inflight_id} 归档为 abandoned (${outcome.reason})`);
                  } else {
                    log.warn(`[startup] 图像 provider ${record.provider_id} 无 resumePoll, 保留 inflight 留存审计 (第 ${outcome.attempts} 次): ${record.inflight_id}`);
                  }
                }
                continue;
              }
              const provider = reg.getVideo(record.provider_id);
              if (provider?.resumePoll) {
                log.info(`[startup] resuming ${record.provider_id} task ${record.provider_job_id}...`);
                // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
                // 删 AbortSignal.timeout(30 * 60_000). resume poll 等多久就等多久,
                // 进程关闭时 graceful shutdown 会清理 inflight 记录.
                try {
                  const videoRes: any = await provider.resumePoll(record.provider_job_id);
                  // B6: store resumed video in vault + update shot
                  if (videoRes?.video?.buffer) {
                    try {
                      const { saveToVault } = await import("../../../packages/library/src/assetVault");
                      const vaultEntry = await saveToVault({
                        buffer: videoRes.video.buffer,
                        kind: "video",
                        mime: videoRes.video.mime || "video/mp4",
                        context: {
                          kind: "shot_video",
                          series_slug: record.context.series_slug,
                          shot_id: record.context.shot_id,
                        },
                        provider_id: record.provider_id,
                        width: videoRes.video.width,
                        height: videoRes.video.height,
                        duration_sec: videoRes.video.duration_sec,
                        tags: ["resumed", `job:${record.provider_job_id}`],
                      });
                      log.info(`[startup] inflight ${record.inflight_id} saved to vault ${vaultEntry.vault_id}`);

                      // Update shot with new generation record (best-effort)
                      if (record.context?.series_slug && record.context?.shot_id) {
                        try {
                          const store = await import("./api/v2/seriesStore");
                          const series = await store.readSeries(record.context.series_slug);
                          if (series?.episodes) {
                            const gen: any = {
                              generation_id: vaultEntry.vault_id,
                              provider: record.provider_id,
                              vault_id: vaultEntry.vault_id,
                              asset_id: vaultEntry.vault_id,
                              status: "done" as const,
                              type: "video" as const,
                              created_at: new Date().toISOString(),
                              provider_job_id: record.provider_job_id,
                            };
                            for (const epId of series.episodes) {
                              try {
                                const shot = await store.readShot(record.context.series_slug, epId, record.context.shot_id);
                                if (shot) {
                                  if (!shot.generations) shot.generations = [];
                                  shot.generations.push(gen);
                                  await store.updateShot(record.context.series_slug, epId, record.context.shot_id, { generations: shot.generations });
                                  log.info(`[startup] inflight ${record.inflight_id} shot ${record.context.shot_id} updated`);
                                  break;
                                }
                              } catch { /* try next episode */ }
                            }
                          }
                        } catch (shotErr: unknown) {
                          log.warn(`[startup] inflight ${record.inflight_id} shot update skipped: ${shotErr instanceof Error ? shotErr.message : String(shotErr)}`);
                        }
                      }
                    } catch (vaultErr: unknown) {
                      log.warn(`[startup] inflight ${record.inflight_id} vault save failed: ${vaultErr instanceof Error ? vaultErr.message : String(vaultErr)}`);
                    }

                    // 2026-07-10 audit — 恢复成功 = 远端任务在重启前已提交、钱已花. 之前 resume 成功后
                    // 从不 recordCharge → budgetGuard 账本永久缺这笔 → 日 / 单作业 / 单 provider 三档硬熔断
                    // 按低于真实花费的口径, 预算被架空. 这里补记: real cost 优先, 回退 inflight 估算 /
                    // provider.estimateCost (可灵等 resumePoll 不返 cost、也不持久化 cost_estimate, 必须靠估算).
                    if (budgetReady) {
                      try {
                        let chargeCny = 0;
                        let chargeCurrency: "CNY" | "USD" = "CNY";
                        if (videoRes.cost && typeof videoRes.cost.amount === "number" && videoRes.cost.amount > 0) {
                          chargeCny = videoRes.cost.amount;
                          chargeCurrency = videoRes.cost.currency === "USD" ? "USD" : "CNY";
                        } else if (typeof record.context?.cost_estimate === "number" && record.context.cost_estimate > 0) {
                          chargeCny = record.context.cost_estimate;
                        } else if (provider.estimateCost) {
                          try {
                            const est = provider.estimateCost({
                              prompt: "",
                              duration_sec: record.context?.duration_sec ?? 5,
                              aspect_ratio: (record.context?.aspect_ratio ?? "16:9") as "9:16" | "16:9" | "1:1" | "4:3" | "3:4",
                            });
                            if (est && typeof est.cny === "number" && est.cny > 0) chargeCny = est.cny;
                          } catch { /* estimate best-effort */ }
                        }
                        if (chargeCny > 0) {
                          budgetGuard.recordCharge(chargeCny, record.context?.job_id, record.provider_id, chargeCurrency);
                          log.info(`[startup] inflight ${record.inflight_id} 已补记已扣费 ¥${chargeCny.toFixed(2)} 到预算账本`);
                        }
                      } catch (chargeErr: unknown) {
                        log.warn(`[startup] inflight ${record.inflight_id} recordCharge failed: ${chargeErr instanceof Error ? chargeErr.message : String(chargeErr)}`);
                      }
                    }
                  }
                  // 2026-07-10 终验补 — 仅账本就绪(已补记)后才删 inflight; budgetReady=false(loadCharges
                  // 磁盘故障)时保留 inflight, 留待下次启动账本恢复后补记这笔已扣费, 不让它从账本永久丢失。
                  if (budgetReady) {
                    await removeInflight(record.inflight_id);
                    log.info(`[startup] inflight task ${record.inflight_id} completed and removed`);
                  } else {
                    log.warn(`[startup] inflight ${record.inflight_id} 已恢复但账本未就绪, 保留 inflight 待下次启动补记扣费`);
                  }
                } catch (err: unknown) {
                  // 2026-07-10 audit — resume 失败不静默删 inflight: 远端任务可能已扣费, 删了 = 钱花了、视频也丢了.
                  // X7-5 (2026-07-22): 但也不再无限保留刷 WARN —— 连续失败 ≥3 次或年龄 >7 天归档 abandoned
                  // (搬 data/inflight/abandoned/ 留审计、不删除), 否则保留句柄下次重试 (resumePoll 只重下载不重提交, 不重复扣费).
                  const outcome = await handleInflightResumeFailure(record, err instanceof Error ? err.message : String(err));
                  if (outcome.outcome === "abandoned") {
                    log.info(`[startup] inflight ${record.inflight_id} resume 连续失败/超龄, 归档 abandoned (${outcome.reason}); 已扣费凭证保留待人工处理`);
                  } else {
                    log.warn(`[startup] inflight task ${record.inflight_id} resume 失败 (第 ${outcome.attempts} 次, 保留待重试, 不删除防丢已扣费): ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              } else {
                // 2026-07-10 audit — provider 无 resumePoll 能力也不静默删 (可能已扣费, 删了清掉唯一凭证).
                // X7-5: 走归档策略 —— 连续/超龄阈值后 abandoned (不删除、留审计), 不再每次启动永久刷同一条 WARN.
                const outcome = await handleInflightResumeFailure(record, `provider ${record.provider_id} 无 resumePoll 能力`);
                if (outcome.outcome === "abandoned") {
                  log.info(`[startup] inflight ${record.inflight_id} 归档为 abandoned (${outcome.reason}); provider 无 resumePoll, 凭证保留 data/inflight/abandoned/`);
                } else {
                  log.warn(`[startup] provider ${record.provider_id} 无 resumePoll 能力, 保留 inflight 留存审计 (第 ${outcome.attempts} 次): ${record.inflight_id}`);
                }
              }
            } catch (err: unknown) {
              log.warn(`[startup] inflight ${record.inflight_id} error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] inflight resume failed (non-fatal)`);
      }

      // S2: Load persisted budget charges from disk
      try {
        const { budgetGuard } = await import("../../../packages/providers/src/core/budgetGuard");
        await budgetGuard.loadCharges();
        log.info(`[startup] budgetGuard loaded, daily used=¥${budgetGuard.getDailyUsed().toFixed(2)}`);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] budgetGuard load failed (non-fatal)`);
      }

      // 4.E: keep one rolling backup per day under ~/.video-generate-backups
      try {
        const { ensureDailyBackup } = await import("./api/dataManagement");
        const created = await ensureDailyBackup();
        // X7-2: 记录成功状态 (created=null 表示今天已有非空备份, 也算 ok). /healthz 可见。
        setLastBackupStatus({ ok: true, at: new Date().toISOString(), filename: created?.filename ?? null, error: null });
        if (created) {
          log.info(`[startup] daily backup created: ${created.filename}`);
        }
        // FIX 2026-05-14: 加 unref() 让 graceful shutdown 不被这个 timer 卡住.
        const dailyBackupTimer = setInterval(async () => {
          try {
            const daily = await ensureDailyBackup();
            setLastBackupStatus({ ok: true, at: new Date().toISOString(), filename: daily?.filename ?? null, error: null });
            if (daily) log.info(`[cron] daily backup created: ${daily.filename}`);
          } catch (err) {
            setLastBackupStatus({ ok: false, at: new Date().toISOString(), filename: null, error: scrubForClient(err instanceof Error ? err.message : String(err)) });
            log.warn({ err: err instanceof Error ? err.message : err }, `[cron] daily backup failed`);
          }
        }, 24 * 60 * 60 * 1000);
        if (typeof dailyBackupTimer.unref === "function") dailyBackupTimer.unref();
      } catch (err) {
        // X7-2: 备份失败不再只 console —— 写进共享状态, /healthz 的 last_backup.ok=false 即暴露给诊断。
        setLastBackupStatus({ ok: false, at: new Date().toISOString(), filename: null, error: scrubForClient(err instanceof Error ? err.message : String(err)) });
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] daily backup init failed (non-fatal)`);
      }

      // P180 B5: Start retry-until-satisfied poll loop (resume active jobs after restart)
      try {
        const { startPollLoop } = await import("./jobs/retryJob");
        startPollLoop();
        log.info("[startup] retry job poll loop started");
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] retry job poll loop failed (non-fatal)`);
      }

      // B2 (2026-05-15): 恢复 realVideoLock 持久化状态. 读 data/real_video_lock.json,
      // 用 inflight 队列校对 — 残留死锁自动清理, 真实仍在跑的任务保留锁.
      try {
        const { initRealVideoLock } = await import("../../../packages/core/src/realVideoLock");
        const r = await initRealVideoLock();
        if (r.restored) {
          log.info(
            `[startup] realVideoLock restored: provider=${r.holder?.provider} job=${r.holder?.jobId} scene=${r.holder?.sceneId}`,
          );
        } else if (r.removedStale) {
          log.info(`[startup] realVideoLock removed stale lock file (no matching inflight)`);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, `[startup] realVideoLock init failed (non-fatal)`);
      }

      // T7: warmup vault index cache (after initRealVideoLock)
      try {
        const { warmupVaultCache } = await import("../../../packages/library/src/assetVault");
        await warmupVaultCache();
        log.info("[startup] vault index cache warmed up");
      } catch (err) {
        console.warn("[startup] vault warmCache failed (non-fatal):", err instanceof Error ? err.message : err);
      }

      // T7: vault trash 90 天自动清理 — 延迟 30s 首次执行，之后每 24h 一次
      const runVaultCleanup = async () => {
        try {
          const { cleanupOldTrash } = await import("../../../packages/library/src/assetVault");
          const removed = await cleanupOldTrash(90);
          if (removed > 0) {
            log.info(`[vault-cleanup] removed ${removed} trashed entries older than 90d`);
          }
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : err }, `[vault-cleanup] failed (non-fatal)`);
        }
      };
      // FIX 2026-05-14: 加 unref() 让 graceful shutdown 不被这些 timer 卡住.
      const vaultFirstTimer = setTimeout(runVaultCleanup, 30_000);
      if (typeof vaultFirstTimer.unref === "function") vaultFirstTimer.unref();
      const vaultCronTimer = setInterval(runVaultCleanup, 24 * 60 * 60 * 1000);
      if (typeof vaultCronTimer.unref === "function") vaultCronTimer.unref();

      // V-7: Element 回收站定期清理 — 遍历所有系列清理过期的 element trash
      const ELEMENT_TRASH_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
      const runElementTrashCleanup = async () => {
        try {
          const { listSeries } = await import("./repositories/seriesRepo");
          const { cleanupElementTrash } = await import("./repositories/_softDeleteHelper");
          const allSeries = await listSeries();
          let totalRemoved = 0;
          for (const s of allSeries) {
            try {
              const r = await cleanupElementTrash(s.slug);
              totalRemoved += r.removed;
            } catch { /* 单个系列清理失败不阻塞其他 */ }
          }
          if (totalRemoved > 0) {
            log.info(`[cron] cleaned up ${totalRemoved} expired element trash entr${totalRemoved === 1 ? "y" : "ies"}`);
          }
        } catch (err) {
          log.warn("[cron] element trash cleanup failed:", err instanceof Error ? err.message : err);
        }
      };
      const elemTrashFirstTimer = setTimeout(runElementTrashCleanup, 60_000);
      if (typeof elemTrashFirstTimer.unref === "function") elemTrashFirstTimer.unref();
      const elemTrashCronTimer = setInterval(runElementTrashCleanup, ELEMENT_TRASH_CLEANUP_INTERVAL_MS);
      if (typeof elemTrashCronTimer.unref === "function") elemTrashCronTimer.unref();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, `[startup] reconcile step failed (non-fatal)`);
    }
  })();
});

// B-N6 (2026-05-12): 优雅退出. 之前 SIGTERM / SIGINT 直接 process.exit, WAL 文件未
// checkpoint 大概率没事但极端情况下下次启动 recovery 慢. 现在:
//   1. 停止接受新连接 (server.close)
//   2. 给现有请求 10s 处理时间
//   3. checkpoint + 关 db
//   4. 退出
let _shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  const log = await getAppLogger();
  log.info(`[shutdown] received ${signal}, draining...`);
  const forceTimer = setTimeout(() => {
    log.warn(`[shutdown] timed out after 10s, forcing exit`);
    process.exit(1);
  }, 10_000);
  if (typeof forceTimer.unref === "function") forceTimer.unref();
  try {
    server.close(() => {
      log.info(`[shutdown] http server closed`);
    });
  } catch { /* ignore */ }
  // X7-4 (A5-6b): 关连接后立刻树杀在跑的 ffmpeg/whisper/python 子进程 —— Windows 上父进程退出不自动收子进程,
  // 不杀就留孤儿 ffmpeg 持有 final.mp4 写句柄, 用户重启再合成撞"文件被占用". 在 closeDb 前杀, 让文件锁尽快释放。
  try {
    const n = activeChildProcessCount();
    killAllTrackedProcesses();
    if (n > 0) log.info(`[shutdown] tree-killed ${n} active child process(es) (ffmpeg/whisper/python)`);
  } catch (err) {
    log.warn({ err }, `[shutdown] killAllTrackedProcesses failed`);
  }
  try {
    const { closeDb } = await import("../../../packages/core/src/db/index");
    closeDb();
    log.info(`[shutdown] db closed (WAL checkpointed)`);
  } catch (err) {
    log.warn({ err }, `[shutdown] db close failed`);
  }
  try { await closeAppLogger(); } catch { console.error("[shutdown] 日志未能完全刷盘"); }
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });

// X7-4 (A5-9, 2026-07-22): 全局兜底 —— Express 请求生命周期之外的代码 (setInterval/setTimeout 回调、SSE 心跳、
// fire-and-forget 异步 IIFE、第三方依赖内部同步抛错) 一旦 uncaughtException / unhandledRejection, Node 默认
// 直接崩溃退出: 不 checkpoint DB WAL、不清在跑的 ffmpeg 子进程 (留孤儿锁 final.mp4)、tsx watch 也不自动拉起.
// 这里接住 → 记日志 → 走同一条 gracefulShutdown (至少 checkpoint DB + 树杀子进程) 再退出, 把硬崩溃变成优雅退出。
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error(`[fatal] uncaughtException — attempting graceful shutdown:`, err instanceof Error ? err.stack ?? err.message : err);
  void gracefulShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error(`[fatal] unhandledRejection — attempting graceful shutdown:`, reason instanceof Error ? reason.stack ?? reason.message : reason);
  void gracefulShutdown("unhandledRejection");
});
