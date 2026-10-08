// P23: Kling Video Provider — implements P20 VideoProvider interface (mode="i2v")
// Uses Kling 3.0 image-to-video API with JWT auth and async polling.

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
import { KlingJwtManager } from "./klingJwt";
import {
  loadKlingConfig,
  submitKlingI2V,
  pollKlingTask,
  downloadKlingVideo,
  type KlingConfig,
  type KlingSubmitInput,
} from "./klingClient";

// ─── Preset tier → mode mapping ────────────────────────────────────

interface KlingPresetExtras {
  tier?: "std" | "pro";
  cost_per_second_cny?: number;
}

function extractTier(preset: PresetOption): "std" | "pro" {
  const extras = preset.extras as KlingPresetExtras | undefined;
  return extras?.tier ?? "std";
}

function extractCostPerSecond(preset: PresetOption, tier: "std" | "pro"): number {
  const extras = preset.extras as KlingPresetExtras | undefined;
  if (extras?.cost_per_second_cny) return extras.cost_per_second_cny;
  // Fallback defaults (approximate, from official pricing)
  return tier === "pro" ? 0.7 : 0.35;
}

// ─── Aspect ratio mapping ──────────────────────────────────────────

function mapAspectRatio(ratio: string): string {
  // Kling accepts "9:16", "16:9", "1:1" directly
  const valid = ["9:16", "16:9", "1:1"];
  return valid.includes(ratio) ? ratio : "16:9";
}

/** S5: 将 aspect_ratio 字符串解析为宽高 */
function aspectDims(aspect: string): { w: number; h: number } {
  switch (aspect) {
    case "9:16": return { w: 1080, h: 1920 };
    case "1:1": return { w: 1080, h: 1080 };
    case "4:3": return { w: 1440, h: 1080 };
    case "3:4": return { w: 1080, h: 1440 };
    case "16:9":
    default: return { w: 1920, h: 1080 };
  }
}

// ─── KlingVideoProvider ────────────────────────────────────────────

export class KlingVideoProvider implements VideoProvider {
  readonly id: string;
  readonly mode: "i2v" = "i2v";

  private _config: KlingConfig;
  private _jwtManager: KlingJwtManager | null;
  private _tier: "std" | "pro";
  private _costPerSecond: number;

  constructor(cfg: PresetOption, accessKey: string | null, secretKey: string | null) {
    this.id = cfg.id;
    this._config = loadKlingConfig();
    this._tier = extractTier(cfg);
    this._costPerSecond = extractCostPerSecond(cfg, this._tier);

    const finalAccessKey = accessKey || this._config.accessKey || null;
    const finalSecretKey = secretKey || this._config.secretKey || null;

    if (!finalAccessKey || !finalSecretKey) {
      // Lazy: will throw in generate() if keys are missing
      this._jwtManager = null;
    } else {
      // Load config already has keys from env; override with explicit keys
      this._config.accessKey = finalAccessKey;
      this._config.secretKey = finalSecretKey;
      this._jwtManager = new KlingJwtManager(finalAccessKey, finalSecretKey);
    }
  }

