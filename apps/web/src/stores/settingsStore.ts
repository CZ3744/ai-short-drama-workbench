import { create } from "zustand";
import { persist } from "zustand/middleware";

// 2026-05-28 P1-2: 删除 5 个死字段 + setter (locale / theme / sidebarCollapsed /
// autoSaveInterval / recentSeriesIds). 全项目无 caller, persist schema bump 到 v2,
// 老 localStorage 数据走 migrate 函数, 只保留 nightBatch.

export interface NightBatchSettings {
  /** 是否启用夜间批处理 */
  enabled: boolean;
  /** 开始时间 (HH:mm) */
  start: string;
  /** 结束时间 (HH:mm) */
  end: string;
  /** 自动推进到下一个人工 gate（跳过 picked 挑卡，系统自动选质量分最高的） */
  autoAdvanceToGate: boolean;
}

export type ThemeMode = "light" | "dark" | "system";

export interface SettingsState {
  /** 夜间批处理设置 */
  nightBatch: NightBatchSettings;
  /** 主题模式: 明亮 / 暗黑 / 跟随系统 */
  theme: ThemeMode;

  setNightBatch: (patch: Partial<NightBatchSettings>) => void;
  setTheme: (theme: ThemeMode) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      nightBatch: {
        enabled: false,
        start: "23:00",
        end: "07:00",
        autoAdvanceToGate: true,
      },
      theme: "system" as ThemeMode,

      setNightBatch: (patch) =>
        set((s) => ({ nightBatch: { ...s.nightBatch, ...patch } })),
      setTheme: (theme) => set({ theme }),
    }),
    {
      // 2026-05-28 audit P2: 统一 localStorage 命名前缀 video-generate.* (跟 tasksStore 一致).
      // zustand persist 老 key "studio-settings" 已废弃, 老数据走默认初始化 (单机本地工作台
      // 偶尔丢一次夜批排程设置可接受). 不写 alias 因为 zustand persist API 不支持读多 key.
      name: "video-generate.settings.studio.v3",
      version: 3,
      migrate: (persisted: any, version: number) => {
        // P1-2: version 0/1 → 2: 删 5 个死字段, 老数据仅保留 nightBatch
        if (version < 2) {
          return {
            nightBatch: {
              enabled: persisted?.nightBatch?.enabled ?? false,
              start: persisted?.nightBatch?.start ?? "23:00",
              end: persisted?.nightBatch?.end ?? "07:00",
              autoAdvanceToGate: persisted?.nightBatch?.autoAdvanceToGate ?? true,
            },
            theme: "system" as ThemeMode,
          };
        }
        // version 2 → 3: 新增 theme 字段
        if (version < 3) {
          return {
            ...persisted,
            theme: "system" as ThemeMode,
          };
        }
        return persisted;
      },
    }
  )
);
