import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[var(--r-full)] px-2.5 py-0.5 text-[var(--fs-xs)] font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-[var(--ink-100)] text-[var(--ink-700)]",
        brand: "bg-[var(--brand-100)] text-[var(--brand-700)]",
        ok: "bg-[var(--ok-bg)] text-[var(--ok)]",
        warn: "bg-[var(--warn-bg)] text-[var(--warn)]",
        err: "bg-[var(--err-bg)] text-[var(--err)]",
        info: "bg-[var(--info-bg)] text-[var(--info)]",
        outline: "border border-[var(--ink-200)] text-[var(--ink-600)] bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  )
);
Badge.displayName = "Badge";

export { badgeVariants };
