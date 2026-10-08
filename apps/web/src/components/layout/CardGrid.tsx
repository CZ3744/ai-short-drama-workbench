import React from "react";

export interface CardGridProps {
  children: React.ReactNode;
  columns?: 2 | 3 | 4 | 5;
  gap?: number;
  className?: string;
}

export function CardGrid({ children, columns = 4, gap = 14, className = "" }: CardGridProps) {
  const colClass =
    columns === 2 ? "grid-cols-2"
    : columns === 3 ? "grid-cols-3"
    : columns === 5 ? "grid-cols-5"
    : "grid-cols-4";

  return (
    <div
      className={`grid ${colClass} ${className}`}
      style={{ gap }}
    >
      {children}
    </div>
  );
}

export default CardGrid;
