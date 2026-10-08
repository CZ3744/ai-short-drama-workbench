/**
 * deriveMentionIds — 从 shot.*_nodes 富文本节点回算 character_ids / scene_id / element_ids.
 *
 * 背景 (2026-05-22 P0-B):
 *   shot.action_nodes / dialogue_nodes / voiceover_nodes / prompt_img_nodes / prompt_vid_nodes
 *   是 entity-first 主真理源 (每个 mention 节点带 entity_id + kind), 用户在 ScriptCanvas /
 *   ShotStage 改 mention (例: 加新角色 @林晚) 时 PATCH 这些 nodes.
 *
 *   但 PATCH /shots/:id 路径之前不重算 character_ids / element_ids / scene_id, 导致:
 *     - shot.action_nodes 含新 mention (entity_id=char_xxx, kind=character)
 *     - shot.character_ids 仍是老的, 不含 char_xxx
 *     - orchestrator 生图收参考图用 character_ids → silent 漏掉新角色
 *   主仓库扫描结果: 60 shots 中 33 个 character_ids=[] 但 nodes 含 character mention.
 *
 * 设计:
 *   - 纯函数, 输入 nodes 集合, 输出 { character_ids, scene_id, element_ids }
 *   - mention.kind === "character" → character_ids
 *   - mention.kind === "scene" → 单 scene_id (取第一个出现的, 不覆盖已 explicit set 的)
 *   - mention.kind === "element" → element_ids
 *   - 去重 (entity_id 唯一)
 *   - 老 nodes 缺 entity_id 时 silent skip (兼容老数据)
 *
 * 用法 (PATCH /shots/:id):
 *   1) 检查 PATCH body 是否含任一 *_nodes 字段
 *   2) 命中 → merge 老 shot + 新 PATCH 得到完整 nodes 集合
 *   3) 调 deriveMentionIdsFromNodes 算出新 character_ids / scene_id / element_ids
 *   4) 写入 patchData (覆盖用户传的 character_ids 等, 因为 nodes 是真理源)
 *
 * 另: scripts/migrate-derive-mention-ids.ts 用相同函数批量补主仓库 33 个 broken shot.
 */

import type { ShotTextNode } from "../../../../../packages/drama/src/types";

export interface DerivedMentionIds {
  character_ids: string[];
  scene_id: string | null;
  element_ids: string[];
}

/**
 * 从一组 nodes 数组里抽 mention, 按 kind 分组返回 id 数组.
 *
 * @param nodesGroups 多个 nodes 数组 (action_nodes / dialogue_nodes / voiceover_nodes / prompt_img_nodes / prompt_vid_nodes)
 *                    传 undefined 数组 silent skip.
 * @returns 去重后的 ids. scene_id 仅取第一个出现的 (避免一镜多场景).
 */
export function deriveMentionIdsFromNodes(
  ...nodesGroups: Array<ShotTextNode[] | undefined>
): DerivedMentionIds {
  const charIds = new Set<string>();
  const elemIds = new Set<string>();
  let firstSceneId: string | null = null;

  for (const nodes of nodesGroups) {
    if (!Array.isArray(nodes)) continue;
    for (const n of nodes) {
      if (!n || n.type !== "mention") continue;
      const eid = (n as { entity_id?: unknown }).entity_id;
      const kind = (n as { kind?: unknown }).kind;
      if (typeof eid !== "string" || !eid.trim()) continue;
      if (kind === "character") {
        charIds.add(eid);
      } else if (kind === "scene") {
        if (!firstSceneId) firstSceneId = eid;
      } else if (kind === "element") {
        elemIds.add(eid);
      }
    }
  }

  return {
    character_ids: Array.from(charIds),
    scene_id: firstSceneId,
    element_ids: Array.from(elemIds),
  };
}

/**
 * 给 PATCH /shots/:id 用: 检查 PATCH 是否动了任一 *_nodes, 动了就回算 ids.
 *
 * @param existing 已存盘的 ShotData (可能 partial), 提供未在 PATCH 里改的 nodes 字段.
 * @param patch 用户 PATCH body, 可能含 0~5 个 *_nodes 字段 + 用户显式传的 character_ids 等.
 * @returns 补 patch (含 character_ids / scene_id / element_ids), 没 *_nodes patch 时返回空 {}.
 *
 * 决策 (2026-05-27 修正 — 之前"nodes derive 胜出"是错的):
 *   - 任一 *_nodes 字段被 patch → derive 出 character_ids / scene_id / element_ids
 *   - **用户显式 patch 了某 ids 字段 → 尊重用户值** (即使是空数组, 也是用户取消勾选意图)
 *   - 未显式 patch 该 ids 字段 → 走 derive 兜底 (entity-first nodes 是真理源)
 *
 * 为啥改: shotText.plainTextToNodes 第 3 阶段裸 name 兜底识别会把 action 文本里
 * 出现的角色名都 parse 成 mention 节点 (例 "酸奶队长打开冰箱" → mention=酸奶队长).
 * 用户 LibraryConnectPanel 取消勾选林深 → saveAction 传 character_ids:[] + 5 个
 * _nodes (含林深裸 mention) → 老逻辑 derive 又把林深加回 → 用户感受"我明明取消了".
 *
 * 没 *_nodes patch → 不动 (用户单独 PATCH character_ids 是兼容老用法).
 */
export function applyDerivedMentionIdsToPatch(
  existing: {
    action_nodes?: ShotTextNode[];
    dialogue_nodes?: ShotTextNode[];
    voiceover_nodes?: ShotTextNode[];
    prompt_img_nodes?: ShotTextNode[];
    prompt_vid_nodes?: ShotTextNode[];
  },
  patch: {
    action_nodes?: ShotTextNode[];
    dialogue_nodes?: ShotTextNode[];
    voiceover_nodes?: ShotTextNode[];
    prompt_img_nodes?: ShotTextNode[];
    prompt_vid_nodes?: ShotTextNode[];
    character_ids?: string[];
    scene_id?: string;
    element_ids?: string[];
  },
): Partial<DerivedMentionIds> {
  const touched =
    "action_nodes" in patch ||
    "dialogue_nodes" in patch ||
    "voiceover_nodes" in patch ||
    "prompt_img_nodes" in patch ||
    "prompt_vid_nodes" in patch;
  if (!touched) return {};

  // merge: patch 优先, 没传的字段保留 existing 老 nodes (保证完整覆盖矩阵)
  const merged = {
    action_nodes: patch.action_nodes ?? existing.action_nodes,
    dialogue_nodes: patch.dialogue_nodes ?? existing.dialogue_nodes,
    voiceover_nodes: patch.voiceover_nodes ?? existing.voiceover_nodes,
    prompt_img_nodes: patch.prompt_img_nodes ?? existing.prompt_img_nodes,
    prompt_vid_nodes: patch.prompt_vid_nodes ?? existing.prompt_vid_nodes,
  };

  const derived = deriveMentionIdsFromNodes(
    merged.action_nodes,
    merged.dialogue_nodes,
    merged.voiceover_nodes,
    merged.prompt_img_nodes,
    merged.prompt_vid_nodes,
  );

  // 2026-05-27 — 用户显式 patch 某 ids 字段 = 真意图 (含空数组取消勾选). 不在 patch
  // 的字段才走 derive 兜底.
  const result: Partial<DerivedMentionIds> = {};
  if (!("character_ids" in patch)) result.character_ids = derived.character_ids;
  if (!("scene_id" in patch)) result.scene_id = derived.scene_id;
  if (!("element_ids" in patch)) result.element_ids = derived.element_ids;
  return result;
}
