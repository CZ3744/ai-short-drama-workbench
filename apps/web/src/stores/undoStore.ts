import { create } from "zustand";
import { persist } from "zustand/middleware";

// ── Operation types ───────────────────────────────────────────────

export type UndoOpType =
  | "delete_candidate"   // 删候选 → 从 vault trash 恢复
  | "edit_script"        // 改剧本 → version 时间线回滚
  | "switch_provider"    // 切 provider → 恢复设置
  | "batch_generate";    // 批量生成 → 标记这批候选为 trashed

export interface UndoRecord {
  /** 唯一 ID */
  id: string;
  /** 操作类型 */
  type: UndoOpType;
  /** 人类可读的描述 */
  label: string;
  /** 操作时间 ISO */
  timestamp: string;
  /** 操作上下文 — 不同 type 对应不同 payload */
  payload: UndoPayload;
  /** 是否已回滚 */
  undone: boolean;
}

// ── Payload per type ──────────────────────────────────────────────

export interface DeleteCandidatePayload {
  series_slug: string;
  episode_id: string;
  shot_id: string;
  generation_id: string;
}

export interface EditScriptPayload {
  series_slug: string;
  episode_id: string;
  shot_id: string;
  /** 操作前的字段值快照 */
  before_snapshot: Record<string, unknown>;
}

export interface SwitchProviderPayload {
  category: "llm" | "image" | "video" | "tts";
  previous_value: string;
  new_value: string;
}

export interface BatchGeneratePayload {
  /** 本次批量生成产出的 generation_ids，回滚时全部 trash */
  generation_ids: string[];
  series_slug: string;
  episode_id: string;
  shot_ids: string[];
}

export type UndoPayload =
  | DeleteCandidatePayload
  | EditScriptPayload
  | SwitchProviderPayload
  | BatchGeneratePayload;

// ── Store state ───────────────────────────────────────────────────

export interface UndoState {
  /** 最多保留 20 条 */
  records: UndoRecord[];

  /** 记录一条新操作 */
  push: (record: Omit<UndoRecord, "id" | "timestamp" | "undone">) => string;

  /** 标记某条已回滚 */
  markUndone: (id: string) => void;

  /** 清空全部记录 */
  clear: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────

function genId(): string {
  return `undo_${crypto.randomUUID()}`;
}

// ── Store ─────────────────────────────────────────────────────────

export const useUndoStore = create<UndoState>()(
  persist(
    (set) => ({
      records: [],

      push: (record) => {
        const id = genId();
        const newRecord: UndoRecord = {
          ...record,
          id,
          timestamp: new Date().toISOString(),
          undone: false,
        };
        set((state) => {
          // 保留最新 20 条（含已回滚的，方便用户查看历史）
          const next = [newRecord, ...state.records].slice(0, 20);
          return { records: next };
        });
        return id;
      },

      markUndone: (id) =>
        set((state) => ({
          records: state.records.map((r) =>
            r.id === id ? { ...r, undone: true } : r
          ),
        })),

      clear: () => set({ records: [] }),
    }),
    { name: "undo-history" }
  )
);
