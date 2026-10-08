import type { CoverGenerationOptions } from "../../lib/seriesApi";
/**
 * series-detail/EpisodeRow.tsx — 集卡片行
 *
 * 2026-05-21 — 从 SeriesDetail 内联 JSX 抽出, 含封面 popover + 真图渲染.
 * Wave P2 #15 — 进一步移到独立文件, 让 SeriesDetail 主入口聚焦于装载逻辑.
 *
 * 设计要点 (铁律 #4 就近决策 + #2 可干预性):
 *   - 86×62 缩略图块: 有 coverImageUrl 时直接渲染真图; 没有时 fallback gradient + icon
 *   - 缩略图右下角悬停可见小按钮 "生成封面" / "重生封面" → 弹 CoverGenPopover
 *   - popover 内含 ModelPicker (kind="image") + 风格关键词 input + 一键生成
 */

import { useState } from "react";
import { ROUTES } from "../../lib/routes";
import { formatBeijingTime } from "../../lib/format";
import { Icon } from "../../components/shared/Icon";
import { Button } from "../../components/ui/button";
import { CoverGenPopover } from "../../components/studio/CoverGenPopover";
import { StageChip } from "./parts";
import type { EpStatus } from "./utils";

export interface EpisodeRowProps {
  episodeId: string;
  episodeNumber: number;
  episodeTitle?: string;
  hasScript: boolean;
  hasStoryboard: boolean;
  isDone: boolean;
  primaryRoute: string;
  shotLabel: string;
  durationLabel: string;
  pill: EpStatus;
  label: string;
  slug: string;
  createdAt?: string;
  helperText: string;
  actionLabel: string;
  coverImageUrl: string | null;
  isGeneratingCover: boolean;
  onCoverGen: (opts: CoverGenerationOptions) => void;
  onNavigate: (route: string) => void;
  pickThumbClass: (n: number) => string;
}

