import React from "react";
import { Button } from "../ui/button";

export interface DetailPanelProps {
  children: React.ReactNode;
  title?: string;
  onClose?: () => void;
  className?: string;
  width?: number;
  /** Render a sticky footer */
  footer?: React.ReactNode;
}

export function DetailPanel({
  children,
  title,
  onClose,
  className = "",
  width = 420,
  footer,
}: DetailPanelProps) {
  return (
    <div
      className={`flex flex-col border-l border-[var(--ink-100)] bg-[var(--surface-card)] ${className}`}
      style={{ width, flexShrink: 0 }}
    >
      {title && (
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--ink-100)]">
          <h3 className="text-[var(--fs-lg)] font-semibold text-[var(--ink-900)] m-0">{title}</h3>
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              iconLeft="close"
              onClick={onClose}
              title="关闭"
              aria-label={title ? `关闭${title}面板` : "关闭面板"}
            >
              关闭
            </Button>
          )}
        </div>
      )}
      <div className="flex-1 overflow-auto p-5 mk-scroll">{children}</div>
      {footer && (
        <div className="border-t border-[var(--ink-100)] px-5 py-3">{footer}</div>
      )}
    </div>
  );
}

export default DetailPanel;
