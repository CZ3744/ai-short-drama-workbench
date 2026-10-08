import { create } from "zustand";
import useSWR from "swr";

export interface PresetItem {
  id: string;
  name: string;
  [key: string]: any;
}

export interface PresetsState {
  /** 按 dictId 分组的 preset 字典 */
  dicts: Record<string, PresetItem[]>;
  /** 已加载的 dictId 列表（用数组存储以确保 JSON 序列化正确） */
  loadedDictIds: string[];

  setDict: (dictId: string, items: PresetItem[]) => void;
  getDict: (dictId: string) => PresetItem[];
  /** 检查 dictId 是否已加载 */
  isLoaded: (dictId: string) => boolean;
}

/** P187: 稳定空数组引用，防止 getDict 每次返回新 [] 导致 useSyncExternalStore 无限重渲染 */
const EMPTY_DICT: PresetItem[] = [];

export const usePresetsStore = create<PresetsState>((set, get) => ({
  dicts: {},
  loadedDictIds: [],

  setDict: (dictId, items) =>
    set((state) => {
      if (state.loadedDictIds.includes(dictId)) {
        return { dicts: { ...state.dicts, [dictId]: items } };
      }
      return {
        dicts: { ...state.dicts, [dictId]: items },
        loadedDictIds: [...state.loadedDictIds, dictId],
      };
    }),

  getDict: (dictId) => get().dicts[dictId] ?? EMPTY_DICT,

  isLoaded: (dictId) => get().loadedDictIds.includes(dictId),
}));

/** 预加载指定 dictId 的 presets */
export function usePresets(dictId: string) {
  // 2026-07-22 X5-6 (A4-8): 原无 selector 整 state 解构会订阅整个 PresetsState(含 dicts 大对象),
  // 导致"加载运镜预设字典"的组件重渲染会连带影响"只关心转场预设字典"的另一个调用方。
  // setDict/isLoaded 是 store action, 引用本来就稳定, 拆两个单字段 selector 零成本(CLAUDE.md §7).
  const setDict = usePresetsStore((s) => s.setDict);
  const isLoaded = usePresetsStore((s) => s.isLoaded);
  return useSWR(
    dictId && !isLoaded(dictId) ? `/api/v2/presets/${dictId}` : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = Array.isArray(data) ? data : data.items ?? [];
      setDict(dictId, items);
      return items;
    },
    { revalidateOnFocus: false }
  );
}
