/**
 * SSE 客户端 — /events?job_id=... 或 /events?series_slug=...
 * 自动重连 + 指数退避(5s 上限)。
 *
 * 支持命名 SSE 事件:
 *   event: progress → onProgress(data)
 *   event: done     → onDone(data)
 *   event: error    → onSseError(data)  (服务端发送的业务错误)
 *
 * W6-A (2026-05-15): 新增 buildTaskEventHandlers — 一键把 task.queued / task.running /
 *   task.done / task.failed 接进 tasksStore.tasks Map(task 维度精确状态)。后端在
 *   apps/server/src/jobs/orchestrator.ts 已经 emit 这 4 个命名事件,W6-A 之前没人订
 *   阅, 这里补齐让 ShotStagePage 的抽卡按钮能拿到精确状态。
 */

import { useTasksStore, type TaskKind, type TaskStatus } from "../stores/tasksStore";

export interface SSEOptions {
  /** job 级别 SSE */
  jobId?: string;
  /** 系列级别 SSE */
  seriesSlug?: string;
  /** 未命名事件(无 event: 字段)的通用回调 */
  onMessage?: (data: any) => void;
  /** 命名 SSE 事件: event: progress */
  onProgress?: (data: any) => void;
  /** 命名 SSE 事件: event: done */
  onDone?: (data: any) => void;
  /** 命名 SSE 事件: event: error (服务端业务错误, 非连接错误) */
  onSseError?: (data: any) => void;
  /** 连接错误回调(EventSource 自身断线) */
  onError?: (error: Event) => void;
  onOpen?: () => void;
  onClose?: () => void;
  autoReconnect?: boolean;
  /** 初始重连间隔(ms)，指数退避上限 5000ms */
  reconnectInterval?: number;
  /**
   * 任意命名 SSE 事件回调 Map。
   * key = SSE event type (如 "task.done", "task.failed", "shot.updated")
   * value = 回调函数，收到序列化后的 data JSON
   */
  onEvent?: Record<string, (data: any) => void>;
}

/** 从 MessageEvent 安全解析 JSON data */
function parseMessageData(event: MessageEvent): any {
  try {
    return JSON.parse(event.data);
  } catch {
    return event.data;
  }
}

