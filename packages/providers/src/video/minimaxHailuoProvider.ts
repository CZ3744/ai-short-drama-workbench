// P20: MiniMax Hailuo Video Provider wrapper — adapts minimaxVideo.ts to VideoProvider interface

import path from "node:path";
import type { PresetOption } from "../../../core/src/presetSchema";
import type { VideoProvider, VideoGenerateRequest, VideoGenerateResponse, ProviderContext, HealthCheckResult } from "../core/types";
import { ProviderError } from "../core/errors";
import { saveInflight, removeInflight } from "../core/inflightStore";
import { MiniMaxHailuoVideoProvider } from "../minimaxVideo";
import { loadMiniMaxConfig, submitTextToVideo, pollVideoTask, retrieveFile, downloadFile } from "../minimaxClient";
import { clampPrompt } from "../minimaxVideo";
import { getConfigValue } from "../../../core/src/localSettings";
import type { ClipJobInput } from "../video";

/** T3: MiniMax pricing is in USD. Use configurable rate to convert to CNY. */
function getUSDCNYRate(): number {
  const raw = getConfigValue("USD_CNY_RATE", "7.2");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 7.2;
}

export class MiniMaxHailuoVideoWrapper implements VideoProvider {
  readonly id: string;
  readonly mode: "t2v" = "t2v";
  private _inner: MiniMaxHailuoVideoProvider;
  private _apiKey: string | null;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._apiKey = apiKey;
    this._inner = new MiniMaxHailuoVideoProvider({
      apiKey: apiKey ?? undefined,
    });
  }

  // 2026-05-21 X-1: request.last_frame 在 t2v provider 不适用, silent 忽略 (不抛错保持向后兼容).
  async generate(req: VideoGenerateRequest, ctx: ProviderContext): Promise<VideoGenerateResponse> {
    // 2026-05-18: 二级 instance_override
    const override = req.instance_override;
    const effectiveKey = override?.api_key?.trim() || this._apiKey;
    if (!effectiveKey) {
      throw new ProviderError({
        message: "MiniMax API key not configured (实例未填 api_key 也无 env fallback)",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    const baseCfg = loadMiniMaxConfig();
    const config = {
      ...baseCfg,
      apiKey: effectiveKey,
      baseUrl: override?.api_base_url?.trim() || baseCfg.baseUrl,
    };
    const clamped = clampPrompt(req.prompt || "");

    // M6: Submit first, then saveInflight immediately for crash recovery
    let taskId: string | undefined;
    let inflightId: string | undefined;
    // 2026-07-09 audit C7 sibling: post-submit 瞬时失败保留 inflight 句柄给 startup resumePoll 恢复已扣费任务
    let preserveInflightForResume = false;
    try {
      const submitResult = await submitTextToVideo(config, {
        prompt: clamped.text,
        model: req.model_id?.trim() || config.model,
        duration: req.duration_sec,
        // 2026-05-27 — audit P0-11 真凶: 之前两边都写 768P, 用户配 1080P silent ignored.
        // MiniMax 海螺 9:16 / 16:9 都支持 768P / 1080P, 走 config.resolution (用户在 settings 选).
        resolution: ((config as { resolution?: string }).resolution as string | undefined) || "768P",
      });
      taskId = submitResult.task_id;

      // M6: saveInflight immediately after submit (before poll)
      const inflight = await saveInflight({
        provider_id: this.id,
        provider_job_id: taskId,
        submitted_at: new Date().toISOString(),
        context: { series_slug: ctx.series_slug, shot_id: ctx.task_id, kind: "video", job_id: ctx.job_id, aspect_ratio: req.aspect_ratio, duration_sec: req.duration_sec },
      });
      inflightId = inflight.inflight_id;

      // Poll until complete (T1: pass ctx.signal for abort propagation)
      const pollResult = await pollVideoTask(config, taskId, undefined, ctx.signal);
      if (pollResult.status === "Fail") {
        throw new ProviderError({
          message: `MiniMax task ${taskId} failed`,
          code: "server",
          provider_id: this.id,
          retriable: false,
        });
      }

      // Retrieve download URL
      const retrieveResult = await retrieveFile(config, pollResult.file_id!);

      // Download MP4
      const tmpDir = path.join(process.cwd(), "outputs", "tmp");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(tmpDir, { recursive: true });
      const outputPath = path.join(tmpDir, `minimax_${Date.now()}.mp4`);
      const downloadResult = await downloadFile(retrieveResult.download_url, outputPath, config.downloadTimeoutMs);

      // Read buffer
      const fs = await import("node:fs/promises");
      const buffer = await fs.readFile(downloadResult.filePath);

      // Clean up temp file
      fs.unlink(downloadResult.filePath).catch(() => {});

      return {
        video: {
          buffer,
          mime: "video/mp4",
          duration_sec: req.duration_sec,
          width: pollResult.video_width ?? 1280,
          height: pollResult.video_height ?? 720,
        },
      };
    } catch (err: any) {
      // 2026-07-09 audit C7 sibling: submit 边界在 submitTextToVideo(上面 taskId = submitResult.task_id)。
      // taskId 一旦被赋值 = MiniMax 端任务已建、可能已出片已扣费。此后任何失败(poll timeout/abort、
      // retrieve、下载 CDN 500)绝不能 retriable:true — queue._execute(queue.ts:222) 认 retriable 会重跑
      // generate() 重新 submitTextToVideo 一个全新计费任务 = 同一视频重复扣费, budgetGuard 只记成功 1 次,
      // 架空日预算硬熔断。submit 之前(taskId 未定义、还没建远端任务、没扣费)的失败才可 retriable:true。
      const postSubmit = taskId !== undefined;
      if (err instanceof ProviderError) {
        // post-submit 瞬时 ProviderError 强制 retriable:false 防重跑重扣, 保留 inflight 给 resumePoll。
        if (postSubmit && err.retriable) {
          preserveInflightForResume = true;
          throw new ProviderError({
            message: err.message,
            code: err.code,
            provider_id: this.id,
            retriable: false,
            original: (err as any).original ?? err,
          });
        }
        throw err;
      }
      // P186-T2: classify by keyword before falling back to server
      const msg = (err.message ?? String(err)).toLowerCase();
      if (msg.includes("content policy") || msg.includes("safety") || msg.includes("invalid_prompt")) {
        // 内容审核 = 终态(重试/重提交也会再被拒), inflight 由 finally 清。
        throw new ProviderError({
          message: err.message ?? String(err),
          code: "content_policy",
          provider_id: this.id,
          retriable: false,
          original: err,
        });
      }
      // 通用错误: pre-submit(还没建远端任务、没扣费)可 retriable:true 让 queue 安全重试;
      // post-submit(taskId 已定义)必须 retriable:false 防重扣, 并保留 inflight 给 startup resumePoll。
      if (postSubmit) preserveInflightForResume = true;
      throw new ProviderError({
        message: err.message ?? String(err),
        code: "server",
        provider_id: this.id,
        retriable: !postSubmit,
        original: err,
      });
    } finally {
      // M6 + 2026-07-09 audit C7 sibling: 成功 / 终态失败 → 清 inflight;
      // post-submit 瞬时失败 → 保留句柄让 startup resumePoll 恢复已扣费任务, 不重新提交。
      if (inflightId && !preserveInflightForResume) await removeInflight(inflightId).catch(() => {});
    }
  }

  // S1: MiniMax API 不支持远端取消，返回 unsupported
  async cancel(_providerJobId: string, _ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed"> {
    return "unsupported";
  }

  // T3: MiniMax 官方定价 USD $0.3/s，通过 USD_CNY_RATE 换算为 CNY
  estimateCost(req: VideoGenerateRequest): { cny: number; basis: "estimated"; original_currency?: string } {
    const usdPerSec = 0.3;
    const usd = req.duration_sec * usdPerSec;
    const rate = getUSDCNYRate();
    return { cny: usd * rate, basis: "estimated", original_currency: "USD" };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing key" };
    return { ok: true };
  }

  async resumePoll(providerJobId: string, signal?: AbortSignal): Promise<VideoGenerateResponse> {
    if (!this._apiKey) {
      throw new ProviderError({
        message: "MiniMax API key not configured",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }
    return this._inner.resumePoll(providerJobId, signal);
  }
}
