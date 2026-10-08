/**
 * implicitReferenceCollector — Wave B-2 (2026-05-16); 2026-05-26 W1 加角色组合性 (wardrobe/prop).
 *
 * 一句话: 给一条分镜, 把它引用的 character / scene / element 的"主图"
 *         自动收集成可作生图模型 reference_images 的列表 + 给前端展示用的人类可读元数据.
 *
 * ── 产品依据 ─────────────────────────────────────────────────────────
 *
 * 用户原话 (USER_FEEDBACK_2026-05-16 §2): "我提的勾选素材库图片作为参考图给生图模型 —
 * 这就是治本方案". 进一步推: 用户每个 shot 引用了 character / scene, 系统应该自动把
 * 这些素材的主图作 reference 传给生图模型, 不需要用户在分镜创作时再次手选.
 *
 * 2026-05-26 W1 — 角色组合性 (wardrobe/prop):
 * 用户原话 (素材一致性评估 §改进路线 A): "character → wardrobe / prop 持有关系".
 * character.wardrobe_element_ids[] 让角色绑定 N 套服装造型, character.prop_element_ids[]
 * 让角色常带 N 件道具; shot.wardrobe_id 让分镜选本镜穿哪套, shot.prop_ids 加本镜额外道具.
 * 隐式 reference 时, 这些 element 的主图自动跟随相关 character 进入参考集.
 *
 * ── 设计契约 (任务约束) ───────────────────────────────────────────────
 *
 * 1. 后端不做"silent 隐式注入" — 后端 generate endpoint 只接收 caller (前端) 传来的
 *    最终 reference_images, 不在生图链路里偷偷塞主图.
 *
 * 2. 每个 element 在单镜内只用 1 张图作 reference (2026-05-20 用户红线):
 *    "同时输出多张图片那视频模型能明白吗, 到底用哪张每个地方只用特定的一张, 没选的话默认主图".
 *    所以 wardrobe / prop 加进来后还是每个 element 单张主图; override 走 shot.reference_overrides.
 *
 * 3. 去重: 同一 element_id 不论从哪条路径进 (角色道具 vs 本镜道具 vs 显式 element_ids)
 *    只出现 1 次. source 字段记录"第一次拉进来的角色"用于前端分组展示.
 *
 * 4. 解耦边界 (memory/feedback_decoupling.md):
 *    - 不 import shotStageController (controller 来 import 它, 单向)
 *    - 不修改 character/scene/element repo, 只 read
 *    - 加新 source kind 时只动本文件, controller / 前端 fallback 处理未知 source 字符串
 */

import { readCharacter, readScene } from "../../api/v2/seriesStore";
import { readAnyElement } from "../../api/v2/elementController.helpers";
import { readEffectiveElement } from "../cast/effectiveElements";
import { resolveTypicalImages } from "../../repositories/elementRepo";
import type { ShotData } from "../../api/v2/seriesStore";

/**
 * 一条"系统建议"的参考图.
 *
 * source 取值 (2026-05-26 W1 扩):
 *   - character_primary: 角色主图
 *   - character_wardrobe: 角色本镜穿的服装造型主图 (W1 新)
 *   - character_prop: 角色常带的道具主图 (W1 新)
 *   - scene_primary: 场景主图
 *   - element_primary: shot.element_ids[] 引用的素材主图
 *   - shot_prop: 本镜独立道具主图 (W1 新, 与 shot.prop_ids 对应)
 */
export interface SuggestedReference {
  /** 后端 ImageInputRef 用 — 真正定位到 vault/asset 的 key */
  asset_id: string;
  /** 缩略图 URL — 前端 PromptReviewModal 显示用 */
  url: string;
  /** 缩略图小尺寸 URL (可选) */
  thumbnail_url?: string;
  /** 人类可读标签 — 显示在缩略图下方 */
  label: string;
  /** 来源种类 — 用于前端筛选 / 显示分组 */
  source:
    | "character_primary"
    | "character_wardrobe"
    | "character_prop"
    | "scene_primary"
    | "element_primary"
    | "shot_prop";
  /** 来源对象 id (W1 后: character_wardrobe 时是 wardrobe element id 不是 character id) */
  source_id: string;
  /** 来源对象人类可读名 */
  source_name: string;
}

