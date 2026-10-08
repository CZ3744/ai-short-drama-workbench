/**
 * PushToDownstreamModal — 把本地版本推送到指定下游派生素材 (W3).
 *
 * 触发: UpstreamDownstreamPanel 在 derivatives 卡片点"推送到这个剧".
 * 流程: 用户勾要推哪几个字段 → 二次确认 (输框输入目标名) → POST /push-to-downstream.
 *
 * UX 铁律:
 *   #1 用户控制 — 字段必选, 默认全不勾
 *   #6 数据保留 — 推送前明示"会覆盖目标素材对应字段", 输入框二次确认
 *   #11 按钮带文字 — "推送所选" / "取消"
 *   #12 批改即发送 — 没缓存任何字段
 */

import { useState } from "react";
import { toast } from "sonner";
import { BaseDialog } from "../ui/BaseDialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  pushToDownstream,
  type DerivativeEntry,
  type SyncField,
} from "../../lib/elementApi";
import { showErrorToast } from "../../lib/errorTranslate";

export interface PushToDownstreamModalProps {
  open: boolean;
  slug: string;
  elementId: string;
  /** 本地素材名 — 用于二次确认对照 */
  elementName: string;
  /** 推送目标 (从 derivatives 列表点过来的那一条). */
  target: DerivativeEntry;
  onClose: () => void;
  onPushed: () => void;
}

const FIELDS: { key: SyncField; label: string; hint: string }[] = [
  { key: "description", label: "描述", hint: "把本地的描述文本覆盖到复制版" },
  { key: "tags", label: "标签", hint: "把本地的标签集合覆盖到复制版 (整体替换)" },
  { key: "primary_image", label: "主图", hint: "把本地主图追加到复制版 (不抢主图位置)" },
  { key: "image_briefs", label: "图规划", hint: "把本地的图规划列表覆盖到复制版" },
];

export function PushToDownstreamModal({
  open,
  slug,
  elementId,
  elementName,
  target,
  onClose,
  onPushed,
}: PushToDownstreamModalProps) {
  const [selected, setSelected] = useState<Set<SyncField>>(new Set());
  const [confirmText, setConfirmText] = useState("");
  const [pushing, setPushing] = useState(false);

  function toggle(field: SyncField) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field); else next.add(field);
      return next;
    });
  }

  const requireText = target.element_name; // 用户必须输目标素材名才能确认
  const canSubmit = selected.size > 0 && confirmText.trim() === requireText.trim() && !pushing;

  async function handlePush() {
    if (!canSubmit) return;
    setPushing(true);
    try {
      const res = await pushToDownstream(
        slug,
        elementId,
        target.series_slug,
        target.element_id,
        Array.from(selected),
      );
      const labels = res.updated_fields
        .map((f) => FIELDS.find((x) => x.key === f)?.label ?? f)
        .join("、");
      toast.success(labels ? `已同步: ${labels}` : "复制版已无字段需要更新");
      onPushed();
      onClose();
    } catch (e) {
      showErrorToast(e, "同步失败");
    } finally {
      setPushing(false);
    }
  }

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      title="同步到这部剧"
      subtitle={`目标剧: ${target.series_title} · 目标素材: ${target.element_name}`}
      iconName="upload"
      busy={pushing}
      maxWidth={620}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={pushing}>
            取消
          </Button>
          <Button
            variant="primary"
            iconLeft="upload"
            onClick={handlePush}
            disabled={!canSubmit}
          >
            {pushing ? "同步中..." : `同步所选 (${selected.size})`}
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          style={{
            background: "var(--amber-50, #fff7ed)",
            border: "1px solid var(--amber-200, #fed7aa)",
            borderRadius: "var(--r-md)",
            padding: 10,
            fontSize: 12.5,
            color: "var(--ink-700)",
            lineHeight: 1.55,
          }}
        >
          这会用「{elementName}」当前的字段值覆盖目标剧「{target.series_title}」中的「{target.element_name}」
          对应字段. 此操作不可撤销. 请仔细勾选要同步的字段.
        </div>

        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-800)" }}>
          选要同步的字段
        </div>
        {FIELDS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => toggle(f.key)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: 10,
              border: `1px solid ${selected.has(f.key) ? "var(--brand-500)" : "var(--ink-200)"}`,
              borderRadius: "var(--r-sm)",
              background: selected.has(f.key) ? "var(--brand-50)" : "var(--surface)",
              textAlign: "left",
              cursor: "pointer",
              transition: "all 120ms",
            }}
          >
            <Checkbox checked={selected.has(f.key)} onCheckedChange={() => toggle(f.key)} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)" }}>{f.label}</div>
              <div style={{ fontSize: 11.5, color: "var(--ink-500)", marginTop: 2 }}>{f.hint}</div>
            </div>
          </button>
        ))}

        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-800)", marginBottom: 6 }}>
            二次确认 — 输入目标素材名以解锁同步按钮
          </div>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={requireText}
            disabled={pushing}
          />
          <div style={{ fontSize: 11, color: "var(--ink-500)", marginTop: 4 }}>
            需输入: <code style={{ color: "var(--brand-700)" }}>{requireText}</code>
          </div>
        </div>
      </div>
    </BaseDialog>
  );
}
