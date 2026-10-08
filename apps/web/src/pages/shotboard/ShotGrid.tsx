// 拆自 ShotboardPage.tsx — 分镜列表区域(toolbar + AutoPipeline 横幅/进度 + 卡片网格 + 末尾"添加分镜"占位).
//
// 主页面把 useShots/useAutoPipeline/selectedIds/拖拽 state 都提取出来传入,
// 该组件不直接调 API、不持有业务状态(纯渲染 + 透传回调)。
//
// W10 (2026-05-26): 加视图切换 (列表 / 九宫格 / 时间线) + 整集状态条.
//   列表视图复用原 ShotCard (含拖拽 + 勾选 + ⋯ 菜单);
//   九宫格 / 时间线视图轻量 — 不参与拖拽, 用户想拖排序请切回列表.
import { useEffect, useMemo, useRef, useState } from "react";
import type { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { Empty } from "../../components/ui/empty";
import { Icon } from "../../components/shared/Icon";
import { ROUTES } from "../../lib/routes";
import { invalidateShots } from "../../lib/swrInvalidate";
import { PickerFullscreenView } from "./PickerFullscreenView";
import { AutoPipelineLauncher } from "../../components/auto-pipeline/AutoPipelineLauncher";
import { AutoPipelineProgressPanel } from "../../components/auto-pipeline/AutoPipelineProgressPanel";
import type { useAutoPipeline } from "../../hooks/useAutoPipeline";
import type { EpisodeRecord } from "../../lib/api";
import type { Shot } from "../../hooks/useShots";
import { ShotCard } from "./parts/ShotCard";
import { useSeries } from "../../hooks/useSeries";
import { seriesAspectToCss } from "../../lib/aspectRatio";
import { ShotboardViewSwitcher, loadView, saveView, type ShotboardView } from "./parts/ShotboardViewSwitcher";
import { ShotBoardView } from "./parts/ShotBoardView";
import { ShotTimelineView } from "./parts/ShotTimelineView";
import { EpisodeStatusBar } from "./parts/EpisodeStatusBar";

type AutoPipeline = ReturnType<typeof useAutoPipeline>;

export function ShotGrid({
  slug,
  selectedEpId,
  selectedEpisode,
  episodes,
  pickerMode,
  loadingShots,
  shotsError,
  orderedShots,
  dragId,
  dragOverId,
  hasShotSelected,
  toggleShotId,
  allSelected,
  someSelected,
  selectAll,
  clearSelect,
  creatingShot,
  navigate,
  autoPipeline,
  onCreateShot,
  onInsertAfter,
  onSingleDelete,
  onDeleteEpisode,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  slug: string;
  selectedEpId: string;
  selectedEpisode: EpisodeRecord | null;
  /** 2026-05-26: 整部剧批量启动用 — launcher 拿全部集列表给"整部剧"选项 */
  episodes: EpisodeRecord[];
  pickerMode: boolean;
  loadingShots: boolean;
  shotsError: unknown;
  orderedShots: Shot[];
  dragId: string | null;
  dragOverId: string | null;
  hasShotSelected: (id: string) => boolean;
  toggleShotId: (id: string) => void;
  allSelected: boolean;
  someSelected: boolean;
  selectAll: () => void;
  clearSelect: () => void;
  creatingShot: boolean;
  navigate: ReturnType<typeof useNavigate>;
  autoPipeline: AutoPipeline;
  onCreateShot: () => void;
  onInsertAfter: (shotId: string) => void;
  onSingleDelete: (shotId: string, shotIndex: number | undefined, e: React.MouseEvent) => void;
  onDeleteEpisode: () => void;
  onDragStart: (e: React.DragEvent, shotId: string) => void;
  onDragOver: (e: React.DragEvent, shotId: string) => void;
  onDrop: (e: React.DragEvent, shotId: string) => void;
  onDragEnd: () => void;
}) {
  const { data: series } = useSeries(slug);
  const aspectRatio = seriesAspectToCss(series?.defaults?.aspect_ratio);

  // 2026-05-26 双栏布局所需的"该剧最近全部 pipeline 列表" — batch 启动时显示左栏全貌.
  // 5s 轮询 (跟 hook 单 pipeline 轮询同步). running 时高频, 全部 done 后停.
  const [allPipelines, setAllPipelines] = useState<import("../../lib/autoPipelineApi").AutoPipelineRecord[]>([]);
  // 2026-05-26 batch 启动期间 pending state — 走 startAutoPipelineBatch 不经 hook,
  // launcher.pending 拿不到, 用户可能双击启动两次. 这里自维护 + 传给 launcher.
  const [batchStartPending, setBatchStartPending] = useState(false);
  // BUG-23 fix: 加 fetchingRef 防止 setInterval 竞态（网络慢时多个请求并行）
  const fetchingRef = useRef(false);
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    const fetch = async () => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      try {
        const { listAutoPipelines } = await import("../../lib/autoPipelineApi");
        const resp = await listAutoPipelines(slug);
        if (alive && resp.ok) setAllPipelines(resp.records);
      } catch {
        // 静默, 下次重试
      } finally {
        fetchingRef.current = false;
      }
    };
    void fetch();
    const timer = setInterval(fetch, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [slug]);

  // W10: 视图切换 — 列表/九宫格/时间线, 默认列表. 按 slug+epId 隔离 localStorage.
  const [view, setView] = useState<ShotboardView>(() => loadView(slug, selectedEpId));
  // 切集时重载该集的视图偏好
  useEffect(() => {
    setView(loadView(slug, selectedEpId));
  }, [slug, selectedEpId]);
  function handleViewChange(next: ShotboardView) {
    setView(next);
    saveView(slug, selectedEpId, next);
  }

  // P1-3: 分镜搜索栏 — 按 action / dialogue / title / scene_name 过滤
  const [searchQuery, setSearchQuery] = useState("");
  const filteredShots = useMemo(() => {
    if (!searchQuery.trim()) return orderedShots;
    const q = searchQuery.trim().toLowerCase();
    return orderedShots.filter((s) => {
      const hay = [s.action, s.action_description, s.dialogue, s.voiceover, s.title, s.scene_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [orderedShots, searchQuery]);

  return (
    <section>
      {/* W10: 整集状态条 — 顶部 sticky 一行进度概览 */}
      {selectedEpId && !pickerMode && orderedShots.length > 0 && (
        <EpisodeStatusBar
          shots={orderedShots}
          onJumpToFailedShot={(shotId) => navigate(`/studio/${slug}/shot-stage/${selectedEpId}/${shotId}`)}
        />
      )}

      <div className="shotboard-list-toolbar" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        {/* T4: 全选 checkbox — 列表视图才显示 (其他视图勾选体验不一致) */}
        {orderedShots.length > 0 && view === "list" && (
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = someSelected; }}
            onChange={(e) => { if (e.target.checked) selectAll(); else clearSelect(); }}
            aria-label="全选分镜"
            style={{ width: 16, height: 16, accentColor: "var(--brand-500)", cursor: "pointer", flexShrink: 0 }}
          />
        )}
        <div className="mk-label">分镜列表 {selectedEpisode ? `（当前选中：${selectedEpisode.title}）` : ""}</div>
        {/* P1-3: 分镜搜索栏 */}
        {orderedShots.length > 3 && !pickerMode && (
          <div style={{ position: "relative", flex: "0 0 auto" }}>
            <Icon name="search" size={12} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--ink-400)", pointerEvents: "none" }} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索分镜…"
              aria-label="搜索分镜"
              style={{
                height: 28,
                width: 180,
                padding: "0 8px 0 24px",
                borderRadius: 7,
                border: "1px solid var(--ink-150)",
                background: "var(--surface-card)",
                fontSize: 12,
                color: "var(--ink-800)",
                outline: "none",
                transition: "border-color 0.15s, width 0.2s",
              }}
              onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "var(--brand-400)"; (e.target as HTMLInputElement).style.width = "240px"; }}
              onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = "var(--ink-150)"; (e.target as HTMLInputElement).style.width = "180px"; }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="清除搜索"
                style={{
                  position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                  width: 16, height: 16, borderRadius: 999, border: "none",
                  background: "var(--ink-100)", color: "var(--ink-500)",
                  display: "grid", placeItems: "center", cursor: "pointer", fontSize: 10,
                }}
              >
                <Icon name="close" size={10} />
              </button>
            )}
          </div>
        )}
        {/* P1-3: 搜索结果计数 */}
        {searchQuery.trim() && (
          <span style={{ fontSize: 11, color: "var(--ink-500)" }}>
            {filteredShots.length}/{orderedShots.length} 镜
          </span>
        )}
        {/* W10: 视图切换 — 列表 / 九宫格 / 时间线 */}
        {selectedEpId && orderedShots.length > 0 && !pickerMode && (
          <ShotboardViewSwitcher value={view} onChange={handleViewChange} />
        )}
        <span className="shotboard-toolbar-spacer" style={{ flex: 1 }} />
        <Button variant="secondary" size="sm" iconLeft="doc" onClick={() => navigate(ROUTES.script(slug))}>
          系列剧本
        </Button>
        <Button
          variant="primary"
          size="sm"
          iconLeft="plus"
          loading={creatingShot}
          onClick={onCreateShot}
          disabled={!selectedEpId || creatingShot}
        >
          {creatingShot ? "新增中..." : "添加分镜"}
        </Button>
        {/* 2026-05-19 #14: 删除本集 — 软删 + 二次确认 (用户原话"不小心新建的分集无法删除") */}
        {selectedEpId && (
          <Button
            variant="danger"
            size="sm"
            iconLeft="trash"
            onClick={onDeleteEpisode}
            title="把这一集移到回收站(90 天可恢复)"
          >
            删除本集
          </Button>
        )}
      </div>

      {/* 2026-05-19: 一键自动生成 — 副标题强调 3 种模式可选 (用户原话:
          "剧集一键生成功能要允许同时一键按顺序抽素材+所有分镜首帧,现在只有分别的功能").
          实际后端 only_firstframes 模式就是"素材图+首帧"组合, 但之前文案只写"首帧→视频→合成"
          让用户以为必跑视频, 没敢点. 现在把 3 种模式直接列出来, 弹窗里选哪个就跑哪个. */}
      {selectedEpId && !pickerMode && orderedShots.length > 0 && (
        <div
          className="shotboard-pipeline-banner"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            marginBottom: 12,
            borderRadius: 10,
            border: "1px solid var(--brand-300, #d97757)",
            background: "linear-gradient(96deg, var(--brand-25, rgba(217,119,87,0.04)) 0%, #fff 100%)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--brand-700)" }}>
            <Icon name="sparkles" size={14} />
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>一键自动生成</span>
          </div>
          <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>
            3 种模式可选:只抽素材图 · 素材图+首帧 (不烧视频费) · 全流程 (到成片)
          </span>
          <span style={{ flex: 1 }} />
          <AutoPipelineLauncher
            slug={slug}
            epId={selectedEpId}
            allEpisodes={episodes.map((ep: EpisodeRecord) => ({
              id: ep.episode_id ?? ep.id ?? "",
              title: ep.title,
              index: ep.index,
            }))}
            pending={autoPipeline.pending || batchStartPending}
            disabled={(!!autoPipeline.record && autoPipeline.record.status === "running") || batchStartPending}
            onStart={async (body, targetEpIds) => {
              if (!slug || !selectedEpId) return;
              // 2026-05-26 整部剧模式: 调 batch 端点串行启动每集 pipeline.
              // hook 仍只跟踪当前集 pipeline (UI 显示当前集进度), 切到其他集后 rehydrate 接管那集.
              const eps = targetEpIds && targetEpIds.length > 1
                ? targetEpIds
                : [selectedEpId];
              if (eps.length > 1) {
                setBatchStartPending(true);
                try {
                const { startAutoPipelineBatch } = await import("../../lib/autoPipelineApi");
                const { toast } = await import("sonner");
                const resp = await startAutoPipelineBatch({
                  series_episodes: eps.map((ep_id: string) => ({ slug, ep_id })),
                  options: body,
                });
                // 2026-05-26 修边界: total_started === 0 是"全部启动失败", 必须红字而非 success.
                const errSummary = resp.errors.length > 0
                  ? `失败原因: ${resp.errors.map((e: { ep_id: string; reason: string }) => `${e.ep_id}: ${e.reason}`).join("; ")}`
                  : "切换到其他集可看每集独立进度";
                if (resp.total_started === 0) {
                  toast.error(`批量启动失败 — ${resp.total_requested} 集全部未启动`, {
                    duration: 10000,
                    description: errSummary,
                  });
                } else if (resp.errors.length > 0) {
                  toast.warning(`部分启动: ${resp.total_started}/${resp.total_requested} 集已启动, ${resp.errors.length} 集失败`, {
                    duration: 10000,
                    description: errSummary,
                  });
                } else {
                  toast.success(`已批量启动 ${resp.total_started} 集 pipeline`, {
                    duration: 6000,
                    description: "切换到其他集可看每集独立进度",
                  });
                }
                // 2026-05-26 修 "batch 启动后当前集 UI 不接管新 pipeline":
                // 启动前 hook 可能持有同集旧 pipeline (已被后端 abort). force=true 跳过
                // "同集 skip" 检查 + 不 reset (避免 setRecord(null) 闪屏), 拿到新 record
                // 再原子替换.
                if (eps.includes(selectedEpId)) {
                  await autoPipeline.rehydrate(slug, selectedEpId, { force: true });
                }
                } finally {
                  setBatchStartPending(false);
                }
              } else {
                await autoPipeline.start(slug, selectedEpId, body);
              }
            }}
          />
        </div>
      )}

      {/* 2026-05-18 EVE-3: 一键自动管线进度面板 — record 在跑时显示 */}
      {autoPipeline.record && (
        <div style={{ marginBottom: 12 }}>
          <AutoPipelineProgressPanel
            record={autoPipeline.record}
            pending={autoPipeline.pending}
            onAbort={() => autoPipeline.abort()}
            // 2026-05-19 反馈 #2: 透传 opts 让"重试失败的 N 项"只重抽失败子集
            onRetryStage={(stage, opts) => autoPipeline.retryStage(stage, opts)}
            onJumpToCompose={() => {
              autoPipeline.reset();
              // 完成时自动跳合成页让用户验收成片
              if (slug && selectedEpId) navigate(ROUTES.compose(slug, selectedEpId));
            }}
            // 2026-05-19 #A: only_element_images 模式完成后跳素材库 (跳合成页是空白页)
            onJumpToElements={() => {
              autoPipeline.reset();
              if (slug) navigate(ROUTES.elements(slug));
            }}
            onClose={() => autoPipeline.reset()}
            // 2026-05-26 双栏布局: batch 启动多集时左栏显示全部集进度概览
            allPipelines={allPipelines}
            episodes={episodes.map((ep) => ({
              id: ep.episode_id ?? ep.id ?? "",
              title: ep.title,
              index: ep.index,
            }))}
            onSwitchEpisode={(epId) => navigate(ROUTES.storyboard(slug, epId))}
          />
        </div>
      )}

      {/* 2026-05-19 #C: W8-D 整集挂机抽首帧 toolbar 已删除 — 合并进 AutoPipelineLauncher 弹窗的"运行模式: 只跑首帧". */}

      {!selectedEpId && (
        <div className="mk-card" style={{ padding: 42, textAlign: "center" }}>
          <Empty title="还没有分集" description="先在剧本页生成分集与分镜，或手动添加新集。" cta="去系列剧本" onCta={() => navigate(ROUTES.script(slug))} />
        </div>
      )}

      {selectedEpId && pickerMode && <PickerFullscreenView slug={slug} epId={selectedEpId} aspectRatio={aspectRatio} />}

      {selectedEpId && !pickerMode && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {loadingShots ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="mk-card" style={{ height: 108, background: "var(--ink-50)" }} />
            ))
          ) : shotsError ? (
            <div className="mk-card" style={{ padding: 28 }}>
              {/* 2026-07-22 X5-5 (A4-12): 加载失败原来只有文字, 没有可点击的重试入口 —
                  用户只能手动刷新整页. 复用 ElementListPage 同款"重试"模式, 用全局 SWR
                  mutate(key) 触发 useShots 重新拉取(与 ShotboardPage 共享同一 SWR key,
                  不需要新增 prop / 改父组件). */}
              <Empty
                title="加载分镜失败"
                description="请检查后端是否已启动"
                cta="重试"
                onCta={() => invalidateShots(slug, selectedEpId)}
              />
            </div>
          ) : filteredShots.length === 0 && searchQuery.trim() ? (
            // P1-3: 搜索无结果
            <div className="mk-card" style={{ padding: 42, textAlign: "center" }}>
              <Empty
                title="没有匹配的分镜"
                description={`搜索 "${searchQuery.trim()}" 未找到结果。试试其他关键词，或清除搜索。`}
                cta="清除搜索"
                onCta={() => setSearchQuery("")}
              />
            </div>
          ) : filteredShots.length === 0 ? (
            // T6: 空状态"添加第一条"用虚线卡片样式
            <button
              onClick={onCreateShot}
              style={{
                minHeight: 104,
                borderRadius: 8,
                border: "1px dashed var(--ink-300)",
                background: "var(--ink-25, rgba(0,0,0,0.02))",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--ink-500)",
                cursor: "pointer",
                width: "100%",
                transition: "border-color 0.15s, background 0.15s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--brand-400)"; (e.currentTarget as HTMLButtonElement).style.background = "var(--brand-25, rgba(217,119,87,0.04))"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--ink-300)"; (e.currentTarget as HTMLButtonElement).style.background = "var(--ink-25, rgba(0,0,0,0.02))"; }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 650 }}>
                <Icon name="plus" size={16} />添加第一条分镜
              </span>
            </button>
          ) : view === "board" ? (
            // W10: 九宫格视图 — 3 列大图, 不参与拖拽 (用户想拖请切回列表)
            <ShotBoardView
              shots={filteredShots}
              slug={slug}
              selectedEpId={selectedEpId}
              aspectRatio={aspectRatio}
              hasShotSelected={hasShotSelected}
              toggleShotId={toggleShotId}
              navigate={navigate}
            />
          ) : view === "timeline" ? (
            // W10: 时间线视图 — 横向帧条
            <ShotTimelineView
              shots={filteredShots}
              slug={slug}
              selectedEpId={selectedEpId}
              aspectRatio={aspectRatio}
              navigate={navigate}
            />
          ) : (
            // 列表视图 — 原 ShotCard 含拖拽 + 勾选 + ⋯ 菜单
            filteredShots.map((shot) => (
              <ShotCard
                key={shot.id}
                shot={shot}
                slug={slug}
                selectedEpId={selectedEpId}
                aspectRatio={aspectRatio}
                selected={hasShotSelected(shot.id)}
                isDragging={dragId === shot.id}
                isDragOver={dragOverId === shot.id}
                creatingShot={creatingShot}
                navigate={navigate}
                onToggleSelect={toggleShotId}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
                onInsertAfter={onInsertAfter}
                onDelete={onSingleDelete}
              />
            ))
          )}
          {/* T6/T3.4: 添加分镜占位卡片，和已有卡片同 borderRadius/border/背景，只填充色变为虚线浅色（铁律#8）
              W10: 只在列表视图显示 — 九宫格 / 时间线视图整体节奏不同, 用户切回列表加更直觉 */}
          {filteredShots.length > 0 && view === "list" && (
            <button
              onClick={onCreateShot}
              disabled={creatingShot}
              style={{
                minHeight: 104,
                borderRadius: 8,
                border: "1px dashed var(--ink-300)",
                background: "var(--ink-25, rgba(0,0,0,0.02))",
                color: "var(--ink-500)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: creatingShot ? "wait" : "pointer",
                transition: "border-color 0.15s, background 0.15s",
                width: "100%",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--brand-400)"; (e.currentTarget as HTMLButtonElement).style.background = "var(--brand-25, rgba(217,119,87,0.04))"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--ink-300)"; (e.currentTarget as HTMLButtonElement).style.background = "var(--ink-25, rgba(0,0,0,0.02))"; }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 650 }}>
                <Icon name="plus" size={16} />{creatingShot ? "新增中…" : "添加分镜（追加到最后）"}
              </span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}
