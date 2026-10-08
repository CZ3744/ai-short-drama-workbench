/**
 * 全局图像生成并发信号量 — 防止 batch 启动多集 pipeline 时瞬间打爆 ChatGPT 订阅速率限制.
 *
 * 背景 (2026-05-26 用户反馈):
 *   batch 启 5 集 → 每集 firstframes stage 内 N shot 一次性 enqueue + 各自走 orchestrator
 *   → 后端没有跨 pipeline 的并发上限 → 25 个 ChatGPT 请求瞬时打出去 → 429 Too Many Requests.
 *   用户原话: "我不是说不要太并发生图吗, 你现在写的同时并发没有自己控制上限?"
 *
 * 设计:
 *   - module-level 单例 Semaphore, 进程内共享.
 *   - 每个 image generation call 进 provider.generate 前 acquire, 完成后 release.
 *   - 排队 (waiter array) FIFO, 不饿死后入任务.
 *   - permits 由 env IMAGE_GEN_MAX_CONCURRENCY 控制, 默认 3 (经验值, ChatGPT 订阅 5+ 易触 429).
 *
 * 不限的:
 *   - video provider (各家 quota 不同, 不在本信号量内)
 *   - 不同 image provider 共享同一上限 (简化, 后续需要的话按 provider_id 分开)
 */

import { loggerSync } from "../../../../packages/core/src/logger";

class Semaphore {
  private current = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  /** 拿一个 permit. 没有 permit 时排队, 等其他释放. 永远不抛 (无 timeout — 上游 ctx.signal 才是真中止). */
  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        // 等到的时候 current 还是 max, 这里不变, 直接进入"占用"
        resolve();
      });
    });
  }

  /** 释放 permit. 如果有 waiter 在等, 唤醒下一个 (current 不变, 只是 holder 切换). */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // 不要立即 sync call, 让出 event loop 一下避免深递归栈
      Promise.resolve().then(next);
    } else {
      this.current = Math.max(0, this.current - 1);
    }
  }

  /** 调试用 — 当前占用 / 等待数 */
  stats(): { current: number; waiting: number; max: number } {
    return { current: this.current, waiting: this.waiters.length, max: this.max };
  }
}

function getMaxConcurrency(): number {
  const raw = process.env.IMAGE_GEN_MAX_CONCURRENCY;
  if (!raw) return 3;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(n, 20); // 上限 20, 防止误配 999
}

export const imageGenSemaphore = new Semaphore(getMaxConcurrency());

/**
 * helper: acquire → 跑 fn → release, 即使 fn throw 也 release.
 * 调用方: `return withImageGenPermit(() => provider.generate(req, ctx));`
 */
export async function withImageGenPermit<T>(fn: () => Promise<T>): Promise<T> {
  const waitStartedAt = Date.now();
  await imageGenSemaphore.acquire();
  const heldStartedAt = Date.now();
  const waitedMs = heldStartedAt - waitStartedAt;
  const stats = imageGenSemaphore.stats();
  // 2026-05-26 日志降噪 — 只在等待 >2s 或 waiting>5 才记录, 否则正常排队太吵
  if (waitedMs > 2000 || stats.waiting > 5) {
    loggerSync().info(
      `[imageGenSemaphore] acquired after ${waitedMs}ms wait (current=${stats.current}/${stats.max}, waiting=${stats.waiting})`,
    );
  }
  try {
    return await fn();
  } finally {
    imageGenSemaphore.release();
    const heldMs = Date.now() - heldStartedAt;
    if (heldMs > 60000) {
      loggerSync().info(`[imageGenSemaphore] released after ${heldMs}ms (long task)`);
    }
  }
}
