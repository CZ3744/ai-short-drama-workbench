/**
 * series-detail/SeriesSidebar.tsx — 右侧速查 sidebar
 *
 * Wave P2 #15 抽出: SeriesDetail 主入口的右侧 column 部分集中到这里.
 * 包含: 角色速查 / 场景速查 / 全剧美学指南 / 系列信息卡 / 快捷导航
 *
 * 2026-05-28 AI 出图打磨: 加 "全剧美学指南 (Style Bible)" 编辑卡片.
 *   背后写入 series.visual_style_guide 字段, deriveSeriesContextForShot
 *   自动喂每镜 prompt — 解决用户原话"整部剧风格不统一"的痛点.
 *   竞品参照: Runway / Sora / Higgsfield 短剧工具的 "Style Bible"
 *   双层注入 (全剧美学 + 单镜 brief), 业内公认的跨分镜一致性最佳实践.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { SeriesRecord, EpisodeRecord } from "../../lib/api";
import { updateSeries } from "../../lib/seriesApi";
import { ROUTES } from "../../lib/routes";
import { SidebarSection, QuickNavButton } from "./parts";
import { Button } from "../../components/ui/button";
import { getEpisodeId } from "./utils";

export interface SeriesSidebarProps {
  slug: string;
  series: SeriesRecord;
  episodes: EpisodeRecord[];
  totalCostYuan: string;
  createdLabel: string;
}

export function SeriesSidebar({
  slug,
  series,
  episodes,
  totalCostYuan,
  createdLabel,
}: SeriesSidebarProps) {
  const navigate = useNavigate();
  return (
    <div
      className="overflow-auto mk-scroll"
      style={{
        borderLeft: "1px solid var(--ink-100)",
        background: "var(--surface-card)",
        padding: "14px 16px",
      }}
    >
      {/* 2026-05-25 — 角色/场景 count 接 series.character_ids/scene_ids 真数据.
          原 count=0 + "暂无角色数据" 硬编码, 跟 SeriesHeader StatBox 显的不一致.
          数量 > 0 时只显数字提示, 进 ElementListPage 看详情 (列表卡片那里更适合). */}
      <SidebarSection
        title="角色速查"
        count={series.character_ids?.length ?? 0}
        addLabel="管理角色"
        onAdd={() => navigate(ROUTES.characters(slug))}
      >
        <div
          className="py-2 text-[11px]"
          style={{ color: "var(--ink-400)" }}
        >
          {(series.character_ids?.length ?? 0) === 0
            ? "暂无角色, 先去管理页建一个"
            : `已有 ${series.character_ids?.length} 个角色, 点上方按钮查看详情`}
        </div>
      </SidebarSection>

      {/* Scenes quick-ref */}
      <SidebarSection
        title="场景"
        count={series.scene_ids?.length ?? 0}
        addLabel="管理场景"
        onAdd={() => navigate(ROUTES.scenes(slug))}
      >
        <div
          className="py-2 text-[11px]"
          style={{ color: "var(--ink-400)" }}
        >
          {(series.scene_ids?.length ?? 0) === 0
            ? "暂无场景, 先去管理页建一个"
            : `已有 ${series.scene_ids?.length} 个场景, 点上方按钮查看详情`}
        </div>
      </SidebarSection>

      {/* 2026-05-28 AI 出图打磨 — 全剧美学指南 (Style Bible) */}
      <VisualStyleGuideEditor slug={slug} series={series} />

      {/* Series info card */}
      <div style={{ marginBottom: 16 }}>
        <div className="mk-label" style={{ marginBottom: 8 }}>
          系列信息
        </div>
        <div className="mk-card" style={{ padding: "10px 12px" }}>
          <div
            className="flex items-center justify-between"
            style={{
              padding: "6px 0",
              borderBottom: "1px solid var(--ink-100)",
            }}
          >
            <span className="text-[11.5px]" style={{ color: "var(--ink-500)" }}>
              总花费
            </span>
            <span
              className="text-xs font-semibold"
              style={{ color: "var(--ink-900)", fontFeatureSettings: '"tnum"' }}
            >
              {totalCostYuan}
            </span>
          </div>
          <div
            className="flex items-center justify-between"
            style={{
              padding: "6px 0",
              borderBottom: "1px solid var(--ink-100)",
            }}
          >
            <span className="text-[11.5px]" style={{ color: "var(--ink-500)" }}>
              创建时间
            </span>
            <span
              className="text-xs font-semibold"
              style={{ color: "var(--ink-900)" }}
            >
              {createdLabel}
            </span>
          </div>
          <div
            className="flex items-center justify-between"
            style={{ padding: "6px 0" }}
          >
            <span className="text-[11.5px]" style={{ color: "var(--ink-500)" }}>
              集数
            </span>
            <span
              className="text-xs font-semibold"
              style={{ color: "var(--ink-900)", fontFeatureSettings: '"tnum"' }}
            >
              {series.episode_count}
            </span>
          </div>
        </div>
      </div>

      {/* Quick nav links */}
      <div style={{ marginBottom: 16 }}>
        <div className="mk-label" style={{ marginBottom: 8 }}>
          快捷导航
        </div>
        <div className="flex flex-col gap-1">
          <QuickNavButton
            icon="film"
            label="分镜板"
            onClick={() => {
              const ep = episodes[0];
              const episodeId = ep ? getEpisodeId(ep) : "";
              if (episodeId) navigate(ROUTES.storyboard(slug, episodeId));
            }}
          />
          <QuickNavButton
            icon="user"
            label="角色管理"
            onClick={() => navigate(ROUTES.characters(slug))}
          />
          <QuickNavButton
            icon="image"
            label="场景管理"
            onClick={() => navigate(ROUTES.scenes(slug))}
          />
          <QuickNavButton
            icon="sparkles"
            label="风格板"
            onClick={() => navigate(ROUTES.moodBoard(slug))}
          />
          <QuickNavButton
            icon="layers"
            label="资源库"
            onClick={() => navigate(ROUTES.seriesLibrary(slug))}
          />
        </div>
      </div>
    </div>
  );
}

