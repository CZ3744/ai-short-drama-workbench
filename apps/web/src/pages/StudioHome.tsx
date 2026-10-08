import type { CoverGenerationOptions } from "../lib/seriesApi";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import { Icon } from "../components/shared/Icon";
import { Button } from "../components/ui/button";
import { CreateSeriesDialog } from "../components/studio/CreateSeriesDialog";
import { BatchSeriesDialog } from "../components/studio/batch-series/BatchSeriesDialog";
import { PageTransition } from "../components/studio/PageTransition";
import { StudioSeriesCard, coverFor } from "../components/studio/StudioSeriesCard";
import { useConfirm } from "../components/ui/ConfirmModal";
import { listSeries, createSeries, duplicateSeries, deleteSeries, generateSeriesCover, getSeries, type SeriesRecord } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";
import { useSessionStore } from "../stores/sessionStore";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useToggleSet } from "../hooks/useToggleSet";
import { formatRelativeTime as relTime } from "../lib/format";
import { labelEpisodeId } from "../lib/sourceLabels";

function getGreeting() {
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "numeric", hour12: false }));
  return hour >= 5 && hour < 12 ? "早上好" : hour >= 12 && hour < 18 ? "下午好" : "晚上好";
}
export default function StudioHome() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const currentSeriesSlug = useSessionStore((s) => s.currentSeriesSlug);
  const currentEpisodeId = useSessionStore((s) => s.currentEpisodeId);
  const setCurrentSeries = useSessionStore((s) => s.setCurrentSeries);
  const [createOpen, setCreateOpen] = useState(false);
  // 2026-05-19 反馈 #9: 批量 AI 生成系列
  const [batchOpen, setBatchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "created" | "title" | "episodes">("recent");
  // 2026-05-19: 防并发 — 删/复制点了之后置位, 期间 ⋯ 菜单按钮置灰
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  // 2026-07-22 Y6 UP-9: 批量清理测试残卡 — 只给工具, 不代删/不自动删(C-2 公理). 用户自己勾选 +
  // 二次确认才移入回收站(既有系列软删, 90 天保留可恢复).
  const [batchMode, setBatchMode] = useState(false);
  const selected = useToggleSet<string>();
  const [batchDeleting, setBatchDeleting] = useState(false);
  // "筛 0 分镜系列" 快捷筛选 — 懒计算(点了才拉), 不在首屏对每个系列多发请求.
  const [zeroShotOnly, setZeroShotOnly] = useState(false);
  const [shotCounts, setShotCounts] = useState<Record<string, number>>({});
  const [computingShotCounts, setComputingShotCounts] = useState(false);

  const { data, error, isLoading, isValidating, mutate } = useSWR(
    "studio:series-list",
    () => listSeries(),
    { revalidateOnFocus: false },
  );

  const seriesList: SeriesRecord[] = data?.series ?? [];

  // 2026-07-22 Y6 UP-9: 0 分镜快捷筛选 — 每个系列的分镜数 = 该系列所有分集 actual_shot_count 之和
  // (复用既有 getSeries() 返回的 enrichEpisodeWithStats 数据, 跟分集页/分镜板同一份真理源).
  // 拉取失败的系列保守地不计入"0 分镜"结果(sentinel -1), 避免因网络抖动误判成可清理对象.
  async function handleToggleZeroShotFilter() {
    if (zeroShotOnly) { setZeroShotOnly(false); return; }
    setComputingShotCounts(true);
    try {
      const entries = await Promise.all(
        seriesList.map(async (s) => {
          try {
            const { episodes } = await getSeries(s.slug);
            const total = episodes.reduce((n, ep) => n + (ep.actual_shot_count ?? 0), 0);
            return [s.slug, total] as const;
          } catch {
            return [s.slug, -1] as const;
          }
        }),
      );
      setShotCounts(Object.fromEntries(entries));
      setZeroShotOnly(true);
      const unavailable = entries.filter(([, count]) => count < 0).length;
      if (unavailable) toast.warning(`${unavailable} 个系列暂时无法统计，已保留在全部系列中。`);
    } catch (err) {
      showErrorToast(err, "统计分镜数失败");
    } finally {
      setComputingShotCounts(false);
    }
  }

  const displayedSeriesList = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return seriesList.filter((series) => (!zeroShotOnly || shotCounts[series.slug] === 0)
      && (!search || `${series.title} ${series.synopsis ?? ""} ${series.description ?? ""}`.toLocaleLowerCase().includes(search)))
      .sort((a, b) => {
        if (sort === "title") return a.title.localeCompare(b.title, "zh-CN", { numeric: true });
        if (sort === "episodes") return b.episode_count - a.episode_count || b.updated_at.localeCompare(a.updated_at);
        return (sort === "created" ? b.created_at : b.updated_at).localeCompare(sort === "created" ? a.created_at : a.updated_at);
      });
  }, [seriesList, query, sort, zeroShotOnly, shotCounts]);

  const continueCard = useMemo(() => {
    if (!currentSeriesSlug) return null;
    const last = seriesList.find((s) => s.slug === currentSeriesSlug);
    return last ? { series: last, epId: currentEpisodeId } : null;
  }, [currentSeriesSlug, currentEpisodeId, seriesList]);

  // useAsyncAction 接管 busy + 错误 — 重复点击在 busy=true 时 noop.
  // 2026-05-26 audit #9: input 接 CreateSeriesData 6 个 optional 高级参数, 全部进 defaults JSON.
  const createAction = useAsyncAction(
    async (input: import("../components/studio/CreateSeriesDialog").CreateSeriesData) =>
      createSeries({
        title: input.title,
        synopsis: input.synopsis,
        defaults: {
          content_type: input.type,
          // 2026-05-26 walkthrough fix: 类型预设带"竖屏 1080×1920" 文案 (CreateSeriesDialog 行 44),
          // 但 aspect_ratio 没真存进 defaults → 用户预期竖屏短剧但 series.defaults.aspect_ratio 是 16:9.
          // 这里跟着 content_type 给个合理默认 (用户仍可在 SeriesDetail 改).
          aspect_ratio: input.type === "short" ? "9:16" : "16:9",
          // 全部 optional, undefined 不写进去 (后端 JSON 不污染)
          ...(input.tone ? { tone: input.tone } : {}),
          ...(input.pacing ? { pacing: input.pacing } : {}),
          ...(input.episodes_target ? { episodes_target: input.episodes_target } : {}),
          ...(input.duration_target_sec ? { duration_target_sec: input.duration_target_sec } : {}),
          ...(input.default_llm ? { default_llm: input.default_llm } : {}),
          ...(input.default_image ? { default_image: input.default_image } : {}),
          ...(input.default_video ? { default_video: input.default_video } : {}),
        },
      }),
    {
      errorMessage: "创建系列失败",
      onSuccess: async ({ series }) => {
        await mutate();
        setCreateOpen(false);
        toast.success(`「${series.title}」已创建`, {
          action: { label: "开始创作", onClick: () => navigate(`/studio/${encodeURIComponent(series.slug)}/inbox`) },
          duration: 8000,
        });
      },
    },
  );
  const creating = createAction.busy;
  async function handleCreate(input: import("../components/studio/CreateSeriesDialog").CreateSeriesData) {
    await createAction.run(input);
  }

  // 2026-05-21 — 生成系列封面 (铁律 #4 就近决策: 封面在哪显示, 生成按钮就在哪).
  // 用 Set 记 generating 中的 slug, 同时支持多系列并发生成, 各卡片独立 loading 状态.
  const { add: addCoverGenerating, remove: removeCoverGenerating, has: isCoverGenerating } = useToggleSet<string>();
  async function handleGenerateCover(s: SeriesRecord, opts: CoverGenerationOptions = {}) {
    if (isCoverGenerating(s.slug)) return;
    addCoverGenerating(s.slug);
    try {
      await generateSeriesCover(s.slug, opts);
      await mutate();
      toast.success(`「${s.title}」封面已生成`);
    } catch (err) {
      showErrorToast(err, "生成封面失败");
    } finally {
      removeCoverGenerating(s.slug);
    }
  }

  // 2026-05-19: 复制系列 — 后端 duplicateSeries 已就绪, fork 整个 data/series/<slug>/ 目录树
  async function handleDuplicate(s: SeriesRecord) {
    if (pendingSlug) return;
    try {
      setPendingSlug(s.slug);
      const { series } = await duplicateSeries(s.slug);
      await mutate();
      toast.success(`已复制为「${series.title}」`);
    } catch (err) {
      showErrorToast(err, "复制系列失败");
    } finally {
      setPendingSlug(null);
    }
  }

  // 2026-05-19: 移到回收站 — 后端软删, 90 天内可手动从 data/series/_trash/ 恢复
  // 跟铁律 #6 数据保留 > 直接删除对齐.
  async function handleDelete(s: SeriesRecord) {
    if (pendingSlug) return;
    const ok = await confirm({
      title: `把「${s.title}」移到回收站?`,
      description: [
        `${s.episode_count} 集 · ${relTime(s.updated_at)} 更新${s.total_cost > 0 ? ` · 累计成本 ¥${(s.total_cost / 100).toFixed(2)}` : ""}`,
        "",
        "整个系列(剧本/分镜/角色/场景/素材/已合成视频)会移到回收站。",
        "90 天内可以从回收站恢复。",
      ].join("\n"),
      variant: "destructive",
      confirmLabel: "移到回收站",
    });
    if (!ok) return;
    try {
      setPendingSlug(s.slug);
      await deleteSeries(s.slug);
      // 若删的是"当前系列", 清掉 session 避免"继续上次"卡片指向已删项目
      if (currentSeriesSlug === s.slug) setCurrentSeries(null);
      await mutate();
      toast.success(`已把「${s.title}」移到回收站`);
    } catch (err) {
      showErrorToast(err, "删除系列失败");
    } finally {
      setPendingSlug(null);
    }
  }

  // 2026-07-22 Y6 UP-9: 批量移到回收站 — 跟单个删除走同一条后端软删(90 天保留可恢复), 只是循环调用.
  // 二次确认 + 用 Promise.allSettled 容忍部分失败(网络抖动/并发冲突), 失败的留在列表里不吞掉.
  async function handleBatchDelete() {
    const slugs = selected.toArray();
    if (slugs.length === 0 || batchDeleting) return;
    const picked = seriesList.filter((s) => slugs.includes(s.slug));
    const titleSample = picked.slice(0, 5).map((s) => s.title).join("、");
    const ok = await confirm({
      title: `把选中的 ${slugs.length} 个系列移到回收站?`,
      description: [
        titleSample + (picked.length > 5 ? ` 等 ${picked.length} 部` : ""),
        "",
        "每个系列的整套内容(剧本/分镜/角色/场景/素材/已合成视频)都会移到回收站。",
        "90 天内可在回收站逐个恢复, 不会立即永久删除。",
      ].join("\n"),
      variant: "destructive",
      confirmLabel: `移到回收站 (${slugs.length})`,
    });
    if (!ok) return;
    setBatchDeleting(true);
    try {
      const results = await Promise.allSettled(slugs.map((slug) => deleteSeries(slug)));
      const failed = results
        .map((r, i) => ({ r, slug: slugs[i] }))
        .filter((x) => x.r.status === "rejected");
      const succeededCount = slugs.length - failed.length;
      if (currentSeriesSlug && slugs.some((slug, index) => slug === currentSeriesSlug && results[index].status === "fulfilled")) setCurrentSeries(null);
      await mutate();
      // 选中集合收敛成"只剩失败的" — 成功的自然从选中里消失, 失败的留着方便用户重试.
      selected.replace(failed.map((x) => x.slug));
      if (failed.length === 0) {
        toast.success(`已把 ${succeededCount} 个系列移到回收站`);
        setBatchMode(false);
      } else {
        toast.error(`${succeededCount} 个成功, ${failed.length} 个失败(仍选中, 可重试)`);
      }
    } finally {
      setBatchDeleting(false);
    }
  }

  return (
    <PageTransition className="studio-home-transition">
      <div className="v24-studio-home studio-home">
        <header className="studio-home-heading">
          <div>
            <div className="studio-eyebrow"><span />你的创作工作台</div>
            <h1>{getGreeting()}，让故事发生。</h1>
            <p>从一个想法，到一部作品。按你的节奏，继续创造。</p>
          </div>
          <div className="studio-home-heading-actions">
            <Button variant="secondary" iconLeft="sparkles" onClick={() => setBatchOpen(true)} disabled={creating}>批量 AI 生成</Button>
            <Button variant="primary" iconLeft="plus" loading={creating} onClick={() => setCreateOpen(true)}>{creating ? "创建中…" : "新建系列"}</Button>
          </div>
        </header>

        {continueCard && (
          <section className="studio-resume" aria-label="继续上次创作">
            <div className="studio-resume-mark" style={{ background: coverFor(continueCard.series.slug) }}><Icon name="bookOpen" size={24} /></div>
            <div className="studio-resume-copy">
              <span className="studio-eyebrow">接着上次的灵感</span>
              <h2>{continueCard.series.title}{continueCard.epId ? ` · ${labelEpisodeId(continueCard.epId)}` : ""}</h2>
              <p>{continueCard.series.episode_count} 集 · {relTime(continueCard.series.updated_at)}更新</p>
            </div>
            <Button variant="secondary" iconRight="arrowRight" onClick={() => navigate(continueCard.epId ? `/studio/${encodeURIComponent(continueCard.series.slug)}/storyboard/${encodeURIComponent(continueCard.epId)}` : `/studio/${encodeURIComponent(continueCard.series.slug)}/inbox`)}>继续创作</Button>
          </section>
        )}

        <section className="studio-projects" aria-labelledby="studio-projects-title">
          <div className="studio-section-heading">
            <h2 id="studio-projects-title">我的系列 <span>{isLoading && !data ? "…" : seriesList.length}</span></h2>
            <div className="studio-section-actions">
              <Button variant="ghost" size="sm" iconLeft="trash" onClick={() => navigate("/trash?tab=series")}>回收站</Button>
              <Button variant="ghost" size="sm" iconLeft="refresh" loading={isValidating} onClick={() => void mutate()}>刷新</Button>
            </div>
          </div>
          <div className="studio-library-toolbar">
            <label className="studio-search">
              <Icon name="search" size={17} />
              <input type="search" aria-label="搜索系列" placeholder="搜索系列名称或故事简介" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <label className="studio-sort"><span>排序</span><select aria-label="系列排序" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="recent">最近更新</option><option value="created">最近创建</option><option value="title">名称 A–Z</option><option value="episodes">集数最多</option></select></label>
            <Button variant={zeroShotOnly ? "primary" : "secondary"} size="sm" iconLeft="filter" aria-pressed={zeroShotOnly} loading={computingShotCounts} disabled={batchDeleting || isLoading || seriesList.length === 0} onClick={() => void handleToggleZeroShotFilter()}>{computingShotCounts ? "统计分镜中…" : "尚无分镜"}</Button>
            <Button variant={batchMode ? "primary" : "secondary"} size="sm" iconLeft={batchMode ? "close" : "check"} aria-pressed={batchMode} disabled={batchDeleting || isLoading || seriesList.length === 0} onClick={() => { setBatchMode(!batchMode); selected.clear(); }}>{batchMode ? "退出管理" : "批量管理"}</Button>
          </div>
          {batchMode && <div className="studio-selection-bar" role="status">
            <span>已选择 <strong>{selected.size}</strong> 个系列</span>
            <Button variant="ghost" size="sm" iconLeft="check" disabled={batchDeleting || displayedSeriesList.length === 0} onClick={() => {
              const allVisibleSelected = displayedSeriesList.every((series) => selected.has(series.slug));
              const visible = new Set(displayedSeriesList.map((series) => series.slug));
              selected.replace(allVisibleSelected ? selected.toArray().filter((slug) => !visible.has(slug)) : [...selected.toArray(), ...visible]);
            }}>{displayedSeriesList.length > 0 && displayedSeriesList.every((series) => selected.has(series.slug)) ? "取消本页选择" : "选择当前结果"}</Button>
            <Button variant="danger" size="sm" iconLeft="trash" disabled={selected.size === 0} loading={batchDeleting} onClick={() => void handleBatchDelete()}>移到回收站</Button>
          </div>}
          {(query.trim() || zeroShotOnly) && <div className="studio-filter-summary" role="status"><span>找到 {displayedSeriesList.length} 个系列{zeroShotOnly ? " · 尚无分镜" : ""}</span><Button variant="ghost" size="xs" iconLeft="close" onClick={() => { setQuery(""); setZeroShotOnly(false); }}>清除筛选</Button></div>}
          {error && <div className="studio-list-error" role="alert"><Icon name="warning" size={20} /><div><strong>{data ? "暂时无法刷新系列" : "系列暂时没有加载成功"}</strong><p>{data ? "当前保留上次加载的内容。连接恢复后可以重试。" : "请确认工作台服务已启动，再重新加载。你的作品不会因此丢失。"}</p></div><Button variant="secondary" size="sm" iconLeft="refresh" loading={isValidating} onClick={() => void mutate()}>重新加载</Button></div>}
          <div className="studio-project-results" aria-busy={isLoading || isValidating}>
            {isLoading && !data ? <div className="studio-project-grid" role="status" aria-label="正在加载系列">{Array.from({ length: 6 }, (_, index) => <div className="studio-project-skeleton" key={index} aria-hidden="true"><div /><span /><span /></div>)}</div>
              : !data && error ? null
              : seriesList.length === 0 ? <div className="studio-welcome">
                <div className="studio-welcome-art" aria-hidden="true"><div /><div /><div><Icon name="edit" size={31} /></div></div>
                <span className="studio-eyebrow">每个故事，都有第一幕</span>
                <h2>你的下一个故事，从这里开始</h2>
                <p>先起一个名字，写下一点灵感。剧本、人物和镜头，都可以在创作中慢慢完善。</p>
                <Button variant="primary" iconLeft="plus" onClick={() => setCreateOpen(true)}>创建第一个系列</Button>
                <div className="studio-workflow-preview"><span><Icon name="edit" size={15} />写下故事</span><Icon name="arrowRight" size={13} /><span><Icon name="image" size={15} />构思画面</span><Icon name="arrowRight" size={13} /><span><Icon name="film" size={15} />完成作品</span></div>
              </div>
              : displayedSeriesList.length === 0 ? <div className="studio-no-results"><Icon name="search" size={30} /><h3>没有找到匹配的系列</h3><p>试试其他关键词，或清除筛选查看全部作品。</p><Button variant="secondary" iconLeft="close" onClick={() => { setQuery(""); setZeroShotOnly(false); }}>清除筛选</Button></div>
              : <div className="studio-project-grid">{displayedSeriesList.map((series) => <StudioSeriesCard key={series.slug} series={series} onDuplicate={() => void handleDuplicate(series)} onDelete={() => void handleDelete(series)} onGenerateCover={(opts) => void handleGenerateCover(series, opts)} generatingCover={isCoverGenerating(series.slug)} busy={!!pendingSlug || batchDeleting} batchMode={batchMode} selected={selected.has(series.slug)} onToggleSelect={() => selected.toggle(series.slug)} />)}
                {!batchMode && !query.trim() && !zeroShotOnly && <button type="button" className="studio-new-project" onClick={() => setCreateOpen(true)}><span><Icon name="plus" size={25} /></span><strong>新的故事，新的可能</strong><small>新建系列</small></button>}
              </div>}
          </div>
        </section>
        <CreateSeriesDialog open={createOpen} busy={creating} onClose={() => setCreateOpen(false)} onCreate={handleCreate} existingTitles={seriesList.map((series) => series.title)} />
        <BatchSeriesDialog open={batchOpen} onClose={() => setBatchOpen(false)} onCreated={() => { void mutate(); }} existingTitles={seriesList.map((series) => series.title)} />
      </div>
    </PageTransition>
  );
}
