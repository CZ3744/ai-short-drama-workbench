import * as crypto from "node:crypto";
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

interface TencentCredential {
  secretId: string;
  secretKey: string;
  region: string;
}

interface TencentConfig extends TencentCredential {
  endpoint: string;
  service: string;
  version: string;
  resolution: string;
  logoAdd: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  downloadTimeoutMs: number;
}

interface TencentResponse<T> {
  Response?: T & {
    RequestId?: string;
    Error?: {
      Code?: string;
      Message?: string;
    };
  };
}

interface SubmitBody {
  JobId?: string;
}

interface QueryBody {
  Status?: "WAIT" | "RUN" | "FAIL" | "DONE";
  ErrorCode?: string;
  ErrorMessage?: string;
  ResultVideoUrl?: string;
}

function parseCredential(apiKey: string | null): Partial<TencentCredential> {
  if (!apiKey) return {};
  try {
    const parsed = JSON.parse(apiKey) as Record<string, string>;
    return {
      secretId: parsed.secret_id ?? parsed.secretId ?? parsed.TENCENT_SECRET_ID,
      secretKey: parsed.secret_key ?? parsed.secretKey ?? parsed.TENCENT_SECRET_KEY,
      region: parsed.region ?? parsed.TENCENT_REGION,
    };
  } catch {
    return { secretId: apiKey };
  }
}

