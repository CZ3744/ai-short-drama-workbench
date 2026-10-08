import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useGlobalTool } from "../shell/GlobalTools";
import { useNavigate } from "react-router-dom";
import useSWR from "swr";
import { cn } from "../../lib/cn";
import {
  useTasksStore,
  useActiveTasksList,
  type SeriesTaskStats,
  type TaskRecord,
} from "../../stores/tasksStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ROUTES } from "../../lib/routes";
// 2026-05-28 P0-9/23 — SSE client 全局唯一 (App.tsx useGlobalSSE 内建), 不再自建第二个.
// 2026-07-09 audit C30: 补 friendlyTaskError — 失败任务的 error_message 之前原样渲染 (常驻可见处泄露英文/HTML/JSON).
import { labelOfStage, labelShotId, friendlyTaskError } from "../../lib/sourceLabels";
import { apiGet } from "../../lib/api";
import { listElements } from "../../lib/elementApi";
import {
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Moon,
  Sun,
  Settings2,
  Layers,
  X,
} from "../shared/LucideIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
// 2026-05-28 P0-9/23: 删 toast import — SSE block 删后无任何 toast 调用 (App.tsx 集中处理).

// ── 夜间批处理时段判断 ──

function isNightBatchActive(start: string, end: string): boolean {
  const now = new Date();
  const hh = now.getHours();
  const mm = now.getMinutes();
  const cur = hh * 60 + mm;

  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;

  // 跨午夜: 23:00 - 07:00
  if (startMin > endMin) {
    return cur >= startMin || cur < endMin;
  }
  return cur >= startMin && cur < endMin;
}

// ── 单系列任务行 ──

interface SeriesRowProps {
  stat: SeriesTaskStats;
  onClickSeries: (slug: string) => void;
  onClickShot: (slug: string, shotId?: string) => void;
  shotIndexMap?: Record<string, number>;
}

