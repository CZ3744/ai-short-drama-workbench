import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface CreationSettings {
  content_type: string;
  platform: string;
  aspect_ratio: string;
  visual_style: string;
  audience: string;
  tone: string;
  pace: string;
  camera_style: string;
  ending_type: string;
  episode_count: number;
  episode_duration: string;
  /** 当 episode_duration === "custom" 时使用,单位秒 */
  episode_duration_sec?: number;
  llm: string;
  llm_provider_id?: string;
  /** X7: 专项 LLM 选择 — 按任务分别指定模型 */
  llm_storyboard_planner?: string;
  llm_entity_extractor?: string;
  llm_composer?: string;
}

const DEFAULT_SETTINGS: CreationSettings = {
  content_type: "short_drama",
  platform: "douyin",
  aspect_ratio: "9:16",
  visual_style: "comic",
  audience: "general",
  tone: "sweet",
  pace: "normal",
  camera_style: "vertical_narrative",
  ending_type: "cliffhanger",
  episode_count: 1,
  episode_duration: "60s",
  llm: "",
};

export interface InboxState {
  /** 灵感文本 */
  inspiration: string;
  /** 标题（可选） */
  title: string;
  /** 上传的文件列表 */
  uploadedFiles: Array<{ name: string; size: number; type: string; text?: string }>;
  /** 当前创作设置（本地暂存，不立即写回 series.defaults） */
  settings: CreationSettings;
  /** 是否正在生成 */
  generating: boolean;
  /** 当前模板名称 */
  currentTemplateName: string | null;

  setInspiration: (text: string) => void;
  setTitle: (title: string) => void;
  addUploadedFile: (file: { name: string; size: number; type: string; text?: string }) => void;
  removeUploadedFile: (index: number) => void;
  updateSetting: <K extends keyof CreationSettings>(key: K, value: CreationSettings[K]) => void;
  batchUpdateSettings: (settings: Partial<CreationSettings>) => void;
  setGenerating: (generating: boolean) => void;
  setCurrentTemplateName: (name: string | null) => void;
  loadFromSeriesDefaults: (defaults: Partial<CreationSettings>) => void;
  reset: () => void;
}

export const useInboxStore = create<InboxState>()(
  persist(
    (set) => ({
      inspiration: "",
      title: "",
      uploadedFiles: [],
      settings: { ...DEFAULT_SETTINGS },
      generating: false,
      currentTemplateName: null,

      setInspiration: (text) => set({ inspiration: text }),
      setTitle: (title) => set({ title }),
      addUploadedFile: (file) =>
        set((state) => ({ uploadedFiles: [...state.uploadedFiles, file] })),
      removeUploadedFile: (index) =>
        set((state) => ({ uploadedFiles: state.uploadedFiles.filter((_, i) => i !== index) })),
      updateSetting: (key, value) =>
        set((state) => ({ settings: { ...state.settings, [key]: value } })),
      batchUpdateSettings: (partial) =>
        set((state) => ({ settings: { ...state.settings, ...partial } })),
      setGenerating: (generating) => set({ generating }),
      setCurrentTemplateName: (name) => set({ currentTemplateName: name }),
      loadFromSeriesDefaults: (defaults) =>
        set((state) => ({ settings: { ...state.settings, ...defaults } })),
      reset: () =>
        set({
          inspiration: "",
          title: "",
          uploadedFiles: [],
          settings: { ...DEFAULT_SETTINGS },
          generating: false,
          currentTemplateName: null,
        }),
    }),
    {
      // 2026-05-28 audit P2: 统一 localStorage 命名前缀 video-generate.* (跟 tasksStore 一致).
      // 此 store 是首页创作 settings 暂存, 跟 InboxPage 的 inbox-draft (灵感草稿) 不同语义,
      // 改名后 zustand persist 读不到老 key 会走默认初始值, 用户角色单机一次性丢可接受.
      name: "video-generate.inbox.series-defaults.v1",
      partialize: (state) => ({
        inspiration: state.inspiration,
        settings: state.settings,
      }),
    }
  )
);