export function EpisodeRow({
  episodeId,
  episodeNumber,
  episodeTitle,
  hasScript,
  hasStoryboard,
  isDone,
  primaryRoute,
  shotLabel,
  durationLabel,
  pill,
  label,
  slug,
  createdAt,
  helperText,
  actionLabel,
  coverImageUrl,
  isGeneratingCover,
  onCoverGen,
  onNavigate,
  pickThumbClass,
}: EpisodeRowProps) {
  const [coverPopoverOpen, setCoverPopoverOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <article
      key={episodeId}
      className="flex items-stretch gap-4 cursor-pointer rounded-[var(--r-md)] border hover:bg-[var(--ink-50)] v24-series-episode-row"
      style={{
        borderColor: "var(--ink-100)",
        background: "var(--surface-card)",
        padding: 14,
        minHeight: 132,
      }}
      onClick={() => onNavigate(primaryRoute)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex flex-col items-center gap-2 shrink-0" style={{ width: 86 }}>
        <div
          className={coverImageUrl ? "" : `mk-thumb ${pickThumbClass(episodeNumber)}`}
          style={{
            width: 86,
            height: 62,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,.86)",
            position: "relative",
            overflow: "hidden",
            background: coverImageUrl ? "var(--ink-100)" : undefined,
          }}
        >
          {coverImageUrl ? (
            <img
              src={coverImageUrl}
              alt={`第 ${episodeNumber} 集封面`}
              loading="lazy"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <Icon name={hasStoryboard ? "shot" : "film"} size={24} />
          )}
          <CoverGenPopover
            open={coverPopoverOpen}
            onOpenChange={setCoverPopoverOpen}
            busy={isGeneratingCover}
            onSubmit={(opts) => { setCoverPopoverOpen(false); onCoverGen(opts); }}
            title="生成集封面"
            slug={slug}
            episodeId={episodeId}
            subtitle="走 AI 图像模型, 1080×1920 竖屏"
            triggerEl={
              !coverImageUrl ? (
                <button
                  onClick={(e) => { e.stopPropagation(); }}
                  disabled={isGeneratingCover}
                  style={{
                    position: "absolute",
                    bottom: 2,
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 2,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.92)",
                    border: "1px solid rgba(255,255,255,0.7)",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
                    color: "var(--ink-800)",
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: isGeneratingCover ? "wait" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    whiteSpace: "nowrap",
                  }}
                  title="为本集生成真封面图(走 AI image provider, 1080×1920 竖屏)"
                >
                  <Icon name={isGeneratingCover ? "refresh" : "image"} size={10} />
                  {isGeneratingCover ? "生成中" : "生成封面"}
                </button>
              ) : (
                hovered ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); }}
                    disabled={isGeneratingCover}
                    style={{
                      position: "absolute",
                      bottom: 3,
                      right: 3,
                      zIndex: 2,
                      padding: "2px 6px",
                      borderRadius: 999,
                      background: "rgba(0,0,0,0.6)",
                      border: "1px solid rgba(255,255,255,0.2)",
                      backdropFilter: "blur(8px)",
                      color: "rgba(255,255,255,0.96)",
                      fontSize: 10,
                      fontWeight: 600,
                      cursor: isGeneratingCover ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                    title="重新生成集封面"
                  >
                    {/* 2026-05-25 — 原三元两边都是 "refresh" typo 冗余, 简化.
                        生成中 spinner 在文字侧已经表达, 图标统一 refresh 即可. */}
                    <Icon name="refresh" size={10} />
                    {isGeneratingCover ? "生成中" : "重生"}
                  </button>
                ) : <span style={{ display: "none" }} />
              )
            }
          />
        </div>
        <div
          className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{ background: "var(--ink-50)", color: "var(--ink-700)" }}
        >
          第 {episodeNumber} 集
        </div>
      </div>

      <div className="flex-1 min-w-0 v24-series-episode-info">
        <div className="flex items-center gap-2 min-w-0">
          <h4
            className="m-0 truncate"
            style={{ color: "var(--ink-900)", fontSize: 15, fontWeight: 800 }}
          >
            {episodeTitle || `第 ${episodeNumber} 集`}
          </h4>
          <span className={`mk-pill mk-pill--${pill}`} style={{ height: 22, fontSize: 11 }}>
            {label}
          </span>
        </div>

        <p
          className="mt-2 mb-0 line-clamp-2"
          style={{ color: "var(--ink-600)", fontSize: 12.5, lineHeight: 1.6 }}
        >
          {helperText}
        </p>

        <div className="grid grid-cols-3 gap-2 mt-3">
          <StageChip done={hasScript} icon="bookOpen" label="剧本" value={hasScript ? "已生成" : "待补充"} />
          <StageChip done={hasStoryboard} icon="shot" label="分镜" value={shotLabel} />
          <StageChip done={isDone} icon="compose" label="合成" value={isDone ? "已完成" : "待合成"} />
        </div>

        <div className="flex items-center gap-3 mt-3 text-[11px]" style={{ color: "var(--ink-400)" }}>
          <span>{durationLabel}</span>
          {/* 2026-07-22 X5-4 (A4-9): 裸 slice(0,10) 取的是 UTC 日历日, 跨 UTC 16:00-24:00
              (北京 00:00-08:00) 窗口创建的分集会显错前一天. 改走 formatBeijingTime 锁 Asia/Shanghai,
              保留原 "创建日期待定" 空值文案(不用 formatBeijingTime 自带的通用 "—"). */}
          <span>{createdAt ? formatBeijingTime(createdAt, { mode: "date" }) : "创建日期待定"}</span>
        </div>
      </div>

      <div className="flex flex-col items-end justify-between gap-2 shrink-0">
        <Button
          variant="primary"
          size="sm"
          iconRight="chevRight"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(primaryRoute);
          }}
        >
          {actionLabel}
        </Button>
        {hasScript && (
          <Button
            key="view-action"
            variant="ghost"
            size="xs"
            iconLeft="bookOpen"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(ROUTES.script(slug));
            }}
          >
            看剧本
          </Button>
        )}
      </div>
    </article>
  );
}
