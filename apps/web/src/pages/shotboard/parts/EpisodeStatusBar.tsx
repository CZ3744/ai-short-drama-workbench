// W10 (2026-05-26): 整集状态条 — 顶部一行显示本集进度概览.
// 2026-05-26 hotfix: 关掉 sticky — 跟 ShotboardHeader 叠加 + 滚动不顺.
//
// 内容: 共 N 镜 · X 镜已挑首帧 · Y 镜已选视频 · Z 镜失败 · 进度 P%
// 失败镜 chip 可点 → 弹出第一个失败镜的 toast 引导用户去查看 (避免全自动跳转, 铁律 #1).
// 进度计算: 已挑首帧 + 已选视频 + 失败 加权 ÷ 总镜数 (粗略反映完成度).
import { useMemo } from "react";
import { Icon, type IconName } from "../../../components/shared/Icon";
import type { Shot } from "../../../hooks/useShots";

export interface EpisodeStatusBarProps {
  shots: Shot[];
  onJumpToFailedShot?: (shotId: string) => void;
}

interface ShotStats {
  total: number;
  withFirstFrame: number;
  withVideo: number;
  failed: number;
  firstFailedShot: Shot | undefined;
  percent: number;
}

function computeStats(shots: Shot[]): ShotStats {
  const total = shots.length;
  if (total === 0) {
    return { total: 0, withFirstFrame: 0, withVideo: 0, failed: 0, firstFailedShot: undefined, percent: 0 };
  }
  let withFirstFrame = 0;
  let withVideo = 0;
  let failed = 0;
  let firstFailedShot: Shot | undefined;
  for (const s of shots) {
    if (s.picked_first_frame_id) withFirstFrame++;
    if (s.picked_video_id) withVideo++;
    // 失败判定: status 是 failed 或 last_image_error / last_video_error 标志位
    const isFailed =
      s.status === "failed" ||
      Boolean((s as { last_image_error?: string }).last_image_error) ||
      Boolean((s as { last_video_error?: string }).last_video_error);
    if (isFailed) {
      failed++;
      if (!firstFailedShot) firstFailedShot = s;
    }
  }
  // 粗略进度: 视频权重 70%, 首帧 30%, 失败不计入 (UI 里另外标红)
  const videoWeight = 0.7;
  const firstWeight = 0.3;
  const percent = Math.round(((withVideo * videoWeight + withFirstFrame * firstWeight) / total) * 100);
  return { total, withFirstFrame, withVideo, failed, firstFailedShot, percent: Math.min(100, percent) };
}

export function EpisodeStatusBar({ shots, onJumpToFailedShot }: EpisodeStatusBarProps) {
  const stats = useMemo(() => computeStats(shots), [shots]);

  if (stats.total === 0) return null;

  return (
    <div
      style={{
        // hotfix 2026-05-26 — 关 sticky (跟 ShotboardHeader 叠 + 滚动不顺), 改成普通顶部一行
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "8px 12px",
        marginBottom: 12,
        borderRadius: 10,
        background: "linear-gradient(96deg, var(--surface-card) 0%, var(--ink-25, rgba(0,0,0,0.012)) 100%)",
        border: "1px solid var(--ink-100)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        backdropFilter: "blur(6px)",
      }}
    >
      <StatChip
        icon="film"
        text={`共 ${stats.total} 镜`}
        tone="ink"
      />
      <StatChip
        icon="image"
        text={`${stats.withFirstFrame} 镜已确认首帧`}
        tone={stats.withFirstFrame === stats.total ? "ok" : "brand"}
      />
      <StatChip
        icon="video"
        text={`${stats.withVideo} 镜已选视频`}
        tone={stats.withVideo === stats.total ? "ok" : "brand"}
      />
      {stats.failed > 0 && (
        <button
          type="button"
          onClick={() => {
            if (stats.firstFailedShot && onJumpToFailedShot) onJumpToFailedShot(stats.firstFailedShot.id);
          }}
          title="点击跳到第一个失败的分镜"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "3px 9px",
            borderRadius: 999,
            fontSize: 11.5,
            fontWeight: 700,
            border: "1px solid rgba(220,38,38,0.30)",
            background: "rgba(220,38,38,0.10)",
            color: "var(--danger, #dc2626)",
            cursor: onJumpToFailedShot ? "pointer" : "default",
          }}
        >
          <Icon name="warning" size={11} />
          {stats.failed} 镜失败
        </button>
      )}
      <span style={{ flex: 1 }} />
      {/* 进度条 — 数字 + 横条, 文字主色, 条颜色按进度过渡 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 220 }}>
        <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>进度</span>
        <div
          style={{
            position: "relative",
            flex: 1,
            height: 8,
            borderRadius: 999,
            background: "var(--ink-100)",
            overflow: "hidden",
            minWidth: 100,
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              width: `${stats.percent}%`,
              background: stats.percent >= 100
                ? "linear-gradient(90deg, #10b981, #059669)"
                : stats.percent >= 50
                ? "linear-gradient(90deg, var(--brand-400), var(--brand-600))"
                : "linear-gradient(90deg, var(--brand-300), var(--brand-500))",
              transition: "width 220ms ease",
              borderRadius: 999,
            }}
          />
        </div>
        <span style={{
          fontSize: 12,
          fontWeight: 700,
          color: stats.percent >= 100 ? "var(--ok, #059669)" : "var(--ink-700)",
          minWidth: 36,
          textAlign: "right",
        }}>
          {stats.percent}%
        </span>
      </div>
    </div>
  );
}

function StatChip({ icon, text, tone }: { icon: IconName; text: string; tone: "ink" | "ok" | "brand" }) {
  const palette = {
    ink: { bg: "var(--ink-50)", border: "var(--ink-150)", color: "var(--ink-700)" },
    ok: { bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.30)", color: "var(--ok, #059669)" },
    brand: { bg: "var(--brand-50, rgba(217,119,87,0.08))", border: "var(--brand-200, rgba(217,119,87,0.30))", color: "var(--brand-700)" },
  }[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.color,
      }}
    >
      <Icon name={icon} size={11} />
      {text}
    </span>
  );
}
