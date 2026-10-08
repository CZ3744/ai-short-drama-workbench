/**
 * Field — 表单字段标签 + 子内容包装 (左栏 / 关键参数区).
 * 视觉零变更. 从 ShotStagePage 拆出 (P2 #16).
 */
import type React from "react";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-500)", letterSpacing: "0.04em" }}>{label}</span>
      {children}
    </label>
  );
}
