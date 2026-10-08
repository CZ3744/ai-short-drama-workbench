import { useMemo } from "react";
import { create } from "zustand";

// ──────────────────────────────────────────────────────────────
// W6-A · 全局任务追踪系统(2026-05-15)
// ──────────────────────────────────────────────────────────────
// 在原 SeriesTaskStats / TaskEvent 基础上引入 task 维度的精确状态:
//  - tasks         按 task_id 索引 的精确任务记录(kind / shot_id / status / eta_s / error)
//  - taskKindByShot 按 "shot_id|kind" 倒排索引最新 task_id, 让按钮 selector O(1) 查询
//  - sessionStorage 持久化,刷新/切 tab 仍可见
//
// 命名约定:
//  - "shot_id|kind" 的 kind ∈ image | video | tts | llm
//  - upsertTask 用于点击按钮后立即 enqueue task(status=queued), 以及 SSE task.* 事件更新
//
// 保留 events / runningCount / queuedCount / failedCount 兼容旧字段(GlobalQueuePanel /
// AppTopBar / CockpitPage 等多处引用), 不破坏已上线行为。

export interface TaskEvent {
  jobId: string;
  series_slug?: string;
  stage: string;
  progress: number;
  status: "running" | "completed" | "failed" | "queued";
  message?: string;
  timestamp: number;
  /** 关联的 shot_id，用于点击跳转 */
  shot_id?: string;
  /** 关联的 episode id */
  ep_id?: string;
}

/** 单个 shot 的 compose 进度 — 来自 SSE compose.shot 事件 */
export interface ComposeShotEvent {
  shot_id: string;
  index: number;
  total: number;
  audio_generated: boolean;
  srt_done: boolean;
}

/** 按 series_slug 分组的任务统计 */
export interface SeriesTaskStats {
  slug: string;
  running: number;
  queued: number;
  failed: number;
  completed: number;
}

// ── W6-A 新增 ────────────────────────────────────────────────────

export type TaskKind = "image" | "video" | "tts" | "llm" | "compose";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed";

/** 单个任务的精确状态 — 用于按钮状态 / 候选区 skeleton / 失败中心 */
export interface TaskRecord {
  task_id: string;
  kind: TaskKind;
  status: TaskStatus;
  /** 该任务关联的 shot id, 用于 useTaskByShot 倒排索引 */
  shot_id?: string;
  /** element id, 元素生图任务用 */
  element_id?: string;
  /** 系列 slug, 便于 panel 按系列分组 */
  series_slug?: string;
  /** episode id, 便于跳转 */
  ep_id?: string;
  /** 简短进度百分比 0-100 */
  progress?: number;
  /** 入队时间戳(ms) */
  started_at: number;
  /** 预计完成秒数(估算值), 用于按钮 "~预计 30s" 文案 */
  eta_s?: number;
  /** 失败时的错误消息 */
  error_message?: string;
  /** 失败 attempt_id, 失败中心可以跳转 */
  attempt_id?: string;
  /** 该 task 关联的 job_id(orchestrator 维度), 便于失败重试 */
  job_id?: string;
}

/**
 * 2026-05-27 — 从 sessionStorage 改 localStorage 双写.
 *
 * 用户反馈"视频生成中刷新页面占位就没了". 根因排查:
 *   - sessionStorage 同 tab 刷新应保留, 但浏览器在某些场景 (隐私模式 /
 *     storage 配额满 / 跨进程恢复) 会清掉.
 *   - dev server tsx watch restart 期间, 用户若在新 tab 打开同 URL,
 *     sessionStorage 不共享 → task 占位丢.
 *   - localStorage 跨 tab + 跨刷新 + 跨 dev server restart 都保留, 跨 tab
 *     共享对单用户本地工作台无副作用 (用户一次只在一个 tab 编辑).
 *
 * 兼容老 sessionStorage 数据: load 时先看 localStorage, 没就 fallback
 * sessionStorage; 写时只写 localStorage. 一次刷新后老数据自然迁过去.
 */
const LS_KEY_TASKS = "video-generate.tasks.v2";
const SS_KEY_TASKS_LEGACY = "video-generate.tasks.v1";

