// P1 #17 (2026-05-21): 顶部 sticky header — 从 ShotStagePage 拆出.
// 纯展示组件: 所有 state / handler 通过 props 传入. hook 与业务逻辑留在主页面.
//
// W10 (2026-05-26):
//   - 删顶栏 "一键 CTA" 主按钮 (跟下方 ComposeBox 重复, 用户原话铁律 #4 就近决策)
//   - 顶栏保留次级 "前往合成" — 选完视频再出现 (没 picked_video 时藏起来, 不占位)
//   - 前/后镜按钮 title 加快捷键提示 "← / J" "→ / K"
import { Icon } from "../../../components/shared/Icon";
import { Button } from "../../../components/ui/button";
import type { Shot } from "../../../hooks/useShots";
import { labelEpisodeId } from "../../../lib/sourceLabels";

type StatusBadge = { text: string; tone: "ok" | "warn" | "ink" };

export interface ShotStageHeaderProps {
  // 基本 meta
  slug: string;
  epId: string;
  /**
   * 2026-07-09 audit(text-global finding P3 · ShotStageHeader): 父组件若已拿到真实
   * episode.title 可传入优先显示; 不传时 fallback 到 labelEpisodeId(epId) 翻译,
   * 禁止再把原始路由 epId(如 "ep01")直接抛给创作者 (铁律 #9 toC 兜底)。
   */
  episodeTitle?: string;
  sourceShot: Shot | undefined;
  title: string;
  onTitleChange: (next: string) => void;

  // 保存/状态
  dirty: boolean;
  saving: boolean;
  savedRelText: string;
  failureCount: number;
  statusBadge: StatusBadge;

  // 前后镜导航
  prevShot: Shot | undefined;
  nextShot: Shot | undefined;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  onNavigateStoryboard: () => void;
  onNavigateCompose: () => void;
  onSave: () => void;

  // W10: 选完视频才出 "前往合成" 次级按钮 (没选时藏起来)
  hasPickedVideo: boolean;

  /**
   * 2026-05-28 深度打磨 #5 — 撤销最近一次 autosave.
   * undoDepth = ShotStagePage 持的 historyStack.length, 0 时按钮 disabled.
   * onUndoLastSave 触发 pop + setDraft + 自动 autosave 回到上一个版本.
   */
  undoDepth?: number;
  onUndoLastSave?: () => void;
}