// ─── 2026-05-28 AI 出图打磨 — 全剧美学指南编辑器 ─────────────────────────
//
// 用户原话 (推断自 USER_FEEDBACK + 跨分镜一致性铁律): "整部剧的风格就不怎么统一,
// 不同分镜独立生成". 业内 (Runway / Sora / Higgsfield) 短剧工具的成熟做法是
// "Style Bible" + per-shot brief 双层注入. 这里给用户一个自由文本编辑入口,
// 写完保存后 deriveSeriesContextForShot 自动喂每镜 prompt 的 series_visual_style 段.
//
// 示例填法: "整剧深蓝-橙色调, 冷光低饱和, 玻璃质感的窗户/桌面反射, 角色服装以
// 毛呢/羊毛针织为主, 背景多用城市夜景剪影, 避免高饱和粉/紫"
//
// 铁律 #1 用户控制权 — 用户主动填, 没填 fallback 到 defaults.visual_style preset
// 铁律 #4 就近决策 — 就在 series 总览页, 不藏深层设置
// 铁律 #5 真实保存 — 保存按 PATCH /api/v2/series/:slug 真持久化

interface VisualStyleGuideEditorProps {
  slug: string;
  series: SeriesRecord;
}

function VisualStyleGuideEditor({ slug, series }: VisualStyleGuideEditorProps) {
  const [value, setValue] = useState(series.visual_style_guide ?? "");
  const [saving, setSaving] = useState(false);
  const [savedValue, setSavedValue] = useState(series.visual_style_guide ?? "");

  // series 切换时重置 (sidebar 跨 series 复用)
  useEffect(() => {
    setValue(series.visual_style_guide ?? "");
    setSavedValue(series.visual_style_guide ?? "");
  }, [series.slug, series.visual_style_guide]);

  const dirty = value.trim() !== savedValue.trim();

  async function handleSave() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const trimmed = value.trim();
      await updateSeries(slug, { visual_style_guide: trimmed });
      setSavedValue(trimmed);
      toast.success(trimmed
        ? "全剧美学指南已保存, 后续生图自动锚定全剧风格"
        : "全剧美学指南已清空, 后续生图将走预设风格");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存失败";
      toast.error(`保存失败: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  const charCount = value.length;
  const overLimit = charCount > 600;

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="mk-label" style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>全剧美学指南</span>
        <span
          className="text-[10px]"
          style={{ color: overLimit ? "var(--err)" : "var(--ink-400)", fontFeatureSettings: '"tnum"' }}
          title="跨分镜风格一致性 — 业内 Style Bible 做法, 每镜出图自动锚定"
        >
          {charCount}/600
        </span>
      </div>
      <div className="mk-card" style={{ padding: 10 }}>
        <p
          className="text-[10.5px]"
          style={{ color: "var(--ink-400)", lineHeight: 1.5, marginBottom: 8 }}
        >
          填一段全剧的视觉锚点 (色调 / 光线 / 摄影 / 服装色板), 每镜生图都会自动参考. 比单镜 prompt 重复写"赛博朋克"靠谱.
        </p>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder='例: 整剧深蓝-橙色调, 冷光低饱和, 玻璃质感反射, 角色服装毛呢针织为主, 背景多用城市夜景剪影. 避免高饱和粉紫.'
          rows={5}
          className="mk-input"
          style={{
            width: "100%",
            fontSize: 11.5,
            lineHeight: 1.55,
            padding: "8px 10px",
            resize: "vertical",
            minHeight: 80,
            color: overLimit ? "var(--err)" : "var(--ink-900)",
            fontFamily: "inherit",
          }}
        />
        <div className="flex items-center justify-between" style={{ marginTop: 8, gap: 8 }}>
          <span className="text-[10px]" style={{ color: "var(--ink-400)" }}>
            {dirty ? "未保存改动" : (savedValue ? "已保存" : "未填 — 走预设风格")}
          </span>
          <Button
            variant={dirty ? "primary" : "secondary"}
            size="sm"
            disabled={!dirty || saving || overLimit}
            onClick={handleSave}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  );
}
