/**
 * CandidateLabel — W11 A4 (2026-05-27): 候选图名字单一真理源.
 *
 * 用户原话铁律 #2 (display_name 跨页面统一):
 *   "任何渲染图缩略图位置必须用 image.display_name + 接 InlineLabel inline 编辑,
 *    fallback 顺序 display_name || provider 角度 || '第 N 张', 禁止'第 N 张'当主标签".
 *
 * 整合的 5 处:
 *   - FirstFrameTile.tsx (首帧候选卡)
 *   - VideoCandidateTile.tsx (视频候选卡)
 *   - VideoColumn 视频历史条带
 *   - RejectPoolStrip 废案库卡
 *   - lightbox metadata provider 字段
 *
 * Fallback 顺序: display_name > provider 标签 (经 labelOfSource 翻译) > "第 N 张" 兜底.
 *
 * 注意: 这只是只读展示组件. 需要 inline 编辑请直接用 components/shot-stage/InlineLabel.tsx.
 */
import type { ReactNode, CSSProperties } from "react";
import { labelOfSource, hasSourceLabel } from "../../lib/sourceLabels";
import { formatBeijingTime } from "../../lib/format";
import type { ShotCandidate } from "../../lib/shotApi";

export interface CandidateLabelProps {
  candidate: Pick<ShotCandidate, "display_name" | "provider"> & {
    origin?: unknown;
  };
  /** 兜底序号 1-based, 用于 "第 N 张" fallback */
  fallbackIndex?: number;
  /** 用于复用在 lightbox metadata 这种"只要返回字符串"的场景, 不渲染 JSX 直接返回 */
  asString?: boolean;
  /** CSS class (可选) */
  className?: string;
  style?: CSSProperties;
}

/** 纯计算函数 — 供 lightbox metadata / 复制 ChatGPT 标签等不渲染 JSX 的场景调用 */
export function candidateDisplayLabel(
  candidate: Pick<ShotCandidate, "display_name" | "provider"> & { origin?: unknown },
  fallbackIndex?: number,
): string {
  const name = candidate.display_name?.trim();
  if (name) return name;
  const origin = (candidate as { origin?: string }).origin;
  if (hasSourceLabel(origin)) return labelOfSource(origin);
  if (candidate.provider) return labelOfSource(candidate.provider);
  if (typeof fallbackIndex === "number") return `第 ${fallbackIndex} 张`;
  return "—";
}

/**
 * 2026-05-27 — 候选自动标签, 带序号 + 时间:
 *   - display_name 用户改过 → 直接用 (尊重用户)
 *   - 否则: "智谱 CogVideoX · #2 · 14:47" (provider + 序号 + 时间)
 *
 * 用户原话: "为素材的命名体现顺序... 不要只写生成来源的模型名字, 多了之后就乱了不好记".
 * 序号是这一镜内的 1-based 排名 (按创建时间正序), 时间是北京时间 HH:MM.
 */
export function candidateRichLabel(
  candidate: Pick<ShotCandidate, "display_name" | "provider"> & {
    origin?: unknown;
    created_at?: string;
  },
  opts?: { index?: number; total?: number },
): string {
  const userName = candidate.display_name?.trim();
  if (userName) return userName;
  const origin = (candidate as { origin?: string }).origin;
  const providerLabel = hasSourceLabel(origin)
    ? labelOfSource(origin)
    : candidate.provider ? labelOfSource(candidate.provider) : "";
  const indexPart =
    typeof opts?.index === "number"
      ? typeof opts.total === "number"
        ? `#${opts.index}/${opts.total}`
        : `#${opts.index}`
      : "";
  let timePart = "";
  if (candidate.created_at) {
    try {
      const fmt = formatBeijingTime(candidate.created_at, { mode: "short" });
      // "短" 模式格式 "MM-DD HH:MM", 只取 HH:MM 部分
      const m = fmt.match(/(\d{2}:\d{2})/);
      timePart = m ? m[1] : fmt;
    } catch { /* noop */ }
  }
  const parts = [providerLabel, indexPart, timePart].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export function CandidateLabel({
  candidate, fallbackIndex, asString, className, style,
}: CandidateLabelProps): ReactNode {
  const label = candidateDisplayLabel(candidate, fallbackIndex);
  if (asString) return label;
  return (
    <span
      className={className}
      style={{ fontWeight: 600, color: "var(--ink-700)", ...style }}
      title={label}
    >
      {label}
    </span>
  );
}
