/**
 * FirstFrameTile — 首帧候选卡 — 整张可点 = lightbox, 操作按钮 hover 浮出底部.
 *   W8-BC: 加 isFocused (键盘 1-9 选中态) + isCompareSelected (对比复选) + onInpaint (局部重抽).
 *
 * W11 A5 (2026-05-27) 按钮收菜单 + 画笔显式入口 — 用户原话:
 *   - "对已有图片进行提示词反馈重抽的功能哪儿去了? 之前有文字+画笔写修改意见的, 恢复一下"
 * 老布局: 6 个按钮 5 种自定义彩色 (再抽这张 / 设首帧 / 设尾帧 / 关键帧 / 废弃) — 违反铁律 #8 视觉一致.
 *   画笔功能藏在 RegenModal 二级 tab, 用户找不到.
 * 新布局:
 *   - 缩略图下方常驻 **2 个主按钮**: 「设首帧」(主操作 primary) + 「废弃」(灰 ghost)
 *   - hover 显示右上角 ⋯ 按钮, 点开 dropdown 菜单, 含:
 *     · 整图重抽 (i2i tab)
 *     · 画笔局部修改 ⭐ 恢复显式入口 (直接进 inpaint tab)
 *     · 设尾帧
 *     · 关键帧
 *   - 5 种彩色背景全删, 统一用 Button 组件 — 视觉一致铁律 #8
 */
import { useState } from "react";
import { Icon } from "../../../components/shared/Icon";
import { Button } from "../../../components/ui/button";
import { InlineLabel } from "../../../components/shot-stage/InlineLabel";
import { candidateRichLabel } from "../../../components/shared/CandidateLabel";
import type { ShotCandidate } from "../../../lib/shotApi";
import { pickStarBadge } from "./styles";

