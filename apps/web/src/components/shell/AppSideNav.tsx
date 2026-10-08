// v24-batch-all · 生产侧栏 (重写 · 2026-05-13)
// 来源: design-skill/video-generate/src/shell.jsx (SideNav, line 117-199)
// 旧版备份: apps/web/src/_legacy/components_shell/AppSideNav.tsx.legacy
//
// 视觉对齐 v24 设计稿:
//   - 232px 宽 · 米黄底色 · 右侧 1px ink-100 边
//   - 当前集卡片 (含进度条) 顶部
//   - 4 段分组导航: 顶部驾驶舱 / 制作 / 素材 / 底部 (归档柜/公共/诊断/设置)
//   - 底部任务驾驶舱小条
//
// 保留生产功能:
//   - react-router-dom 路由 (useNavigate / useLocation)
//   - sessionStore 当前系列/集
//   - useEpisode 拿当前集 ID
//   - 阶段锁定 (未选系列时菜单变 disabled)
import { useNavigate, useLocation, useMatch } from "react-router-dom";
import { toast } from "sonner";
import { useSessionStore } from "../../stores/sessionStore";
import { useEpisode } from "../../hooks/useEpisode";
import { useShots } from "../../hooks/useShots";
import { Icon, type IconName } from "../shared/Icon";
import { labelEpisodeId } from "../../lib/sourceLabels";

interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  to?: string; // 缺省 = 路径由 slug/epId 拼接
  dot?: "brand";
  chevron?: boolean;
  requiresSlug?: boolean;
  requiresEp?: boolean;
  /** 2026-05-19 #12: 缩进 14px 显出子项从属关系 */
  indented?: boolean;
}

interface NavSection {
  title?: string;
  /** 2026-05-19 #12: section title 跳目标 (可点击) */
  titleTo?: string;
  /** 2026-05-19 #12: title 对应的 activeId, 让 active 高亮指向 header */
  titleId?: string;
  items: NavItem[];
}

function buildSections(slug: string | null, epId: string | null): NavSection[] {
  const s = slug ?? "";
  const e = epId ?? "";
  return [
    {
      items: [
        // 2026-05-26 audit #8: 原 "生产驾驶舱" + "系统诊断" + "失败中心" 3 入口合成 "系统状态" 1 入口.
        { id: "system",   label: "系统状态", icon: "gauge", to: "/status" },
      ],
    },
    {
      title: "制作",
      items: [
        { id: "inbox",     label: "灵感收件箱", icon: "inbox", to: s ? `/studio/${s}/inbox` : undefined, requiresSlug: true },
        { id: "script",    label: "剧本", icon: "doc",   to: s ? `/studio/${s}/script` : undefined, requiresSlug: true },
        { id: "shotboard", label: "分镜", icon: "shot",  to: s ? `/studio/${s}/storyboard` : undefined, requiresSlug: true },
        { id: "compose",   label: "合成", icon: "film",  to: s && e ? `/studio/${s}/compose/${e}` : undefined, requiresSlug: true, requiresEp: true },
      ],
    },
    {
      // 2026-05-19 #12: 「素材」section title 改成可点击 = 跳全部素材, 删除"全部素材" item, 子项缩进显从属.
      // 用户原话: "第一行的全部素材和下面几行不应该并列, 现在看起来是并列的, 展现不出层级关系".
      title: "素材",
      titleTo: s ? `/studio/${s}/elements` : undefined,
      titleId: "el-all",
      items: [
        { id: "character",    label: "角色",     icon: "user",     to: s ? `/studio/${s}/elements/kind/character` : undefined, requiresSlug: true, indented: true },
        { id: "scene",        label: "场景",     icon: "image",    to: s ? `/studio/${s}/elements/kind/scene` : undefined, requiresSlug: true, indented: true },
        { id: "el-prop",      label: "物品",     icon: "grid",     to: s ? `/studio/${s}/elements/kind/prop` : undefined, requiresSlug: true, indented: true },
        { id: "el-wardrobe",  label: "服装",     icon: "layers",   to: s ? `/studio/${s}/elements/kind/wardrobe` : undefined, requiresSlug: true, indented: true },
        { id: "el-reference", label: "参考照片", icon: "image",    to: s ? `/studio/${s}/elements/kind/reference` : undefined, requiresSlug: true, indented: true },
        { id: "el-misc",      label: "杂物",     icon: "package",  to: s ? `/studio/${s}/elements/kind/misc` : undefined, requiresSlug: true, indented: true },
        // 2026-05-26 audit #1: 回收站变全局 /trash, 不再 series-scope. 没系列也能进 (series tab 工作).
        // 2026-05-26 Codex P2-8: 统一术语 "垃圾桶" → "回收站", 跟 trash/系列回收站 / 候选废案库分开,
        // 减少用户认知负担 (废案库 = 单镜候选废弃池, 归档柜 = vault 全部成功素材).
        { id: "trash",        label: "回收站",   icon: "trash",    to: "/trash", indented: true },
      ],
    },
    {
      // 2026-05-26 audit #2: 公共资源库已合并到归档柜 (顶部范围 tab 切"本系列 / 全局").
      // 2026-05-26 audit #6: 删「我的剧组」入口 — 素材组已搬到素材库.
      // 2026-05-26 audit #8: "系统诊断" 已合到顶部 "系统状态" 入口, 这一组里删掉.
      items: [
        { id: "archive",  label: "归档柜",             icon: "archive", to: "/vault" },
        { id: "settings", label: "设置",               icon: "settings", to: "/settings" },
      ],
    },
  ];
}

