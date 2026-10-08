import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, pathExists, getConfigValue } from "../../core/src/index";
import { scrubForClient } from "../../core/src/logger";
import {
  type VideoProvider,
  type ClipJobInput,
  type ClipJobResult,
  type ClipJobStatus,
  type CostEstimate,
  probeClipDuration
} from "./video";
import {
  loadMiniMaxConfig,
  submitTextToVideo,
  pollVideoTask,
  retrieveFile,
  downloadFile,
  type MiniMaxConfig
} from "./minimaxClient";

const MAX_PROMPT_CHARS = 1800;
const FALLBACK_PROMPT = "高级感知识讲解画面，简洁构图，柔和背景，信息卡片视觉，[固定]";

export function clampPrompt(prompt: string, maxChars: number = MAX_PROMPT_CHARS): { text: string; originalLength: number; finalLength: number; wasFallback: boolean } {
  const originalLength = prompt.length;
  if (!prompt || prompt.trim().length === 0) {
    return { text: FALLBACK_PROMPT, originalLength: 0, finalLength: FALLBACK_PROMPT.length, wasFallback: true };
  }
  if (prompt.length <= maxChars) {
    return { text: prompt, originalLength, finalLength: prompt.length, wasFallback: false };
  }
  // Truncate at last complete sentence or word boundary
  const truncated = prompt.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf("。");
  const lastComma = truncated.lastIndexOf("，");
  const cutAt = lastPeriod > maxChars * 0.7 ? lastPeriod + 1 : lastComma > maxChars * 0.7 ? lastComma : truncated.lastIndexOf(" ") > maxChars * 0.7 ? truncated.lastIndexOf(" ") : maxChars;
  const text = truncated.slice(0, cutAt).trimEnd();
  // v0.2.4: truncation is NOT a fallback; wasFallback=false distinguishes
  // "prompt shortened to fit provider limit" from "prompt was empty and we
  // substituted a generic placeholder". Downstream stats stay accurate.
  return { text, originalLength, finalLength: text.length, wasFallback: false };
}

export interface MiniMaxClipJobResult extends ClipJobResult {
  provider_task_id?: string;
  provider_file_id?: string;
  raw_status_redacted?: string;
  is_real_video?: boolean;
  provider_kind?: string;
  video_width?: number;
  video_height?: number;
  bytes?: number;
  prompt_original_length?: number;
  prompt_final_length?: number;
  prompt_was_fallback?: boolean;
}

export class MiniMaxHailuoVideoProvider implements VideoProvider {
  id = "minimax_hailuo";
  label = "MiniMax / 海螺文生视频";
  private config: MiniMaxConfig;

  constructor(configOverrides?: Partial<MiniMaxConfig>) {
    const base = loadMiniMaxConfig();
    this.config = { ...base, ...configOverrides };
  }

  private get apiKeyPresent(): boolean {
    return Boolean(this.config.apiKey && this.config.apiKey.trim().length > 0);
  }

  async submitTextToVideoClip(input: ClipJobInput): Promise<ClipJobResult> {
    if (!this.apiKeyPresent) {
      return { ok: false, error: "MiniMax API Key 未配置", error_type: "key_missing" };
    }

    const clamped = clampPrompt(input.prompt || "");
    // v0.2.4 fix: use the explicit wasFallback flag from clampPrompt instead
    // of `clamped.text !== input.prompt`, which misclassifies length-truncated
    // prompts as fallback and skews real_clip_health statistics.
    const promptWasFallback = clamped.wasFallback;
    const jobRoot = input.jobRoot || path.dirname(input.assetPath);
    const sceneDir = input.sceneStableId || "unknown";
    const clipsDir = path.join(jobRoot, "clips", sceneDir);
    await ensureDir(clipsDir);

    try {
      // Submit task
      const submitResult = await submitTextToVideo(this.config, {
        prompt: clamped.text,
        model: input.model,
        duration: input.durationSec,
        resolution: input.resolution
      });

      const taskId = submitResult.task_id;

      // Poll until complete (T1: pass signal if available)
      const pollResult = await pollVideoTask(this.config, taskId, undefined, undefined);

      if (pollResult.status === "Fail") {
        return {
          ok: false,
          error: `MiniMax task ${taskId} failed`,
          error_type: "provider_job_failed",
          providerJobId: taskId
        };
      }

      // Retrieve download URL
      const retrieveResult = await retrieveFile(this.config, pollResult.file_id!);

      // Download MP4
      const timestamp = Date.now();
      const outputPath = input.outputPath || path.join(clipsDir, `minimax_${timestamp}.mp4`);
      const downloadResult = await downloadFile(retrieveResult.download_url, outputPath, this.config.downloadTimeoutMs);

      // Probe duration — reject invalid mp4
      const actualDuration = await probeClipDuration(downloadResult.filePath);
      if (!actualDuration || actualDuration <= 0) {
        return {
          ok: false,
          error: `Downloaded file is not a valid video (probe returned ${actualDuration})`,
          error_type: "invalid_downloaded_video",
          providerJobId: taskId
        };
      }

      return {
        ok: true,
        providerJobId: taskId,
        clipPath: downloadResult.filePath,
        durationSec: actualDuration,
        providerFileId: pollResult.file_id,
        videoWidth: pollResult.video_width,
        videoHeight: pollResult.video_height,
        bytes: downloadResult.bytes,
        promptOriginalLength: clamped.originalLength,
        promptFinalLength: clamped.finalLength,
        rawStatusRedacted: "Success",
        isRealVideo: true,
        providerKind: "real_video",
        promptWasFallback
      };
    } catch (error: any) {
      const errType = error.error_type || "provider_job_failed";
      const rawMsg = scrubForClient(error.message || String(error));
      return {
        ok: false,
        error: rawMsg,
        error_type: errType,
        providerJobId: error.provider_task_id
      };
    }
  }

