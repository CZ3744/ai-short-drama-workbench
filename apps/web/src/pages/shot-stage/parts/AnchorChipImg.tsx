/**
 * AnchorChipImg — 锚点 chip (首/尾) — 缩略图改 <img> 浏览器原生右键复制.
 * 未设状态:虚线占位 + 点击提示用户去设定(铁律 #10 优雅空状态).
 *
 * 视觉零变更. 从 ShotStagePage 拆出 (P2 #16).
 */
import type { ShotCandidate, FrameAnchor } from "../../../lib/shotApi";

export function AnchorChipImg({
  label, anchor, candidate, onOpen, onMissingClick,
}: {
  label: string; anchor?: FrameAnchor; candidate?: ShotCandidate;
  onOpen?: (c: ShotCandidate) => void;
  onMissingClick?: () => void;
}) {
  const has = !!anchor && !!candidate;
  const src = candidate?.thumbnail || candidate?.url || "";
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "3px 7px", borderRadius: 6,
        background: has ? "var(--surface-card)" : "transparent",
        border: has ? "1px solid var(--ink-150)" : "1px dashed var(--ink-300)",
        cursor: has || onMissingClick ? "pointer" : "default",
      }}
      onClick={() => {
        if (has && onOpen && candidate) onOpen(candidate);
        else if (!has && onMissingClick) onMissingClick();
      }}
      title={has ? `点击放大查看 ${label}` : `${label}未设 · 点击查看如何设定`}
    >
      <span style={{ fontSize: 10.5, fontWeight: 700, color: has ? "var(--ink-700)" : "var(--ink-400)" }}>
        {label}
      </span>
      {has && src ? (
        <img
          src={src}
          alt={candidate?.display_name?.trim() || label}
          style={{
            width: 36, height: 36, borderRadius: 4, objectFit: "cover",
            border: "1px solid var(--ink-150)",
          }}
          title="点击放大 / 右键可复制"
        />
      ) : (
        <span style={{
          width: 36, height: 36, borderRadius: 4,
          display: "grid", placeItems: "center",
          background: "var(--ink-50)",
          color: "var(--ink-400)",
          fontSize: 9, fontWeight: 600,
        }}>未设</span>
      )}
    </span>
  );
}
