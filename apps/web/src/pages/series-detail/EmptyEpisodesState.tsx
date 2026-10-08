/**
 * series-detail/EmptyEpisodesState.tsx — 空 episodes 优雅状态
 *
 * 铁律 #1 用户控制权 + #10 优雅空状态 > 强制流程.
 * 显示: 顶部封面条 (让用户知道在哪个系列) + 中央 EmptyState + 3 个 CTA.
 *
 * Wave P2 #15 抽出: SeriesDetail 主入口 episodes.length === 0 分支集中到这里.
 */

import { useNavigate } from "react-router-dom";
import type { SeriesRecord } from "../../lib/api";
import { ROUTES } from "../../lib/routes";
import { Icon } from "../../components/shared/Icon";
import { Button } from "../../components/ui/button";
import { pickCoverClass } from "./utils";

export interface EmptyEpisodesStateProps {
  slug: string;
  series: SeriesRecord;
  creatingEpisode: boolean;
  onCreateEpisode: () => void;
}

export function EmptyEpisodesState({
  slug,
  series,
  creatingEpisode,
  onCreateEpisode,
}: EmptyEpisodesStateProps) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col h-full">
      {/* 顶部封面条 — 让用户知道自己在哪个系列 */}
      <header
        className={`${pickCoverClass(slug)} text-white relative overflow-hidden`}
        style={{ padding: "28px 40px 24px", boxShadow: "0 4px 16px rgba(0,0,0,.15)" }}
      >
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-white/75">工作室</span>
          <Icon name="chevRight" size={11} style={{ color: "rgba(255,255,255,0.5)" }} />
          <span className="text-xs text-white font-semibold">{series.title}</span>
        </div>
        <h1
          className="text-[28px] font-bold tracking-[-0.02em] text-white mb-2 mk-display"
        >
          {series.title}
        </h1>
        {series.description && (
          <p
            className="text-[13px] text-white/75 leading-relaxed mb-0"
            style={{ maxWidth: 560 }}
          >
            {series.description}
          </p>
        )}
      </header>

      {/* 中央 EmptyState + 两个 CTA */}
      <div className="flex-1 flex items-center justify-center" style={{ background: "var(--surface-canvas)" }}>
        <div className="flex flex-col items-center text-center" style={{ maxWidth: 520, padding: "32px 24px" }}>
          <div className="mb-5" style={{ color: "var(--ink-300)" }}>
            <Icon name="film" size={56} />
          </div>
          <h2
            className="font-bold"
            style={{ fontSize: 22, color: "var(--ink-900)", marginBottom: 10, fontFamily: "'Noto Serif SC', serif" }}
          >
            这个系列还没有剧集
          </h2>
          <p
            className="mb-6"
            style={{ fontSize: 13.5, color: "var(--ink-500)", lineHeight: 1.7, maxWidth: 420 }}
          >
            还没有任何剧集。先到灵感箱写一条想法让 AI 扩写成剧本,
            或者直接到剧本页手动开写,再继续拆分镜和合成。
          </p>
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              iconLeft="sparkles"
              onClick={() => navigate(ROUTES.inbox(slug))}
            >
              去添加灵感 · AI 扩写
            </Button>
            <Button
              variant="secondary"
              iconLeft="bookOpen"
              onClick={() => navigate(ROUTES.script(slug))}
            >
              直接去剧本页
            </Button>
            <Button
              variant="ghost"
              iconLeft="plus"
              loading={creatingEpisode}
              onClick={onCreateEpisode}
              disabled={creatingEpisode}
            >
              {creatingEpisode ? "新建中..." : "手动新建集"}
            </Button>
          </div>
          <p
            className="mt-5"
            style={{ fontSize: 11.5, color: "var(--ink-400)" }}
          >
            你可以随时回到这个总览页查看系列状态、角色、场景与花费。
          </p>
        </div>
      </div>
    </div>
  );
}
