import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as RadixSeparator from "@radix-ui/react-separator";
import { cn } from "../../lib/cn";

export interface SeparatorProps extends ComponentPropsWithoutRef<typeof RadixSeparator.Root> {}

export const Separator = forwardRef<HTMLDivElement, SeparatorProps>(
  ({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
    <RadixSeparator.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-[var(--ink-100)]",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className
      )}
      {...props}
    />
  )
);
Separator.displayName = "Separator";
