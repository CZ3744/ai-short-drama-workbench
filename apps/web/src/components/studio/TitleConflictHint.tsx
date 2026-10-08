/**
 * TitleConflictHint — 共享重名提示组件.
 *
 * 2026-05-21 — 用户原话: "导入/创建的时候要检查, 重名的话要提示修改".
 *
 * 用法 (各 dialog title input 旁边嵌入):
 *   <input value={title} onChange={...} />
 *   <TitleConflictHint title={title} existingTitles={existingTitles} />
 *
 * 行为:
 *   - title.trim() 为空 → 不显示
 *   - title.trim().toLowerCase() === 任一 existingTitles (同款 normalize) → 显示橘色 hint
 *   - 不阻塞 (后端 uniqueSlug 自动加 -2 后缀, 用户也可能真想做 A/B 对比), 但显式告知避免误操作
 */

import { useMemo } from "react";

export interface TitleConflictHintProps {
  /** 用户当前输入的标题 (任意大小写 / 空格) */
  title: string;
  /** 已有系列的 title 列表 (从 listSeries 拿) */
  existingTitles: string[];
  /** 自定义边距 (默认 marginTop: 6) */
  style?: React.CSSProperties;
}

/**
 * 检测 title 是否跟已有系列重名 (toLowerCase + trim 比较, 大小写/空格不敏感).
 * 返回冲突的原始 title (用于 hint 文案), 没有冲突时 undefined.
 */
export function detectTitleConflict(title: string, existingTitles: string[]): string | undefined {
  const trimmed = title.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = trimmed.toLowerCase();
  return existingTitles.find((t) => t.trim().toLowerCase() === normalized);
}

export function TitleConflictHint({ title, existingTitles, style }: TitleConflictHintProps) {
  const conflict = useMemo(
    () => detectTitleConflict(title, existingTitles),
    [title, existingTitles],
  );
  if (!conflict) return null;
  return (
    <div
      style={{
        marginTop: 6,
        padding: "8px 10px",
        background: "rgba(217, 119, 6, 0.08)",
        border: "1px solid rgba(217, 119, 6, 0.2)",
        borderRadius: 8,
        fontSize: 12,
        color: "var(--ink-700)",
        lineHeight: 1.5,
        ...style,
      }}
    >
      <strong style={{ color: "var(--warn, #d97706)" }}>⚠ 已有同名系列「{conflict}」</strong>
      <div style={{ marginTop: 2, color: "var(--ink-600)" }}>
        继续创建会作为另一部独立系列(标题相同但内部 slug 加后缀 -2 区分)。
        建议改名以免后续混淆,或确认这是有意的同名(例如做 A/B 版本对比)。
      </div>
    </div>
  );
}
