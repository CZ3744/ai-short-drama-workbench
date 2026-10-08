/**
 * generationHookHelpers.ts — useImage/useVideo 共用样板抽离 (2026-05-28 audit P2).
 *
 * 出发点 (用户反馈 feedback_decoupling.md):
 *   "看到两份相似实现必须合并". useImageGeneration / useVideoGeneration 两 hook
 *   各 ~700 行, 但里面 60% 是同款 SSE 订阅 / dry-run 确认 / 异步入队上报 / 失败拉
 *   tasksStore + friendlyTaskError 的样板. 改一份漏改另一份是常态(用户原话:
 *   "视频侧改了图像侧没改, 截图就出现首帧失败 + HTML 502 body").
 *
 * 这里抽 5 个 helper, 5 个 hook 中只有 useImage/useVideo 共享 (3 个用法差异太大,
 * 见底部 "为什么不抽 X" 说明):
 *   1. useCallbackRefs           — onSuccess / onError / displayName useRef 同步
 *   2. useGenerationSSE          — createSSEClient + buildTaskEventHandlers + ep_id deps
 *   3. useDryRunConfirm          — key_missing / cost / 真实锁 / 降级机会 流程
 *   4. registerAsyncTasksAck     — ack.tasks 过滤 skipped_limit + skipped_mentions toast
 *                                    + registerTasksFromResponse + pendingTaskIdsRef 写入
 *   5. upsertLocalSyncTask       — sync 模式 queued/succeeded/failed 三次 upsertTask 包装
 *
 * 不影响 caller 接口 — useImage / useVideo 的 return shape 完全不变.
 *
 * ── 为什么不抽 X ────────────────────────────────────────────────────
 *  - useCompose:  用原生 EventSource (不用 createSSEClient), 监听 compose.stage /
 *                 compose.progress / compose.done / compose.error 4 个命名事件,
 *                 还要 SSE → 30s 兜底轮询的回退路径, 跟 task.* 模型不兼容.
 *                 抽出来反而要硬塞一个"两种连接模式"参数, 收益负.
 *  - useExport:   不开 SSE, 单次 fetch + AbortController + 200ms 计时器, 跟生成流
 *                 程结构完全不同.
 *  - useAutoPipeline: SSE 用 createSSEClient 但事件是 pipeline.stage.* / pipeline.done
 *                    / pipeline.failed / pipeline.aborted, 跟 task.* 维度不同. 它的
 *                    "pipeline_id 维度" 跟 useImage 的 "shot_id + kind 维度" 也不兼容.
 *                    抽出 useGenerationSSE 套不上, 它的 stage reducer 是自家专属逻辑.
 */

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  createSSEClient,
  buildTaskEventHandlers,
} from "../lib/sse";
import { labelOfSource } from "../lib/sourceLabels";
import { useTasksStore, type TaskKind, type TaskStatus } from "../stores/tasksStore";
import type { AsyncGenerationAck } from "../lib/generationApi";

// ──────────────────────────────────────────────────────────────────
// 1. useCallbackRefs — onSuccess/onError/displayName useRef 同步
//
// useImage/useVideo 都用 ref 拿最新 callback 避免闭包陈旧 (SSE 回调里 await 后
// callback 已经变了的场景). 三行模板抽一处:
//
//   const refs = useCallbackRefs({ onSuccess, onError, displayName });
//   refs.onSuccessRef.current?.(...);
// ──────────────────────────────────────────────────────────────────

export interface CallbackRefsInput<TSuccess> {
  onSuccess?: (result: TSuccess) => void;
  onError?: (err: unknown) => void;
  displayName?: string;
}

export interface CallbackRefs<TSuccess> {
  onSuccessRef: React.MutableRefObject<((result: TSuccess) => void) | undefined>;
  onErrorRef: React.MutableRefObject<((err: unknown) => void) | undefined>;
  displayNameRef: React.MutableRefObject<string | undefined>;
}

