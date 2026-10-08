// P20: Aliyun Wan Video Provider wrapper — adapts aliyunWanVideo.ts to VideoProvider interface

import fs from "node:fs/promises";
import path from "node:path";
import type { PresetOption } from "../../../core/src/presetSchema";
import type { VideoProvider, VideoGenerateRequest, VideoGenerateResponse, ProviderContext, HealthCheckResult } from "../core/types";
import { ProviderError } from "../core/errors";
import { loadAllInflight } from "../core/inflightStore";
import { AliyunWanT2VProvider } from "../aliyunWanVideo";
import { loadAliyunWanConfig, submitWanTextToVideo, pollWanTask, downloadWanFile } from "../aliyunWanClient";
import { saveInflight, removeInflight } from "../core/inflightStore";
import type { ClipJobInput } from "../video";

function parseWanSize(size: string): { w: number; h: number } | null {
  const match = /^(\d+)[*x](\d+)$/i.exec(size.trim());
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

function wanSizeForAspect(aspect: string, fallbackSize: string): string {
  const parsed = parseWanSize(fallbackSize);
  if (!parsed) return fallbackSize;
  const long = Math.max(parsed.w, parsed.h);
  const short = Math.min(parsed.w, parsed.h);
  switch (aspect) {
    case "9:16":
      return `${short}*${long}`;
    case "1:1":
      return `${short}*${short}`;
    case "16:9":
    default:
      return `${long}*${short}`;
  }
}

function wanDimsFromSize(size: string, aspect: string): { w: number; h: number } {
  const parsed = parseWanSize(size);
  if (parsed) return parsed;
  if (aspect === "9:16") return { w: 832, h: 1280 };
  if (aspect === "1:1") return { w: 832, h: 832 };
  return { w: 1280, h: 720 };
}

export class AliyunWanVideoProvider implements VideoProvider {
  readonly id: string;
  readonly mode: "t2v" = "t2v";
  private _inner: AliyunWanT2VProvider;
  private _apiKey: string | null;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._apiKey = apiKey;
    this._inner = new AliyunWanT2VProvider({
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
        message: "Aliyun Wan API key not configured (实例未填 api_key 也无 env fallback)",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    const baseCfg = loadAliyunWanConfig();
    const config = {
      ...baseCfg,
      apiKey: effectiveKey,
      baseUrl: override?.api_base_url?.trim() || baseCfg.baseUrl,
      region: override?.region?.trim() || baseCfg.region,
    };
    const maxPromptChars = 800;
    const promptText = req.prompt && req.prompt.length > maxPromptChars
      ? req.prompt.slice(0, maxPromptChars)
      : (req.prompt || "");
    const submitSize = wanSizeForAspect(req.aspect_ratio, config.size);

    // M7: Submit first, then saveInflight immediately for crash recovery
    let taskId: string | undefined;
    let inflightId: string | undefined;
    // 2026-07-10 audit C7 sibling: post-submit 瞬时失败保留 inflight 给 startup resumePoll (防重跑重扣)
    let preserveInflightForResume = false;
    try {
      const submitResult = await submitWanTextToVideo(config, {
        prompt: promptText,
        model: req.model_id?.trim() || config.model,
        size: submitSize,
        duration: req.duration_sec || config.duration,
        promptExtend: config.promptExtend,
        watermark: config.watermark,
        seed: req.seed ?? config.seed,
        negativePrompt: typeof req.extras?.negative_prompt === "string" ? req.extras.negative_prompt : config.negativePrompt,
      });
      taskId = submitResult.task_id;

      // M7: saveInflight right after submit, before poll
      const inflight = await saveInflight({
        provider_id: this.id,
        provider_job_id: taskId,
        submitted_at: new Date().toISOString(),
        context: { series_slug: ctx.series_slug, shot_id: ctx.task_id, kind: "video", job_id: ctx.job_id, aspect_ratio: req.aspect_ratio, duration_sec: req.duration_sec },
      });
      inflightId = inflight.inflight_id;

      // Poll until complete (T1: pass ctx.signal for abort propagation)
      const pollResult = await pollWanTask(config, taskId, undefined, ctx.signal);
      if (pollResult.task_status === "FAILED" || pollResult.task_status === "CANCELED") {
        throw new ProviderError({
          message: `Aliyun Wan task ${taskId} ended with status ${pollResult.task_status}`,
          code: "server",
          provider_id: this.id,
          retriable: false,
        });
      }
      if (!pollResult.video_url) {
        throw new ProviderError({
          message: `Aliyun Wan task ${taskId} succeeded but no video_url`,
          code: "server",
          provider_id: this.id,
          retriable: false,
        });
      }

      // Download
      const tmpDir = path.join(process.cwd(), "outputs", "tmp");
      await fs.mkdir(tmpDir, { recursive: true });
      const outputPath = path.join(tmpDir, `aliyun_wan_${Date.now()}.mp4`);
      await downloadWanFile(pollResult.video_url, outputPath, config.downloadTimeoutMs);
      const buffer = await fs.readFile(outputPath);
      await fs.unlink(outputPath).catch(() => {});

      const dims = wanDimsFromSize(submitSize, req.aspect_ratio);

      return {
        video: {
          buffer,
          mime: "video/mp4",
          duration_sec: req.duration_sec,
          width: dims.w,
          height: dims.h,
        },
      };
    } catch (err: any) {
      // 2026-07-10 终验补 — post-submit 的 retriable ProviderError 也降级(对齐 baidu/zhipu/tencent),
      // 防将来给 aliyunWanClient 的 poll/download 加 ProviderError 分类时绕过下方 postSubmit 降级 → 重复扣费。
      if (err instanceof ProviderError) {
        if (taskId !== undefined && err.retriable) {
          preserveInflightForResume = true;
          throw new ProviderError({ message: err.message, code: err.code, provider_id: this.id, retriable: false, original: (err as { original?: unknown }).original ?? err });
        }
        throw err;
      }
      // P186-T2: classify by keyword before falling back to server
      const msg = (err.message ?? String(err));
      if (msg.includes("InvalidParameter")) {
        throw new ProviderError({
          message: msg,
          code: "invalid_prompt",
          provider_id: this.id,
          retriable: false,
          original: err,
        });
      }
      // 2026-07-10 audit C7 sibling: taskId 已赋值 = 远端任务已建、可能已扣费。post-submit 的
      // poll/download/网络失败绝不能 retriable:true — queue 会重跑 generate() 重新 submit 一个
      // 全新计费任务 = 同一视频重复扣费 (minimax C7 已修, aliyun 兄弟点漏了)。保留 inflight 给
      // startup resumePoll 恢复已扣费任务。
      const postSubmit = taskId !== undefined;
      if (postSubmit) preserveInflightForResume = true;
      throw new ProviderError({
        message: msg,
        code: "server",
        provider_id: this.id,
        retriable: !postSubmit,
        original: err,
      });
    } finally {
      // M7: remove inflight on completion or error (C7 sibling: post-submit 失败保留给 resumePoll)
      if (inflightId && !preserveInflightForResume) await removeInflight(inflightId).catch(() => {});
    }
  }

  // S1: Aliyun DashScope 不支持远端取消，返回 unsupported
  async cancel(_providerJobId: string, _ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed"> {
    return "unsupported";
  }

  // B3: 预估成本(通义万相约0.3元/秒)
  estimateCost(req: VideoGenerateRequest): { cny: number; basis: "estimated" } {
    return { cny: req.duration_sec * 0.3, basis: "estimated" };
  }

  // S4: resume inflight poll after server restart
  async resumePoll(providerJobId: string, signal?: AbortSignal): Promise<VideoGenerateResponse> {
    if (!this._apiKey) {
      throw new ProviderError({
        message: "Aliyun Wan API key not configured",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    const config = loadAliyunWanConfig();
    // Override with our stored key
    config.apiKey = this._apiKey;

    // S4: 从 inflightStore 读 context 获取原始请求参数
    let durationSec = 5;
    let aspectRatio = "16:9";
    try {
      const allInflight = await loadAllInflight();
      const match = allInflight.find(r => r.provider_job_id === providerJobId && r.provider_id === this.id);
      if (match?.context) {
        durationSec = (match.context as any).duration_sec ?? durationSec;
        aspectRatio = (match.context as any).aspect_ratio ?? aspectRatio;
      }
    } catch { /* best-effort */ }

    // Poll existing task (T1: pass signal for abort propagation)
    const pollResult = await pollWanTask(config, providerJobId, undefined, signal);
    if (pollResult.task_status === "FAILED" || pollResult.task_status === "CANCELED") {
      throw new ProviderError({
        message: `Aliyun Wan task ${providerJobId} ended with status ${pollResult.task_status}`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    if (!pollResult.video_url) {
      throw new ProviderError({
        message: `Aliyun Wan task ${providerJobId} succeeded but no video_url`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    // Download video
    const tmpDir = path.join(process.cwd(), "outputs", "wan_resume");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `wan_resume_${Date.now()}.mp4`);
    await downloadWanFile(pollResult.video_url, outputPath, config.downloadTimeoutMs);
    const buffer = await fs.readFile(outputPath);
    await fs.unlink(outputPath).catch(() => {});

    // Resolve dimensions from aspect ratio
    const dims = wanDimsFromSize(wanSizeForAspect(aspectRatio, config.size), aspectRatio);

    return {
      video: {
        buffer,
        mime: "video/mp4",
        duration_sec: (pollResult.usage as any)?.duration ?? durationSec,
        width: dims.w,
        height: dims.h,
      },
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing key" };
    return { ok: true };
  }
}
