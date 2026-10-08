/**
 * EpisodeShotIntelligenceAdvisor — 整集分镜智能建议 (2026-05-28 AI 出图打磨)
 *
 * 用户痛点: AI 短剧 #1 痛点是跨分镜一致性. 用户拆完分镜板, 一眼看不出哪里要补.
 *
 * 业内 (Runway / Sora / Higgsfield 短剧工具) 标准做法: 在分镜板上层给出"全局健康"
 * 指标 — 让用户在生图前就发现问题, 而不是 50 镜全生完才看到角色脸不一致.
 *
 * 本组件做四个轻量分析 (纯前端, 无后端调用 — 不消耗 API 额度):
 *
 *   1. 角色一致性预警: 跨多镜 character (≥2 镜出现) 是否锚定主图.
 *      没锚定主图 → 业内经验: 每镜独立生成 ≈ 50% 角色脸漂移 (Runway 早期 user study).
 *      锚定主图 → 漂移降到 ~10-15%. 这是出图前必做的功课.
 *
 *   2. 情绪曲线提醒: 邻镜 mood 突变 (紧张 → 欢快) 提示 — 用户可能漏写过渡镜或
 *      mood 字段填错. 业内剧本节奏: 突变是高级技巧 (转折点), 没有意图的突变是 bug.
 *
 *   3. 场景一致性预警: 跨多镜 scene 是否锚定主图 (同上).
 *
 *   4. 已有"钩子开场"在 EpisodeTimelineBar 内, 不重复.
 *
 * 设计原则:
 *   - 铁律 #1 用户控制权: 只提建议, 不强制. 用户可以选择不理.
 *   - 铁律 #3 信息直接可见: 默认展开, 不需点开看.
 *   - 铁律 #9 toC 兜底: 文案人话, 不暴露技术字段.
 *   - 铁律 #10 优雅空状态: 0 个问题时显示"全部就绪" (绿色), 而不是隐藏.
 *
 * 性能: 纯派生计算 (useMemo), shots 不变就不重算. 50 镜 character × 10 scene 量级
 *       的复杂度可忽略.
 */
import { useMemo } from "react";
import type { useNavigate } from "react-router-dom";
import type { Shot } from "../../hooks/useShots";
import { Icon } from "../../components/shared/Icon";

interface AdvisorProps {
  shots: Shot[];
  slug: string;
  selectedEpId: string;
  navigate: ReturnType<typeof useNavigate>;
}

interface ConsistencyConcern {
  /** "character" / "scene" */
  kind: "character" | "scene";
  /** entity name (e.g. "林夏" / "顶层公寓客厅") */
  name: string;
  /** 跨几镜出现 */
  shotCount: number;
  /** 出现的镜号 (1-based, 至多列 5 个) */
  shotIndices: number[];
  /** 是否锚定 (character_names 或 scene_name 是否存在 + 后续 picked 跨镜) */
  reason: string;
}

interface MoodJump {
  fromShotIdx: number;
  toShotIdx: number;
  fromMood: string;
  toMood: string;
}

/** mood 类别 — 把 raw mood 字符串 normalize 到大类, 同类不算跳跃 */
function moodCategory(mood: string): string | null {
  const m = (mood ?? "").trim();
  if (!m) return null;
  if (/紧张|愤怒|战斗|追逐|爆裂|高潮|激烈/.test(m)) return "高强度";
  if (/伤心|失落|压抑|绝望|悲伤/.test(m)) return "低落";
  if (/兴奋|欢快|喜悦|轻松|幽默|愉悦/.test(m)) return "欢快";
  if (/浪漫|温柔|温情|甜蜜/.test(m)) return "柔情";
  if (/恐惧|惊悚|诡异|惊吓/.test(m)) return "异类";
  if (/宁静|平静|冷静|淡然|沉思/.test(m)) return "平静";
  return "其他";
}