function loadPersistedTasks(): Record<string, TaskRecord> {
  if (typeof window === "undefined") return {};
  let raw: string | null = null;
  try {
    raw = window.localStorage?.getItem(LS_KEY_TASKS) ?? null;
    if (!raw) raw = window.sessionStorage?.getItem(SS_KEY_TASKS_LEGACY) ?? null;
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, TaskRecord>;
    const now = Date.now();
    const TTL_TERMINAL = 30 * 60 * 1000;   // 已 succeeded/failed 超 30 分钟丢
    const TTL_ANY = 24 * 60 * 60 * 1000;   // 任何状态超 24h 丢
    // 2026-05-27 — queued/running 状态超 45 分钟视为僵尸 (后端早重启或挂了,
    // 没人推 task.done 终态 → 前端死显"排队"). 用户报"没任务但任务中心
    // 一堆排队", 都是这类僵尸. 45min 是真实视频跑完的最长合理估值 (kling
    // 1080P pro 约 3-5 分钟, batch 25 镜串行 ≈ 30 分钟, 加余量 45).
    const TTL_PENDING = 45 * 60 * 1000;
    const filtered: Record<string, TaskRecord> = {};
    for (const [tid, t] of Object.entries(parsed)) {
      if (now - t.started_at > TTL_ANY) continue;
      if ((t.status === "succeeded" || t.status === "failed") && now - t.started_at > TTL_TERMINAL) continue;
      if ((t.status === "queued" || t.status === "running") && now - t.started_at > TTL_PENDING) continue;
      filtered[tid] = t;
    }
    return filtered;
  } catch {
    return {};
  }
}

function persistTasks(tasks: Record<string, TaskRecord>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(LS_KEY_TASKS, JSON.stringify(tasks));
  } catch {
    // 配额满 / 私密模式 — 静默
  }
}

/**
 * 2026-05-28 P0#12: index key 加 series_slug 前缀防跨 series shotId 污染.
 *
 * shotId 不全局唯一 — 用户新建 series 时, 后端可能复用 shot_001 / shot_002 这种
 * 序列 id. 旧 index key = "shot_001|image" 在 series A 和 series B 都覆盖同一
 * 个 task_id, 切到 series B 时 useTaskByShot 拿到 series A 的 task → 进度卡 /
 * 失败提示串台.
 *
 * 新 key = "${series_slug}|${shot_id}|${kind}". 没 series_slug 的旧 task 走
 * 兜底 key "|${shot_id}|${kind}" (空 prefix), caller 传 series_slug=undefined
 * 时也命中这个兜底, 保持向后兼容.
 */
export function shotIndexKey(seriesSlug: string | undefined, shotId: string, kind: TaskKind): string {
  return `${seriesSlug ?? ""}|${shotId}|${kind}`;
}

export function elementIndexKey(seriesSlug: string | undefined, elementId: string, kind: TaskKind): string {
  return `element:${seriesSlug ?? ""}|${elementId}|${kind}`;
}

function rebuildIndex(tasks: Record<string, TaskRecord>): Record<string, string> {
  const index: Record<string, string> = {};
  // 后入为准: 同一 (series, shot, kind) 的最新 task 覆盖旧的
  // 按 started_at 升序遍历, 这样最大的 started_at 最后写入
  const sorted = Object.values(tasks).sort((a, b) => a.started_at - b.started_at);
  for (const t of sorted) {
    if (t.shot_id) index[shotIndexKey(t.series_slug, t.shot_id, t.kind)] = t.task_id;
    if (t.element_id) index[elementIndexKey(t.series_slug, t.element_id, t.kind)] = t.task_id;
  }
  return index;
}

export interface TasksState {
  /** 活跃任务事件 (SSE 事件落到这里) — 保留旧字段 */
  events: Record<string, TaskEvent>;
  /** 运行中的 job 数 */
  runningCount: number;
  /** 排队中的 job 数 */
  queuedCount: number;
  /** 失败的 job 数 */
  failedCount: number;
  /** 最近一次 ledger 记录(用于 Toast) */
  lastLedger: { amount: number; jobId: string; ts: number } | null;
  /** 需要刷新的 shot key 列表(供 SWR mutate) */
  dirtyShotKeys: string[];

  /** compose 合成时, 每个 shot 的实时进度 (shot_id → ComposeShotEvent) */
  composeShotMap: Record<string, ComposeShotEvent>;
  /** 本次 compose 的 shot 总数 */
  composeTotalShots: number;

