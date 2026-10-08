import type { CoverGenerationOptions } from "../../lib/seriesApi";
// 拆自 ShotboardPage.tsx — 剧集列表横向滚动 section + 单集卡片 (EpisodeStripCard) +
// 末尾"添加新集"虚线占位卡。同时导出 episodeStatusLabel/getEpisodeId/getEpisodeNumber
// 三个 helper 供主页面共享(避免重复定义)。
import { useRef, useState } from "react";
import type { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "../../components/shared/Icon";
import { CoverGenPopover } from "../../components/studio/CoverGenPopover";
import { ROUTES } from "../../lib/routes";
import type { EpisodeRecord } from "../../lib/api";

export function getEpisodeId(ep: EpisodeRecord): string {
  return ep.episode_id ?? ep.id ?? "";
}

export function getEpisodeNumber(ep: EpisodeRecord): number {
  return ep.episode_number ?? ep.index ?? 0;
}

/**
 * 2026-05-26 重写 — 用户反馈"待完善看不出来该完善哪里, 提示不明确".
 *
 * 智能识别 episode 当前在哪一步, 返回具体引导文案:
 *   - failed → 出错重试
 *   - generating → 生成中
 *   - 已完成 → 已完成
 *   - 有分镜 + 全选视频 → 可以合成
 *   - 有分镜 + 部分选了 → "X/Y 镜已选"
 *   - 有分镜 + 没选 → 待选视频
 *   - 有剧本没分镜 → 待拆分镜
 *   - 啥都没 → 待写剧本
 *
 * 兼容两种 caller signature: 老 caller 传 status string, 新 caller 传完整 ep 对象.
 */
export function episodeStatusLabel(
  epOrStatus?: EpisodeRecord | string,
): string {
  // 解析 status + 扩展字段
  const ep = typeof epOrStatus === "object" ? epOrStatus : null;
  const status = typeof epOrStatus === "string" ? epOrStatus : ep?.status;

  if (status === "failed") return "出错需重试";
  if (status === "generating") return "生成中";
  // P1-31 (2026-05-28 audit wave 4): 4 完成态拆开, 用户能看出下一步该做什么.
  // 老行为: approved/completed/exported/done 全显示"已完成" → 用户不知道是该去合成还是导出.
  if (status === "approved") return "待合成视频";
  if (status === "completed") return "待导出";
  if (status === "exported") return "已导出";
  if (status === "done") return "已完成";
  if (status === "assembled") return "可导出";

  // 智能 — 仅当传整个 ep 时
  if (ep) {
    const shotCount = ep.actual_shot_count ?? ep.target_shot_count ?? 0;
    const pickedCount = ep.picked_video_count ?? 0;
    const hasStoryboard = ["storyboarded", "picked", "ready"].includes(status ?? "")
      || !!ep.storyboard_path
      || (ep.actual_shot_count ?? 0) > 0;
    const hasScript = !!(ep.script_path || ep.script_md);

    if (hasStoryboard) {
      if (shotCount > 0 && pickedCount === shotCount) return "可以合成";
      if (pickedCount > 0) return `${pickedCount}/${shotCount} 镜已选`;
      return "待选视频";
    }
    if (hasScript) return "待拆分镜";
    return "待写剧本";
  }

  // 老 string-only fallback
  if (status === "storyboarded" || status === "picked" || status === "ready") return "已有分镜";
  if (status === "scripted" || status === "scripting") return "已有剧本";
  return "待完善";
}

/**
 * 2026-05-21 — 剧集列表里的单集卡片 (16:9 大缩略图 + 标题 + 简介).
 * 外层不能用 <button>(否则 Radix Popover trigger button 会嵌套 button, HTML 非法),
 * 改 div + role="button" + tabIndex 保持可访问性. 16:9 缩略图块接 cover_vault_id 真图,
 * 没生成时 fallback gradient + 中央 "生成封面" chip → 弹 CoverGenPopover (就近选 model + 风格).
 */
function EpisodeStripCard({
  ep,
  episodeId,
  number,
  active,
  slug,
  location,
  navigate,
  isGeneratingCover,
  onCoverGen,
  statusLabel,
}: {
  ep: EpisodeRecord;
  episodeId: string;
  number: number;
  active: boolean;
  slug: string;
  location: ReturnType<typeof useLocation>;
  navigate: ReturnType<typeof useNavigate>;
  isGeneratingCover: boolean;
  onCoverGen: (opts: CoverGenerationOptions) => void;
  statusLabel: string;
}) {
  const [coverPopoverOpen, setCoverPopoverOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const coverImageUrl = ep.cover_vault_id ? `/api/v2/vault/${ep.cover_vault_id}/raw` : null;
  const handleActivate = () => navigate(ROUTES.storyboard(slug, episodeId) + location.search);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); handleActivate(); } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        // W11 B6 (2026-05-27): 卡片从 180px 缩到 140px — 多集时水平滚动距离短一截.
        // 字号 / 缩略图比例同步缩, 整体视觉密度提升.
        width: 140,
        flex: "0 0 auto",
        textAlign: "left",
        scrollSnapAlign: "start",
        borderRadius: 9,
        border: active ? "1.5px solid var(--brand-400)" : "1px solid var(--ink-150)",
        background: active ? "var(--brand-50)" : "var(--surface-card)",
        padding: 9,
        cursor: "pointer",
        boxShadow: active
          ? "0 8px 20px rgba(160,86,55,0.12)"
          : hovered ? "0 6px 16px rgba(28,25,23,0.08)" : "0 1px 2px rgba(28,25,23,0.03)",
        transform: !active && hovered ? "translateY(-1px)" : "translateY(0)",
        transition: "box-shadow 0.15s, transform 0.15s, border-color 0.15s",
        outline: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 7 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-900)" }}>第 {number} 集</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--ink-500)" }}>{statusLabel}</span>
      </div>
      <div
        style={{
          aspectRatio: "16/9",
          borderRadius: 5,
          border: "1px solid var(--ink-100)",
          background: coverImageUrl ? "var(--ink-100)" : "linear-gradient(135deg, var(--ink-50), var(--ink-100))",
          display: "grid",
          placeItems: "center",
          color: "var(--ink-300)",
          marginBottom: 10,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {coverImageUrl ? (
          <img
            src={coverImageUrl}
            alt={`第 ${number} 集封面`}
            loading="lazy"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <Icon name="image" size={22} />
        )}
        <CoverGenPopover
          open={coverPopoverOpen}
          onOpenChange={setCoverPopoverOpen}
          busy={isGeneratingCover}
          onSubmit={(opts) => { setCoverPopoverOpen(false); onCoverGen(opts); }}
          title="生成集封面"
          subtitle="走 AI 图像模型, 1080×1920 竖屏"
          slug={slug}
          episodeId={episodeId}
          triggerEl={
            !coverImageUrl ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); }}
                onMouseDown={(e) => { e.stopPropagation(); }}
                disabled={isGeneratingCover}
                style={{
                  position: "absolute",
                  bottom: 6,
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 2,
                  padding: "3px 10px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.96)",
                  border: "1px solid rgba(255,255,255,0.7)",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
                  color: "var(--ink-800)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: isGeneratingCover ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  whiteSpace: "nowrap",
                }}
                title="为本集生成真封面图(走 AI image provider, 1080×1920 竖屏)"
              >
                <Icon name={isGeneratingCover ? "refresh" : "image"} size={11} />
                {isGeneratingCover ? "生成中…" : "生成封面"}
              </button>
            ) : (
              hovered ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); }}
                  onMouseDown={(e) => { e.stopPropagation(); }}
                  disabled={isGeneratingCover}
                  style={{
                    position: "absolute",
                    bottom: 4,
                    right: 4,
                    zIndex: 2,
                    padding: "3px 8px",
                    borderRadius: 999,
                    background: "rgba(0,0,0,0.6)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    backdropFilter: "blur(8px)",
                    color: "rgba(255,255,255,0.96)",
                    fontSize: 10.5,
                    fontWeight: 600,
                    cursor: isGeneratingCover ? "wait" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                  }}
                  title="重新生成集封面"
                >
                  <Icon name="refresh" size={10} />
                  {isGeneratingCover ? "生成中" : "重生封面"}
                </button>
              ) : <span style={{ display: "none" }} />
            )
          }
        />
      </div>
      <div style={{ fontSize: 11.5, fontWeight: 650, color: "var(--ink-900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ep.title || `第 ${number} 集`}</div>
      <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ep.synopsis || "一句话剧情待补充"}</div>
      {/* 2026-05-26 — 底部时长 / 分镜数智能化:
              优先用真实选定视频累加 (picked_video_total_duration_sec) → 显示"X 秒(已选 Y 镜)"
              其次用目标值 (target_duration_sec / target_shot_count) → 显示"目标 X 秒"
              都没有 → 显示该完善的下一步, 替代旧"时长待定" */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6, fontSize: 9.5, color: "var(--ink-400)" }}>
        {(() => {
          const realDur = ep.picked_video_total_duration_sec;
          const targetDur = ep.target_duration_sec;
          const realShots = ep.actual_shot_count ?? 0;
          const pickedVideo = ep.picked_video_count ?? 0;
          const targetShots = ep.target_shot_count ?? 0;

          // 优先级 1: 选过视频 → 显示真长 + 进度
          if (realDur && realDur > 0) {
            return (
              <>
                <span>{Math.round(realDur)} 秒</span>
                <span>·</span>
                <span>{pickedVideo}/{realShots} 镜已选视频</span>
              </>
            );
          }
          // 优先级 2: 有分镜但没选视频 → 显示分镜数 + 提示
          if (realShots > 0) {
            return (
              <>
                <span>{realShots} 镜</span>
                <span>·</span>
                <span>{targetDur ? `目标 ${targetDur} 秒, 待选视频` : "待选视频"}</span>
              </>
            );
          }
          // 优先级 3: LLM 拆过目标但还没真生成分镜 → 显示目标
          if (targetShots > 0) {
            return (
              <>
                <span>目标 {targetDur ?? "?"} 秒</span>
                <span>·</span>
                <span>{targetShots} 镜 (待生成)</span>
              </>
            );
          }
          // 优先级 4: 啥也没有 → 显示该往下走的提示 (替代旧"时长待定")
          return <span>{statusLabel}</span>;
        })()}
      </div>
    </div>
  );
}

