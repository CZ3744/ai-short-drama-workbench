import type { CoverGenerationOptions } from "../lib/seriesApi";
import { useEffect, useCallback, useState } from "react";
import { useToggleSet } from "../hooks/useToggleSet";
import { useParams, useNavigate, Outlet, useLocation, Navigate } from "react-router-dom";
import { toast } from "sonner";
import { ErrorState } from "../components/ui/error";
import { useSessionStore } from "../stores/sessionStore";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { ROUTES } from "../lib/routes";
import { createEpisode, getSeries, generateEpisodeCover, type SeriesRecord, type EpisodeRecord } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";
import { formatBeijingTime } from "../lib/format";
import { Icon } from "../components/shared/Icon";
import {
  episodeHasScript,
  episodeHasStoryboard,
  episodeIsDone,
  episodeIsDraft,
  episodeNeedsStoryboard,
  getEpisodeId,
  getEpisodeNumber,
  pickCoverClass,
  resolveEpisodeRoute,
} from "./series-detail/utils";
import { SeriesHeader } from "./series-detail/SeriesHeader";
import { EpisodeTabs } from "./series-detail/EpisodeTabs";
import { EpisodeList } from "./series-detail/EpisodeList";
import { SeriesSidebar } from "./series-detail/SeriesSidebar";
import { EmptyEpisodesState } from "./series-detail/EmptyEpisodesState";
import { Button } from "../components/ui/button";

/**
 * /studio/:slug — 系列总览（P09 v24 设计）。
 *
 * 作为 layout route 包裹所有子路由：
 *   - index (/studio/:slug) → 显示 P09 总览页
 *   - 子路由 (/studio/:slug/characters 等) → 透传 <Outlet />
 *
 * 首次进入自动创建 ep01 作为"当前工作集"。
 *
 * Wave P2 #15 (2026-05-21): 从单文件 1259 行拆出 7 个子文件 (utils / parts /
 * EpisodeRow / SeriesHeader / EpisodeTabs / EpisodeList / SeriesSidebar /
 * EmptyEpisodesState), 主入口只保留数据装载 + 路由 + 业务回调.
 */
