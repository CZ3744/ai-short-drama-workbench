/**
 * AutoPipelineProgressPanel — 一键自动管线进度面板.
 *
 *   显示 3 个 stage (firstframes / videos / compose), 每 stage:
 *     - 名称 + 状态图标 (pending / running / done / failed / aborted / skipped)
 *     - 进度条 (completed/total) + 百分比
 *     - 失败/aborted 时给"重试该阶段" / "中断 (running 时)"
 *   - 顶部状态条
 *   - 完成时显示 "已就绪 — 进入合成页查看" 跳转按钮 (由父组件传 onDone)
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";
import { Button } from "../ui/button";
import { Icon } from "../shared/Icon";
import { Progress } from "../ui/progress";
import { formatBeijingTime } from "../../lib/format";
import { labelShotId, friendlyTaskError } from "../../lib/sourceLabels";
import type {
  AutoPipelineRecord,
  AutoPipelineStage,
  AutoPipelineStageState,
} from "../../lib/autoPipelineApi";
// 2026-05-26 单条重抽走独立 API — pipeline running 时点重抽不再 abort 整条 pipeline.
// 用户体验: 跟"加入队列"一致, 失败那张并行重抽, 其他正在跑的图继续跑.
import {
  retryFailedElementBriefIndependent,
  retryFailedShotFirstframeIndependent,
  retryFailedShotVideoIndependent,
} from "../../lib/autoPipelineRetry";

const STAGE_LABEL: Record<AutoPipelineStage, string> = {
  element_images: "1. 生成素材图 (角色 / 场景 等)",
  firstframes: "2. 生成所有首帧",
  videos: "3. 生成所有视频",
  compose: "4. 合成成片",
};

// 2026-05-19 toC 文案: 改自含 "image_briefs / i2v / ffmpeg / concat / TTS" 等技术词 — 用户原话"所有地方的表述要 toC"
const STAGE_HINT: Record<AutoPipelineStage, string> = {
  element_images: "为每个素材按顺序抽参考图, 后面的图会接前一张保持五官一致",
  firstframes: "为每个镜头生成首帧画面, 自动并行加速",
  videos: "把首帧推演成视频片段, 自动并行加速",
  compose: "配上语音和字幕, 拼接成最终成片",
};

const STATUS_LABEL: Record<AutoPipelineStageState["status"], string> = {
  pending: "等待中",
  running: "进行中",
  done: "已完成",
  failed: "失败",
  aborted: "已中断",
  skipped: "跳过",
};

const STATUS_COLOR: Record<AutoPipelineStageState["status"], string> = {
  pending: "var(--ink-500)",
  running: "var(--brand-600)",
  done: "var(--ok)",
  failed: "var(--err)",
  aborted: "var(--ink-600)",
  skipped: "var(--ink-400)",
};

export interface AutoPipelineProgressPanelProps {
  record: AutoPipelineRecord;
  /** 父组件管中断 */
  onAbort?: () => void;
  /**
   * 父组件管 retry-stage.
   * 2026-05-19 反馈 #2: 第 2 个参数 opts.shot_ids / opts.element_ids 用于"只重抽失败的子集".
   *   - element_images stage failed → opts.element_ids
   *   - firstframes / videos stage failed → opts.shot_ids
   *   - compose stage failed 或 opts 不传 → 走整 stage 重跑(原行为)
   */
  onRetryStage?: (
    stage: AutoPipelineStage,
    opts?: { shot_ids?: string[]; element_ids?: string[] },
  ) => void;
  /**
   * 父组件管"完成后进入合成页" — pipeline.done 时显示这个 CTA.
   * 仅在 record.options.only_element_images !== true 时显示
   * (素材图模式没有 firstframes/videos/final.mp4, 跳合成页是空白页).
   */
  onJumpToCompose?: () => void;
  /**
   * 2026-05-19 #A: 父组件管"完成后查看素材库" — 当 record.options.only_element_images=true 时
   * 显示此按钮替代 onJumpToCompose. 跳到 /studio/:slug/elements 让用户看刚补全的图.
   */
  onJumpToElements?: () => void;
  /** 父组件管关闭面板 (aborted / failed 时给 reset) */
  onClose?: () => void;
  /** 父组件持锁 pending (启动 / abort / retry 中) */
  pending?: boolean;
  /**
   * 2026-05-26: 该剧最近一段时间的全部 pipeline 列表 — 用来在左侧渲染"本次批次"全貌.
   * 父组件调 listAutoPipelines(slug) 拿. length > 1 时显示左栏, 单集就藏起来.
   */
  allPipelines?: AutoPipelineRecord[];
  /** 该剧全部集列表 (含 title/index), 配合 allPipelines 渲染左栏集卡 */
  episodes?: Array<{ id: string; title?: string; index?: number; episode_number?: number }>;
  /** 点击左栏某集卡 → 切换当前选中集 (父组件通常 navigate URL) */
  onSwitchEpisode?: (epId: string) => void;
}