// nav item 实际跳转目标. 解除"灰锁"限制 (2026-05-13 用户需求): 即使前置条件 (系列/集) 缺失,
// 也允许点击, 跳到能引导用户的 fallback page. 不再 disabled / not-allowed / 显示锁图标.
function resolveNavTarget(item: NavItem, slug: string | null, epId: string | null): string | undefined {
  // 不需要 slug 的 item (驾驶舱/归档柜/设置等): 直接用 item.to
  if (!item.requiresSlug) return item.to;
  // 需要 slug 但没 slug → 跳主页让选系列
  if (!slug) return "/studio";
  // 需要 epId 但没 epId → 跳系列总览, 那里 SeriesOverviewPlaceholder 引导用户选/造集
  if (item.requiresEp && !epId) return `/studio/${slug}`;
  // 条件齐全: 用 buildSections 拼好的 to
  return item.to;
}

// 路由 → activeId 映射
function detectActiveId(pathname: string): string {
  // 2026-05-26 audit #4: /cockpit / /diagnostics / /failures redirect 后 URL 已经变 /status, 这里
  // 永远不会再命中老路径. 只判断 /status 一个即可.
  if (pathname.startsWith("/status")) {
    return "system";
  }
  // 2026-05-26 audit #1: 全局 /trash 走"垃圾桶"高亮 (跟素材组下的"垃圾桶"项一致, 不在系列 scope).
  if (pathname.startsWith("/trash")) return "trash";
  if (pathname.startsWith("/vault")) return "archive";
  if (pathname.startsWith("/settings")) return "settings";

  // /studio/:slug/... 路径
  const inSlug = pathname.match(/\/studio\/[^/]+\/([^/]+)/);
  if (inSlug) {
    const sub = inSlug[1];
    if (sub === "inbox") return "inbox";
    if (sub === "script") return "script";
    if (sub === "storyboard" || sub === "shot-stage" || sub === "timeline") return "shotboard";
    if (sub === "compose") return "compose";
    if (sub === "characters") return "character";
    if (sub === "scenes") return "scene";
    if (sub === "elements") {
      // /studio/:slug/elements 或 /elements/kind/<kind> 或 /elements/<id>
      if (pathname.includes("/elements/kind/character")) return "character";
      if (pathname.includes("/elements/kind/scene")) return "scene";
      if (pathname.includes("/elements/kind/prop")) return "el-prop";
      if (pathname.includes("/elements/kind/wardrobe")) return "el-wardrobe";
      if (pathname.includes("/elements/kind/reference")) return "el-reference";
      if (pathname.includes("/elements/kind/misc")) return "el-misc";
      return "el-all";
    }
    // 旧路由兼容: library / mood-board 已废弃, 高亮回「全部素材」
    if (sub === "library" || sub === "mood-board") return "el-all";
  }
  // 2026-05-25 — 主页(/ 或 /studio 无 slug)或未识别路径: 不高亮任何 nav item.
  // 旧 fallback "cockpit" 导致用户在主页时左侧栏"生产驾驶舱"误高亮 (用户原话截图反馈).
  return "";
}

