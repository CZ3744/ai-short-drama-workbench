/**
 * KeyboardShortcutsDialog — 全局快捷键 help 弹窗 (2026-05-27)
 *
 * 触发: 按 "?" / "/" / "Shift+?", 或右下角常驻的"快捷键"浮按钮 (2026-07-09 补, 见下方
 * GlobalKeyboardShortcutsHelp — 之前只能靠隐藏快捷键触发, 中文输入法下"?"常被吞, 等于
 * 这个"教用户有哪些快捷键"的帮助自己完全不可发现).
 * 用户原话: "还有什么痛点... 你糊弄我". 项目快捷键多 (F/V/1-9/Esc/←→/Alt+I 等)
 * 但用户不知道, 没 help 弹窗. 这一个补齐.
 */
import { useGlobalTool } from "./GlobalTools";
import { useEffect, useState } from "react";
import { BaseDialog } from "../ui/BaseDialog";
import { Icon } from "../shared/Icon";

interface ShortcutEntry {
  keys: string[];
  desc: string;
  scope: string; // 在哪个页面生效
}

const SHORTCUTS: ShortcutEntry[] = [
  // 全局
  { scope: "全局", keys: ["?"], desc: "打开快捷键速查 (本对话框)" },
  { scope: "全局", keys: ["Alt", "I"], desc: "打开 / 收起 AI 润色助手" },
  { scope: "全局", keys: ["Esc"], desc: "关闭当前对话框 / 弹窗 / Lightbox" },

  // 单镜创作页 (ShotStagePage)
  { scope: "单镜创作页", keys: ["←", "J"], desc: "上一镜" },
  { scope: "单镜创作页", keys: ["→", "K"], desc: "下一镜" },
  { scope: "单镜创作页", keys: ["Esc"], desc: "返回分镜板" },
  { scope: "单镜创作页", keys: ["1", "—", "9"], desc: "定位到第 N 张候选图" },
  { scope: "单镜创作页", keys: ["F"], desc: "把当前焦点候选设为首帧" },
  { scope: "单镜创作页", keys: ["V"], desc: "把当前焦点候选设为最终视频" },
  { scope: "单镜创作页", keys: ["Space"], desc: "播放 / 暂停已选中的视频" },
  { scope: "单镜创作页", keys: ["Ctrl", "Enter"], desc: "在生成框内触发抽卡 (生成首帧 / 视频)" },
  // 2026-05-28 深度打磨 #5: 撤销最近一次保存
  { scope: "单镜创作页", keys: ["Ctrl", "Z"], desc: "撤销最近一次自动保存 (回到上一版本)" },

  // AI 助手
  { scope: "AI 助手", keys: ["Ctrl", "Enter"], desc: "输入框内 — 发送消息" },
];

export function KeyboardShortcutsDialog({
  open, onClose,
}: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  // 按 scope 分组
  const grouped = SHORTCUTS.reduce((acc, s) => {
    if (!acc[s.scope]) acc[s.scope] = [];
    acc[s.scope].push(s);
    return acc;
  }, {} as Record<string, ShortcutEntry[]>);

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      toolPanel="shortcuts"
      title="键盘快捷键速查"
      maxWidth={560}
      iconName="help"
    >
      <div style={{ fontSize: 12, color: "var(--ink-500)", marginBottom: 12 }}>
        在 input / textarea / 弹窗内时, 大部分快捷键暂停 (避免吞用户输入).
        如果快捷键没响应, 检查是不是焦点在某个输入框.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {Object.entries(grouped).map(([scope, items]) => (
          <div key={scope}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--brand-700)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}>
              {scope}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {items.map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 10px",
                    borderRadius: 6,
                    background: i % 2 === 0 ? "var(--ink-50)" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    {s.keys.map((k, j) => (
                      <kbd
                        key={j}
                        style={{
                          padding: "2px 7px",
                          fontFamily: "ui-monospace, Consolas, monospace",
                          fontSize: 10.5,
                          fontWeight: 600,
                          color: "var(--ink-800)",
                          background: "var(--surface-card)",
                          border: "1px solid var(--ink-200)",
                          borderRadius: 4,
                          minWidth: 22,
                          textAlign: "center",
                          boxShadow: "0 1px 0 var(--ink-200)",
                        }}
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                  <span style={{ fontSize: 12, color: "var(--ink-700)" }}>{s.desc}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </BaseDialog>
  );
}

/** Hook: 在 App 顶层挂一次, 全局监听 "?" 键打开 dialog */
export function useKeyboardShortcutsHelp() {
  const { open, setOpen } = useGlobalTool("shortcuts");
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ? 或 Shift+/ 都触发 (英文键盘上 ? 是 Shift+/)
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        // 输入框 / 弹窗内不触发
        const t = e.target as HTMLElement;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        if (t?.closest('[role="dialog"]')) return;
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}

/** App 顶层挂载的 wrapper — 包 hook + dialog, 一行接入. */
export function GlobalKeyboardShortcutsHelp() {
  const { open, setOpen } = useKeyboardShortcutsHelp();
  return (
    <>
      {/* 2026-07-09 audit(text-global finding P3 · KeyboardShortcutsDialog): 之前这个帮助
          弹窗只能靠隐藏的 "?" 键触发(中文输入法下常被吞), 组件头注释还声称"或 AppTopBar
          显式入口"但 AppTopBar 里根本没做——等于"教用户有哪些快捷键"的入口自己完全不可发现
          (铁律 #11 每个按钮都有名字: 图标 + 文字)。补一个常驻右下角浮按钮, 与 AI 助手 /
          任务中心浮按钮同一竖排堆叠 (bottom: 24 / 88, 这里再上一层 152), 弹窗打开时隐藏
          浮按钮避免和 BaseDialog 遮罩重复占位。 */}
      {!open && (
        <button
          type="button"
          data-tool-trigger="shortcuts"
          onClick={() => setOpen(true)}
          style={{
            position: "relative",
            height: 36,
            minWidth: 84,
            padding: "0 12px",
            borderRadius: 999,
            background: "var(--surface-card)",
            color: "var(--ink-600)",
            border: "1px solid var(--ink-200)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            zIndex: 50,
          }}
          title="查看全部键盘快捷键 (按 ? 键也能打开)"
        >
          <Icon name="help" size={13} />
          快捷键
        </button>
      )}
      <KeyboardShortcutsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
