import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";

export interface InlineActionBarProps {
  visible?: boolean;
  actions?: { label: string; icon?: ReactNode; onClick: () => void; variant?: "primary" | "ghost" | "danger" }[];
  className?: string;
}

/**
 * 浮动工具条(Canvas 段落选中时弹出)。
 */
export function InlineActionBar({
  visible = false,
  actions = [],
  className,
}: InlineActionBarProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.95 }}
          transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "inline-flex items-center gap-1 rounded-[var(--r-lg)] bg-[var(--surface-card)] p-1 shadow-[var(--shadow-lg)] border border-[var(--ink-100)]",
            className
          )}
        >
          {actions.map((action, i) => (
            <span key={i} className="flex items-center">
              {i > 0 && <Separator orientation="vertical" className="mx-1 h-5" />}
              <Button
                variant={action.variant ?? "ghost"}
                size="sm"
                onClick={action.onClick}
                className="gap-1"
              >
                {action.icon}
                {action.label}
              </Button>
            </span>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
