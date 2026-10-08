import React from "react";

export interface ProgressPulseProps {
  /** 0-100 */
  progress: number;
  label?: string;
  sublabel?: string;
  color?: "brand" | "ok";
  className?: string;
  height?: number;
}

export function ProgressPulse({
  progress,
  label,
  sublabel,
  color = "brand",
  className = "",
  height = 4,
}: ProgressPulseProps) {
  const trackColor = color === "brand" ? "var(--brand-100)" : "var(--ok-bg)";
  const fillColor = color === "brand" ? "var(--brand-500)" : "var(--ok)";
  const glowColor = color === "brand" ? "rgba(217,119,87,0.5)" : "rgba(47,158,90,0.4)";

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {(label || sublabel) && (
        <div className="flex items-center justify-between">
          {label && <span className="text-[var(--fs-xs)] font-medium text-[var(--ink-700)]">{label}</span>}
          {sublabel && (
            <span className="text-[var(--fs-xs)] text-[var(--ink-400)]" style={{ fontFeatureSettings: '"tnum"' }}>
              {sublabel}
            </span>
          )}
        </div>
      )}
      <div
        className="rounded-full overflow-hidden"
        style={{ height, background: trackColor }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${Math.min(100, Math.max(0, progress))}%`,
            background: fillColor,
            boxShadow: progress > 0 ? `0 0 6px ${glowColor}` : undefined,
          }}
        />
      </div>
    </div>
  );
}

export default ProgressPulse;
