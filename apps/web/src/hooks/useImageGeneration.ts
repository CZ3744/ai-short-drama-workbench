/**
 * useImageGeneration — 统一图像生成 hook (Phase 2, Wave 2, 2026-05-16).
 *
 * 把"调 API + tasksStore 上报 + SSE 订阅 + toast 反馈"这套样板逻辑收敛到一个 hook,
 * 让 caller (页面 / ImageGenerationPanel) 只关心:
 *   "调哪个 target + 用什么 prompt + 拿到结果做什么"
 *
 * ── 模式 (Wave 4-B 增加) ────────────────────────────────────────────
 *  - mode: "sync"  (默认 — ElementWorkbench / 小任务用)
 *      调统一 endpoint /api/v2/generate/image, 等结果返回 → onSuccess.
 *  - mode: "async" (主流量 ShotStagePage 用)
 *      调 scoped endpoint /api/v2/series/.../shots/.../stage/firstframe/generate,
 *      立即返 task_id 列表 → 写 tasksStore queued → SSE buildTaskEventHandlers
 *      自动接管 task.* 事件 → 完成时拉新 shot detail 透传给 caller.
 *
 *      async 模式仅支持 target.kind = shot_first_frame / shot_last_frame; 其他 kind
 *      throw error (本来就是 thin sync).
 *
 * ── Wave 4-D dry-run + confirm 下沉 (2026-05-16) ────────────────────
 *
 * trigger() 内部根据 confirmBatch 选项 + count >= 2 判断, 自动跑 dry-run + confirm.
 * Panel (ImageGenerationPanel) 自己做完整 dry-run + confirm UX 时传 confirmBatch=false
 * 避免 double-confirm.
 *
 * ── 2026-05-28 audit P2 refactor ────────────────────────────────────
 *   SSE 连接 / callback ref / dry-run confirm / async tasks ack / sync pseudo task
 *   样板全部抽到 generationHookHelpers.ts (跟 useVideoGeneration 共享).
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  generateImage,
  generateImageAsync,
  generateImageDryRun,
  type GenerateImageInput,
  type GenerateImageResult,
  type GenerateImageDryRunResult,
  type ImageGenerationTarget,
  type PersistedImage,
} from "../lib/generationApi";
import { labelOfSource, isKeylessImageProvider, resolveTaskFailureMessage } from "../lib/sourceLabels";
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

export type ImageGenerationMode = "sync" | "async";

export interface UseImageGenerationOptions {
  target: ImageGenerationTarget;
  mode?: ImageGenerationMode;
  onSuccess?: (result: GenerateImageResult) => void;
  onError?: (err: unknown) => void;
  displayName?: string;
  confirmBatch?: boolean;
  confirmFn?: (message: string) => Promise<boolean>;
  onGoSettings?: () => void;
}

export interface UseImageGenerationResult {
  trigger: (input: GenerateImageTriggerInput) => Promise<GenerateImageResult | null>;
  dryRun: (input: GenerateImageTriggerInput) => Promise<GenerateImageDryRunResult>;
  generating: boolean;
  estimating: boolean;
  awaiting: boolean;
  lastError: string | null;
  partialReceived: number;
  totalRequested: number;
}

export interface GenerateImageTriggerInput {
  prompt: string;
  negative_prompt?: string;
  model_ref?: string;
  count?: number;
  width?: number;
  height?: number;
  seed?: number;
  reference_images?: GenerateImageInput["reference_images"];
  i2i_base?: GenerateImageInput["i2i_base"];
  extra_tags?: string[];
  job_id?: string;
  task_id?: string;
  /**
   * 2026-07-22 Y5 (UP-4): 费用预估同源提示词兜底.
   * 首帧快速抽卡 prompt 传空字符串让后端 compiler 拼 (真实发送路径正确),
   * 但 dry-run 端点 Zod 校验 prompt.min(1) → 空提示词 400 "提示词不可为空",
   * 费用预估当场翻车. caller (ShotStagePage) 把已编译的预览提示词
   * (livePreview.composed_prompt, 与后端 compileShotImagePrompt 同源) 从此字段传入,
   * 仅当 prompt 为空时用于 dry-run 估价; 真实发送仍走 prompt(空)→后端 compiler, 行为不变.
   */
  dryRunPromptOverride?: string;
}

// ─── 实现 ───────────────────────────────────────────────────────────

