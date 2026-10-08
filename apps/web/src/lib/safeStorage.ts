/**
 * safeStorage — 安全的 localStorage wrapper
 *
 * 在隐私模式、配额超限或 localStorage 被禁用时不抛出异常，静默降级。
 * 使用方：import { safeStorage } from "../lib/safeStorage";
 */
export const safeStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, val: string): void {
    try {
      window.localStorage.setItem(key, val);
    } catch {
      /* 隐私模式 / 配额超限 / 被禁用 — 静默忽略 */
    }
  },
  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  },
};
