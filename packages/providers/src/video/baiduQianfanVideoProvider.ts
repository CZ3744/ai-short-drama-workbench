import type { PresetOption } from "../../../core/src/presetSchema";
import { getConfigValue } from "../../../core/src/localSettings";
import type { HealthCheckResult, ProviderContext, VideoGenerateRequest, VideoGenerateResponse, VideoProvider } from "../core/types";
import { ProviderError } from "../core/errors";
import { saveInflight, removeInflight, loadAllInflight } from "../core/inflightStore";
import {
  combineSignal,
  downloadVideoBuffer,
  providerErrorFromUnknown,
  readJsonResponse,
  videoDimsForAspect,
} from "./mainlandVideoUtils";

interface BaiduCreateResponse {
  task_id?: string;
  id?: string;
  status?: string;
  err_code?: string;
  err_msg?: string;
}

interface BaiduQueryResponse {
  id?: string;
  status?: string;
  err_code?: string;
  err_msg?: string;
  creations?: Array<{ id?: string; url?: string; cover_url?: string }>;
}

interface BaiduConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  resolution: string;
  audio: boolean;
  bgm: boolean;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  downloadTimeoutMs: number;
}

function loadConfig(cfg: PresetOption, apiKey: string): BaiduConfig {
  const anyCfg = cfg as Record<string, unknown>;
  return {
    apiKey,
    baseUrl: String(anyCfg.base_url || getConfigValue("BAIDU_QIANFAN_BASE_URL", "https://qianfan.baidubce.com")),
    model: String(anyCfg.model_id || anyCfg.model || getConfigValue("BAIDU_QIANFAN_VIDEO_MODEL", "VQ3-Pro")),
    resolution: getConfigValue("BAIDU_QIANFAN_VIDEO_RESOLUTION", "720p"),
    audio: getConfigValue("BAIDU_QIANFAN_VIDEO_AUDIO", "true") !== "false",
    bgm: getConfigValue("BAIDU_QIANFAN_VIDEO_BGM", "false") === "true",
    pollIntervalMs: Number(getConfigValue("BAIDU_QIANFAN_VIDEO_POLL_INTERVAL_MS", "5000")),
    // 2026-05-28 audit P0-08: 视频生成 10-20 分钟正常, 客户端不能本地 timeout 误判.
    // 默认 Infinity, 只听 ctx.signal. env 覆盖仍生效.
    pollTimeoutMs: (() => {
      const raw = getConfigValue("BAIDU_QIANFAN_VIDEO_POLL_TIMEOUT_MS", "0");
      const n = Number(raw);
      return n > 0 ? n : Number.POSITIVE_INFINITY;
    })(),
    downloadTimeoutMs: Number(getConfigValue("BAIDU_QIANFAN_VIDEO_DOWNLOAD_TIMEOUT_MS", "300000")),
  };
}

function baiduTaskError(providerId: string, data: BaiduCreateResponse | BaiduQueryResponse): ProviderError | null {
  const status = String(data.status ?? "").toLowerCase();
  const errCode = data.err_code ?? "";
  const msg = data.err_msg || errCode;
  if (status === "failed" || errCode) {
    let code: "content_policy" | "rate_limit" | "server" | "invalid_request" = "server";
    if (/unsafe|sensitive|prompt/i.test(msg)) code = "content_policy";
    else if (/rate|concurrency|limit/i.test(msg)) code = "rate_limit";
    else if (/invalid|argument/i.test(msg)) code = "invalid_request";
    return new ProviderError({
      message: `Baidu Qianfan video task failed${msg ? `: ${msg}` : ""}`,
      code,
      provider_id: providerId,
      retriable: code === "rate_limit",
      original: data,
    });
  }
  return null;
}

