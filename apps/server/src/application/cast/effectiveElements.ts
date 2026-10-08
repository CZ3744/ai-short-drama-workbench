/**
 * effectiveElements — Cast/Series 合并 element 视图 (W4 2026-05-26 / W7 多组扩展).
 *
 * 给"series 视角"提供一个统一的 element 列表 / 单读, 不论 element 是 series local
 * (现有 elementRepo 路径) 还是 cast member (新 castRepo 路径).
 *
 * 合并语义 (W7 多组):
 *   1. 没加入任何素材组 (series.cast_ids 空 + cast_id 空) → 仅 series local
 *   2. 加入了 N 个组 → union(每个 cast.elements) ∪ series local elements (本剧专属)
 *   3. 同 id 冲突优先级: series local > 第一个 cast (按 cast_ids 顺序)
 *      (本剧 override 上游, 多组同 id 时第一个出现的赢, 用户原话:
 *       "本剧专属调整不要被上游同步盖掉")
 *   4. 返回时给每个 element 加 _source: "cast" | "local" 标记 (前端徽章用)
 *      _cast_id 记录是从哪个 cast 来的, 前端 tooltip 显示具体组名用.
 *
 * 兼容: 老 series.cast_id 单组字段会被 normalize 到 cast_ids[0] 合并读 (写操作走 PATCH /cast-ids).
 *
 * 性能: 项目数 < 50 / 组数 < 10 时不优化, 单文件 read 即可. O(Σ cast_members + local_members).
 *
 * 边界:
 *   - cast.id 不存在 (例: 用户删了 cast) → 跳过这个 cast, 不阻塞其他组
 *   - readEffectiveElement(slug, id): 优先 local, 没的话遍历 cast_ids 找首个命中
 *
 * caller: castController GET /series/:slug/effective-elements
 *         shotPromptInput / implicitReferenceCollector 在引用 entity 时统一走这里
 *         (替代裸 readElement / readAnyElement)
 */

import { readSeries } from "../../api/v2/seriesStore";
import { listElements } from "../../repositories/elementRepo";
import {
  listCastElements,
  readCast,
  readCastElement,
} from "../../repositories/castRepo";
import {
  readAnyElement as readAnyElementSeries,
  adaptCharacterData,
  adaptSceneData,
} from "../../api/v2/elementController.helpers";
import { listCharacters } from "../../repositories/characterRepo";
import { listScenes } from "../../repositories/sceneRepo";
import type { ElementData, ElementKind, Series } from "../../../../../packages/drama/src/types";

/**
 * W7: 把 series 老 cast_id (单组) + 新 cast_ids (多组) 归一成一个去重数组.
 * 老字段保留向后兼容, 新写操作只动 cast_ids.
 */
export function normalizeSeriesCastIds(series: Pick<Series, "cast_id" | "cast_ids"> | null | undefined): string[] {
  if (!series) return [];
  const ids: string[] = [];
  if (Array.isArray(series.cast_ids)) {
    for (const id of series.cast_ids) {
      if (typeof id === "string" && id.trim() && !ids.includes(id)) ids.push(id);
    }
  }
  if (series.cast_id && typeof series.cast_id === "string" && !ids.includes(series.cast_id)) {
    ids.push(series.cast_id);
  }
  return ids;
}

/** ElementData 加 _source 来源标记 — 前端徽章 / 调试用. */
export type SourcedElement = ElementData & {
  _source: "cast" | "local";
  /** 当 _source="cast" 时, 标记是哪个 cast 提供的 (前端展示 "来自 cast xxx") */
  _cast_id?: string;
};

/**
 * 拿到 series 视角下"实际可用 elements" (多个素材组 + local 合并).
 *
 * @param slug   series slug
 * @param opts.kind  按 kind 过滤 (透传给 listElements / listCastElements)
 */
