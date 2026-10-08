import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, getConfigValue } from "../../core/src/index";
import {
  readVideoProviderPresets,
  resolveVideoPresetSelection,
  redactVideoUrl,
  type PresetSelection
} from "../../core/src/videoProviderPresets";
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
  loadAliyunWanConfig,
  submitWanTextToVideo,
  pollWanTask,
  downloadWanFile,
  type AliyunWanConfig
} from "./aliyunWanClient";
import { saveInflight, removeInflight } from "./core/inflightStore";

const FALLBACK_PROMPT = "高级感知识讲解画面，简洁构图，柔和背景，信息卡片视觉，[固定]";

function clampPrompt(prompt: string, maxChars: number): { text: string; originalLength: number; finalLength: number; wasFallback: boolean } {
  const originalLength = prompt.length;
  if (!prompt || prompt.trim().length === 0) {
    return { text: FALLBACK_PROMPT, originalLength: 0, finalLength: FALLBACK_PROMPT.length, wasFallback: true };
  }
  if (prompt.length <= maxChars) {
    return { text: prompt, originalLength, finalLength: prompt.length, wasFallback: false };
  }
  const truncated = prompt.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf("。");
  const lastComma = truncated.lastIndexOf("，");
  const cutAt = lastPeriod > maxChars * 0.7 ? lastPeriod + 1 : lastComma > maxChars * 0.7 ? lastComma : truncated.lastIndexOf(" ") > maxChars * 0.7 ? truncated.lastIndexOf(" ") : maxChars;
  const text = truncated.slice(0, cutAt).trimEnd();
  return { text, originalLength, finalLength: text.length, wasFallback: false };
}

export class AliyunWanT2VProvider implements VideoProvider {
  id = "aliyun_wan_t2v";
  label = "阿里云百炼 / 通义万相 Wan 文生视频";
  private config: AliyunWanConfig;
  private presetSelection: PresetSelection | null = null;

  constructor(configOverrides?: Partial<AliyunWanConfig>) {
    const base = loadAliyunWanConfig();
    this.config = { ...base, ...configOverrides };
  }

  private get apiKeyPresent(): boolean {
    return Boolean(this.config.apiKey && this.config.apiKey.trim().length > 0);
  }

  private resolvePreset(input: ClipJobInput): PresetSelection | null {
    const presets = readVideoProviderPresets();
    const defaultModel = presets.default_model_overrides["aliyun_wan_t2v"] || "wan2.2-t2v-plus";
    const modelId = input.model || this.config.model || defaultModel;

    const result = resolveVideoPresetSelection({
      providerId: "aliyun_wan_t2v",
      modelId,
      aspectRatio: input.aspectRatio || this.config.aspectRatio,
      resolutionTier: input.resolution || this.config.resolutionTier,
      duration: input.durationSec || this.config.duration,
      promptExtend: this.config.promptExtend,
      watermark: this.config.watermark,
      seed: this.config.seed,
      negativePrompt: this.config.negativePrompt
    });

    if (result.ok) return result.selection;
    return null;
  }