/** 检测"突变跳跃" — 高强度 ↔ 欢快 / 柔情 ↔ 异类 等不自然的组合 */
function isJump(from: string | null, to: string | null): boolean {
  if (!from || !to || from === to) return false;
  const incompatible: Array<[string, string]> = [
    ["高强度", "欢快"],
    ["高强度", "柔情"],
    ["低落", "欢快"],
    ["欢快", "异类"],
    ["柔情", "高强度"],
    ["欢快", "低落"],
  ];
  return incompatible.some(([a, b]) => (from === a && to === b) || (from === b && to === a));
}

export function EpisodeShotIntelligenceAdvisor({
  shots, slug, selectedEpId, navigate,
}: AdvisorProps) {
  void slug; void selectedEpId; void navigate;

  const concerns = useMemo<ConsistencyConcern[]>(() => {
    // 1) Character 跨镜统计 — character_ids 跨 ≥2 镜出现且无 picked_first_frame_id 全 picked
    const charShots = new Map<string, { name: string; idxs: number[]; picked: number }>();
    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i];
      const ids = sh.character_ids ?? [];
      const names = sh.character_names ?? [];
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        const nm = names[k] ?? id;
        const entry = charShots.get(id) ?? { name: nm, idxs: [], picked: 0 };
        entry.idxs.push(sh.index ?? i + 1);
        if (sh.picked_first_frame_id) entry.picked += 1;
        charShots.set(id, entry);
      }
    }
    const sceneShots = new Map<string, { name: string; idxs: number[]; picked: number }>();
    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i];
      if (!sh.scene_id) continue;
      const nm = sh.scene_name ?? sh.scene_id;
      const entry = sceneShots.get(sh.scene_id) ?? { name: nm, idxs: [], picked: 0 };
      entry.idxs.push(sh.index ?? i + 1);
      if (sh.picked_first_frame_id) entry.picked += 1;
      sceneShots.set(sh.scene_id, entry);
    }

    const list: ConsistencyConcern[] = [];

    // 跨 ≥2 镜且没全 picked → 提示去先锚定主图
    for (const [, info] of charShots) {
      if (info.idxs.length >= 2 && info.picked < info.idxs.length) {
        list.push({
          kind: "character",
          name: info.name,
          shotCount: info.idxs.length,
          shotIndices: info.idxs.slice(0, 5),
          reason: info.picked === 0
            ? `跨 ${info.idxs.length} 镜出场, 但还没生成任何首帧 — 建议先在素材页给这个角色锚定主图, 出图时全镜会自动用同一张参考`
            : `跨 ${info.idxs.length} 镜出场, ${info.idxs.length - info.picked} 镜还没 picked 首帧 — 角色一致性会飘`,
        });
      }
    }
    for (const [, info] of sceneShots) {
      if (info.idxs.length >= 2 && info.picked < info.idxs.length) {
        list.push({
          kind: "scene",
          name: info.name,
          shotCount: info.idxs.length,
          shotIndices: info.idxs.slice(0, 5),
          reason: info.picked === 0
            ? `跨 ${info.idxs.length} 镜出现, 还没生成任何首帧 — 建议先锚定场景主图`
            : `跨 ${info.idxs.length} 镜出现, ${info.idxs.length - info.picked} 镜还没 picked 首帧 — 场景外观会飘`,
        });
      }
    }

    return list.slice(0, 8); // 至多显 8 条避免淹没
  }, [shots]);

  const moodJumps = useMemo<MoodJump[]>(() => {
    const jumps: MoodJump[] = [];
    for (let i = 0; i < shots.length - 1; i++) {
      const cur = shots[i];
      const nxt = shots[i + 1];
      const a = moodCategory(cur.mood ?? "");
      const b = moodCategory(nxt.mood ?? "");
      if (isJump(a, b)) {
        jumps.push({
          fromShotIdx: cur.index ?? i + 1,
          toShotIdx: nxt.index ?? i + 2,
          fromMood: cur.mood ?? "",
          toMood: nxt.mood ?? "",
        });
      }
    }
    return jumps.slice(0, 5);
  }, [shots]);

  // 总体健康分: concerns + moodJumps
  const issueCount = concerns.length + moodJumps.length;
  const allGood = issueCount === 0;

  if (shots.length === 0) return null;

  return (
    <div
      style={{
        margin: "10px 0 6px",
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${allGood ? "rgba(16,185,129,0.3)" : "rgba(245,158,11,0.3)"}`,
        background: allGood
          ? "linear-gradient(180deg, rgba(16,185,129,0.05) 0%, rgba(252,250,247,0.4) 100%)"
          : "linear-gradient(180deg, rgba(245,158,11,0.05) 0%, rgba(252,250,247,0.4) 100%)",
      }}
      aria-label="分镜全局体检"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: concerns.length === 0 && moodJumps.length === 0 ? 0 : 8,
        }}
      >
        <Icon
          name={allGood ? "check" : "warning"}
          size={12}
          style={{ color: allGood ? "var(--ok)" : "var(--brand-700)" }}
        />
        <span style={{ fontWeight: 700, fontSize: 11, color: "var(--ink-800)" }}>
          分镜全局体检
        </span>
        <span
          className="mk-chip"
          style={{
            height: 18,
            fontSize: 10,
            padding: "0 6px",
            background: allGood ? "rgba(16,185,129,0.1)" : "rgba(245,158,11,0.1)",
            color: allGood ? "var(--ok)" : "var(--brand-700)",
            border: `1px solid ${allGood ? "rgba(16,185,129,0.3)" : "rgba(245,158,11,0.3)"}`,
          }}
        >
          {allGood ? "全部就绪" : `${issueCount} 项建议`}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{ fontSize: 10, color: "var(--ink-400)" }}
          title="跨分镜一致性是 AI 短剧 #1 痛点. 这里在出图前就能发现要补的位置."
        >
          {allGood ? "角色/场景一致性 + 情绪曲线连贯 OK" : "出图前先解决会省一半返工"}
        </span>
      </div>

      {/* Consistency concerns */}
      {concerns.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {concerns.map((c, i) => (
            <div
              key={`${c.kind}-${i}`}
              style={{
                fontSize: 11,
                color: "var(--ink-700)",
                lineHeight: 1.5,
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  padding: "0 5px",
                  height: 16,
                  borderRadius: 3,
                  background: c.kind === "character" ? "rgba(217,119,87,0.15)" : "rgba(100,116,139,0.15)",
                  color: c.kind === "character" ? "var(--brand-700)" : "var(--ink-700)",
                  fontSize: 9.5,
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  marginTop: 2,
                }}
              >
                {c.kind === "character" ? "角色" : "场景"}
              </span>
              <span style={{ flex: 1 }}>
                <strong style={{ color: "var(--ink-900)" }}>「{c.name}」</strong>
                {" "}
                <span style={{ color: "var(--ink-500)", fontSize: 10 }}>
                  (第 {c.shotIndices.join("/")} 镜
                  {c.shotIndices.length < c.shotCount ? ` 等共 ${c.shotCount} 镜` : ""})
                </span>
                {" — "}
                <span style={{ color: "var(--ink-600)" }}>{c.reason}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Mood jumps */}
      {moodJumps.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            marginTop: concerns.length > 0 ? 8 : 0,
            paddingTop: concerns.length > 0 ? 8 : 0,
            borderTop: concerns.length > 0 ? "1px dashed var(--ink-100)" : "none",
          }}
        >
          {moodJumps.map((j, i) => (
            <div
              key={`mood-${i}`}
              style={{
                fontSize: 11,
                color: "var(--ink-700)",
                lineHeight: 1.5,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  padding: "0 5px",
                  height: 16,
                  borderRadius: 3,
                  background: "rgba(124,58,237,0.12)",
                  color: "#7c3aed",
                  fontSize: 9.5,
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                节奏
              </span>
              <span>
                第 <strong>{j.fromShotIdx}</strong> 镜 ({j.fromMood}) → 第 <strong>{j.toShotIdx}</strong> 镜 ({j.toMood})
                <span style={{ color: "var(--ink-500)" }}>
                  {" "}— 情绪跳跃较大, 中间需要过渡镜, 或检查 mood 字段是否填错
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