export default function SeriesDetail() {
  const { slug, epId } = useParams<{ slug: string; epId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const setCurrentSeries = useSessionStore((s) => s.setCurrentSeries);
  const setCurrentEpisode = useSessionStore((s) => s.setCurrentEpisode);
  const setSeriesCost = useSessionStore((s) => s.setSeriesCost);
  const setSeriesList = useSessionStore((s) => s.setSeriesList);

  const [series, setSeries] = useState<SeriesRecord | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [epFilter, setEpFilter] = useState<string>("all");

  const loadSeries = useCallback(async () => {
    if (!slug) return;
    setLoadError(null);
    setLoading(true);
    try {
      const existingEpisodeId = useSessionStore.getState().currentEpisodeId;
      const existingSeriesList = useSessionStore.getState().seriesList;
      const data = await getSeries(slug);
      setSeries(data.series);
      setEpisodes(data.episodes);
      setCurrentSeries(slug);
      setSeriesCost(data.series.total_cost);
      setSeriesList([
        ...existingSeriesList.filter((item) => item.slug !== slug),
        {
          slug: data.series.slug,
          title: data.series.title,
          description: data.series.description,
          coverUrl: data.series.cover_url,
          episodeCount: data.series.episode_count,
          totalCost: data.series.total_cost,
          updatedAt: data.series.updated_at,
        },
      ]);

      // 铁律 #1: 用户控制权 > 系统智能 — 空 episodes 不再强制跳 inbox,
      // 由下面的渲染逻辑展示优雅 EmptyState + CTA 让用户主动选择。
      if (data.episodes.length > 0) {
        const routeEpisodeId = epId;
        const routeEpisodeExists = routeEpisodeId
          ? data.episodes.some((episode) => getEpisodeId(episode) === routeEpisodeId)
          : false;
        const existingEpisodeStillExists = existingEpisodeId
          ? data.episodes.some((episode) => getEpisodeId(episode) === existingEpisodeId)
          : false;
        const fallbackEpisodeId = getEpisodeId(data.episodes[0]);
        setCurrentEpisode(
          routeEpisodeExists
            ? routeEpisodeId!
            : existingEpisodeStillExists
              ? existingEpisodeId!
              : fallbackEpisodeId,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [slug, epId, setCurrentSeries, setCurrentEpisode, setSeriesCost, setSeriesList, navigate]);

  useEffect(() => {
    loadSeries();
  }, [loadSeries]);

  useEffect(() => {
    if (epId) {
      setCurrentEpisode(epId);
    }
  }, [epId, setCurrentEpisode]);

  // ── callbacks (必须放在 early return 之前, 否则 Rules of Hooks 报 "Rendered more hooks than during the previous render") ─
  const handleEpisodeTabClick = useCallback(
    (episodeId: string) => {
      if (!slug) return;
      navigate(resolveEpisodeRoute(slug, episodeId, location.pathname));
    },
    [slug, navigate, location.pathname],
  );

  // 2026-05-18 EVE-6: useAsyncAction 接管 busy + 内置串行 (busy=true 时 noop) — 防止用户连点
  // 后端 listEpisodes.length+1 算 id 时会 race 出重复 id, 写盘后 series.episodes
  // 数组也会重复 push (前端"集不存在"潜在原因之一)
  const createEpisodeAction = useAsyncAction(
    async () => {
      if (!slug) return null;
      const nextIndex = episodes.length > 0 ? Math.max(...episodes.map(getEpisodeNumber)) + 1 : 1;
      const result = await createEpisode(slug, {
        title: `第 ${nextIndex} 集`,
        index: nextIndex,
      });
      await loadSeries();
      return result;
    },
    {
      errorMessage: "创建分集失败",
      onSuccess: (result) => {
        if (result && slug) {
          // V-2.4: 强制跳转改 toast + action (UX 铁律 #1)
          const epId = result.episode?.id || (result as { ep_id?: string }).ep_id;
          const storyboardPath = epId
            ? ROUTES.storyboard(slug, epId)
            : ROUTES.storyboard(slug);
          toast.success("分集已创建", {
            duration: 6000,
            action: {
              label: "查看分镜板",
              onClick: () => navigate(storyboardPath),
            },
          });
        }
      },
    },
  );
  const creatingEpisode = createEpisodeAction.busy;
  const handleCreateEpisode = useCallback(() => {
    if (!slug) return;
    void createEpisodeAction.run();
  }, [slug, createEpisodeAction]);

  // 2026-05-21 — 生成系列封面 action 已挪到 StudioHome (铁律 #4 就近决策),
  // 因为 SeriesDetail 顶部 cover header 只在 /studio/<slug> 根路径显示,
  // 用户从首页点系列卡直接 navigate /studio/<slug>/inbox, 根本不会路过根路径.

  // 2026-05-21 — 集级封面生成: 多 episode 可并发, 按 epId 记录 busy 状态
  const { add: addCoverGenerating, remove: removeCoverGenerating, has: isCoverGenerating } = useToggleSet<string>();
  const handleEpisodeCoverGen = useCallback(
    async (epId: string, opts: CoverGenerationOptions) => {
      if (!slug || isCoverGenerating(epId)) return;
      addCoverGenerating(epId);
      try {
        await generateEpisodeCover(slug, epId, opts);
        toast.success("集封面已生成");
        await loadSeries();
      } catch (err) {
        showErrorToast(err, "封面生成失败");
      } finally {
        removeCoverGenerating(epId);
      }
    },
    [slug, isCoverGenerating, addCoverGenerating, removeCoverGenerating, loadSeries],
  );

  // ── guard clauses ───────────────────────────────────────

  // 2026-05-17 P2.5: 用 <Navigate> 替代 render 内调 navigate() — 避免 React 渲染时 setState 警告,
  // 且属于路由参数缺失的 graceful redirect 合规场景(铁律 #1 例外)。
  if (!slug) {
    return <Navigate to={ROUTES.studio} replace />;
  }

  // 判断是否在 index 路由（系列总览）还是子路由
  // 2026-05-18 EVE-6: 中文 slug bug — location.pathname 是 URL-encoded(%E6%B5%8B...),
  // ROUTES.seriesDetail(slug) 是 raw 中文,两者永远不等! 导致 SeriesDetail 总是返回 <Outlet />
  // 完整内容(cover header / episode tabs / 新建集按钮)永远不显示
  // 修复: decode 后比较, 或同时 raw + encoded 比较
  const isIndex = decodeURIComponent(location.pathname) === ROUTES.seriesDetail(slug)
    || location.pathname === ROUTES.seriesDetail(slug);

  // 子路由：直接透传 Outlet（数据已在后台加载）
  if (!isIndex) {
    return <Outlet />;
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center h-full">
        <ErrorState
          title="加载失败"
          description={loadError}
          onRetry={() => loadSeries()}
        />
      </div>
    );
  }

  if (loading || !series) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div key="loading-spinner" className="h-6 w-6 border-2 border-[var(--brand-500)] border-t-transparent rounded-full animate-spin" />
          <span key="loading-label" className="text-[var(--fs-sm)] text-[var(--ink-400)]">加载中...</span>
        </div>
      </div>
    );
  }

  // ── 空 episodes 优雅状态（铁律 #1 用户控制权 + #10 优雅空状态 > 强制流程） ─
  if (episodes.length === 0) {
    return (
      <EmptyEpisodesState
        slug={slug}
        series={series}
        creatingEpisode={creatingEpisode}
        onCreateEpisode={handleCreateEpisode}
      />
    );
  }

  // ── computed data ───────────────────────────────────────

  const doneCount = episodes.filter(episodeIsDone).length;
  const storyboardCount = episodes.filter(episodeHasStoryboard).length;
  const needsStoryboardCount = episodes.filter(episodeNeedsStoryboard).length;
  const draftCount = episodes.filter(episodeIsDraft).length;

  const filteredEpisodes =
    epFilter === "all"
      ? episodes
      : epFilter === "done"
        ? episodes.filter(episodeIsDone)
        : epFilter === "active"
          ? episodes.filter((episode) => episodeHasStoryboard(episode) && !episodeIsDone(episode))
          : epFilter === "draft"
            ? episodes.filter(episodeNeedsStoryboard)
            : episodes.filter(episodeIsDraft);

  const coverClass = pickCoverClass(slug);
  // 2026-05-25 — 原 formatLabel 硬编码 "16:9 · 1080×1920", 竖屏系列也显示横屏假数据.
  // 改读 series.defaults.aspect_ratio + 推算分辨率.
  const formatLabel = (() => {
    const ar = series.defaults?.aspect_ratio || "16:9";
    const resolution =
      ar === "9:16" ? "1080×1920" :
      ar === "1:1" ? "1080×1080" :
      ar === "4:3" ? "1440×1080" :
      ar === "3:4" ? "1080×1440" :
      "1920×1080";  // 16:9 + 兜底
    return `${ar} · ${resolution}`;
  })();
  // 2026-07-22 X5-4 (A4-9): 后端 created_at 是 UTC ISO 字符串, 裸 slice(0,10) 在 UTC 16:00-24:00
  // (北京 00:00-08:00) 创建的项目会显错前一天日期. 改走 formatBeijingTime 锁 Asia/Shanghai
  // (undefined/null/无效值它自己会兜底返回 "—", 不需要再包一层三元).
  const createdLabel = formatBeijingTime(series.created_at, { mode: "date" });
  const totalShotCount = episodes.reduce((sum, episode) => sum + (episode.actual_shot_count ?? 0), 0);
  const totalDurationSec = episodes.reduce((sum, episode) => sum + (episode.target_duration_sec ?? 0), 0);
  const totalCostYuan = series.total_cost > 0
    ? `¥${(series.total_cost / 100).toFixed(2)}`
    : "—";
  const currentEpisode = episodes.find((episode) => getEpisodeId(episode) === epId) ?? episodes[0] ?? null;
  const currentEpisodeId = currentEpisode ? getEpisodeId(currentEpisode) : "";
  const currentEpisodeNumber = currentEpisode ? getEpisodeNumber(currentEpisode) : 0;
  // 2026-07-09 audit: 就绪横幅改用本集真实镜数. 旧代码用 series.episode_count(系列集数)当分子分母,
  // 10 集的系列无论本集几个镜都恒显"10/10 分镜就绪"(铁律 #5 状态精确). 用本集 actual_shot_count.
  const readyShotTotal = currentEpisode?.actual_shot_count ?? 0;
  const readyShotPicked = currentEpisode?.picked_video_count ?? readyShotTotal;
  const currentPageLabel = isIndex
    ? "总览"
    : location.pathname.includes("/storyboard/")
    ? "分镜"
    : location.pathname.includes("/compose/")
      ? "合成"
      : location.pathname.includes("/timeline/")
        ? "时间线"
        : "剧本";

  const activeEpisodeId = epId ?? currentEpisodeId;

  // ── render P09 ──────────────────────────────────────────

  return (
    <div className="v24-shell flex flex-col h-full">
      <SeriesHeader
        slug={slug}
        series={series}
        coverClass={coverClass}
        currentEpisode={currentEpisode}
        currentEpisodeNumber={currentEpisodeNumber}
        currentPageLabel={currentPageLabel}
        formatLabel={formatLabel}
        createdLabel={createdLabel}
        totalShotCount={totalShotCount}
        totalDurationSec={totalDurationSec}
      />

      <EpisodeTabs
        episodes={episodes}
        activeEpisodeId={activeEpisodeId}
        creatingEpisode={creatingEpisode}
        onTabClick={handleEpisodeTabClick}
        onCreate={handleCreateEpisode}
      />

      {/* 7.6 All-shots-ready banner */}
      {currentEpisode && currentEpisode.status === "picked" && (
        <div
          key="ready-banner"
          className="flex items-center gap-3 px-6 py-2.5 border-b border-[var(--ok)] bg-[var(--ok-bg)]"
        >
          <Icon name="checkCircle" size={18} style={{ color: "var(--ok)" }} />
          <span className="text-[13px] font-semibold" style={{ color: "var(--ok)" }}>
            {readyShotTotal > 0
              ? `${readyShotPicked}/${readyShotTotal} 分镜就绪，去合成`
              : "本集分镜已就绪，去合成"}
          </span>
          <Button
            variant="primary"
            size="xs"
            iconRight="chevRight"
            onClick={() => navigate(ROUTES.compose(slug, currentEpisodeId))}
          >
            去合成
          </Button>
        </div>
      )}

      {/* ═══ Body: episodes + sidebar ═══ */}
      <div
        key="series-body"
        className="flex-1 grid min-h-0 v24-series-body"
        style={{ gridTemplateColumns: "1fr 280px" }}
      >
        <EpisodeList
          slug={slug}
          episodes={episodes}
          filteredEpisodes={filteredEpisodes}
          epFilter={epFilter}
          onFilterChange={setEpFilter}
          doneCount={doneCount}
          storyboardCount={storyboardCount}
          needsStoryboardCount={needsStoryboardCount}
          draftCount={draftCount}
          isCoverGenerating={isCoverGenerating}
          onEpisodeCoverGen={handleEpisodeCoverGen}
        />

        <SeriesSidebar
          slug={slug}
          series={series}
          episodes={episodes}
          totalCostYuan={totalCostYuan}
          createdLabel={createdLabel}
        />
      </div>
    </div>
  );
}
