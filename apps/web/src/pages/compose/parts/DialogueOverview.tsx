/**
 * DialogueOverview — 合成完成后的台词速览 (2026-05-28 深度打磨 #3).
 *
 * 用户痛点: 合成完一集, 想快速核对"我的台词都对了吗? 哪一镜的对白说得清楚?".
 * 之前 ComposePage 只显视频 + canvas markers, 用户必须从头看到尾才能听全台词.
 * 行业标准 (剪映 / CapCut / 智影): 视频旁边一列时间戳 + 台词文本, 点台词跳到那段.
 *
 * 设计:
 *   - 一行一镜 — 显示 S01 0:00-0:05 · 林夕: "雨夜便利店, 我等你三天了"
 *   - 点击一行 → 触发外部 onJumpTo(sec) → FinalPreviewPlayer seek + autoplay 该段
 *   - 没台词的镜显示 "(本镜无对白 / 旁白)" 灰色占位, 不空白
 *   - chip 数量过多时 (>8 镜) 限高 + 内部 scroll
 *   - 紧凑视觉, 不占太大空间
 */
import { useMemo } from "react";
import { Icon } from "../../../components/shared/Icon";
import type { Shot } from "../../../hooks/useShots";
import type { ShotSegment } from "./FinalPreviewPlayer";

export interface DialogueOverviewProps {
  shots: Shot[];
  segments: ShotSegment[];
  /** 点击行触发跳转 — ComposePage 把这个 hook 进 player 的 seekTo */
  onJumpTo: (sec: number) => void;
  /**
   * 2026-05-29 P0-2: true 表示时间码是 shot.duration_sec 估算值 (后端 ffprobe 真长还没拿到).
   * 标注"(估算)"提示用户这跟成片真实时间可能差几秒, 不假装精确 (用户铁律: 不撒谎).
   */
  estimatedTimings?: boolean;
}

function formatSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** 角色名找寻 — 优先 dialogue 段的 character_names 第一个, 没有就显空 */
function pickSpeaker(shot: Shot): string | null {
  const names = shot.character_names;
  if (names && names.length > 0 && names[0]?.trim()) return names[0].trim();
  return null;
}

export function DialogueOverview({
  shots,
  segments,
  onJumpTo,
  estimatedTimings = false,
}: DialogueOverviewProps) {
  // 把 shots 跟 segments 配对 — 用 shotId 匹配 (segments 由 ComposePage readiness.map 构造,
  // 顺序跟 shots 一致). 防御性写: 找不到 segment 就用 shot.duration_sec 算 fallback.
  const rows = useMemo(() => {
    let cursor = 0;
    return shots.map((shot) => {
      const seg = segments.find((s) => s.shotId === shot.id);
      const startSec = seg?.startSec ?? cursor;
      const endSec = seg?.endSec ?? (cursor + (shot.duration_sec || 5));
      cursor = endSec;
      const dialogue = shot.dialogue?.trim() || "";
      const voiceover = shot.voiceover?.trim() || "";
      const speaker = pickSpeaker(shot);
      const friendlyLabel = shot.title?.trim() || `第 ${shot.index} 镜`;
      return {
        shotId: shot.id,
        label: friendlyLabel,
        startSec,
        endSec,
        dialogue,
        voiceover,
        speaker,
        text: dialogue || voiceover || "",
        textKind: dialogue ? ("dialogue" as const)
          : voiceover ? ("voiceover" as const)
          : ("empty" as const),
      };
    });
  }, [shots, segments]);

  if (rows.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 14,
        padding: "12px 14px",
        background: "var(--surface-card, #fff)",
        border: "1px solid var(--ink-150, #e7e5e2)",
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 10,
          fontSize: 12.5,
          fontWeight: 700,
          color: "var(--ink-900)",
        }}
      >
        <Icon name="message" size={13} style={{ color: "var(--brand-700)" }} />
        台词速览
        <span style={{ fontSize: 10.5, fontWeight: 400, color: "var(--ink-400)", marginLeft: 4 }}>
          (点一行跳到该段并播放, 核对台词是否准确)
        </span>
        {estimatedTimings && (
          <span
            style={{ fontSize: 10, fontWeight: 600, color: "#c2410c", marginLeft: 6, padding: "1px 6px", borderRadius: 999, background: "#fff7ed", border: "1px solid #fed7aa" }}
            title="时间码按每镜设定时长估算, 跟成片真实时间可能差几秒"
          >
            时间为估算
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          maxHeight: rows.length > 8 ? 360 : undefined,
          overflowY: rows.length > 8 ? "auto" : undefined,
          paddingRight: rows.length > 8 ? 4 : 0,
        }}
      >
        {rows.map((row) => {
          const emptyText = row.textKind === "empty";
          return (
            <button
              key={row.shotId}
              type="button"
              onClick={() => onJumpTo(row.startSec)}
              title={`跳到 ${row.label} 并播放 (${formatSec(row.startSec)}-${formatSec(row.endSec)})`}
              style={{
                display: "grid",
                gridTemplateColumns: "auto auto 1fr",
                alignItems: "baseline",
                gap: 10,
                padding: "7px 10px",
                background: "transparent",
                border: "1px solid transparent",
                borderRadius: 7,
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "inherit",
                color: "inherit",
                transition: "background 0.12s, border-color 0.12s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--ink-50)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
            >
              {/* 镜头号 + 时间码 — monospace 等宽对齐 */}
              <span
                style={{
                  fontFamily: "ui-monospace, Consolas, monospace",
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: "var(--brand-600)",
                  letterSpacing: "0.02em",
                  whiteSpace: "nowrap",
                }}
              >
                {row.label}
              </span>
              <span
                style={{
                  fontFamily: "ui-monospace, Consolas, monospace",
                  fontSize: 10,
                  color: "var(--ink-400)",
                  whiteSpace: "nowrap",
                }}
              >
                {formatSec(row.startSec)}–{formatSec(row.endSec)}
              </span>
              {/* 台词内容 — 单行截断, 不强占空间 */}
              <span
                style={{
                  fontSize: 12.5,
                  color: emptyText ? "var(--ink-400)" : "var(--ink-800)",
                  fontStyle: emptyText ? "italic" : "normal",
                  lineHeight: 1.4,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.textKind === "dialogue" && row.speaker && (
                  <span style={{ color: "var(--brand-700)", fontWeight: 600, marginRight: 6 }}>
                    {row.speaker}:
                  </span>
                )}
                {row.textKind === "voiceover" && (
                  <span style={{ color: "var(--ink-500)", fontWeight: 600, marginRight: 6, fontSize: 10.5 }}>
                    旁白:
                  </span>
                )}
                {row.text || "(本镜无对白 / 旁白)"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default DialogueOverview;
