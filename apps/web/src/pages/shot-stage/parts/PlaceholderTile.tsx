/**
 * PlaceholderTile — 占位骨架卡 (生成中态, 显示在右栏候选区顶部).
 *   触发: localPendingDraws / runningImageTasks / runningVideoTasks
 *   设计: 灰色背景 + 中央 spinner + "生成中 ~Xs", 绝不暴露 task_id / provider id 等技术字段
 *
 * 2026-05-27 — 删 "预计 X 秒" 假 eta (用户原话"预计多少秒是怎么算的", 不信任).
 * 之前的 etaText 来自 useVideoGeneration 公式 max(60, duration*8+30) = 拍脑袋,
 * 跟实际 provider (智谱 ~2-3 分钟 / 即梦 ~70 秒 / 阿里 ~2-3 分钟 / 可灵 ~5-8 分钟)
 * 差 2-5 倍. 改成显示真实"已等 N 秒" + provider 经验区间提示, 不撒谎.
 *
 * 2026-05-28 深度打磨 #1 — 视频等待期"消失感" 改善:
 *   - 加进度条 (基于经验区间 0..100%) — 不是真进度, 是"用户期望进度". 超过经验上限走 95% 抑制.
 *     视觉前进感比"秒数干等"好得多 (跟竞品 Runway / Pika 一致).
 *   - 加"可同时做" 提示 — 等 30s+ 显示"等待期不必干等, 可以去:" 一句话引导, 用户从"焦虑等待"
 *     变"主动安排". 不放具体 link (那需要拿 slug/epId, 不属于这个组件职责), 让用户决策.
 */
import { useEffect, useState } from "react";
import { Icon } from "../../../components/shared/Icon";

/** 各 provider 的真实生成耗时经验值 (秒), 用于显示"通常 X-Y 秒" */
const PROVIDER_TYPICAL_S: Record<string, [number, number]> = {
  // 视频
  zhipu_cogvideox: [120, 180],
  minimax_hailuo: [60, 90],
  jimeng_video_3pro: [60, 100],
  aliyun_wan_t2v: [90, 150],
  aliyun_wan_i2v: [120, 200],
  kling_3: [240, 480],
  vidu_q3_ref: [60, 120],
  baidu_qianfan_video: [120, 180],
  tencent_hunyuan_video: [120, 240],
  local_mock_video: [3, 8],
  local_animatediff: [60, 180],
  // 图像
  chatgpt_codex_image: [30, 90],
  openrouter_gemini_image: [10, 30],
  local_sdxl_openclaw: [15, 45],
  local_card_image: [1, 3],
};

function pickTypicalLabel(providerId?: string, kind?: "image" | "video"): string | undefined {
  if (providerId) {
    const range = PROVIDER_TYPICAL_S[providerId];
    if (range) return `通常 ${range[0]}-${range[1]} 秒`;
  }
  // 兜底按 kind 给宽区间
  if (kind === "video") return "通常 1-3 分钟";
  if (kind === "image") return "通常 10-60 秒";
  return undefined;
}

