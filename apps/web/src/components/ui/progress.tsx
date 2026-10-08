import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/* ---- 条形进度 ---- */
export interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value?: number;       // 0-100
  max?: number;
  variant?: "default" | "ok" | "warn" | "err" | "brand";
  size?: "sm" | "md";
  showLabel?: boolean;
}

export const Progress = forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, max = 100, variant = "default", size = "md", showLabel, ...props }, ref) => {
    const pct = Math.min(100, Math.max(0, (value / max) * 100));
    const colorMap = {
      default: "bg-[var(--brand-500)]",
      ok: "bg-[var(--ok)]",
      warn: "bg-[var(--warn)]",
      err: "bg-[var(--err)]",
      brand: "bg-[var(--brand-500)]",
    };
    return (
      <div ref={ref} className={cn("w-full", className)} {...props}>
        {showLabel && (
          <div className="flex justify-between mb-1 text-[var(--fs-xs)] text-[var(--ink-500)]">
            <span>{Math.round(pct)}%</span>
          </div>
        )}
        <div
          className={cn(
            "w-full overflow-hidden rounded-[var(--r-full)] bg-[var(--ink-100)]",
            size === "sm" ? "h-1.5" : "h-2.5"
          )}
        >
          <div
            className={cn("h-full rounded-[var(--r-full)] transition-all", colorMap[variant])}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }
);
Progress.displayName = "Progress";

/* ---- 圆形进度 ---- */
export interface CircularProgressProps extends HTMLAttributes<HTMLDivElement> {
  value?: number;
  size?: number;
  strokeWidth?: number;
  variant?: "default" | "ok" | "warn" | "err" | "brand";
}

export const CircularProgress = forwardRef<HTMLDivElement, CircularProgressProps>(
  ({ className, value = 0, size = 64, strokeWidth = 6, variant = "default", ...props }, ref) => {
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const pct = Math.min(100, Math.max(0, value));
    const offset = circumference - (pct / 100) * circumference;
    const colorMap = {
      default: "var(--brand-500)",
      ok: "var(--ok)",
      warn: "var(--warn)",
      err: "var(--err)",
      brand: "var(--brand-500)",
    };
    return (
      <div ref={ref} className={cn("relative inline-flex items-center justify-center", className)} {...props}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--ink-100)"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={colorMap[variant]}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="transition-all"
          />
        </svg>
        <span className="absolute text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">
          {Math.round(pct)}%
        </span>
      </div>
    );
  }
);
CircularProgress.displayName = "CircularProgress";