function loadConfig(cfg: PresetOption, apiKey: string | null): TencentConfig {
  const parsed = parseCredential(apiKey);
  const anyCfg = cfg as Record<string, unknown>;
  return {
    secretId: parsed.secretId || getConfigValue("TENCENT_SECRET_ID", ""),
    secretKey: parsed.secretKey || getConfigValue("TENCENT_SECRET_KEY", ""),
    region: parsed.region || getConfigValue("TENCENT_REGION", "ap-guangzhou"),
    endpoint: String(anyCfg.base_url || getConfigValue("TENCENT_HUNYUAN_VIDEO_BASE_URL", "https://vclm.tencentcloudapi.com")),
    service: "vclm",
    version: "2024-05-23",
    resolution: getConfigValue("TENCENT_HUNYUAN_VIDEO_RESOLUTION", "720p"),
    logoAdd: getConfigValue("TENCENT_HUNYUAN_VIDEO_LOGO_ADD", "1") === "0" ? 0 : 1,
    pollIntervalMs: Number(getConfigValue("TENCENT_HUNYUAN_VIDEO_POLL_INTERVAL_MS", "5000")),
    // 2026-05-28 audit P0-08: 视频生成 10-20 分钟正常, 客户端不能本地 timeout 误判.
    // 默认 Infinity, 只听 ctx.signal. env 覆盖仍生效.
    pollTimeoutMs: (() => {
      const raw = getConfigValue("TENCENT_HUNYUAN_VIDEO_POLL_TIMEOUT_MS", "0");
      const n = Number(raw);
      return n > 0 ? n : Number.POSITIVE_INFINITY;
    })(),
    downloadTimeoutMs: Number(getConfigValue("TENCENT_HUNYUAN_VIDEO_DOWNLOAD_TIMEOUT_MS", "300000")),
  };
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key: crypto.BinaryLike | crypto.KeyObject, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: crypto.BinaryLike | crypto.KeyObject, value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function utcDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function signTencentRequest(cfg: TencentConfig, action: string, payload: string, timestamp: number): Record<string, string> {
  const host = new URL(cfg.endpoint).host;
  const algorithm = "TC3-HMAC-SHA256";
  const date = utcDate(timestamp);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload),
  ].join("\n");
  const credentialScope = `${date}/${cfg.service}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${cfg.secretKey}`, date);
  const secretService = hmac(secretDate, cfg.service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmacHex(secretSigning, stringToSign);
  const authorization = `${algorithm} Credential=${cfg.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authorization,
    "Content-Type": "application/json; charset=utf-8",
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": cfg.version,
    "X-TC-Timestamp": String(timestamp),
    "X-TC-Region": cfg.region,
  };
}

function tencentTaskError(providerId: string, data: TencentResponse<unknown>, action: string): ProviderError | null {
  const err = data.Response?.Error;
  if (!err) return null;
  const code = err.Code ?? "Unknown";
  const message = err.Message ?? "";
  let mapped: "missing_key" | "rate_limit" | "quota_exceeded" | "content_policy" | "invalid_request" | "server" = "server";
  if (/auth|signature|secret|unauthorized/i.test(code + message)) mapped = "missing_key";
  else if (/limit|frequency|throttl|concurrency/i.test(code + message)) mapped = "rate_limit";
  else if (/quota|balance|insufficient/i.test(code + message)) mapped = "quota_exceeded";
  else if (/sensitive|unsafe|policy/i.test(code + message)) mapped = "content_policy";
  else if (/invalid|parameter/i.test(code + message)) mapped = "invalid_request";
  return new ProviderError({
    message: `Tencent ${action} failed: ${code}${message ? ` ${message}` : ""}`,
    code: mapped,
    provider_id: providerId,
    retriable: mapped === "rate_limit" || mapped === "server",
    original: data,
  });
}

export class TencentHunyuanVideoProvider implements VideoProvider {
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
    // 2026-05-20 Wave T S25 — instance_override 优先(三段 key:api_key=secretId / secret_key=secretKey / region)
    const override = req.instance_override;
    const baseCfg = loadConfig(this._cfg, this._apiKey);
    const cfg: TencentConfig = {
      ...baseCfg,
      secretId: override?.api_key?.trim() || baseCfg.secretId,
      secretKey: override?.secret_key?.trim() || baseCfg.secretKey,
      region: override?.region?.trim() || baseCfg.region,
      endpoint: override?.api_base_url?.trim() || baseCfg.endpoint,
    };
    if (!cfg.secretId || !cfg.secretKey) {
      throw new ProviderError({ message: "Tencent SecretId/SecretKey not configured (实例未填 也无 env fallback)", code: "missing_key", provider_id: this.id, retriable: false });
    }

    let jobId = "";
    let inflightId: string | undefined;
    // 2026-07-10 audit C7 sibling: post-submit 失败保留 inflight 给 startup resumePoll (防重跑重扣)
    let preserveInflightForResume = false;
    try {
      // 2026-05-19: ctx.signal 现 optional — 兜底 never-abort signal.
      const ctxSignal = ctx.signal ?? new AbortController().signal;
      const submit = await this.callTencent<SubmitBody>(cfg, "SubmitHunyuanToVideoJob", {
        Prompt: (req.prompt || "").slice(0, 200),
        Resolution: cfg.resolution,
        LogoAdd: cfg.logoAdd,
      }, ctxSignal);
      const submitError = tencentTaskError(this.id, submit, "SubmitHunyuanToVideoJob");
      if (submitError) throw submitError;
      jobId = submit.Response?.JobId ?? "";
      if (!jobId) {
        throw new ProviderError({ message: "Tencent Hunyuan submit response missing JobId", code: "invalid_output", provider_id: this.id, retriable: false, original: submit });
      }

      const inflight = await saveInflight({
        provider_id: this.id,
        provider_job_id: jobId,
        submitted_at: new Date().toISOString(),
        context: { series_slug: ctx.series_slug, shot_id: ctx.task_id, kind: "video", job_id: ctx.job_id, aspect_ratio: req.aspect_ratio, duration_sec: req.duration_sec },
      });
      inflightId = inflight.inflight_id;

      const final = await this.pollTask(cfg, jobId, ctx);
      const videoUrl = final.Response?.ResultVideoUrl;
      if (!videoUrl) {
        throw new ProviderError({ message: `Tencent Hunyuan task ${jobId} succeeded but returned no ResultVideoUrl`, code: "invalid_output", provider_id: this.id, retriable: false, original: final });
      }

      const buffer = await downloadVideoBuffer(this.id, videoUrl, cfg.downloadTimeoutMs, ctx.signal);
      const dims = videoDimsForAspect(req.aspect_ratio);
      return { video: { buffer, mime: "video/mp4", duration_sec: req.duration_sec, width: dims.width, height: dims.height } };
    } catch (err) {
      // 2026-07-10 audit C7 sibling: jobId 非空 = 远端任务已建、可能已扣费。post-submit 的 poll/
      // download 失败绝不能 retriable:true — queue 重跑会重新 submit 全新计费任务 = 重复扣费。
      // 强制 retriable:false + 保留 inflight 给 startup resumePoll 恢复已扣费任务。
      const pe = providerErrorFromUnknown(this.id, err, "Tencent Hunyuan video generation failed");
      if (jobId && pe.retriable) {
        preserveInflightForResume = true;
        throw new ProviderError({ message: pe.message, code: pe.code, provider_id: this.id, retriable: false, original: (pe as { original?: unknown }).original ?? err });
      }
      throw pe;
    } finally {
      if (inflightId && !preserveInflightForResume) await removeInflight(inflightId).catch(() => {});
    }
  }

  private async pollTask(cfg: TencentConfig, jobId: string, ctx: ProviderContext): Promise<TencentResponse<QueryBody>> {
    const started = Date.now();
    while (Date.now() - started < cfg.pollTimeoutMs) {
      // 2026-05-19: ctx.signal 现 optional — 兜底 never-abort signal.
      const ctxSignal = ctx.signal ?? new AbortController().signal;
      const data = await this.callTencent<QueryBody>(cfg, "DescribeHunyuanToVideoJob", { JobId: jobId }, ctxSignal);
      const apiError = tencentTaskError(this.id, data, "DescribeHunyuanToVideoJob");
      if (apiError) throw apiError;
      const status = data.Response?.Status;
      if (status === "DONE") return data;
      if (status === "FAIL") {
        throw new ProviderError({
          message: `Tencent Hunyuan task failed: ${data.Response?.ErrorCode ?? ""} ${data.Response?.ErrorMessage ?? ""}`.trim(),
          code: "server",
          provider_id: this.id,
          retriable: false,
          original: data,
        });
      }
      // 2026-05-19: ctx.signal 现 optional — null-safe abort hook.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, cfg.pollIntervalMs);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        }, { once: true });
      });
    }
    throw new ProviderError({ message: `Tencent Hunyuan poll timeout for job ${jobId}`, code: "timeout", provider_id: this.id, retriable: true });
  }

  private async callTencent<T>(cfg: TencentConfig, action: string, body: Record<string, unknown>, signal: AbortSignal): Promise<TencentResponse<T>> {
    const payload = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const resp = await fetch(cfg.endpoint, {
      method: "POST",
      headers: signTencentRequest(cfg, action, payload, timestamp),
      body: payload,
      signal: combineSignal(signal, 60_000),
    });
    return readJsonResponse<TencentResponse<T>>(this.id, resp, `Tencent ${action} failed`);
  }

  // X1-1 (A1-1): resume inflight poll after server restart — 照 aliyunWanProvider 模板。
  // 提交成功(jobId 已拿到=远端已建任务、可能已扣费)后, 若 poll/download 瞬时失败, generate() catch
  // 已强制 retriable:false + 保留 inflight。重启后 index.ts 走本方法续下载已扣费视频 (只 poll+download,
  // 绝不重新 submit → 不重复扣费)。铁律#1: 只透传外部 signal, 不叠加本地 timeout。
  async resumePoll(providerJobId: string, signal?: AbortSignal): Promise<VideoGenerateResponse> {
    const cfg = loadConfig(this._cfg, this._apiKey);
    if (!cfg.secretId || !cfg.secretKey) {
      throw new ProviderError({ message: "Tencent SecretId/SecretKey not configured", code: "missing_key", provider_id: this.id, retriable: false });
    }

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

    // 复用 generate 的 pollTask (只 poll 现有 job, 不 submit)。构造最小 ctx 仅透传 signal。
    const ctx: ProviderContext = { series_slug: "", job_id: "", task_id: providerJobId, log: () => {}, signal };
    const final = await this.pollTask(cfg, providerJobId, ctx);
    const videoUrl = final.Response?.ResultVideoUrl;
    if (!videoUrl) {
      throw new ProviderError({ message: `Tencent Hunyuan task ${providerJobId} succeeded but returned no ResultVideoUrl`, code: "invalid_output", provider_id: this.id, retriable: false, original: final });
    }
    const buffer = await downloadVideoBuffer(this.id, videoUrl, cfg.downloadTimeoutMs, signal);
    const dims = videoDimsForAspect(aspectRatio);
    return { video: { buffer, mime: "video/mp4", duration_sec: durationSec, width: dims.width, height: dims.height } };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const cfg = loadConfig(this._cfg, this._apiKey);
    if (!cfg.secretId || !cfg.secretKey) return { ok: false, reason: "missing Tencent SecretId/SecretKey" };
    return { ok: true };
  }

  estimateCost(req: VideoGenerateRequest): { cny: number; basis: "estimated" } {
    return { cny: Math.max(1, req.duration_sec) * 0.4, basis: "estimated" };
  }
}
