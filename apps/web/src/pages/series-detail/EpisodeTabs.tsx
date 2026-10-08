/**
 * series-detail/EpisodeTabs.tsx — 集 tab 切换栏 + 新建集按钮
 *
 * Wave P2 #15 抽出: SeriesDetail 主入口的集 tab 切换栏 JSX 集中到这里.
 */

import type { EpisodeRecord } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { getEpisodeId, getEpisodeNumber } from "./utils";

export interface EpisodeTabsProps {
  episodes: EpisodeRecord[];
  activeEpisodeId: string;
  creatingEpisode: boolean;
  onTabClick: (episodeId: string) => void;
  onCreate: () => void;
}

export function EpisodeTabs({
  episodes,
  activeEpisodeId,
  creatingEpisode,
  onTabClick,
  onCreate,
}: EpisodeTabsProps) {
  return (
    <div
      key="episode-tabs"
      className="flex items-center gap-2 px-6 py-3 border-b border-[var(--ink-100)] bg-[var(--surface-card)] overflow-x-auto mk-scroll"
      style={{ minHeight: 56 }}
    >
      <span key="episode-tabs-label" className="text-[11px] text-[var(--ink-400)] shrink-0 mr-1">集</span>
      {episodes.map((episode) => {
        const episodeId = getEpisodeId(episode);
        if (!episodeId) return null;
        const episodeNumber = getEpisodeNumber(episode);
        const active = episodeId === activeEpisodeId;
        return (
          <button
            key={episodeId}
            className="mk-chip shrink-0"
            style={{
              height: 30,
              padding: "0 12px",
              border: active ? "1px solid var(--brand-200)" : "1px solid var(--ink-100)",
              background: active ? "var(--brand-50)" : "var(--surface-card)",
              color: active ? "var(--brand-700)" : "var(--ink-600)",
              fontWeight: active ? 600 : 500,
            }}
            onClick={() => onTabClick(episodeId)}
          >
            集 {episodeNumber}
          </button>
        );
      })}
      <Button
        key="create-episode"
        variant="ghost"
        size="sm"
        iconLeft="plus"
        className="shrink-0 ml-1"
        loading={creatingEpisode}
        onClick={onCreate}
        disabled={creatingEpisode}
      >
        {creatingEpisode ? "新建中" : "新建集"}
      </Button>
    </div>
  );
}
