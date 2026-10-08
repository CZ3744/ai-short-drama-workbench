import { forwardRef, type ComponentPropsWithoutRef, type HTMLAttributes } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { cn } from "../../lib/cn";
import { X } from "../shared/LucideIcon";
import { AnimatePresence, motion } from "framer-motion";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogTitle = RadixDialog.Title;
export const DialogDescription = RadixDialog.Description;

export const DialogContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadixDialog.Content>
>(({ className, children, ...props }, ref) => (
  <RadixDialog.Portal>
    <AnimatePresence>
      <RadixDialog.Overlay asChild>
        <motion.div
          key="overlay"
          className="fixed inset-0 z-[var(--z-modal)] bg-[var(--surface-overlay)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        />
      </RadixDialog.Overlay>
      <RadixDialog.Content
        ref={ref}
        asChild
        {...props}
      >
        <motion.div
          key="content"
          className={cn(
            "fixed left-1/2 top-1/2 z-[var(--z-modal)] w-full max-w-lg -translate-x-1/2 -translate-y-1/2",
            // 2026-05-21 UX-修: 默认 max-h 90vh + 内部滚动, 防止内容超长把 footer (按钮)
            // 推出视口外不可点。caller 不需要再各自手动加 max-h / overflow-y-auto。
            "max-h-[90vh] overflow-y-auto",
            "rounded-[var(--r-xl)] bg-[var(--surface-card)] p-[var(--sp-6)] shadow-[var(--shadow-xl)]",
            className
          )}
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        >
          {children}
          <RadixDialog.Close
            className="absolute right-4 top-4 rounded-[var(--r-sm)] p-1 text-[var(--ink-400)] hover:text-[var(--ink-700)] transition-colors"
            aria-label="关闭"
            title="关闭"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </RadixDialog.Close>
        </motion.div>
      </RadixDialog.Content>
    </AnimatePresence>
  </RadixDialog.Portal>
));
DialogContent.displayName = "DialogContent";

export const DialogHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mb-[var(--sp-4)]", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";
