/**
 * series-detail/SeriesHeader.tsx — 系列顶部 cover header (含 breadcrumb / title / stats)
 *
 * Wave P2 #15 抽出: SeriesDetail 主入口的顶部 84-95 行 JSX 集中到这里.
 *
 * 注意: 系列封面生成按钮已挪到 StudioHome 卡片上 (铁律 #4 就近决策),
 * 因为 SeriesDetail 顶部 cover header 只在 /studio/<slug> 根路径显示, 但
 * StudioHome 卡片点击直接 navigate /studio/<slug>/inbox, 用户根本不会进根路径.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";
import type { SeriesRecord, EpisodeRecord } from "../../lib/api";
import { Icon } from "../../components/shared/Icon";
import { Button } from "../../components/ui/button";
import { listCasts, patchSeriesCastIds, type CastWithUsage } from "../../lib/castApi";
import { MetaBadge, StatBox } from "./parts";
import { formatDuration } from "./utils";
import { ROUTES } from "../../lib/routes";

export interface SeriesHeaderProps {
  slug: string;
  series: SeriesRecord;
  coverClass: string;
  currentEpisode: EpisodeRecord | null;
  currentEpisodeNumber: number;
  currentPageLabel: string;
  formatLabel: string;
  createdLabel: string;
  totalShotCount: number;
  totalDurationSec: number;
}

export function SeriesHeader({
  slug,
  series,
  coverClass,
  currentEpisode,
  currentEpisodeNumber,
  currentPageLabel,
  formatLabel,
  createdLabel,
  totalShotCount,
  totalDurationSec,
}: SeriesHeaderProps) {
  const navigate = useNavigate();
  return (
    <header
      key="series-cover"
      className={`${coverClass} text-white relative overflow-hidden v24-series-cover`}
      style={{
        padding: "32px 40px 28px",
        boxShadow: "0 4px 16px rgba(0,0,0,.15)",
      }}
    >
      <div
        className="flex items-start justify-between gap-8 relative v24-series-hero"
        style={{ zIndex: 1 }}
      >
        {/* left: info */}
        <div className="flex-1 min-w-0 v24-series-hero-copy">
          {/* breadcrumb */}
          <div key="series-breadcrumb" className="flex items-center gap-2 mb-3 v24-series-breadcrumb">
            <span key="workspace-crumb" className="text-xs text-white/75">工作室</span>
            <Icon key="workspace-separator" name="chevRight" size={11} style={{ color: "rgba(255,255,255,0.5)" }} />
            <span key="series-crumb" className="text-xs text-white font-semibold">{series.title}</span>
            {currentEpisode && (
              <span key="episode-crumb" style={{ display: "contents" }}>
                <Icon name="chevRight" size={11} style={{ color: "rgba(255,255,255,0.5)" }} />
                <span className="text-xs text-white/90">
                  集 {String(currentEpisodeNumber).padStart(2, "0")} · {currentEpisode.title}
                </span>
              </span>
            )}
            <Icon key="page-separator" name="chevRight" size={11} style={{ color: "rgba(255,255,255,0.5)" }} />
            <span key="page-crumb" className="text-xs text-white/70">{currentPageLabel}</span>
            {/* 2026-05-25 — 原硬编码"进行中"pill 改成基于 currentEpisode.status 真实判断.
                状态枚举: draft/planned/generating/generated/picked/approved/locked
                铁律 #5 真实保存 + 状态精确 — 否则用户看着"进行中"实际啥也没在跑就疑惑. */}
            {currentEpisode && (() => {
              const statusMap: Record<string, { label: string; bg: string }> = {
                draft: { label: "草稿", bg: "rgba(255,255,255,.16)" },
                drafted: { label: "草稿", bg: "rgba(255,255,255,.16)" },
                planned: { label: "已规划", bg: "rgba(96,165,250,.35)" },
                generating: { label: "生成中", bg: "rgba(251,146,60,.45)" },
                generated: { label: "已生成", bg: "rgba(96,165,250,.35)" },
                picked: { label: "已挑卡", bg: "rgba(34,197,94,.4)" },
                approved: { label: "已选定", bg: "rgba(34,197,94,.4)" },
                locked: { label: "已锁定", bg: "rgba(34,197,94,.4)" },
                has_images: { label: "有图", bg: "rgba(96,165,250,.35)" },
              };
              const meta = statusMap[currentEpisode.status as string];
              if (!meta) return null;
              return (
                <span
                  key="status-pill"
                  className="mk-pill ml-2.5"
                  style={{ background: meta.bg, color: "var(--ink-50)" }}
                >
                  {meta.label}
                </span>
              );
            })()}
          </div>

          {/* title */}
          <h1
            key="series-title"
            className="text-[34px] font-bold tracking-[-0.02em] text-white mb-2 mk-display"
          >
            {series.title}
          </h1>

          {/* description */}
          {series.description && (
            <p
              key="series-description"
              className="text-[13px] text-white/75 leading-relaxed mb-0"
              style={{ maxWidth: 560 }}
            >
              {series.description}
            </p>
          )}

          {/* meta line */}
          <div key="series-meta" className="flex items-center gap-[18px] mt-3 v24-series-meta-row">
            <MetaBadge icon="film" label={`${series.episode_count} 集`} />
            <MetaBadge icon="compose" label={formatLabel} />
            <MetaBadge icon="clock" label={createdLabel} />
          </div>

          {/* actions */}
          <div key="series-actions" className="flex gap-2 mt-[14px] v24-series-actions">
            <Button
              variant="primary"
              iconLeft="plus"
              onClick={() => navigate(ROUTES.inbox(slug))}
            >
              新建剧集
            </Button>
            {/* W7 (2026-05-26): 使用素材组 — 多选 chip, 替代旧"加入剧组"下拉 */}
            <SeriesGroupsPicker slug={slug} series={series} />
            {/* 2026-05-21 — 系列封面生成按钮已挪到 StudioHome 卡片上 (铁律 #4 就近决策).
                SeriesDetail 顶部 cover header 只在 /studio/<slug> 根路径显示, 但 StudioHome
                卡片点击直接 navigate /studio/<slug>/inbox, 用户根本不会进根路径 →
                顶部按钮永远见不到. 改到 StudioHome 卡片本身让用户在首页就能点. */}
          </div>
        </div>

        {/* right: stats */}
        <div className="shrink-0">
          <div
            className="flex gap-7 px-5 py-2.5 rounded-[var(--r-lg)] v24-series-stats"
            style={{ background: "rgba(35,28,23,.18)", backdropFilter: "blur(8px)" }}
          >
            <StatBox value={String(series.episode_count)} label="总集数" />
            <StatBox value={totalDurationSec > 0 ? formatDuration(totalDurationSec) : "—"} label="计划时长" />
            <StatBox value={String(totalShotCount)} label="已建分镜" />
            <StatBox value={String(series.character_ids?.length ?? 0)} label="角色" />
            <StatBox value={String(series.scene_ids?.length ?? 0)} label="场景" />
          </div>
        </div>
      </div>
    </header>
  );
}

