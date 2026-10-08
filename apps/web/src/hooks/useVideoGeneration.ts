/**
 * useVideoGeneration — 统一视频生成 hook (Phase 2, Wave 2, 2026-05-16).
 *
 * 对称 useImageGeneration. 差异:
 *  - 真实 provider 必须先 dry-run 拿估费 + 真实锁状态, hook 内置二级确认 (Wave 4-D)
 *  - tasksStore kind = "video", eta_s 默认按 duration_sec × 8s + 60s baseline
 *  - 视频默认 1 条, 不允许批量 (实际成本 / 锁占用太高)
 *
 * ── 模式 (Wave 4-B) ────────────────────────────────────────────────
 *  - mode: "sync"   (调统一 /api/v2/generate/video 等结果)
 *  - mode: "async"  (默认 — 视频几乎全是长任务 + 真实视频锁, 必须靠 SSE):
 *      调 scoped endpoint /api/v2/series/.../shots/.../stage/video/generate,
 *      立即返 task_id → tasksStore queued → SSE buildTaskEventHandlers 接管.
 *
 *      async 模式仅支持 target.kind = shot_video.
 *
 *      真实视频锁 acquire 在后端做; 前端只看 SSE task.failed (含 409 锁占用错误)
 *      触发 onError, 不在客户端拦锁.
 *
 * 与 useImageGeneration 一致, 不调 compiler、不写 SWR、不暴露技术字段。
 *
 * ── Wave 4-D dry-run + confirm 下沉 (2026-05-16) ────────────────────
 *
 * trigger() 内部根据 confirmRealVideo 选项 + isRealVideoProvider 判断,
 * 自动跑 dry-run + confirm. 真实锁被占 → 直接拒返 null.
 *
 * ── 2026-05-28 audit P2 refactor ────────────────────────────────────
 *   SSE 连接 / callback ref / dry-run confirm / async tasks ack / sync pseudo task
 *   样板全部抽到 generationHookHelpers.ts (跟 useImageGeneration 共享).
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  generateVideo,
  generateVideoAsync,
  generateVideoDryRun,
  type GenerateVideoInput,
  type GenerateVideoResult,
  type GenerateVideoDryRunResult,
  type VideoGenerationTarget,
  type PersistedVideo,
} from "../lib/generationApi";
import { labelOfSource, resolveTaskFailureMessage } from "../lib/sourceLabels";
import { isRealVideoProvider } from "../lib/providerKind";
import { type TaskStatus } from "../stores/tasksStore";
import { getScopedShotDetail, isNotImplemented, type ShotDetail } from "../lib/shotApi";
import {
  useCallbackRefs,
  useGenerationSSE,
  runDryRunConfirm,
  registerAsyncTasksAck,
  upsertLocalSyncTask,
  makePseudoTaskId,
} from "./generationHookHelpers";

// ─── Hook 公共契约 ──────────────────────────────────────────────────

export type VideoGenerationMode = "sync" | "async";

export interface UseVideoGenerationOptions {
  target: VideoGenerationTarget;
  mode?: VideoGenerationMode;
  onSuccess?: (result: GenerateVideoResult) => void;
  onError?: (err: unknown) => void;
  displayName?: string;
  confirmRealVideo?: boolean;
  confirmFn?: (message: string) => Promise<boolean>;
  onGoSettings?: () => void;
}

export interface UseVideoGenerationResult {
  trigger: (input: GenerateVideoTriggerInput) => Promise<GenerateVideoResult | null>;
  dryRun: (input: GenerateVideoTriggerInput) => Promise<GenerateVideoDryRunResult>;
  generating: boolean;
  estimating: boolean;
  awaiting: boolean;
  lastError: string | null;
}

export interface GenerateVideoTriggerInput {
  prompt: string;
  negative_prompt?: string;
  model_ref?: string;
  duration_sec?: number;
  aspect_ratio?: GenerateVideoInput["aspect_ratio"];
  seed?: number;
  first_frame?: GenerateVideoInput["first_frame"];
  reference_images?: GenerateVideoInput["reference_images"];
  source_video_generation_id?: string;
  /** 2026-05-27 — 同时抽 N 段视频 (后端 GenerateVideoSchema 已支持 1..3) */
  count?: number;
  extra_tags?: string[];
  job_id?: string;
  task_id?: string;
}

