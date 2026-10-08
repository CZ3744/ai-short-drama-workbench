import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";
import { PromptDialog } from "../ui/prompt-dialog";
import { Icon } from "../shared/Icon";
import { cn } from "../../lib/cn";
import { createSeries, listSeries, type SeriesRecord } from "../../lib/api";
import { ROUTES } from "../../lib/routes";
import { useSessionStore } from "../../stores/sessionStore";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { formatBeijingTime } from "../../lib/format";

interface CombinedProject {
  slug: string;
  title: string;
  description: string;
  coverPath: string | null;
  episodeCount: number;
  updatedAt: string;
  aspectRatio: string;
}

function slugifyProjectTitle(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `project-${Date.now().toString(36)}`;
}

function projectPathFromCurrent(locationPath: string, nextSlug: string): string {
  return locationPath.replace(/^(\/studio|\/projects)\/[^/]+/, `$1/${nextSlug}`);
}

export function ProjectSwitcher() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentSeriesSlug = useSessionStore((s) => s.currentSeriesSlug);
  const setCurrentSeries = useSessionStore((s) => s.setCurrentSeries);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  void setSettingsOpen; // 2026-05-27 audit P0-11 保留 import 备未来全局抽屉真实现
  const [series, setSeries] = useState<SeriesRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // V-40: 迁 v2 API — 不再调 legacy /api/projects, 只用 listSeries
  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const seriesRes = await listSeries({ includeInternal: true });
      setSeries(seriesRes.series || []);
    } catch {
      setSeries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const items = useMemo<CombinedProject[]>(() => {
    return series.map((item) => ({
      slug: item.slug,
      title: item.title,
      description: item.description || "",
      coverPath: item.cover_url || null,
      episodeCount: item.episode_count ?? 0,
      updatedAt: item.updated_at || item.created_at || "",
      aspectRatio: item.defaults?.aspect_ratio || "16:9",
    }));
  }, [series]);

  const current = useMemo(
    () => items.find((item) => item.slug === currentSeriesSlug) ?? items[0] ?? null,
    [items, currentSeriesSlug],
  );

  const handleSelect = useCallback(
    (slug: string) => {
      setCurrentSeries(slug);
      const nextPath = projectPathFromCurrent(location.pathname, slug);
      // 2026-05-18 EVE-6: 中文 slug url-encoded vs decoded 比较问题, 同 SeriesDetail isIndex bug
      const decodedCurrent = decodeURIComponent(location.pathname);
      navigate(nextPath === location.pathname || nextPath === decodedCurrent
        ? ROUTES.seriesDetail(slug)
        : nextPath);
    },
    [location.pathname, navigate, setCurrentSeries],
  );

  // V-40: 改用 v2 createSeries (不再调 legacy /api/projects)
  const createProjectAction = useAsyncAction(
    async (title: string) => {
      const res = await createSeries({ title });
      return res;
    },
    {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译 + 收掉 as any
      onError: (err: unknown) => showErrorToast(err, "创建项目失败"),
      onSuccess: async (res) => {
        const createdTitle = res.series?.title ?? "新建项目";
        toast.success(`已创建项目「${createdTitle}」`);
        await loadProjects();
        setCreateOpen(false);
        if (res.series?.slug) handleSelect(res.series.slug);
      },
    },
  );
  const creating = createProjectAction.busy;
  const handleCreateProject = useCallback(async (title: string) => {
    await createProjectAction.run(title);
  }, [createProjectAction]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-10 min-w-[220px] justify-start gap-3 px-3",
            "bg-white/75 border border-[var(--ink-100)] shadow-[var(--shadow-sm)]",
          )}
          title={current ? `${current.title} · ${current.episodeCount} 集` : "选择项目"}
        >
          <span
            className="mk-thumb mk-thumb--empty shrink-0"
            style={{
              width: 28,
              height: 28,
              borderRadius: "var(--r-md)",
              background: current?.coverPath
                ? `linear-gradient(135deg, var(--brand-50), var(--ink-50)), url(${current.coverPath})`
                : "var(--brand-50)",
              backgroundSize: current?.coverPath ? "cover" : "auto",
              backgroundPosition: "center",
            }}
          >
            {!current?.coverPath && (
              <Icon name="layers" size={14} className="text-[var(--brand-700)]" />
            )}
          </span>
          <span className="flex-1 min-w-0 text-left">
            <span className="block truncate text-[var(--fs-sm)] font-medium text-[var(--ink-900)]">
              {current?.title || "选择项目"}
            </span>
            <span className="block truncate text-[11px] text-[var(--ink-400)]">
              {current ? `${current.episodeCount} 集 · ${current.aspectRatio}` : "本地项目切换"}
            </span>
          </span>
          <Icon name="chevDown" size={14} className="text-[var(--ink-400)] shrink-0" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[360px] p-0" align="start" sideOffset={8}>
        <div className="border-b border-[var(--ink-100)] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[var(--fs-sm)] font-semibold text-[var(--ink-900)]">项目切换</div>
              <div className="text-[11px] text-[var(--ink-400)]">
                {loading ? "正在刷新项目列表..." : `${items.length} 个项目`}
              </div>
            </div>
            {/* 2026-05-27 audit P0-11: setSettingsOpen flag 没人读, 改 navigate("/settings") */}
            <Button variant="ghost" size="sm" className="h-8 px-2.5" onClick={() => navigate("/settings")}>
              <Icon name="settings" size={13} />
              项目设置
            </Button>
          </div>
        </div>

        <ScrollArea className="max-h-[320px]">
          <div className="p-2">
            {items.map((item) => {
              const active = item.slug === currentSeriesSlug;
              return (
                <button
                  key={item.slug}
                  type="button"
                  onClick={() => handleSelect(item.slug)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-[var(--r-md)] px-3 py-2 text-left transition-colors",
                    active
                      ? "bg-[var(--brand-50)] text-[var(--brand-700)]"
                      : "text-[var(--ink-700)] hover:bg-[var(--ink-50)]",
                  )}
                >
                  <span
                    className="mk-thumb mk-thumb--empty shrink-0"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "var(--r-sm)",
                      background: item.coverPath
                        ? `linear-gradient(135deg, var(--brand-50), var(--ink-50)), url(${item.coverPath})`
                        : "var(--ink-50)",
                      backgroundSize: item.coverPath ? "cover" : "auto",
                      backgroundPosition: "center",
                    }}
                  >
                    {!item.coverPath && <Icon name="film" size={13} className="text-[var(--ink-400)]" />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-[var(--fs-sm)] font-medium">
                      {item.title}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--ink-400)]">
                      {item.episodeCount} 集 · {item.updatedAt ? formatBeijingTime(item.updatedAt, { mode: "date" }) : "暂无更新"}
                    </span>
                    {item.description && (
                      <span className="block truncate text-[11px] text-[var(--ink-400)]">
                        {item.description}
                      </span>
                    )}
                  </span>
                  {active && <Icon name="check" size={14} className="mt-0.5 text-[var(--brand-600)]" />}
                </button>
              );
            })}

            {items.length === 0 && (
              <div className="px-3 py-8 text-center text-[var(--fs-sm)] text-[var(--ink-400)]">
                暂无项目
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--ink-100)] px-3 py-3">
          <Button variant="outline" size="sm" className="h-8" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={13} />
            新建项目
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => navigate(ROUTES.seriesDetail(currentSeriesSlug || items[0]?.slug || "default"))}
          >
            打开当前项目
          </Button>
        </div>
      </PopoverContent>
      <PromptDialog
        open={createOpen}
        title="新建项目"
        description="项目会作为一个本地制作空间，用来承载系列、分集、素材和导出结果。"
        label="项目名称"
        placeholder="例如：雨夜便利店短剧"
        confirmText="创建项目"
        busy={creating}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreateProject}
      />
    </Popover>
  );
}

export default ProjectSwitcher;
