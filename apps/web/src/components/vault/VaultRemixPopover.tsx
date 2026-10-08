// 2026-05-26 — Vault "风格变体" 弹层 (替换原 silent 默认模型路径).
//
// 用户反馈: 点风格变体按钮直接弹"该 Provider 当前不可用, 已尝试备选"。
// 根因: 老代码 vaultRemix 没指定 provider_id, 后端走 registry.listAvailable("image")[0],
// 默认 provider 全失败时 toast 报"备选 N 家"系统话术, 用户没意识到要选模型。
//
// 设计要点 (铁律 #1 用户控制 > 系统智能 + #4 就近决策 + #2 可干预性):
//   - 点风格变体 → 弹小 popover (跟 CoverGenPopover 风格统一)
//   - 必选: 图像模型 ModelPicker (不选不能提交)
//   - 选填: 修改意见 (默认"风格变体")
//   - 文案明确"会扣 API 额度"提示, 不偷偷扣费
//   - 记住上次用过的模型 (rememberLastUsed)
//
// 解耦: 不知道 vault_id, 父 caller 给一个 onSubmit 回调.

import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { ModelPicker } from "../studio/ModelPicker";
import { Button } from "../ui/button";
import { getLastUsedModel, rememberLastUsed } from "../../lib/lastUsedModel";

export interface VaultRemixPopoverProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  triggerEl: React.ReactNode;
  busy: boolean;
  onSubmit: (opts: { provider_id: string; user_note: string }) => void;
}

export function VaultRemixPopover({
  open,
  onOpenChange,
  triggerEl,
  busy,
  onSubmit,
}: VaultRemixPopoverProps) {
  const [modelRef, setModelRef] = useState<string>(() => getLastUsedModel("image") || "");
  const [note, setNote] = useState<string>("");

  const canSubmit = !!modelRef && !busy;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{triggerEl}</PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80"
        onClick={(e) => e.stopPropagation()}
        onPointerDownOutside={() => onOpenChange(false)}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)", marginBottom: 4 }}>
              生成风格变体
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-500)", lineHeight: 1.5 }}>
              以这张图为底稿, 选个图像模型重画一版。<span style={{ color: "var(--warn, #b45309)" }}>会扣 API 额度。</span>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, color: "var(--ink-600)", display: "block", marginBottom: 4 }}>
              图像模型
            </label>
            <ModelPicker
              kind="image"
              value={modelRef}
              onChange={(v) => {
                const ref = v ?? "";
                setModelRef(ref);
                if (ref) rememberLastUsed("image", ref);
              }}
              size="sm"
              placeholder="选图像模型"
            />
          </div>

          <div>
            <label style={{ fontSize: 11, color: "var(--ink-600)", display: "block", marginBottom: 4 }}>
              修改意见 <span style={{ color: "var(--ink-400)", fontWeight: 400 }}>(选填)</span>
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例: 换成水彩风格 / 角色面带微笑"
              style={{
                width: "100%",
                height: 30,
                padding: "0 8px",
                fontSize: 12,
                borderRadius: 6,
                border: "1px solid var(--ink-200)",
                outline: "none",
                background: "var(--surface-card)",
              }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              iconLeft={busy ? "refresh" : "sparkles"}
              loading={busy}
              onClick={() =>
                onSubmit({
                  provider_id: modelRef,
                  user_note: note.trim() || "风格变体",
                })
              }
              disabled={!canSubmit}
              title={!modelRef ? "请先选图像模型" : "开始生成"}
            >
              {busy ? "生成中…" : "开始生成"}
            </Button>
          </div>
          {!modelRef ? (
            <div style={{ fontSize: 11, color: "var(--warn, #b45309)" }}>
              请先选图像模型, 或去「设置」配置默认模型
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