export function useCallbackRefs<TSuccess>(
  input: CallbackRefsInput<TSuccess>,
): CallbackRefs<TSuccess> {
  const onSuccessRef = useRef(input.onSuccess);
  const onErrorRef = useRef(input.onError);
  const displayNameRef = useRef(input.displayName);
  useEffect(() => {
    onSuccessRef.current = input.onSuccess;
  }, [input.onSuccess]);
  useEffect(() => {
    onErrorRef.current = input.onError;
  }, [input.onError]);
  useEffect(() => {
    displayNameRef.current = input.displayName;
  }, [input.displayName]);
  return { onSuccessRef, onErrorRef, displayNameRef };
}

// ──────────────────────────────────────────────────────────────────
// 2. useGenerationSSE — async 模式 SSE 订阅 + task.* handler 工厂
//
// useImage/useVideo 都在 useEffect 内根据 (mode==="async", series_slug, target.kind,
// target.target_id, target.meta.ep_id 字符串) 重连 SSE. task.* 事件命中
// (kind === expectedKind, shotId === target.target_id) 时调 onTerminal.
//
// 调用方式:
//   useGenerationSSE({
//     enabled: mode === "async",
//     seriesSlug: target.series_slug,
//     targetId: target.target_id,
//     epIdHint: typeof target.meta?.ep_id === "string" ? target.meta.ep_id : "",
//     expectedKind: "image",
//     onTerminal: async (status) => { ... },
//     extraEventHandlers: { "image.partial": handler },  // sync 模式 image partial
//   });
//
// ep_id 走"字符串 deps"避免整个 target.meta object 引用变化触发重连风暴
// (2026-05-28 P1#19 教训).
// ──────────────────────────────────────────────────────────────────

export interface UseGenerationSSEOptions {
  /** false → 不开 SSE (sync 模式不订阅 task.*, 但仍可订阅 extraEventHandlers) */
  enabled: boolean;
  seriesSlug: string;
  /** target.target_id — 用于命中过滤. 空字符串 / undefined 表示"不过滤" */
  targetId?: string;
  /**
   * target.meta.ep_id 转成字符串后传入 (避免传 object 触发 deps 风暴).
   * 2026-05-28 P1#19: 用户切分集时 SSE handler 闭包指着老 ep_id, handleSseTerminal
   * 拉错分集 detail. 这里作 deps 让 ep_id 变化时重建 SSE.
   */
  epIdHint: string;
  /** image / video — 只在命中此 kind 时调 onTerminal */
  expectedKind: TaskKind;
  /** task.* 走到终态时调 (succeeded / failed). 由 caller 决定拉 shot detail / 翻 friendly error. */
  onTerminal?: (status: TaskStatus) => Promise<void>;
  /**
   * 额外的命名 SSE 事件 handler (例: useImage sync 模式订阅 image.partial 推渐进 skeleton).
   * 这里把 handler **引用** 用 ref 留住, useEffect deps 不含, 不触发重连.
   * 同样的事件类型集合在 useEffect 入口时锁定一次.
   */
  extraEventHandlers?: Record<string, (data: any) => void>;
}

