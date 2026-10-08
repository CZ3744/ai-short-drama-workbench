/**
 * RejectPoolStrip — 三级废案库横向滚动条 (§11)
 *
 * 展示当前层级(本素材/本项目/公共)的废案缩略图列表.
 * 每张废案带操作按钮: 导入回素材 / 升级到项目库 / 升级到公共库 / 彻底清理(危险红描边).
 * "浏览废案"按钮打开完整 RejectPoolBrowserModal.
 *
 * 2026-05-16 五件 UX 修复:
 *   - 按钮全部 icon + 文字 (铁律 #11), 文字明确"导入回素材 / 升级到项目库 / 升级到公共库"
 *   - 新增 "彻底清理" 红描边按钮 — 二次 confirm, 真调 POST /vault/:id/trash 把源文件移入回收站
 *   - 配色分级: 导入回素材 → 品牌色描边; 升级 → 信息蓝描边; 彻底清理 → 危险红描边
 *
 * W8-sweep (2026-05-16):
 *  - element_kind 后端字段翻译成中文(铁律 #9 toC 兜底)
 *  - 按钮加图标(铁律 #11)
 *  - img 加 onClick + onOpenImage 回调供放大查看
 */

import type React from "react";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { ELEMENT_KIND_LABEL, type RejectItem } from "../../lib/elementApi";
import { videoFirstFrameSrc } from "../../lib/videoSrc";

// 2026-05-17 P1.1: 兼容 ShotStage 本镜废案库 — 加 "shot" tier 给分镜内"本镜废案"用
export type RejectTier = "element" | "project" | "public" | "shot";

// 2026-05-17: 媒体类型过滤 — 用户反馈"废案库要图像/视频双类型, 不要混"
export type RejectMediaType = "all" | "image" | "video";

const TIER_LABEL: Record<RejectTier, string> = {
  shot: "本镜",
  element: "本素材",
  project: "本项目",
  public: "公共",
};

export interface RejectPoolStripProps {
  tier: RejectTier;
  rejects: RejectItem[];
  onTierChange: (tier: RejectTier) => void;
  onImport: (vaultId: string) => void;
  onPromote: (vaultId: string, to: "project" | "public") => void;
  /** 2026-05-16: 彻底清理一张废案 — 父组件应做 confirm + 调 trashRejectVaultEntry 后刷新列表 */
  onPurge?: (item: RejectItem) => void;
  onOpenBrowser?: () => void;
  /** W8-sweep (2026-05-16): 点击废案缩略 → 父组件 MediaLightbox 放大查看. 不传则不可点. */
  onOpenImage?: (item: RejectItem) => void;
  /**
   * 2026-05-17 P1.1: 自定义每张废案的操作按钮组. 传入则替换默认 import/promote/purge 按钮组.
   * 用于 ShotStage 本镜废案:恢复 / 升级到项目 / 升级到公共 / 用微调重抽.
   */
  itemActions?: (item: RejectItem, tier: RejectTier) => React.ReactNode;
  /**
   * 2026-05-17 P1.1: tier 选项配置(可自定义只展示哪些 tier + 自定义计数).
   * 不传则默认展示 element / project / public(向后兼容).
   */
  tierOptions?: Array<{ key: RejectTier; label: string; count?: number }>;
  /**
   * 2026-05-17 P1.1: 自定义每张废案的展示文字(默认是 kindLabel · element_name).
   * 用于 ShotStage 本镜废案要显示 provider 来源.
   */
  getLabel?: (item: RejectItem) => string;
  /**
   * 2026-05-17 P1.1: tier 切换条之后、"浏览废案"按钮之前的额外工具栏 slot.
   */
  extraToolbar?: React.ReactNode;
  /**
   * 2026-05-17 P1.1: 自定义"空状态"提示文字(替代默认 "本素材暂无废案").
   */
  emptyText?: string;
  /**
   * 2026-05-17 精修: 自定义 tile 宽度(默认 148px). 本镜废案 itemActions 按钮多, 传 180+ 更舒服.
   * tile 高度按 4:3 比例自适应.
   */
  tileWidth?: number;
  /**
   * 2026-05-17: 媒体类型过滤 (图像 / 视频 / 全部). 默认 "all". 父组件控状态.
   * 用户原话:"所有废案库要改成图像视频双类型, 不要混在一起".
   */
  mediaType?: RejectMediaType;
  onMediaTypeChange?: (mt: RejectMediaType) => void;
}

// 2026-05-16 五件 UX: 按钮统一样式 (铁律 #8 视觉一致性 + #11 按钮有名字)
// 2026-05-17 P1.1: 导出供 ShotStage 等 caller 复用 itemActions 时使用同样视觉
export const stripBtnBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  height: 24,
  padding: "0 7px",
  borderRadius: 4,
  fontSize: 10.5,
  fontWeight: 600,
  cursor: "pointer",
  background: "var(--surface-card)",
  whiteSpace: "nowrap",
  transition: "background-color 120ms, border-color 120ms",
};

