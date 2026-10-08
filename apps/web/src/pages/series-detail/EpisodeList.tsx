/**
 * series-detail/EpisodeList.tsx — 分集列表容器 (header + filter tabs + 列表 + 空状态)
 *
 * Wave P2 #15 抽出: SeriesDetail 主入口的 episode column 部分集中到这里.
 *
 * 不在内部做过滤逻辑 (counts / filtered episodes 由 caller 传入), 这样 caller
 * 可以一次计算同一份 episodes 派生 4 个统计值, 不用重复 reduce.
 */

import { useNavigate } from "react-router-dom";
import type { EpisodeRecord } from "../../lib/api";
import { Icon } from "../../components/shared/Icon";
import { FilterTab } from "./parts";
import { EpisodeRow } from "./EpisodeRow";
import {
  episodeActionLabel,
  episodeHasScript,
  episodeHasStoryboard,
  episodeHelperText,
  episodeIsDone,
  episodePrimaryRoute,
  episodeStatusLabel,
  epStatusPill,
  formatDuration,
  getEpisodeId,
  getEpisodeNumber,
  pickThumbClass,
} from "./utils";

export interface EpisodeListProps {
  slug: string;
  episodes: EpisodeRecord[];
  filteredEpisodes: EpisodeRecord[];
  epFilter: string;
  onFilterChange: (filter: string) => void;
  doneCount: number;
  storyboardCount: number;
  needsStoryboardCount: number;
  draftCount: number;
  isCoverGenerating: (epId: string) => boolean;
  onEpisodeCoverGen: (epId: string, opts: { provider_override?: string; style?: string; reference_shot_id?: string }) => void;
}

export function EpisodeList({
  slug,
  episodes,
  filteredEpisodes,
  epFilter,
  onFilterChange,
  doneCount,
  storyboardCount,
  needsStoryboardCount,
  draftCount,
  isCoverGenerating,
  onEpisodeCoverGen,
}: EpisodeListProps) {
  const navigate = useNavigate();
  return (
    <div
      className="flex flex-col min-h-0 v24-series-episode-col"
      style={{
        background: "var(--surface-card)",
        borderRight: "1px solid var(--ink-100)",
      }}
    >
      {/* episode header */}
      <div
        className="flex items-center justify-between gap-4 px-6 py-4 v24-series-episode-header"
        style={{ borderBottom: "1px solid var(--ink-100)" }}
      >
        <div>
          <h3
            className="text-base font-bold m-0"
            style={{ fontSize: 16, color: "var(--ink-900)" }}
          >
            分集与分镜
          </h3>
          <p className="m-0 mt-1 text-[12px]" style={{ color: "var(--ink-500)" }}>
            每一集独立管理剧本、分镜和合成进度。
          </p>
        </div>
        <div className="flex gap-1 shrink-0">
          <FilterTab active={epFilter === "all"} onClick={() => onFilterChange("all")}>
            全部 {episodes.length}
          </FilterTab>
          <FilterTab active={epFilter === "done"} onClick={() => onFilterChange("done")}>
            已完成 {doneCount}
          </FilterTab>
          <FilterTab active={epFilter === "active"} onClick={() => onFilterChange("active")}>
            有分镜 {storyboardCount}
          </FilterTab>
          <FilterTab active={epFilter === "draft"} onClick={() => onFilterChange("draft")}>
            待分镜 {needsStoryboardCount}
          </FilterTab>
          <FilterTab active={epFilter === "empty"} onClick={() => onFilterChange("empty")}>
            草稿 {draftCount}
          </FilterTab>
        </div>
      </div>

      {/* episode list */}
      <div
        className="flex-1 overflow-auto flex flex-col gap-3 mk-scroll v24-series-episode-list"
        style={{ padding: "14px 16px 16px" }}
      >
        {filteredEpisodes.length === 0 && (
          <div
            key="empty-episodes"
            className="flex flex-col items-center justify-center py-14 text-center"
            style={{ color: "var(--ink-400)", fontSize: 13 }}
          >
            <Icon name="film" size={32} style={{ color: "var(--ink-300)", marginBottom: 10 }} />
            <div style={{ color: "var(--ink-700)", fontWeight: 700, fontSize: 14 }}>这里暂时没有分集</div>
            <div className="mt-1">换一个筛选条件，或新建一集继续创作。</div>
          </div>
        )}
        {filteredEpisodes.map((ep) => {
          const episodeId = getEpisodeId(ep);
          if (!episodeId) return null;
          const episodeNumber = getEpisodeNumber(ep);
          const hasScript = episodeHasScript(ep);
          const hasStoryboard = episodeHasStoryboard(ep);
          const isDone = episodeIsDone(ep);
          const primaryRoute = episodePrimaryRoute(slug, ep);
          // 2026-05-26 修复 — 用户反馈"分镜选了视频但卡片不显示时长":
          // shotLabel 优先显示真实进度 (X/Y 镜已选视频), fallback 旧逻辑
          const realShots = ep.actual_shot_count ?? 0;
          const pickedVideo = ep.picked_video_count ?? 0;
          const shotLabel = hasStoryboard
            ? realShots > 0
              ? pickedVideo > 0
                ? `${pickedVideo}/${realShots} 镜已选视频`
                : `${realShots} 个分镜, 待选视频`
              : ep.target_shot_count
                ? `${ep.target_shot_count} 个分镜`
                : "已有分镜"
            : hasScript
              ? "待拆分镜"
              : "待写剧本";
          // formatDuration 升级为接整个 ep — 优先真选视频累加 > 目标时长 > "拆分镜后显示"
          const durationLabel = formatDuration(ep);
          const pill = epStatusPill(ep.status);
          const label = episodeStatusLabel(ep);
          const coverImageUrl = ep.cover_vault_id
            ? `/api/v2/vault/${ep.cover_vault_id}/raw`
            : null;
          const isGeneratingCover = isCoverGenerating(episodeId);
          return (
            <EpisodeRow
              key={episodeId}
              episodeId={episodeId}
              episodeNumber={episodeNumber}
              episodeTitle={ep.title}
              hasScript={hasScript}
              hasStoryboard={hasStoryboard}
              isDone={isDone}
              primaryRoute={primaryRoute}
              shotLabel={shotLabel}
              durationLabel={durationLabel}
              pill={pill}
              label={label}
              slug={slug}
              createdAt={ep.created_at}
              helperText={episodeHelperText(ep)}
              actionLabel={episodeActionLabel(ep)}
              coverImageUrl={coverImageUrl}
              isGeneratingCover={isGeneratingCover}
              onCoverGen={(opts) => onEpisodeCoverGen(episodeId, opts)}
              onNavigate={(route) => navigate(route)}
              pickThumbClass={pickThumbClass}
            />
          );
        })}
      </div>
    </div>
  );
}
