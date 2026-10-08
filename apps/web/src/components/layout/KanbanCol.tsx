import React from "react";

export interface KanbanColProps {
  title: string;
  count?: number;
  children: React.ReactNode;
  color?: "brand" | "ok" | "warn" | "err" | "info";
  className?: string;
}

export function KanbanCol({
  title,
  count,
  children,
  color = "brand",
  className = "",
}: KanbanColProps) {
  const colorMap = {
    brand: { dot: "var(--brand-500)", bg: "var(--brand-50)" },
    ok: { dot: "var(--ok)", bg: "var(--ok-bg)" },
    warn: { dot: "var(--warn)", bg: "var(--warn-bg)" },
    err: { dot: "var(--err)", bg: "var(--err-bg)" },
    info: { dot: "var(--info)", bg: "var(--info-bg)" },
  };
  const { dot, bg } = colorMap[color];

  return (
    <div
      className={`flex flex-col rounded-[var(--r-lg)] border border-[var(--ink-100)] overflow-hidden ${className}`}
      style={{ minWidth: 280 }}
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--ink-100)]" style={{ background: bg }}>
        <span className="mk-dot" style={{ background: dot }} />
        <span className="text-[var(--fs-sm)] font-semibold text-[var(--ink-800)]">{title}</span>
        {count != null && (
          <span className="ml-auto text-[var(--fs-xs)] text-[var(--ink-400)]" style={{ fontFeatureSettings: '"tnum"' }}>
            {count}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-3 flex flex-col gap-2 mk-scroll">
        {children}
      </div>
    </div>
  );
}

export default KanbanCol;
