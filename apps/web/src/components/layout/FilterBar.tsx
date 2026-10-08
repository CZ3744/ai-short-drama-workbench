import React from "react";

export interface FilterChip {
  key: string;
  label: string;
  active?: boolean;
  count?: number;
  color?: "brand" | "ok" | "warn" | "err" | "info" | "ghost" | "outline";
}

export interface FilterBarProps {
  chips: FilterChip[];
  onToggle: (key: string) => void;
  className?: string;
  /** Optional search input */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  actions?: React.ReactNode;
}

export function FilterBar({
  chips,
  onToggle,
  className = "",
  searchValue,
  onSearchChange,
  searchPlaceholder = "搜索…",
  actions,
}: FilterBarProps) {
  return (
    <div className={`flex items-center gap-3 flex-wrap ${className}`}>
      {chips.map((chip) => (
        // 保留原因: mk-chip 已建立的非-mk-btn 语义 class (规则 1) — chip 形态独立于普通按钮,7 种 color 主题切换 active/outline 双态
        <button
          key={chip.key}
          onClick={() => onToggle(chip.key)}
          className={`mk-chip ${chip.active ? `mk-chip--${chip.color || "brand"}` : "mk-chip--outline"}`}
        >
          {chip.label}
          {chip.count != null && (
            <span style={{ fontFeatureSettings: '"tnum"', opacity: 0.7 }}>
              {chip.count}
            </span>
          )}
        </button>
      ))}
      {onSearchChange && (
        <div className="relative ml-auto">
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-400)]"
          >
            <circle cx={11} cy={11} r={7} />
            <line x1={21} y1={21} x2={16.65} y2={16.65} />
          </svg>
          <input
            type="text"
            value={searchValue ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="mk-input pl-9 w-48 text-[var(--fs-xs)]"
          />
        </div>
      )}
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export default FilterBar;