export function AppSideNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const route = useMatch("/studio/:slug/*");
  const currentSlug = useSessionStore((state) => state.currentSeriesSlug);
  const currentEpId = useSessionStore((state) => state.currentEpisodeId);
  const activeSlug = route?.params.slug ?? currentSlug;
  const epId = activeSlug === currentSlug ? currentEpId : null;
  const { data: episode } = useEpisode(activeSlug ?? undefined, epId ?? undefined);
  const { shots } = useShots(activeSlug ?? undefined, epId ?? undefined);
  const episodeTitle = episode?.title ?? (epId ? labelEpisodeId(epId) : "选择一集开始创作");
  const isStudioHome = location.pathname === "/" || location.pathname === "/studio";
  const completedShots = shots.filter((shot) => !!shot.picked_video_id).length;
  const episodeProgress = shots.length ? Math.round(completedShots / shots.length * 100) : 0;
  const sections = buildSections(activeSlug ?? null, epId);
  const activeId = detectActiveId(location.pathname);

  return (
    <nav className="studio-sidenav" aria-label="主导航">
      <button type="button" className="studio-brand" onClick={() => navigate("/studio")} aria-label="AI 短剧生成工作台，返回主页">
        <span className="studio-brand-symbol"><Icon name="sparkles" size={23} /></span>
        <span><strong>AI 短剧生成工作台</strong><small>让灵感成为作品</small></span>
      </button>
      <button type="button" className={`studio-nav-item studio-nav-home${isStudioHome ? " is-active" : ""}`} aria-current={isStudioHome ? "page" : undefined} onClick={() => navigate("/studio")}><Icon name="home" size={17} /><span>我的系列</span></button>
      {!isStudioHome && activeSlug && <div className="studio-current-episode">
        <span className="studio-eyebrow">当前创作</span>
        <strong>{episodeTitle}</strong>
        {epId && <><div className="studio-episode-progress" role="progressbar" aria-label="已选定视频的镜头比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={episodeProgress}><span style={{ width: `${episodeProgress}%` }} /></div><small>{completedShots} / {shots.length} 个镜头已选定视频</small></>}
        <button type="button" onClick={() => navigate(`/studio/${encodeURIComponent(activeSlug)}`)}><Icon name="layers" size={13} />{epId ? "切换分集" : "选择分集"}<Icon name="chevRight" size={12} /></button>
      </div>}
      <div className="studio-nav-sections mk-scroll">
        {sections.slice(0, -1).map((section, index) => <div className="studio-nav-section" key={index}>
          {section.title && (section.titleTo ? <button type="button" className={`studio-nav-section-title${section.titleId === activeId ? " is-active" : ""}`} aria-current={section.titleId === activeId ? "page" : undefined} onClick={() => navigate(section.titleTo!)}><span>{section.title}</span><Icon name="chevRight" size={12} /><span className="studio-nav-section-hint">查看全部</span></button> : <div className="studio-nav-section-title">{section.title}</div>)}
          {section.items.map((item) => {
            const target = resolveNavTarget(item, activeSlug ?? null, epId);
            const active = item.id === activeId;
            return <button type="button" key={item.id} className={`studio-nav-item${active ? " is-active" : ""}${item.indented ? " is-indented" : ""}`} aria-current={active ? "page" : undefined} onClick={() => {
              if (!target) return;
              if (item.requiresSlug && !activeSlug) toast.info(`先选择一个系列，再进入${item.label}`);
              else if (item.requiresEp && !epId) toast.info("先选择一集，再开始合成");
              if (target !== location.pathname) navigate(target);
            }}><Icon name={item.icon} size={16} /><span>{item.label}</span></button>;
          })}
        </div>)}
      </div>
      <div className="studio-nav-utilities" aria-label="全局工具">
        {sections[sections.length - 1].items.map((item) => <button type="button" key={item.id} className={`studio-nav-item${item.id === activeId ? " is-active" : ""}`} aria-current={item.id === activeId ? "page" : undefined} onClick={() => { if (item.to) navigate(item.to); }}><Icon name={item.icon} size={16} /><span>{item.label}</span></button>)}
      </div>
      <div className="studio-nav-footer"><Icon name="monitor" size={14} /><span>本地创作 · 自由掌控</span></div>
    </nav>
  );
}