  async submitImageToVideoClip(input: ClipJobInput): Promise<ClipJobResult> {
    return { ok: false, error: "MiniMax image-to-video not supported in v0.2", error_type: "not_supported" };
  }

  async getJobStatus(providerJobId: string): Promise<ClipJobStatus> {
    if (!this.apiKeyPresent) {
      return { status: "failed", error: "MiniMax API Key 未配置", error_type: "key_missing" };
    }

    try {
      const { queryVideoTask } = await import("./minimaxClient");
      const result = await queryVideoTask(this.config, providerJobId);

      if (result.status === "Success") {
        return { status: "completed", clipPath: undefined, durationSec: undefined };
      }
      if (result.status === "Fail") {
        return { status: "failed", error: `MiniMax task ${providerJobId} failed`, error_type: "provider_job_failed" };
      }
      return { status: "running" };
    } catch (error: any) {
      return { status: "failed", error: scrubForClient(error.message || String(error)), error_type: "provider_job_failed" };
    }
  }

  async downloadClip(providerJobId: string, outputPath: string): Promise<string> {
    if (!this.apiKeyPresent) {
      throw new Error("MiniMax API Key 未配置");
    }

    // providerJobId is the task_id; we need to query to get file_id, then retrieve download_url
    const { queryVideoTask, retrieveFile, downloadFile } = await import("./minimaxClient");
    const queryResult = await queryVideoTask(this.config, providerJobId);

    if (queryResult.status !== "Success" || !queryResult.file_id) {
      throw new Error(`MiniMax task ${providerJobId} is not ready for download (status: ${queryResult.status})`);
    }

    const retrieveResult = await retrieveFile(this.config, queryResult.file_id);
    return (await downloadFile(retrieveResult.download_url, outputPath, this.config.downloadTimeoutMs)).filePath;
  }

  async cancelJob(providerJobId: string): Promise<void> {
    // MiniMax API does not support cancel. Mark as a no-op.
  }

  /**
   * Resume polling an inflight task after server restart.
   * Uses getJobStatus + downloadClip to recover.
   */
  async resumePoll(providerJobId: string, signal?: AbortSignal): Promise<import("./core/types").VideoGenerateResponse> {
    if (!this.apiKeyPresent) {
      throw new Error("MiniMax API Key 未配置");
    }

    const { queryVideoTask, retrieveFile, downloadFile } = await import("./minimaxClient");
    const path = await import("node:path");

    // Poll with backoff
    // 2026-05-28 audit P0-08: resumePoll 不能本地 timeout 误判, 跟 generate 路径保持一致.
    // 远端任务可能 13-20 分钟正常, 只听 signal abort.
    let intervalMs = 5_000;
    const maxIntervalMs = 15_000;

    while (true) {
      if (signal?.aborted) throw new Error("Resume poll aborted");

      // 2026-05-18: 用户原话"本地不设额外的等待时间限制"
      const result = await queryVideoTask(this.config, providerJobId, signal);

      if (result.status === "Fail") {
        throw new Error(`MiniMax task ${providerJobId} failed`);
      }

      if (result.status === "Success" && result.file_id) {
        const retrieveResult = await retrieveFile(this.config, result.file_id);
        const outputPath = path.join(process.cwd(), "data", "_tmp", `resumed_${providerJobId}.mp4`);
        const downloadResult = await downloadFile(retrieveResult.download_url, outputPath, this.config.downloadTimeoutMs);
        const fs = await import("node:fs/promises");
        const buffer = await fs.readFile(downloadResult.filePath);

        // 2026-05-27 audit P0-14: 之前写死 6, 但 buffer 实际可能 6 / 10 秒, 字幕对齐用 6 算 → 10s 视频字幕只到 6s.
        // 违反铁律 #4. 用 ffprobe 探真长, 失败 fallback 用 inflight context 里持久化的 duration_sec.
        let realDurSec = 6;
        try {
          const { probeVideoFile } = await import("../../render/src/ffprobe");
          const probe = await probeVideoFile(downloadResult.filePath);
          if (probe.duration_sec > 0) realDurSec = probe.duration_sec;
        } catch {
          // ffprobe 失败 fallback 到 inflight context (resumePoll caller 传的)
          const ctxDur = (result as { _context_duration_sec?: number })._context_duration_sec;
          if (typeof ctxDur === "number" && ctxDur > 0) realDurSec = ctxDur;
        }

        return {
          video: {
            buffer,
            mime: "video/mp4",
            duration_sec: realDurSec,
            width: result.video_width ?? 1280,
            height: result.video_height ?? 720,
          },
        };
      }

      // Still pending
      await new Promise((r) => setTimeout(r, intervalMs));
      intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    }
  }

  async estimateCost(input: ClipJobInput): Promise<CostEstimate> {
    const duration = input.durationSec || 6;
    const is768P = (input.resolution || this.config.resolution).includes("768");
    // Rough estimate based on public MiniMax pricing hints
    const estimatedCredits = duration <= 6 ? (is768P ? 3 : 5) : (is768P ? 5 : 8);
    const estimatedUsd = estimatedCredits * 0.15;

    return {
      estimated_credits: estimatedCredits,
      estimated_usd: Math.round(estimatedUsd * 100) / 100,
      currency: "USD",
      notes: `估算基于 ${input.resolution || this.config.resolution} / ${duration}s。实际消耗以 MiniMax 平台计费为准。`
    };
  }
}