export function ShotStageHeader(props: ShotStageHeaderProps) {
  const {
    epId, episodeTitle, sourceShot, title, onTitleChange,
    dirty, saving, savedRelText, failureCount, statusBadge,
    prevShot, nextShot, onNavigatePrev, onNavigateNext, onNavigateStoryboard, onNavigateCompose,
    hasPickedVideo,
    undoDepth = 0, onUndoLastSave,
  } = props;
  // W11 B1 (2026-05-27): "保存" 按钮删 — autosave 已 1s debounce 跑, 只显示状态. props.onSave 保留兼容 caller.
  void props.onSave;

  return (
    <div style={{
      position: "sticky", top: 0, zIndex: 20,
      padding: "10px 24px 6px", borderBottom: "1px solid var(--ink-100)",
      background: "var(--surface-card)",
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <Button
        variant="ghost"
        size="sm"
        iconLeft="back"
        onClick={onNavigateStoryboard}
        title="返回分镜列表"
      >
        返回分镜
      </Button>

      <div style={{ flex: "1 1 180px", minWidth: 160 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--brand-700)", textTransform: "uppercase" }}>
          {episodeTitle || labelEpisodeId(epId)} · {sourceShot ? `第 ${sourceShot.index} 镜` : "—"}
        </div>
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="给这个分镜起个名字"
          style={{ width: "100%", marginTop: 2, border: "none", outline: "none", background: "transparent", color: "var(--ink-900)", fontSize: 18, fontWeight: 750, fontFamily: "'Noto Serif SC', serif" }}
        />
      </div>

      {/* W7: 状态徽章 — toC 兜底 */}
      <span
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          height: 24, padding: "0 10px", borderRadius: 999,
          fontSize: 11.5, fontWeight: 600,
          background: statusBadge.tone === "ok" ? "rgba(16,185,129,0.12)" : statusBadge.tone === "warn" ? "rgba(245,158,11,0.14)" : "var(--ink-50)",
          color: statusBadge.tone === "ok" ? "var(--ok, #059669)" : statusBadge.tone === "warn" ? "var(--warn, #b45309)" : "var(--ink-600)",
          border: `1px solid ${statusBadge.tone === "ok" ? "rgba(16,185,129,0.3)" : statusBadge.tone === "warn" ? "rgba(245,158,11,0.3)" : "var(--ink-150)"}`,
        }}
        title="本镜进度"
      >
        {statusBadge.text}
      </span>

      {/* W11 B1: 失败 chip 整合到状态条右侧 (同 statusBadge 视觉一致) */}
      {failureCount > 0 && (
        <span
          className="mk-chip mk-chip--err"
          style={{ height: 24 }}
          title={`本镜历史失败 ${failureCount} 次, 点开任务中心查看明细`}
        >
          <Icon name="warning" size={11} /> {failureCount} 次失败
        </span>
      )}

      {/* W7: 保存状态(实时,精确) — 铁律#5. W11 B1: 删了"保存"按钮 (autosave 跑得稳, 只显示状态) */}
      <span
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 11.5, color: dirty ? "var(--warn)" : "var(--ink-500)",
        }}
        title={saving ? "保存中..." : dirty ? "改动尚未保存, 1 秒后自动同步" : "已自动保存"}
      >
        <span style={{ width: 6, height: 6, borderRadius: 999, background: dirty ? "var(--warn)" : "var(--ok)" }} />
        {savedRelText}
      </span>

      {/* 2026-05-28 深度打磨 #5 — 撤销最近一次保存. 用户改坏了 prompt 后能立刻回退,
          不必手动重打. autosave 落盘前 push 上一版到 stack, 最多 10 层. 0 时灰按钮提示
          "没有可撤销的历史". */}
      {onUndoLastSave && (
        <Button
          variant="ghost"
          size="sm"
          iconLeft="refresh"
          onClick={onUndoLastSave}
          disabled={undoDepth === 0}
          title={
            undoDepth === 0
              ? "没有可撤销的修改 — autosave 落盘前的版本会进 undo 栈"
              : `回到上一个保存的版本 (还有 ${undoDepth} 步可撤销)`
          }
        >
          撤销
          {undoDepth > 0 && (
            <span style={{
              marginLeft: 4,
              fontSize: 10,
              padding: "0 5px",
              borderRadius: 8,
              background: "rgba(217,119,87,0.12)",
              color: "var(--brand-700)",
              fontWeight: 700,
            }}>
              {undoDepth}
            </span>
          )}
        </Button>
      )}

      {/* W7: 前/后镜导航 — 2026-05-26 Codex P2-10: 加可见文字标签 (铁律 #11 禁止 icon-only) */}
      <Button
        variant="ghost"
        size="sm"
        iconLeft="chevLeft"
        onClick={onNavigatePrev}
        disabled={!prevShot}
        title={prevShot ? `前一镜 (← / J): ${prevShot.title || "未命名"}` : "已是第一镜 (← / J)"}
        aria-label="前一镜"
      >
        前一镜
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconLeft="chevRight"
        onClick={onNavigateNext}
        disabled={!nextShot}
        title={nextShot ? `后一镜 (→ / K): ${nextShot.title || "未命名"}` : "已是最后一镜 (→ / K)"}
        aria-label="后一镜"
      >
        后一镜
      </Button>

      {/* W11 B1: "前往合成" 只在 picked_video_id 存在时显示 (现在 always 显示 — 改成仅在选完视频后出). */}
      {hasPickedVideo && (
        <Button
          variant="secondary"
          size="sm"
          iconRight="arrowRight"
          onClick={onNavigateCompose}
          title="前往本集合成与导出"
        >
          前往合成
        </Button>
      )}

      {/* W10: 整行宽快捷键提示 — 紧贴 header 末尾, 不抢主操作按钮的视觉. */}
      <div style={{
        flexBasis: "100%",
        fontSize: 10.5,
        color: "var(--ink-400)",
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        marginTop: 2,
      }}>
        <span>← → 或 J K 切镜</span>
        <span>·</span>
        <span>Esc 返回</span>
        <span>·</span>
        <span>1-9 选候选</span>
        <span>·</span>
        <span>F 设首帧</span>
        <span>·</span>
        <span>V 设视频</span>
      </div>
    </div>
  );
}