/** 内部上下文 — 单字段精简 */
interface CollectInput {
  character_ids?: string[];
  scene_id?: string;
  element_ids?: string[];
  /** 2026-05-26 W1: 本镜出场角色穿的服装造型 element id (kind=wardrobe), 覆盖角色默认 */
  wardrobe_id?: string;
  /** 2026-05-26 W1: 本镜独立出现的道具 element id 列表 (kind=prop) */
  prop_ids?: string[];
}

/**
 * 主图资产 url 生成 — 与 elementController.helpers.assetUrl 保持一致.
 */
function assetThumbnailUrl(slug: string, assetId: string, size: 512 | 256 = 512): string {
  return `/api/v2/series/${slug}/assets/${assetId}/thumbnail?size=${size}`;
}

/** 主图 vault url 生成 — element 用 vault_id 时走这条 */
function vaultThumbnailUrl(vaultId: string): string {
  return `/api/v2/vault/${vaultId}/thumbnail`;
}

/**
 * 2026-05-26 W1 — 内部 helper: 拉一个 element 的代表图集合作 SuggestedReference.
 *
 * 复用于:
 *   - character_wardrobe (角色服装造型)
 *   - character_prop (角色常带道具)
 *   - element_primary (shot.element_ids)
 *   - shot_prop (shot.prop_ids 本镜额外道具)
 *
 * 2026-05-26 Fix 6 — 改为 typical pool 全部图 (用户标 3 张"老张笑/哭/西服"必须全进):
 *   1. 走 resolveTypicalImages — is_typical=true 的全部图
 *   2. 一张都没 → fallback primary_image_id 单张
 *   3. 都没 → 返空数组 (caller 跳过)
 *
 * caller 直接 spread 到 refs 列表里, 跨镜表情/服装变体不再丢.
 */
