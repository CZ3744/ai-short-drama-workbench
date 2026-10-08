import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { cn } from "../../lib/cn";

export const TooltipProvider = RadixTooltip.Provider;
export const Tooltip = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export const TooltipContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadixTooltip.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <RadixTooltip.Portal>
    <RadixTooltip.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-[var(--z-tooltip)] overflow-hidden rounded-[var(--r-md)] bg-[var(--ink-950)] px-3 py-1.5 text-[var(--fs-xs)] text-white shadow-[var(--shadow-md)]",
        "animate-in fade-in-0 zoom-in-95",
        className
      )}
      {...props}
    />
  </RadixTooltip.Portal>
));
TooltipContent.displayName = "TooltipContent";
