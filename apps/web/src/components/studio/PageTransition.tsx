import { motion } from "framer-motion";
import type { ReactNode } from "react";

/**
 * PageTransition — 页面过渡动画包装组件。
 *
 * 2026-05-27 — 用户原话: "刷新页面之后会有几个 tab 加载然后弹出, 比较影响观感,
 * 不能刷新完一下就加载好吗".
 *
 * 之前 initial={{opacity:0, y:8}} + animate{{opacity:1, y:0}} 200ms 让每次
 * mount (包括刷新页面 + 路由切换) 都跑一遍 fade-in + 上滑动画, 用户感觉"内容
 * 弹出来". 改 initial={false} 让 framer-motion 跳过初始动画, 立即显示 animate
 * 终态 — 刷新即满状态, 不再有"弹出"动作.
 *
 * exit 保留, 给未来接入 AnimatePresence 时还能跑退出动画 (当前 App.tsx 没用
 * AnimatePresence, 实际不触发).
 */
export function PageTransition({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