// ─── 实现 ───────────────────────────────────────────────────────────

export function useVideoGeneration(options: UseVideoGenerationOptions): UseVideoGenerationResult {
  const {
    target,
    mode = "async",
    onSuccess,
    onError,
    displayName,
    confirmRealVideo = true,
    confirmFn,
    onGoSettings,
  } = options;

  const [generating, setGenerating] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // callback refs (避免闭包陈旧 + 不触发 SSE 重连)
  const { onSuccessRef, onErrorRef, displayNameRef } = useCallbackRefs<GenerateVideoResult>({
    onSuccess,
    onError,
    displayName,
  });

  // pendingTaskIdsRef — async 模式跟踪本次投放 task_id 集合
  const pendingTaskIdsRef = useRef<Set<string>>(new Set());

  // ── SSE 订阅 (async 模式订阅 task.video.*) ─────────────────────
  const slug = target.series_slug;
  const epIdHint =
    typeof target.meta?.ep_id === "string" ? (target.meta.ep_id as string) : "";

  useGenerationSSE({
    enabled: mode === "async" && Boolean(slug),
    seriesSlug: slug ?? "",
    targetId: target.target_id,
    epIdHint,
    expectedKind: "video",
    onTerminal: async (status) => {
      await handleSseTerminal(status);
    },
  });

  async function handleSseTerminal(status: TaskStatus) {
    if (status === "succeeded") {
      try {
        const sid = target.target_id ?? "";
        if (!slug || !epIdHint || !sid) {
          setAwaiting(false);
          return;
        }
        const res = await getScopedShotDetail(slug, epIdHint, sid);
        if (isNotImplemented(res)) {
          onSuccessRef.current?.({
            ok: true,
            video: emptyVideo(),
            provider_id: "",
            target_state: undefined,
          });
          setAwaiting(false);
          return;
        }
        const shot = res as ShotDetail;
        // 找最新挑选的 / 最新一条 video candidate
        const candidates = shot.video_candidates ?? [];
        const picked =
          (shot.picked_video_id
            ? candidates.find(
                (c) => c.id === shot.picked_video_id || c.generation_id === shot.picked_video_id,
              )
            : undefined) ?? candidates[candidates.length - 1];
        const video: PersistedVideo = picked
          ? {
              generation_id: picked.generation_id,
              asset_id: picked.asset_id,
              vault_id: picked.vault_id,
              url: picked.url ?? "",
              duration_sec: picked.duration_sec ?? 0,
              mime: "video/mp4",
              provider_id: picked.provider ?? "",
              prompt_snapshot: picked.prompt ?? "",
            }
          : emptyVideo();

        const label = displayNameRef.current ?? "视频";
        toast.success(`「${label}」生成完成`);

        onSuccessRef.current?.({
          ok: true,
          video,
          provider_id: video.provider_id,
          target_state: shot,
        });
      } catch (err) {
        // audit P0 #8: catch 改 onError 不 silent
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[useVideoGeneration async] fetch shot detail after task.done failed:", msg);
        if (onErrorRef.current) {
          onErrorRef.current(new Error(`生成完成但刷新候选区失败 (${msg}), 请手动刷新页面看新视频`));
        } else {
          toast.warning(`生成完成但刷新候选区失败, 请刷新页面: ${msg}`);
        }
      } finally {
        setAwaiting(false);
      }
    } else if (status === "failed") {
      // 走 resolveTaskFailureMessage 跟 useImage 共享底层 (改一处两边都生效)
      const { friendly, raw } = resolveTaskFailureMessage(
        target.target_id ?? "",
        "video",
        "视频生成失败, 请稍后重试",
        slug,
      );
      setLastError(friendly);
      if (onErrorRef.current) {
        const err: Error & { rawProviderError?: string } = new Error(friendly);
        if (raw) err.rawProviderError = raw;
        onErrorRef.current(err);
      } else {
        toast.error(friendly);
      }
      setAwaiting(false);
    }
  }

  // ── Wave 4-D: dry-run + confirm 包装层 ────────────────────────────
  // 真实 video provider 时跑 dry-run + confirm (key_missing/锁占/费用三态).
  const trigger = useCallback(
    async (input: GenerateVideoTriggerInput): Promise<GenerateVideoResult | null> => {
      setLastError(null);

      const providerRef =
        input.model_ref ??
        (typeof target.meta?.default_model_ref === "string"
          ? (target.meta.default_model_ref as string)
          : undefined);
      const needsConfirm = confirmRealVideo && isRealVideoProvider(providerRef);

      if (needsConfirm) {
        const outcome = await runDryRunConfirm<GenerateVideoDryRunResult>({
          dryRun: () => dryRun(input),
          confirmFn,
          onGoSettings,
          dryRunFailFallbackMessage: (e) =>
            `费用预估失败 (${e instanceof Error ? e.message : String(e)})。\n仍要继续生成视频吗?`,
          preflight: async (dr) => {
            // 真实锁被占用 — 显式拒, 让用户知道当前谁在跑
            if (dr.real_lock_held_by) {
              const holder = dr.real_lock_held_by;
              const ask = confirmFn ?? ((_msg: string) => Promise.resolve(false));
              await ask(
                `真实视频锁被占用 — ${labelOfSource(holder.provider)} 正在生成 (分镜 ${holder.scene_id})。\n请稍后再试, 或改用 mock provider。`,
              );
              return false;
            }
            // 非真实 provider — 不需要弹 confirm, 直接放行
            if (!dr.is_real_provider) return undefined;
            // 真实 provider — 走默认 confirm
            return null;
          },
          buildCostMessage: (dr) => {
            const providerLabel = labelOfSource(dr.provider_id);
            const cost = dr.estimated_cost_cny;
            const costPart = cost != null ? `预估费用: ¥${cost.toFixed(2)}` : "预估费用未知";
            const lockPart = dr.will_acquire_real_lock ? "\n锁占用: 是 (单镜真实锁)" : "";
            const durationPart =
              typeof input.duration_sec === "number" ? `\n时长: ${input.duration_sec}s` : "";
            const realWarning = "\n\n⚠ 真实视频 provider 会扣费";
            return `将用 ${providerLabel} 为「${displayName ?? "本镜头"}」生成视频。\n${costPart}${durationPart}${lockPart}${realWarning}\n\n确认继续?`;
          },
        });
        if (outcome === "cancelled") return null;
      }

      if (mode === "async") {
        return triggerAsync(input);
      }
      return triggerSync(input);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, target, confirmRealVideo, confirmFn, onGoSettings, displayName],
  );

  // ── sync 模式 ───────────────────────────────────────────────────
  async function triggerSync(input: GenerateVideoTriggerInput): Promise<GenerateVideoResult> {
    setGenerating(true);

    const pseudoTaskId = makePseudoTaskId("video");
    const shotIdForTask = target.kind === "shot_video" ? target.target_id : undefined;
    const epId = epIdHint || undefined;
    const etaSec = Math.max(60, (input.duration_sec ?? 5) * 8 + 30);

    upsertLocalSyncTask({
      pseudoTaskId,
      kind: "video",
      status: "queued",
      seriesSlug: target.series_slug,
      epId,
      shotId: shotIdForTask,
      etaSec,
    });

    try {
      const result = await generateVideo(buildInput(target, input));

      upsertLocalSyncTask({
        pseudoTaskId,
        kind: "video",
        status: "succeeded",
        seriesSlug: target.series_slug,
        epId,
        shotId: shotIdForTask,
        progress: 100,
      });

      const label = displayNameRef.current ?? "视频";
      const providerLabel = labelOfSource(result.provider_id);
      toast.success(`「${label}」已生成, 累加进图库 (${providerLabel})`);

      onSuccessRef.current?.(result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);

      upsertLocalSyncTask({
        pseudoTaskId,
        kind: "video",
        status: "failed",
        seriesSlug: target.series_slug,
        epId,
        shotId: shotIdForTask,
        errorMessage: msg,
      });

      if (onErrorRef.current) {
        onErrorRef.current(err);
      } else {
        toast.error(`生成失败: ${msg}`);
      }
      throw err;
    } finally {
      setGenerating(false);
    }
  }

  // ── async 模式 ──────────────────────────────────────────────────
  async function triggerAsync(input: GenerateVideoTriggerInput): Promise<GenerateVideoResult> {
    if (target.kind !== "shot_video") {
      const err = new Error(`async 模式仅支持 shot_video, 不支持 "${target.kind}"`);
      if (onErrorRef.current) {
        onErrorRef.current(err);
      } else {
        toast.error(err.message);
      }
      throw err;
    }

    setGenerating(true);
    setAwaiting(true);

    try {
      const ack = await generateVideoAsync(buildInput(target, input));

      const etaSec = Math.max(60, (input.duration_sec ?? 5) * 8 + 30);

      try {
        registerAsyncTasksAck({
          ack,
          kind: "video",
          seriesSlug: target.series_slug,
          epId: epIdHint || undefined,
          etaSec,
          skippedLimitMessage:
            "这一镜已达视频抽卡次数上限,请先清理废案或调高 max_retake_per_shot",
          noTaskMessage: "后端未能创建生成任务, 请检查模型配置",
          pendingTaskIdsRef,
        });
      } catch (helperErr) {
        const msg = helperErr instanceof Error ? helperErr.message : String(helperErr);
        setGenerating(false);
        setAwaiting(false);
        toast.error(msg);
        if (onErrorRef.current) onErrorRef.current(new Error(msg));
        throw helperErr;
      }

      setGenerating(false);
      const ackResult: GenerateVideoResult = {
        ok: true,
        video: emptyVideo(),
        provider_id: "",
        target_state: undefined,
      };
      return ackResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setGenerating(false);
      setAwaiting(false);
      if (onErrorRef.current) {
        onErrorRef.current(err);
      } else {
        toast.error(`生成失败: ${msg}`);
      }
      throw err;
    }
  }

  const dryRun = useCallback(
    async (input: GenerateVideoTriggerInput): Promise<GenerateVideoDryRunResult> => {
      setEstimating(true);
      try {
        return await generateVideoDryRun(buildInput(target, input));
      } finally {
        setEstimating(false);
      }
    },
    [target],
  );

  return { trigger, dryRun, generating, estimating, awaiting, lastError };
}

// ─── helpers ────────────────────────────────────────────────────────

function buildInput(target: VideoGenerationTarget, input: GenerateVideoTriggerInput): GenerateVideoInput {
  return {
    target,
    prompt: input.prompt,
    negative_prompt: input.negative_prompt,
    model_ref: input.model_ref,
    duration_sec: input.duration_sec,
    aspect_ratio: input.aspect_ratio,
    seed: input.seed,
    first_frame: input.first_frame,
    reference_images: input.reference_images,
    source_video_generation_id: input.source_video_generation_id,
    count: input.count,
    extra_tags: input.extra_tags,
    job_id: input.job_id,
    task_id: input.task_id,
  };
}

function emptyVideo(): PersistedVideo {
  return {
    generation_id: "",
    url: "",
    duration_sec: 0,
    mime: "video/mp4",
    provider_id: "",
    prompt_snapshot: "",
  };
}
