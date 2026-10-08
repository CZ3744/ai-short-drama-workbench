/**
 * lastUsedRegistry.ts — 通用 "上次使用 X" 持久化 factory
 *
 * 解耦 2026-05-20 P2: lastUsedModel / lastUsedSeriesDefaults 形态相同，
 * 统一抽到这里，两个 caller 改成 factory 调用。
 *
 * 两种用法:
 *   A) 单 key:
 *      const reg = createLastUsed<MyType>({ storageKey: "my-key", serialize, deserialize });
 *      reg.get()         → MyType | null
 *      reg.set(val)
 *      reg.clear()
 *
 *   B) 多 key (prefix + discriminant):
 *      const reg = createLastUsedByKey<K, V>({ keyPrefix: "prefix.", validKeys, serialize, deserialize });
 *      reg.get(key)      → V | null
 *      reg.set(key, val)
 *      reg.clear(key)
 *
 * 序列化: 默认假设 V = string (直存)。传 serialize/deserialize 可存 JSON 对象。
 *
 * 红线: 只做 UX 建议用途, 不参与任何真实生成决策。
 */

import { safeStorage } from "./safeStorage";

// ── 单 key 模式 ────────────────────────────────────────────────────────────

export interface SingleKeyOpts<V> {
  storageKey: string;
  /** 存入 localStorage 前的序列化 (默认: String(v)) */
  serialize?: (v: V) => string;
  /** 从 localStorage 读出后的反序列化 (默认: raw as unknown as V) */
  deserialize?: (raw: string) => V;
}

export interface SingleKeyRegistry<V> {
  get(): V | null;
  set(v: V): void;
  clear(): void;
}

export function createLastUsed<V>(opts: SingleKeyOpts<V>): SingleKeyRegistry<V> {
  const { storageKey, serialize, deserialize } = opts;
  const ser: (v: V) => string = serialize ?? ((v) => String(v));
  const des: (raw: string) => V = deserialize ?? ((raw) => raw as unknown as V);
  return {
    get(): V | null {
      const raw = safeStorage.getItem(storageKey);
      if (raw === null) return null;
      try { return des(raw); } catch { return null; }
    },
    set(v: V): void {
      safeStorage.setItem(storageKey, ser(v));
    },
    clear(): void {
      safeStorage.removeItem(storageKey);
    },
  };
}

// ── 多 key (prefix) 模式 ──────────────────────────────────────────────────

export interface PrefixKeyOpts<K extends string, V> {
  keyPrefix: string;
  /** 可选: 枚举合法 key 集合, 传入不在集合中的 key 时静默返回 null/不写 */
  validKeys?: readonly K[];
  serialize?: (v: V) => string;
  deserialize?: (raw: string) => V;
}

export interface PrefixKeyRegistry<K extends string, V> {
  get(key: K): V | null;
  set(key: K, v: V): void;
  clear(key: K): void;
}

export function createLastUsedByKey<K extends string, V>(
  opts: PrefixKeyOpts<K, V>,
): PrefixKeyRegistry<K, V> {
  const { keyPrefix, validKeys, serialize, deserialize } = opts;
  const ser: (v: V) => string = serialize ?? ((v) => String(v));
  const des: (raw: string) => V = deserialize ?? ((raw) => raw as unknown as V);

  function isValid(k: string): k is K {
    if (!validKeys) return true;
    return (validKeys as readonly string[]).includes(k);
  }

  return {
    get(key: K): V | null {
      if (!isValid(key)) return null;
      const raw = safeStorage.getItem(keyPrefix + key);
      if (raw === null) return null;
      try { return des(raw); } catch { return null; }
    },
    set(key: K, v: V): void {
      if (!isValid(key)) return;
      safeStorage.setItem(keyPrefix + key, ser(v));
    },
    clear(key: K): void {
      if (!isValid(key)) return;
      safeStorage.removeItem(keyPrefix + key);
    },
  };
}
