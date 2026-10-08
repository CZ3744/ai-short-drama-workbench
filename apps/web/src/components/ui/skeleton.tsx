import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "text" | "circular" | "rectangular" | "rounded";
}

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, variant = "text", ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "animate-pulse bg-[var(--ink-100)]",
          {
            "h-4 w-full rounded-[var(--r-sm)]": variant === "text",
            "h-10 w-10 rounded-[var(--r-full)]": variant === "circular",
            "h-20 w-full": variant === "rectangular",
            "h-20 w-full rounded-[var(--r-lg)]": variant === "rounded",
          },
          className
        )}
        {...props}
      />
    );
  }
);
Skeleton.displayName = "Skeleton";
