// 2026-05-17: 候选卡片底部 inline 重命名 — 视频候选 + 首帧候选公用一套.
// 2026-05-20: 字段名统一为 display_name (display_name 体系全工作台单一真理源).
//
// 用户原话: "生成的视频素材不能直接修改底下的视频名, 之前我要求过允许修改,
//          查查所有地方是不是都有问题, 包括图片素材底下也要能自己改, 复用同一套逻辑就行".
//
// 设计:
//   - 默认显示 displayLabel (custom display_name 优先, 没有则 provider 名)
//   - 单击/聚焦切入编辑态 (input + 保存按钮 + 取消)
//   - Enter / blur 保存, Esc 取消
//   - 失败 toast 提示 + 自动恢复
//   - 显示状态: 蓝色描边表示 custom (display_name 存在), 灰色 italic 表示默认 provider 名

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useAsyncAction } from "../../hooks/useAsyncAction";

// 2026-05-20 Wave T — 父组件通过 ref 主动触发编辑态(用 ImageCard 让整个名字行可点击进编辑)
export interface InlineLabelHandle {
  startEdit(): void;
}

export interface InlineLabelProps {
  /** 当前用户自定义名 (空 = 走默认 fallback) */
  value: string | undefined;
  /** 没设 display_name 时显示的灰底文字 (例如 provider 名) */
  fallback: string;
  /** 保存回调; throw 让 InlineLabel 回退 + 显示错误 */
  onSave: (newLabel: string) => Promise<void>;
  /** 默认 false; 加 stopPropagation 让卡片 onClick 不触发 lightbox 等 */
  stopPropagation?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export const InlineLabel = forwardRef<InlineLabelHandle, InlineLabelProps>(function InlineLabel(
  { value, fallback, onSave, stopPropagation = true, className, style },
  ref,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 暴露 startEdit() 给父 — 父在外层 div 上 click 可触发本组件编辑态
  useImperativeHandle(ref, () => ({
    startEdit: () => setEditing(true),
  }), []);

  // 用 useAsyncAction 接管 busy + try/catch — onSave 内部已 toast, 失败回退 draft
  const saveAction = useAsyncAction(
    async (trimmed: string) => {
      await onSave(trimmed);
    },
    {
      silent: true,
      onSuccess: () => setEditing(false),
      onError: () => setDraft(value ?? ""),
    },
  );
  const saving = saveAction.busy;

  // value 从外部更新时同步 draft (e.g. SWR refresh)
  useEffect(() => { if (!editing) setDraft(value ?? ""); }, [value, editing]);

  // 进入编辑态自动 focus + 全选
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleEnter = (e: React.MouseEvent | React.KeyboardEvent) => {
    if (stopPropagation) e.stopPropagation();
    setEditing(true);
  };

  const handleCancel = () => {
    setDraft(value ?? "");
    setEditing(false);
  };

  const handleSave = async () => {
    const trimmed = draft.trim();
    if (trimmed === (value ?? "")) {
      setEditing(false);
      return;
    }
    await saveAction.run(trimmed);
  };

  if (editing) {
    return (
      <div
        className={className}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          ...style,
        }}
        onClick={(e) => stopPropagation && e.stopPropagation()}
        onMouseDown={(e) => stopPropagation && e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={60}
          disabled={saving}
          placeholder={fallback}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void handleSave(); }
            else if (e.key === "Escape") { e.preventDefault(); handleCancel(); }
          }}
          onBlur={() => { if (!saving) void handleSave(); }}
          style={{
            flex: 1, minWidth: 0,
            fontSize: 10.5,
            padding: "2px 6px",
            borderRadius: 4,
            border: "1px solid var(--brand-500)",
            background: "var(--surface-card)",
            color: "var(--ink-900)",
            outline: "none",
          }}
        />
      </div>
    );
  }

  const isCustom = !!(value && value.trim());

  // 2026-05-20 Wave T — 整行可点击编辑, 不需要单独"铅笔按钮"(用户原话"不要点编辑按钮才能编辑").
  // 多重防御:div onClick + onMouseDown 都 stopPropagation, 防外层 onClick 抢触发.
  const stopMouse = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
  };

  return (
    <div
      className={`v24-inline-label ${className ?? ""}`}
      onClick={handleEnter}
      onMouseDown={stopMouse}
      title={isCustom ? `点击修改 (默认: ${fallback})` : "点击命名此候选"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        cursor: "text",
        overflow: "hidden",
        ...style,
      }}
    >
      <span style={{
        flex: 1, minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        // 虚线下划线让用户看出可编辑
        textDecoration: "underline dashed",
        textDecorationColor: "currentColor",
        textDecorationThickness: 1,
        textUnderlineOffset: 3,
        opacity: isCustom ? 1 : 0.7,
        fontStyle: isCustom ? "normal" : "italic",
      }}>
        {isCustom ? value : fallback}
      </span>
    </div>
  );
});
