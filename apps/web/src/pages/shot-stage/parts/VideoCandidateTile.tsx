/**
 * VideoCandidateTile — 视频候选卡 — 整张可点 = lightbox 播放.
 *   W8-BC: 加 isFocused(键盘 1-9 选中态)+ data-video-candidate-id(Space 抓 <video>).
 *
 * W11 A5 (2026-05-27) 按钮收菜单 — 视觉一致铁律 #8:
 *   常驻 2 主按钮: 「选定」(primary) + 「废弃」(ghost). 「再抽视频」收进 hover ⋯ 菜单.
 */
import { useState } from "react";  // hover state 仍保留 (播放图标 hover 隐藏)
import { Icon } from "../../../components/shared/Icon";
import { Button } from "../../../components/ui/button";
import { InlineLabel } from "../../../components/shot-stage/InlineLabel";
import { candidateRichLabel } from "../../../components/shared/CandidateLabel";
import { videoFirstFrameSrc } from "../../../lib/videoSrc";
import type { ShotCandidate } from "../../../lib/shotApi";
import { pickStarBadge } from "./styles";

export function VideoCandidateTile({
  candidate, isPicked, isFocused, onOpen, onSelect, onReject, onRename, onRegen,
  aspectRatio = "16/9",
  displayIndex, displayTotal,
}: {
  candidate: ShotCandidate; isPicked?: boolean;
  isFocused?: boolean;
  onOpen: () => void;
  onSelect: () => void; onReject: () => void;
  onRegen?: () => void;
  /** 2026-05-17: inline rename, 用户给候选起名 */
  onRename?: (label: string) => void;
  /** 2026-05-22: 缩略图比例 — 跟剧本身 aspect_ratio 一致, fallback 16/9 (横屏) */
  aspectRatio?: string;
  /** 2026-05-27 — 本镜内序号 (1-based, 按创建时间正序) + 总数, 用户没改名时 fallback 显示 */
  displayIndex?: number;
  displayTotal?: number;
}) {
  const [hover, setHover] = useState(false);
  const src = candidate.thumbnail || candidate.url || "";
  const failed = candidate.status === "failed";
  const running = candidate.status === "running" || candidate.status === "pending";
  // 2026-05-27 — display_name 用户没改时, fallback 走 candidateRichLabel:
  //   "智谱 CogVideoX · #2/3 · 14:47" 比裸 provider 名字一眼好认.
  const richFallback = candidateRichLabel(candidate, { index: displayIndex, total: displayTotal });

  // W8-BC: focused border > picked border (同 FirstFrameTile)
  const borderColor = isFocused
    ? "2px solid var(--brand-600)"
    : isPicked
      ? "1.5px solid var(--brand-500)"
      : "1px solid var(--ink-100)";

  return (
    <div
      data-video-candidate-id={candidate.id}
      style={{
        borderRadius: 7,
        border: borderColor,
        padding: 6, background: "var(--surface-card)",
        cursor: candidate.url ? "pointer" : "default",
        position: "relative",
        boxShadow: isFocused ? "0 0 0 3px rgba(217,119,87,0.18)" : undefined,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-tile-action]")) return;
        if (candidate.url) onOpen();
      }}
      title="点击放大播放视频 · 按 Space 在 picked 视频上播放/暂停"
    >
      {/* 2026-05-27 hotfix — 按钮展开到视频下方, 不再 ⋯ 菜单 (铁律 #3 信息直接可见) */}

      <div style={{
        position: "relative", aspectRatio, borderRadius: 5, overflow: "hidden",
        background: "var(--ink-50)", display: "grid", placeItems: "center",
      }}>
        {/* W7-stage-reorg: <video> 标签 — 浏览器原生右键可"另存为视频" / "复制视频地址" */}
        {candidate.url ? (
          <video
            src={videoFirstFrameSrc(candidate.url)}
            poster={candidate.thumbnail || undefined}
            preload="metadata"
            muted
            playsInline
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            title="点击放大播放 / 右键可另存"
          />
        ) : src ? (
          // 仅有 thumbnail 没有 url(罕见,运行中状态)→ 显示缩略图占位
          <img
            src={src}
            alt={candidate.display_name?.trim() || "视频候选"}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            title="点击放大查看 / 右键可复制"
          />
        ) : (
          <Icon name="video" size={20} style={{ color: "var(--ink-300)" }} />
        )}
        {running && <span className="mk-pill mk-pill--generating" style={{ position: "absolute", top: 6, left: 6, height: 18, fontSize: 9.5 }}>生成中</span>}
        {failed && <span className="mk-pill mk-pill--failed" style={{ position: "absolute", top: 6, left: 6, height: 18, fontSize: 9.5 }}>失败</span>}
        {isPicked && (
          <span style={pickStarBadge} title="已选定为最终视频">
            <Icon name="bookmark" size={10} style={{ color: "#fff" }} />
            <span style={{ fontSize: 9.5, fontWeight: 700, color: "#fff" }}>已选定</span>
          </span>
        )}
        {/* W7: 播放图标提示 + hover 浮出操作 */}
        {candidate.url && !hover && !running && !failed && (
          <span style={{
            position: "absolute", inset: 0, display: "grid", placeItems: "center",
            color: "rgba(255,255,255,0.85)", pointerEvents: "none",
          }}>
            <span style={{
              width: 40, height: 40, borderRadius: 999, background: "rgba(0,0,0,0.55)",
              display: "grid", placeItems: "center",
            }}>
              <Icon name="play" size={18} />
            </span>
          </span>
        )}
      </div>
      {/* 2026-05-27 — 按钮全部展开到视频下方, 不藏二级菜单 (铁律 #3 信息直接可见).
          常用: 选定 / 废弃; 调一调: 基于此视频再抽 (有 onRegen 时显示) */}
      {!running && !failed && (
        <div
          style={{ marginTop: 6, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}
          data-tile-action
        >
          {/* 2026-05-27 — 已选定时按钮变态: ghost + "已选定" 文字, 跟首帧卡同款 */}
          <Button
            variant={isPicked ? "ghost" : "primary"}
            size="xs"
            iconLeft="check"
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
            title={isPicked ? "已选为本镜最终视频 — 再点取消" : "选定此视频作为最终视频"}
            style={isPicked ? { color: "var(--brand-700)", borderColor: "var(--brand-300)" } : undefined}
          >
            {isPicked ? "已选定" : "选定"}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            iconLeft="archive"
            onClick={(e) => { e.stopPropagation(); onReject(); }}
            title="废弃此视频到废案库"
          >
            废弃
          </Button>
          {onRegen && (
            <Button
              variant="ghost"
              size="xs"
              iconLeft="refresh"
              onClick={(e) => { e.stopPropagation(); onRegen(); }}
              title="基于这条视频加修改意见, 再抽一条新的"
              style={{ gridColumn: "1 / -1" }}
            >
              再抽视频(参考此视频)
            </Button>
          )}
        </div>
      )}
      {/* 2026-05-17: inline rename + 成本 */}
      {/* 2026-05-20: display_name 体系统一 — 优先读 display_name, 老数据 fallback user_label */}
      <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginTop: 5, display: "flex", gap: 6, alignItems: "center" }} data-tile-action>
        <div style={{ flex: 1, minWidth: 0 }}>
          <InlineLabel
            value={candidate.display_name}
            fallback={richFallback}
            onSave={async (newLabel) => { await onRename?.(newLabel); }}
          />
        </div>
        {typeof candidate.cost_cny === "number" && <span>¥{candidate.cost_cny.toFixed(2)}</span>}
      </div>
    </div>
  );
}
