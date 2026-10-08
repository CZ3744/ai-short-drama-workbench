// P24: Vidu Q3 Reference-to-Video Provider
// mode = "ref2v", supports 3-7 reference images, async create → poll → download

import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  VideoProvider,
  VideoGenerateRequest,
  VideoGenerateResponse,
  ProviderContext,
  HealthCheckResult,
  CostInfo,
} from "../core/types";
import { ProviderError } from "../core/errors";
import { saveInflight, removeInflight, loadAllInflight } from "../core/inflightStore";
import { pollAsyncJob, type PollResult } from "../core/asyncJobPoller";
import { ViduClient, type ViduTaskStatus } from "./viduClient";
import {
  sortReferenceImages,
  adaptRef2VBody,
  InvalidRefRequestError,
  type RefImageInput,
  type SortedRefImage,
} from "../promptAdapters/vidu";
import { getConfigValue } from "../../../core/src/localSettings";

/** S5: 将 aspect_ratio 解析为宽高 */
function viduAspectDims(aspect: string): { w: number; h: number } {
  switch (aspect) {
    case "9:16": return { w: 1080, h: 1920 };
    case "1:1": return { w: 1080, h: 1080 };
    case "4:3": return { w: 1440, h: 1080 };
    case "3:4": return { w: 1080, h: 1440 };
    case "16:9":
    default: return { w: 1920, h: 1080 };
  }
}

// ─── Cost table (per second, by style) ────────────────────────────────

const COST_TABLE: Record<string, Record<number, number>> = {
  general: { 4: 0.35, 8: 0.70 },
  anime:   { 4: 0.40, 8: 0.80 },
};

// ─── Provider ─────────────────────────────────────────────────────────

export class ViduRefVideoProvider implements VideoProvider {
  readonly id: string;
  readonly mode: "ref2v" = "ref2v";

