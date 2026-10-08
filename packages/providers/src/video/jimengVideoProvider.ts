/**
 * P22: JimengVideoProvider — 即梦视频 3.0 Pro / 720P via Volcengine API
 *
 * Implements the VideoProvider interface from P20 (mode="i2v").
 * Uses JimengVideoClient for HTTP + HMAC-SHA256 signing.
 *
 * Key mapping:
 *   JIMENG_VOLC_ACCESS_KEY / JIMENG_VOLC_SECRET_KEY
 *   Shared with P21 (即梦图片), same HMAC signing via volcSign.ts
 *
 * Async flow:
 *   1. submitTask  — POST with first_frame base64 + prompt
 *   2. pollStatus  — poll every 5s, timeout 10min, log every 30s
 *   3. downloadResult — fetch MP4 → Buffer
 *
 * Model variants:
 *   - jimeng_high_aes_general_v30pro  (即梦视频 3.0 Pro)
 *   - jimeng_high_aes_general_v30     (即梦视频 3.0 720P)
 */

import fs from "node:fs/promises";
import path from "node:path";
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
import { adaptVideoPrompt } from "../promptAdapters/jimeng";
import {
  submitJimengVideoTask,
  queryJimengVideoTask,
  downloadJimengVideo,
  resolveModelVariant,
  mapApiErrorType,
  loadJimengVideoConfig,
  type JimengVideoConfig,
  type JimengVideoSubmitInput,
} from "./jimengVideoClient";
import { pollAsyncJob } from "../core/asyncJobPoller";

// ─── Constants ──────────────────────────────────────────────────────────

/** Supported durations (seconds) */
const VALID_DURATIONS = new Set([3, 5, 10]);

/** S5: 将 aspect_ratio 解析为宽高 (Jimeng 用 720P 基础) */
function jimengAspectDims(aspect: string): { w: number; h: number } {
  switch (aspect) {
    case "9:16": return { w: 720, h: 1280 };
    case "1:1": return { w: 720, h: 720 };
    case "16:9":
    default: return { w: 1280, h: 720 };
  }
}

// 2026-05-28 audit P1-26: 删 DEFAULT_POLL_TIMEOUT_MS — 跟 P0-08 一致, 由 client config (loadJimengVideoConfig)
// 的 pollTimeoutMs 字段读 env, env 缺默认 Infinity (jimengVideoClient.ts:46-50 已实现).
// 这里再加一个 DEFAULT 会让人误以为可以 wall-clock timeout — 删掉避免 future 误用.

/** Progress log interval: 30 seconds */
const PROGRESS_LOG_INTERVAL_MS = 30_000;

// ─── Preset extras type ─────────────────────────────────────────────────

interface JimengVideoPresetExtras {
  model_variant?: string;
  cost_per_second_cny?: number;
}

// ─── JimengVideoProvider ────────────────────────────────────────────────

export class JimengVideoProvider implements VideoProvider {
  readonly id: string;
  readonly mode: "i2v" = "i2v";

  private _config: JimengVideoConfig;
  private _preset: PresetOption;
  private _modelVariant: string;
  private _costPerSecond: number;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._preset = cfg;
    this._config = loadJimengVideoConfig();

    // Parse key — may be JSON with access_key + secret_key (same as P21)
    if (apiKey) {
      try {
        const parsed = JSON.parse(apiKey);
        this._config.accessKey = parsed.access_key ?? parsed.JIMENG_VOLC_ACCESS_KEY ?? this._config.accessKey;
        this._config.secretKey = parsed.secret_key ?? parsed.JIMENG_VOLC_SECRET_KEY ?? this._config.secretKey;
      } catch {
        // Single key string — not valid for HMAC signing, but store anyway
        if (!this._config.accessKey) this._config.accessKey = apiKey;
      }
    }

