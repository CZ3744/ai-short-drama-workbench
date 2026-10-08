// 拆自 ShotboardPage.tsx — 单独负责"删除分镜二次确认"弹窗(T5)
// 主页面调用：count + labels + 取消/确认两个回调。不改业务逻辑。
import { Button } from "../../../components/ui/button";
import { Icon } from "../../../components/shared/Icon";

export function DeleteConfirmModal({
  count,
  labels,
  onCancel,
  onConfirm,
}: {
  count: number;
  labels: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="presentation"
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 80,
        display: "grid", placeItems: "center", padding: 24,
        background: "rgba(40,30,24,0.36)",
      }}
    >
      <div
        className="mk-card"
        role="dialog"
        aria-modal="true"
        aria-label="删除分镜确认"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(380px, calc(100vw - 32px))", borderRadius: 14, padding: 22, boxShadow: "var(--shadow-xl)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--err-bg)", display: "grid", placeItems: "center", color: "var(--err)", flexShrink: 0 }}>
            <Icon name="warning" size={18} />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 750, color: "var(--ink-900)" }}>
              删除 {count > 1 ? `${count} 条分镜` : "分镜"}？
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-500)", marginTop: 3 }}>
              {labels.length > 0 ? labels.join("、") : count > 1 ? `${count} 条` : "该"}{count > 1 ? "分镜" : "分镜"}将移到本集垃圾桶，可随时恢复。
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="danger" size="sm" iconLeft="trash" onClick={onConfirm}>
            确认删除
          </Button>
        </div>
      </div>
    </div>
  );
}
