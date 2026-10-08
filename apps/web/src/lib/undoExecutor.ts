/**
 * undoExecutor — 执行 undoStore 中记录的实际回滚操作
 *
 * undoStore 只记录操作上下文和标记 undone 状态，
 * 真正的回滚逻辑在此模块执行，调用对应的后端 API。
 */

import { useUndoStore, type UndoRecord, type UndoPayload, type DeleteCandidatePayload, type EditScriptPayload, type SwitchProviderPayload, type BatchGeneratePayload } from "../stores/undoStore";
import { apiPost, apiPatch } from "../lib/api";
import { useSessionStore } from "../stores/sessionStore";

/**
 * 执行一条 undo 记录的回滚操作。
 * 返回 true 表示回滚成功，false 表示回滚失败或已回滚。
 */
export async function executeUndo(record: UndoRecord): Promise<boolean> {
  if (record.undone) return false;

  try {
    switch (record.type) {
      case "delete_candidate":
        await undoDeleteCandidate(record.payload as DeleteCandidatePayload);
        break;
      case "edit_script":
        await undoEditScript(record.payload as EditScriptPayload);
        break;
      case "switch_provider":
        await undoSwitchProvider(record.payload as SwitchProviderPayload);
        break;
      case "batch_generate":
        await undoBatchGenerate(record.payload as BatchGeneratePayload);
        break;
      default: {
        const payloadType =
          record.payload && typeof record.payload === "object"
            ? (record.payload as { type?: unknown }).type
            : undefined;
        console.warn(`[undoExecutor] 未知操作类型: ${String(payloadType)}`);
        return false;
      }
    }

    // 回滚成功，标记 undone
    useUndoStore.getState().markUndone(record.id);
    return true;
  } catch (err) {
    console.error("[undoExecutor] 回滚失败:", err);
    return false;
  }
}

// ── 具体回滚实现 ──────────────────────────────────────────────

/** 恢复被删除的候选：调用 restore generation API */
async function undoDeleteCandidate(payload: DeleteCandidatePayload) {
  const { series_slug, episode_id, shot_id, generation_id } = payload;
  await apiPost(
    `/api/v2/series/${series_slug}/episodes/${episode_id}/shots/${shot_id}/generations/${generation_id}/restore`
  );
}

/** 回滚剧本/分镜编辑：用 before_snapshot 中的字段值调 patch API */
async function undoEditScript(payload: EditScriptPayload) {
  const { series_slug, episode_id, shot_id, before_snapshot } = payload;
  await apiPatch(
    `/api/v2/series/${series_slug}/episodes/${episode_id}/shots/${shot_id}`,
    before_snapshot
  );
}

/** 回滚 provider 切换：恢复到之前的 provider 设置 */
async function undoSwitchProvider(payload: SwitchProviderPayload) {
  const { category, previous_value } = payload;
  // 通过 sessionStore 恢复 provider 设置
  const store = useSessionStore.getState();
  store.setProvider(category, previous_value);
}

/** 回滚批量生成：将这批生成的候选全部移入废案箱 */
async function undoBatchGenerate(payload: BatchGeneratePayload) {
  const { generation_ids, series_slug, episode_id, shot_ids } = payload;
  // 逐个移入废案箱（非阻塞，一个失败不影响其他）
  const results = await Promise.allSettled(
    generation_ids.map((genId, i) => {
      const shotId = shot_ids[i] || shot_ids[0];
      return apiPost(
        `/api/v2/series/${series_slug}/episodes/${episode_id}/shots/${shotId}/generations/${genId}/trash`
      );
    })
  );
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    console.warn(`[undoExecutor] 批量废案部分失败: ${failures.length}/${results.length}`);
  }
}
