import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import { cn } from "../../lib/cn";

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
/** 锚点 — 用于 controlled Popover 锁定弹窗位置但 trigger 行为不冲突 chip 自有 onClick. */
export const PopoverAnchor = RadixPopover.Anchor;

export const PopoverContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadixPopover.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <RadixPopover.Portal>
    <RadixPopover.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-[var(--z-popover)] w-72 rounded-[var(--r-lg)] bg-white p-4 shadow-[var(--shadow-lg)] border border-[var(--ink-100)]",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        className
      )}
      {...props}
    />
  </RadixPopover.Portal>
));
PopoverContent.displayName = "PopoverContent";