export function createSSEClient(options: SSEOptions) {
  const {
    jobId,
    seriesSlug,
    autoReconnect = true,
    reconnectInterval = 1000,
  } = options;

  // 2026-05-28 P1#18: callback ref 化 —
  // 之前所有 callback 在 createSSEClient 入口被 destructure 当 const, connect()
  // 闭包捕获. forceReconnect 调 connect() 重新 register handler 时, 闭包仍指向
  // 第一次创建时的 callback 引用. 若 caller 把 onMessage / onEvent 等放在
  // useEffect 内 (deps 故意不全, 避免重连风暴), 重连后会用陈旧 callback.
  // 改用 cbRef: connect() 内每个 handler 都 read cbRef.current.onXxx, 拿最新.
  const cbRef: { current: SSEOptions } = { current: options };

  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let retryCount = 0;
  /** C2: Track last event id for reconnection replay */
  let lastEventId: string | undefined;

  /** Helper: track lastEventId from a MessageEvent, then invoke handler */
  function trackAndCall<T>(handler: (data: T) => void, event: MessageEvent): void {
    if (event.lastEventId) lastEventId = event.lastEventId;
    if (event.data !== undefined) handler(parseMessageData(event));
  }

  function connect() {
    if (disposed) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    eventSource?.close();

    let url: string;
    if (seriesSlug) {
      url = `/api/v2/events?series_slug=${encodeURIComponent(seriesSlug)}`;
    } else if (jobId) {
      url = `/api/v2/events?job_id=${encodeURIComponent(jobId)}`;
    } else {
      url = "/api/v2/events";
    }

    // C2: Append lastEventId so broker can replay missed events on reconnect
    if (lastEventId) {
      url += (url.includes("?") ? "&" : "?") + `lastEventId=${encodeURIComponent(lastEventId)}`;
    }

    eventSource = new EventSource(url);

    eventSource.onopen = () => {
      retryCount = 0; // 连接成功重置退避
      cbRef.current.onOpen?.();
    };

    // ── 未命名事件(无 event: 字段) ──
    eventSource.onmessage = (event) => {
      if (event.lastEventId) lastEventId = event.lastEventId;
      cbRef.current.onMessage?.(parseMessageData(event));
    };

    // ── 命名事件: progress ──
    // P1#18: 不再用 connect 时刻的 onProgress 引用 check — 直接 always register,
    // 内部从 cbRef.current 拿. 若 caller 没传, ?. 短路无副作用.
    eventSource.addEventListener("progress", (event: Event) => {
      const me = event as MessageEvent;
      const handler = cbRef.current.onProgress;
      if (handler) trackAndCall(handler, me);
      else if (me.lastEventId) lastEventId = me.lastEventId;
    });

    // ── 命名事件: done ──
    eventSource.addEventListener("done", (event: Event) => {
      const me = event as MessageEvent;
      const handler = cbRef.current.onDone;
      if (handler) trackAndCall(handler, me);
      else if (me.lastEventId) lastEventId = me.lastEventId;
    });

    // ── 通用命名事件回调(P60 3F: 支持 task.done / task.failed / shot.updated 等) ──
    // P1#18: 用 connect 时刻的 onEvent 决定要 register 哪些 event type (类型集合
    // 在 createSSEClient 调用时就固定), 但每个 handler 的实际函数走 cbRef.current
    // 拿最新. 兼容 caller 用 useEffect 闭包的场景.
    const onEventTypes = Object.keys(options.onEvent ?? {});
    for (const eventType of onEventTypes) {
      eventSource.addEventListener(eventType, (event: Event) => {
        const me = event as MessageEvent;
        const handler = cbRef.current.onEvent?.[eventType];
        if (handler) trackAndCall(handler, me);
        else if (me.lastEventId) lastEventId = me.lastEventId;
      });
    }

    // ── 连接错误 + 服务端 event: error 共用 "error" 事件名 ──
    // EventSource 的 "error" 事件在两种情况下触发:
    //   1. 服务端发送 event: error (MessageEvent, 有 .data)
    //   2. 连接断开/网络故障 (Event, 无 .data)
    eventSource.addEventListener("error", (event: Event) => {
      if ("data" in event && (event as MessageEvent).data) {
        // 服务端发送的业务错误事件
        const me = event as MessageEvent;
        if (me.lastEventId) lastEventId = me.lastEventId;
        cbRef.current.onSseError?.(parseMessageData(me));
      } else {
        // 连接错误 — 自动重连
        cbRef.current.onError?.(event);
        eventSource?.close();

        if (autoReconnect && !disposed) {
          // 指数退避: 1s → 2s → 4s → 5s(上限)
          const delay = Math.min(reconnectInterval * Math.pow(2, retryCount), 5000);
          retryCount++;
          reconnectTimer = setTimeout(connect, delay);
        }
      }
    });
  }

  connect();

  // 2026-05-17 增强自动重连(纯浏览器事件,0 终端 / 0 进程 / 0 后端改动):
  //   - visibilitychange (切回 tab) → 强制重连
  //   - online (网络恢复) → 强制重连
  // 场景:backend 热重载 / 用户切 tab 数分钟 / 网络抖动后, SSE socket 可能 stale 或被服务端 close,
  // 浏览器原生 EventSource 不会自动重连(只在传输层错误时触发 onerror)。
  // 切回 tab + 网络恢复时主动 reconnect 让用户少 Ctrl+F5.
  function forceReconnect() {
    if (disposed) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    retryCount = 0;
    eventSource?.close();
    eventSource = null;
    connect();
  }
  function onVisibilityChange() {
    if (!disposed && document.visibilityState === "visible") {
      // 切回前台:check 当前 EventSource readyState, 0/2 表示连接已断,需要重连
      // (1 = OPEN, 0 = CONNECTING, 2 = CLOSED)
      if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
        forceReconnect();
      }
    }
  }
  function onOnline() {
    if (!disposed) forceReconnect();
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }

  return {
    dispose() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      eventSource?.close();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
      cbRef.current.onClose?.();
    },
    reconnect() {
      eventSource?.close();
      retryCount = 0;
      connect();
    },
    /**
     * 2026-05-28 P1#18: 让 caller 在 useEffect deps 不重连情况下能更新 callback.
     * 例如 useImageGeneration onSuccess 引用每次 render 变化, useEffect deps 故意
     * 不含它 (避免重连风暴). 改用 client.updateCallbacks({ onSuccess: latestFn }).
     */
    updateCallbacks(patch: Partial<SSEOptions>) {
      cbRef.current = { ...cbRef.current, ...patch };
    },
  };
}

