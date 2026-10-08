import { cn } from "../../../lib/cn";
import { Icon } from "../../../components/shared/Icon";

export type ComposeStageKey = "storyboard" | "dubbing" | "subtitle" | "cover" | "export";
export interface StageDetail { completed: number; total: number; }
export interface StageProgressBarProps {
  current: ComposeStageKey;
  completed: ComposeStageKey[];
  stageDetails: Partial<Record<ComposeStageKey, StageDetail>>;
  running?: boolean;
  className?: string;
}

// Keys stay compatible with stored view state; labels reflect the actual evidence.
const STAGES: { key: ComposeStageKey; label: string; hint: string }[] = [
  { key: "storyboard", label: "分镜规划", hint: "已规划的镜头" },
  { key: "dubbing", label: "视频素材", hint: "已选定的视频" },
  { key: "subtitle", label: "镜头确认", hint: "已确认且有视频" },
  { key: "export", label: "合成预览", hint: "预览满意后再导出" },
];

export function StageProgressBar({ current, completed, stageDetails, running = false, className }: StageProgressBarProps) {
  return (
    <ol aria-label="合成准备进度" className={cn(className)} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(116px, 1fr))", gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
      {STAGES.map((stage, index) => {
        const done = completed.includes(stage.key);
        const active = current === stage.key;
        const detail = stageDetails[stage.key];
        const inProgress = active && running;
        const count = detail && detail.total > 0 ? `${detail.completed} / ${detail.total}` : "尚未开始";
        const status = inProgress ? "正在合成…" : stage.key === "export" ? (done ? "已有合成结果" : "等待合成") : count;
        return (
          <li key={stage.key} aria-current={active ? "step" : undefined} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 8px", borderRadius: 12, background: active ? "var(--brand-50)" : "var(--surface-card)", border: `1px solid ${active ? "var(--brand-200)" : "var(--ink-100)"}`, minWidth: 0 }}>
            <span aria-hidden="true" style={{ width: 23, height: 23, flexShrink: 0, borderRadius: 999, display: "grid", placeItems: "center", fontSize: 11, background: done && !inProgress ? "var(--ok-bg)" : "var(--ink-50)", color: done && !inProgress ? "var(--ok)" : "var(--brand-700)" }}>
              {done && !inProgress ? <Icon name="check" size={12} /> : index + 1}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-800)", lineHeight: 1.5 }}>{stage.label}</div>
              <div style={{ fontSize: 11, color: active ? "var(--brand-700)" : "var(--ink-500)", lineHeight: 1.7 }}>{status}</div>
              <div style={{ fontSize: 10, color: "var(--ink-400)", lineHeight: 1.5 }}>{stage.hint}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
