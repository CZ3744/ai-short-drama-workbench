import { create } from "zustand";
import { useTasksStore } from "./tasksStore";

/** 系列元数据 */
export interface SeriesMeta {
  slug: string;
  title: string;
  description?: string;
  coverUrl?: string;
  episodeCount: number;
  totalCost: number; // 分
  updatedAt: string;
}

/** Provider chain state (used by useProviderChain) */
export interface ProviderChainState {
  active: string | null;
  chain: string[];
  overridden: boolean;
}

export interface SessionState {
  /** 当前系列 slug */
  currentSeriesSlug: string | null;
  /** 当前集 ID */
  currentEpisodeId: string | null;
  /** 当前 provider 选择 */
  providers: {
    llm: string;
    image: string;
    video: string;
    tts: string;
  };
  /** Provider 链状态（用于 fallback 追踪） */
  chainState: ProviderChainState;
  /** 当前活动的 job */
  activeJobId: string | null;
  /** 设置 drawer 是否打开 */
  settingsOpen: boolean;
  /** 系列列表(从 API 拉取后缓存) */
  seriesList: SeriesMeta[];
  /** 系列累计花费(分) */
  seriesCost: number;
  /** 分镜列表视图模式 */
  shotboardViewMode: "list" | "card";

  setCurrentSeries: (slug: string | null) => void;
  setCurrentEpisode: (id: string | null) => void;
  setProvider: (category: keyof SessionState["providers"], value: string) => void;
  setChainState: (next: ProviderChainState | ((prev: ProviderChainState) => ProviderChainState)) => void;
  setActiveJob: (id: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setSeriesList: (list: SeriesMeta[]) => void;
  setSeriesCost: (cost: number) => void;
  addSeriesCost: (delta: number) => void;
  setShotboardViewMode: (mode: "list" | "card") => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  currentSeriesSlug: null,
  currentEpisodeId: null,
  providers: {
    llm: "ikuncode_gpt55",
    image: "local_sdxl_openclaw",
    video: "local_mock_video",
    tts: "edge_tts",
  },
  chainState: { active: null, chain: [], overridden: false },
  activeJobId: null,
  settingsOpen: false,
  seriesList: [],
  seriesCost: 0,
  shotboardViewMode: "card",

  setCurrentSeries: (slug) => {
    // 2026-05-27 — 不再 clearAll() — 用户原话: "点击生成之后退出重进, 占位生成中又没了".
    // 之前 setCurrentSeries 会调 useTasksStore.clearAll(), 把 localStorage 里所有
    // task 全清掉, 包括用户当前正在跑的 task. 路径: 用户进 ShotStagePage 点生成 →
    // task 入 localStorage. 用户跳到 SeriesDetail / ProjectSwitcher 触发 setCurrentSeries
    // → clearAll → localStorage 清空 → 返回 ShotStagePage 时占位没了.
    //
    // tasks 是按 task_id 索引的, 不会跨 series 互冲. 显示时按 series_slug filter / group
    // 就够用, 不需要清整个 store. 让 TTL (45min queued/running, 30min terminal) 自然过期.
    set({ currentSeriesSlug: slug, currentEpisodeId: null, seriesCost: 0 });
  },
  setCurrentEpisode: (id) => set({ currentEpisodeId: id }),
  setProvider: (category, value) =>
    set((state) => ({
      providers: { ...state.providers, [category]: value },
    })),
  setChainState: (next) =>
    set((state) => ({
      chainState: typeof next === "function" ? next(state.chainState) : next,
    })),
  setActiveJob: (id) => set({ activeJobId: id }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSeriesList: (list) => set({ seriesList: list }),
  setSeriesCost: (cost) => set({ seriesCost: cost }),
  addSeriesCost: (delta) => set((state) => ({ seriesCost: state.seriesCost + delta })),
  setShotboardViewMode: (mode) => set({ shotboardViewMode: mode }),
}));
