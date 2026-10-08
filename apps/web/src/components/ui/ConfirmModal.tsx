/**
 * ConfirmModal — 网页内统一二级确认弹窗 (2026-05-19).
 *
 * 取代所有 window.confirm / window.alert 的浏览器原生弹窗 — 用户原话:
 *   "弹窗不要做成浏览器层面的, 要做成页面级别的弹窗, 现在这样体验很割裂,
 *    仿佛不是在前端一起做出来的。弹窗同样要有设计感。
 *    其他所有类似的地方都改掉, 我要的是网页内部的一致性使用体验。"
 *
 * 设计参考 prompt-dialog.tsx — mk-card + 半透明 backdrop + framer-motion 入场动画,
 * 跟项目其他弹窗 (PromptDialog / Dialog) 风格一致.
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   import { useConfirm } from "@/components/ui/ConfirmModal";
 *
 *   function MyComponent() {
 *     const confirm = useConfirm();
 *     async function handleDelete() {
 *       const ok = await confirm({
 *         title: "删除这一集?",
 *         description: "这一集会从分镜板消失. 数据移入回收站可恢复.",
 *         variant: "destructive",
 *         confirmLabel: "删除",
 *       });
 *       if (!ok) return;
 *       // ... 真删除
 *     }
 *   }
 *
 * App.tsx 根级已挂 <ConfirmModalProvider>, 任何后代组件都能用 hook.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "./button";
import { useBodyScrollLock } from "./BaseDialog";

// ─── 类型 ──────────────────────────────────────────────────────────

export type ConfirmVariant = "destructive" | "default" | "warning";

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** 默认 "确定" */
  confirmLabel?: string;
  /** 默认 "取消" */
  cancelLabel?: string;
  /** default = 主色按钮 / destructive = 红色按钮 / warning = 橙色按钮 */
  variant?: ConfirmVariant;
}

interface ResolvedConfirmOptions extends Required<Omit<ConfirmOptions, "description">> {
  description: string | undefined;
}

interface ConfirmState {
  options: ResolvedConfirmOptions;
  resolve: (value: boolean) => void;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

// ─── Context ───────────────────────────────────────────────────────

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * useConfirm — 在任何组件里调用, 返回一个 async 函数, await 它拿 true/false.
 *
 * 必须在 ConfirmModalProvider 之内调用; 否则 throw 提示开发者忘了挂 Provider.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error(
      "useConfirm() 必须在 <ConfirmModalProvider> 之内使用。请在 App.tsx 根层挂载 Provider。",
    );
  }
  return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────

