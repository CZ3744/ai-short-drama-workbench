import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { AlertTriangle } from "../shared/LucideIcon";
import { Button } from "./button";

export interface ErrorStateProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  onRetry?: () => void;
}

export const ErrorState = forwardRef<HTMLDivElement, ErrorStateProps>(
  ({ className, title = "出了点问题", description, onRetry, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center justify-center py-[var(--sp-12)] px-[var(--sp-6)] text-center",
        className
      )}
      {...props}
    >
      {/* 红色背景框 */}
      <div className="flex flex-col items-center gap-[var(--sp-3)] rounded-[var(--r-xl)] bg-[var(--err)]/5 border border-[var(--err)]/20 px-[var(--sp-8)] py-[var(--sp-8)] max-w-[420px] w-full">
        <div className="text-[var(--err)]">
          <AlertTriangle className="h-12 w-12" />
        </div>
        <h3 className="text-[var(--fs-lg)] font-semibold text-[var(--err)]">
          {title}
        </h3>
        {description && (
          <p className="text-[var(--fs-sm)] text-[var(--ink-500)] max-w-[320px]">
            {description}
          </p>
        )}
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="mt-[var(--sp-2)] border-[var(--err)]/30 text-[var(--err)] hover:bg-[var(--err)]/10">
            重试
          </Button>
        )}
      </div>
    </div>
  )
);
ErrorState.displayName = "ErrorState";
