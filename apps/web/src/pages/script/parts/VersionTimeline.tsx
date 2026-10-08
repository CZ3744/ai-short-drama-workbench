import { useState } from "react";
import { cn } from "../../../lib/cn";
import { Button } from "../../../components/ui/button";
import { Clock, GitCompare, RotateCcw, X } from "../../../components/shared/LucideIcon";
import type { VersionEntry } from "../../../hooks/useVersions";
import { SOURCE_LABEL } from "../../../lib/sourceLabels";
import { formatBeijingTime } from "../../../lib/format";

function formatTime(iso: string): string {
  return formatBeijingTime(iso, { mode: "short" });
}

// ====================================================================
// VersionTimeline
// ====================================================================

export interface VersionTimelineProps {
  versions: VersionEntry[];
  currentVersion: number;
  /** 点击某个版本 chip */
  onVersionClick: (version: number) => void;
  /** 点击比较按钮 */
  onCompare: () => void;
  /** 当前正在预览的版本(只读模式) */
  previewVersion?: number | null;
  /** 关闭预览 */
  onClosePreview?: () => void;
  /** 恢复到预览版本 */
  onRevert?: (version: number) => void;
  className?: string;
}

export function VersionTimeline({
  versions,
  currentVersion,
  onVersionClick,
  onCompare,
  previewVersion,
  onClosePreview,
  onRevert,
  className,
}: VersionTimelineProps) {
  const [hoveredVersion, setHoveredVersion] = useState<number | null>(null);

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 py-2 bg-[var(--surface-card)] border-b border-[var(--ink-100)] overflow-x-auto",
        className
      )}
    >
      <Clock className="h-4 w-4 text-[var(--ink-400)] shrink-0" />

      {/* 版本 chips */}
      <div className="flex items-center gap-1 flex-1 overflow-x-auto">
        {versions.map((v, i) => {
          const isCurrent = v.version === currentVersion;
          const isPreview = v.version === previewVersion;
          const isHovered = v.version === hoveredVersion;

          return (
            <div key={v.version} className="relative shrink-0">
              <button
                onClick={() => onVersionClick(v.version)}
                onMouseEnter={() => setHoveredVersion(v.version)}
                onMouseLeave={() => setHoveredVersion(null)}
                className={cn(
                  "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[var(--fs-xs)] font-medium transition-all",
                  isCurrent &&
                    "bg-[var(--brand-100)] text-[var(--brand-700)] ring-1 ring-[var(--brand-300)]",
                  isPreview &&
                    "bg-[var(--ok-light)] text-[var(--ok)] ring-1 ring-[var(--ok)]",
                  !isCurrent &&
                    !isPreview &&
                    "bg-[var(--ink-50)] text-[var(--ink-500)] hover:bg-[var(--ink-100)]"
                )}
              >
                v{v.version}
                {isCurrent && <span className="text-[var(--brand-500)]">当前</span>}
              </button>

              {/* Hover tooltip */}
              {isHovered && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-[var(--ink-900)] text-white text-[var(--fs-xs)] rounded-[var(--r-md)] p-2 shadow-lg z-50 pointer-events-none">
                  <div className="font-medium">
                    v{v.version} · {SOURCE_LABEL[v.source] || "其他"}
                  </div>
                  <div className="text-[var(--ink-300)] mt-0.5">
                    {formatTime(v.created_at)}
                  </div>
                  {v.summary && (
                    <div className="text-[var(--ink-300)] mt-0.5 truncate">
                      {v.summary}
                    </div>
                  )}
                  {/* 箭头 */}
                  <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-[var(--ink-900)]" />
                </div>
              )}

              {/* 连接线 */}
              {i < versions.length - 1 && (
                <div className="absolute top-1/2 right-0 w-2 h-px bg-[var(--ink-200)] translate-x-full" />
              )}
            </div>
          );
        })}
      </div>

      {/* 比较按钮 */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onCompare}
        className="shrink-0 gap-1"
      >
        <GitCompare className="h-3.5 w-3.5" />
        比较
      </Button>

      {/* 预览模式工具栏 */}
      {previewVersion != null && (
        <div className="flex items-center gap-2 ml-2 pl-2 border-l border-[var(--ink-200)] shrink-0">
          <span className="text-[var(--fs-xs)] text-[var(--ink-500)]">
            预览 v{previewVersion}
          </span>
          {onRevert && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => onRevert(previewVersion)}
              className="gap-1"
            >
              <RotateCcw className="h-3 w-3" />
              恢复此版本
            </Button>
          )}
          {onClosePreview && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClosePreview}
              className="gap-1"
            >
              <X className="h-3 w-3" />
              关闭
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