  // ── W6-A: task 维度 ────────────────────────────────────────
  /** 按 task_id 索引的精确任务记录 */
  tasks: Record<string, TaskRecord>;
  /** "shot_id|kind" → task_id 倒排索引 (最新一次的 task_id) */
  taskKindByShot: Record<string, string>;

  upsertEvent: (event: TaskEvent) => void;
  removeEvent: (jobId: string) => void;
  clearAll: () => void;
  /**
   * 2026-05-27 — 清理"僵尸"任务: queued/running 超 45min, succeeded/failed 超 30min.
   * GlobalQueuePanel 打开时自动调一次, 让用户不需手动清就看不到死任务.
   */
  pruneStaleTasks: () => void;
  setLedger: (amount: number, jobId: string) => void;
  markShotDirty: (key: string) => void;
  clearDirtyShot: (key: string) => void;

  /** 按 series_slug 分组统计任务 */
  getStatsBySeries: () => SeriesTaskStats[];

  /** 推入一条 compose.shot 事件, 更新 composeShotMap */
  pushComposeShot: (ev: ComposeShotEvent) => void;
  /** 清空 compose shot 进度 */
  clearComposeShots: () => void;

  // ── W6-A actions ──────────────────────────────────────────
  /** 提交后立即写入 task 列表(queued / running 都用) */
  upsertTask: (record: TaskRecord) => void;
  /** 终态后(succeeded / failed)记录仍保留,但可显式删除 */
  removeTask: (taskId: string) => void;
  /** 清掉某 shot 上所有任务(切系列时用) */
  clearTasksByShot: (shotId: string) => void;
  /** 注册一批 tasks(后端 /generate 返回 tasks[] 后批量入队) */
  registerTasksFromResponse: (
    tasks: Array<{ task_id: string; shot_id?: string; status?: string }>,
    opts: {
      kind: TaskKind;
      series_slug?: string;
      ep_id?: string;
      eta_s?: number;
      attempt_id?: string;
      job_id?: string;
      element_id?: string;
    },
  ) => void;
}

// 2026-05-28 P0-6 修: loadPersistedTasks 之前被调两次 (tasks + taskKindByShot 各一次),
// 启动时双 IO + 双 TTL 计算. 提到模块级单次 load 共用.
const __initialTasks = loadPersistedTasks();

// 2026-05-28 P0-24 修: STALE_SERIES_PATTERNS 之前在 upsertEvent + pruneStaleTasks 内
// 各 inline 一份, 改 series 名得改两处. 提到模块级单一来源.
const STALE_SERIES_PATTERNS: RegExp[] = [
  /^orchestrator-测试系列/,
  /^attempt-queue-test-/,
  /^preview-prompt-smoke$/,
  /^codex-walkthrough-test$/,
  /^p3-audit-test$/,
  /^测试用例$/,
  /^测试短剧-walkthrough$/,
  /^老张测试ip-/,
  /^测试ip$/,
  /^ip$/,
  /^30秒$/,
  /^_archived_/,
];
function isStaleSeries(slug?: string): boolean {
  return !!slug && STALE_SERIES_PATTERNS.some((re) => re.test(slug));
}