async function collectElementPrimaryRefs(
  slug: string,
  elementId: string,
  source: SuggestedReference["source"],
  contextHint: string,
): Promise<SuggestedReference[]> {
  try {
    // W4: 先 series local (readAnyElement 含 character/scene legacy), 没的话 fallback cast member
    let el = await readAnyElement(slug, elementId);
    if (!el) {
      const eff = await readEffectiveElement(slug, elementId);
      if (eff) el = eff;
    }
    if (!el) return [];
    if (!el.images || el.images.length === 0) return [];

    // 2026-05-26 Fix 6 — 走 typical pool, 用户标 N 张全进; 无 typical 时 fallback primary 1 张
    const typicalImages = resolveTypicalImages(el);
    if (typicalImages.length === 0) return [];

    const kindLabel = (() => {
      switch (source) {
        case "character_wardrobe":
          return contextHint ? `角色「${contextHint}」服装` : "服装";
        case "character_prop":
          return contextHint ? `角色「${contextHint}」道具` : "道具";
        case "shot_prop":
          return "本镜道具";
        case "element_primary":
        default: {
          const kindMap: Record<string, string> = {
            character: "角色",
            scene: "场景",
            prop: "道具",
            wardrobe: "服装",
            reference: "参考",
            misc: "素材",
          };
          return `${kindMap[el.kind] ?? "素材"}`;
        }
      }
    })();
    const elementName = el.name ?? elementId;

    const results: SuggestedReference[] = [];
    for (const img of typicalImages) {
      const displayName = img.display_name?.trim();
      const isOnlyPrimary = typicalImages.length === 1 && img.image_id === el.primary_image_id;
      const baseLabel = isOnlyPrimary
        ? `${kindLabel}「${elementName}」主图`
        : `${kindLabel}「${elementName}」代表图`;
      const label = displayName ? `${baseLabel}:${displayName}` : baseLabel;
      // source_id 用 elementId, 但 typical pool 多张时 caller 不能再用 source_id 去重 (会丢图).
      // 改用 asset_id+image_id 复合去重 (由 caller 处理).
      if (img.asset_id) {
        results.push({
          asset_id: img.asset_id,
          url: assetThumbnailUrl(slug, img.asset_id, 512),
          thumbnail_url: assetThumbnailUrl(slug, img.asset_id, 256),
          label,
          source,
          source_id: elementId,
          source_name: elementName,
        });
      } else if (img.vault_id) {
        results.push({
          asset_id: img.vault_id,
          url: vaultThumbnailUrl(img.vault_id),
          thumbnail_url: vaultThumbnailUrl(img.vault_id),
          label,
          source,
          source_id: elementId,
          source_name: elementName,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 收集分镜引用的所有"主图"建议参考图.
 *
 * 收集顺序 (顺序对前端分组渲染有意义, 用户最大痛点是人物一致性 → 角色靠前):
 *   1. characters[i] 主图
 *   2. characters[i] 服装造型 (shot.wardrobe_id 显式 > character.wardrobe_element_ids[0]) — W1 新
 *   3. characters[i] 常带道具 (character.prop_element_ids[*]) — W1 新
 *   4. scene 主图
 *   5. shot.element_ids 引用素材主图
 *   6. shot.prop_ids 本镜独立道具 — W1 新
 *
 * 去重: 同一 element_id 不论被哪条路径拉到只出现 1 次 (后到的不覆盖先到的 source).
 */
export async function collectImplicitReferences(
  slug: string,
  input: CollectInput,
): Promise<SuggestedReference[]> {
  const refs: SuggestedReference[] = [];
  // 2026-05-26 Fix 6 — typical pool 可让同 element 出多张图, 去重 key 改为 asset_id.
  // 不同 element 同 asset_id (legacy 数据共享同一张) 仍只算 1 次, 避免给模型重复输入.
  const seenAssetIds = new Set<string>();
  const seenSourceIds = new Set<string>();

  function pushUnique(ref: SuggestedReference | null) {
    if (!ref) return;
    if (seenAssetIds.has(ref.asset_id)) return;
    seenAssetIds.add(ref.asset_id);
    refs.push(ref);
  }

  function pushMany(refsList: SuggestedReference[]) {
    for (const r of refsList) pushUnique(r);
    if (refsList[0]) seenSourceIds.add(refsList[0].source_id);
  }

  // 1) characters — 主图 + 服装 + 道具 (W1)
  for (const cid of input.character_ids ?? []) {
    try {
      // 2026-05-26 Fix 7 — series-local 没找到时, 走 readEffectiveElement (cast member fallback).
      // 跨剧引用 Cast member 时, c=null 但 cast 里仍有该角色主图, 不该 silent skip.
      const c = await readCharacter(slug, cid);
      const eff = c ? null : await readEffectiveElement(slug, cid);
      // c 提供 character 专属字段 (wardrobe_element_ids/prop_element_ids/locked_seed);
      // eff 仅有 ElementData (主图/typical pool) — cast 路径丢失这些字段是 W7 设计简化.
      if (!c && !eff) continue;

      const charName = c?.name ?? eff?.name ?? cid;

      // 1a) character 主图 + typical pool
      // 2026-05-26 Fix 6 — 走 readAnyElement / readEffectiveElement 拿 ElementData 视图, 用 typical pool
      if (!seenSourceIds.has(cid)) {
        const charRefs = await collectElementPrimaryRefs(slug, cid, "character_primary", charName);
        if (charRefs.length > 0) {
          pushMany(charRefs);
        } else if (c?.primary_ref_image_id && !seenAssetIds.has(c.primary_ref_image_id)) {
          // legacy fallback: character.primary_ref_image_id (旧数据无 element images 时)
          seenAssetIds.add(c.primary_ref_image_id);
          seenSourceIds.add(cid);
          refs.push({
            asset_id: c.primary_ref_image_id,
            url: assetThumbnailUrl(slug, c.primary_ref_image_id, 512),
            thumbnail_url: assetThumbnailUrl(slug, c.primary_ref_image_id, 256),
            label: `角色「${charName}」主图`,
            source: "character_primary",
            source_id: cid,
            source_name: charName,
          });
        }
      }

      // 1b) W1 — 该角色本镜穿的服装造型 (仅 series-local character 有这些字段; cast 路径跳过)
      const wardrobeId =
        (input.wardrobe_id && input.wardrobe_id.trim()) ||
        (c?.wardrobe_element_ids && c.wardrobe_element_ids[0]) ||
        undefined;
      if (wardrobeId && !seenSourceIds.has(wardrobeId)) {
        const wardrobeRefs = await collectElementPrimaryRefs(
          slug,
          wardrobeId,
          "character_wardrobe",
          charName,
        );
        pushMany(wardrobeRefs);
      }

      // 1c) W1 — 该角色常带道具
      for (const propId of c?.prop_element_ids ?? []) {
        if (seenSourceIds.has(propId)) continue;
        const propRefs = await collectElementPrimaryRefs(
          slug,
          propId,
          "character_prop",
          charName,
        );
        pushMany(propRefs);
      }
    } catch {
      // 读不到 character — 跳过
    }
  }

  // 2) scene — 单个, 走 typical pool
  if (input.scene_id && !seenSourceIds.has(input.scene_id)) {
    try {
      const sceneRefs = await collectElementPrimaryRefs(slug, input.scene_id, "scene_primary", "");
      if (sceneRefs.length > 0) {
        pushMany(sceneRefs);
      } else {
        // legacy fallback
        const s = await readScene(slug, input.scene_id);
        if (s?.primary_ref_image_id && !seenAssetIds.has(s.primary_ref_image_id)) {
          seenAssetIds.add(s.primary_ref_image_id);
          seenSourceIds.add(input.scene_id);
          refs.push({
            asset_id: s.primary_ref_image_id,
            url: assetThumbnailUrl(slug, s.primary_ref_image_id, 512),
            thumbnail_url: assetThumbnailUrl(slug, s.primary_ref_image_id, 256),
            label: `场景「${s.name ?? "未命名场景"}」主图`,
            source: "scene_primary",
            source_id: input.scene_id,
            source_name: s.name ?? "未命名场景",
          });
        }
      }
    } catch {
      // 读不到 scene — 跳过
    }
  }

  // 3) elements (prop / wardrobe / reference / misc) — shot.element_ids[]
  for (const eid of input.element_ids ?? []) {
    if (seenSourceIds.has(eid)) continue;
    const elementRefs = await collectElementPrimaryRefs(slug, eid, "element_primary", "");
    pushMany(elementRefs);
  }

  // 4) W1 — 本镜独立道具 (shot.prop_ids)
  for (const propId of input.prop_ids ?? []) {
    if (seenSourceIds.has(propId)) continue;
    const propRefs = await collectElementPrimaryRefs(slug, propId, "shot_prop", "");
    pushMany(propRefs);
  }

  return refs;
}

/**
 * 便利 wrapper — caller 持有完整 ShotData 时直接调本函数.
 *
 * 2026-05-26 W1 — 加 wardrobe_id / prop_ids 透传.
 */
export function collectImplicitReferencesFromShot(
  slug: string,
  shot: Pick<ShotData, "character_ids" | "scene_id" | "element_ids" | "wardrobe_id" | "prop_ids">,
): Promise<SuggestedReference[]> {
  return collectImplicitReferences(slug, {
    character_ids: shot.character_ids ?? [],
    scene_id: shot.scene_id ?? undefined,
    element_ids: shot.element_ids ?? [],
    wardrobe_id: shot.wardrobe_id ?? undefined,
    prop_ids: shot.prop_ids ?? [],
  });
}
