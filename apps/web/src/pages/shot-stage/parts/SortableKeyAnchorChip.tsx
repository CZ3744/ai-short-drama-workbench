/**
 * SortableKeyAnchorChip — 关键帧 chip (可拖拽) — 用 useSortable 包一层.
 *
 * 视觉零变更. 从 ShotStagePage 拆出 (P2 #16).
 */
import type React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "../../../components/shared/Icon";
import type { ShotCandidate, FrameAnchor } from "../../../lib/shotApi";

export function SortableKeyAnchorChip({
  anchor, index, candidate, onOpen, onRemove,
}: {
  anchor: FrameAnchor;
  index: number;
  candidate?: ShotCandidate;
  onOpen?: (c: ShotCandidate) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: anchor.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
    display: "inline-flex", alignItems: "center", gap: 5,
    padding: "3px 5px 3px 3px", borderRadius: 6,
    background: "var(--surface-card)",
    border: "1px solid var(--ink-150)",
    boxShadow: isDragging ? "0 6px 18px rgba(0,0,0,0.18)" : undefined,
  };
  const src = candidate?.thumbnail || candidate?.url || "";
  return (
    <span ref={setNodeRef} style={style}>
      {/* 拖拽 grip handle */}
      <span
        {...listeners}
        {...attributes}
        title="拖动调整顺序"
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 18, height: 36, cursor: "grab",
          color: "var(--ink-400)",
          touchAction: "none",
        }}
      >
        <Icon name="grip" size={12} />
      </span>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ink-700)" }}>
        关键{index + 1}
      </span>
      {src ? (
        <img
          src={src}
          alt={candidate?.display_name?.trim() || `关键帧 ${index + 1}`}
          onClick={() => { if (candidate && onOpen) onOpen(candidate); }}
          style={{
            width: 36, height: 36, borderRadius: 4, objectFit: "cover",
            border: "1px solid var(--ink-150)",
            cursor: candidate && onOpen ? "pointer" : "default",
          }}
          title="点击放大 / 右键可复制"
        />
      ) : (
        <span style={{
          width: 36, height: 36, borderRadius: 4,
          display: "grid", placeItems: "center",
          background: "var(--ink-50)", color: "var(--ink-400)",
        }}>
          <Icon name="image" size={10} />
        </span>
      )}
      {/* W8-sweep (2026-05-16): chip 内删除 X — 16x16 容器没空间放文字, 但是 chip 整体已带角度文本,
         配合 hover tooltip 充分表达意图; 铁律 #11 允许"空间不够 2x2 排列"豁免. */}
      {/* 保留原因: chip 内嵌的 16×16 圆形 X (borderRadius 999),Button size icon-sm 是 28×28 太大,且 chip 整体已是 sortable 拖拽形态 (规则 6 拖拽 handle 同行) */}
      <button
        type="button"
        onClick={onRemove}
        aria-label="移除此关键帧锚点"
        style={{
          marginLeft: 2, width: 16, height: 16, borderRadius: 999,
          border: "1px solid var(--ink-200)", background: "var(--surface-card)",
          color: "var(--ink-600)", cursor: "pointer",
          display: "grid", placeItems: "center", padding: 0,
        }}
        title="移除此关键帧锚点"
      >
        <Icon name="close" size={8} />
      </button>
    </span>
  );
}