export function ConfirmModalProvider({ children }: { children: ReactNode }) {
  // 当前展示中的 modal — 同时只有一个 (后续 confirm 调用会替换前一个并 resolve(false))
  const [state, setState] = useState<ConfirmState | null>(null);

  // 用 ref 持有最新的 resolve, 避免闭包陈旧问题 (state 已经设过新值时, 旧 resolve 还可能被调)
  const currentResolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>(async (opts) => {
    // 如果当前有未关闭的 modal — 先取消它 (resolve false), 再上新 modal
    if (currentResolveRef.current) {
      currentResolveRef.current(false);
      currentResolveRef.current = null;
    }
    return new Promise<boolean>((resolve) => {
      const resolved: ResolvedConfirmOptions = {
        title: opts.title,
        description: opts.description,
        confirmLabel: opts.confirmLabel ?? "确定",
        cancelLabel: opts.cancelLabel ?? "取消",
        variant: opts.variant ?? "default",
      };
      currentResolveRef.current = resolve;
      setState({ options: resolved, resolve });
    });
  }, []);

  const handleResolve = useCallback((value: boolean) => {
    const cur = state;
    if (!cur) return;
    cur.resolve(value);
    if (currentResolveRef.current === cur.resolve) {
      currentResolveRef.current = null;
    }
    setState(null);
  }, [state]);

  // 监听 ESC — 触发 cancel.
  // 2026-07-09 audit (C26): ConfirmModal 常叠在 BaseDialog 之上 (任何 BaseDialog 内的删除流程走 useConfirm).
  // BaseDialog 也在 window 上挂了 bubble-phase 的 ESC→onClose, 且它注册更早 (弹窗打开时就挂了). 若 ConfirmModal
  // 只在 bubble phase 监听, BaseDialog 的 listener 会先触发 → 按 Esc 取消一次删除却把上层弹窗一起关掉
  // (违反铁律 #6 二次确认). 修: 在 CAPTURE phase 监听 (capture 早于任何 bubble), 命中 Escape 后
  // stopPropagation + stopImmediatePropagation 吞掉事件, 底层 BaseDialog 收不到 → ESC 只作用最顶层弹窗.
  useEffect(() => {
    if (!state) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleResolve(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [state, handleResolve]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmModalView state={state} onResolve={handleResolve} />
    </ConfirmContext.Provider>
  );
}

// ─── 视图层 ────────────────────────────────────────────────────────

interface ConfirmModalViewProps {
  state: ConfirmState | null;
  onResolve: (value: boolean) => void;
}

function ConfirmModalView({ state, onResolve }: ConfirmModalViewProps) {
  // framer-motion AnimatePresence — 开关都有 fade + slight scale 动画
  return (
    <AnimatePresence>
      {state ? (
        <ConfirmModalInner
          key="confirm-modal"
          options={state.options}
          onConfirm={() => onResolve(true)}
          onCancel={() => onResolve(false)}
        />
      ) : null}
    </AnimatePresence>
  );
}

interface ConfirmModalInnerProps {
  options: ResolvedConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModalInner({ options, onConfirm, onCancel }: ConfirmModalInnerProps) {
  // 2026-07-09 audit (asset-dialog lane): 弹窗打开时锁背景滚动 (与 BaseDialog 共用引用计数,
  // 叠在 BaseDialog 之上时不会提前解锁). ConfirmModalInner 只在展示期间挂载, 传 true 即可.
  useBodyScrollLock(true);

  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  // 2026-07-09 audit (asset-dialog lane): 不再一律聚焦"确认". destructive (删除 / 不可逆) 默认
  // 聚焦"取消", 防用户顺手 Enter/空格误触执行不可撤销操作 (公认的误触陷阱); default / warning
  // 才聚焦确认让回车顺手. 用户想确认仍可 Tab 过去或直接点击.
  useEffect(() => {
    const t = setTimeout(() => {
      if (options.variant === "destructive") cancelBtnRef.current?.focus();
      else confirmBtnRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [options.variant]);

  // 确认按钮 variant 映射 — variant prop 决定按钮颜色,
  // destructive → danger (红), warning → primary 但加 amber tint, default → primary (品牌)
  const confirmVariant = useMemo<"primary" | "danger">(() => {
    if (options.variant === "destructive") return "danger";
    return "primary"; // default / warning 都用主色, warning 通过额外样式区分
  }, [options.variant]);

  // warning 时给按钮加一层琥珀色覆盖, 提示"非删除但需要注意"的语义
  const warningStyle = options.variant === "warning"
    ? { backgroundColor: "var(--warn, #f59e0b)", color: "white", borderColor: "var(--warn, #f59e0b)" }
    : undefined;

  // 顶部图标 — 不同 variant 显示不同色块装饰
  const accentColor = options.variant === "destructive"
    ? "var(--err, #ef4444)"
    : options.variant === "warning"
    ? "var(--warn, #f59e0b)"
    : "var(--brand-500, #6366f1)";

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal,1000)] flex items-center justify-center px-4"
      style={{
        backgroundColor: "rgba(15, 23, 42, 0.42)",
        backdropFilter: "blur(2px)",
      }}
      onMouseDown={(e) => {
        // 点 backdrop 触发 cancel — 跟 PromptDialog 一致
        if (e.target === e.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      aria-describedby={options.description ? "confirm-modal-desc" : undefined}
    >
      <motion.div
        key="confirm-modal-card"
        className="mk-card w-full max-w-md"
        style={{ padding: 24, boxShadow: "var(--shadow-xl, 0 24px 48px rgba(15,23,42,0.18))" }}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* 顶部色条 — 用 accent 颜色区分 variant 语义, 不靠纯文字 */}
        <div
          aria-hidden
          style={{
            height: 3,
            borderRadius: 2,
            background: accentColor,
            marginBottom: 16,
            opacity: 0.85,
          }}
        />

        <h3
          id="confirm-modal-title"
          className="m-0 text-base font-semibold text-[var(--ink-900)]"
          style={{ fontSize: 16, lineHeight: "24px" }}
        >
          {options.title}
        </h3>

        {options.description ? (
          <p
            id="confirm-modal-desc"
            className="mt-2 text-sm text-[var(--ink-500)]"
            style={{
              fontSize: 13,
              lineHeight: "22px",
              whiteSpace: "pre-line", // 允许 \n 换行 — 老 caller 习惯用 \n 分段
            }}
          >
            {options.description}
          </p>
        ) : null}

        <div
          className="mt-5 flex justify-end gap-2"
          style={{ marginTop: 20 }}
        >
          <Button ref={cancelBtnRef} variant="outline" size="sm" onClick={onCancel}>
            {options.cancelLabel}
          </Button>
          <Button
            ref={confirmBtnRef}
            variant={confirmVariant}
            size="sm"
            onClick={onConfirm}
            style={warningStyle}
          >
            {options.confirmLabel}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
