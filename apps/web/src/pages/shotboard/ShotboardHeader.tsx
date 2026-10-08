// 拆自 ShotboardPage.tsx — 顶部 header(返回 + 大标题三件套 + VersionSwitcher + 工具栏 + 副信息卡).
//
// 设计:外部传入 series/episodes/counts/selectedEpisode/sbVersionSummaries + 4 个动作回调,
// 内部纯渲染、不持有状态。导航(navigate)从 props 透传,避免组件内绑死路由。
import type { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/shared/Icon";
import { VersionSwitcher, type VersionSummary } from "../../components/shared/VersionSwitcher";
import { ROUTES } from "../../lib/routes";
import type { EpisodeRecord, SeriesRecord } from "../../lib/api";

export function ShotboardHeader({
  slug,
  series,
  episodes,
  counts,
  selectedEpisode,
  sbVersionSummaries,
  sbVersionsLoading,
  navigate,
  onActivateSbVersion,
  onDeleteSbVersion,
  onCreateSbVersion,
  onShowPasteDialog,
}: {
  slug: string;
  series: SeriesRecord | null;
  episodes: EpisodeRecord[];
  counts: { total: number; picked: number; ready: number };
  selectedEpisode: EpisodeRecord | null;
  sbVersionSummaries: VersionSummary[];
  sbVersionsLoading: boolean;
  navigate: ReturnType<typeof useNavigate>;
  onActivateSbVersion: (id: string) => void;
  onDeleteSbVersion: (id: string) => void;
  onCreateSbVersion: () => void;
  onShowPasteDialog: () => void;
}) {
  return (
    <div className="shotboard-header" style={{ padding: "18px 24px 12px", background: "var(--surface-card)", borderBottom: "1px solid var(--ink-100)" }}>
      <div className="shotboard-header-toolbar" style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Button
          variant="ghost"
          size="sm"
          iconLeft="back"
          onClick={() => navigate(ROUTES.seriesDetail(slug))}
          title="回到系列总览"
        >
          返回
        </Button>
        <div className="shotboard-header-title" style={{ flex: 1, minWidth: 0 }}>
          {/* 2026-05-20 Wave T S23 — App Store 风格三件套:eyebrow + 大标题(24px)+ 浅灰副标题 */}
          {/* Wave T hotfix — h1 加 overflow ellipsis,防长 series.title 撑高 header */}
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--brand-700)", textTransform: "uppercase" }}>分集与分镜</div>
          <h1
            title={series?.title || slug}
            style={{
              margin: "3px 0 0",
              fontSize: 24,
              fontWeight: 700,
              color: "var(--ink-900)",
              fontFamily: "'Noto Serif SC', serif",
              lineHeight: 1.2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {series?.title || slug}
          </h1>
          <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--ink-500)" }}>
            共 {episodes.length} 集 · 当前 {counts.total} 镜 · 已挑 {counts.picked} · 待挑 {counts.ready}
          </div>
        </div>
        {/* T3: 分镜版本切换器（W6-H 接通） */}
        <VersionSwitcher
          versions={sbVersionSummaries}
          disabled={sbVersionsLoading}
          onActivate={onActivateSbVersion}
          onDelete={onDeleteSbVersion}
          onCreate={onCreateSbVersion}
          label="分镜版本"
        />
        {/* 2026-05-18 EVE-4: 粘贴 AI 分镜入口 — 用户原话"跳过灵感生成剧本直接粘贴分镜" */}
        <Button
          variant="secondary"
          size="sm"
          iconLeft="upload"
          onClick={onShowPasteDialog}
          title="把外部 AI(ChatGPT/Claude/Gemini)生成的分镜 JSON 粘贴导入,跳过灵感+剧本流程"
        >
          粘贴 AI 分镜
        </Button>
        {/* T5: 回收站入口 (2026-05-26 Codex P2-8 术语统一) */}
        <Button
          variant="ghost"
          size="sm"
          iconLeft="trash"
          onClick={() => navigate(`/studio/${slug}/trash`)}
          title="查看回收站"
        >
          回收站
        </Button>
      </div>

      <div style={{ marginTop: 16, padding: "14px 16px", borderRadius: 12, border: "1px solid var(--ink-100)", background: "linear-gradient(96deg, #fff 0%, #fff 58%, #fff7f2 100%)" }}>
        <div className="shotboard-header-context" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: "var(--brand-50)", display: "grid", placeItems: "center", color: "var(--brand-700)" }}>
            <Icon name="shot" size={18} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, color: "var(--ink-500)", marginBottom: 3 }}>从系列剧本拆出的分集会按顺序出现在这里。点击上方集卡切换，下方只显示当前集的分镜。</div>
            <div style={{ fontSize: 13, color: "var(--ink-800)", fontWeight: 600 }}>{selectedEpisode?.title ?? "尚未选择分集"}</div>
          </div>
          {/* W11 B6 (2026-05-27): 上一集 / 下一集快捷按钮 — 跟缩短的集 strip 配合, 不用滚动也能切. */}
          {selectedEpisode && episodes.length > 1 && (() => {
            const currentIdx = episodes.findIndex((e) => (e.episode_id ?? e.id) === (selectedEpisode.episode_id ?? selectedEpisode.id));
            const prev = currentIdx > 0 ? episodes[currentIdx - 1] : null;
            const next = currentIdx >= 0 && currentIdx < episodes.length - 1 ? episodes[currentIdx + 1] : null;
            const gotoEp = (e: EpisodeRecord) => navigate(ROUTES.storyboard(slug, e.episode_id ?? e.id ?? ""));
            return (
              <div style={{ display: "inline-flex", gap: 4 }}>
                {/* 2026-05-26 Codex P2-10: 加可见文字标签 (铁律 #11 禁止 icon-only) */}
                <Button
                  variant="ghost"
                  size="sm"
                  iconLeft="chevLeft"
                  onClick={() => prev && gotoEp(prev)}
                  disabled={!prev}
                  title={prev ? `上一集: ${prev.title ?? `第 ${(prev.episode_number ?? prev.index ?? 0)} 集`}` : "已是第一集"}
                  aria-label="上一集"
                >
                  上一集
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconLeft="chevRight"
                  onClick={() => next && gotoEp(next)}
                  disabled={!next}
                  title={next ? `下一集: ${next.title ?? `第 ${(next.episode_number ?? next.index ?? 0)} 集`}` : "已是最后一集"}
                  aria-label="下一集"
                >
                  下一集
                </Button>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
