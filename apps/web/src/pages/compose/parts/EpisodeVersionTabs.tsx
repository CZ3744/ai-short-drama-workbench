/**
 * EpisodeVersionTabs.tsx — W6-F
 * 按剧集 + 按版本管理 sub-tabs
 * 放置在 ComposePage 顶部：左侧显示各集 tab，右侧显示版本切换。
 */

import { useCallback } from "react";
import { cn } from "../../../lib/cn";
import { useSeriesEpisodes, type SeriesEpisode } from "../../../hooks/useSeries";

export interface EpisodeVersionTabsProps {
  slug: string;
  /** 当前激活的 episode id */
  activeEpId: string;
  /** 切换集时的回调（父组件负责 navigate） */
  onEpisodeChange: (epId: string) => void;
  className?: string;
}

export function EpisodeVersionTabs({
  slug,
  activeEpId,
  onEpisodeChange,
  className,
}: EpisodeVersionTabsProps) {
  const { data: epData, isLoading } = useSeriesEpisodes(slug);
  const episodes: SeriesEpisode[] = epData?.episodes ?? [];

  const handleEpClick = useCallback(
    (ep: SeriesEpisode) => {
      if (ep.id !== activeEpId) {
        onEpisodeChange(ep.id);
      }
    },
    [activeEpId, onEpisodeChange],
  );

  if (isLoading) {
    return (
      <div className={cn("flex items-center gap-2 px-1", className)}>
        <span className="text-xs text-[var(--ink-400)] animate-pulse">加载剧集…</span>
      </div>
    );
  }

  if (episodes.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex items-center gap-3 flex-wrap", className)}>
      {/* 左侧: 剧集 tabs */}
      <div className="flex items-center gap-1 flex-wrap">
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "var(--ink-400)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginRight: 4,
          }}
        >
          剧集
        </span>
        {episodes.map((ep, i) => {
          const isActive = ep.id === activeEpId;
          return (
            // 保留原因: chip 形态 (rounded-full) + 双色 active (规则 5) + 嵌入 status dot — Button 默认 borderRadius 8, 不是 chip 圆形
            <button
              key={ep.id}
              type="button"
              onClick={() => handleEpClick(ep)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer",
                isActive
                  ? "bg-[var(--brand-600)] text-white border-[var(--brand-600)] shadow-sm"
                  : "bg-white text-[var(--ink-600)] border-[var(--ink-200)] hover:border-[var(--brand-400)] hover:text-[var(--brand-700)]",
              )}
              title={ep.title}
            >
              EP{String(i + 1).padStart(2, "0")}
              {ep.status === "composed" && (
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 ml-1 align-middle"
                  title="已合成"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
