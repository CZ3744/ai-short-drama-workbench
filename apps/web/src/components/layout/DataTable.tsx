import React from "react";

export interface DataColumn<T> {
  key: string;
  header: string;
  width?: number;
  align?: "left" | "center" | "right";
  render: (row: T, index: number) => React.ReactNode;
}

export interface DataTableProps<T> {
  columns: DataColumn<T>[];
  data: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T, index: number) => void;
  className?: string;
  emptyMessage?: string;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  className = "",
  emptyMessage = "暂无数据",
}: DataTableProps<T>) {
  return (
    <div className={`overflow-auto mk-scroll ${className}`}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[var(--ink-100)]">
            {columns.map((col) => (
              <th
                key={col.key}
                className="px-4 py-3 text-left text-[var(--fs-xs)] font-semibold text-[var(--ink-400)] uppercase tracking-wider"
                style={{ width: col.width, textAlign: col.align || "left" }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12 text-center text-[var(--fs-sm)] text-[var(--ink-400)]">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                onClick={() => onRowClick?.(row, i)}
                className="border-b border-[var(--ink-100)] hover:bg-[var(--ink-50)] transition-colors"
                style={{ cursor: onRowClick ? "pointer" : undefined }}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className="px-4 py-2.5 text-[var(--fs-sm)] text-[var(--ink-700)]"
                    style={{ textAlign: col.align || "left", fontFeatureSettings: col.align === "right" ? '"tnum"' : undefined }}
                  >
                    {col.render(row, i)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default DataTable;