export async function getEffectiveElementsForSeries(
  slug: string,
  opts?: { kind?: ElementKind },
): Promise<SourcedElement[]> {
  // 1) 读 series, 拿到所有加入的素材组 id (兼容老 cast_id 单字段)
  const series = await readSeries(slug).catch(() => null);
  const castIds = normalizeSeriesCastIds(series);

  // 2) 拉 series local 完整素材 (与 GET /elements 等价):
  //    - elementRepo 仅 4 kind (prop/wardrobe/reference/misc)
  //    - character/scene 走 legacy characterRepo/sceneRepo 适配出 ElementData
  //    Bug 2026-05-26: 之前只读 elementRepo 漏掉 character/scene, 导致用户挂载组前
  //    "我的素材库里素材怎么都没了"。修复: 三个来源合并, 与 /elements 路由对齐.
  const kindFilter = opts?.kind;
  const localElements: ElementData[] = [];

  // character — 仅在不过滤 kind 或过滤 character 时拉
  if (!kindFilter || kindFilter === "character") {
    try {
      for (const c of await listCharacters(slug)) {
        const adapted = await adaptCharacterData(slug, c).catch(() => null);
        if (adapted) localElements.push(adapted);
      }
    } catch {
      /* series 没 character 目录 — 正常情况, 跳过 */
    }
  }
  // scene — 同理
  if (!kindFilter || kindFilter === "scene") {
    try {
      for (const s of await listScenes(slug)) {
        const adapted = await adaptSceneData(slug, s).catch(() => null);
        if (adapted) localElements.push(adapted);
      }
    } catch {
      /* series 没 scene 目录 — 跳过 */
    }
  }
  // prop/wardrobe/reference/misc — 走 elementRepo
  // 注意: 当 kindFilter 是 character/scene 时不读 elementRepo (kind 不会有交集)
  if (!kindFilter || (kindFilter !== "character" && kindFilter !== "scene")) {
    const repoElements = await listElements(slug, kindFilter ? { kind: kindFilter } : undefined)
      .catch(() => [] as ElementData[]);
    for (const el of repoElements) localElements.push(el);
  }

  // 3) 合并: local 优先入列, 再按 cast_ids 顺序填充 cast members (同 id 跳过)
  const seen = new Set<string>();
  const merged: SourcedElement[] = [];
  for (const local of localElements) {
    merged.push({ ...local, _source: "local" });
    seen.add(local.id);
  }
  for (const castId of castIds) {
    const cast = await readCast(castId).catch(() => null);
    if (!cast) continue; // 用户删了组 → 跳过, 不阻塞其他组
    const members = await listCastElements(castId, opts?.kind ? { kind: opts.kind } : undefined)
      .catch(() => [] as ElementData[]);
    for (const member of members) {
      if (seen.has(member.id)) continue; // 已被 local 或之前 cast 占用
      merged.push({ ...member, _source: "cast", _cast_id: castId });
      seen.add(member.id);
    }
  }

  // 排序: updated_at desc (与 listElements 行为一致)
  return merged.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * 拿到 series 视角下"实际可用单个 element" (cast + local 合并语义).
 *
 * 优先级:
 *   1. series local (elementRepo + 走 readAnyElement legacy character/scene 兜底)
 *   2. cast member (如果 series 挂了 cast)
 *   3. null (都没找到)
 */
export async function readEffectiveElement(
  slug: string,
  elementId: string,
): Promise<SourcedElement | null> {
  // 1) series local — 优先 elementRepo, fallback character/scene legacy 由 readAnyElement 处理
  const local = await readAnyElementSeries(slug, elementId).catch(() => null);
  if (local) {
    return { ...local, _source: "local" };
  }

  // 2) cast member — 遍历所有加入的素材组, 取首个命中
  const series = await readSeries(slug).catch(() => null);
  const castIds = normalizeSeriesCastIds(series);
  for (const castId of castIds) {
    const member = await readCastElement(castId, elementId).catch(() => null);
    if (member) {
      return { ...member, _source: "cast", _cast_id: castId };
    }
  }

  return null;
}

/**
 * 便捷 alias: 给 shotPromptInput 用 (语义清晰 — "拿这个 character id 的有效数据").
 *
 * 老 character/scene 仍走 series-local 路径 (characterRepo / sceneRepo),
 * 新数据走 cast member 时通过 readEffectiveElement 兜底.
 *
 * 注意: 仅给 implicit reference collector / shotPromptInput 等"按 id 查" caller 用.
 *       对应的 character/scene 直接读不在本文件范围 (legacy 路径仍工作).
 */
export const readEffectiveCharacter = readEffectiveElement;
export const readEffectiveScene = readEffectiveElement;