export function useGenerationSSE(options: UseGenerationSSEOptions): void {
  const {
    enabled,
    seriesSlug,
    targetId,
    epIdHint,
    expectedKind,
    onTerminal,
    extraEventHandlers,
  } = options;

  // 用 ref 持锁回调, 避免闭包陈旧 + 触发重连
  const onTerminalRef = useRef(onTerminal);
  const extraHandlersRef = useRef(extraEventHandlers);
  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);
  useEffect(() => {
    extraHandlersRef.current = extraEventHandlers;
  }, [extraEventHandlers]);

  // 锁定 event type 集合 — 只在 mount/重连时 register 一次 (createSSEClient 内部约定)
  // 这里在 deps 中加 extra event 类型组合, 让新 event type 加入时重建.
  const extraEventTypesKey = extraEventHandlers
    ? Object.keys(extraEventHandlers).sort().join(",")
    : "";

  useEffect(() => {
    if (!enabled || !seriesSlug) return;

    const onEvent: Record<string, (data: any) => void> = {
      // task.* — 走 buildTaskEventHandlers 自动同步 tasksStore, 命中本 target 时调 onTerminal
      ...buildTaskEventHandlers(seriesSlug, async (shotId, kind, status) => {
        if (kind !== expectedKind) return;
        if (targetId && shotId !== targetId) return;
        await onTerminalRef.current?.(status);
      }),
    };

    // 额外 handler — 从 ref 取最新引用, 避免闭包陈旧
    if (extraHandlersRef.current) {
      for (const evtType of Object.keys(extraHandlersRef.current)) {
        onEvent[evtType] = (data: any) => {
          extraHandlersRef.current?.[evtType]?.(data);
        };
      }
    }

    const client = createSSEClient({
      seriesSlug,
      onEvent,
    });
    return () => {
      client.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, seriesSlug, targetId, epIdHint, expectedKind, extraEventTypesKey]);
}

// ──────────────────────────────────────────────────────────────────
// 3. useDryRunConfirm — dry-run + confirm 流程
//
// useImage(count>=2) 和 useVideo(real provider) 都走"调 dryRun → key_missing
// 提示 → 费用 confirm → 用户取消返 null"流程. 区别仅在:
//   - useImage: 看 count >= 2 触发
//   - useVideo: 看 isRealVideoProvider(model_ref) 触发, 多一个 real_lock_held_by 拒
//
// 把"defaultConfirmFn = 永真 / defaultGoSettings = window.location.assign /
// 调 dryRun 报错的降级机会 / key_missing 弹去设置 / 用户取消返 null"统一抽出.
// caller 自己在 build message 时拼业务字段 (锁信息 / 张数等).
// ──────────────────────────────────────────────────────────────────

export const defaultConfirmFn: (msg: string) => Promise<boolean> = (_msg) =>
  Promise.resolve(true);

export const defaultGoSettings = (): void => {
  if (typeof window !== "undefined") {
    window.location.assign("/settings");
  }
};

export interface DryRunOutcomeKeyMissing {
  kind: "key_missing";
  provider_id: string;
  message?: string;
}

export interface DryRunOutcomeOk<T> {
  kind: "ok";
  result: T;
}

/**
 * 通用 dry-run 结果约束 — useImage/useVideo 的 DryRunResult 共享字段子集.
 * 用 interface 而非 import 真实类型, 避免 helper 耦合具体 GenerateXxxDryRunResult.
 */
export interface DryRunResultLike {
  provider_id: string;
  estimated_cost_cny?: number | null;
  estimated_cost_note?: string;
  message?: string;
  error?: "key_missing";
}

export interface RunDryRunOptions<TDryRunResult extends DryRunResultLike> {
  /** 真实跑 dry-run 的函数 — caller 注入 (调 hook 的 dryRun) */
  dryRun: () => Promise<TDryRunResult>;
  /** caller 的 confirm UI, undefined 走 defaultConfirmFn (放行) */
  confirmFn: ((message: string) => Promise<boolean>) | undefined;
  /** caller 的 "去设置页" 跳转, undefined 走 defaultGoSettings */
  onGoSettings: (() => void) | undefined;
  /** dry-run 失败时的降级问询消息 (caller 拼成业务上下文) */
  dryRunFailFallbackMessage: (err: unknown) => string;
  /**
   * 拿到 dry-run 成功结果时, caller 决定 confirm 文案 + 提前拒 (例如真实视频锁被占).
   * 返回 null = 继续走默认 confirm(走 buildCostMessage 拼); undefined = 显式跳过 confirm;
   * Promise<string> = 用此消息走 confirm; Promise<false> = 拒(返 outcome=cancelled).
   */
  preflight?: (result: TDryRunResult) => Promise<string | null | false | undefined>;
  /** 默认 confirm 文案构造器 — caller 拼业务上下文(几张 / 时长 / provider 等). */
  buildCostMessage: (result: TDryRunResult) => string;
}

