import fs from "node:fs/promises";
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

interface ZhipuCreateResponse {
  id?: string;
  task_status?: string;
  error?: { code?: string; message?: string };
}

interface ZhipuQueryResponse {
  id?: string;
  task_status?: string;
  status?: string;
  video_result?: Array<{ url?: string; cover_image_url?: string }>;
  error?: { code?: string; message?: string };
}

interface ZhipuConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  quality: "speed" | "quality";
  withAudio: boolean;
  fps: 30 | 60;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  downloadTimeoutMs: number;
}

function loadConfig(cfg: PresetOption, apiKey: string): ZhipuConfig {
  const anyCfg = cfg as Record<string, unknown>;
  const fps = Number(getConfigValue("ZHIPU_VIDEO_FPS", "30"));
  return {
    apiKey,
    baseUrl: String(anyCfg.base_url || getConfigValue("ZHIPU_BASE_URL", "https://open.bigmodel.cn")),
    model: String(anyCfg.model_id || anyCfg.model || getConfigValue("ZHIPU_VIDEO_MODEL", "cogvideox-3")),
    quality: getConfigValue("ZHIPU_VIDEO_QUALITY", "speed") === "quality" ? "quality" : "speed",
    withAudio: getConfigValue("ZHIPU_VIDEO_WITH_AUDIO", "false") === "true",
    // 2026-05-27 — 按官方 docs.z.ai/api-reference/video/generate-video 删除 watermark_enabled
    // (官方文档没列这字段, 旧版可能支持但 cogvideox-3 不再使用, 传了可能被忽略或警告).
    fps: fps === 60 ? 60 : 30,
    pollIntervalMs: Number(getConfigValue("ZHIPU_VIDEO_POLL_INTERVAL_MS", "5000")),
    // 2026-05-28 audit P0-08: 智谱 4K cogvideox-3 实测 13-20 分钟正常, 客户端不能本地 timeout
    // 否则用户花了钱、远端跑成功、客户端却 abort. 默认 Infinity, 只听 ctx.signal.
    // 仍允许 env 覆盖为有限值 (CI / 测试用), 但默认无超时.
    pollTimeoutMs: (() => {
      const raw = getConfigValue("ZHIPU_VIDEO_POLL_TIMEOUT_MS", "0");
      const n = Number(raw);
      return n > 0 ? n : Number.POSITIVE_INFINITY;
    })(),
    downloadTimeoutMs: Number(getConfigValue("ZHIPU_VIDEO_DOWNLOAD_TIMEOUT_MS", "300000")),
  };
}

/**
 * 2026-05-27 — 按智谱官方文档 (docs.z.ai/api-reference/video/generate-video)
 * cogvideox-3 支持 7 种 size:
 *   1280x720 / 720x1280 / 1024x1024 / 1920x1080 / 1080x1920 / 2048x1080 / 3840x2160
 *
 * 之前只覆盖 1080x1920/1024x1024/1920x1080 三种, 用户想要 720P / 2K / 4K 没法选.
 * 现按 aspect_ratio + 用户偏好分辨率档位映射. 默认 1080P 平衡画质和成本.
 */
function zhipuSize(aspect: string, preferred: "720p" | "1080p" | "2k" | "4k" = "1080p"): string {
  // 横屏 16:9
  if (aspect === "16:9") {
    if (preferred === "4k") return "3840x2160";
    if (preferred === "2k") return "2048x1080";
    if (preferred === "720p") return "1280x720";
    return "1920x1080";
  }
  // 竖屏 9:16
  if (aspect === "9:16") {
    if (preferred === "720p") return "720x1280";
    return "1080x1920";
  }
  // 方屏 1:1
  if (aspect === "1:1") return "1024x1024";
  // 4:3 / 3:4 / 其他不在官方枚举内, fallback 默认 1080P 横屏
  return "1920x1080";
}

function normalizeDuration(seconds: number): 5 | 10 {
  return seconds > 5 ? 10 : 5;
}

/**
 * 2026-05-27 — 把 first_frame / last_frame 的 asset_id (文件路径) 读为 base64 data URL.
 * 智谱 image_url 字段接受 URL 或 Base64; base64 必须带 data:image/...;base64, 前缀.
 * 跟 klingVideoProvider:131-145 同款读法.
 */
