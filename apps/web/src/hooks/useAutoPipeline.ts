/**
 * useAutoPipeline — 一键自动管线状态 hook.
 *
 *  - start(body) → 调后端启动, 初始化 record
 *  - SSE 订阅 series_slug 频道, 监听 pipeline.* 事件按 pipeline_id 路由本 hook 状态
 *  - 30s 兜底轮询 GET /auto-pipelines/:id (容 SSE 抖动)
 *  - abort(): POST /abort
 *  - retryStage(stage): POST /retry-stage
 *  - status / current_stage / stages[] 直接给 UI 渲染
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  abortAutoPipeline,
  getAutoPipeline,
  listAutoPipelines,
  retryAutoPipelineStage,
  startAutoPipeline,
  type AutoPipelineRecord,
  type AutoPipelineStage,
  type AutoPipelineStartBody,
} from "../lib/autoPipelineApi";
import { createSSEClient } from "../lib/sse";

export interface UseAutoPipelineResult {
  record: AutoPipelineRecord | null;
  /** 启动新管线 — 调用方先准备好 body 再调 */
  start: (slug: string, epId: string, body: AutoPipelineStartBody) => Promise<AutoPipelineRecord>;
  /** 中断当前管线 */
  abort: () => Promise<void>;
  /**
   * 从指定 stage 重跑.
   * 2026-05-19 反馈 #2: 第 2 个可选参数 opts.shot_ids / opts.element_ids 限定只重跑这些子集
   *   — 让"重试失败的 N 项"按钮只重抽失败的镜头/素材, 而不是整 stage.
   */
  retryStage: (stage: AutoPipelineStage, opts?: { shot_ids?: string[]; element_ids?: string[] }) => Promise<void>;
  /**
   * 2026-05-26: 离页再回来恢复进度面板.
   *   - 问后端 GET /auto-pipelines?series_slug=&episode_id= 拿当前活跃 pipeline
   *   - 找到 status=running 的 → setRecord + subscribe SSE, UI 恢复
   *   - 没活跃的: 找最新的 finished pipeline 也展示一下, 方便用户看上次结果
   *   - 已有 pipeline_id 在跑时不动 (避免覆盖正在跑的)
   */
  rehydrate: (slug: string, epId: string, opts?: { force?: boolean }) => Promise<void>;
  /** 关闭管线 UI (record 清空, SSE 取消订阅) */
  reset: () => void;
  /** 启动 / abort 中的网络请求 loading */
  pending: boolean;
  /** 启动失败的错误消息 (toC 兜底) */
  error: string | null;
}

