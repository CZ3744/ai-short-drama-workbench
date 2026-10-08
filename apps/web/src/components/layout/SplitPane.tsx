import React, { useCallback, useRef, useState, useEffect } from "react";

export interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  leftWidth?: number;
  minLeft?: number;
  maxLeft?: number;
  className?: string;
  resizable?: boolean;
}

export function SplitPane({
  left,
  right,
  leftWidth = 420,
  minLeft = 300,
  maxLeft = 600,
  className = "",
  resizable = true,
}: SplitPaneProps) {
  const [width, setWidth] = useState(leftWidth);
  const dragging = useRef(false);
  const paneRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !paneRef.current) return;
      const rect = paneRef.current.getBoundingClientRect();
      const newWidth = Math.max(minLeft, Math.min(maxLeft, e.clientX - rect.left));
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [minLeft, maxLeft]);

  return (
    <div ref={paneRef} className={`flex h-full ${className}`}>
      <div style={{ width, flexShrink: 0, overflow: "auto" }} className="border-r border-[var(--ink-100)]">
        {left}
      </div>
      {resizable && (
        <div
          className="w-1 cursor-col-resize hover:bg-[var(--brand-200)] transition-colors shrink-0 bg-transparent"
          onMouseDown={onMouseDown}
        />
      )}
      <div className="flex-1 overflow-auto">{right}</div>
    </div>
  );
}

export default SplitPane;
