// W10 (2026-05-26): 时间线视图 — 横向帧条, 每镜 100×56 缩略图 + 镜号.
// 点击进单镜. 适合给用户 "整集像剪辑软件" 的感觉 — 一眼扫过去看整集节奏.
import type { useNavigate } from "react-router-dom";
import { Icon } from "../../../components/shared/Icon";
import type { Shot } from "../../../hooks/useShots";
import { pickThumb } from "./ShotCard";

export interface ShotTimelineViewProps {
  shots: Shot[];
  slug: string;
  selectedEpId: string;
  aspectRatio?: string;
  navigate: ReturnType<typeof useNavigate>;
}

export function ShotTimelineView({
  shots,
  slug,
  selectedEpId,
  aspectRatio = "16/9",
  navigate,
}: ShotTimelineViewProps) {
  return (
    <div
      className="mk-scroll"
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 8,
        padding: "12px 4px",
        overflowX: "auto",
        overflowY: "hidden",
        borderRadius: 10,
        background: "var(--surface-card)",
        border: "1px solid var(--ink-100)",
      }}
    >
      {shots.map((shot, idx) => (
        <TimelineFrame
          key={shot.id}
          shot={shot}
          slug={slug}
          selectedEpId={selectedEpId}
          aspectRatio={aspectRatio}
          navigate={navigate}
          isLast={idx === shots.length - 1}
        />
      ))}
    </div>
  );
}

function TimelineFrame({
  shot,
  slug,
  selectedEpId,
  aspectRatio,
  navigate,
  isLast,
}: {
  shot: Shot;
  slug: string;
  selectedEpId: string;
  aspectRatio: string;
  navigate: ReturnType<typeof useNavigate>;
  isLast: boolean;
}) {
  const thumb = pickThumb(shot);
  const route = `/studio/${slug}/shot-stage/${selectedEpId}/${shot.id}`;
  const isVideoSelected = !!shot.picked_video_id;

  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 4, flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => navigate(route)}
        title={`第 ${shot.index} 镜 · ${shot.title || "未命名"}`}
        style={{
          width: 100,
          padding: 0,
          border: "1px solid var(--ink-150)",
          borderRadius: 8,
          background: "var(--surface-card)",
          cursor: "pointer",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          transition: "border-color 0.15s, box-shadow 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = "var(--brand-400)";
          (e.currentTarget as HTMLElement).style.boxShadow = "0 3px 10px rgba(217,119,87,0.18)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = "var(--ink-150)";
          (e.currentTarget as HTMLElement).style.boxShadow = "none";
        }}
      >
        {/* 缩略图 — 16:9 ~ 56px 高 (按 aspectRatio 派生) */}
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
              alt={`第 ${shot.index} 镜`}
              loading="lazy"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <Icon name="image" size={16} />
          )}
          {isVideoSelected && (
            <span
              style={{
                position: "absolute",
                top: 2,
                right: 2,
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: "var(--ok, #059669)",
                color: "#fff",
                display: "grid",
                placeItems: "center",
                fontSize: 8,
                fontWeight: 700,
                border: "1px solid #fff",
              }}
              title="已选定视频"
            >
              <Icon name="check" size={8} />
            </span>
          )}
        </div>
        {/* 底部 — 镜号 */}
        <div
          style={{
            padding: "4px 6px",
            fontSize: 10.5,
            fontWeight: 700,
            color: "var(--ink-700)",
            textAlign: "center",
            background: "var(--ink-25, rgba(0,0,0,0.015))",
            borderTop: "1px solid var(--ink-100)",
          }}
        >
          第 {shot.index} 镜
        </div>
      </button>
      {/* 镜与镜之间的小竖线 (像剪辑软件分隔条) */}
      {!isLast && (
        <div style={{ width: 1, background: "var(--ink-100)", flexShrink: 0 }} />
      )}
    </div>
  );
}
