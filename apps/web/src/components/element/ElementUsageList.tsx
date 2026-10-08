/**
 * ElementUsageList — 展示此素材出现在哪些分镜，点击跳转 (§11)
 */

import { Icon } from "../shared/Icon";
import type { ElementUsage } from "../../lib/elementApi";

export interface ElementUsageListProps {
  usage: ElementUsage[];
  onNavigate: (episodeId: string, shotId: string) => void;
}

export function ElementUsageList(props: ElementUsageListProps) {
  const { usage, onNavigate } = props;

  if (usage.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--ink-400)" }}>
        暂未被任何分镜引用。在分镜创作页选用此素材后会在这里显示。
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {usage.map((u) => (
        <div
          key={u.shot_id}
          onClick={() => onNavigate(u.episode_id, u.shot_id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            borderRadius: 8,
            cursor: "pointer",
            background: "var(--surface-canvas)",
          }}
        >
          {u.first_frame_url ? (
            <img
              src={u.first_frame_url}
              alt={`第 ${u.shot_index} 镜首帧`}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
            />
          ) : (
            /* 2026-05-19 #11: 没首帧时的设计感兜底 — 渐变镜头方块 + 镜号水印.
               用户原话"没有也要有具有设计感的空应对, 不是错误". */
            <div
              style={{
                width: 36, height: 36, borderRadius: 4,
                background: "linear-gradient(135deg, var(--brand-50) 0%, var(--ink-100) 100%)",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
                color: "var(--brand-700)",
                fontSize: 10, fontWeight: 700,
              }}
              title="该分镜还没生成首帧"
            >
              <Icon name="film" size={12} style={{ opacity: 0.5 }} />
            </div>
          )}
          <div style={{ flex: 1, fontSize: 12.5 }}>
            {/* P0-2 (2026-05-29): 铁律 #9 toC 兜底 — 用 episode_index 渲染"第 N 集"
                而非 episode_id (ULID). 后端 usage 路由已多回 episode_index. */}
            <div style={{ fontWeight: 600, color: "var(--ink-800)" }}>
              第 {u.episode_index} 集 · 第 {u.shot_index} 镜
            </div>
          </div>
          <Icon name="chevRight" size={13} style={{ color: "var(--ink-400)" }} />
        </div>
      ))}
    </div>
  );
}

export default ElementUsageList;