async function readImageAsDataUrl(assetPath: string, providerId: string): Promise<string> {
  try {
    const buffer = await fs.readFile(assetPath);
    const lower = assetPath.toLowerCase();
    const mime = lower.endsWith(".png") ? "image/png"
      : (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) ? "image/jpeg"
      : "image/png"; // 兜底
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch (err) {
    throw new ProviderError({
      message: `读取参考图失败 (${assetPath}): ${err instanceof Error ? err.message : String(err)}`,
      code: "invalid_request",
      provider_id: providerId,
      retriable: false,
      original: err,
    });
  }
}

function zhipuTaskFailed(data: ZhipuQueryResponse | ZhipuCreateResponse): ProviderError | null {
  const status = String(data.task_status ?? (data as ZhipuQueryResponse).status ?? "").toUpperCase();
  const msg = data.error?.message || data.error?.code || "";
  if (status === "FAIL" || status === "FAILED") {
    return new ProviderError({
      message: `Zhipu video task failed${msg ? `: ${msg}` : ""}`,
      code: /sensitive|unsafe|policy/i.test(msg) ? "content_policy" : "server",
      provider_id: "zhipu_cogvideox",
      retriable: false,
      original: data,
    });
  }
  return null;
}

export class ZhipuCogVideoProvider implements VideoProvider {
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
      throw new ProviderError({ message: "Zhipu API key not configured (实例未填 api_key 也无 env fallback)", code: "missing_key", provider_id: this.id, retriable: false });
    }

    const baseCfg = loadConfig(this._cfg, effectiveKey);
    const cfg = {
      ...baseCfg,
      apiKey: effectiveKey,
      baseUrl: override?.api_base_url?.trim() || baseCfg.baseUrl,
    };
    const model = req.model_id?.trim() || cfg.model;
    const duration = normalizeDuration(req.duration_sec);
    const prompt = (req.prompt || "").slice(0, 512);
    let taskId = "";
    let inflightId: string | undefined;
    // 2026-07-10 audit C7 sibling: post-submit 失败保留 inflight 给 startup resumePoll (防重跑重扣)
    let preserveInflightForResume = false;

    try {
      const submitUrl = `${cfg.baseUrl.replace(/\/$/, "")}/api/paas/v4/videos/generations`;

      // 2026-05-27 — 按智谱官方 API 文档 (docs.z.ai/api-reference/video/generate-video) 完整请求体:
      //   必填: model + (prompt 或 image_url 至少一个)
      //   可选: quality / size / fps / duration / with_audio / request_id / image_url
      //   image_url: string (i2v 单参考) 或 [first, last] (首尾帧)
      //
      // 项目支持 i2v: req.first_frame.asset_id 是文件路径 (orchestrator resolve 后).
      // 有 first_frame → 跑 i2v (cogvideox-3 支持). 有 last_frame → 首尾帧 (array).
      // 都没 → 纯 t2v.

      const isFlashModel = String(model).toLowerCase().startsWith("cogvideox-flash");
      const submitBody: Record<string, unknown> = {
        model,
        prompt,
        duration,
        request_id: `${ctx.job_id}-${ctx.task_id}`,
      };

      // 2026-05-27 真接 i2v / 首尾帧 — 之前 zhipuCogVideoProvider 完全没处理 first_frame,
      // 用户挑了 picked first frame 项目 silent 丢. 现在按文档把图作 base64 data URL 传给
      // 智谱 image_url 字段.
      const firstFrameUrl = req.first_frame?.asset_id
        ? await readImageAsDataUrl(req.first_frame.asset_id, this.id)
        : null;
      const lastFrameUrl = req.last_frame?.asset_id
        ? await readImageAsDataUrl(req.last_frame.asset_id, this.id)
        : null;
      if (firstFrameUrl && lastFrameUrl) {
        // 首尾帧 — array 形式
        submitBody.image_url = [firstFrameUrl, lastFrameUrl];
      } else if (firstFrameUrl) {
        // i2v — string 形式
        submitBody.image_url = firstFrameUrl;
      }

      // Flash 模型按之前 audit 文档不支持 quality/size/fps, 保留 simple body.
      // cogvideox-3 + 其他 N 系列完整参数 (按文档).
      if (!isFlashModel) {
        submitBody.quality = cfg.quality;
        submitBody.with_audio = cfg.withAudio;
        submitBody.size = zhipuSize(req.aspect_ratio);
        submitBody.fps = cfg.fps;
      }

      const submitResp = await fetch(submitUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(submitBody),
        signal: combineSignal(ctx.signal, 60_000),
      });
      const submit = await readJsonResponse<ZhipuCreateResponse>(this.id, submitResp, "Zhipu video submit failed");
      const failed = zhipuTaskFailed(submit);
      if (failed) throw failed;
      taskId = submit.id ?? "";
      if (!taskId) {
        throw new ProviderError({ message: "Zhipu submit response missing id", code: "invalid_output", provider_id: this.id, retriable: false, original: submit });
      }

      const inflight = await saveInflight({
        provider_id: this.id,
        provider_job_id: taskId,
        submitted_at: new Date().toISOString(),
        context: { series_slug: ctx.series_slug, shot_id: ctx.task_id, kind: "video", job_id: ctx.job_id, aspect_ratio: req.aspect_ratio, duration_sec: duration },
      });
      inflightId = inflight.inflight_id;

      const final = await this.pollTask(cfg, taskId, ctx);
      const videoUrl = final.video_result?.[0]?.url;
      if (!videoUrl) {
        throw new ProviderError({ message: `Zhipu task ${taskId} succeeded but returned no video URL`, code: "invalid_output", provider_id: this.id, retriable: false, original: final });
      }

      const buffer = await downloadVideoBuffer(this.id, videoUrl, cfg.downloadTimeoutMs, ctx.signal);
      const dims = videoDimsForAspect(req.aspect_ratio);
      return { video: { buffer, mime: "video/mp4", duration_sec: duration, width: dims.width, height: dims.height } };
    } catch (err) {
      // 2026-07-10 audit C7 sibling: taskId 非空 = 远端任务已建、可能已扣费。post-submit 的 poll/
      // download 失败绝不能 retriable:true — queue 重跑会重新 submit 全新计费任务 = 重复扣费。
      // 强制 retriable:false + 保留 inflight 给 startup resumePoll 恢复已扣费任务。
      const pe = providerErrorFromUnknown(this.id, err, "Zhipu video generation failed");
      if (taskId && pe.retriable) {
        preserveInflightForResume = true;
        throw new ProviderError({ message: pe.message, code: pe.code, provider_id: this.id, retriable: false, original: (pe as { original?: unknown }).original ?? err });
      }
      throw pe;
    } finally {
      if (inflightId && !preserveInflightForResume) await removeInflight(inflightId).catch(() => {});
    }
  }

  private async pollTask(cfg: ZhipuConfig, taskId: string, ctx: ProviderContext): Promise<ZhipuQueryResponse> {
    const started = Date.now();
    const pollUrl = `${cfg.baseUrl.replace(/\/$/, "")}/api/paas/v4/async-result/${encodeURIComponent(taskId)}`;
    while (Date.now() - started < cfg.pollTimeoutMs) {
      const resp = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: combineSignal(ctx.signal, 30_000),
      });
      const data = await readJsonResponse<ZhipuQueryResponse>(this.id, resp, "Zhipu video poll failed");
      const failed = zhipuTaskFailed(data);
      if (failed) throw failed;
      const status = String(data.task_status ?? data.status ?? "").toUpperCase();
      if (status === "SUCCESS" || data.video_result?.[0]?.url) return data;
      // 2026-05-19: ctx.signal 现 optional — null-safe abort hook.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, cfg.pollIntervalMs);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        }, { once: true });
      });
    }
    throw new ProviderError({ message: `Zhipu poll timeout for task ${taskId}`, code: "timeout", provider_id: this.id, retriable: true });
  }

  // X1-1 (A1-1): resume inflight poll after server restart — 照 aliyunWanProvider 模板。
  // 提交成功(taskId 已拿到=远端已建任务、可能已扣费)后, 若 poll/download 瞬时失败, generate() catch
  // 已强制 retriable:false + 保留 inflight。重启后 index.ts 走本方法续下载已扣费视频 (只 poll+download,
  // 绝不重新 submit → 不重复扣费)。铁律#1: 只透传外部 signal, 不叠加本地 timeout。
  async resumePoll(providerJobId: string, signal?: AbortSignal): Promise<VideoGenerateResponse> {
    if (!this._apiKey) {
      throw new ProviderError({ message: "Zhipu API key not configured", code: "missing_key", provider_id: this.id, retriable: false });
    }
    const cfg = loadConfig(this._cfg, this._apiKey);

    // 从 inflightStore 读回提交时的原始请求参数 (aspect_ratio/duration_sec)
    let durationSec = 5;
    let aspectRatio = "16:9";
    try {
      const allInflight = await loadAllInflight();
      const match = allInflight.find((r) => r.provider_job_id === providerJobId && r.provider_id === this.id);
      if (match?.context) {
        durationSec = match.context.duration_sec ?? durationSec;
        aspectRatio = match.context.aspect_ratio ?? aspectRatio;
      }
    } catch { /* best-effort: 读不到就用默认 */ }

    // 复用 generate 的 pollTask (只 poll 现有 task, 不 submit)。构造最小 ctx 仅透传 signal。
    const ctx: ProviderContext = { series_slug: "", job_id: "", task_id: providerJobId, log: () => {}, signal };
    const final = await this.pollTask(cfg, providerJobId, ctx);
    const videoUrl = final.video_result?.[0]?.url;
    if (!videoUrl) {
      throw new ProviderError({ message: `Zhipu task ${providerJobId} succeeded but returned no video URL`, code: "invalid_output", provider_id: this.id, retriable: false, original: final });
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
    return { cny: normalizeDuration(req.duration_sec) * 0.35, basis: "estimated" };
  }
}