function SeriesRow({ stat, onClickSeries, onClickShot, shotIndexMap }: SeriesRowProps) {
  const events = useTasksStore((s) => s.events);
  const seriesEvents = useMemo(
    () => Object.values(events).filter((e) => (e.series_slug || "(未分组)") === stat.slug),
    [events, stat.slug],
  );

  return (
    <div className="border-b border-[var(--ink-100)] last:border-b-0">
      {/* 系列汇总行 */}
      <button
        className="flex items-center gap-3 w-full px-4 py-2.5 hover:bg-[var(--ink-50)] transition-colors text-left"
        onClick={() => onClickSeries(stat.slug)}
      >
        <span className="text-[var(--fs-sm)] font-medium text-[var(--ink-800)] truncate flex-1 min-w-0">
          {stat.slug}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {stat.running > 0 && (
            <span className="flex items-center gap-1 text-[var(--info)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-[11px] tabular-nums">{stat.running}</span>
            </span>
          )}
          {stat.queued > 0 && (
            <Badge variant="default" className="text-[10px] px-1.5 py-0">
              排队 {stat.queued}
            </Badge>
          )}
          {stat.failed > 0 && (
            <span className="flex items-center gap-1 text-[var(--err)]">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span className="text-[11px] tabular-nums">{stat.failed}</span>
            </span>
          )}
          {stat.completed > 0 && (
            <span className="flex items-center gap-1 text-[var(--ok)]">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span className="text-[11px] tabular-nums">{stat.completed}</span>
            </span>
          )}
        </div>
      </button>

      {/* 展开的任务明细 */}
      {seriesEvents.length > 0 && (
        <div className="pl-6 pr-4 pb-1 space-y-0.5">
          {seriesEvents.map((evt) => (
            <button
              key={evt.jobId}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[var(--r-sm)] hover:bg-[var(--ink-50)] transition-colors text-left"
              onClick={() => onClickShot(stat.slug, evt.shot_id)}
            >
              {evt.status === "running" && (
                <Loader2 className="h-3 w-3 text-[var(--info)] animate-spin shrink-0" />
              )}
              {evt.status === "queued" && <Clock className="h-3 w-3 text-[var(--ink-400)] shrink-0" />}
              {evt.status === "failed" && (
                <AlertTriangle className="h-3 w-3 text-[var(--err)] shrink-0" />
              )}
              {evt.status === "completed" && (
                <CheckCircle2 className="h-3 w-3 text-[var(--ok)] shrink-0" />
              )}
              <span className="text-[11px] text-[var(--ink-600)] truncate flex-1">
                {labelOfStage(evt.stage)}
                {evt.shot_id
                  ? ` · ${
                      shotIndexMap?.[evt.shot_id] != null
                        ? `第 ${(shotIndexMap[evt.shot_id] as number) + 1} 镜`
                        : "未命名分镜"
                    }`
                  : ""}
              </span>
              {evt.progress > 0 && evt.progress < 100 && (
                <span className="text-[10px] tabular-nums text-[var(--ink-400)] shrink-0">
                  {evt.progress}%
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── W6-A 单 task 行(按 shot + kind 精确) ──
// W7-element-ux: 失败记录已整合到这里,显示 项目·集·分镜·失败种类 + 切模型重试按钮

/** 把 TaskRecord 拼成人话上下文 — "测试用例 · EP01 · 第 3 镜 · 首帧生成" */
function describeTask(
  t: TaskRecord,
  shotIndexMap?: Record<string, number>,
  elementNameMap?: Record<string, string>,
  episodeTitleMap?: Record<string, string>,
): string {
  const parts: string[] = [];
  if (t.series_slug) parts.push(t.series_slug);
  if (t.ep_id) {
    // 2026-05-27 — 优先用 episode.title (人话标题), fallback "EP01" 技术 id.
    // 用户截图: 任务列表显示 "废墟微光 · EP01 · 第 3 镜 · 合成成片" → 改后变
    // "废墟微光 · 序章: 崩溃之日 · 第 3 镜 · 合成成片", UX 铁律 #9 toC 兜底.
    const title = t.series_slug ? episodeTitleMap?.[`${t.series_slug}::${t.ep_id}`] : undefined;
    parts.push(title ?? t.ep_id.toUpperCase());
  }
  if (t.shot_id) {
    // 2026-05-27 — 优先 index+1 显示"第 N 镜", 找不到走 labelShotId(t.shot_id)
    // 解析 "s0001_xxx" / "shot_001" 这种技术 id 成"分镜 1" — 比 "未命名分镜" 直观.
    const idx = shotIndexMap?.[t.shot_id];
    parts.push(idx != null ? `第 ${idx + 1} 镜` : labelShotId(t.shot_id));
  } else if (t.element_id) {
    // 优先用 element.name，找不到 fallback "未命名素材"（绝不显示 hash）
    const name = elementNameMap?.[t.element_id];
    parts.push(name ? `素材 ${name}` : "未命名素材");
  }
  const kindLabel =
    t.kind === "image" ? "首帧生成" :
    t.kind === "video" ? "视频生成" :
    t.kind === "tts" ? "配音生成" :
    t.kind === "compose" ? "合成成片" : "LLM 调用";
  parts.push(kindLabel);
  return parts.join(" · ");
}

function TaskRow({
  task,
  onClick,
  shotIndexMap,
  elementNameMap,
  episodeTitleMap,
}: {
  task: TaskRecord;
  onClick: (slug: string, shotId?: string, epId?: string) => void;
  shotIndexMap?: Record<string, number>;
  elementNameMap?: Record<string, string>;
  episodeTitleMap?: Record<string, string>;
}) {
  const elapsedSec = Math.max(1, Math.round((Date.now() - task.started_at) / 1000));
  const isFailed = task.status === "failed";
  const contextLabel = describeTask(task, shotIndexMap, elementNameMap, episodeTitleMap);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 14px",
        borderLeft: isFailed ? "3px solid var(--err)" : "3px solid transparent",
        background: isFailed ? "rgba(220,38,38,0.04)" : "transparent",
        transition: "background-color 120ms",
      }}
    >
      <div className="flex items-center gap-2 w-full">
        {task.status === "running" && <Loader2 className="h-3.5 w-3.5 text-[var(--info)] animate-spin shrink-0" />}
        {task.status === "queued" && <Clock className="h-3.5 w-3.5 text-[var(--ink-400)] shrink-0" />}
        {task.status === "succeeded" && <CheckCircle2 className="h-3.5 w-3.5 text-[var(--ok)] shrink-0" />}
        {task.status === "failed" && <AlertTriangle className="h-3.5 w-3.5 text-[var(--err)] shrink-0" />}
        <button
          className="text-[11.5px] text-[var(--ink-700)] font-medium truncate flex-1 text-left hover:underline"
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
          onClick={() => task.series_slug && onClick(task.series_slug, task.shot_id, task.ep_id)}
          title={contextLabel}
        >
          {contextLabel}
        </button>
        <span className="text-[10px] tabular-nums text-[var(--ink-400)] shrink-0">
          {/* 2026-05-27 — 用户反馈"全都 67s 不像真状态". 之前 eta_s 用入队时
              算的固定 baseline (~视频时长×8+30), 跟实际任务进度无关, 多条同款
              eta_s 误导用户. 现在改成真实在跑用 elapsedSec, 排队中显"排队中" */}
          {task.status === "succeeded" ? "完成" :
           task.status === "failed" ? "失败" :
           task.status === "queued" ? "排队中" :
           `${elapsedSec}s`}
        </span>
      </div>
      {isFailed && task.error_message && (
        <div className="text-[10.5px] text-[var(--err)]" style={{ paddingLeft: 22, lineHeight: 1.4 }}>
          {friendlyTaskError(task.error_message)}
        </div>
      )}
      {isFailed && task.series_slug && task.shot_id && task.ep_id && (
        <div style={{ paddingLeft: 22 }}>
          <button
            className="mk-btn mk-btn--xs mk-btn--primary"
            style={{ borderRadius: 6, border: "1px solid var(--brand-600)", display: "inline-flex", alignItems: "center", gap: 4 }}
            onClick={(e) => {
              e.stopPropagation();
              onClick(task.series_slug!, task.shot_id, task.ep_id);
            }}
            title="跳到分镜页 · 选择新模型重试"
          >
            <Settings2 className="h-3 w-3" /> 切模型重试
          </button>
        </div>
      )}
    </div>
  );
}

// ── 夜间批处理设置面板 ──

function NightBatchSettingsPanel() {
  // W8-sweep (2026-05-16): 不解构整个 store, 走单字段 selector 避免无限循环 (CLAUDE.md 陷阱 §1)
  const nightBatch = useSettingsStore((s) => s.nightBatch);
  const setNightBatch = useSettingsStore((s) => s.setNightBatch);

  return (
    <div className="px-4 py-3 border-t border-[var(--ink-100)] bg-[var(--ink-50)]">
      <div className="flex items-center gap-2 mb-2">
        <Moon className="h-4 w-4 text-[var(--ink-500)]" />
        <span className="text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">夜间批处理</span>
      </div>
      <div className="flex items-center gap-3 mb-2">
        <label className="flex items-center gap-2 text-[11px] text-[var(--ink-600)]">
          <input
            type="checkbox"
            checked={nightBatch.enabled}
            onChange={(e) => setNightBatch({ enabled: e.target.checked })}
            className="rounded"
          />
          启用
        </label>
        <label className="flex items-center gap-1 text-[11px] text-[var(--ink-600)]">
          开始
          <input
            type="time"
            value={nightBatch.start}
            onChange={(e) => setNightBatch({ start: e.target.value })}
            className="w-16 px-1 py-0.5 rounded border border-[var(--ink-200)] text-[11px] bg-[var(--surface-card)]"
          />
        </label>
        <label className="flex items-center gap-1 text-[11px] text-[var(--ink-600)]">
          结束
          <input
            type="time"
            value={nightBatch.end}
            onChange={(e) => setNightBatch({ end: e.target.value })}
            className="w-16 px-1 py-0.5 rounded border border-[var(--ink-200)] text-[11px] bg-[var(--surface-card)]"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-[var(--ink-600)]">
        <input
          type="checkbox"
          checked={nightBatch.autoAdvanceToGate}
          onChange={(e) => setNightBatch({ autoAdvanceToGate: e.target.checked })}
          className="rounded"
        />
        自动选质量分最高的推进到人工 gate
      </label>
      {nightBatch.enabled && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[var(--ink-400)]">
          {isNightBatchActive(nightBatch.start, nightBatch.end) ? (
            <>
              <Moon className="h-3 w-3 text-[var(--brand-500)]" />
              <span>夜间模式进行中 ({nightBatch.start} - {nightBatch.end})</span>
            </>
          ) : (
            <>
              <Sun className="h-3 w-3 text-[var(--warn)]" />
              <span>当前为白天，{nightBatch.start} 后自动进入夜间模式</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── 弹出任务列表窗口 ──

interface QueuePopoverProps {
  onClose: () => void;
  runningCount: number;
  queuedCount: number;
  taskRunning: number;
  taskQueued: number;
  failedCount: number;
  taskFailed: number;
  isNightActive: boolean;
  seriesStats: SeriesTaskStats[];
  activeTasks: TaskRecord[];
  failedTasks: TaskRecord[];
  showNightSettings: boolean;
  onToggleNightSettings: () => void;
  onClickSeries: (slug: string) => void;
  onClickShot: (slug: string, shotId?: string, epId?: string) => void;
  onClearCompleted: () => void;
  onGoToFailures: () => void;
  shotIndexMap: Record<string, number>;
  elementNameMap: Record<string, string>;
  episodeTitleMap: Record<string, string>;
}

function QueuePopover({
  onClose,
  runningCount,
  queuedCount,
  taskRunning,
  taskQueued,
  failedCount,
  taskFailed,
  isNightActive,
  seriesStats,
  activeTasks,
  failedTasks,
  showNightSettings,
  onToggleNightSettings,
  onClickSeries,
  onClickShot,
  onClearCompleted,
  onGoToFailures,
  shotIndexMap,
  elementNameMap,
  episodeTitleMap,
}: QueuePopoverProps) {
  const totalRunning = runningCount + taskRunning;
  const totalQueued = queuedCount + taskQueued;
  const totalFailed = failedCount + taskFailed;

  // ESC 关闭
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        right: 24,
        bottom: 24,
        width: "min(360px, calc(100vw - 48px))",
        maxHeight: "min(480px, calc(100dvh - 48px))",
        borderRadius: 16,
        zIndex: 200,
        background: "var(--surface-card)",
        border: "1px solid var(--ink-100)",
        boxShadow: "0 16px 48px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.10)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      role="dialog"
      aria-label="任务中心"
      data-tool-panel="queue"
      tabIndex={-1}
    >
      {/* Header */}
      <div
        style={{
          height: 48,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          borderBottom: "1px solid var(--ink-100)",
          flexShrink: 0,
          gap: 8,
        }}
      >
        <Layers className="h-4 w-4 text-[var(--ink-500)] shrink-0" />
        <span className="text-[var(--fs-sm)] font-semibold text-[var(--ink-800)] flex-1">任务中心</span>
        {/* 统计摘要 */}
        <div className="flex items-center gap-2 text-[11px] tabular-nums shrink-0">
          {totalRunning > 0 && (
            <span className="flex items-center gap-1 text-[var(--info)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              {totalRunning}
            </span>
          )}
          {totalQueued > 0 && (
            <span className="flex items-center gap-1 text-[var(--ink-400)]">
              <Clock className="h-3 w-3" />
              {totalQueued}
            </span>
          )}
          {totalFailed > 0 && (
            <span className="flex items-center gap-1 text-[var(--err)]">
              <AlertTriangle className="h-3 w-3" />
              {totalFailed}
            </span>
          )}
        </div>
        {/* 夜间设置 */}
        <button
          onClick={onToggleNightSettings}
          title="夜间批处理设置"
          aria-label="夜间批处理设置"
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[var(--ink-50)] transition-colors text-[var(--ink-400)] hover:text-[var(--ink-700)] text-[11px]"
        >
          <Settings2 className="h-3.5 w-3.5 shrink-0" />
          <span>夜批</span>
        </button>
        {/* 关闭按钮 */}
        <button
          onClick={onClose}
          aria-label="关闭任务中心"
          title="关闭"
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[var(--ink-50)] transition-colors text-[var(--ink-400)] hover:text-[var(--ink-700)] text-[11px]"
        >
          <X className="h-3.5 w-3.5 shrink-0" />
          <span>关闭</span>
        </button>
      </div>

      {/* 夜间模式状态条 */}
      {isNightActive && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-50)] border-b border-[var(--brand-100)] shrink-0">
          <Moon className="h-3.5 w-3.5 text-[var(--brand-500)]" />
          <span className="text-[11px] text-[var(--brand-700)] font-medium">
            夜间批处理模式 — 自动推进到人工 gate
          </span>
        </div>
      )}

      {/* 任务列表（可滚动） */}
      <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
        {/* 按系列分组 */}
        {seriesStats.length > 0 && (
          <div className="divide-y-0">
            {seriesStats.map((stat) => (
              <SeriesRow
                key={stat.slug}
                stat={stat}
                onClickSeries={onClickSeries}
                onClickShot={onClickShot}
                shotIndexMap={shotIndexMap}
              />
            ))}
          </div>
        )}

        {/* 按 shot+kind 维度的精确任务列表 */}
        {(activeTasks.length > 0 || failedTasks.length > 0) && (
          <div className={cn(seriesStats.length > 0 ? "border-t border-[var(--ink-100)]" : "")}>
            <div className="px-4 py-2 text-[10px] uppercase tracking-wider font-bold text-[var(--ink-500)]">
              生成任务（按分镜）
            </div>
            <div className="space-y-0.5 pb-2">
              {activeTasks.map((t) => (
                <TaskRow key={t.task_id} task={t} onClick={onClickShot} shotIndexMap={shotIndexMap} elementNameMap={elementNameMap} episodeTitleMap={episodeTitleMap} />
              ))}
              {failedTasks.slice(0, 6).map((t) => (
                <TaskRow key={t.task_id} task={t} onClick={onClickShot} shotIndexMap={shotIndexMap} elementNameMap={elementNameMap} episodeTitleMap={episodeTitleMap} />
              ))}
            </div>
          </div>
        )}

        {/* 无任务时 */}
        {seriesStats.length === 0 && activeTasks.length === 0 && failedTasks.length === 0 && (
          <div className="px-4 py-8 text-center text-[var(--fs-sm)] text-[var(--ink-400)]">
            暂无活跃任务
          </div>
        )}

        {/* 夜间批处理设置 */}
        {showNightSettings && <NightBatchSettingsPanel />}
      </div>

      {/* Footer */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-t border-[var(--ink-100)] bg-[var(--ink-50)] shrink-0"
      >
        <button
          onClick={onClearCompleted}
          className="text-[11px] text-[var(--ink-500)] hover:text-[var(--ink-800)] transition-colors px-2 py-1 rounded hover:bg-[var(--ink-100)]"
          title="清空所有任务记录 (包含进行中 / 失败 / 已完成 / 僵尸残留)"
        >
          全部清空
        </button>
        <div className="flex-1" />
        {totalFailed > 0 && (
          <button
            onClick={onGoToFailures}
            className="text-[11px] text-[var(--err)] hover:text-[var(--err)] transition-colors px-2 py-1 rounded hover:bg-[var(--err)]/10 font-medium"
          >
            前往失败中心 →
          </button>
        )}
      </div>
    </div>
  );
}

// ── 圆形悬浮按钮 ──

interface QueueBubbleProps {
  onClick: () => void;
  totalActive: number;   // queued + running
  totalFailed: number;
  hasActive: boolean;
}

function QueueBubble({ onClick, totalActive, totalFailed, hasActive }: QueueBubbleProps) {
  // 颜色状态：进行中 > 失败 > 完成
  const isActive = totalActive > 0;
  const isFailed = !isActive && totalFailed > 0;

  const buttonStyle: React.CSSProperties = {
    position: "relative",
    height: 36,
    minWidth: 88,
    padding: "0 16px",
    borderRadius: 22,
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    cursor: "pointer",
    border: "none",
    outline: "none",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.12)",
    background: isActive
      ? "linear-gradient(135deg, var(--brand-500, #f97316), var(--brand-700, #c2410c))"
      : isFailed
      ? "linear-gradient(135deg, #f59e0b, #d97706)"
      : "var(--ink-100, #e5e7eb)",
    color: isActive || isFailed ? "#fff" : "var(--ink-500, #6b7280)",
    fontSize: 13,
    fontWeight: 600,
  };

  const tooltipText = `任务中心${totalActive > 0 ? ` · ${totalActive} 个进行中` : ""}${totalFailed > 0 ? ` · ${totalFailed} 个失败` : ""}`;

  return (
    <button
      style={buttonStyle}
      onClick={onClick}
      data-tool-trigger="queue"
      aria-label="打开任务中心"
      title={tooltipText}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.04)";
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 12px 32px rgba(0,0,0,0.22), 0 4px 10px rgba(0,0,0,0.14)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 8px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.12)";
      }}
    >
      {/* 左侧图标：进行中时脉冲动效 */}
      <Layers
        className={cn("h-4 w-4 shrink-0", isActive && "animate-pulse")}
        style={{ pointerEvents: "none" }}
      />
      {/* 文字标签 */}
      <span style={{ pointerEvents: "none", lineHeight: 1 }}>任务</span>
      {/* 角标：进行中任务数（放在文字右侧内联，样式更紧凑） */}
      {totalActive > 0 && (
        <span
          style={{
            minWidth: 18,
            height: 18,
            borderRadius: 999,
            background: "rgba(255,255,255,0.35)",
            color: "#fff",
            fontSize: 10,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 4px",
            lineHeight: 1,
            pointerEvents: "none",
          }}
        >
          {totalActive}
        </span>
      )}
      {isFailed && totalFailed > 0 && (
        <span
          style={{
            minWidth: 18,
            height: 18,
            borderRadius: 999,
            background: "rgba(255,255,255,0.35)",
            color: "#fff",
            fontSize: 10,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 4px",
            lineHeight: 1,
            pointerEvents: "none",
          }}
        >
          {totalFailed}
        </span>
      )}
    </button>
  );
}

// ── 主组件 ──

export interface GlobalQueuePanelProps {
  className?: string;
}

/**
 * 右下角悬浮任务中心按钮 + 弹出小窗
 *
 * - 默认：56×56px 圆形悬浮按钮（右下角 fixed）
 * - 点击按钮 → 弹出 360×480px 圆角弹窗
 * - 无任务时整体隐藏
 * - 保留 W6-A 所有功能：任务列表、SSE 订阅、夜间批处理设置
 */
export function GlobalQueuePanel({ className: _className }: GlobalQueuePanelProps) {
  const { open, setOpen } = useGlobalTool("queue");
  const [showNightSettings, setShowNightSettings] = useState(false);
  const navigate = useNavigate();
  const overlayRef = useRef<HTMLDivElement>(null);

  // 单字段 selector，避免 zustand 无限循环
  const events = useTasksStore((s) => s.events);
  const tasksMap = useTasksStore((s) => s.tasks);
  const clearAll = useTasksStore((s) => s.clearAll);
  const pruneStaleTasks = useTasksStore((s) => s.pruneStaleTasks);

  // 2026-05-27 — panel 打开时自动 prune 僵尸任务. 用户报"没任务任务中心还一堆排队",
  // 都是历史 queued/running 没收到终态推送的死任务. 45min 未更新视为僵尸.
  useEffect(() => {
    if (open) pruneStaleTasks();
  }, [open, pruneStaleTasks]);
  // W8-sweep (2026-05-16): 单字段 selector — 避免 zustand 反模式 (CLAUDE.md 陷阱 §1)
  const nightBatch = useSettingsStore((s) => s.nightBatch);
  const currentSlug = useSessionStore((s) => s.currentSeriesSlug);
  const activeTasksRaw = useActiveTasksList();

  // 2026-05-27 — dedupe by shot_id|kind (或 element_id|kind), 让用户看不到同一镜
  // 多条重复 "废墟微光·EP05·未命名分镜·首帧 67s"+ 7 条同款. 同 shot+kind 取 started_at
  // 最新一条. 没 shot_id 的任务保持原样.
  const activeTasks = useMemo(() => {
    const byKey = new Map<string, TaskRecord>();
    const noKey: TaskRecord[] = [];
    for (const t of activeTasksRaw) {
      const k = t.shot_id ? `${t.shot_id}|${t.kind}` : t.element_id ? `element:${t.element_id}|${t.kind}` : "";
      if (!k) { noKey.push(t); continue; }
      const prev = byKey.get(k);
      if (!prev || t.started_at > prev.started_at) byKey.set(k, t);
    }
    return [...byKey.values(), ...noKey].sort((a, b) => b.started_at - a.started_at);
  }, [activeTasksRaw]);

  const failedTasks = useMemo(() => {
    // 同款 dedupe — 失败列表也去重 (同 shot+kind 取最新)
    const byKey = new Map<string, TaskRecord>();
    const noKey: TaskRecord[] = [];
    for (const t of Object.values(tasksMap)) {
      if (t.status !== "failed") continue;
      const k = t.shot_id ? `${t.shot_id}|${t.kind}` : t.element_id ? `element:${t.element_id}|${t.kind}` : "";
      if (!k) { noKey.push(t); continue; }
      const prev = byKey.get(k);
      if (!prev || t.started_at > prev.started_at) byKey.set(k, t);
    }
    return [...byKey.values(), ...noKey].sort((a, b) => b.started_at - a.started_at);
  }, [tasksMap]);

  // 2026-05-28 P0-9/23: 不再自建 SSE — App.tsx useGlobalSSE 内同一个全局 SSE client
  // 已订阅 task.* 命名事件 (走 buildTaskEventHandlers 写 tasksStore.tasks), 以及"任务
  // 完成"toast. 这里只消费 tasksStore 显示, 不重复订阅. 避免: 双 connection / 双
  // 计数 / 双 toast / HTTP/2 流浪费.

  const taskJobIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of Object.values(tasksMap)) {
      if (task.job_id) ids.add(task.job_id);
    }
    return ids;
  }, [tasksMap]);
  const legacyEvents = useMemo(
    () => Object.values(events).filter((event) => !taskJobIds.has(event.jobId)),
    [events, taskJobIds],
  );
  // BUG-27 fix: 合并到 useMemo，避免每次渲染 3 次 filter().length
  const legacyCounts = useMemo(() => {
    let running = 0;
    let queued = 0;
    let failed = 0;
    for (const event of legacyEvents) {
      if (event.status === "running") running++;
      else if (event.status === "queued") queued++;
      else if (event.status === "failed") failed++;
    }
    return { running, queued, failed };
  }, [legacyEvents]);
  const legacyRunning = legacyCounts.running;
  const legacyQueued = legacyCounts.queued;
  const legacyFailed = legacyCounts.failed;

  // tasks 是主来源；events 只补没有 task_id/job_id 对应关系的旧事件，避免双计数。
  const taskRunning = activeTasks.filter((t) => t.status === "running").length;
  const taskQueued = activeTasks.filter((t) => t.status === "queued").length;
  const taskFailed = failedTasks.length;

  const totalActive = legacyRunning + legacyQueued + taskRunning + taskQueued;
  const totalFailed = legacyFailed + taskFailed;
  const total = totalActive + totalFailed;

  // 2026-05-22 — 用户报"根本没进任务中心":
  // 旧版 seriesStats 只统计 tasksMap, 但 compose 是 await blocking 流程, 不走 task
  // 注册路径(没 registerTasksFromResponse), 只 emit SSE compose.* 事件落到 events.
  // 结果: 合成进行中 events 满载, 但 panel 仍显示"暂无活跃任务".
  // 修: events + tasks 双源并表, 同一 slug 合并(events 是 legacy job 维度, tasks 是
  // shot+kind 维度, 不会重复).
  const seriesStats = useMemo<SeriesTaskStats[]>(() => {
    const statsMap = new Map<string, SeriesTaskStats>();
    // 1) tasks 源
    for (const task of Object.values(tasksMap)) {
      if (!task.series_slug) continue;
      const current = statsMap.get(task.series_slug) || {
        slug: task.series_slug,
        queued: 0,
        running: 0,
        failed: 0,
        completed: 0,
      };
      if (task.status === "queued") current.queued += 1;
      else if (task.status === "running") current.running += 1;
      else if (task.status === "failed") current.failed += 1;
      else if (task.status === "succeeded") current.completed += 1;
      statsMap.set(task.series_slug, current);
    }
    // 2) legacy events 源 (compose / 旧 job 走这里, 不走 task 注册)
    const taskJobs = new Set<string>();
    for (const t of Object.values(tasksMap)) {
      if (t.job_id) taskJobs.add(t.job_id);
    }
    for (const evt of Object.values(events)) {
      if (taskJobs.has(evt.jobId)) continue; // 已被 tasks 计数, 跳过避免重复
      const slug = evt.series_slug || "(未分组)";
      const current = statsMap.get(slug) || { slug, queued: 0, running: 0, failed: 0, completed: 0 };
      if (evt.status === "running") current.running += 1;
      else if (evt.status === "queued") current.queued += 1;
      else if (evt.status === "failed") current.failed += 1;
      else if (evt.status === "completed") current.completed += 1;
      statsMap.set(slug, current);
    }
    return Array.from(statsMap.values()).sort((a, b) => {
      const aActive = a.running + a.queued + a.failed;
      const bActive = b.running + b.queued + b.failed;
      return bActive - aActive || a.slug.localeCompare(b.slug);
    });
  }, [tasksMap, events]);

  const isNightActive =
    nightBatch.enabled && isNightBatchActive(nightBatch.start, nightBatch.end);

  const handleClickSeries = useCallback(
    (slug: string) => {
      if (slug && slug !== "(未分组)") {
        navigate(ROUTES.seriesDetail(slug));
        setOpen(false);
      }
    },
    [navigate],
  );

  const handleClickShot = useCallback(
    (slug: string, shotId?: string, epId?: string) => {
      if (!slug || slug === "(未分组)") return;
      if (shotId && epId) {
        // W7-element-ux: 跳到 shot-stage 单镜创作页(失败时也走这条路径,user 在那里可以切模型重试)
        navigate(`/studio/${slug}/shot-stage/${epId}/${shotId}`);
      } else if (shotId) {
        // 没有 ep_id, 跳系列详情让用户自己选集（避免 hardcode "ep01" 导致 404）
        navigate(ROUTES.seriesDetail(slug));
      } else {
        navigate(ROUTES.seriesDetail(slug));
      }
      setOpen(false);
    },
    [navigate],
  );

  const handleClearCompleted = useCallback(() => {
    clearAll();
  }, [clearAll]);

  const handleGoToFailures = useCallback(() => {
    navigate("/studio");
    setOpen(false);
  }, [navigate]);

  // ── shot 反查：从 activeTasks+failedTasks 收集 (slug, epId) 组合，构建 shotIndexMap ──
  // 只在弹窗打开时加载，减少不必要请求
  const allTasks = useMemo(() => [...activeTasks, ...failedTasks], [activeTasks, failedTasks]);
  const epKeys = useMemo(() => {
    const seen = new Set<string>();
    const pairs: Array<{ slug: string; epId: string }> = [];
    for (const t of allTasks) {
      if (t.series_slug && t.ep_id) {
        const k = `${t.series_slug}::${t.ep_id}`;
        if (!seen.has(k)) { seen.add(k); pairs.push({ slug: t.series_slug, epId: t.ep_id }); }
      }
    }
    return pairs;
  }, [allTasks]);

  // 用 SWR 加载涉及的所有 episode 的 shots（利用 SWR dedupe 缓存）
  // V-1.5: 排序稳定 key，只在 open 时 fetch
  const epKeysStr = [...epKeys]
    .sort((a, b) => `${a.slug}::${a.epId}`.localeCompare(`${b.slug}::${b.epId}`))
    .map((p) => `${p.slug}::${p.epId}`)
    .join(",");

  // 2026-05-27 — episodeTitleMap: epId → episode.title, 让任务行显示"序章: 崩溃之日"而不是 "EP01"
  // 用户痛点 (agent 审计 P2 #10): 任务列表暴露技术 id, 违反 UX 铁律 #9 toC 兜底.
  // 按 slug 维度 SWR fetch (每个项目的 episodes 列表), dedupe + 30s 缓存.
  const uniqueSlugsStr = [...new Set([...epKeys].map((p) => p.slug))].sort().join(",");
  const { data: episodesBySlug } = useSWR<Record<string, Array<{ id: string; title: string; index: number }>>>(
    open && uniqueSlugsStr ? `gqp:episodes:${uniqueSlugsStr}` : null,
    async () => {
      const slugs = uniqueSlugsStr.split(",").filter(Boolean);
      const result: Record<string, Array<{ id: string; title: string; index: number }>> = {};
      await Promise.all(
        slugs.map(async (slug) => {
          try {
            const r = await apiGet<{ episodes: Array<{ id: string; title: string; index: number }> }>(
              `/api/v2/series/${encodeURIComponent(slug)}/episodes`,
            );
            result[slug] = r.episodes ?? [];
          } catch {
            result[slug] = [];
          }
        }),
      );
      return result;
    },
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
  const episodeTitleMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (!episodesBySlug) return map;
    for (const [slug, episodes] of Object.entries(episodesBySlug)) {
      for (const ep of episodes) {
        // key 用 "slug::epId" 避免不同项目同名 epId 冲突
        map[`${slug}::${ep.id}`] = ep.title || `EP${String(ep.index ?? 0).padStart(2, "0")}`;
      }
    }
    return map;
  }, [episodesBySlug]);
  const { data: shotsPages } = useSWR<Record<string, Array<{ shot_id: string }>>>(
    open && epKeys.length > 0 ? `gqp:shots:${epKeysStr}` : null,
    async () => {
      const result: Record<string, Array<{ shot_id: string }>> = {};
      await Promise.all(
        epKeys.map(async ({ slug, epId }) => {
          try {
            const r = await apiGet<{ shots: Array<{ shot_id: string }> }>(
              `/api/v2/series/${slug}/episodes/${epId}/shots`,
            );
            result[`${slug}::${epId}`] = r.shots ?? [];
          } catch {
            result[`${slug}::${epId}`] = [];
          }
        }),
      );
      return result;
    },
    { revalidateOnFocus: false, dedupingInterval: 15_000 },
  );

  // shotIndexMap: shot_id → index (0-based)
  const shotIndexMap = useMemo<Record<string, number>>(() => {
    if (!shotsPages) return {};
    const map: Record<string, number> = {};
    for (const shots of Object.values(shotsPages)) {
      shots.forEach((s, idx) => { map[s.shot_id] = idx; });
    }
    return map;
  }, [shotsPages]);

  // element 反查：用 currentSlug 加载 elements（SWR dedupe）
  const { data: elementsData } = useSWR(
    currentSlug ? `gqp:elements:${currentSlug}` : null,
    () => listElements(currentSlug!).catch(() => ({ elements: [] })),
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );

  // elementNameMap: element_id → element.name
  const elementNameMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const el of (elementsData?.elements ?? [])) {
      if (el.id && el.name) map[el.id] = el.name;
    }
    return map;
  }, [elementsData]);

  // 点击弹窗外部关闭（通过透明遮罩层）
  const handleOverlayClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) setOpen(false);
  }, []);

  // 2026-05-27 — 用户截图反馈: 任务按钮直接消失. 之前 "无任务时完全隐藏"
  // (total===0 return null) 是产品错误 — 任务中心是用户主动入口, 即使没活跃
  // 任务也应该常驻 (类似 Notion 右下角入口 / VSCode 状态栏), 否则用户:
  //   - 想看历史失败找不到入口
  //   - 想了解任务系统找不到按钮
  //   - 平时看见的按钮突然没了, 怀疑系统坏了
  // QueueBubble 自带"灰色 fallback 颜色 + '任务' 文字"应付 total===0 状态, 不需要
  // 隐藏整个组件. 删 return null, 让 QueueBubble 永远显示.

  return (
    <>
      {/* 弹出层（含透明遮罩） */}
      {open && (
        <div
          ref={overlayRef}
          onClick={handleOverlayClick}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 199,
            // 透明遮罩，点击外部关闭
          }}
        >
          <QueuePopover
            onClose={() => setOpen(false)}
            runningCount={legacyRunning}
            queuedCount={legacyQueued}
            taskRunning={taskRunning}
            taskQueued={taskQueued}
            failedCount={legacyFailed}
            taskFailed={taskFailed}
            isNightActive={isNightActive}
            seriesStats={seriesStats}
            activeTasks={activeTasks}
            failedTasks={failedTasks}
            showNightSettings={showNightSettings}
            onToggleNightSettings={() => setShowNightSettings((v) => !v)}
            onClickSeries={handleClickSeries}
            onClickShot={handleClickShot}
            onClearCompleted={handleClearCompleted}
            onGoToFailures={handleGoToFailures}
            shotIndexMap={shotIndexMap}
            elementNameMap={elementNameMap}
            episodeTitleMap={episodeTitleMap}
          />
        </div>
      )}

      {/* 右下角圆形悬浮按钮（弹窗打开时隐藏，避免重叠） */}
      {!open && (
        <QueueBubble
          onClick={() => setOpen(true)}
          totalActive={totalActive}
          totalFailed={totalFailed}
          hasActive={totalActive > 0}
        />
      )}
    </>
  );
}
