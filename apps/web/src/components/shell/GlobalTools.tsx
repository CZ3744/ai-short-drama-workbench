import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type SetStateAction } from "react";

type Tool = "shortcuts" | "assistant" | "queue";
const ToolsContext = createContext<{ active: Tool | null; setActive: React.Dispatch<SetStateAction<Tool | null>> } | null>(null);

export function GlobalToolsProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Tool | null>(null);
  return <ToolsContext.Provider value={{ active, setActive }}>{children}</ToolsContext.Provider>;
}

/** A single panel at a time, Escape/focus behavior shared by all three tool entry points. */
export function useGlobalTool(tool: Tool) {
  const context = useContext(ToolsContext);
  if (!context) throw new Error("GlobalToolsProvider missing");
  const { active, setActive } = context;
  const open = active === tool;
  const wasOpen = useRef(false);
  const setOpen = useCallback((value: SetStateAction<boolean>) => {
    setActive(current => {
      const next = typeof value === "function" ? value(current === tool) : value;
      return next ? tool : current === tool ? null : current;
    });
  }, [setActive, tool]);
  useEffect(() => {
    let frame = 0;
    if (open) {
      frame = requestAnimationFrame(() => {
        const panel = document.querySelector<HTMLElement>(`[data-tool-panel="${tool}"]`);
        (panel?.querySelector<HTMLElement>('button, input, textarea, [tabindex="0"]') ?? panel)?.focus();
      });
    } else if (wasOpen.current && active === null) {
      frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tool-trigger="${tool}"]`)?.focus());
    }
    wasOpen.current = open;
    return () => cancelAnimationFrame(frame);
  }, [open, active, tool]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const panel = document.querySelector<HTMLElement>(`[data-tool-panel="${tool}"]`);
      // Nested dialogs own their own Escape and focus cycle.
      const nested = (event.target as HTMLElement)?.closest('[role="dialog"]');
      if (nested && nested !== panel) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); }
      if (event.key === "Tab" && panel) {
        const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter(el => el.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen, tool]);
  return { open, setOpen };
}
