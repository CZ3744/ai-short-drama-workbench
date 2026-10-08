/**
 * ElementHeader — 素材详情页顶部信息条 + 大标题输入.
 *
 * 内容:
 *   · 返回素材库按钮
 *   · 类型 chip (角色/场景/...)
 *   · 状态药丸 (草稿/有候选图/已锁主图)
 *   · "保存修改" 按钮(仅 dirty 时显示)
 *   · "删除" 按钮(走二次确认,父组件 handleDelete)
 *   · 名称大标题 input
 *
 * 从 ElementWorkbench 拆出(Wave P2 解耦). 视觉零变更.
 */

import { Button } from "../../../components/ui/button";
import { ELEMENT_KIND_LABEL, type ElementData } from "../../../lib/elementApi";

const STATUS_PILL: Record<ElementData["status"], { cls: string; label: string }> = {
  drafted: { cls: "mk-pill--draft", label: "草稿" },
  has_images: { cls: "mk-pill--ready", label: "有候选图" },
  locked: { cls: "mk-pill--approved", label: "已锁定主图" },
};

interface Props {
  element: ElementData;
  name: string;
  dirty: boolean;
  onNameChange: (next: string) => void;
  onSave: () => void;
  onBack: () => void;
  onDelete: () => void;
}

export function ElementHeader({
  element,
  name,
  dirty,
  onNameChange,
  onSave,
  onBack,
  onDelete,
}: Props) {
  const pill = STATUS_PILL[element.status];

  return (
    <>
      {/* 顶部 chips + 操作按钮 */}
      <div className="element-workbench-toolbar" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <Button variant="ghost" size="sm" iconLeft="arrowLeft" onClick={onBack}>
          素材库
        </Button>
        <span className="mk-chip mk-chip--ghost">{ELEMENT_KIND_LABEL[element.kind]}</span>
        <span className={`mk-pill ${pill.cls}`}>{pill.label}</span>
        <div style={{ flex: 1 }} />
        {dirty ? (
          <Button variant="primary" size="sm" iconLeft="check" onClick={onSave}>
            保存修改
          </Button>
        ) : null}
        <Button variant="danger" size="sm" iconLeft="warning" onClick={onDelete}>
          删除
        </Button>
      </div>

      {/* 大标题名称输入 */}
      <input
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        style={{
          fontFamily: "'Noto Serif SC', 'Source Han Serif SC', serif",
          fontSize: 24,
          fontWeight: 700,
          color: "var(--ink-900)",
          border: "none",
          background: "transparent",
          outline: "none",
          width: "100%",
          padding: "6px 0 14px",
        }}
      />
    </>
  );
}