export type RunDryRunOutcome = "ok" | "cancelled";

/**
 * 跑 dry-run + confirm 流程, 返回:
 *  - "ok" = 用户确认, caller 进入真实 trigger
 *  - "cancelled" = key_missing / 锁被占 / 用户取消 / dry-run 失败用户也不继续
 */
export async function runDryRunConfirm<TDryRunResult extends DryRunResultLike>(
  opts: RunDryRunOptions<TDryRunResult>,
): Promise<RunDryRunOutcome> {
  const ask = opts.confirmFn ?? defaultConfirmFn;
  const goSettings = opts.onGoSettings ?? defaultGoSettings;

  let dr: TDryRunResult | null = null;
  try {
    dr = await opts.dryRun();
  } catch (e) {
    // dry-run 报错不致命 — 给 caller 一次降级机会
    const ok = await ask(opts.dryRunFailFallbackMessage(e));
    return ok ? "ok" : "cancelled";
  }

  if (dr) {
    // Key 缺失 — 弹去设置
    if (dr.error === "key_missing") {
      const wantSettings = await ask(
        `${dr.message ?? `${labelOfSource(dr.provider_id)} 还没填 Key`}\n现在去设置页配置吗?`,
      );
      if (wantSettings) goSettings();
      return "cancelled";
    }

    // 让 caller 做前置检查 (例如 video 的 real_lock_held_by 拒)
    if (opts.preflight) {
      const pre = await opts.preflight(dr);
      if (pre === false) return "cancelled";
      if (pre === undefined) return "ok"; // caller 显式跳过 confirm
      const message = pre ?? opts.buildCostMessage(dr);
      const ok = await ask(message);
      return ok ? "ok" : "cancelled";
    }

    // 默认 confirm
    const ok = await ask(opts.buildCostMessage(dr));
    return ok ? "ok" : "cancelled";
  }

  return "ok";
}

// ──────────────────────────────────────────────────────────────────
// 4. registerAsyncTasksAck — ack.tasks 过滤 + skipped_mentions toast +
//                              registerTasksFromResponse + pendingTaskIdsRef 写入
//
// useImage/useVideo async 模式调完 generateImageAsync / generateVideoAsync 后做同款
// 5 步:
//   1. filter status==="skipped_limit" 过滤掉(限流跳过). 全部都被限流 → throw.
//   2. 调 registerTasksFromResponse 写 tasksStore.
//   3. 检查 skipped_mentions 非空 → toast.warning 列出来.
//   4. pendingTaskIdsRef = Set(realTasks.map(t => t.task_id))
//   5. 返 realTasks (caller 视情况决定 setGenerating(false) / 返 ack result).
//
// 这里抽出 1-4, 第 5 步由 caller 控制 setState 时机.
// ──────────────────────────────────────────────────────────────────

export interface RegisterAsyncTasksAckOptions {
  ack: AsyncGenerationAck;
  kind: TaskKind;
  seriesSlug: string;
  /** target.meta.ep_id 转成字符串 / undefined */
  epId?: string;
  /** caller 拼好的 eta (image: count*8, video: duration_sec*8+30) */
  etaSec: number;
  /**
   * skipped_limit 时给 caller 自己 throw 的中文消息(image:"抽卡次数上限" / video:"视频抽卡上限").
   * 全部任务都被 skipped_limit 时, 这里 throw 中文消息让 caller 接住.
   */
  skippedLimitMessage: string;
  /** 后端 0 task 创建时的兜底消息 */
  noTaskMessage?: string;
  /** 写入 pendingTaskIdsRef.current = Set(...) */
  pendingTaskIdsRef: React.MutableRefObject<Set<string>>;
}

export interface RegisterAsyncTasksAckResult {
  /** 过滤后真正入队的 tasks. caller 透传 result.tasks 长度做后续 UX. */
  realTasks: AsyncGenerationAck["tasks"];
}

