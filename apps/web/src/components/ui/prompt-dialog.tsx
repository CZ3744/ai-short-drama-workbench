// TODO(ui-dialog-unify): 迁 BaseDialog 统一 — 当前是手写 fixed 卡片, 不走 Radix Dialog / BaseDialog,
// 与 codebase 其余 19 个 Dialog 不一致. 6 个 caller 文件需同步更新, 估时 >30min.
import { useEffect, useState } from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";

export interface PromptDialogProps {
  open: boolean;
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  busy?: boolean;
  multiline?: boolean;
  allowEmpty?: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void | Promise<void>;
}

export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  defaultValue = "",
  confirmText = "确认",
  cancelText = "取消",
  busy,
  multiline,
  allowEmpty,
  onClose,
  onSubmit,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [defaultValue, open]);

  if (!open) return null;

  const trimmed = value.trim();
  const canSubmit = allowEmpty ? !busy : Boolean(trimmed) && !busy;
  const submit = () => {
    if (!canSubmit) return;
    void onSubmit(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="mk-card w-full max-w-md p-5 shadow-2xl" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mb-4">
          <h3 className="m-0 text-base font-semibold text-[var(--ink-900)]">{title}</h3>
          {description ? <p className="mt-1 text-sm leading-6 text-[var(--ink-500)]">{description}</p> : null}
        </div>

        <label className="block">
          {label ? <span className="mb-1 block text-xs font-medium text-[var(--ink-600)]">{label}</span> : null}
          {multiline ? (
            <Textarea
              autoFocus
              rows={4}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
            />
          ) : (
            <Input
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
                if (event.key === "Escape" && !busy) onClose();
              }}
              placeholder={placeholder}
            />
          )}
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {cancelText}
          </Button>
          <Button size="sm" onClick={submit} loading={busy} disabled={!canSubmit}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