// 主操作: 导入回素材 — 品牌色描边
export const stripBtnImport: React.CSSProperties = {
  ...stripBtnBase,
  color: "var(--brand-700, #c2410c)",
  border: "1px solid var(--brand-600, #d97757)",
};

// 升级: 项目/公共 — 信息蓝描边
export const stripBtnPromote: React.CSSProperties = {
  ...stripBtnBase,
  color: "var(--info-700, #1d4ed8)",
  border: "1px solid var(--info, #3b82f6)",
};

// 危险: 彻底清理 — 红描边 (二次确认走 onPurge 回调)
export const stripBtnPurge: React.CSSProperties = {
  ...stripBtnBase,
  color: "var(--err, #dc2626)",
  border: "1px solid var(--err, #dc2626)",
};

// 中性: 恢复/拉回(非主操作) — 灰描边
export const stripBtnNeutral: React.CSSProperties = {
  ...stripBtnBase,
  color: "var(--ink-700)",
  border: "1px solid var(--ink-200)",
};

// 保留内部引用名以保持本文件内部代码不动
const btnImport = stripBtnImport;
const btnPromote = stripBtnPromote;
const btnPurge = stripBtnPurge;

export function RejectPoolStrip(props: RejectPoolStripProps) {
  const {
    tier, rejects, onTierChange, onImport, onPromote, onPurge, onOpenBrowser, onOpenImage,
    itemActions, tierOptions, getLabel, extraToolbar, emptyText, tileWidth = 148,
    mediaType = "all", onMediaTypeChange,
  } = props;
  const tileImgHeight = Math.round(tileWidth * 0.75);

  // 2026-05-17: 按媒体类型过滤 (图像 / 视频 / 全部)
  // 视频废案 vault.kind === "video", 其他视为 image
  const isVideoItem = (r: RejectItem) => r.kind === "video";
  const filteredRejects = mediaType === "all"
    ? rejects
    : mediaType === "video"
      ? rejects.filter(isVideoItem)
      : rejects.filter((r) => !isVideoItem(r));
  const counts = {
    all: rejects.length,
    image: rejects.filter((r) => !isVideoItem(r)).length,
    video: rejects.filter(isVideoItem).length,
  };

  const tierList: Array<{ key: RejectTier; label: string; count?: number }> =
    tierOptions ?? [
      { key: "element", label: TIER_LABEL.element },
      { key: "project", label: TIER_LABEL.project },
      { key: "public", label: TIER_LABEL.public },
    ];

  const fallbackEmpty = tier === "element"
    ? "本素材暂无废案。抽卡时不满意的图点「入废案」会进这里。"
    : tier === "shot"
      ? "本镜暂无废案。抽卡时不满意的图点「入废案」会进这里。"
      : "暂无废案。";

  return (
    <div className="mk-card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div className="mk-label">废案库</div>
        {/* 2026-05-20 Wave T S23 — tier / mediaType 两组真 tab,迁到 App Store 风格 mk-tab-group */}
        <div className="mk-tab-group">
          {tierList.map((opt) => (
            <button
              key={opt.key}
              className={`mk-tab ${tier === opt.key ? "mk-tab--active" : ""}`}
              onClick={() => onTierChange(opt.key)}
            >
              {opt.label}
              {typeof opt.count === "number" ? ` ${opt.count}` : null}
            </button>
          ))}
        </div>
        {/* 2026-05-17: 媒体类型分 tab — 用户原话"图像/视频双类型, 不要混" */}
        {/* 2026-05-20 Wave T hotfix — 两组 tab-group 间插竖向分隔线 + 大间距 */}
        {onMediaTypeChange ? (
          <>
            <span style={{ width: 1, height: 18, background: "var(--ink-200)", margin: "0 8px", display: "inline-block" }} aria-hidden="true" />
            <div className="mk-tab-group">
            {([
              { key: "all" as const, label: "全部", count: counts.all },
              { key: "image" as const, label: "图像", count: counts.image },
              { key: "video" as const, label: "视频", count: counts.video },
            ]).map((opt) => (
              <button
                key={opt.key}
                className={`mk-tab ${mediaType === opt.key ? "mk-tab--active" : ""}`}
                onClick={() => onMediaTypeChange(opt.key)}
                title={`仅看 ${opt.label} 废案`}
              >
                {opt.label} {opt.count > 0 ? opt.count : ""}
              </button>
            ))}
            </div>
          </>
        ) : null}
        {extraToolbar}
        <span style={{ flex: 1 }} />
        {onOpenBrowser ? (
          <Button variant="secondary" size="sm" iconLeft="layers" onClick={onOpenBrowser}>
            浏览废案
          </Button>
        ) : null}
      </div>

      {filteredRejects.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-400)" }}>
          {rejects.length > 0 && mediaType !== "all"
            ? `当前过滤"${mediaType === "video" ? "视频" : "图像"}"无废案,切换到"全部"看其他类型。`
            : (emptyText ?? fallbackEmpty)}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
          {filteredRejects.map((r) => {
            // W8-sweep (2026-05-16): element_kind 是后端 ID, 翻成中文 (toC 兜底)
            const kindLabel = r.element_kind
              ? ((ELEMENT_KIND_LABEL as Record<string, string>)[r.element_kind] ?? r.element_kind)
              : "";
            // 2026-05-21 — 铁律 #2 display_name 跨页面统一: 图本身的 display_name 优先,
            // 没设过才 fallback 到 "${kindLabel} · ${element_name}" 元数据展示.
            // (vault entry 现已透传 display_name 字段, 见 rejectPoolController.ts:127)
            const imageDisplayName = (r.display_name ?? r.user_note ?? "").trim();
            const labelText = getLabel
              ? getLabel(r)
              : imageDisplayName
                ? imageDisplayName
                : r.element_name
                  ? `${kindLabel}${kindLabel ? " · " : ""}${r.element_name}`
                  : "未命名废案";
            const isVideo = isVideoItem(r);
            const tileMediaStyle: React.CSSProperties = {
              width: tileWidth,
              height: tileImgHeight,
              objectFit: "cover",
              borderRadius: 5,
              border: "1px solid var(--ink-200)",
              cursor: onOpenImage ? "zoom-in" : "default",
              background: "var(--ink-50)",
              display: "block",
            };
            return (
              <div key={r.vault_id} style={{ width: tileWidth, flexShrink: 0, position: "relative" }}>
                {/* 2026-05-17 修封面丢失: video kind 用 <video> + 首帧 fragment; image 用 <img> */}
                {isVideo ? (
                  <div style={{ position: "relative" }}>
                    <video
                      src={videoFirstFrameSrc(r.url)}
                      preload="metadata"
                      muted
                      playsInline
                      onClick={onOpenImage ? () => onOpenImage(r) : undefined}
                      title={onOpenImage ? "点击放大播放视频 / 悬停预览" : undefined}
                      onMouseEnter={(e) => { try { (e.currentTarget as HTMLVideoElement).play(); } catch {} }}
                      onMouseLeave={(e) => { try { (e.currentTarget as HTMLVideoElement).pause(); (e.currentTarget as HTMLVideoElement).currentTime = 0; } catch {} }}
                      style={tileMediaStyle}
                    />
                    <span style={{
                      position: "absolute", bottom: 4, left: 4,
                      background: "rgba(0,0,0,0.65)", color: "white",
                      fontSize: 9, fontWeight: 600,
                      padding: "1px 5px", borderRadius: 3,
                      pointerEvents: "none",
                    }}>
                      <Icon name="video" size={8} /> 视频
                    </span>
                  </div>
                ) : (
                  <img
                    src={r.url}
                    alt={imageDisplayName || labelText}
                    onClick={onOpenImage ? () => onOpenImage(r) : undefined}
                    title={onOpenImage ? "点击放大查看 / 右键可复制图片" : undefined}
                    style={tileMediaStyle}
                  />
                )}
                <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginTop: 3, lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {labelText}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
                  {itemActions ? (
                    itemActions(r, tier)
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        size="xs"
                        iconLeft="download"
                        onClick={() => onImport(r.vault_id)}
                        title="把这张废案复制回当前素材的图库 (作为候选)"
                      >
                        导入回素材
                      </Button>
                      {tier !== "project" ? (
                        <Button
                          variant="secondary"
                          size="xs"
                          iconLeft="arrowRight"
                          onClick={() => onPromote(r.vault_id, "project")}
                          title="升级到本项目共享废案库 (项目内跨素材共享)"
                        >
                          升级到项目库
                        </Button>
                      ) : null}
                      {tier !== "public" ? (
                        <Button
                          variant="secondary"
                          size="xs"
                          iconLeft="arrowRight"
                          onClick={() => onPromote(r.vault_id, "public")}
                          title="升级到全局公共废案库 (跨项目共享)"
                        >
                          升级到公共库
                        </Button>
                      ) : null}
                      {onPurge ? (
                        <Button
                          variant="danger"
                          size="xs"
                          iconLeft="trash"
                          onClick={() => onPurge(r)}
                          title="彻底清理这张废案 — 真把源文件移入归档回收站 (90 天后系统自动删)"
                        >
                          彻底清理
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default RejectPoolStrip;