  private _apiKey: string | null;
  private _model: string;
  private _defaultStyle: string;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._apiKey = apiKey;
    // 2026-05-14 (per PM C9): 不再硬编码占位 model 名,用户在设置自己填。
    // Preset 也不预填; 用户没填会被 Vidu API 拒绝并返回明确错误。
    this._model = (cfg as any).model ?? getConfigValue("VIDU_MODEL", "");
    this._defaultStyle = (cfg as any).default_style ?? "general";
  }

  // 2026-05-21 X-1: request.last_frame 在 ref2v 模式不适用 (Vidu 用 reference_images 数组
  // 传递多张参考图, 非首/尾帧模型). silent 忽略, 不抛错保持向后兼容.
  async generate(
    req: VideoGenerateRequest,
    ctx: ProviderContext,
  ): Promise<VideoGenerateResponse> {
    // 2026-05-18: 二级 instance_override — 优先用实例的 api_key / base_url
    const override = req.instance_override;
    const effectiveKey = override?.api_key?.trim() || this._apiKey;
    const effectiveBaseUrl = override?.api_base_url?.trim() || undefined;
    if (!effectiveKey) {
      throw new ProviderError({
        message: "VIDU_API_KEY not configured (实例未填 api_key 也无 env fallback)",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    // ── Validate reference images ──
    if (!req.reference_images || req.reference_images.length === 0) {
      throw new ProviderError({
        message: "Vidu ref2v requires at least 3 reference images",
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    // ── Build RefImageInput[] from request ──
    // req.reference_images[].asset_id is expected to be a base64 data URL
    // or an https URL resolved by the caller (AssetStore layer).
    const refInputs: RefImageInput[] = req.reference_images.map((ri, i) => ({
      asset_id: ri.asset_id,
      role: inferRole(i, req.reference_images!.length),
      url: ri.asset_id, // asset_id already contains resolved URL/data_url
      label: `ref_${i}`,
    }));

    // ── Sort reference images ──
    let sorted: SortedRefImage[];
    try {
      // Build a minimal Shot-like object for sortReferenceImages
      const pseudoShot = {
        character_ids: req.extras?.character_ids as string[] | undefined ?? [],
      } as any;
      sorted = sortReferenceImages(pseudoShot, refInputs);
    } catch (err: any) {
      if (err instanceof InvalidRefRequestError) {
        throw new ProviderError({
          message: err.message,
          code: "invalid_request",
          provider_id: this.id,
          retriable: false,
        });
      }
      throw err;
    }

    // ── Resolve style ──
    const style = (req.extras?.style as string) ?? this._defaultStyle;
    const model = req.model_id?.trim() || this._model;
    if (!model) {
      throw new ProviderError({
        message: "Vidu model not configured; set VIDU_MODEL or choose a model in ModelPicker",
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    // ── Build request body ──
    const body = adaptRef2VBody({
      prompt: req.prompt,
      sortedImages: sorted,
      model,
      style,
      duration: req.duration_sec,
      aspectRatio: req.aspect_ratio,
      seed: req.seed,
    });

    ctx.log("info", `[vidu_ref2v] submitting task: model=${body.model}, images=${body.images.length}, duration=${body.duration}s, style=${style}`);

    const client = new ViduClient(effectiveKey, { baseUrl: effectiveBaseUrl });

    // ── Submit ──
    let createResp;
    try {
      createResp = await client.createRef2V(body);
    } catch (err: any) {
      throw mapViduError(err, this.id);
    }

    ctx.log("info", `[vidu_ref2v] task created: ${createResp.task_id}, state=${createResp.state}`);

    // B6: persist inflight record for crash recovery
    // 2026-05-28 audit P1-22: 持久化 instance_override — resumePoll 重启后用同一个 Key/URL.
    const inflight = await saveInflight({
      provider_id: this.id,
      provider_job_id: createResp.task_id,
      submitted_at: new Date().toISOString(),
      poll_url: `${effectiveBaseUrl || "https://api.vidu.com/ent/v2"}/tasks/${encodeURIComponent(createResp.task_id)}/creations`,
      context: {
        series_slug: ctx.series_slug,
        shot_id: ctx.task_id,
        kind: "video",
        job_id: ctx.job_id,
        aspect_ratio: req.aspect_ratio,
        duration_sec: req.duration_sec,
        // 2026-05-28 audit P1-22: 把 override 的 key/base_url 写盘, resumePoll 优先读这里.
        ...(override ? { instance_override: { api_key: override.api_key, api_base_url: override.api_base_url } } : {}),
      },
    });

    // ── Poll (using P23 asyncJobPoller) ──
    const pollResult = await pollAsyncJob<ViduTaskStatus>({
      providerId: this.id,
      taskId: createResp.task_id,
      pollFn: async (): Promise<PollResult<ViduTaskStatus>> => {
        try {
          const status = await client.queryTask(createResp.task_id);
          if (status.state === "success") {
            return { status: "succeed", data: status, raw: status };
          }
          if (status.state === "failed") {
            return { status: "failed", error: status.err_code ?? "unknown", errorCode: status.err_code, raw: status };
          }
          return { status: "processing", raw: status };
        } catch (err: any) {
          throw mapViduError(err, this.id);
        }
      },
      initialIntervalMs: 5_000,
      maxIntervalMs: 15_000,
      // 2026-05-14 per PM C10: 不设 timeout, 由 provider 自然结束 or ctx.signal abort
      logger: (msg) => ctx.log("info", msg),
      signal: ctx.signal,
    });

    if (pollResult.status === "timeout") {
      // 2026-07-09 audit C7 sibling: vidu poll timeoutMs=Infinity(见上 pollAsyncJob, 不设 wall-clock
      // timeout), 故 pollResult=timeout 只可能来自 ctx.signal abort = 用户/orchestrator 主动取消。
      // 清 inflight 句柄尊重取消(不在下次启动 resumePoll 复活被取消的任务), 且强制 retriable:false —
      // 绝不能让 queue._execute(queue.ts:222) 认 retriable 重跑 generate() 重新 createRef2V 一个全新
      // 计费任务 = 同一视频重复扣费, budgetGuard 只记成功 1 次, 架空日预算硬熔断。
      await removeInflight(inflight.inflight_id).catch(() => {});
      throw new ProviderError({
        message: `Vidu poll timeout for task ${createResp.task_id}`,
        code: "timeout",
        provider_id: this.id,
        retriable: false,
      });
    }

    if (pollResult.status === "failed") {
      await removeInflight(inflight.inflight_id).catch(() => {});
      throw new ProviderError({
        message: `Vidu task failed: ${pollResult.error ?? "unknown error"}`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    const finalStatus = pollResult.data!;
    if (!finalStatus.creations || finalStatus.creations.length === 0) {
      await removeInflight(inflight.inflight_id).catch(() => {});
      throw new ProviderError({
        message: "Vidu task succeeded but returned no creations",
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    // ── Download ──
    const videoUrl = finalStatus.creations[0].url;
    let buffer: Buffer;
    try {
      buffer = await client.downloadVideo(videoUrl);
    } catch (err: any) {
      // 2026-07-09 audit C7 sibling: 轮询已 success = Vidu 端已出片已扣费。下载 MP4 的瞬时错误
      // (CDN 500 / 连接重置, 极常见)经 mapViduError 可能被判 retriable:true(rate_limit/timeout/429/
      // 408/504), 绝不能原样抛 — queue._execute(queue.ts:222) 认 retriable 会重跑 generate() 重新
      // createRef2V 一个全新计费任务 = 重复扣费, budgetGuard 只记成功 1 次, 架空日预算硬熔断。强制
      // retriable:false, 且不清 inflight 句柄 → startup resumePoll 只重下载已产出的视频、不重新提交。
      const mapped = mapViduError(err, this.id);
      throw new ProviderError({
        message: mapped.message,
        code: mapped.code,
        provider_id: this.id,
        retriable: false,
        original: mapped.original ?? err,
      });
    }

    // ── Cost ──
    const cost = estimateCost(style, req.duration_sec);

    // B6: task complete — remove inflight record
    await removeInflight(inflight.inflight_id).catch(() => {});

    ctx.log("info", `[vidu_ref2v] done: ${buffer.length} bytes, cost=${cost.amount} ${cost.currency}`);

    return {
      video: {
        buffer,
        mime: "video/mp4",
        duration_sec: req.duration_sec,
        width: viduAspectDims(req.aspect_ratio).w,
        height: viduAspectDims(req.aspect_ratio).h,
      },
      cost,
    };
  }

  // B6 + S5: resume inflight poll after server restart — only polls, never submits
  async resumePoll(providerJobId: string, signal?: AbortSignal): Promise<VideoGenerateResponse> {
    // S5: 从 inflightStore 读 context 获取原始 aspect_ratio + duration_sec
    // 2026-05-28 audit P1-22: 还要读 instance_override 用对的 Key/URL,
    // 之前永远 fallback 用 cfg env Key → 用户切了 ChannelInstance 后 resumePoll 401.
    let ctxAspectRatio = "16:9";
    let ctxDurationSec = 5;
    let hasContext = false;
    let overrideKey: string | undefined;
    let overrideBaseUrl: string | undefined;
    try {
      const allInflight = await loadAllInflight();
      const match = allInflight.find(r => r.provider_job_id === providerJobId);
      if (match?.context) {
        ctxAspectRatio = (match.context as any).aspect_ratio ?? ctxAspectRatio;
        ctxDurationSec = (match.context as any).duration_sec ?? ctxDurationSec;
        hasContext = true;
        const inflightOverride = (match.context as any).instance_override;
        if (inflightOverride) {
          overrideKey = inflightOverride.api_key;
          overrideBaseUrl = inflightOverride.api_base_url;
        }
      }
    } catch { /* best-effort */ }

    // 优先用 inflight 的 override key, fallback 到 cfg env
    const effectiveKey = overrideKey?.trim() || this._apiKey;
    if (!effectiveKey) {
      throw new ProviderError({
        message: "VIDU_API_KEY not configured (inflight 也无 instance_override.api_key)",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    const client = new ViduClient(effectiveKey, { baseUrl: overrideBaseUrl });

    const pollResult = await pollAsyncJob<ViduTaskStatus>({
      providerId: this.id,
      taskId: providerJobId,
      pollFn: async (): Promise<PollResult<ViduTaskStatus>> => {
        try {
          const status = await client.queryTask(providerJobId);
          if (status.state === "success") {
            return { status: "succeed", data: status, raw: status };
          }
          if (status.state === "failed") {
            return { status: "failed", error: status.err_code ?? "unknown", errorCode: status.err_code, raw: status };
          }
          return { status: "processing", raw: status };
        } catch (err: any) {
          throw mapViduError(err, this.id);
        }
      },
      initialIntervalMs: 5_000,
      maxIntervalMs: 15_000,
      // 2026-05-14 per PM C10: 不设 timeout
      signal,
    });

    if (pollResult.status === "timeout") {
      throw new ProviderError({
        message: `Vidu poll timeout for task ${providerJobId}`,
        code: "timeout",
        provider_id: this.id,
        retriable: true,
      });
    }

    if (pollResult.status === "failed") {
      throw new ProviderError({
        message: `Vidu task failed: ${pollResult.error ?? "unknown error"}`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    const finalStatus = pollResult.data!;
    if (!finalStatus.creations || finalStatus.creations.length === 0) {
      throw new ProviderError({
        message: "Vidu task succeeded but returned no creations",
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    const videoUrl = finalStatus.creations[0].url;
    const buffer = await client.downloadVideo(videoUrl);

    // S5: 从 context 解析 dimensions
    const dims = viduAspectDims(ctxAspectRatio);
    let finalWidth = dims.w;
    let finalHeight = dims.h;
    if (!hasContext) {
      try {
        const { probeVideoFile } = await import("../../../render/src/ffprobe");
        // Write buffer to temp file for ffprobe
        const fsp = await import("node:fs/promises");
        const tmpPath = (await import("node:path")).join(process.cwd(), "data", "_tmp", `vidu_probe_${Date.now()}.mp4`);
        await fsp.mkdir((await import("node:path")).dirname(tmpPath), { recursive: true });
        await fsp.writeFile(tmpPath, buffer);
        try {
          const probe = await probeVideoFile(tmpPath);
          if (probe.has_video_stream && probe.width > 0 && probe.height > 0) {
            finalWidth = probe.width;
            finalHeight = probe.height;
          }
        } finally {
          await fsp.unlink(tmpPath).catch(() => {});
        }
      } catch { /* ffprobe best-effort */ }
    }

    return {
      video: {
        buffer,
        mime: "video/mp4",
        duration_sec: ctxDurationSec,
        width: finalWidth,
        height: finalHeight,
      },
    };
  }

  // S1: 调 Vidu cancel 端点取消远端任务
  async cancel(providerJobId: string, _ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed"> {
    if (!this._apiKey) return "failed";
    try {
      const client = new ViduClient(this._apiKey);
      return await client.cancelTask(providerJobId);
    } catch {
      return "failed";
    }
  }

  // B3: 预估成本(从 COST_TABLE 查 style + duration)
  estimateCost(req: VideoGenerateRequest): { cny: number; basis: "estimated" } {
    const style = (req.extras?.style as string) ?? this._defaultStyle;
    const costInfo = estimateCost(style, req.duration_sec);
    return { cny: costInfo.amount, basis: "estimated" };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing key" };
    return { ok: true };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Infer reference image role by position.
 * First image = main character, middle = scene, rest = secondary.
 */
function inferRole(
  index: number,
  total: number,
): "character" | "scene" | "prop" {
  if (index === 0) return "character";
  if (total >= 3 && index === 1) return "scene";
  return "prop";
}

export function estimateCost(style: string, durationSec: number): CostInfo {
  const styleTable = COST_TABLE[style] ?? COST_TABLE.general;
  const amount = styleTable[durationSec] ?? styleTable[4] ?? 0.35;
  return {
    currency: "CNY",
    amount,
    basis: "estimated",
  };
}

function mapViduError(err: unknown, providerId: string): ProviderError {
  if (err instanceof ProviderError) return err;

  if (err instanceof Error && err.name === "ViduApiError") {
    const apiErr = err as any;
    const status = apiErr.httpStatus as number;
    let code: "missing_key" | "rate_limit" | "invalid_request" | "server" | "timeout" = "server";
    if (status === 401 || status === 403) code = "missing_key";
    else if (status === 429) code = "rate_limit";
    else if (status === 400 || status === 422) code = "invalid_request";
    else if (status === 408 || status === 504) code = "timeout";

    return new ProviderError({
      message: err.message,
      code,
      provider_id: providerId,
      retriable: code === "rate_limit" || code === "timeout",
      original: err,
    });
  }

  // P186-T2: vidu 关键词分类 ("rate limit"/"too many" → rate_limited, backoff=60s)
  const msg = err instanceof Error ? err.message : String(err);
  const msgLower = msg.toLowerCase();
  if (msgLower.includes("rate limit") || msgLower.includes("too many")) {
    return new ProviderError({
      message: msg,
      code: "rate_limited",
      provider_id: providerId,
      retriable: true,  // backoff=60s suggested
      original: err,
    });
  }

  return new ProviderError({
    message: msg,
    code: "unknown",
    provider_id: providerId,
    retriable: false,
    original: err,
  });
}
