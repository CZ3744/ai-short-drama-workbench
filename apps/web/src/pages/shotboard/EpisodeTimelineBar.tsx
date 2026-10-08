/**
 * EpisodeTimelineBar — 本集节奏可视化时间轴 (2026-05-27)
 *
 * 用户原话: "还有什么痛点, 之前都让你想过, 你糊弄我". 之前没系统给用户全局节奏视野.
 * 现在加这个: 一条横向时间条, 每镜按 duration_sec 占比例, 颜色按 mood / shot_type
 * 分类, hover 显示该镜简述 + 时长, 点击跳到该镜.
 *
 * 给用户一眼看出:
 *   - 本集总时长 (60s / 90s / 180s)
 *   - 哪几镜最长 / 最短 (节奏不均的位置)
 *   - 情绪分布 (开场冷淡 / 中段过紧 / 末段松散)
 *   - 钩子开场 (前 3 秒) 是否到位
 */
import { useMemo } from "react";
import type { useNavigate } from "react-router-dom";
import type { Shot } from "../../hooks/useShots";
import { Icon } from "../../components/shared/Icon";

interface EpisodeTimelineBarProps {
  shots: Shot[];
  slug: string;
  selectedEpId: string;
  navigate: ReturnType<typeof useNavigate>;
}

/** 按情绪/节奏给一段颜色 — 不靠 mood 字段时按 shot_index 推断段位 (开/中/末段) */
function colorForShot(shot: Shot, index: number, total: number): string {
  const mood = (shot.mood ?? "").trim();
  // 优先按 mood 上色 (符合用户对情绪曲线的直觉)
  if (mood) {
    if (/紧张|愤怒|战斗|追逐|爆裂/i.test(mood)) return "#dc2626"; // 红 — 高强度
    if (/伤心|失落|压抑|绝望/i.test(mood)) return "#475569"; // 灰蓝 — 低落
    if (/兴奋|欢快|喜悦/i.test(mood)) return "#f59e0b"; // 橙 — 明快
    if (/浪漫|温柔|温情/i.test(mood)) return "#ec4899"; // 粉 — 柔
    if (/幽默|轻松|讽刺/i.test(mood)) return "#10b981"; // 绿 — 轻
    if (/恐惧|惊悚|诡异/i.test(mood)) return "#7c3aed"; // 紫 — 异
  }
  // fallback 按位置分段: 开场暖 / 中段冷 / 末段渐变 — 提供"位置感"
  const phase = index / Math.max(1, total - 1); // 0..1
  if (phase < 0.15) return "rgba(217,119,87,0.85)"; // 开场橙
  if (phase < 0.7) return "rgba(100,116,139,0.65)"; // 中段灰蓝
  return "rgba(217,119,87,0.65)"; // 末段橙
}

export function EpisodeTimelineBar({
  shots, slug, selectedEpId, navigate,
}: EpisodeTimelineBarProps) {
  const stats = useMemo(() => {
    const durations = shots.map((s) => s.duration_sec || 5);
    const total = durations.reduce((a, b) => a + b, 0);
    const avg = shots.length > 0 ? total / shots.length : 0;
    const max = Math.max(...durations, 0);
    const min = durations.length > 0 ? Math.min(...durations) : 0;
    return { total, avg, max, min, count: shots.length };
  }, [shots]);

  if (shots.length === 0) return null;

  return (
    <div
      style={{
        margin: "10px 0 14px",
        padding: "10px 14px",
        borderRadius: 10,
        border: "1px solid var(--ink-100)",
        background: "linear-gradient(180deg, var(--surface-card) 0%, rgba(252,250,247,0.4) 100%)",
        boxShadow: "0 1px 2px rgba(40,32,24,0.02)",
      }}
    >
      {/* 顶部 meta — 总时长 + 镜数 + 平均 + 极值 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          fontSize: 10.5,
          color: "var(--ink-500)",
          marginBottom: 8,
        }}
      >
        <Icon name="clock" size={11} style={{ color: "var(--brand-600)" }} />
        <span style={{ fontWeight: 700, color: "var(--ink-800)" }}>本集节奏</span>
        <span>总时长 <strong style={{ color: "var(--ink-900)" }}>{stats.total.toFixed(0)}s</strong></span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{stats.count} 镜</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>平均 {stats.avg.toFixed(1)}s</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>最长 {stats.max}s / 最短 {stats.min}s</span>
        {/* 钩子提醒: 第一镜 > 5s 不算钩子 */}
        {shots[0] && (shots[0].duration_sec || 5) > 5 && (
          <span
            className="mk-chip"
            style={{
              height: 18, fontSize: 10, padding: "0 6px",
              background: "rgba(245,158,11,0.1)",
              color: "var(--brand-700)",
              border: "1px solid rgba(245,158,11,0.3)",
            }}
            title="第一镜超过 5 秒, 短视频前 3 秒不抓人就会被划走. 考虑用更短的钩子镜开场."
          >
            ⚠ 钩子偏长
          </span>
        )}
      </div>

      {/* 时间轴本体 — 横向 flex 按 duration 占宽 */}
      <div
        style={{
          display: "flex",
          height: 28,
          borderRadius: 6,
          overflow: "hidden",
          border: "1px solid var(--ink-100)",
          background: "var(--ink-50)",
        }}
      >
        {shots.map((shot, idx) => {
          const d = shot.duration_sec || 5;
          const pct = (d / Math.max(1, stats.total)) * 100;
          const color = colorForShot(shot, idx, shots.length);
          const moodLabel = (shot.mood ?? "").trim();
          const actionPreview = (shot.action ?? shot.title ?? "").slice(0, 40);
          const title = `第 ${shot.index ?? idx + 1} 镜 · ${d}s${moodLabel ? ` · ${moodLabel}` : ""}\n${actionPreview || "(无描述)"}`;
          return (
            <button
              key={shot.id}
              type="button"
              onClick={() => navigate(`/studio/${slug}/shot-stage/${selectedEpId}/${shot.id}`)}
              title={title}
              style={{
                flex: `${pct} 0 0`,
                minWidth: 16,
                background: color,
                border: "none",
                borderRight: idx < shots.length - 1 ? "1px solid rgba(255,255,255,0.4)" : "none",
                color: "#fff",
                fontSize: 9.5,
                fontWeight: 700,
                cursor: "pointer",
                padding: 0,
                position: "relative",
                transition: "filter 120ms",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.15)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
            >
              {/* 段宽大于 4% 才显示镜号, 否则只看颜色 */}
              {pct > 4 ? (shot.index ?? idx + 1) : ""}
            </button>
          );
        })}
      </div>

      {/* 底部图例 — 颜色含义 */}
      <div
        style={{
          marginTop: 6,
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          fontSize: 10,
          color: "var(--ink-400)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#dc2626" }} />
          紧张/动作
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#7c3aed" }} />
          惊悚
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#475569" }} />
          压抑/伤心
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#f59e0b" }} />
          欢快
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#ec4899" }} />
          浪漫
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#10b981" }} />
          轻松/幽默
        </span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>没标 mood 走"开场橙 / 中段灰 / 末段橙" 默认色</span>
        <span style={{ marginLeft: "auto", color: "var(--brand-700)" }}>点击段块跳到该镜</span>
      </div>
    </div>
  );
}