export function useAutoPipeline(): UseAutoPipelineResult {
  const [record, setRecord] = useState<AutoPipelineRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 用 ref 持锁 pipeline_id, 避免 SSE 闭包看到旧 state
  const pipelineIdRef = useRef<string | null>(null);
  // 2026-05-26: 跟踪当前订阅的 epId, 切集时让 rehydrate 知道要换 pipeline
  const currentEpIdRef = useRef<string | null>(null);
  const sseDisposeRef = useRef<(() => void) | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 取消 SSE + 轮询 */
  const cleanup = useCallback(() => {
    sseDisposeRef.current?.();
    sseDisposeRef.current = null;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  /** 启动 SSE 订阅 + 兜底轮询 */
  const subscribe = useCallback((slug: string, pipelineId: string) => {
    cleanup();

    // 30s 兜底轮询 — SSE 抖动 / 重连缺口期由它兜底
    pollTimerRef.current = setInterval(async () => {
      if (pipelineIdRef.current !== pipelineId) return;
      try {
        const resp = await getAutoPipeline(pipelineId);
        if (resp.ok && resp.record && pipelineIdRef.current === pipelineId) {
          setRecord(resp.record);
          if (resp.record.status === "done" || resp.record.status === "failed" || resp.record.status === "aborted") {
            if (pollTimerRef.current) {
              clearInterval(pollTimerRef.current);
              pollTimerRef.current = null;
            }
          }
        }
      } catch {
        // 网络错抖动 — 等下一拍重试
      }
    }, 5000);

    // SSE 订阅, 按 series_slug 走全局 channel — createSSEClient 返回 {dispose, reconnect}
    const client = createSSEClient({
      seriesSlug: slug,
      onEvent: {
        "pipeline.stage.started": (data: any) => {
          if (data?.pipeline_id !== pipelineIdRef.current) return;
          setRecord((prev) => prev ? applyStageStarted(prev, data) : prev);
        },
        "pipeline.stage.progress": (data: any) => {
          if (data?.pipeline_id !== pipelineIdRef.current) return;
          setRecord((prev) => prev ? applyStageProgress(prev, data) : prev);
        },
        "pipeline.stage.done": (data: any) => {
          if (data?.pipeline_id !== pipelineIdRef.current) return;
          setRecord((prev) => prev ? applyStageDone(prev, data) : prev);
          // 2026-05-19: skip 事件给用户明确反馈, 避免用户看到 retry 立即 done 以为"卡死".
          // 后端 emitStage("pipeline.stage.done", { skipped: true }) 在 element_images
          // 没东西可重抽时推. 用户原话"生图失败点击重试现在卡死了" — 真因是 skip 静默通过.
          if (data?.skipped === true) {
            const stageLabel = data?.stage === "element_images"
              ? "素材图"
              : data?.stage === "firstframes"
              ? "首帧"
              : data?.stage === "videos"
              ? "视频"
              : data?.stage === "compose"
              ? "合成"
              : "该阶段";
            toast.info(`${stageLabel}阶段已无需要重做的内容 — 可能图已经存在或剧目数据已变更。如果仍想强制重抽,请去对应素材/分镜单独触发。`, {
              duration: 6000,
            });
          }
        },
        "pipeline.done": (data: any) => {
          if (data?.pipeline_id !== pipelineIdRef.current) return;
          setRecord((prev) => prev ? {
            ...prev,
            status: "done",
            current_stage: null,
            final_video_path: data?.final_video_path ?? prev.final_video_path,
            finished_at: new Date().toISOString(),
          } : prev);
        },
        "pipeline.failed": (data: any) => {
          if (data?.pipeline_id !== pipelineIdRef.current) return;
          setRecord((prev) => {
            if (!prev) return prev;
            const next = { ...prev, status: "failed" as const, finished_at: new Date().toISOString() };
            if (data?.stage) {
              // 2026-05-26: pipeline.failed/aborted 现在带 failed_details / failed_ids,
              // 让中途 abort 时失败明细不丢
              const failedIds = Array.isArray(data?.failed_ids) ? data.failed_ids : undefined;
              const failedDetails = Array.isArray(data?.failed_details) ? data.failed_details : undefined;
              const failedNum = typeof data?.failed === "number" ? data.failed : undefined;
              next.stages = prev.stages.map((s) => s.id === data.stage
                ? {
                    ...s,
                    status: "failed" as const,
                    error: data?.error ?? "未知错误",
                    ...(failedNum !== undefined ? { failed: failedNum } : {}),
                    ...(failedIds !== undefined ? { failed_ids: failedIds } : {}),
                    ...(failedDetails !== undefined ? { failed_details: failedDetails } : {}),
                  }
                : s);
            }
            return next;
          });
        },
        "pipeline.aborted": (data: any) => {
          if (data?.pipeline_id !== pipelineIdRef.current) return;
          setRecord((prev) => {
            if (!prev) return prev;
            const next = { ...prev, status: "aborted" as const, finished_at: new Date().toISOString() };
            if (data?.stage) {
              const failedIds = Array.isArray(data?.failed_ids) ? data.failed_ids : undefined;
              const failedDetails = Array.isArray(data?.failed_details) ? data.failed_details : undefined;
              const failedNum = typeof data?.failed === "number" ? data.failed : undefined;
              next.stages = prev.stages.map((s) => s.id === data.stage
                ? {
                    ...s,
                    status: "aborted" as const,
                    ...(failedNum !== undefined ? { failed: failedNum } : {}),
                    ...(failedIds !== undefined ? { failed_ids: failedIds } : {}),
                    ...(failedDetails !== undefined ? { failed_details: failedDetails } : {}),
                  }
                : s);
            }
            return next;
          });
        },
      },
    });
    sseDisposeRef.current = () => client.dispose();
  }, [cleanup]);

  const start = useCallback(async (slug: string, epId: string, body: AutoPipelineStartBody) => {
    setPending(true);
    setError(null);
    try {
      const resp = await startAutoPipeline(slug, epId, body);
      pipelineIdRef.current = resp.pipeline_id;
      setRecord(resp.record);
      subscribe(slug, resp.pipeline_id);
      return resp.record;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setPending(false);
    }
  }, [subscribe]);

  const abort = useCallback(async () => {
    if (!pipelineIdRef.current) return;
    setPending(true);
    try {
      await abortAutoPipeline(pipelineIdRef.current);
      // SSE 会推 pipeline.aborted; record 状态变更
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, []);

  const retryStage = useCallback(async (
    stage: AutoPipelineStage,
    opts?: { shot_ids?: string[]; element_ids?: string[] },
  ) => {
    if (!pipelineIdRef.current) return;
    setPending(true);
    setError(null);
    try {
      // 2026-05-19 反馈 #2: 透传 opts 给后端 — 限定只重跑失败的子集
      const resp = await retryAutoPipelineStage(pipelineIdRef.current, stage, opts);
      setRecord(resp.record);
      // 2026-05-19: retry skip 反馈 — 用户原话"生图失败点击重试现在卡死了"
      // 真因: retry 命中"已无需重抽内容"分支 (queue=0 直接 skip), 用户看到 record.status
      // 立即 done, 跟"卡死"一样. 给个明确 toast 让用户知道发生了什么.
      // 监听 SSE 推 stage.done with skipped=true 比这里立即判断更准, 但 SSE 有延迟,
      // 这里 retry 调完 record 立即拿到, 比 SSE 早 < 100ms 就能告诉用户.
      // 实际场景: 后端 retryStage 返 record 时 stage 还是 pending (fire-and-forget 还没跑),
      // 所以这里看不到 skipped — 需要靠 SSE pipeline.stage.done 事件回流后再 toast.
      // pipeline_id 不变, SSE 订阅继续有效
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setPending(false);
    }
  }, []);

  const reset = useCallback(() => {
    pipelineIdRef.current = null;
    currentEpIdRef.current = null;
    cleanup();
    setRecord(null);
    setError(null);
  }, [cleanup]);

  // 2026-05-26: 离页再回来 — 自动恢复进度面板. ShotboardPage / ComposePage mount 时调.
  //   2026-05-26 修复"批量启动整部剧后切集进度不变" — 之前 pipelineIdRef 存在就 return,
  //   导致切到其他集时 record 没换. 现在加 currentEpIdRef 跟踪当前订阅的集 id,
  //   epId 切换时 cleanup 旧订阅 + 按新集 fetch.
  //   2026-05-26 修复"切集闪烁" — 旧版立刻 setRecord(null) 让 panel 消失, 等 fetch
  //   完才设新值, 期间面板白屏 100-300ms. 现在切集只 cleanup SSE/timer 但保留旧 record
  //   视觉, 等新 record 拿到再原子替换. 新集真没 pipeline 才 setRecord(null).
  //   优先恢复 status=running 的, 没活跃就显示最新一条.
  const rehydrate = useCallback(async (slug: string, epId: string, opts?: { force?: boolean }) => {
    if (!slug || !epId) return;
    // 同集且已订阅 → 默认 skip; force=true (batch 启动后接管新 pipeline) 强制刷新
    if (!opts?.force && pipelineIdRef.current && currentEpIdRef.current === epId) return;
    if (pipelineIdRef.current && (opts?.force || currentEpIdRef.current !== epId)) {
      cleanup();
      pipelineIdRef.current = null;
      // ★ 不立即 setRecord(null) — 保留旧 panel 显示, 避免白屏闪烁
    }
    currentEpIdRef.current = epId;
    try {
      const resp = await listAutoPipelines(slug, epId);
      // 新集真没 pipeline 才清空 record (此时切到的是没跑过的集)
      if (!resp.ok || !Array.isArray(resp.records) || resp.records.length === 0) {
        if (currentEpIdRef.current === epId) setRecord(null);
        return;
      }
      // 防止异步竞态: 调期间用户又切了集
      if (currentEpIdRef.current !== epId) return;
      // 找最新一个 running, 没有就拿最新一条 (按 started_at 排序, 后端可能已排序)
      const sorted = [...resp.records].sort((a, b) =>
        (b.started_at ?? "").localeCompare(a.started_at ?? "")
      );
      const target = sorted.find((r) => r.status === "running") ?? sorted[0];
      if (!target?.pipeline_id) return;
      // 2026-05-26 subscribe 前再 check 一次 race — list 返回后到 setRecord 之间用户又切了集.
      if (currentEpIdRef.current !== epId) return;
      pipelineIdRef.current = target.pipeline_id;
      setRecord(target);
      // 只对 running 才订阅 SSE + 轮询 (已结束的没必要持续监听)
      if (target.status === "running") {
        subscribe(slug, target.pipeline_id);
      }
    } catch {
      // 静默失败, 网络问题用户下次进页面再试
    }
  }, [subscribe, cleanup]);

  // unmount cleanup
  useEffect(() => () => { cleanup(); }, [cleanup]);

  return { record, start, abort, retryStage, rehydrate, reset, pending, error };
}

// ─── Pure reducers ──────────────────────────────────────────────────

function applyStageStarted(prev: AutoPipelineRecord, data: any): AutoPipelineRecord {
  const stage = data?.stage as AutoPipelineStage | undefined;
  if (!stage) return prev;
  return {
    ...prev,
    status: "running",
    current_stage: stage,
    stages: prev.stages.map((s) => s.id === stage
      ? { ...s, status: "running", started_at: new Date().toISOString() }
      : s),
  };
}

function applyStageProgress(prev: AutoPipelineRecord, data: any): AutoPipelineRecord {
  const stage = data?.stage as AutoPipelineStage | undefined;
  if (!stage) return prev;
  // 2026-05-26 修 "5 失败但只显示 4 条明细" — progress 事件后端也推 failed / failed_ids / failed_details,
  // 这里同步合并. 之前只读 completed/total → failed 数字和明细数组永远是旧值, 要靠 30s 兜底轮询才拉新.
  const eventFailed = typeof data?.failed === "number" ? data.failed : undefined;
  const eventFailedIds = Array.isArray(data?.failed_ids) ? data.failed_ids : undefined;
  const eventFailedDetails = Array.isArray(data?.failed_details) ? data.failed_details : undefined;
  return {
    ...prev,
    stages: prev.stages.map((s) => s.id === stage
      ? {
          ...s,
          completed: Number(data?.completed) || 0,
          total: Number(data?.total) || s.total,
          ...(eventFailed !== undefined ? { failed: eventFailed } : {}),
          ...(eventFailedIds !== undefined ? { failed_ids: eventFailedIds } : {}),
          ...(eventFailedDetails !== undefined ? { failed_details: eventFailedDetails } : {}),
        }
      : s),
  };
}

function applyStageDone(prev: AutoPipelineRecord, data: any): AutoPipelineRecord {
  const stage = data?.stage as AutoPipelineStage | undefined;
  if (!stage) return prev;
  // 2026-05-19 反馈 #2: 如果 SSE 事件带了 failed_ids 就用 (后端目前没推, 但保留以便未来扩);
  // 否则保留 stage 上现有的 failed_ids — 它会由 5s 轮询 getAutoPipeline 同步过来.
  const eventFailedIds = Array.isArray(data?.failed_ids)
    ? (data.failed_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  // 2026-05-22 bug B: failed_details — 后端 element_images stage 推送的失败明细
  const eventFailedDetails = Array.isArray(data?.failed_details) ? data.failed_details : undefined;
  // P2: skipped_count — autoPickGenerations 挑选时跳过的 shot 数 (没有 candidates 可挑)
  const skippedCount = typeof data?.skipped_count === "number" ? data.skipped_count : undefined;
  // 2026-05-26: 显式判断 SSE 是否带了字段, 避免 `|| 0` 把"本来就 0"的合法值兜底成 0,
  // 也避免缺字段时读 s.completed 当 0. 字段在 → 用新值; 字段缺 → 保留旧值.
  const eventCompleted = typeof data?.succeeded === "number" ? data.succeeded : undefined;
  const eventFailed = typeof data?.failed === "number" ? data.failed : undefined;
  return {
    ...prev,
    stages: prev.stages.map((s) => s.id === stage
      ? {
          ...s,
          status: "done",
          completed: eventCompleted !== undefined ? eventCompleted : s.completed,
          failed: eventFailed !== undefined ? eventFailed : s.failed,
          finished_at: new Date().toISOString(),
          failed_ids: eventFailedIds ?? s.failed_ids,
          failed_details: eventFailedDetails ?? s.failed_details,
          ...(skippedCount !== undefined ? { skipped_count: skippedCount } : {}),
        }
      : s),
  };
}
