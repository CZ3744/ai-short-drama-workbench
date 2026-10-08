import { cn } from "../../lib/cn";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "../ui/tooltip";

export interface ProviderHealthDotProps {
  color: "green" | "yellow" | "red" | "gray";
  label: string;
  className?: string;
}

const COLOR_MAP: Record<string, string> = {
  green: "bg-[#22c55e]",
  yellow: "bg-[#eab308]",
  red: "bg-[#ef4444]",
  gray: "bg-[#9ca3af]",
};

/**
 * 顶栏 provider 状态指示灯小圆点。
 * 颜色来自 GET /providers/presets 的 quota.color，
 * 鼠标悬停显示完整状态文字。
 */
export function ProviderHealthDot({ color, label, className }: ProviderHealthDotProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full shrink-0 cursor-default",
            COLOR_MAP[color] ?? COLOR_MAP.gray,
            className,
          )}
          aria-label={label}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
