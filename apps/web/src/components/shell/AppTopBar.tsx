import { useMemo } from "react";
import { useNavigate, useLocation, useMatch } from "react-router-dom";
import { useSessionStore } from "../../stores/sessionStore";
import { useTasksStore } from "../../stores/tasksStore";
import { Button } from "../ui/button";
import { Icon } from "../shared/Icon";

export interface AppTopBarProps {
  className?: string;
  children?: React.ReactNode;
  navigationOpen?: boolean;
  onToggleNavigation?: () => void;
}

const PAGE_LABELS: Record<string, string> = {
  inbox: "灵感收件箱", script: "剧本创作", storyboard: "分镜规划", "shot-stage": "单镜创作",
  compose: "合成作品", characters: "角色", scenes: "场景", elements: "素材库", timeline: "时间线",
  "mood-board": "视觉风格", settings: "设置", status: "系统状态", trash: "回收站", vault: "归档柜", library: "素材库",
};

export function AppTopBar({ className, children, navigationOpen, onToggleNavigation }: AppTopBarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const route = useMatch("/studio/:slug/*");
  const currentSlug = useSessionStore((state) => state.currentSeriesSlug);
  const seriesCost = useSessionStore((state) => state.seriesCost ?? 0);
  const seriesList = useSessionStore((state) => state.seriesList);
  const events = useTasksStore((state) => state.events);
  const tasks = useTasksStore((state) => state.tasks);
  const taskCount = useMemo(() => {
    const taskJobs = new Set(Object.values(tasks).flatMap((task) => task.job_id ? [task.job_id] : []));
    return Object.values(tasks).filter((task) => task.status === "running" || task.status === "queued").length
      + Object.values(events).filter((event) => !taskJobs.has(event.jobId) && (event.status === "running" || event.status === "queued")).length;
  }, [tasks, events]);
  const activeSlug = route?.params.slug;
  const title = activeSlug ? seriesList.find((series) => series.slug === activeSlug)?.title : undefined;
  const parts = location.pathname.split("/").filter(Boolean);
  const pageLabel = activeSlug
    ? parts[2] === "shot-stage" && parts[5] === "failures" ? "镜头失败记录" : PAGE_LABELS[parts[2]] ?? "系列总览"
    : PAGE_LABELS[parts[0]] ?? "我的系列";
  const costIsCurrent = activeSlug && activeSlug === currentSlug && title;

  return (
    <header className={`studio-topbar ${className ?? ""}`}>
      {onToggleNavigation && <Button className="studio-nav-toggle" aria-expanded={navigationOpen} aria-controls="studio-navigation" onClick={onToggleNavigation} iconLeft={navigationOpen ? "close" : "list"}>{navigationOpen ? "收起导航" : "导航"}</Button>}
      <nav className="studio-breadcrumbs" aria-label="当前位置">
        <Button variant="ghost" size="sm" iconLeft="home" onClick={() => navigate("/studio")}>主页</Button>
        {activeSlug && <><span aria-hidden="true">/</span><Button className="studio-breadcrumb-project" variant="ghost" size="sm" onClick={() => navigate(`/studio/${encodeURIComponent(activeSlug)}`)} title={title}>{title ?? "正在加载系列…"}</Button></>}
        <span aria-hidden="true">/</span><span className="studio-breadcrumb-current" aria-current="page">{pageLabel}</span>
      </nav>
      <div className="studio-topbar-spacer" />
      <div className="studio-topbar-status" aria-label="生成状态">
        {costIsCurrent && <span className="studio-cost"><span>本系列累计</span><strong>¥{(seriesCost / 100).toFixed(2)}</strong></span>}
        {taskCount > 0 && <span className="studio-task-status"><Icon name="refresh" size={13} className="mk-spin" />{taskCount} 个任务进行中</span>}
      </div>
      <div className="global-tools" aria-label="工作台工具">{children}</div>
    </header>
  );
}

export default AppTopBar;
