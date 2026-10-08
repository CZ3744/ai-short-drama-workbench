import { useCallback, useEffect, useRef } from "react";
import { useTasksStore } from "../stores/tasksStore";
import { createTaskSynchronizer } from "../lib/taskSynchronization";

/** 全局唯一任务恢复入口，供定时刷新、重新联网和 SSE 断线恢复共同使用。 */
export function useTaskSynchronization(): () => Promise<void> {
  const current = useRef<(() => Promise<void>) | null>(null);
  const synchronize = useCallback(() => current.current?.() ?? Promise.resolve(), []);

  useEffect(() => {
    const controller = new AbortController();
    const sync = createTaskSynchronizer({ getStore: useTasksStore.getState, signal: controller.signal });
    current.current = sync;
    void sync();
    const visible = () => { if (document.visibilityState === "visible") void sync(); };
    const online = () => { void sync(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    const timer = window.setInterval(visible, 30_000);
    return () => {
      // 生命周期取消，不是给长时间生成请求增加超时。
      controller.abort();
      if (current.current === sync) current.current = null;
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
      window.clearInterval(timer);
    };
  }, []);

  return synchronize;
}
