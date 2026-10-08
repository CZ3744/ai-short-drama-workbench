// 2026-05-21 — useToggleSet: 统一管理 Set<T> 状态.
//
// 项目内 11 处用 useState<Set<string>>(new Set()) 各自重写 add/delete 切换逻辑,
// 解耦信仰要求统一抽出.
//
// @example
//   const { ids, toggle, add, remove, has, clear, size, replace } = useToggleSet<string>();
//   <button onClick={() => toggle(itemId)} className={has(itemId) ? "active" : ""}>...</button>

import { useCallback, useState } from "react";

export interface ToggleSetApi<T> {
  ids: Set<T>;
  has: (id: T) => boolean;
  size: number;
  toggle: (id: T) => void;
  add: (id: T) => void;
  remove: (id: T) => void;
  clear: () => void;
  replace: (next: Iterable<T>) => void;
  toArray: () => T[];
}

export function useToggleSet<T>(initial?: Iterable<T>): ToggleSetApi<T> {
  const [ids, setIds] = useState<Set<T>>(() => new Set(initial));
  const has = useCallback((id: T) => ids.has(id), [ids]);
  const toggle = useCallback((id: T) => {
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const add = useCallback(
    (id: T) => setIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id))),
    [],
  );
  const remove = useCallback((id: T) => {
    setIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const clear = useCallback(() => setIds(new Set()), []);
  const replace = useCallback((next: Iterable<T>) => setIds(new Set(next)), []);
  const toArray = useCallback(() => Array.from(ids), [ids]);
  return { ids, has, size: ids.size, toggle, add, remove, clear, replace, toArray };
}
