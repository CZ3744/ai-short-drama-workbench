import { useState } from "react";
import { cn } from "../../../lib/cn";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface MissingShotsAlertProps {
  /** 未就绪分镜数量 */
  missingCount: number;
  /** 总镜头数 */
  totalCount: number;
  /** 缺失分镜标签列表 (用于提示) */
  missingLabels?: string[];
  /** 点击跳转到第一个缺失分镜 */
  onClick: () => void;
  /** 是否可关闭 */
  dismissible?: boolean;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function MissingShotsAlert({
  missingCount,
  totalCount,
  missingLabels = [],
  onClick,
  dismissible = true,
  className,
}: MissingShotsAlertProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  // 全部就绪 — 绿色成功条
  if (missingCount === 0 && totalCount > 0) {
    return (
      <div
        className={cn(
          "flex items-center gap-[var(--sp-3)] px-[var(--sp-4)] py-[var(--sp-3)] rounded-lg",
          "bg-green-50 border border-green-300 text-green-800 text-sm",
          className,
        )}
      >
        <svg className="w-5 h-5 shrink-0 text-green-500" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
        </svg>
        <span className="flex-1 font-medium">
          全部 {totalCount} 个分镜已就绪，可以合成长片了
        </span>
        {/* 保留原因: alert 主题色嵌入 X 关闭按钮 — text-green-500 + hover:bg-green-100 跟容器 bg-green-50 主题一致,Button 无对应 success 变体. 2026-07-22 X4 铁律#11: X 图标后加可见文字"关闭" */}
        {dismissible && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-green-100 transition-colors text-green-500 hover:text-green-700"
            aria-label="关闭提示"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-xs font-medium">关闭</span>
          </button>
        )}
      </div>
    );
  }

  // 全部缺失 — 极端情况
  if (missingCount === totalCount && totalCount > 0) {
    return (
      <div
        className={cn(
          "flex items-center gap-[var(--sp-3)] px-[var(--sp-4)] py-[var(--sp-3)] rounded-lg",
          "bg-red-50 border border-red-300 text-red-800 text-sm",
          className,
        )}
      >
        <svg className="w-5 h-5 shrink-0 text-red-500" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 1.944A8.056 8.056 0 0118.056 10 8.056 8.056 0 0110 18.056 8.056 8.056 0 011.944 10 8.056 8.056 0 0110 1.944zM10 6a1 1 0 00-1 1v3a1 1 0 102 0V7a1 1 0 00-1-1zm0 7a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" />
        </svg>
        <span className="flex-1 font-medium">
          全部 {missingCount} 个分镜未就绪；可先粗剪预览节奏，精剪前再审批并挑选素材
        </span>
        {/* 保留原因: alert 主题色嵌入 X 关闭按钮 — text-red-500 + hover:bg-red-100 跟容器 bg-red-50 一致,Button 无对应 alert-context X 关闭变体. 2026-07-22 X4 铁律#11: X 图标后加可见文字"关闭" */}
        {dismissible && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-red-100 transition-colors text-red-500 hover:text-red-700"
            aria-label="关闭提示"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-xs font-medium">关闭</span>
          </button>
        )}
      </div>
    );
  }

  // 部分缺失 — 黄色/橙色警示条
  if (missingCount > 0) {
    const labelSample = missingLabels.slice(0, 5).join(", ");
    const moreHint = missingLabels.length > 5 ? ` 等 ${missingLabels.length} 个` : "";

    return (
      // 保留原因: 整张 alert card 可点击模式 — w-full + 多列 layout (svg + flex-1 文本 + 缩略 + 箭头 + 嵌入 X) + 主题色背景 amber-50, Button 不覆盖这种 alert-as-button 形态
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex items-center gap-[var(--sp-3)] px-[var(--sp-4)] py-[var(--sp-3)] rounded-lg w-full text-left",
          "bg-amber-50 border border-amber-300 text-amber-800 text-sm",
          "hover:bg-amber-100 hover:border-amber-400 transition-colors cursor-pointer",
          className,
        )}
      >
        <svg className="w-5 h-5 shrink-0 text-amber-500" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        <span className="flex-1 font-medium">
          {missingCount} 个分镜未就绪，可先粗剪预览（点击查看）
        </span>
        <span className="text-xs text-amber-600 hidden sm:inline max-w-[200px] truncate">
          {labelSample}{moreHint}
        </span>
        <svg className="w-4 h-4 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        {/* 保留原因: 嵌套于 alert button 内的 X 关闭子按钮 — text-amber-500 主题色 + 防 click 冒泡 stopPropagation; 不能用 Button (Button 会嵌套 button → DOM invalid). 2026-07-22 X4 铁律#11: X 图标后加可见文字"关闭" */}
        {dismissible && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-amber-100 transition-colors text-amber-500 hover:text-amber-700 ml-1"
            aria-label="关闭提示"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-xs font-medium">关闭</span>
          </button>
        )}
      </button>
    );
  }

  // 无分镜数据 — 不渲染
  return null;
}
