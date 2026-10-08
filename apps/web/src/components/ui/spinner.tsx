import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Loader2 } from "../shared/LucideIcon";

export interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
  size?: "sm" | "md" | "lg";
  label?: ReactNode;
}

export const Spinner = forwardRef<HTMLDivElement, SpinnerProps>(
  ({ className, size = "md", label, ...props }, ref) => {
    const sizeMap = { sm: "h-4 w-4", md: "h-6 w-6", lg: "h-8 w-8" };
    return (
      <div ref={ref} className={cn("flex items-center gap-2", className)} {...props}>
        <Loader2 className={cn("animate-spin text-[var(--brand-500)]", sizeMap[size])} />
        {label && (
          <span className="text-[var(--fs-sm)] text-[var(--ink-500)]">{label}</span>
        )}
      </div>
    );
  }
);
Spinner.displayName = "Spinner";

/** 全屏加载态 */
export function FullScreenSpinner({ label = "加载中..." }: { label?: string }) {
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--surface-canvas)]/80">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-[var(--brand-500)]" />
        <span className="text-[var(--fs-md)] text-[var(--ink-500)]">{label}</span>
      </div>
    </div>
  );
}
