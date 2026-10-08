import React, { useState, useEffect, useCallback } from "react";

export interface TOCItem {
  id: string;
  label: string;
  indent?: number;
}

export interface StickyTOCProps {
  items: TOCItem[];
  className?: string;
  title?: string;
}

export function StickyTOC({ items, className = "", title = "页面导航" }: StickyTOCProps) {
  const [activeId, setActiveId] = useState<string>(items[0]?.id ?? "");

  const handleScroll = useCallback(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const el = document.getElementById(items[i].id);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= 120) {
          setActiveId(items[i].id);
          return;
        }
      }
    }
    if (items.length > 0) setActiveId(items[0].id);
  }, [items]);

  useEffect(() => {
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  return (
    <nav className={`sticky flex flex-col gap-1 ${className}`} style={{ top: 88 }}>
      {title && (
        <div className="mk-label mb-2">{title}</div>
      )}
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          onClick={(e) => {
            e.preventDefault();
            const el = document.getElementById(item.id);
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "start" });
              setActiveId(item.id);
            }
          }}
          className="block text-[var(--fs-sm)] py-1.5 px-2 rounded-[var(--r-sm)] transition-colors no-underline"
          style={{
            paddingLeft: item.indent ? `${8 + item.indent * 12}px` : "8px",
            color: item.id === activeId ? "var(--brand-700)" : "var(--ink-500)",
            fontWeight: item.id === activeId ? 600 : 400,
            background: item.id === activeId ? "var(--brand-50)" : "transparent",
          }}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

export default StickyTOC;