// ──────────────────────────────────────────────────────────────
// W6-A · buildTaskEventHandlers
// ──────────────────────────────────────────────────────────────
// 后端 task.* 事件的 payload 大致形状(契约见 packages/contracts/src/events/sse.ts):
//   task.queued  { type, job_id, task_id, data: { shot_id, action } , at }
//   task.running { type, job_id, task_id, data: { shot_id?, ... }, at }
//   task.done    { type, job_id, task_id, data: { shot_id, generation }, at }
//   task.failed  { type, job_id, task_id, data: { shot_id?, error?, cancel_result? }, at }
//
// action ∈ generate_first_frames | generate_videos | (其他元素 / TTS / LLM)
// 由 action 推断 TaskKind。

function inferKindFromAction(action: string | undefined): TaskKind | undefined {
  switch (action) {
    case "generate_first_frames":
    case "generate_first_frame":
    case "image":
      return "image";
    case "generate_videos":
    case "generate_video":
    case "video":
      return "video";
    case "tts":
      return "tts";
    case "llm":
    case "expand_script":
    case "plan_storyboard":
      return "llm";
    case "compose":
      return "compose";
    default:
      // 2026-05-28 P0#7: 不再 silent fallback "image" — 错误归类把 video 任务存进 image
      // 索引, 上层 hook (useVideoGeneration) 永远 stuck running. 返 undefined +
      // console.warn, caller 拿 undefined 时跳过 upsertTask (不新建记录).
      console.warn("[sse.inferKindFromAction] unknown action; cannot infer task kind:", action);
      return undefined;
  }
}

/** 给 createSSEClient.onEvent 用的 task.* 事件 handler 工厂。
 *  示例:
 *    createSSEClient({
 *      seriesSlug: slug,
 *      onEvent: { ...buildTaskEventHandlers(slug), ...其他 handler },
 *    });
 */
export function buildTaskEventHandlers(
  seriesSlug?: string,
  onShotChange?: (shotId: string, kind: TaskKind, status: TaskStatus) => void,
): Record<string, (data: any) => void> {
  function applyUpdate(data: any, status: TaskStatus, errorMessage?: string) {
    const store = useTasksStore.getState();
    const taskId = data?.task_id || data?.id;
    if (!taskId) return;
    const inner = data?.data || {};
    const shotId: string | undefined = inner.shot_id || data?.shot_id;
    const action: string | undefined = inner.action || data?.action;
    // 已有的记录优先,没有则新建
    const existing = store.tasks[taskId];
    const inferredKind = inferKindFromAction(action);
    const kind: TaskKind | undefined = existing?.kind ?? inferredKind;
    // 2026-05-28 P0#7: kind 推断失败 + 没有已存记录 → 不能新建 task record.
    // 旧代码 fallback "image" 会把 video task 误存进 image 索引, ShotStagePage
    // 视频区永远 spinner. 显式跳过 + console.warn 让问题暴露.
    if (!kind) {
      console.warn("[sse.applyUpdate] skip upsert — task kind unknown & no existing record:", { taskId, action, status });
      return;
    }
    const record = {
      task_id: taskId,
      kind,
      status,
      shot_id: shotId ?? existing?.shot_id,
      element_id: existing?.element_id,
      series_slug: inner.series_slug ?? data?.series_slug ?? existing?.series_slug,
      ep_id: inner.episode_id ?? data?.episode_id ?? existing?.ep_id,
      progress: status === "succeeded" ? 100 : status === "running" ? Math.max(existing?.progress ?? 10, 10) : existing?.progress ?? 0,
      started_at: existing?.started_at ?? Date.now(),
      eta_s: existing?.eta_s,
      error_message: status === "failed" ? (errorMessage || existing?.error_message || "任务失败") : existing?.error_message,
      attempt_id: existing?.attempt_id,
      job_id: data?.job_id ?? existing?.job_id,
    };
    store.upsertTask(record);
    if (shotId) {
      // 标记 dirty 让 SWR mutate refresh 候选区
      store.markShotDirty(shotId);
      onShotChange?.(shotId, kind, status);
    }
  }

  return {
    "task.queued": (data) => applyUpdate(data, "queued"),
    "task.running": (data) => applyUpdate(data, "running"),
    "task.done": (data) => applyUpdate(data, "succeeded"),
    "task.failed": (data) => {
      const err = data?.data?.error || data?.error;
      const msg = typeof err === "string" ? err : err?.message || data?.message || "任务失败";
      applyUpdate(data, "failed", msg);
    },
  };
}
