/**
 * shot-stage 共享样式 — 从 ShotStagePage 抽出供 parts/ 子组件复用.
 * 视觉零变更. 不引入新依赖, 不调整任何样式数值.
 *
 * 命名分组:
 *   · inputStyle / textareaStyle / removeBadgeStyle  ─ 通用表单元素
 *   · candidateZoneStyle / candidateHeaderStyle / zoneTitleStyle / candidateEmptyStyle  ─ 候选区容器
 *   · inlinePreviewStyle / inlinePreviewSummaryStyle  ─ 提示词预览 details
 *   · mentionHintStyle  ─ textarea 下方提示
 *   · pickStarBadge / overlayBtn*  ─ 候选 Tile (FirstFrameTile / VideoCandidateTile) 覆盖按钮
 */
import type React from "react";

// ─── 通用表单元素 ─────────────────────────────────────────────
export const inputStyle: React.CSSProperties = {
  width: "100%", height: 34, borderRadius: 8, border: "1px solid var(--ink-200)",
  background: "var(--surface-card)", padding: "0 10px", outline: "none", fontSize: 12.5, color: "var(--ink-900)",
};
export const textareaStyle: React.CSSProperties = {
  width: "100%", borderRadius: 8, border: "1px solid var(--ink-200)", background: "var(--surface-card)",
  padding: "9px 10px", outline: "none", resize: "vertical", fontSize: 13, lineHeight: 1.65,
  color: "var(--ink-900)", fontFamily: "inherit",
};
// 2026-05-18: lcCheckBadge 已移除 — 唯一用过它的外置 element 网格已删除
export const removeBadgeStyle: React.CSSProperties = {
  position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 999,
  border: "1px solid var(--ink-200)", background: "var(--surface-card)", color: "var(--ink-600)",
  display: "grid", placeItems: "center", cursor: "pointer", padding: 0,
};

// ─── 候选区容器 ─────────────────────────────────────────────
export const candidateZoneStyle: React.CSSProperties = {
  borderRadius: 14, border: "1px solid var(--ink-100)",
  background: "var(--surface-card)", padding: "14px 16px 16px",
  boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
};
export const candidateHeaderStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 10, marginBottom: 14,
  paddingBottom: 12, borderBottom: "1px dashed var(--ink-100)",
};
// W10 sticky 版 header (2026-05-26 hotfix): 已**回退到非 sticky**.
//
// 原因: 用户实测反馈"上下滑动不顺畅, 有组件重叠":
//   - ShotStageHeader sticky top: 0 (zIndex 20, 高度 ~52px) 已占了屏幕顶部
//   - candidateHeader 也 top: 0 (zIndex 6) → 滚动时叠在 ShotStageHeader 后面
//   - 首帧 column 和视频 column 各自一个 sticky candidateHeader → 切换两列时跳跃
//   - sticky + backdrop-filter + 长滚动距离, Chrome / Safari 渲染卡顿
// 修法: 键盘 1-9 / F / V / ←→ 已能完成"选候选 + 切镜" 不需要 sticky ComposeBox 也能顺手.
// 保留导出名 candidateHeaderStickyStyle 但内容等价 candidateHeaderStyle, 避免大改 caller.
export const candidateHeaderStickyStyle: React.CSSProperties = {
  ...candidateHeaderStyle,
};
export const zoneTitleStyle: React.CSSProperties = {
  margin: 0, fontSize: 13.5, fontWeight: 750, color: "var(--ink-900)",
  display: "inline-flex", alignItems: "center", gap: 6,
};
export const candidateEmptyStyle: React.CSSProperties = {
  padding: "32px 0", textAlign: "center", fontSize: 12.5, color: "var(--ink-400)",
  border: "1px dashed var(--ink-150)", borderRadius: 10, background: "var(--ink-50)",
};

// ─── 提示词预览 details ─────────────────────────────────────
// W7-stage-reorg: 候选区 header 内嵌的提示词预览 <details>
// 2026-05-27 — 用户反馈"三个框线叠加 UI 难看", padding 收紧 + 用更柔和的米色背景
// 让 details 当唯一卡片视觉, 内部 PromptPreviewBlock 平铺 (不再二层卡).
export const inlinePreviewStyle: React.CSSProperties = {
  marginTop: 6,
  borderRadius: 10,
  border: "1px solid var(--ink-100)",
  background: "linear-gradient(180deg, var(--surface-card) 0%, rgba(252,250,247,0.5) 100%)",
  padding: "10px 14px",
  boxShadow: "0 1px 2px rgba(40,32,24,0.02)",
};
export const inlinePreviewSummaryStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
  fontSize: 12, fontWeight: 600, color: "var(--ink-700)",
  cursor: "pointer", listStyle: "none",
  userSelect: "none",
  paddingBottom: 2,
};

// W7-stage-reorg: textarea 下方 "@ 召唤" 小提示
export const mentionHintStyle: React.CSSProperties = {
  fontSize: 10, color: "var(--ink-400)", marginTop: 2, display: "inline-block",
};

// ─── 候选 Tile 覆盖按钮 (FirstFrameTile / VideoCandidateTile) ─────
export const pickStarBadge: React.CSSProperties = {
  position: "absolute", top: 6, left: 6,
  display: "inline-flex", alignItems: "center", gap: 3,
  padding: "2px 7px", borderRadius: 999,
  background: "var(--brand-600)", color: "#fff",
  fontSize: 9.5, fontWeight: 700,
  boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
};
const overlayBtnBase: React.CSSProperties = {
  height: 24, padding: "0 6px", borderRadius: 6,
  border: "none", color: "#fff",
  fontSize: 10.5, fontWeight: 600,
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3,
  cursor: "pointer",
};
export const overlayBtnPrimary: React.CSSProperties = {
  ...overlayBtnBase,
  background: "var(--brand-600, #d97757)",
};
export const overlayBtnAmber: React.CSSProperties = {
  ...overlayBtnBase,
  background: "rgba(245,158,11,0.95)",
  color: "#fff",
};
export const overlayBtnInfo: React.CSSProperties = {
  ...overlayBtnBase,
  background: "rgba(59,130,246,0.92)",
};
export const overlayBtnDanger: React.CSSProperties = {
  ...overlayBtnBase,
  background: "rgba(220,38,38,0.92)",
};
// W8-BC (2026-05-16): 局部重抽按钮 — 品牌色描边 + 深底(在黑色 hover 渐变上要够清晰)
export const overlayBtnInpaint: React.CSSProperties = {
  ...overlayBtnBase,
  background: "rgba(20,18,16,0.85)",
  border: "1px solid var(--brand-500, #d97757)",
  color: "var(--brand-300, #f1b89a)",
};
