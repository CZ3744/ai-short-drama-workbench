import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "flex min-h-[80px] w-full rounded-[var(--r-md)] px-3 py-2 text-[var(--fs-md)] text-[var(--ink-950)] placeholder:text-[var(--ink-400)] transition-colors resize-y",
          "focus:outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        style={{
          border: `1px solid ${error ? "var(--err, #c83c3c)" : "var(--ink-200, #c7c1b9)"}`,
          backgroundColor: "var(--surface-card, #ffffff)",
        }}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";
