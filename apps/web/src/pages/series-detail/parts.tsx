/**
 * series-detail/parts.tsx — SeriesDetail 页用 UI 小组件
 *
 * Wave P2 #15 抽出: 把 MetaBadge / StatBox / FilterTab / SidebarSection /
 * StageChip / QuickNavButton 这些纯展示小组件集中, 让主入口聚焦于布局.
 */

import type { ReactNode } from "react";
import { Icon, type IconName } from "../../components/shared/Icon";
import { Button } from "../../components/ui/button";

export function MetaBadge({ icon, label }: { icon: IconName; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-white/85"
      style={{ fontSize: 12 }}
    >
      <Icon name={icon} size={12} style={{ opacity: 0.7 }} />
      {label}
    </span>
  );
}

export function StatBox({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 min-w-[44px]">
      <span
        className="text-[22px] font-bold text-white"
        style={{ fontFeatureSettings: '"tnum"' }}
      >
        {value}
      </span>
      <span className="text-[11px] text-white/90 whitespace-nowrap">{label}</span>
    </div>
  );
}

export function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

interface SidebarSectionProps {
  title: string;
  count: number;
  addLabel: string;
  onAdd?: () => void;
  children: ReactNode;
}

export function SidebarSection({ title, count, addLabel, onAdd, children }: SidebarSectionProps) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="mk-label" style={{ marginBottom: 8 }}>
        {title} · {count}
      </div>
      {children}
      {/* 特殊"添加"占位风格: dashed 虚线边 + 透明背景, Button 不支持 dashed-border, 保留裸 button */}
      <button
        onClick={onAdd}
        className="flex items-center justify-center gap-1.5 w-full mt-1"
        style={{
          height: 32,
          background: "transparent",
          border: "1.5px dashed var(--ink-200)",
          borderRadius: 8,
          color: "var(--ink-500)",
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        <Icon name="plus" size={12} />
        {addLabel}
      </button>
    </div>
  );
}

export function StageChip({
  done,
  icon,
  label,
  value,
}: {
  done: boolean;
  icon: IconName;
  label: string;
  value: string;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-[var(--r-sm)]"
      style={{
        minHeight: 44,
        padding: "8px 10px",
        background: done ? "var(--ok-bg)" : "var(--ink-50)",
        color: done ? "var(--ok)" : "var(--ink-600)",
      }}
    >
      <Icon name={done ? "checkCircle" : icon} size={15} />
      <div className="min-w-0">
        <div style={{ fontSize: 11, fontWeight: 800, lineHeight: 1.1 }}>{label}</div>
        <div className="truncate" style={{ fontSize: 10.5, opacity: 0.78, marginTop: 3 }}>
          {value}
        </div>
      </div>
    </div>
  );
}

export function QuickNavButton({
  icon,
  label,
  onClick,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconLeft={icon}
      onClick={onClick}
      block
      style={{ justifyContent: "flex-start" }}
    >
      {label}
    </Button>
  );
}
