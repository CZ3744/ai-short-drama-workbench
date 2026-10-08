// W10 (2026-05-26): 九宫格视图 — 3 列大图卡片, 每格显示一镜 picked first frame.
// 整张卡片可点击进单镜. 缩略图右下角显示"第 N 镜 · title".
// 没 picked 时显示占位 (gradient + Icon).
//
// 不持有业务 state — 跟 ShotCard 一样, 拖拽/勾选/删除回调通过 props 透传.
// 这里只渲染大图 + 标题 + 状态 chip + 选择框 (悬停时出现).
import type { useNavigate } from "react-router-dom";
import { Icon } from "../../../components/shared/Icon";
import { labelOfStatus } from "../../../lib/sourceLabels";
import type { Shot } from "../../../hooks/useShots";
import { pickThumb } from "./ShotCard";

export interface ShotBoardViewProps {
  shots: Shot[];
  slug: string;
  selectedEpId: string;
  aspectRatio?: string;
  hasShotSelected: (id: string) => boolean;
  toggleShotId: (id: string) => void;
  navigate: ReturnType<typeof useNavigate>;
}

export function ShotBoardView({
  shots,
  slug,
  selectedEpId,
  aspectRatio = "16/9",
  hasShotSelected,
  toggleShotId,
  navigate,
}: ShotBoardViewProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        gap: 14,
      }}
    >
      {shots.map((shot) => (
        <BoardCard
          key={shot.id}
          shot={shot}
          slug={slug}
          selectedEpId={selectedEpId}
          aspectRatio={aspectRatio}
          selected={hasShotSelected(shot.id)}
          onToggleSelect={toggleShotId}
          navigate={navigate}
        />
      ))}
    </div>
  );
}

function BoardCard({
  shot,
  slug,
  selectedEpId,
  aspectRatio,
  selected,
  onToggleSelect,
  navigate,
}: {
  shot: Shot;
  slug: string;
  selectedEpId: string;
  aspectRatio: string;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const thumb = pickThumb(shot);
  const route = `/studio/${slug}/shot-stage/${selectedEpId}/${shot.id}`;
  const titleText = shot.title || `分镜 ${shot.index}`;

  return (
    <article
      onClick={() => navigate(route)}
      className="mk-card"
      style={{
        padding: 0,
        borderRadius: 12,
        overflow: "hidden",
        cursor: "pointer",
        transition: "box-shadow 0.15s, transform 0.15s",
        position: "relative",
        background: selected ? "var(--brand-25, rgba(217,119,87,0.04))" : "var(--surface-card)",
        borderColor: selected ? "var(--brand-300)" : undefined,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = "0 8px 22px rgba(0,0,0,0.10)";
        (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)";
        (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio,
          background: thumb ? "var(--ink-900)" : "linear-gradient(135deg, var(--ink-50), var(--ink-100))",
          display: "grid",
          placeItems: "center",
          color: "var(--ink-300)",
        }}
      >
        {thumb ? (
          <img
            src={thumb}
            alt={`${titleText} 首帧`}
            loading="lazy"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <Icon name="image" size={28} />
            <span style={{ fontSize: 11, color: "var(--ink-400)" }}>还没生成首帧</span>
          </div>
        )}

        {/* 左上 — 勾选框 (悬停才出现, 不阻挡看图) */}
        <label
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            width: 22,
            height: 22,
            display: "grid",
            placeItems: "center",
            borderRadius: 6,
            background: "rgba(255,255,255,0.92)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.20)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => {
              e.stopPropagation();
              onToggleSelect(shot.id);
            }}
            aria-label={`选择分镜 ${shot.index}`}
            style={{ width: 14, height: 14, accentColor: "var(--brand-500)", cursor: "pointer" }}
          />
        </label>

        {/* 右上 — 状态 chip */}
        <span
          className={`mk-pill mk-pill--${shot.status}`}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            height: 20,
            fontSize: 10.5,
            paddingLeft: 7,
            paddingRight: 7,
          }}
        >
          {labelOfStatus(shot.status)}
        </span>

        {/* 底部 — 镜号 + 标题 (黑色渐变蒙层) */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: "16px 10px 8px",
            background: thumb
              ? "linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.40) 60%, transparent 100%)"
              : undefined,
            color: thumb ? "#fff" : "var(--ink-700)",
            fontSize: 12,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            gap: 6,
            textShadow: thumb ? "0 1px 2px rgba(0,0,0,0.4)" : undefined,
          }}
        >
          <span style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "2px 7px",
            borderRadius: 4,
            background: "rgba(217,119,87,0.92)",
            color: "#fff",
            fontSize: 10.5,
            fontWeight: 700,
            flexShrink: 0,
          }}>
            第 {shot.index} 镜
          </span>
          <span style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12.5,
          }}>
            {titleText}
          </span>
        </div>
      </div>
    </article>
  );
}