  async submitTextToVideoClip(input: ClipJobInput): Promise<ClipJobResult> {
    if (!this.apiKeyPresent) {
      return { ok: false, error: "阿里云百炼 API Key 未配置", error_type: "key_missing" };
    }

    // Resolve preset selection
    const presets = readVideoProviderPresets();
    const defaultModel = presets.default_model_overrides["aliyun_wan_t2v"] || "wan2.2-t2v-plus";
    const modelId = input.model || this.config.model || defaultModel;

    const selectionResult = resolveVideoPresetSelection({
      providerId: "aliyun_wan_t2v",
      modelId,
      aspectRatio: input.aspectRatio || this.config.aspectRatio,
      resolutionTier: input.resolution || this.config.resolutionTier,
      duration: input.durationSec || this.config.duration,
      promptExtend: this.config.promptExtend,
      watermark: this.config.watermark,
      seed: this.config.seed,
      negativePrompt: this.config.negativePrompt
    });

    if (!selectionResult.ok) {
      return {
        ok: false,
        error: `Preset validation failed: ${selectionResult.errors.map(e => e.message).join("; ")}`,
        error_type: "invalid_preset"
      };
    }

    const sel = selectionResult.selection;
    this.presetSelection = sel;

    // Clamp prompt
    const modelPreset = presets.providers["aliyun_wan_t2v"]?.models[sel.modelId];
    const maxChars = modelPreset?.prompt_max_chars || 800;
    const clamped = clampPrompt(input.prompt || "", maxChars);
    const negativePromptMaxChars = modelPreset?.negative_prompt_max_chars || 500;
    let negativePrompt = sel.negativePrompt || "";
    if (negativePrompt.length > negativePromptMaxChars) {
      negativePrompt = negativePrompt.slice(0, negativePromptMaxChars);
    }

    const jobRoot = input.jobRoot || path.dirname(input.assetPath);
    const sceneDir = input.sceneStableId || "unknown";
    const clipsDir = path.join(jobRoot, "clips", sceneDir);
    await ensureDir(clipsDir);

    let taskId = "";
    try {
      // Submit task
      const submitResult = await submitWanTextToVideo(this.config, {
        prompt: clamped.text,
        negativePrompt: negativePrompt || undefined,
        model: sel.modelId,
        size: sel.size,
        duration: sel.duration,
        promptExtend: sel.promptExtend,
        watermark: sel.watermark,
        seed: sel.seed
      });

      taskId = submitResult.task_id;

      // V3: persist inflight for crash recovery
      await saveInflight({
        provider_id: "aliyun_wan_t2v",
        provider_job_id: taskId,
        submitted_at: new Date().toISOString(),
        context: { aspect_ratio: sel.aspectRatio, duration_sec: sel.duration },
      });

      // Poll until complete
      const pollResult = await pollWanTask(this.config, taskId);

      if (pollResult.task_status === "FAILED") {
        return {
          ok: false,
          error: pollResult.message || `Aliyun Wan task ${taskId} failed`,
          error_type: "provider_job_failed",
          providerJobId: taskId,
          rawStatusRedacted: redactVideoUrl(pollResult.raw)
        };
      }

      if (pollResult.task_status === "CANCELED") {
        return {
          ok: false,
          error: `Aliyun Wan task ${taskId} was canceled`,
          error_type: "provider_job_failed",
          providerJobId: taskId,
          rawStatusRedacted: redactVideoUrl(pollResult.raw)
        };
      }

      if (pollResult.task_status === "UNKNOWN") {
        return {
          ok: false,
          error: `Aliyun Wan task ${taskId} returned unknown status`,
          error_type: "provider_job_unknown",
          providerJobId: taskId,
          rawStatusRedacted: redactVideoUrl(pollResult.raw)
        };
      }

      if (!pollResult.video_url) {
        return {
          ok: false,
          error: `Aliyun Wan task ${taskId} succeeded but no video_url`,
          error_type: "provider_job_failed",
          providerJobId: taskId
        };
      }

      // Download MP4
      const timestamp = Date.now();
      const outputPath = input.outputPath || path.join(clipsDir, `aliyun_wan_${timestamp}.mp4`);
      const downloadResult = await downloadWanFile(pollResult.video_url, outputPath, this.config.downloadTimeoutMs);

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

      // Parse size for width/height
      const sizeParts = sel.size.split("*");
      const videoWidth = sizeParts.length === 2 ? parseInt(sizeParts[0], 10) : undefined;
      const videoHeight = sizeParts.length === 2 ? parseInt(sizeParts[1], 10) : undefined;

      return {
        ok: true,
        providerJobId: taskId,
        clipPath: downloadResult.filePath,
        durationSec: actualDuration,
        videoWidth,
        videoHeight,
        bytes: downloadResult.bytes,
        promptOriginalLength: clamped.originalLength,
        promptFinalLength: clamped.finalLength,
        rawStatusRedacted: redactVideoUrl({
          task_status: "SUCCEEDED",
          video_url_present: true,
          usage: pollResult.usage,
          orig_prompt: pollResult.orig_prompt,
          actual_prompt: pollResult.actual_prompt
        }),
        isRealVideo: true,
        providerKind: "real_video",
        promptWasFallback: clamped.wasFallback
      };
    } catch (error: any) {
      const errType = error.error_type || "provider_job_failed";
      const rawMsg = scrubForClient(error.message || String(error));
      return {
        ok: false,
        error: rawMsg,
        error_type: errType,
        providerJobId: error.provider_task_id,
        rawStatusRedacted: error.raw_redacted ? redactVideoUrl(error.raw_redacted) : undefined
      };
    } finally {
      if (taskId) await removeInflight(taskId).catch(() => {});
    }
  }