    // Resolve model variant from preset
    const extras = cfg.extras as JimengVideoPresetExtras | undefined;
    this._modelVariant = extras?.model_variant ?? resolveModelVariant(cfg.id);
    this._costPerSecond = extras?.cost_per_second_cny ?? 0;
  }

  // ─── generate ─────────────────────────────────────────────────────────

  async generate(req: VideoGenerateRequest, ctx: ProviderContext): Promise<VideoGenerateResponse> {
    // 2026-05-18: 二级 instance_override
    const override = req.instance_override;
    const effectiveConfig = { ...this._config };
    if (override) {
      if (override.api_key?.trim()) effectiveConfig.accessKey = override.api_key.trim();
      if (override.secret_key?.trim()) effectiveConfig.secretKey = override.secret_key.trim();
      if (override.api_base_url?.trim()) {
        const baseTrim = override.api_base_url.trim().replace(/\/$/, "");
        // Jimeng endpoint 字段是完整 URL (含 path), api_base_url 只覆盖 host:port + 保留原 path
        try {
          const cur = new URL(effectiveConfig.endpoint);
          const next = new URL(baseTrim);
          cur.protocol = next.protocol;
          cur.host = next.host;
          effectiveConfig.endpoint = cur.toString();
        } catch {
          effectiveConfig.endpoint = baseTrim;
        }
      }
    }
    if (!effectiveConfig.accessKey || !effectiveConfig.secretKey) {
      throw new ProviderError({
        message: "Jimeng Volcengine API keys not configured (实例需要 access_key + secret_key)",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    // ── Validate i2v mode: must have first_frame ──
    if (!req.first_frame?.asset_id) {
      throw new ProviderError({
        message: "Jimeng video i2v mode requires first_frame.asset_id",
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    // ── Validate duration ──
    const duration = VALID_DURATIONS.has(req.duration_sec) ? req.duration_sec : 5;

    // ── Read first frame from asset path ──
    let firstFrameBase64: string;
    try {
      const buffer = await fs.readFile(req.first_frame.asset_id);
      firstFrameBase64 = buffer.toString("base64");
    } catch (err: any) {
      throw new ProviderError({
        message: `Failed to read first frame asset: ${err.message}`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
        original: err,
      });
    }

    // 2026-05-21 X-1: 尾帧 — 即梦 3.0 Pro API 支持首尾帧, 读文件传 base64
    let lastFrameBase64: string | undefined;
    if (req.last_frame?.asset_id) {
      try {
        const tailBuffer = await fs.readFile(req.last_frame.asset_id);
        lastFrameBase64 = tailBuffer.toString("base64");
      } catch (err: any) {
        ctx.log("warn", `[jimeng_video] Failed to read tail frame, skipping: ${err.message}`);
      }
    }

    // ── Resolve dimensions from aspect ratio ──
    const { width, height } = this._resolveDimensions(req.aspect_ratio);

    // B5: request.model_id (ModelPicker colon-suffix) overrides this._modelVariant
    // so the same provider instance can serve jimeng_video_3pro vs jimeng_video_3_720p.
    const effectiveModelVariant = (req.model_id?.trim() || this._modelVariant) as JimengVideoSubmitInput["req_key"];

    // ── Build submit input ──
    const submitInput: JimengVideoSubmitInput = {
      req_key: effectiveModelVariant,
      prompt: req.prompt,
      first_frame_image: firstFrameBase64,
      last_frame_image: lastFrameBase64,
      width,
      height,
      duration,
      seed: req.seed,
      return_url: true,
    };

    // ── Submit task ──
    ctx.log("info", `[jimeng_video] Submitting i2v task (model=${effectiveModelVariant}, duration=${duration}s, aspect=${req.aspect_ratio})`);

    let submitResult;
    try {
      submitResult = await submitJimengVideoTask(effectiveConfig, submitInput);
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw this._mapError(err);
    }

    if (!submitResult.task_id) {
      throw new ProviderError({
        message: "Jimeng video submit returned no task_id",
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    ctx.log("info", `[jimeng_video] Task submitted: ${submitResult.task_id}`);

    // B6: persist inflight record for crash recovery
    const inflight = await saveInflight({
      provider_id: this.id,
      provider_job_id: submitResult.task_id,
      submitted_at: new Date().toISOString(),
      poll_url: `${effectiveConfig.endpoint}`,
      context: { series_slug: ctx.series_slug, shot_id: ctx.task_id, kind: "video", job_id: ctx.job_id, aspect_ratio: req.aspect_ratio, duration_sec: duration },
    });

    // ── Poll until complete ──
    let lastProgressLog = Date.now();

    const pollResult = await pollAsyncJob({
      providerId: this.id,
      taskId: submitResult.task_id,
      pollFn: async () => {
        const result = await queryJimengVideoTask(effectiveConfig, submitResult.task_id);

        const now = Date.now();
        if (now - lastProgressLog >= PROGRESS_LOG_INTERVAL_MS) {
          ctx.log("info", `[jimeng_video] Task ${submitResult.task_id} status: ${result.task_status}`);
          lastProgressLog = now;
        }

        const statusMap: Record<string, "succeed" | "failed" | "processing"> = {
          Succeeded: "succeed",
          Failed: "failed",
          Canceled: "failed",
        };

        return {
          status: statusMap[result.task_status] ?? "processing",
          data: result,
          error: result.task_status === "Failed" ? (result.message ?? "task failed") : undefined,
          raw: result.raw,
        };
      },
      initialIntervalMs: effectiveConfig.pollIntervalMs,
      maxIntervalMs: effectiveConfig.pollIntervalMs,
      timeoutMs: effectiveConfig.pollTimeoutMs,
      signal: ctx.signal,
      logger: (msg) => ctx.log("info", msg),
    });

    if (pollResult.status === "timeout") {
      // 2026-07-10 audit C7 sibling (终验揪出): submit 成功后 task 已建、可能已扣费, poll 超时绝不能
      // retriable:true — queue 会重跑 generate() 重新 submit 全新计费任务 = 重复扣费 (即梦单价=0 时账本
      // 还记不到、熔断不了, 完全不可见)。保留 inflight 给 startup resumePoll 恢复已扣费任务, 与 kling/vidu 一致。
      throw new ProviderError({
        message: `Jimeng video poll timeout for task ${submitResult.task_id}`,
        code: "timeout",
        provider_id: this.id,
        retriable: false,
      });
    }

    if (pollResult.status === "failed") {
      await removeInflight(inflight.inflight_id).catch(() => {});
      throw new ProviderError({
        message: `Jimeng video task ${submitResult.task_id} failed: ${pollResult.error ?? "unknown"}`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    const taskData = pollResult.data;
    if (!taskData?.video_url) {
      await removeInflight(inflight.inflight_id).catch(() => {});
      throw new ProviderError({
        message: `Jimeng video task ${submitResult.task_id} succeeded but no video_url returned`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    // ── Download video ──
    const tmpDir = path.join(process.cwd(), "outputs", "jimeng_video");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `jimeng_${ctx.task_id}_${Date.now()}.mp4`);

    ctx.log("info", `[jimeng_video] Downloading video from ${taskData.video_url.slice(0, 80)}...`);

    let downloadResult;
    try {
      downloadResult = await downloadJimengVideo(
        taskData.video_url,
        outputPath,
        effectiveConfig.downloadTimeoutMs,
      );
    } catch (err: any) {
      throw new ProviderError({
        message: `Jimeng video download failed: ${err.message}`,
        code: "server",
        provider_id: this.id,
        retriable: false,
        original: err,
      });
    }

    const buffer = await fs.readFile(outputPath);
    await fs.unlink(outputPath).catch(() => {});

    // B6: task complete — remove inflight record
    await removeInflight(inflight.inflight_id).catch(() => {});

    // ── Compute cost ──
    const costAmount = duration * this._costPerSecond;

    ctx.log("info", `[jimeng_video] Video ready: ${downloadResult.bytes} bytes, ${duration}s, cost ¥${costAmount.toFixed(2)}`);

    return {
      video: {
        buffer,
        mime: "video/mp4",
        duration_sec: duration,
        width,
        height,
      },
      cost: {
        currency: "CNY",
        amount: costAmount,
        basis: "measured",
      },
    };
  }

  // B6 + S5: resume inflight poll after server restart — only polls, never submits
  async resumePoll(providerJobId: string, signal?: AbortSignal): Promise<VideoGenerateResponse> {
    if (!this._config.accessKey || !this._config.secretKey) {
      throw new ProviderError({
        message: "Jimeng Volcengine API keys not configured",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    // S5: 从 inflightStore 读 context 获取原始 aspect_ratio + duration_sec
    let ctxAspectRatio = "16:9";
    let ctxDurationSec = 5;
    let hasContext = false;
    try {
      const allInflight = await loadAllInflight();
      const match = allInflight.find(r => r.provider_job_id === providerJobId);
      if (match?.context) {
        ctxAspectRatio = (match.context as any).aspect_ratio ?? ctxAspectRatio;
        ctxDurationSec = (match.context as any).duration_sec ?? ctxDurationSec;
        hasContext = true;
      }
    } catch { /* best-effort */ }

    const pollResult = await pollAsyncJob({
      providerId: this.id,
      taskId: providerJobId,
      pollFn: async () => {
        const result = await queryJimengVideoTask(this._config, providerJobId);
        const statusMap: Record<string, "succeed" | "failed" | "processing"> = {
          Succeeded: "succeed",
          Failed: "failed",
          Canceled: "failed",
        };
        return {
          status: statusMap[result.task_status] ?? "processing",
          data: result,
          error: result.task_status === "Failed" ? (result.message ?? "task failed") : undefined,
          raw: result.raw,
        };
      },
      initialIntervalMs: this._config.pollIntervalMs,
      maxIntervalMs: this._config.pollIntervalMs,
      timeoutMs: this._config.pollTimeoutMs,
      signal,
    });

    if (pollResult.status === "timeout") {
      throw new ProviderError({
        message: `Jimeng video poll timeout for task ${providerJobId}`,
        code: "timeout",
        provider_id: this.id,
        retriable: true,
      });
    }

    if (pollResult.status === "failed") {
      throw new ProviderError({
        message: `Jimeng video task ${providerJobId} failed: ${pollResult.error ?? "unknown"}`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    const taskData = pollResult.data as any;
    if (!taskData?.video_url) {
      throw new ProviderError({
        message: `Jimeng video task ${providerJobId} succeeded but no video_url returned`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    const tmpDir = path.join(process.cwd(), "outputs", "jimeng_video");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `jimeng_resume_${Date.now()}.mp4`);
    await downloadJimengVideo(taskData.video_url, outputPath, this._config.downloadTimeoutMs);
    const buffer = await fs.readFile(outputPath);

    // S5: 从 context 解析 dimensions
    const dims = jimengAspectDims(ctxAspectRatio);
    let finalWidth = dims.w;
    let finalHeight = dims.h;
    if (!hasContext) {
      try {
        const { probeVideoFile } = await import("../../../render/src/ffprobe");
        const probe = await probeVideoFile(outputPath);
        if (probe.has_video_stream && probe.width > 0 && probe.height > 0) {
          finalWidth = probe.width;
          finalHeight = probe.height;
        }
      } catch { /* ffprobe best-effort */ }
    }

    await fs.unlink(outputPath).catch(() => {});

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

  // ─── healthCheck ──────────────────────────────────────────────────────

  // S1: 尝试取消远端 Jimeng/Volcengine 任务
  async cancel(providerJobId: string, _ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed"> {
    if (!this._config.accessKey || !this._config.secretKey) return "failed";
    try {
      const { cancelJimengVideoTask } = await import("./jimengVideoClient");
      return await cancelJimengVideoTask(this._config, providerJobId);
    } catch {
      return "failed";
    }
  }

  // B3: 预估成本(按秒单价 * 时长)
  estimateCost(req: VideoGenerateRequest): { cny: number; basis: "estimated" } {
    const duration = VALID_DURATIONS.has(req.duration_sec) ? req.duration_sec : 5;
    return { cny: duration * this._costPerSecond, basis: "estimated" };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._config.accessKey || !this._config.secretKey) {
      return { ok: false, reason: "missing JIMENG_VOLC_ACCESS_KEY / JIMENG_VOLC_SECRET_KEY" };
    }
    return { ok: true };
  }

  // ─── internal helpers ─────────────────────────────────────────────────

  /**
   * Resolve video dimensions from aspect ratio.
   */
  private _resolveDimensions(aspectRatio: string): { width: number; height: number } {
    switch (aspectRatio) {
      case "9:16":
        return { width: 720, height: 1280 };
      case "16:9":
        return { width: 1280, height: 720 };
      case "1:1":
        return { width: 720, height: 720 };
      default:
        return { width: 1280, height: 720 };
    }
  }

  /**
   * Map a raw fetch/network error to ProviderError.
   */
  private _mapError(err: any): ProviderError {
    if (err instanceof ProviderError) return err;

    const msg = err.message ?? String(err);
    const msgLower = msg.toLowerCase();

    if (err.error_type === "auth_failed") {
      return new ProviderError({
        message: `Jimeng video auth failed: ${msg}`,
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
        original: err,
      });
    }

    if (err.error_type === "rate_limited") {
      return new ProviderError({
        message: `Jimeng video rate limited: ${msg}`,
        code: "rate_limited",
        provider_id: this.id,
        retriable: true,
        original: err,
      });
    }

    // P186-T2: 即梦内容审核关键词
    if (msg.includes("审核未通过") || msg.includes("内容违规") || msgLower.includes("content policy") || msgLower.includes("safety")) {
      return new ProviderError({
        message: `Jimeng video content policy: ${msg}`,
        code: "content_policy",
        provider_id: this.id,
        retriable: false,
        original: err,
      });
    }

    if (msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("timeout")) {
      return new ProviderError({
        message: `Jimeng video network timeout: ${msg}`,
        code: "timeout",
        provider_id: this.id,
        retriable: true,
        original: err,
      });
    }

    // P186-T2: 其他网络/5xx → retriable=true
    return new ProviderError({
      message: `Jimeng video unexpected error: ${msg}`,
      code: "server",
      provider_id: this.id,
      retriable: true,
      original: err,
    });
  }
}