// ─── W7 (2026-05-26): 多素材组多选 chip ──────────────────────────────
//
// 替代旧"加入剧组"单选下拉. 用户在系列总览页能就近 (铁律 #4) 加多个素材组,
// effective-elements 自动 union 合并显示.

interface SeriesGroupsPickerProps {
  slug: string;
  series: SeriesRecord;
}

function SeriesGroupsPicker({ slug, series }: SeriesGroupsPickerProps) {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<CastWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // 当前生效的组 id 列表 — 优先用 cast_ids 新字段, fallback 老 cast_id 单组兼容
  const initialIds = useMemo(() => {
    if (Array.isArray(series.cast_ids) && series.cast_ids.length > 0) return [...series.cast_ids];
    if (series.cast_id) return [series.cast_id];
    return [];
  }, [series.cast_ids, series.cast_id]);
  const [currentIds, setCurrentIds] = useState<string[]>(initialIds);
  const [popoverOpen, setPopoverOpen] = useState(false);

  useEffect(() => {
    setCurrentIds(initialIds);
  }, [initialIds]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await listCasts();
        setGroups(r.casts);
      } catch {
        /* silent: 不阻塞顶栏 */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const currentGroups = useMemo(
    () => currentIds.map((id) => groups.find((g) => g.id === id)).filter(Boolean) as CastWithUsage[],
    [currentIds, groups],
  );

  async function applyIds(nextIds: string[]) {
    if (submitting) return;
    setSubmitting(true);
    const prev = currentIds;
    setCurrentIds(nextIds);
    try {
      await patchSeriesCastIds(slug, nextIds);
      if (nextIds.length === 0) toast.success("本剧不再加入任何素材组");
      else if (nextIds.length > prev.length) {
        const newId = nextIds.find((x) => !prev.includes(x));
        const newName = groups.find((g) => g.id === newId)?.name ?? "新组";
        toast.success(`已加入素材组「${newName}」`);
      } else {
        const droppedId = prev.find((x) => !nextIds.includes(x));
        const droppedName = groups.find((g) => g.id === droppedId)?.name ?? "组";
        toast.success(`已退出素材组「${droppedName}」`);
      }
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "保存失败");
      setCurrentIds(prev);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return null;

  // 没建任何素材组 — 给 CTA 引导回素材库管理
  if (groups.length === 0) {
    return (
      <Button
        variant="secondary"
        iconLeft="grid"
        onClick={() => navigate(ROUTES.elements(slug))}
        title="去素材库的「管理素材组」新建一个, 多部剧共用同一组素材"
      >
        建素材组共享角色
      </Button>
    );
  }

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        position: "relative",
      }}
    >
      <span
        style={{
          fontSize: 11.5,
          color: "rgba(255,255,255,0.78)",
          fontWeight: 600,
          letterSpacing: "0.04em",
        }}
      >
        使用素材组:
      </span>
      {currentGroups.length === 0 ? (
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>(本剧专属)</span>
      ) : (
        currentGroups.map((g) => (
          <span
            key={g.id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              borderRadius: 999,
              background: "rgba(255,255,255,0.18)",
              border: "1px solid rgba(255,255,255,0.25)",
              fontSize: 11.5,
              color: "#fff",
              fontWeight: 500,
            }}
            title={`${g.name} · ${g.member_element_ids.length} 个成员`}
          >
            {g.name}
            <button
              onClick={() => void applyIds(currentIds.filter((id) => id !== g.id))}
              disabled={submitting}
              title="从本剧移除这个素材组"
              style={{
                background: "transparent",
                border: "none",
                color: "rgba(255,255,255,0.7)",
                cursor: submitting ? "not-allowed" : "pointer",
                padding: 0,
                lineHeight: 1,
                fontSize: 14,
              }}
            >
              ×
            </button>
          </span>
        ))
      )}
      <Button
        variant="secondary"
        size="sm"
        iconLeft="plus"
        onClick={() => setPopoverOpen((v) => !v)}
        disabled={submitting}
        title="再加入一个素材组"
      >
        加一组
      </Button>
      {popoverOpen ? (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 6,
            zIndex: 50,
            minWidth: 240,
            maxHeight: 320,
            overflow: "auto",
            background: "#fff",
            border: "1px solid var(--ink-200)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            padding: 6,
          }}
        >
          {groups.length === currentIds.length ? (
            <div style={{ padding: 12, fontSize: 12, color: "var(--ink-400)" }}>
              所有已建的素材组都加进来了.
            </div>
          ) : (
            groups
              .filter((g) => !currentIds.includes(g.id))
              .map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    void applyIds([...currentIds, g.id]);
                    setPopoverOpen(false);
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 10px",
                    background: "transparent",
                    border: "none",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 12.5,
                    color: "var(--ink-800)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--ink-50)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <div style={{ fontWeight: 600 }}>{g.name}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-500)", marginTop: 1 }}>
                    {g.member_element_ids.length} 个成员 · {g.referencing_series_count} 部剧用着
                  </div>
                </button>
              ))
          )}
          <div
            style={{
              borderTop: "1px solid var(--ink-100)",
              marginTop: 4,
              paddingTop: 4,
            }}
          >
            <button
              onClick={() => {
                navigate(ROUTES.elements(slug));
                setPopoverOpen(false);
              }}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                color: "var(--brand-700, #c2410c)",
                fontWeight: 500,
              }}
            >
              <Icon name="plus" size={11} style={{ marginRight: 4 }} />
              去素材库新建一个素材组
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