export function FirstFrameTile({
  candidate, isFirst, isEnd, isFocused, isCompareSelected, isRecommended, onToggleCompare,
  onOpen, onSetFirst, onSetEnd, onSetKey, onReject, onRegen, onInpaint, onRename,
  aspectRatio = "1/1",
  displayIndex, displayTotal,
}: {
  candidate: ShotCandidate; isFirst?: boolean; isEnd?: boolean;
  isFocused?: boolean;
  isCompareSelected?: boolean;
  /** B-8: 是否为自动推荐(评分最高)候选 */
  isRecommended?: boolean;
  onToggleCompare?: () => void;
  onOpen: () => void;
  onSetFirst: () => void; onSetEnd: () => void; onSetKey: () => void; onReject: () => void;
  /** W7-cand-ux: 候选卡 hover 出"用此图微调重抽" — 弹 RegenModal (整图微调 tab) */
  onRegen?: () => void;
  /** W11 A5: 候选卡 ⋯ 菜单"画笔局部修改" — 弹 RegenModal (inpaint tab) */
  onInpaint?: () => void;
  /** 2026-05-17: inline rename, 用户给候选起名 */
  onRename?: (label: string) => void;
  /** 2026-05-22: 缩略图比例 — 跟剧本身 aspect_ratio 一致, fallback 1/1 (向后兼容) */
  aspectRatio?: string;
  /** 2026-05-27 — 本镜内序号 (1-based, 按创建时间正序) + 总数, 用户没改名时 fallback 显示 */
  displayIndex?: number;
  displayTotal?: number;
}) {
  const [hover, setHover] = useState(false);
  void hover; // 保留 hover state 给后续若需要的视觉反馈 (当前未用)
  const src = candidate.thumbnail || candidate.url || "";
  const failed = candidate.status === "failed";
  const running = candidate.status === "running" || candidate.status === "pending";
  const picked = isFirst || isEnd;
  // 2026-05-27 — display_name 用户没改时, fallback "ChatGPT 图像 · #2/4 · 14:47"
  const richFallback = candidateRichLabel(candidate, { index: displayIndex, total: displayTotal });

  // W8-BC: focused border > picked border (键盘 1-9 临时高亮 — 信息量比已批准更高优先)
  const borderColor = isFocused
    ? "2px solid var(--brand-600)"
    : picked
      ? "1.5px solid var(--brand-500)"
      : "1px solid var(--ink-100)";
  return (
    <div
      data-candidate-id={candidate.id}
      style={{
        borderRadius: 7,
        border: borderColor,
        padding: 6, background: "var(--surface-card)",
        cursor: src ? "pointer" : "default",
        position: "relative",
        boxShadow: isFocused ? "0 0 0 3px rgba(217,119,87,0.18)" : undefined,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        // 操作按钮不触发 lightbox
        if ((e.target as HTMLElement).closest("[data-tile-action]")) return;
        if (src) onOpen();
      }}
      title="点击放大查看原图"
    >
      {/* W8-BC: 对比复选 — 左上角 */}
      {onToggleCompare && (
        <button
          type="button"
          data-tile-action
          onClick={(e) => { e.stopPropagation(); onToggleCompare(); }}
          style={{
            position: "absolute",
            top: 4, left: 4,
            zIndex: 2,
            height: 22, padding: "0 7px",
            borderRadius: 6,
            border: isCompareSelected ? "1px solid var(--brand-600)" : "1px solid var(--ink-200)",
            background: isCompareSelected ? "var(--brand-600)" : "rgba(255,255,255,0.92)",
            color: isCompareSelected ? "#fff" : "var(--ink-700)",
            fontSize: 10.5, fontWeight: 700,
            cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 4,
          }}
          title={isCompareSelected ? "从对比中移除" : "勾选加入对比(2-4 张并排看大图)"}
        >
          <Icon name={isCompareSelected ? "check" : "plus"} size={9} />
          对比
        </button>
      )}

      {/* 2026-05-27 hotfix — 用户反馈: "这些按钮做到图片下方, 不要二级菜单".
          删 hover ⋯ 菜单, 6 个按钮全部展开到缩略图下方 3×2 grid (铁律 #3 信息直接可见).
          原 onRegen / onInpaint 入口仍走 props (用 Button 而非自定义按钮, 视觉一致铁律 #8). */}

      <div style={{
        position: "relative", aspectRatio, borderRadius: 5, overflow: "hidden",
        background: "var(--ink-50)", display: "grid", placeItems: "center",
      }}>
        {src ? (
          <img
            src={src}
            alt={candidate.display_name?.trim() || "候选首帧"}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            title="点击放大 / 右键可复制 / 右键另存为"
          />
        ) : (
          <Icon name="image" size={20} style={{ color: "var(--ink-300)" }} />
        )}
        {running && <span className="mk-pill mk-pill--generating" style={{ position: "absolute", top: 6, left: 6, height: 18, fontSize: 9.5 }}>生成中</span>}
        {failed && <span className="mk-pill mk-pill--failed" style={{ position: "absolute", top: 6, left: 6, height: 18, fontSize: 9.5 }}>失败</span>}
        {/* W7: 主图徽章 — 左上角 ⭐ */}
        {isFirst && (
          <span style={pickStarBadge} title="已设为首帧">
            <Icon name="bookmark" size={10} style={{ color: "#fff" }} />
            <span style={{ fontSize: 9.5, fontWeight: 700, color: "#fff" }}>首帧</span>
          </span>
        )}
        {isEnd && !isFirst && (
          <span style={pickStarBadge} title="已设为尾帧">
            <Icon name="bookmark" size={10} style={{ color: "#fff" }} />
            <span style={{ fontSize: 9.5, fontWeight: 700, color: "#fff" }}>尾帧</span>
          </span>
        )}
        {/* B-8: 自动推荐角标 — 右下角(不遮住主体) */}
        {isRecommended && !isFirst && (
          <span
            style={{
              position: "absolute", bottom: 4, right: 4,
              background: "var(--brand-600, #d97757)", color: "#fff",
              borderRadius: 5, padding: "1px 6px",
              fontSize: 9.5, fontWeight: 700,
              display: "inline-flex", alignItems: "center", gap: 3,
              boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
            }}
            title="综合评分最高，系统推荐"
          >
            <Icon name="star" size={9} style={{ color: "#fff" }} /> 推荐
          </span>
        )}

      </div>
      {/* 2026-05-27 — 6 个按钮全部展开 (3 行 2 列), 不藏二级菜单 (铁律 #3 信息直接可见).
          行 1: 设首帧 (主) / 废弃 — 最常用
          行 2: 整图重抽 / 画笔局部修改 — 调一调入口
          行 3: 设尾帧 / 关键帧 — 视频锚点 (running/failed 状态隐藏整组) */}
      {!running && !failed && (
        <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }} data-tile-action>
          {/* 2026-05-27 — 已设首帧时按钮变态: ghost + check 图标 + "已是首帧" 文字.
              用户原话: "已设为首帧之后按钮应该状态改变". */}
          <Button
            variant={isFirst ? "ghost" : "primary"}
            size="xs"
            iconLeft={isFirst ? "check" : "pin"}
            onClick={(e) => { e.stopPropagation(); onSetFirst(); }}
            title={isFirst ? "已是本镜首帧 — 再点取消首帧设定" : "设为首帧锚点(图生视频起始帧)"}
            style={isFirst ? { color: "var(--brand-700)", borderColor: "var(--brand-300)" } : undefined}
          >
            {isFirst ? "已是首帧" : "设首帧"}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            iconLeft="archive"
            onClick={(e) => { e.stopPropagation(); onReject(); }}
            title="废弃此候选到废案库"
          >
            废弃
          </Button>
          {onRegen && (
            <Button
              variant="ghost"
              size="xs"
              iconLeft="sparkles"
              onClick={(e) => { e.stopPropagation(); onRegen(); }}
              title="基于这张图加修改意见, 重抽一张新图 (整图微调)"
            >
              整图重抽
            </Button>
          )}
          {onInpaint && (
            <Button
              variant="ghost"
              size="xs"
              iconLeft="edit"
              onClick={(e) => { e.stopPropagation(); onInpaint(); }}
              title="在图上画笔涂抹要改的区域 + 写修改意见 (局部重抽)"
            >
              画笔修改
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            iconLeft={isEnd ? "check" : "arrowRight"}
            onClick={(e) => { e.stopPropagation(); onSetEnd(); }}
            title={isEnd ? "已是本镜尾帧 — 再点取消尾帧设定" : "设为尾帧锚点(图生视频结束帧)"}
            style={isEnd ? { color: "var(--brand-700)", borderColor: "var(--brand-300)" } : undefined}
          >
            {isEnd ? "已是尾帧" : "设尾帧"}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            iconLeft="pin"
            onClick={(e) => { e.stopPropagation(); onSetKey(); }}
            title="添加为关键帧锚点"
          >
            关键帧
          </Button>
        </div>
      )}
      {/* 2026-05-17: inline rename - 用户可起自定义名 (e.g. "粗剪 v1"), 默认 provider 名 */}
      {/* 2026-05-20: display_name 体系统一 — 优先读 display_name, 老数据 fallback user_label */}
      <div style={{ fontSize: 10.5, marginTop: 5 }} data-tile-action>
        {/* 2026-05-18 (铁律 #5): onSave 必须 await onRename → 上层 renameCandidate throw 才能传回 InlineLabel.
            历史: { onRename?.(newLabel); } 没 await/return — 失败时 InlineLabel try-catch 拿不到 error → 不回退 draft. */}
        <InlineLabel
          value={candidate.display_name}
          fallback={richFallback}
          onSave={async (newLabel) => { await onRename?.(newLabel); }}
        />
      </div>
    </div>
  );
}