export class BaiduQianfanVideoProvider implements VideoProvider {
  readonly id: string;
  readonly mode: "t2v" = "t2v";
  private readonly _apiKey: string | null;
  private readonly _cfg: PresetOption;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._apiKey = apiKey;
    this._cfg = cfg;
  }

  async generate(req: VideoGenerateRequest, ctx: ProviderContext): Promise<VideoGenerateResponse> {
    // 2026-05-20 Wave T S25 — instance_override 优先,fallback 到 cfg / env
    const override = req.instance_override;
    const effectiveKey = override?.api_key?.trim() || this._apiKey;
    if (!effectiveKey) {
      throw new ProviderError({ message: "Baidu Qianfan API key not configured (实例未填 api_key 也无 env fallback)", code: "missing_key", provider_id: this.id, retriable: false });
    }

    const baseCfg = loadConfig(this._cfg, effectiveKey);
    const cfg = {
      ...baseCfg,
      apiKey: effectiveKey,
      baseUrl: override?.api_base_url?.trim() || baseCfg.baseUrl,
    };
    const model = req.model_id?.trim() || cfg.model;
    let taskId = "";
    let inflightId: string | undefined;
    // 2026-07-10 audit C7 sibling: post-submit 失败保留 inflight 给 startup resumePoll (防重跑重扣)
    let preserveInflightForResume = false;

    try {
      const endpoint = `${cfg.baseUrl.replace(/\/$/, "")}/beta/video/generations/qianfan-video`;
      const submitResp = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "text2video",
          model,
          model_parameters: {
            prompt: (req.prompt || "").slice(0, 1500),
            duration: req.duration_sec,
            seed: req.seed ?? 0,
            aspect_ratio: req.aspect_ratio,
            resolution: cfg.resolution,
            bgm: cfg.bgm,
            audio: cfg.audio,
          },
        }),
        signal: combineSignal(ctx.signal, 60_000),
      });
      const submit = await readJsonResponse<BaiduCreateResponse>(this.id, submitResp, "Baidu Qianfan video submit failed");
      const failed = baiduTaskError(this.id, submit);
      if (failed) throw failed;
      taskId = submit.task_id ?? submit.id ?? "";
      if (!taskId) {
        throw new ProviderError({ message: "Baidu Qianfan submit response missing task_id", code: "invalid_output", provider_id: this.id, retriable: false, original: submit });
      }

      const inflight = await saveInflight({
        provider_id: this.id,
        provider_job_id: taskId,
        submitted_at: new Date().toISOString(),
        // X1-1: 持久化 model — baidu 任务状态查询端点需要 model, resumePoll 用提交时原值防对不上任务
        context: { series_slug: ctx.series_slug, shot_id: ctx.task_id, kind: "video", job_id: ctx.job_id, aspect_ratio: req.aspect_ratio, duration_sec: req.duration_sec, model },
      });
      inflightId = inflight.inflight_id;

      const final = await this.pollTask(cfg, taskId, model, ctx);
      const videoUrl = final.creations?.[0]?.url;
      if (!videoUrl) {
        throw new ProviderError({ message: `Baidu Qianfan task ${taskId} succeeded but returned no video URL`, code: "invalid_output", provider_id: this.id, retriable: false, original: final });
      }

      const buffer = await downloadVideoBuffer(this.id, videoUrl, cfg.downloadTimeoutMs, ctx.signal);
      const dims = videoDimsForAspect(req.aspect_ratio);
      return { video: { buffer, mime: "video/mp4", duration_sec: req.duration_sec, width: dims.width, height: dims.height } };
    } catch (err) {
      // 2026-07-10 audit C7 sibling: taskId 非空 = 远端任务已建、可能已扣费。post-submit 的 poll/
      // download 失败绝不能 retriable:true — queue 重跑会重新 submit 全新计费任务 = 重复扣费。
      // 强制 retriable:false + 保留 inflight 给 startup resumePoll 恢复已扣费任务。
      const pe = providerErrorFromUnknown(this.id, err, "Baidu Qianfan video generation failed");
      if (taskId && pe.retriable) {
        preserveInflightForResume = true;
        throw new ProviderError({ message: pe.message, code: pe.code, provider_id: this.id, retriable: false, original: (pe as { original?: unknown }).original ?? err });
      }
      throw pe;
    } finally {
      if (inflightId && !preserveInflightForResume) await removeInflight(inflightId).catch(() => {});
    }
  }

  private async pollTask(cfg: BaiduConfig, taskId: string, model: string, ctx: ProviderContext): Promise<BaiduQueryResponse> {
    const started = Date.now();
    const endpoint = `${cfg.baseUrl.replace(/\/$/, "")}/beta/video/generations/qianfan-video?task_id=${encodeURIComponent(taskId)}&model=${encodeURIComponent(model)}`;
    while (Date.now() - started < cfg.pollTimeoutMs) {
      const resp = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: combineSignal(ctx.signal, 30_000),
      });
      const data = await readJsonResponse<BaiduQueryResponse>(this.id, resp, "Baidu Qianfan video poll failed");
      const failed = baiduTaskError(this.id, data);
      if (failed) throw failed;
      if (String(data.status ?? "").toLowerCase() === "success" || data.creations?.[0]?.url) return data;
      // 2026-05-19: ctx.signal 现 optional — null-safe abort hook.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, cfg.pollIntervalMs);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        }, { once: true });
      });
    }
    throw new ProviderError({ message: `Baidu Qianfan poll timeout for task ${taskId}`, code: "timeout", provider_id: this.id, retriable: true });
  }

  // X1-1 (A1-1): resume inflight poll after server restart — 照 aliyunWanProvider 模板。
  // 提交成功(taskId 已拿到=远端已建任务、可能已扣费)后, 若 poll/download 瞬时失败, generate() catch
  // 已强制 retriable:false + 保留 inflight。重启后 index.ts 走本方法续下载已扣费视频 (只 poll+download,
  // 绝不重新 submit → 不重复扣费)。铁律#1: 只透传外部 signal, 不叠加本地 timeout。
  async resumePoll(providerJobId: string, signal?: AbortSignal): Promise<VideoGenerateResponse> {
    if (!this._apiKey) {
      throw new ProviderError({ message: "Baidu Qianfan API key not configured", code: "missing_key", provider_id: this.id, retriable: false });
    }
    const cfg = loadConfig(this._cfg, this._apiKey);

    // 从 inflightStore 读回提交时的原始请求参数 (aspect_ratio/duration_sec/model)
    let durationSec = 5;
    let aspectRatio = "16:9";
    let model = cfg.model;
    try {
      const allInflight = await loadAllInflight();
      const match = allInflight.find((r) => r.provider_job_id === providerJobId && r.provider_id === this.id);
      if (match?.context) {
        durationSec = match.context.duration_sec ?? durationSec;
        aspectRatio = match.context.aspect_ratio ?? aspectRatio;
        model = match.context.model ?? model;
      }
    } catch { /* best-effort: 读不到就用 cfg 默认 */ }

    // 复用 generate 的 pollTask (只 poll 现有 task, 不 submit)。构造最小 ctx 仅透传 signal。
    const ctx: ProviderContext = { series_slug: "", job_id: "", task_id: providerJobId, log: () => {}, signal };
    const final = await this.pollTask(cfg, providerJobId, model, ctx);
    const videoUrl = final.creations?.[0]?.url;
    if (!videoUrl) {
      throw new ProviderError({ message: `Baidu Qianfan task ${providerJobId} succeeded but returned no video URL`, code: "invalid_output", provider_id: this.id, retriable: false, original: final });
    }
    const buffer = await downloadVideoBuffer(this.id, videoUrl, cfg.downloadTimeoutMs, signal);
    const dims = videoDimsForAspect(aspectRatio);
    return { video: { buffer, mime: "video/mp4", duration_sec: durationSec, width: dims.width, height: dims.height } };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing key" };
    return { ok: true };
  }

  estimateCost(req: VideoGenerateRequest): { cny: number; basis: "estimated" } {
    return { cny: Math.max(1, req.duration_sec) * 0.15, basis: "estimated" };
  }
}