export const useTasksStore = create<TasksState>((set, get) => ({
  events: {},
  runningCount: 0,
  queuedCount: 0,
  failedCount: 0,
  lastLedger: null,
  dirtyShotKeys: [],
  composeShotMap: {},
  composeTotalShots: 0,

  // W6-A: 启动时尝试从 localStorage 恢复. P0-6 单次 load + index 重建.
  tasks: __initialTasks,
  taskKindByShot: rebuildIndex(__initialTasks),

  upsertEvent: (event) =>
    set((state) => {
      const now = Date.now();
      const TTL = 30 * 60 * 1000; // 30 min — prune stale events

      // 2026-05-27 — SSE replay 防御: 后端 sseBroker ring buffer 100 events 会在重连时
      // replay, 历史死任务 (orchestrator-测试系列 / attempt-queue-test-* / preview-prompt-smoke
      // 等) 会被推回前端. 这些 series 已经从磁盘清理, 但 ring buffer 没清.
      // 修: SSE 推过来的 event 若 timestamp 超 30min 直接拒收, 不进 state.
      //     (后端重启 dev server 后 ring buffer 会清, 这个防御是兜底)
      if (event.timestamp && now - event.timestamp > TTL) {
        return state;
      }

      // 2026-05-27 — 按 series_slug deny-list 防御已知测试残留 series (即使后端
      // ring buffer 没清, 也不让这些进前端 state). P0-24: 模式提到模块级单一来源.
      if (isStaleSeries(event.series_slug)) {
        return state;
      }

      const existing = state.events[event.jobId];
      const newEvents = { ...state.events, [event.jobId]: event };

      // 增量更新计数：先减去旧事件的状态（如果存在），再加新事件的状态
      let { runningCount: running, queuedCount: queued, failedCount: failed } = state;
      if (existing) {
        if (existing.status === "running") running--;
        else if (existing.status === "queued") queued--;
        else if (existing.status === "failed") failed--;
      }
      if (event.status === "running") running++;
      else if (event.status === "queued") queued++;
      else if (event.status === "failed") failed++;

      // TTL 清理：仅当 events 超过 50 条时执行清理
      if (Object.keys(newEvents).length > 50) {
        for (const [jobId, e] of Object.entries(newEvents)) {
          if (e.status !== "running" && e.status !== "queued" && now - e.timestamp > TTL) {
            if (e.status === "failed") failed--;
            delete newEvents[jobId];
          }
        }
      }

      return { events: newEvents, runningCount: running, queuedCount: queued, failedCount: failed };
    }),

  removeEvent: (jobId) =>
    set((state) => {
      const existing = state.events[jobId];
      if (!existing) return state;
      const { [jobId]: _, ...rest } = state.events;
      let { runningCount: running, queuedCount: queued, failedCount: failed } = state;
      if (existing.status === "running") running--;
      else if (existing.status === "queued") queued--;
      else if (existing.status === "failed") failed--;
      return { events: rest, runningCount: running, queuedCount: queued, failedCount: failed };
    }),

  clearAll: () => {
    persistTasks({});
    set({
      events: {},
      runningCount: 0,
      queuedCount: 0,
      failedCount: 0,
      lastLedger: null,
      dirtyShotKeys: [],
      composeShotMap: {},
      composeTotalShots: 0,
      tasks: {},
      taskKindByShot: {},
    });
  },

  pruneStaleTasks: () => set((state) => {
    const now = Date.now();
    const TTL_TERMINAL = 30 * 60 * 1000;
    const TTL_PENDING = 45 * 60 * 1000;
    const TTL_EVENT = 30 * 60 * 1000;

    // 2026-05-27 deny-list — 测试残留 series 的 task / event 直接清掉, 不论年龄.
    // P0-24: 模式从模块级 STALE_SERIES_PATTERNS / isStaleSeries 复用.

    // tasks 过滤
    const newTasks: Record<string, TaskRecord> = {};
    for (const [tid, t] of Object.entries(state.tasks)) {
      if (isStaleSeries(t.series_slug)) continue;
      if ((t.status === "succeeded" || t.status === "failed") && now - t.started_at > TTL_TERMINAL) continue;
      if ((t.status === "queued" || t.status === "running") && now - t.started_at > TTL_PENDING) continue;
      newTasks[tid] = t;
    }
    // events 过滤 — timestamp 0 或缺也清 (legacy event 没字段)
    const newEvents: Record<string, TaskEvent> = {};
    let running = 0, queued = 0, failed = 0;
    for (const [jid, e] of Object.entries(state.events)) {
      if (isStaleSeries(e.series_slug)) continue;
      const ts = (e as TaskEvent & { timestamp?: number }).timestamp ?? 0;
      // 没 timestamp 或超过 30min 都清 (没 ts 视为无效, 因为 TaskEvent.timestamp 是必填)
      if (!ts || now - ts > TTL_EVENT) continue;
      newEvents[jid] = e;
      if (e.status === "running") running++;
      else if (e.status === "queued") queued++;
      else if (e.status === "failed") failed++;
    }
    persistTasks(newTasks);
    return {
      tasks: newTasks,
      taskKindByShot: rebuildIndex(newTasks),
      events: newEvents,
      runningCount: running,
      queuedCount: queued,
      failedCount: failed,
    };
  }),

  pushComposeShot: (ev) =>
    set((state) => {
      const newMap = { ...state.composeShotMap, [ev.shot_id]: ev };
      return {
        composeShotMap: newMap,
        composeTotalShots: Math.max(state.composeTotalShots, ev.total),
      };
    }),

  clearComposeShots: () => set({ composeShotMap: {}, composeTotalShots: 0 }),

  setLedger: (amount, jobId) =>
    set({ lastLedger: { amount, jobId, ts: Date.now() } }),

  markShotDirty: (key) =>
    set((state) => {
      if (state.dirtyShotKeys.includes(key)) return state;
      return { dirtyShotKeys: [...state.dirtyShotKeys, key] };
    }),

  // 2026-05-27 — short-circuit: key 不在数组里直接返 state 避免无意义 dirtyShotKeys
  // 引用变化触发订阅者 re-render. 之前每次 clearDirtyShot 都 filter 返新数组, 即使
  // key 不存在也 set, ShotStagePage / ShotboardPage 的 useEffect deps 包含
  // dirtyShotKeys 反复 trigger → "Maximum update depth exceeded".
  clearDirtyShot: (key) =>
    set((state) => {
      if (!state.dirtyShotKeys.includes(key)) return state;
      return { dirtyShotKeys: state.dirtyShotKeys.filter((k) => k !== key) };
    }),

  getStatsBySeries: () => {
    const state = get();
    const map = new Map<string, SeriesTaskStats>();
    for (const evt of Object.values(state.events)) {
      const slug = evt.series_slug || "(未分组)";
      let s = map.get(slug);
      if (!s) {
        s = { slug, running: 0, queued: 0, failed: 0, completed: 0 };
        map.set(slug, s);
      }
      if (evt.status === "running") s.running++;
      else if (evt.status === "queued") s.queued++;
      else if (evt.status === "failed") s.failed++;
      else if (evt.status === "completed") s.completed++;
    }
    // events 优先；仅当某 slug 在 events 中完全没有记录时，才用 tasks 作 fallback 补计数
    const slugsWithEvents = new Set(Array.from(map.keys()));
    for (const t of Object.values(state.tasks)) {
      const slug = t.series_slug || "(未分组)";
      if (slugsWithEvents.has(slug)) continue; // events 已覆盖该 slug，跳过避免 double count
      let s = map.get(slug);
      if (!s) {
        s = { slug, running: 0, queued: 0, failed: 0, completed: 0 };
        map.set(slug, s);
      }
      if (t.status === "running") s.running++;
      else if (t.status === "queued") s.queued++;
      else if (t.status === "failed") s.failed++;
      else if (t.status === "succeeded") s.completed++;
    }
    return Array.from(map.values());
  },

  // ── W6-A: task ops ──────────────────────────────────────
  upsertTask: (record) =>
    set((state) => {
      const newTasks = { ...state.tasks, [record.task_id]: record };
      const newIndex = { ...state.taskKindByShot };
      // 2026-05-28 P0#12: index key 加 series_slug 防跨 series shotId 污染
      if (record.shot_id) newIndex[shotIndexKey(record.series_slug, record.shot_id, record.kind)] = record.task_id;
      if (record.element_id) newIndex[elementIndexKey(record.series_slug, record.element_id, record.kind)] = record.task_id;
      persistTasks(newTasks);
      return { tasks: newTasks, taskKindByShot: newIndex };
    }),

  removeTask: (taskId) =>
    set((state) => {
      if (!state.tasks[taskId]) return state;
      const { [taskId]: removed, ...rest } = state.tasks;
      // 重建索引
      const newIndex = rebuildIndex(rest);
      persistTasks(rest);
      return { tasks: rest, taskKindByShot: newIndex };
    }),

  clearTasksByShot: (shotId) =>
    set((state) => {
      const rest: Record<string, TaskRecord> = {};
      for (const [tid, t] of Object.entries(state.tasks)) {
        if (t.shot_id !== shotId) rest[tid] = t;
      }
      const newIndex = rebuildIndex(rest);
      persistTasks(rest);
      return { tasks: rest, taskKindByShot: newIndex };
    }),

  registerTasksFromResponse: (taskList, opts) =>
    set((state) => {
      const now = Date.now();
      const newTasks = { ...state.tasks };
      const newIndex = { ...state.taskKindByShot };
      for (const t of taskList) {
        if (!t?.task_id) continue;
        const status: TaskStatus =
          t.status === "running" ? "running" :
          t.status === "done" || t.status === "completed" || t.status === "succeeded" ? "succeeded" :
          t.status === "failed" ? "failed" : "queued";
        const record: TaskRecord = {
          task_id: t.task_id,
          kind: opts.kind,
          status,
          shot_id: t.shot_id || undefined,
          element_id: opts.element_id,
          series_slug: opts.series_slug,
          ep_id: opts.ep_id,
          progress: 0,
          started_at: now,
          eta_s: opts.eta_s,
          attempt_id: opts.attempt_id,
          job_id: opts.job_id,
        };
        newTasks[t.task_id] = record;
        const sid = t.shot_id;
        // 2026-05-28 P0#12: index key 加 series_slug 防跨 series shotId 污染
        if (sid) newIndex[shotIndexKey(opts.series_slug, sid, opts.kind)] = t.task_id;
        if (opts.element_id) newIndex[elementIndexKey(opts.series_slug, opts.element_id, opts.kind)] = t.task_id;
      }
      persistTasks(newTasks);
      return { tasks: newTasks, taskKindByShot: newIndex };
    }),
}));

