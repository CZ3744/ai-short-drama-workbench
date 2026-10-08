/**
 * useScrollRestoration — 路由切换时记忆/恢复滚动位置 (2026-05-27)
 *
 * 用户原话: "不同页面之间跳转, 不要每次都刷新在页面最上面, 点进之前在哪, 返回就在哪".
 *
 * BrowserRouter (非 data router) 没有内置 <ScrollRestoration>, 默认行为是路由切换不
 * 保留 scroll. 这个 hook 在 App 顶层挂一次, 监听 location 变化:
 *   - 离开前 (location 变化前) 把当前 main 元素的 scrollTop 写到 sessionStorage[pathname]
 *   - 进入后 (新 location 渲染完成下一帧) 从 sessionStorage 读对应 pathname 的位置恢复
 *
 * 注意: App.tsx 的 <main className="flex-1 overflow-y-auto pb-12"> 是真实滚动容器,
 *      window 本身不滚动. 必须监听 main.scrollTop 而不是 window.scrollY.
 *
 * 用 sessionStorage 而非 localStorage — scroll 位置 per-tab, 不应跨 tab 共享.
 */

import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

const SS_KEY = "video-generate.scroll-pos.v1";

interface PositionMap {
  [pathname: string]: { x: number; y: number; ts: number };
}

const TTL_MS = 30 * 60 * 1000; // 30 min — 太老的 scroll 位置不恢复

/** 找滚动容器: 优先 <main>, fallback document.documentElement */
function findScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (document.querySelector("main") as HTMLElement | null) ?? document.documentElement;
}

function loadPositions(): PositionMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage?.getItem(SS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PositionMap;
    const now = Date.now();
    const filtered: PositionMap = {};
    for (const [path, pos] of Object.entries(parsed)) {
      if (now - pos.ts < TTL_MS) filtered[path] = pos;
    }
    return filtered;
  } catch {
    return {};
  }
}

function savePositions(map: PositionMap): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.setItem(SS_KEY, JSON.stringify(map));
  } catch { /* 配额满 — 静默 */ }
}

function snapshotCurrent(pathname: string): void {
  const el = findScroller();
  if (!el) return;
  const positions = loadPositions();
  positions[pathname] = {
    x: el.scrollLeft,
    y: el.scrollTop,
    ts: Date.now(),
  };
  savePositions(positions);
}

export function useScrollRestoration(): void {
  const location = useLocation();
  const prevPathnameRef = useRef<string>(location.pathname);

  // 关闭浏览器原生 scrollRestoration, 完全交给我们
  useEffect(() => {
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      const prev = window.history.scrollRestoration;
      window.history.scrollRestoration = "manual";
      return () => { window.history.scrollRestoration = prev; };
    }
  }, []);

  useEffect(() => {
    const nextPathname = location.pathname;
    const prevPathname = prevPathnameRef.current;

    // 1. 保存前一个 pathname 的 scroll
    if (prevPathname && prevPathname !== nextPathname) {
      snapshotCurrent(prevPathname);
    }

    // 2. 恢复新 pathname 的 scroll (在下一帧, 等 React 渲染完)
    const positions = loadPositions();
    const saved = positions[nextPathname];
    const restore = () => {
      const el = findScroller();
      if (!el) return;
      if (saved) {
        el.scrollTop = saved.y;
        el.scrollLeft = saved.x;
      } else {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      }
    };
    // 两层 rAF: 第一层等 React commit, 第二层等 layout flush (图片/样式加载完高度才稳)
    const raf1 = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(restore);
    });

    prevPathnameRef.current = nextPathname;
    return () => window.cancelAnimationFrame(raf1);
  }, [location.pathname]);

  // 也在 unload 前保存当前 scroll (防用户刷新页面丢)
  useEffect(() => {
    const onBeforeUnload = () => snapshotCurrent(location.pathname);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [location.pathname]);

  // 也定期 snapshot (每 2 秒) — 防 React 内部跳路由没触发 beforeunload 时丢失最新位置
  useEffect(() => {
    const pathname = location.pathname;
    const timer = window.setInterval(() => snapshotCurrent(pathname), 2000);
    return () => window.clearInterval(timer);
  }, [location.pathname]);
}
