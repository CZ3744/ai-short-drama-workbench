/**
 * BaseDialog — 通用 Modal 外壳, 统一所有 Dialog 的 backdrop / 容器 / 标题 /
 * 关闭按钮 / scroll 行为.
 *
 * 用户原话 (2026-05-19 audit):
 *   "避免屎山, 避免同样的逻辑需要去不同处改多次"
 *
 * 之前 BatchSeriesDialog / BatchImportMultiDialog / ExtractFromScriptDialog /
 * PasteStoryboardDialog / CrossSeriesImportDialog 各写 ~30-50 行 shell 代码,
 * 共浪费 ~200 行重复. 抽 BaseDialog 后各 dialog 只写 body + footer.
 *
 * 不强制 ConfirmModal / PromptReviewModal / AddVideoModelModal / LibraryPickerModal
 * 等迁移 (这些有自己的 layout 风格), 仅迁移用同款 shell 的 5 处.
 */

import { useEffect, type ReactNode } from "react";
import { Icon, type IconName } from "../shared/Icon";
import { Button } from "./button";

// 2026-07-09 audit (asset-dialog lane): 打开弹窗锁 body 背景滚动.
// 之前全项目只有 MediaLightbox 锁了滚动, 所有 BaseDialog 系弹窗 (管理素材组 / 跨项目导入 /
// 从剧本抽素材 / 素材库选择器 ...) 打开时滚轮会滚穿到背后整页, 体验很晃, 也容易丢失阅读位置.
// 用「引用计数」而非各自 save/restore: ConfirmModal 常叠在 BaseDialog 之上 (弹窗内任何删除都走
// useConfirm), 若内层关闭时各自还原, 会把外层弹窗的锁提前解掉 → 背景又能滚. 计数归零才真正还原.
let scrollLockCount = 0;
let savedBodyOverflow = "";
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (scrollLockCount === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLockCount += 1;
    return () => {
      scrollLockCount -= 1;
      if (scrollLockCount <= 0) {
        scrollLockCount = 0;
        document.body.style.overflow = savedBodyOverflow;
      }
    };
  }, [active]);
}

export interface BaseDialogProps {
  toolPanel?: string;
  open: boolean;
  onClose: () => void;
  /** 标题 — 大字 + 主色 */
  title: ReactNode;
  /** 副标题 — 小字 + 灰色 (可选) */
  subtitle?: ReactNode;
  /** 顶部 icon (title 左侧, 渐变方块容器) — 默认无 icon */
  iconName?: IconName;
  /** 底部按钮组 slot — 通常包含 [取消] [主操作] */
  footer?: ReactNode;
  /** Footer 左侧附加内容 (例如状态文字 / 流程提示) */
  footerLeft?: ReactNode;
  /** 主 body 内容 */
  children: ReactNode;
  /** 最大宽度 px — 默认 720 */
  maxWidth?: number;
  /**
   * 2026-05-26 audit #10: 最小宽度 px — 默认 undefined (自动跟随内容).
   * 切 tab / 内部状态变化时弹窗尺寸跳的话, caller 传一个合理值 (e.g. 760) 稳定外壳.
   */
  minWidth?: number;
  /**
   * 2026-05-26 audit #10: 最小高度 px — 默认 undefined.
   * 切 tab 内容多少不一时, caller 传值 (e.g. 520) 让弹窗不"抖". 不超过视口高度.
   */
  minHeight?: number;
  /** zIndex — 默认 95 (避开 toast 300 / tooltip 400). 嵌套 dialog 传更高值 */
  zIndex?: number;
  /** 点 backdrop 是否关闭 — 默认 false (busy 状态时 caller 也传 false 防误关) */
  disableBackdropClose?: boolean;
  /** 关闭按钮文字 — 默认 "关闭" */
  closeLabel?: string;
  /** aria-label, 默认从 title 取(但 title 是 ReactNode 时需手传) */
  ariaLabel?: string;
  /** 是否 busy — disabled 关闭按钮 + 锁 backdrop */
  busy?: boolean;
  /** Header 内, 标题之下的额外内容 (chips / 统计 / 提示等). 不在 body 内. */
  headerExtra?: ReactNode;
}

export function BaseDialog({
  toolPanel,
  open,
  onClose,
  title,
  subtitle,
  iconName,
  footer,
  footerLeft,
  children,
  maxWidth = 720,
  minWidth,
  minHeight,
  zIndex = 95,
  disableBackdropClose = false,
  closeLabel = "关闭",
  ariaLabel,
  busy = false,
  headerExtra,
}: BaseDialogProps) {
  const lockBackdrop = busy || disableBackdropClose;

  // 2026-07-09 audit: 打开时锁背景滚动 (引用计数, 卸载/关闭时归零才还原).
  useBodyScrollLock(open);

  // 2026-05-20 P1 解耦: ESC 关闭. CandidateCompareModal / MediaLightbox 等老 modal 各自写
  // 一份 keydown listener, 抽到 BaseDialog 后所有 caller 自动获益.
  // busy 状态时不关 (跟 backdrop 锁逻辑一致).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !lockBackdrop) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, lockBackdrop, onClose]);

  if (!open) return null;

  return (
    <div
      data-tool-panel={toolPanel}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      style={{ position: "fixed", inset: 0, zIndex }}
    >
      {/* Backdrop */}
      <div
        onClick={lockBackdrop ? undefined : onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(26,24,22,0.45)",
          backdropFilter: "blur(6px)",
        }}
      />

      {/* Dialog 主体 — 固定居中 + max-height + 内部 flex column */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: `min(${maxWidth}px, calc(100vw - 32px))`,
          // 2026-05-26 audit #10: minWidth/minHeight 防 tab 切换时弹窗尺寸抖动.
          // 用 min() 兜底视口太小时不撑出去, 仅在视口够大时生效.
          minWidth: minWidth ? `min(${minWidth}px, calc(100vw - 32px))` : undefined,
          minHeight: minHeight ? `min(${minHeight}px, calc(100vh - 48px))` : undefined,
          maxHeight: "calc(100vh - 48px)",
          background: "#fff",
          borderRadius: 18,
          boxShadow: "0 32px 64px rgba(0,0,0,0.24)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--ink-100)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {iconName ? (
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: "linear-gradient(135deg, var(--brand-400), var(--brand-700))",
                  color: "#fff",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <Icon name={iconName} size={18} />
              </div>
            ) : null}
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2
                style={{
                  margin: 0,
                  fontFamily: "'Noto Serif SC', serif",
                  fontSize: 19,
                  fontWeight: 600,
                  color: "var(--ink-900)",
                }}
              >
                {title}
              </h2>
              {subtitle ? (
                <div style={{ fontSize: 12, color: "var(--ink-500)", marginTop: 2 }}>
                  {subtitle}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconLeft="close"
              onClick={onClose}
              disabled={busy}
              title="关闭"
            >
              {closeLabel}
            </Button>
          </div>
          {headerExtra ? <div style={{ marginTop: 12 }}>{headerExtra}</div> : null}
        </div>

        {/* Body — 可滚动 */}
        <div
          className="mk-scroll"
          style={{ flex: 1, overflowY: "auto", padding: "18px 24px" }}
        >
          {children}
        </div>

        {/* Footer — 可选 */}
        {footer || footerLeft ? (
          <div
            style={{
              padding: "14px 24px",
              borderTop: "1px solid var(--ink-100)",
              background: "var(--ink-50)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            {footerLeft ? <span style={{ flex: 1 }}>{footerLeft}</span> : null}
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
