import { cn } from "../../lib/cn";
import { labelOfStage } from "../../lib/sourceLabels";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "../ui/tooltip";

export type StatusValue = "drafted" | "generating" | "ready" | "picked" | "approved" | "failed" | "scripting" | "storyboarded" | "generated" | "exported";

export interface StatusPillProps {
  status: StatusValue;
  className?: string;
  /** Failure entries for failed state — shown in hover tooltip */
  failures?: Array<{ at: string; stage: string; error: string }>;
}

const statusConfig: Record<StatusValue, { label: string; dot: string; bg: string; text: string }> = {
  drafted: { label: "草稿", dot: "bg-[var(--ink-400)]", bg: "bg-[var(--ink-100)]", text: "text-[var(--ink-600)]" },
  generating: { label: "生成中", dot: "bg-[var(--info)]", bg: "bg-[var(--info-bg)]", text: "text-[var(--info)]" },
  ready: { label: "就绪", dot: "bg-[var(--ok)]", bg: "bg-[var(--ok-bg)]", text: "text-[var(--ok)]" },
  picked: { label: "已选", dot: "bg-[var(--brand-500)]", bg: "bg-[var(--brand-100)]", text: "text-[var(--brand-700)]" },
  approved: { label: "已批准", dot: "bg-[var(--ok)]", bg: "bg-[var(--ok-bg)]", text: "text-[var(--ok)]" },
  failed: { label: "失败", dot: "bg-[var(--err)]", bg: "bg-[var(--err-bg)]", text: "text-[var(--err)]" },
  scripting: { label: "创作中", dot: "bg-[var(--info)]", bg: "bg-[var(--info-bg)]", text: "text-[var(--info)]" },
  storyboarded: { label: "已分镜", dot: "bg-[var(--brand-500)]", bg: "bg-[var(--brand-100)]", text: "text-[var(--brand-700)]" },
  generated: { label: "已生成", dot: "bg-[var(--ok)]", bg: "bg-[var(--ok-bg)]", text: "text-[var(--ok)]" },
  exported: { label: "已导出", dot: "bg-[var(--ok)]", bg: "bg-[var(--ok-bg)]", text: "text-[var(--ok)]" },
};

/**
 * 状态胶囊：drafted/generating/ready/picked/approved/failed。
 * failed 状态时如有 failures 则显示 tooltip 列出错误详情。
 */
export function StatusPill({ status, className, failures }: StatusPillProps) {
  const cfg = statusConfig[status];

  const pill = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--r-full)] px-2.5 py-0.5 text-[var(--fs-xs)] font-medium",
        cfg.bg,
        cfg.text,
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot, status === "generating" && "animate-pulse")} />
      {cfg.label}
    </span>
  );

  if (status === "failed" && failures && failures.length > 0) {
    return (
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          {pill}
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[320px]">
          <div className="flex flex-col gap-1">
            <span className="text-[var(--fs-xs)] font-semibold text-[var(--err-light)]">生成失败</span>
            {failures.map((f, i) => (
              <div key={i} className="text-[var(--fs-xs)] text-white/80">
                <span className="text-white/50">{labelOfStage(f.stage)}</span>
                {" · "}
                {f.error}
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return pill;
}