/**
 * 剧集列表 — 横向滚动卡片 + 末尾"添加新集"虚线占位卡。
 * 内部用 useRef 拿到滚动容器(原 stripRef);loadingSeries 时渲染 4 个骨架。
 */
export function EpisodeStrip({
  episodes,
  loadingSeries,
  selectedEpId,
  slug,
  location,
  navigate,
  creatingEpisode,
  isCoverGenerating,
  onEpisodeCoverGen,
  onCreateEpisode,
}: {
  episodes: EpisodeRecord[];
  loadingSeries: boolean;
  selectedEpId: string;
  slug: string;
  location: ReturnType<typeof useLocation>;
  navigate: ReturnType<typeof useNavigate>;
  creatingEpisode: boolean;
  isCoverGenerating: (epId: string) => boolean;
  onEpisodeCoverGen: (epId: string, opts: CoverGenerationOptions) => void;
  onCreateEpisode: () => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div className="mk-label">剧集列表</div>
        <span style={{ flex: 1 }} />
        {/* W7-PM-cleanup (User #22.2): 删除左右滚动箭头 — 用鼠标滚轮/触控板横向滚动剧集列表 */}
      </div>

      <div ref={stripRef} className="mk-scroll" style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 12, scrollSnapType: "x mandatory" }}>
        {loadingSeries ? (
          Array.from({ length: 4 }).map((_, i) => (
            // W11 B6: 骨架同步缩 (140 × 152)
            <div key={i} className="mk-card" style={{ width: 140, height: 152, flex: "0 0 auto", background: "var(--ink-50)" }} />
          ))
        ) : episodes.length === 0 ? null : (
          episodes.map((ep) => {
            const id = getEpisodeId(ep);
            const active = id === selectedEpId;
            const number = getEpisodeNumber(ep) || episodes.indexOf(ep) + 1;
            return (
              <EpisodeStripCard
                key={id}
                ep={ep}
                episodeId={id}
                number={number}
                active={active}
                slug={slug}
                location={location}
                navigate={navigate}
                isGeneratingCover={isCoverGenerating(id)}
                onCoverGen={(opts) => onEpisodeCoverGen(id, opts)}
                statusLabel={episodeStatusLabel(ep)}
              />
            );
          })
        )}
        {/* T6: 添加新集 — 和已有集同尺寸外框，虚线边+透明背景. W11 B6: 同步缩到 140px. */}
        <button
          onClick={onCreateEpisode}
          disabled={creatingEpisode}
          style={{
            width: 140,
            flex: "0 0 auto",
            scrollSnapAlign: "start",
            borderRadius: 9,
            border: "1px dashed var(--ink-300)",
            background: "var(--ink-25, rgba(0,0,0,0.02))",
            color: "var(--ink-500)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            minHeight: 152,
            cursor: creatingEpisode ? "wait" : "pointer",
            transition: "border-color 0.15s, background 0.15s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--brand-400)"; (e.currentTarget as HTMLButtonElement).style.background = "var(--brand-25, rgba(217,119,87,0.04))"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--ink-300)"; (e.currentTarget as HTMLButtonElement).style.background = "var(--ink-25, rgba(0,0,0,0.02))"; }}
        >
          <Icon name="plus" size={16} />
          <span style={{ fontSize: 11.5, fontWeight: 650 }}>{creatingEpisode ? "添加中..." : "添加新集"}</span>
        </button>
      </div>
    </section>
  );
}