export function AutoPipelineProgressPanel({
  record, onAbort, onRetryStage, onJumpToCompose, onJumpToElements, onClose, pending,
  allPipelines, episodes, onSwitchEpisode,
}: AutoPipelineProgressPanelProps) {
  const status = record.status;
  const isRunning = status === "running";
  const isDone = status === "done";
  const isFailed = status === "failed";
  const isAborted = status === "aborted";
  // 2026-05-19 #A: only_element_images 模式没有 firstframes/videos/compose 产出, 完成态 CTA 改成"查看素材库"
  const isElementImagesOnly = record.options?.only_element_images === true;

  // 2026-05-26 单条独立重抽状态 — key = `${stage}:${target_id}:${sub_index}`,
  //   "retrying" 重抽中 (按钮 spinner), "queued" 已加入(成功调起独立任务, 行变灰).
  //   pipeline SSE 不感知独立重抽, 我们在前端本地追踪.
  const [independentRetryState, setIndependentRetryState] = useState<
    Record<string, "retrying" | "queued">
  >({});

  // 2026-05-26: record.pipeline_id 切换 (用户切集 / 重启 pipeline) 时, 清空旧 pipeline 的
  // 重抽状态. 否则切到其他集仍会显示"已加入重抽队列"残留 marker, 跟新 pipeline 失败明细对不上.
  useEffect(() => {
    setIndependentRetryState({});
  }, [record.pipeline_id]);

  // 2026-05-26 修总进度算法 — 用户报告"5/5 全失败但显示已完成 100%":
  // 后端 firstframes stage 跑完无论成败都标 status=done, 前端把 done 当满进度
  // 是错的. 必须按"成功的占比"算, failed 部分不算进度.
  //   skipped (真跳过没东西要跑) → +1 满
  //   done/running/failed 都按 completed/total 算 — failed 部分不贡献进度
  //   total=0 且 done → +1 满 (退化, 兼容没 task 的 stage)
  //   pending → 0
  const overallProgress = useMemo(() => {
    const stageCount = record.stages.length || 1;
    let sum = 0;
    for (const st of record.stages) {
      if (st.status === "skipped") {
        sum += 1;
        continue;
      }
      if (st.total === 0) {
        if (st.status === "done") sum += 1;
        continue;
      }
      sum += Math.min(1, st.completed / st.total);
    }
    return Math.round((sum / stageCount) * 100);
  }, [record.stages]);

  // 2026-05-26 加 totalCompleted — 完成态 UI 拆分"全集已就绪 / 部分完成 / 全部失败"
  const totalCompleted = useMemo(
    () => record.stages.reduce((acc, s) => acc + s.completed, 0),
    [record.stages],
  );

  // 2026-05-19 反馈 #2: 计算所有"有失败"的 stage 列表 (含 status=done 但 failed>0 的, 不仅是 failed/aborted)
  //   — 这是关键: 用户截图就是 "3/4 (1 失败)" stage.status=done 但 failed=1 ,
  //     之前 UI 没给 CTA, 现在补上
  const failedStages = useMemo(
    () => record.stages.filter((s) => s.failed > 0),
    [record.stages],
  );
  const totalFailed = useMemo(
    () => failedStages.reduce((acc, s) => acc + s.failed, 0),
    [failedStages],
  );

  // 2026-05-26 完成态本质判定 — 后端 stage 跑完无论成败都标 done, 这里看 failed/completed 拆 3 档:
  const pipelineAllFailed = isDone && totalFailed > 0 && totalCompleted === 0;
  const pipelinePartial = isDone && totalFailed > 0 && totalCompleted > 0;
  const pipelineTrulyDone = isDone && totalFailed === 0;

  /**
   * 一键"重试失败的 N 项": 遍历所有有失败的 stage, 按 stage 类型组装 options
   *   - element_images → element_ids: stage.failed_ids
   *   - firstframes / videos → shot_ids: stage.failed_ids
   *   - compose → 整 stage 重跑(没有 ids)
   * 串行调 onRetryStage — 多 stage 失败时一次只重抽一个 stage, 用户看进度跑完后可再点.
   * 现实里同时多 stage 失败的情况罕见 (stage 串行执行, 上一个全失败下一个就跳过了),
   * 简化: 只重抽第一个 failed stage 的失败子集.
   */
  function handleRetryAllFailed() {
    if (!onRetryStage || failedStages.length === 0) return;
    const firstFailed = failedStages[0];
    const ids = firstFailed.failed_ids ?? [];
    if (firstFailed.id === "element_images") {
      onRetryStage("element_images", ids.length > 0 ? { element_ids: ids } : undefined);
    } else if (firstFailed.id === "firstframes" || firstFailed.id === "videos") {
      onRetryStage(firstFailed.id, ids.length > 0 ? { shot_ids: ids } : undefined);
    } else {
      // compose stage 或没 ids — 走整 stage 重跑
      onRetryStage(firstFailed.id);
    }
  }

  // 2026-05-26 UI 紧凑重设计 — 用户原话"横向有点长". 改:
  //   - panel max-width 880px + 居中, 不再跨满屏
  //   - 顶部标题/时间/总进度/actions 合并到一行 (标题左/进度中/按钮右),
  //     省一行垂直空间; 窄屏自适应 flex-wrap
  //   - stage 卡片改紧凑:名称+状态徽章+进度条+计数 同一行, 描述行可省
  // 2026-05-26 卡片质感 — 用户原话"做出卡片质感, 像 app store 那样":
  //   - 主卡: 多层柔和阴影 (shadow-lg) + 大圆角 16 + 微妙渐变背景 (顶部白底部更白)
  //     + 几乎不见的极淡边框 (rgba 0.04) 让卡边缘可辨但不喧宾夺主
  //   - 顶部高光: 1px 内嵌 inset, 模拟玻璃表面反光
  //   - 内部 stage 卡: 浅米底 (--ink-50) + 无边框, 跟主卡形成层次差,
  //     像 App Store"sub-section"那样融入而非画框
  // 2026-05-26 双栏布局 — 用户原话"做成左右两部分:批次全貌 + 当前集详情":
  //   batch 启动多集时 allPipelines.length > 1, 左侧 240px 卡片展示
  //   "本次任务·总进度·集列表", 右侧主卡展示当前集详情. 单集模式 (allPipelines<=1)
  //   只显示主卡, 不占左侧空间.
  // 2026-05-26 修"同一集多个历史 pipeline 重复列出": 一个剧曾跑过多次 (retry / abort 后重启),
  //   listAutoPipelines 返回全部历史 pipeline. 按 episode_id 去重, 每集只保留最新 started_at 的.
  //   2026-05-26 修"左栏跟 hook record 短暂脱节" (P1 bug): allPipelines 5s 轮询,
  //   hook record 是 SSE 实时更新, 当前集用 hook record 替换 dedup 数据避免左栏显示
  //   "旧 aborted 100% 失败" 而右栏是"新 running 0%" 的视觉脱节.
  const dedupedByEpisode = useMemo(() => {
    const map = new Map<string, AutoPipelineRecord>();
    for (const p of allPipelines ?? []) {
      const existing = map.get(p.episode_id);
      if (!existing || (p.started_at ?? "") > (existing.started_at ?? "")) {
        map.set(p.episode_id, p);
      }
    }
    // hook record 是当前集最新数据 (SSE 实时), 优先于 5s 轮询拉到的 allPipelines
    if (record?.episode_id) {
      const existing = map.get(record.episode_id);
      if (!existing || (record.started_at ?? "") >= (existing.started_at ?? "")) {
        map.set(record.episode_id, record);
      }
    }
    return [...map.values()];
  }, [allPipelines, record]);
  const showBatchSidebar = dedupedByEpisode.length > 1;
  const batchTotal = dedupedByEpisode.length;
  // 2026-05-27 修"5 集 5 完成 100% 但右侧 1 失败"矛盾:
  //   后端 pipeline.status 跑完无论成败都标 "done", batchDoneCount 之前直接用
  //   status==="done" → 1 集明明有 1 失败仍算"完成", 用户看左 100% 右 50% 困惑.
  //   现按 stages 看真"成功完成":status=done 且 stages 全部 failed=0 才算 done;
  //   有 failed 的归"部分完成"(算半个 partial 完成); 否则跑中/失败/等待.
  function epIsTrulyDone(p: AutoPipelineRecord): boolean {
    if (p.status !== "done") return false;
    return (p.stages ?? []).every((s) => (s.failed ?? 0) === 0);
  }
  function epHasFailedButDone(p: AutoPipelineRecord): boolean {
    if (p.status !== "done") return false;
    return (p.stages ?? []).some((s) => (s.failed ?? 0) > 0);
  }
  const batchDoneCount = dedupedByEpisode.filter(epIsTrulyDone).length;
  const batchPartialCount = dedupedByEpisode.filter(epHasFailedButDone).length;
  const batchRunningCount = dedupedByEpisode.filter((p) => p.status === "running").length;
  const batchFailedCount = dedupedByEpisode.filter((p) => p.status === "failed" || p.status === "aborted").length + batchPartialCount;
  const batchOverall = batchTotal > 0 ? Math.round((batchDoneCount / batchTotal) * 100) : 0;
  function batchStatusLabel(s: AutoPipelineRecord["status"]): { label: string; color: string } {
    switch (s) {
      case "running": return { label: "跑中", color: "var(--brand-600)" };
      case "done": return { label: "完成", color: "var(--ok)" };
      case "failed": return { label: "失败", color: "var(--err)" };
      case "aborted": return { label: "中断", color: "var(--ink-600)" };
      default: return { label: "等待", color: "var(--ink-500)" };
    }
  }
  // 2026-05-26 用户原话"做成一个大 tab, 然后中间用分割线分开左右两部分,
  // 而不是现在这种放两个 tab 在左右": 单卡布局 — 外层一个大 mk-card 套两栏,
  // 中间 1px 竖线分割. 左栏不再独立卡(去掉自己的阴影/边框/渐变), 融入大卡内部.
  return (
    <div
      className="auto-pipeline-progress-panel"
      style={{
        maxWidth: showBatchSidebar ? 1140 : 880,
        margin: "0 auto",
        width: "100%",
        background: "linear-gradient(180deg, #ffffff 0%, #fcfbf8 100%)",
        border: "1px solid rgba(0,0,0,0.04)",
        borderRadius: 16,
        boxShadow: "0 1px 3px rgba(120, 100, 80, 0.05), 0 8px 24px rgba(120, 100, 80, 0.06), inset 0 1px 0 rgba(255,255,255,0.8)",
        display: "flex",
        alignItems: "stretch",
        overflow: "hidden",
      }}
    >
      {showBatchSidebar && (
        <aside
          style={{
            flexShrink: 0,
            width: 280,
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            borderRight: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          {/* 2026-05-26 用户原话"只写进度条就行了, 放在一个卡片里左右而不是两个卡片左右,
              这样每个都列出来多难看啊, 还占地方":
              改成同卡内紧凑行列表, 每集就一行 "第N集 进度条 % 状态", 无独立背景 + 无 border.
              当前选中行才有米色高亮 + 左侧 brand 色细条提示. */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)" }}>
              本次任务
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-500)" }}>
              {batchTotal} 集 · {batchDoneCount} 完成
              {batchRunningCount > 0 && ` · ${batchRunningCount} 跑中`}
              {batchFailedCount > 0 && (
                <span style={{ color: "var(--err)" }}> · {batchFailedCount} 失败</span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <Progress value={batchOverall} className="flex-1" />
            <span style={{ fontSize: 11, color: "var(--ink-600)", minWidth: 28, textAlign: "right" }}>
              {batchOverall}%
            </span>
          </div>
          <div style={{ height: 1, background: "rgba(0,0,0,0.06)", margin: "2px 0" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 0, maxHeight: 400, overflowY: "auto" }}>
            {dedupedByEpisode
              .slice()
              .sort((a, b) => {
                const ea = episodes?.find((e) => e.id === a.episode_id);
                const eb = episodes?.find((e) => e.id === b.episode_id);
                const ia = (ea?.index ?? ea?.episode_number ?? 0) as number;
                const ib = (eb?.index ?? eb?.episode_number ?? 0) as number;
                return ia - ib;
              })
              .map((p) => {
                const ep = episodes?.find((e) => e.id === p.episode_id);
                const epIndex = ep?.index ?? ep?.episode_number ?? p.episode_id.replace(/^ep0*/, "");
                const isActive = p.episode_id === record.episode_id;
                // 2026-05-27 — status=done 但有 failed 时标签显示"有失败"(red), 不再显示"完成"
                // 让用户看左栏行就知道哪集还需要 retry, 不必点进去看右栏才发现.
                const hasFailedInThisEp = epHasFailedButDone(p);
                const sLabel = hasFailedInThisEp
                  ? { label: "有失败", color: "var(--err)" }
                  : batchStatusLabel(p.status);
                const epStages = p.stages ?? [];
                // 2026-05-27 跟 overallProgress 算法对齐 — 之前 status=done 直接算 +1 满进度,
                // 但 stage 5/5 全失败时后端也标 status=done → 这集 100% 假完成. 现按 completed/total
                // 算真"成功占比", failed 部分不贡献进度.
                const epStageCount = epStages.length || 1;
                const epProgressSum = epStages.reduce((acc, s) => {
                  if (s.status === "skipped") return acc + 1;
                  if (s.total === 0) {
                    if (s.status === "done") return acc + 1;
                    return acc;
                  }
                  return acc + Math.min(1, s.completed / s.total);
                }, 0);
                const epProgress = Math.round((epProgressSum / epStageCount) * 100);
                return (
                  <button
                    key={p.pipeline_id}
                    type="button"
                    onClick={() => onSwitchEpisode?.(p.episode_id)}
                    disabled={!onSwitchEpisode}
                    style={{
                      textAlign: "left",
                      padding: "8px 11px",
                      // 2026-05-26 用户原话"选中的卡片质感很差, 就一个左边像 { 的就没了":
                      // 改成完整包围 — 选中时米底 + brand-200 描边 + 微妙阴影, 像 App Store 选中项
                      background: isActive ? "var(--brand-50, #fff5ed)" : "transparent",
                      border: "1px solid",
                      borderColor: isActive ? "var(--brand-200, #f0b48a)" : "transparent",
                      boxShadow: isActive
                        ? "0 1px 2px rgba(217,119,87,0.08), inset 0 1px 0 rgba(255,255,255,0.6)"
                        : "none",
                      borderRadius: 8,
                      cursor: onSwitchEpisode ? "pointer" : "default",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                    title={ep?.title ? `第 ${epIndex} 集 · ${ep.title}` : `第 ${epIndex} 集`}
                  >
                    <span style={{
                      fontSize: 11.5, fontWeight: 600, color: "var(--ink-900)",
                      minWidth: 38, flexShrink: 0,
                    }}>
                      第{epIndex}集
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Progress value={epProgress} className="flex-1" />
                    </div>
                    <span style={{
                      fontSize: 10, color: "var(--ink-500)",
                      minWidth: 28, textAlign: "right", flexShrink: 0,
                    }}>
                      {epProgress}%
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 600, color: sLabel.color,
                      minWidth: 28, textAlign: "right", flexShrink: 0,
                    }}>
                      {sLabel.label}
                    </span>
                  </button>
                );
              })}
          </div>
        </aside>
      )}
    {/* 2026-05-26 右栏 (当前集详情): 单卡布局下不再独立卡, 去掉 background/shadow/border,
        融入外层大卡; padding 保留. */}
    <div
      style={{
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        flex: 1,
        minWidth: 0,
      }}
    >
      {/* 顶部一行: 状态图标+标题+时间 · 总进度条 · actions — 一行省垂直空间 */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {isRunning && <Icon name="refresh" size={16} className="animate-spin" />}
          {isDone && <Icon name="checkCircle" size={16} style={{ color: "var(--ok)" }} />}
          {isFailed && <Icon name="warning" size={16} style={{ color: "var(--err)" }} />}
          {isAborted && <Icon name="pause" size={16} style={{ color: "var(--ink-600)" }} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)", whiteSpace: "nowrap" }}>
              {isRunning ? "一键自动生成进行中" : null}
              {/* 2026-05-26 用户报告"5/5 全失败显示已就绪 100%" — 完成态拆三档判断真正状态 */}
              {pipelineTrulyDone && isElementImagesOnly ? "素材图已补全" : null}
              {pipelineTrulyDone && !isElementImagesOnly ? "全集已就绪" : null}
              {pipelinePartial ? (
                <span style={{ color: "var(--warn, #b8860b)" }}>部分完成 · {totalFailed} 项失败</span>
              ) : null}
              {pipelineAllFailed ? (
                <span style={{ color: "var(--err)" }}>全部失败,需重试</span>
              ) : null}
              {isFailed ? "自动生成失败" : null}
              {isAborted ? "已中断" : null}
            </div>
            {/* 铁律 #9 toC 兜底: 不暴露 pipeline_id hash; 改用启动时间让用户识别. 时区强制北京. */}
            <div style={{ fontSize: 11, color: "var(--ink-500)", whiteSpace: "nowrap" }}>
              {record.started_at
                ? `${formatBeijingTime(record.started_at, { mode: "short" })} 启动`
                : "本次任务"}
            </div>
          </div>
        </div>

        {/* 总进度条 — 占中间剩余空间, 跟标题/按钮同一行 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 180 }}>
          <Progress value={overallProgress} className="flex-1" />
          <span style={{ fontSize: 11, color: "var(--ink-600)", minWidth: 32, textAlign: "right" }}>
            {overallProgress}%
          </span>
        </div>

        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {isRunning && (
            <Button variant="secondary" size="sm" onClick={onAbort} disabled={pending}>
              <Icon name="pause" size={12} />
              中断
            </Button>
          )}
          {/* 2026-05-19 反馈 #2: 完成态有 stage failed>0 时优先显示"重试失败的 N 项" */}
          {(isDone || isFailed) && totalFailed > 0 && onRetryStage && (
            <Button variant="primary" size="sm" onClick={handleRetryAllFailed} disabled={pending}>
              <Icon name="refresh" size={12} />
              重试失败 {totalFailed}
            </Button>
          )}
          {isDone && isElementImagesOnly && onJumpToElements && totalCompleted > 0 && (
            <Button
              variant={totalFailed > 0 ? "secondary" : "primary"}
              size="sm"
              onClick={onJumpToElements}
            >
              <Icon name="arrowRight" size={12} />
              查看素材库
            </Button>
          )}
          {/* 2026-05-26 totalCompleted === 0 (全失败) 不显示"进合成页" — 没有图可合成, 按钮误导 */}
          {isDone && !isElementImagesOnly && onJumpToCompose && totalCompleted > 0 && (
            <Button
              variant={totalFailed > 0 ? "secondary" : "primary"}
              size="sm"
              onClick={onJumpToCompose}
            >
              <Icon name="arrowRight" size={12} />
              进合成页
            </Button>
          )}
          {(isAborted || isFailed) && onClose && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              <Icon name="close" size={12} />
              关闭
            </Button>
          )}
        </div>
      </div>

      {/* 各 stage — 紧凑单行版: 序号 + 名称 + 进度条 + 计数 + 状态 + 重试 全部同一行 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {record.stages.map((stage, idx) => (
          <div
            key={stage.id}
            style={{
              padding: "10px 14px",
              // 2026-05-26 App Store 质感: 浅米底无边框, 跟主卡的纯白形成层次,
              // 像 sub-section 融入而非画框
              background: "var(--ink-50)",
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {/* 序号 + 名称 — 固定宽度, 让进度条对齐 */}
              <div
                style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-900)", minWidth: 168, flexShrink: 0 }}
                title={STAGE_HINT[stage.id]}
              >
                <span style={{ color: "var(--ink-400)", marginRight: 4 }}>{idx + 1}.</span>
                {STAGE_LABEL[stage.id].replace(/^\d+\.\s*/, "")}
              </div>

              {/* 进度条 — 占剩余宽度. running/done/skipped 都显示, failed 显示满条红色感. */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 100 }}>
                <Progress
                  value={stage.total > 0 ? Math.round((stage.completed / stage.total) * 100) : (stage.status === "done" || stage.status === "skipped" ? 100 : 0)}
                  className="flex-1"
                />
                <span style={{ fontSize: 11, color: "var(--ink-600)", minWidth: 44, textAlign: "right", whiteSpace: "nowrap" }}>
                  {stage.total > 0
                    ? `${stage.completed}/${stage.total}`
                    : (stage.status === "done" || stage.status === "skipped" ? "—" : "·")}
                </span>
              </div>

              {/* 状态徽章 */}
              <span style={{ fontSize: 11, fontWeight: 600, color: STATUS_COLOR[stage.status], minWidth: 40, textAlign: "right" }}>
                {STATUS_LABEL[stage.status]}
              </span>

              {/* 失败/中断 重试按钮 */}
              {(stage.status === "failed" || stage.status === "aborted") && onRetryStage && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const ids = stage.failed_ids ?? [];
                    if (ids.length > 0 && stage.id === "element_images") {
                      onRetryStage(stage.id, { element_ids: ids });
                    } else if (ids.length > 0 && (stage.id === "firstframes" || stage.id === "videos")) {
                      onRetryStage(stage.id, { shot_ids: ids });
                    } else {
                      onRetryStage(stage.id);
                    }
                  }}
                  disabled={pending}
                  title={(stage.failed_ids?.length ?? 0) > 0 ? `重试失败的 ${stage.failed_ids?.length} 项` : "重试该阶段"}
                >
                  <Icon name="refresh" size={12} />
                  重试
                </Button>
              )}
            </div>

            {/* 失败 / 跳过 标签行 — 仅有数字时显示 */}
            {(stage.failed > 0 || (stage.skipped_count ?? 0) > 0) && (
              <div style={{ display: "flex", gap: 8, fontSize: 10.5, color: "var(--ink-500)", paddingLeft: 178 }}>
                {stage.failed > 0 && (
                  <span style={{ color: "var(--err)" }}>{stage.failed} 失败</span>
                )}
                {(stage.skipped_count ?? 0) > 0 && (
                  <span>{stage.skipped_count} 跳过</span>
                )}
              </div>
            )}

            {/* 错误 */}
            {stage.status === "failed" && stage.error && (
              <div style={{ fontSize: 11, color: "var(--err)", padding: "4px 8px", background: "var(--err-50)", borderRadius: 4 }}>
                {stage.error}
              </div>
            )}

            {/* 2026-05-22 bug B 修: 失败明细列表 — 让用户知道具体哪张 + 原因 (而非只看到 element 名).
                W11 C4 (2026-05-27): 每条明细右侧加"重抽这一镜"按钮 — 失败镜就地重试, 不离开面板.
                老路径: 关进度面板 → 回 grid → 找失败镜 → 进去重抽 (4 步).
                新路径: 直接点行尾按钮 → 单条重试 (1 步). 重试成功该项就消失. */}
            {(stage.failed_details?.length ?? 0) > 0 && (
              <div style={{
                fontSize: 11,
                color: "var(--err)",
                padding: "6px 10px",
                background: "var(--err-50, rgba(220,38,38,0.06))",
                borderRadius: 4,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}>
                <div style={{ fontWeight: 600 }}>失败明细 ({stage.failed_details?.length} 项)</div>
                {(stage.failed_details ?? []).slice(0, 10).map((d, idx) => {
                  // 2026-05-26 单条独立重抽 — 关键改造:
                  //   旧: 调 onRetryStage → 后端 force abort 整条 pipeline 重启 (打断 12 张正跑的图)
                  //   新: 调独立 generate API → 跟 pipeline 并行, 加入失败队列重抽, 不动其他正在跑的任务
                  const itemKey = `${stage.id}:${d.target_id}:${d.sub_index ?? 0}`;
                  const itemState = independentRetryState[itemKey];
                  const isRetrying = itemState === "retrying";
                  const isQueued = itemState === "queued";
                  const canRetrySingle = !pending && !isRetrying && !isQueued && !!d.target_id &&
                    (stage.id === "firstframes" || stage.id === "videos" || stage.id === "element_images");

                  const handleSingleRetry = async () => {
                    if (!d.target_id) return;
                    setIndependentRetryState((prev) => ({ ...prev, [itemKey]: "retrying" }));
                    // 2026-05-26 修"找不到模型"bug: 用户启动 pipeline 时已经选了 image/video 模型,
                    // 单条重抽透传给独立 API, 不依赖 series.defaults fallback (用户截图证明 fallback 漏)
                    const imageModel = record.options?.image_provider_id ?? null;
                    const videoModel = record.options?.video_provider_id ?? null;
                    let result: { ok: true } | { ok: false; error: string };
                    if (stage.id === "element_images") {
                      result = await retryFailedElementBriefIndependent(
                        record.series_slug,
                        d.target_id,
                        d.sub_index,
                        imageModel,
                      );
                    } else if (stage.id === "firstframes") {
                      result = await retryFailedShotFirstframeIndependent(
                        record.series_slug,
                        record.episode_id,
                        d.target_id,
                        imageModel,
                      );
                    } else if (stage.id === "videos") {
                      result = await retryFailedShotVideoIndependent(
                        record.series_slug,
                        record.episode_id,
                        d.target_id,
                        videoModel,
                      );
                    } else {
                      result = { ok: false, error: "未知阶段" };
                    }

                    if (result.ok) {
                      setIndependentRetryState((prev) => ({ ...prev, [itemKey]: "queued" }));
                      // 2026-05-27 后端 firstframes/videos stage 的 failed_details 只填 target_id (shot_id),
                      //   不带 target_name. 这里 fallback 用 labelShotId 翻译"分镜 N", 不暴露 s0001_xxx 技术字符串.
                      const isShotStage = stage.id === "firstframes" || stage.id === "videos";
                      const fallbackLabel = isShotStage ? labelShotId(d.target_id) : d.target_id;
                      const itemLabel = `${d.target_name ?? fallbackLabel}${d.sub_label ? ` · ${d.sub_label}` : ""}`;
                      toast.success(`${itemLabel} 已加入重抽队列, 跟主流程并行跑`, { duration: 4000 });
                    } else {
                      setIndependentRetryState((prev) => {
                        const next = { ...prev };
                        delete next[itemKey];
                        return next;
                      });
                      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译 (result.error 走 translate 给 toC 提示)
                      showErrorToast(result.error, "重抽失败");
                    }
                  };

                  return (
                    <div
                      key={idx}
                      style={{
                        lineHeight: 1.4,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        opacity: isQueued ? 0.55 : 1,
                      }}
                    >
                      <span style={{ flex: 1 }}>
                        · {d.target_name ?? ((stage.id === "firstframes" || stage.id === "videos") ? labelShotId(d.target_id) : d.target_id)}
                        {d.sub_label ? ` · 第 ${(d.sub_index ?? 0) + 1} 张「${d.sub_label}」` : ""}
                        {": "}
                        <span style={{ opacity: 0.85 }}>{friendlyTaskError(d.error)}</span>
                        {isQueued && (
                          <span style={{ marginLeft: 6, color: "var(--ok)", fontWeight: 600 }}>
                            · 已加入重抽队列
                          </span>
                        )}
                      </span>
                      {canRetrySingle && (
                        <button
                          type="button"
                          onClick={() => void handleSingleRetry()}
                          disabled={pending}
                          style={{
                            flexShrink: 0,
                            padding: "2px 8px",
                            borderRadius: 4,
                            background: "#fff",
                            border: "1px solid var(--err, #dc2626)",
                            color: "var(--err, #dc2626)",
                            fontSize: 10.5,
                            fontWeight: 600,
                            cursor: pending ? "not-allowed" : "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 3,
                            opacity: pending ? 0.5 : 1,
                          }}
                          title="独立重抽这一条 — 跟主流程并行, 不打断其他正在跑的任务"
                        >
                          <Icon name="refresh" size={9} /> 重抽这一{stage.id === "element_images" ? "条" : "镜"}
                        </button>
                      )}
                      {isRetrying && (
                        <span
                          style={{
                            flexShrink: 0,
                            padding: "2px 8px",
                            fontSize: 10.5,
                            color: "var(--ink-500)",
                          }}
                        >
                          加入队列中…
                        </span>
                      )}
                    </div>
                  );
                })}
                {(stage.failed_details?.length ?? 0) > 10 && (
                  <div style={{ opacity: 0.65 }}>… 还有 {(stage.failed_details?.length ?? 0) - 10} 项</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 完成时提示 */}
      {isDone && record.final_video_path && (
        <div style={{
          padding: "8px 12px",
          background: "var(--ok-50)",
          border: "1px solid var(--ok)",
          borderRadius: 6,
          fontSize: 12,
          color: "var(--ok)",
        }}>
          成片已生成: {record.final_video_path}
        </div>
      )}
    </div>
    </div>
  );
}