// ──────────────────────────────────────────────────────────────
// Selector hooks (W6-A)
// ──────────────────────────────────────────────────────────────

/**
 * 取某 shot + kind 的当前 task 状态。
 * 返回 undefined 表示该 shot 没有正在跑/排队的任务。
 *
 * 典型用法:
 *   const task = useTaskByShot(shotId, "image");
 *   const busy = !!task && (task.status === "queued" || task.status === "running");
 */
export function useTaskByShot(
  shotId: string | undefined,
  kind: TaskKind,
  // 2026-05-28 P0#12: 接 seriesSlug 防跨 series shotId 污染. 老 caller 不传时按
  // 兜底 key 命中无 series_slug 的旧 task (向后兼容).
  seriesSlug?: string,
): TaskRecord | undefined {
  return useTasksStore((s) => {
    if (!shotId) return undefined;
    const key = shotIndexKey(seriesSlug, shotId, kind);
    const tid = s.taskKindByShot[key];
    if (!tid) return undefined;
    return s.tasks[tid];
  });
}

/** 取某 shot + kind 的繁忙状态(更轻量的 boolean 派生) */
export function useShotBusy(
  shotId: string | undefined,
  kind: TaskKind,
  seriesSlug?: string,
): boolean {
  return useTasksStore((s) => {
    if (!shotId) return false;
    const key = shotIndexKey(seriesSlug, shotId, kind);
    const tid = s.taskKindByShot[key];
    if (!tid) return false;
    const t = s.tasks[tid];
    if (!t) return false;
    return t.status === "queued" || t.status === "running";
  });
}