export function useImageGeneration(options: UseImageGenerationOptions): UseImageGenerationResult {
  const {
    target,
    mode = "sync",
    onSuccess,
    onError,
    displayName,
    confirmBatch = true,
    confirmFn,
    onGoSettings,
  } = options;

  const [generating, setGenerating] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // 渐进式落盘 — SSE image.partial 累加, trigger 完成清零
  const [partialReceived, setPartialReceived] = useState(0);
  const [totalRequested, setTotalRequested] = useState(0);

  // callback refs (避免闭包陈旧 + 不触发 SSE 重连)
  const { onSuccessRef, onErrorRef, displayNameRef } = useCallbackRefs<GenerateImageResult>({
    onSuccess,
    onError,
    displayName,
  });

  // pendingTaskIdsRef — async 模式跟踪本次投放 task_id 集合
  const pendingTaskIdsRef = useRef<Set<string>>(new Set());

  // ── SSE 订阅 ────────────────────────────────────────────────────
  // sync 模式只接 image.partial(渐进式 skeleton 进度)
  // async 模式同时接 task.* — task.done 触发 handleSseTerminal 拉 shot detail
  const slug = target.series_slug;
  const epIdHint =
    typeof target.meta?.ep_id === "string" ? (target.meta.ep_id as string) : "";

  // image.partial 命中本 hook 的过滤条件: target_kind / series_slug / target_id 都对得上
  const imagePartialHandler = useCallback(
    (data: any) => {
      try {
        const payload = data?.data || data;
        if (!payload) return;
        if (payload.target_kind !== target.kind) return;
        if (payload.series_slug !== slug) return;
        if (target.kind !== "vault_only" && payload.target_id !== target.target_id) return;

        const completed = Number(payload.completed);
        const total = Number(payload.total);
        if (!Number.isFinite(completed) || completed <= 0) return;
        setPartialReceived((prev) =>
          Math.min(Math.max(prev, completed), total || prev + 1),
        );
      } catch {
        /* 解析失败忽略, partial 仅 UX 不阻塞主流程 */
      }
    },
    [target.kind, target.target_id, slug],
  );

  useGenerationSSE({
    enabled: Boolean(slug),
    seriesSlug: slug ?? "",
    targetId: target.target_id,
    epIdHint,
    expectedKind: "image",
    onTerminal: async (status) => {
      if (mode !== "async") return; // sync 模式不走 task.* 终态分支
      await handleSseTerminal(status);
    },
    extraEventHandlers: { "image.partial": imagePartialHandler },
  });

  /**
   * SSE task.done / task.failed 终态处理 — 拉新 shot detail, 透传 onSuccess / onError.
   */
  async function handleSseTerminal(status: TaskStatus) {
    // 任何终态都清空 skeleton — 真实图列表已经由 onSuccess 透传给 caller
    setTimeout(() => {
      setTotalRequested(0);
      setPartialReceived(0);
    }, 0);
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
            images: [],
            provider_id: "",
            target_state: undefined,
          });
          setAwaiting(false);
          return;
        }
        const shot = res as ShotDetail;
        const candidates = ((shot as unknown) as { first_frame_candidates?: unknown[] })
          ?.first_frame_candidates ?? [];
        const images: PersistedImage[] = Array.isArray(candidates)
          ? (candidates as Array<Partial<PersistedImage>>).map((c) => ({
              image_id: c.image_id ?? "",
              asset_id: c.asset_id,
              vault_id: c.vault_id,
              url: c.url ?? "",
              width: c.width,
              height: c.height,
              seed: c.seed,
              mime: c.mime ?? "image/png",
              provider_id: c.provider_id ?? "",
              prompt_snapshot: c.prompt_snapshot ?? "",
            }))
          : [];

        const label = displayNameRef.current ?? "分镜";
        toast.success(`「${label}」生成完成, 候选区已更新`);

        onSuccessRef.current?.({
          ok: true,
          images,
          provider_id: images[0]?.provider_id ?? "",
          target_state: shot,
        });
      } catch (err) {
        // audit P0 #8: catch 内调 onError 让 caller showError 提示刷新, 不 silent 假完成
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[useImageGeneration async] fetch shot detail after task.done failed:", msg);
        if (onErrorRef.current) {
          onErrorRef.current(new Error(`生成完成但刷新候选区失败 (${msg}), 请手动刷新页面看新候选`));
        } else {
          toast.warning(`生成完成但刷新候选区失败, 请刷新页面: ${msg}`);
        }
      } finally {
        setAwaiting(false);
      }
    } else if (status === "failed") {
      // 走 resolveTaskFailureMessage 统一拉真错误 + friendlyTaskError 翻译, 跟 useVideo 共享
      const { friendly, raw } = resolveTaskFailureMessage(
        target.target_id ?? "",
        "image",
        "首帧生成失败, 请稍后重试",
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
  // count >= 2 走 dry-run + confirm (key_missing 弹去设置, 否则费用 confirm).
  // helper runDryRunConfirm 收敛 key_missing / cost / 用户取消三态.
  const trigger = useCallback(
    async (input: GenerateImageTriggerInput): Promise<GenerateImageResult | null> => {
      setLastError(null);

      const count = input.count ?? 1;
      const needsConfirm = confirmBatch && count >= 2;

      if (needsConfirm) {
        // UP-4(b): 费用预估同源提示词 — prompt 为空 (首帧走后端 compiler) 时, dry-run
        // 改用 caller 传的已编译提示词兜底, 避免空提示词打到 Zod 400 让预估翻车.
        // 真实发送仍用原 input.prompt(空)→后端 compiler, 行为不变.
        const dryRunInput: GenerateImageTriggerInput =
          !input.prompt?.trim() && input.dryRunPromptOverride?.trim()
            ? { ...input, prompt: input.dryRunPromptOverride }
            : input;
        // UP-4: 免费/本地图像渠道兜底判定 (dry-run 失败拿不到 is_keyless 时用).
        const freeByModelRef = isKeylessImageProvider(input.model_ref);
        const outcome = await runDryRunConfirm<GenerateImageDryRunResult>({
          dryRun: () => dryRun(dryRunInput),
          confirmFn,
          onGoSettings,
          // UP-4: 免费渠道预估失败也不许出现"费用/扣费"恐吓, 只说"本地免费渠道 · 不计费".
          dryRunFailFallbackMessage: (e) =>
            freeByModelRef
              ? `本地免费渠道 · 不计费。\n仍要抽 ${count} 张吗?`
              : `费用预估失败 (${e instanceof Error ? e.message : String(e)})。\n仍要抽 ${count} 张吗?`,
          buildCostMessage: (dr) => {
            const providerLabel = labelOfSource(dr.provider_id);
            // UP-4: 免费口径以后端 dry-run 的 is_keyless 为权威 — 不计费渠道零"扣费"字样.
            if (dr.is_keyless) {
              return `将用 ${providerLabel} 为「${displayName ?? "素材"}」抽 ${count} 张。\n本地免费渠道 · 不计费。\n\n确认继续?`;
            }
            const costPart =
              dr.estimated_cost_cny != null
                ? `预估 ¥${dr.estimated_cost_cny.toFixed(4)}`
                : "预估费用未知";
            return `将用 ${providerLabel} 为「${displayName ?? "素材"}」抽 ${count} 张。\n${costPart} (${dr.estimated_cost_note})\n\n确认继续?`;
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
    [mode, target, confirmBatch, confirmFn, onGoSettings, displayName],
  );

  // ── sync 模式 ────────────────────────────────────────────────────
  async function triggerSync(input: GenerateImageTriggerInput): Promise<GenerateImageResult> {
    setGenerating(true);

    const count = Math.max(1, input.count ?? 1);
    setTotalRequested(count);
    setPartialReceived(0);

    const pseudoTaskId = makePseudoTaskId("image");
    const shotIdForTask =
      target.kind === "shot_first_frame" || target.kind === "shot_last_frame"
        ? target.target_id
        : undefined;
    const elementIdForTask =
      target.kind === "element" || target.kind === "character_ref" || target.kind === "scene_ref"
        ? target.target_id
        : undefined;
    const epId = epIdHint || undefined;
    const etaSec = Math.max(15, count * 12);

    upsertLocalSyncTask({
      pseudoTaskId,
      kind: "image",
      status: "queued",
      seriesSlug: target.series_slug,
      epId,
      shotId: shotIdForTask,
      elementId: elementIdForTask,
      etaSec,
    });

    try {
      const result = await generateImage(buildInput(target, input));

      upsertLocalSyncTask({
        pseudoTaskId,
        kind: "image",
        status: "succeeded",
        seriesSlug: target.series_slug,
        epId,
        shotId: shotIdForTask,
        elementId: elementIdForTask,
        progress: 100,
      });

      // toC 友好 toast — 永不暴露 provider_id, 走 labelOfSource (铁律 #9)
      const label = displayNameRef.current ?? "素材";
      const providerLabel = labelOfSource(result.provider_id);
      const n = result.images.length;
      toast.success(
        n === 1
          ? `「${label}」已生成 1 张, 累加进图库 (${providerLabel})`
          : `「${label}」已生成 ${n} 张, 累加进图库 (${providerLabel})`,
      );

      onSuccessRef.current?.(result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);

      upsertLocalSyncTask({
        pseudoTaskId,
        kind: "image",
        status: "failed",
        seriesSlug: target.series_slug,
        epId,
        shotId: shotIdForTask,
        elementId: elementIdForTask,
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
      // 渐进式落盘清零, 让 skeleton 消失
      setTimeout(() => {
        setTotalRequested(0);
        setPartialReceived(0);
      }, 0);
    }
  }

  // ── async 模式 ──────────────────────────────────────────────────
  async function triggerAsync(input: GenerateImageTriggerInput): Promise<GenerateImageResult> {
    if (target.kind !== "shot_first_frame" && target.kind !== "shot_last_frame") {
      const err = new Error(
        `async 模式仅支持 shot_first_frame / shot_last_frame, 不支持 "${target.kind}"`,
      );
      if (onErrorRef.current) {
        onErrorRef.current(err);
      } else {
        toast.error(err.message);
      }
      throw err;
    }

    setGenerating(true);
    setAwaiting(true);

    const count = Math.max(1, input.count ?? 1);
    setTotalRequested(count);
    setPartialReceived(0);

    try {
      const ack = await generateImageAsync(buildInput(target, input));

      try {
        registerAsyncTasksAck({
          ack,
          kind: "image",
          seriesSlug: target.series_slug,
          epId: epIdHint || undefined,
          etaSec: Math.max(15, count * 8),
          skippedLimitMessage:
            "这一镜已达抽卡次数上限,请先清理废案或调高 max_retake_per_shot",
          noTaskMessage: "后端未能创建生成任务, 请检查模型配置",
          pendingTaskIdsRef,
        });
      } catch (helperErr) {
        // helper 把 skipped_limit / 0-task throw — 这里翻成 toast + onError
        const msg = helperErr instanceof Error ? helperErr.message : String(helperErr);
        setGenerating(false);
        setAwaiting(false);
        toast.error(msg);
        if (onErrorRef.current) onErrorRef.current(new Error(msg));
        throw helperErr;
      }

      // 立即返"已入队"占位 — 真结果靠 SSE → handleSseTerminal → onSuccess
      setGenerating(false);
      const ackResult: GenerateImageResult = {
        ok: true,
        images: [],
        provider_id: "",
        target_state: undefined,
      };
      return ackResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setGenerating(false);
      setAwaiting(false);
      setTimeout(() => {
        setTotalRequested(0);
        setPartialReceived(0);
      }, 0);
      if (onErrorRef.current) {
        onErrorRef.current(err);
      } else {
        toast.error(`生成失败: ${msg}`);
      }
      throw err;
    }
  }

  const dryRun = useCallback(
    async (input: GenerateImageTriggerInput): Promise<GenerateImageDryRunResult> => {
      setEstimating(true);
      try {
        return await generateImageDryRun(buildInput(target, input));
      } finally {
        setEstimating(false);
      }
    },
    [target],
  );

  return {
    trigger,
    dryRun,
    generating,
    estimating,
    awaiting,
    lastError,
    partialReceived,
    totalRequested,
  };
}

// ─── helper: 合并 target + input ─────────────────────────────────────

function buildInput(target: ImageGenerationTarget, input: GenerateImageTriggerInput): GenerateImageInput {
  return {
    target,
    prompt: input.prompt,
    negative_prompt: input.negative_prompt,
    model_ref: input.model_ref,
    count: input.count,
    width: input.width,
    height: input.height,
    seed: input.seed,
    reference_images: input.reference_images,
    i2i_base: input.i2i_base,
    extra_tags: input.extra_tags,
    job_id: input.job_id,
    task_id: input.task_id,
  };
}