  async submitImageToVideoClip(input: ClipJobInput): Promise<ClipJobResult> {
    return { ok: false, error: "Aliyun Wan image-to-video not supported in v0.2.1", error_type: "not_supported" };
  }

  async getJobStatus(providerJobId: string): Promise<ClipJobStatus> {
    if (!this.apiKeyPresent) {
      return { status: "failed", error: "阿里云百炼 API Key 未配置", error_type: "key_missing" };
    }

    try {
      const { queryWanTask } = await import("./aliyunWanClient");
      const result = await queryWanTask(this.config, providerJobId);

      switch (result.task_status) {
        case "SUCCEEDED":
          return { status: "completed" };
        case "FAILED":
        case "CANCELED":
          return { status: "failed", error: result.message || `Task ${providerJobId} failed`, error_type: "provider_job_failed" };
        case "UNKNOWN":
          return { status: "failed", error: `Task ${providerJobId} unknown status`, error_type: "provider_job_unknown" };
        default:
          return { status: "running" };
      }
    } catch (error: any) {
      return { status: "failed", error: scrubForClient(error.message || String(error)), error_type: "provider_job_failed" };
    }
  }

  async downloadClip(providerJobId: string, outputPath: string): Promise<string> {
    if (!this.apiKeyPresent) {
      throw new Error("阿里云百炼 API Key 未配置");
    }

    const { queryWanTask, downloadWanFile } = await import("./aliyunWanClient");
    const result = await queryWanTask(this.config, providerJobId);

    if (result.task_status !== "SUCCEEDED" || !result.video_url) {
      throw new Error(`Task ${providerJobId} is not ready for download (status: ${result.task_status})`);
    }

    return (await downloadWanFile(result.video_url, outputPath, this.config.downloadTimeoutMs)).filePath;
  }

  async cancelJob(providerJobId: string): Promise<void> {
    // Aliyun DashScope does not support cancel via API in this version
  }

  async estimateCost(input: ClipJobInput): Promise<CostEstimate> {
    const duration = input.durationSec || this.config.duration || 5;
    const modelId = input.model || this.config.model || "wan2.2-t2v-plus";
    // v0.2.4 fix: previously checked `input.resolution` twice but
    // `config.resolutionTier` only once in the 720 branch. Now both fall
    // back symmetrically to config so setting ALIYUN_WAN_RESOLUTION_TIER=1080P
    // no longer under-estimates by a full tier.
    const resolutionTier = input.resolution || this.config.resolutionTier || "480P";
    const is720PPlus = resolutionTier.includes("720") || resolutionTier.includes("1080");

    let credits = 1;
    if (modelId.includes("2.6")) credits = is720PPlus ? 5 : 3;
    else if (modelId.includes("2.5")) credits = is720PPlus ? 3 : 2;
    else credits = is720PPlus ? 2 : 1;

    const usd = credits * 0.10;

    return {
      estimated_credits: credits,
      estimated_usd: Math.round(usd * 100) / 100,
      currency: "USD",
      notes: `估算基于 ${modelId} / ${resolutionTier} / ${duration}s（仅供参考，以阿里云百炼平台计费为准）。`
    };
  }
}