export function PlaceholderTile({
  label, kind = "image", aspectRatio, startedAt, providerId,
}: {
  label?: string;
  kind?: "image" | "video";
  /** 2026-05-22: 跟剧本身 aspect 一致, 不传则按老 kind fallback (image=1/1, video=16/9) */
  aspectRatio?: string;
  /** 2026-05-27 — task.started_at (ms), 用于显示"已等 N 秒" */
  startedAt?: number;
  /** 2026-05-27 — provider id, 用于显示"通常 X-Y 秒"经验区间. 没传按 kind 兜底 */
  providerId?: string;
}) {
  const finalAspect = aspectRatio ?? (kind === "video" ? "16/9" : "1/1");

  // 已等秒数 — 每秒 tick, started_at 缺时不显示
  const [elapsedSec, setElapsedSec] = useState<number | null>(() =>
    startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null,
  );
  useEffect(() => {
    if (!startedAt) {
      setElapsedSec(null);
      return;
    }
    const tick = () => setElapsedSec(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const typicalLabel = pickTypicalLabel(providerId, kind);
  const elapsedLabel = elapsedSec != null ? `已等 ${elapsedSec} 秒` : undefined;
  // 文案策略: 有 elapsedSec 时显"已等 N 秒 · 通常 X-Y 秒", 没 startedAt 只显经验区间.
  const subLabel = elapsedLabel
    ? typicalLabel ? `${elapsedLabel} · ${typicalLabel}` : elapsedLabel
    : typicalLabel;

  // 2026-05-28 深度打磨 #1: 基于经验区间算"期望进度" 百分比.
  //   - elapsed < typical_low: 0..50% 线性 (前半段)
  //   - typical_low <= elapsed < typical_high: 50..90% 线性 (后半段)
  //   - elapsed >= typical_high: 抑制在 95% (永不到 100%, 真完成才到 100%, 不撒谎)
  //   - 没 typical 区间 (provider 不在表 + 没 startedAt) → 不显进度条
  const typicalRange = providerId ? PROVIDER_TYPICAL_S[providerId]
    : kind === "video" ? [60, 180] : kind === "image" ? [10, 60] : null;
  const expectedPct = (() => {
    if (elapsedSec == null || !typicalRange) return null;
    const [low, high] = typicalRange;
    if (elapsedSec < low) {
      // 0..50% 在前半段平滑
      return Math.min(50, (elapsedSec / low) * 50);
    }
    if (elapsedSec < high) {
      // 50..90% 在后半段平滑
      return 50 + ((elapsedSec - low) / (high - low)) * 40;
    }
    // 超时区间: 抑制在 95%, 不到 100% (真完成才 100%)
    return 95;
  })();

  // 等待 30+ 秒后显示"可同时做"提示, 减焦虑感
  const showRecoverHint = elapsedSec != null && elapsedSec >= 30;

  return (
    <div
      style={{
        borderRadius: 7,
        border: "1px solid var(--ink-100)",
        padding: 6,
        background: "var(--surface-card)",
        position: "relative",
      }}
      title={label || "正在生成,生成完成后会自动显示"}
    >
      <div style={{
        position: "relative",
        aspectRatio: finalAspect,
        borderRadius: 5, overflow: "hidden",
        background: "var(--ink-50)",
        display: "grid", placeItems: "center",
        animation: "mk-pulse 1.8s ease-in-out infinite",
      }}>
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
          color: "var(--ink-500)",
          padding: "0 12px",
          width: "100%",
        }}>
          <Icon name="sparkles" size={22} className="mk-spin" style={{ color: "var(--brand-500)" }} />
          <span style={{ fontSize: 11.5, fontWeight: 700 }}>
            {label || (kind === "video" ? "视频生成中" : "首帧生成中")}
          </span>
          {subLabel && (
            <span style={{ fontSize: 10.5, color: "var(--ink-400)", textAlign: "center", lineHeight: 1.5 }}>
              {subLabel}
            </span>
          )}
          {/* 2026-05-28 深度打磨 #1: 期望进度条 — 永不到 100% (真完成才 100%) */}
          {expectedPct != null && (
            <div style={{ width: "75%", maxWidth: 160, marginTop: 4 }}>
              <div style={{
                height: 4,
                background: "rgba(40,32,24,0.08)",
                borderRadius: 3,
                overflow: "hidden",
              }}>
                <div style={{
                  height: "100%",
                  width: `${expectedPct.toFixed(1)}%`,
                  background: expectedPct >= 90
                    ? "linear-gradient(90deg, var(--brand-500), #f59e0b)"
                    : "var(--brand-500)",
                  borderRadius: 3,
                  transition: "width 1s linear",
                }} />
              </div>
              <div style={{
                fontSize: 9.5, color: "var(--ink-400)",
                textAlign: "center", marginTop: 2,
              }}>
                {expectedPct >= 90 ? "比通常慢一些, 仍在等待..." : `期望进度 ~${expectedPct.toFixed(0)}%`}
              </div>
            </div>
          )}
        </div>
      </div>
      <div style={{
        fontSize: 10.5, color: "var(--ink-400)",
        marginTop: 5, textAlign: "center",
      }}>
        {showRecoverHint ? "等待期可以切到其他镜继续 · 不必刷新" : "请稍候 · 不必刷新"}
      </div>
    </div>
  );
}
