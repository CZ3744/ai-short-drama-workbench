import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as RadixScrollArea from "@radix-ui/react-scroll-area";
import { cn } from "../../lib/cn";

export interface ScrollAreaProps extends ComponentPropsWithoutRef<typeof RadixScrollArea.Root> {}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, ...props }, ref) => (
    <RadixScrollArea.Root
      ref={ref}
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <RadixScrollArea.Viewport className="h-full w-full rounded-[inherit]">
        {children}
      </RadixScrollArea.Viewport>
      <RadixScrollArea.Scrollbar
        className="flex select-none touch-none p-0.5 bg-transparent transition-colors duration-150 data-[orientation=vertical]:w-2.5 data-[orientation=horizontal]:flex-col data-[orientation=horizontal]:h-2.5"
        orientation="vertical"
      >
        <RadixScrollArea.Thumb className="flex-1 bg-[var(--ink-300)] rounded-[var(--r-full)] relative before:content-[''] before:absolute before:top-1/2 before:left-1/2 before:-translate-x-1/2 before:-translate-y-1/2 before:w-full before:h-full before:min-w-[44px] before:min-h-[44px]" />
      </RadixScrollArea.Scrollbar>
      <RadixScrollArea.Scrollbar
        className="flex select-none touch-none p-0.5 bg-transparent transition-colors duration-150 data-[orientation=vertical]:w-2.5 data-[orientation=horizontal]:flex-col data-[orientation=horizontal]:h-2.5"
        orientation="horizontal"
      >
        <RadixScrollArea.Thumb className="flex-1 bg-[var(--ink-300)] rounded-[var(--r-full)] relative before:content-[''] before:absolute before:top-1/2 before:left-1/2 before:-translate-x-1/2 before:-translate-y-1/2 before:w-full before:h-full before:min-w-[44px] before:min-h-[44px]" />
      </RadixScrollArea.Scrollbar>
    </RadixScrollArea.Root>
  )
);
ScrollArea.displayName = "ScrollArea";
