import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import { Icon } from "../shared/Icon";

export interface EmptyProps extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode;
  title?: string;
  description?: string;
  cta?: string;
  onCta?: () => void;
}

export const Empty = forwardRef<HTMLDivElement, EmptyProps>(
  ({ className, icon, title = "暂无内容", description, cta, onCta, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center justify-center py-[var(--sp-12)] px-[var(--sp-6)] text-center",
        className
      )}
      {...props}
    >
      <div className="mb-[var(--sp-4)] text-[var(--ink-300)]">
        {icon || <Icon name="doc" size={48} />}
      </div>
      <h3 className="text-[var(--fs-lg)] font-semibold text-[var(--ink-700)] mb-[var(--sp-2)]">
        {title}
      </h3>
      {description && (
        <p className="text-[var(--fs-sm)] text-[var(--ink-400)] mb-[var(--sp-6)] max-w-[280px]">
          {description}
        </p>
      )}
      {cta && onCta && (
        <Button variant="primary" size="sm" onClick={onCta}>
          {cta}
        </Button>
      )}
    </div>
  )
);
Empty.displayName = "Empty";