  async generate(req: VideoGenerateRequest, ctx: ProviderContext): Promise<VideoGenerateResponse> {
    // 2026-05-18: 二级 instance_override (渠道+实例架构) — 优先用 per-call key + base_url,
    // 没有就 fallback 到构造时的 env / preset cfg. Kling 需要双 key, secret 缺失 → throw.
    const override = req.instance_override;
    const effectiveConfig: KlingConfig = { ...this._config };
    let effectiveJwt = this._jwtManager;
    if (override) {
      const ak = override.api_key?.trim() || effectiveConfig.accessKey;
      const sk = override.secret_key?.trim() || effectiveConfig.secretKey;
      if (!ak || !sk) {
        throw new ProviderError({
          message: "Kling 实例缺少 AK 或 SK (instance_override.api_key/secret_key 必填)",
          code: "missing_key",
          provider_id: this.id,
          retriable: false,
        });
      }
      effectiveConfig.accessKey = ak;
      effectiveConfig.secretKey = sk;
      if (override.api_base_url?.trim()) effectiveConfig.baseUrl = override.api_base_url.trim();
      effectiveJwt = new KlingJwtManager(ak, sk);
    }

    // ── Key check ──
    if (!effectiveConfig.accessKey || !effectiveConfig.secretKey) {
      throw new ProviderError({
        message: "Kling API keys not configured (KLING_ACCESS_KEY / KLING_SECRET_KEY)",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }
    // Lazy init: create JWT manager if not yet created (keys came from config, not constructor param)
    if (!effectiveJwt) {
      effectiveJwt = new KlingJwtManager(effectiveConfig.accessKey, effectiveConfig.secretKey);
    }

    // ── Read first frame from AssetStore ──
    let imageBase64: string;
    if (req.first_frame?.asset_id) {
      try {
        const assetPath = req.first_frame.asset_id;
        const buffer = await fs.readFile(assetPath);
        imageBase64 = buffer.toString("base64");
      } catch (err: any) {
        throw new ProviderError({
          message: `Failed to read first frame asset: ${err.message}`,
          code: "invalid_request",
          provider_id: this.id,
          retriable: false,
          original: err,
        });
      }
    } else {
      throw new ProviderError({
        message: "Kling i2v requires first_frame.asset_id",
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    // 2026-05-21 X-1: 尾帧 — Kling v1.6 API 支持 image_tail, 读文件传 base64
    let tailImageBase64: string | undefined;
    if (req.last_frame?.asset_id) {
      try {
        const tailPath = req.last_frame.asset_id;
        const tailBuffer = await fs.readFile(tailPath);
        tailImageBase64 = tailBuffer.toString("base64");
      } catch (err: any) {
        ctx.log("warn", `[kling] Failed to read tail frame, skipping: ${err.message}`);
      }
    }

    // ── Build submit input ──
    const duration = req.duration_sec <= 5 ? "5" : "10";
    const submitInput: KlingSubmitInput = {
      model_name: req.model_id?.trim() || effectiveConfig.model,
      prompt: req.prompt,
      image: imageBase64,
      image_tail: tailImageBase64,
      duration,
      aspect_ratio: mapAspectRatio(req.aspect_ratio),
      cfg_scale: effectiveConfig.cfgScale,
      mode: this._tier,
    };

    if (req.extras?.negative_prompt && typeof req.extras.negative_prompt === "string") {
      submitInput.negative_prompt = req.extras.negative_prompt;
    }

    // ── Submit task ──
    ctx.log("info", `[kling] Submitting i2v task (model=${submitInput.model_name}, mode=${this._tier}, duration=${duration}s)`);

    let submitResult;
    try {
      submitResult = await submitKlingI2V(effectiveConfig, effectiveJwt, submitInput);
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      // P186-T2: classify by keyword before falling back to server
      const msg = (err.message ?? String(err)).toLowerCase();
      if (msg.includes("insufficient balance") || msg.includes("quota")) {
        throw new ProviderError({
          message: `Kling submit error: ${err.message}`,
          code: "quota_exceeded",
          provider_id: this.id,
          retriable: false,
          original: err,
        });
      }
      throw new ProviderError({
        message: `Kling submit error: ${err.message}`,
        code: "server",
        provider_id: this.id,
        retriable: true,
        original: err,
      });
    }

    ctx.log("info", `[kling] Task submitted: ${submitResult.task_id}`);

    // B6: persist inflight record for crash recovery
    const inflight = await saveInflight({
      provider_id: this.id,
      provider_job_id: submitResult.task_id,
      submitted_at: new Date().toISOString(),
      poll_url: `${effectiveConfig.baseUrl}/v1/videos/image2video/${encodeURIComponent(submitResult.task_id)}`,
      context: { series_slug: ctx.series_slug, shot_id: ctx.task_id, kind: "video", job_id: ctx.job_id, aspect_ratio: req.aspect_ratio, duration_sec: req.duration_sec },
    });

    // ── Poll until complete (T1: pass ctx.signal for abort propagation) ──
    let taskResult;
    try {
      taskResult = await pollKlingTask(
        effectiveConfig,
        effectiveJwt,
        submitResult.task_id,
        (msg) => ctx.log("info", msg),
        ctx.signal,
      );
    } catch (err: any) {
      // 2026-07-09 audit C7: post-submit(已拿到 task_id → 任务已提交、Kling 端可能已出片已扣费)
      // 一律 retriable:false — 严禁 queue._execute 重跑整个 generate() 重新 submit 一个新可灵任务
      // (=同一视频重复扣费 2-3 次, 而 budgetGuard 只记最终成功那次, 架空日预算硬熔断)。
      if (err instanceof ProviderError) {
        // 终态失败(task genuinely failed / no-data, retriable:false)才清 inflight 句柄。
        if (!err.retriable) {
          await removeInflight(inflight.inflight_id).catch(() => {});
          throw err;
        }
        // 2026-07-09 audit C7 补漏: pollKlingTask 在 wall-clock timeout / ctx.signal abort 时抛
        // ProviderError{code:"timeout", retriable:true}(klingClient.ts:382)。绝不能原样重抛 —
        // queue._execute(queue.ts:222) 认 retriable 会重跑 generate() 重新 submitKlingI2V 一个
        // 全新计费任务 = 同一视频重复扣费 2-3 次, budgetGuard 只记成功 1 次, 架空日预算硬熔断。
        // 保留 inflight 句柄让 startup resumePoll 恢复已扣费任务, 但强制 retriable:false 阻止重跑。
        throw new ProviderError({
          message: err.message,
          code: err.code,
          provider_id: this.id,
          retriable: false,
          original: (err as any).original ?? err,
        });
      }
      // P186-T2: classify by keyword before falling back to server
      const msg = (err.message ?? String(err)).toLowerCase();
      if (msg.includes("insufficient balance") || msg.includes("quota")) {
        await removeInflight(inflight.inflight_id).catch(() => {}); // 余额不足=终态, 清句柄
        throw new ProviderError({
          message: `Kling poll error: ${err.message}`,
          code: "quota_exceeded",
          provider_id: this.id,
          retriable: false,
          original: err,
        });
      }
      // 瞬时 poll 错误: 保留 inflight 句柄给 resumePoll, retriable:false 阻止 queue 重跑 generate 重复提交
      throw new ProviderError({
        message: `Kling poll error: ${err.message}`,
        code: "server",
        provider_id: this.id,
        retriable: false,
        original: err,
      });
    }

    // ── Extract video URL ──
    const videoUrl = taskResult.task_result?.videos?.[0]?.url;
    if (!videoUrl) {
      await removeInflight(inflight.inflight_id).catch(() => {});
      throw new ProviderError({
        message: `Kling task ${submitResult.task_id} succeeded but no video URL returned`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    // ── Download video ──
    const tmpDir = path.join(process.cwd(), "outputs", "kling_video");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `kling_${ctx.task_id}_${Date.now()}.mp4`);

    ctx.log("info", `[kling] Downloading video from ${videoUrl.slice(0, 80)}...`);

    let downloadResult;
    try {
      downloadResult = await downloadKlingVideo(videoUrl, outputPath, effectiveConfig.downloadTimeoutMs);
    } catch (err: any) {
      // 2026-07-09 audit C7 (核心 bug): 轮询已成功 = Kling 端已出片已扣费, 下载结果 MP4 时的瞬时错误
      // (CDN 500 / 连接重置, 极常见)绝不能删 inflight + retriable:true — 那会让 queue 重跑 generate()
      // 重新提交一个全新可灵任务 = 第二次扣费, 而 budgetGuard 只记最终成功 1 次, 日/单作业/provider
      // 三档硬熔断被架空。保留 inflight 句柄让 startup resumePoll 只重下载、不重新提交。
      if (err instanceof ProviderError) {
        if (!err.retriable) {
          await removeInflight(inflight.inflight_id).catch(() => {});
          throw err;
        }
        // 2026-07-09 audit C7 补漏: 对称覆盖 ProviderError 重抛路径 — 轮询已成功 = Kling 端已出片已扣费。
        // 下载阶段若冒出 retriable:true 的 ProviderError(未来 downloadKlingVideo 若改抛 ProviderError,
        // 或走 CDN 429/5xx 分类)同样绝不能原样重抛让 queue 重跑 generate() 重新提交扣费。
        // 保留 inflight 句柄让 startup resumePoll 只重下载, 强制 retriable:false 阻止重新提交。
        throw new ProviderError({
          message: err.message,
          code: err.code,
          provider_id: this.id,
          retriable: false,
          original: (err as any).original ?? err,
        });
      }
      // P186-T2: classify by keyword before falling back to server
      const msg = (err.message ?? String(err)).toLowerCase();
      if (msg.includes("insufficient balance") || msg.includes("quota")) {
        await removeInflight(inflight.inflight_id).catch(() => {}); // 余额不足=终态, 清句柄
        throw new ProviderError({
          message: `Kling download error: ${err.message}`,
          code: "quota_exceeded",
          provider_id: this.id,
          retriable: false,
          original: err,
        });
      }
      // 瞬时下载错误: 保留 inflight 句柄给 resumePoll 重下载, retriable:false 阻止重新提交扣费
      throw new ProviderError({
        message: `Kling download error: ${err.message}`,
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
    const actualDuration = Number(taskResult.task_result?.videos?.[0]?.duration) || Number(duration);
    const costAmount = actualDuration * this._costPerSecond;

    ctx.log("info", `[kling] Video ready: ${downloadResult.bytes} bytes, ${actualDuration}s, cost ¥${costAmount.toFixed(2)}`);

    return {
      video: {
        buffer,
        mime: "video/mp4",
        duration_sec: actualDuration,
        width: aspectDims(req.aspect_ratio).w,
        height: aspectDims(req.aspect_ratio).h,
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
        message: "Kling API keys not configured",
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

    // Poll existing task (no submit)
    const taskResult = await pollKlingTask(
      this._config,
      this._jwtManager!,
      providerJobId,
      undefined,
      signal,
    );

    const videoUrl = taskResult.task_result?.videos?.[0]?.url;
    if (!videoUrl) {
      throw new ProviderError({
        message: `Kling task ${providerJobId} succeeded but no video URL returned`,
        code: "server",
        provider_id: this.id,
        retriable: false,
      });
    }

    // Download video
    const tmpDir = path.join(process.cwd(), "outputs", "kling_video");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `kling_resume_${Date.now()}.mp4`);
    await downloadKlingVideo(videoUrl, outputPath, this._config.downloadTimeoutMs);
    const buffer = await fs.readFile(outputPath);

    // S5: 从 context 解析 duration + 从 aspect_ratio 解析 dimensions
    const duration = Number(taskResult.task_result?.videos?.[0]?.duration) || ctxDurationSec;
    const dims = aspectDims(ctxAspectRatio);

    // S5 兜底: 若 context 缺失, ffprobe 实际文件
    let finalWidth = dims.w;
    let finalHeight = dims.h;
    let finalDuration = duration;
    if (!hasContext) {
      try {
        const { probeVideoFile } = await import("../../../render/src/ffprobe");
        const probe = await probeVideoFile(outputPath);
        if (probe.has_video_stream && probe.width > 0 && probe.height > 0) {
          finalWidth = probe.width;
          finalHeight = probe.height;
          finalDuration = probe.duration_sec > 0 ? probe.duration_sec : finalDuration;
        }
      } catch { /* ffprobe best-effort */ }
    }

    await fs.unlink(outputPath).catch(() => {});

    return {
      video: {
        buffer,
        mime: "video/mp4",
        duration_sec: finalDuration,
        width: finalWidth,
        height: finalHeight,
      },
    };
  }

  // S1: 尝试取消远端 Kling 任务
  async cancel(providerJobId: string, _ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed"> {
    if (!this._config.accessKey || !this._config.secretKey) return "failed";
    try {
      const { cancelKlingTask } = await import("./klingClient");
      return await cancelKlingTask(this._config, this._jwtManager!, providerJobId);
    } catch {
      return "failed";
    }
  }

  // B3: 预估成本(按秒单价 * 时长)
  estimateCost(req: VideoGenerateRequest): { cny: number; basis: "estimated" } {
    const duration = req.duration_sec <= 5 ? 5 : 10;
    return { cny: duration * this._costPerSecond, basis: "estimated" };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._config.accessKey || !this._config.secretKey) {
      return { ok: false, reason: "missing KLING_ACCESS_KEY / KLING_SECRET_KEY" };
    }
    return { ok: true };
  }
}