/** 取整 shot 的所有 task(image+video, 用于 skeleton / 失败小卡)
 * 修复(2026-05-15 W7-hotfix): 把 Object.values+filter 移出 zustand selector,
 * 改用 useMemo 在 hook 内部派生 — selector 必须返回稳定引用,否则触发无限循环。
 * 2026-05-28 P0#12: 接 seriesSlug 防跨 series shotId 污染. 老 caller 不传时
 * 退化为全 shot_id 匹配 (向后兼容). */
export function useTasksForShot(shotId: string | undefined, seriesSlug?: string): TaskRecord[] {
  const tasks = useTasksStore((s) => s.tasks);
  return useMemo(() => {
    if (!shotId) return [];
    return Object.values(tasks).filter((t) => {
      if (t.shot_id !== shotId) return false;
      // 显式 seriesSlug 时, 只返同 series 的 task; 不传 fallback 旧行为
      if (seriesSlug && t.series_slug && t.series_slug !== seriesSlug) return false;
      return true;
    });
  }, [shotId, seriesSlug, tasks]);
}

/** 取所有 running / queued 任务列表(GlobalQueuePanel 用)
 * 修复(2026-05-15 W7-hotfix): 同上,把派生计算放 useMemo。 */
export function useActiveTasksList(): TaskRecord[] {
  const tasks = useTasksStore((s) => s.tasks);
  return useMemo(
    () => Object.values(tasks).filter((t) => t.status === "queued" || t.status === "running"),
    [tasks],
  );
}
