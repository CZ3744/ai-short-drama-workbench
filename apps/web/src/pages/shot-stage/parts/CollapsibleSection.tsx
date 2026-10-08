/**
 * CollapsibleSection — 左栏 section 折叠头 (画面描述 / 素材连接 / 关键参数 等).
 * 视觉零变更. 从 ShotStagePage 拆出 (P2 #16).
 */
import type React from "react";
import { Icon } from "../../../components/shared/Icon";

export function CollapsibleSection({
  title, icon, defaultOpen = true, borderColor, children, headerExtra,
}: {
  title: string; icon: any; defaultOpen?: boolean; borderColor?: string;
  children: React.ReactNode; headerExtra?: React.ReactNode;
}) {
  return (
    <details open={defaultOpen}>
      <summary
        style={{
          listStyle: "none", display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
          padding: "9px 12px", borderRadius: 10, background: "var(--surface-card)",
          border: `1px solid ${borderColor ?? "var(--ink-100)"}`,
          fontWeight: 700, fontSize: 12.5, color: "var(--ink-900)",
          userSelect: "none",
        }}
      >
        <Icon name={icon} size={13} style={{ color: borderColor ?? "var(--brand-600)" }} />
        {title}
        {headerExtra && <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 400 }}>{headerExtra}</span>}
        <span style={{ marginLeft: headerExtra ? 4 : "auto", fontSize: 10, color: "var(--ink-400)", fontWeight: 400 }}>▾</span>
      </summary>
      <div style={{
        border: `1px solid ${borderColor ?? "var(--ink-100)"}`, borderTop: "none",
        borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
        padding: "12px 12px 14px", background: "var(--surface-card)",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {children}
      </div>
    </details>
  );
}
