import { type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "./button";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  width?: string;
  hideDefaultHeader?: boolean;
}

export function Drawer({
  open,
  onClose,
  side = "right",
  title,
  children,
  className,
  width = "400px",
  hideDefaultHeader,
}: DrawerProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[var(--z-overlay)] bg-[var(--surface-overlay)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.div
            className={cn(
              "fixed top-0 bottom-0 z-[var(--z-overlay)] bg-[var(--surface-card)] shadow-[var(--shadow-lg)]",
              "flex flex-col",
              side === "right" ? "right-0 border-l border-[var(--ink-100)]" : "left-0",
              className
            )}
            style={{ width, maxWidth: "calc(100vw - 2rem)" }}
            initial={{ x: side === "right" ? "100%" : "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: side === "right" ? "100%" : "-100%" }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            {!hideDefaultHeader && (
              <div className="flex items-center justify-between px-[var(--sp-6)] py-[var(--sp-4)] border-b border-[var(--ink-100)]">
                {title && <h2 className="text-[var(--fs-lg)] font-semibold text-[var(--ink-950)]">{title}</h2>}
                <Button
                  variant="ghost"
                  size="sm"
                  iconLeft="close"
                  onClick={onClose}
                  aria-label="关闭"
                  title="关闭"
                  className="ml-auto"
                >
                  关闭
                </Button>
              </div>
            )}
            {hideDefaultHeader ? (
              children
            ) : (
              <div className="flex-1 overflow-y-auto p-[var(--sp-6)]">
                {children}
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
Drawer.displayName = "Drawer";