/**
 * @throws Error("skipped_limit") — caller 应 try/catch 调 onError + toast
 * @throws Error(noTaskMessage)  — 后端 0 task 创建
 */
export function registerAsyncTasksAck(
  opts: RegisterAsyncTasksAckOptions,
): RegisterAsyncTasksAckResult {
  const { ack, kind, seriesSlug, epId, etaSec, skippedLimitMessage, noTaskMessage, pendingTaskIdsRef } = opts;
  const store = useTasksStore.getState();

  const realTasks = ack.tasks.filter((t) => t.status !== "skipped_limit");
  const skippedByLimit = ack.tasks.some((t) => t.status === "skipped_limit");

  if (realTasks.length === 0) {
    if (skippedByLimit) {
      const err = new Error(skippedLimitMessage);
      (err as Error & { code?: string }).code = "skipped_limit";
      throw err;
    }
    throw new Error(noTaskMessage ?? "后端未能创建生成任务, 请检查模型配置");
  }

  store.registerTasksFromResponse(realTasks, {
    kind,
    series_slug: seriesSlug,
    ep_id: epId,
    eta_s: etaSec,
    attempt_id: ack.attempt_id,
    job_id: ack.job_id,
  });

  // @ mention 找不到 → toast.warning 列出来
  if (ack.skipped_mentions && ack.skipped_mentions.length > 0) {
    const KIND_LABEL: Record<string, string> = {
      character: "角色",
      scene: "场景",
      element: "素材",
    };
    const items = ack.skipped_mentions
      .map((s) => `@${KIND_LABEL[s.kind] ?? "素材"}:${s.name} (${s.reason})`)
      .join("\n");
    toast.warning(
      `${ack.skipped_mentions.length} 个 @ 引用没找到, 生成时未注入参考图`,
      {
        description: items,
        duration: 8000,
      },
    );
  }

  pendingTaskIdsRef.current = new Set(realTasks.map((t) => t.task_id));
  return { realTasks };
}

// ──────────────────────────────────────────────────────────────────
// 5. upsertLocalSyncTask — sync 模式三态 upsertTask 包装
//
// useImage/useVideo sync 模式在 trigger 开始/成功/失败时 upsertTask 三次, 给
// GlobalQueuePanel / 主队列推 task 状态. 每次都构造 record + try/catch (store 异常
// 不阻塞主流程). 抽个 helper 让 caller 一行调.
//
// 注意: pseudoTaskId 由 caller 在 trigger 开始时生成并保存(用 useRef), 让 succ/fail
// 时能用同一个 id 更新同一条记录. helper 不持锁.
// ──────────────────────────────────────────────────────────────────

export interface LocalSyncTaskInput {
  pseudoTaskId: string;
  kind: TaskKind;
  status: TaskStatus;
  seriesSlug: string;
  epId?: string;
  shotId?: string;
  elementId?: string;
  etaSec?: number;
  progress?: number;
  errorMessage?: string;
}

export function upsertLocalSyncTask(input: LocalSyncTaskInput): void {
  try {
    useTasksStore.getState().upsertTask({
      task_id: input.pseudoTaskId,
      kind: input.kind,
      status: input.status,
      shot_id: input.shotId,
      element_id: input.elementId,
      series_slug: input.seriesSlug,
      ep_id: input.epId,
      progress: input.progress ?? (input.status === "succeeded" ? 100 : 0),
      started_at: Date.now(),
      eta_s: input.etaSec,
      error_message: input.errorMessage,
    });
  } catch {
    /* noop — store 异常不阻塞主流程 */
  }
}

/**
 * makePseudoTaskId — 生成 sync 模式占位 task_id, 给 GlobalQueuePanel 显示用.
 * caller 在 trigger 开头调一次, 用 useRef 留住, succ/fail/finally 都用同一个 id.
 */
export function makePseudoTaskId(prefix: "image" | "video"): string {
  return `local-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
