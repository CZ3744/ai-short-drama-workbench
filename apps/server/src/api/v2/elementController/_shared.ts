/**
 * elementController 子模块共享 helper 与常量.
 *
 * 2026-05-21 P1 拆分 — elementController.ts 1548 行按 endpoint 类型拆 7 个子文件后,
 * 这些跨子文件复用的 helper / 常量 / 类型集中到本文件。子文件统一从 ./_shared
 * 引入。
 *
 * 实现完全等同于原 elementController.ts 顶部的 helper, 不改业务逻辑。
 */

import type { Response } from "express";
import {
  listElements,
  ELEMENT_REPO_KINDS,
  type ElementKind,
  type ElementData,
  type ElementImage,
  type ImageBrief,
} from "../../../repositories/elementRepo";
import { listEpisodes, listShots } from "../seriesStore";
import { getConfigValue, getKeyFor } from "../../../../../../packages/core/src/localSettings";
import { resolveChain, tryWithFallback } from "../../../../../../packages/providers/src/core/queue";
import type { ProviderContext } from "../../../../../../packages/providers/src/core/types";
import { getRegistry } from "../orchestrationController";
import { listAssetMeta } from "../../../repositories/assetMetaRepo";
import { sendError as err } from "../validateHelpers";

export { err };

/** 通用 6 类 element kind. */
export const ALL_KINDS: ElementKind[] = ["character", "scene", "prop", "wardrobe", "reference", "misc"];

/** 判断 string 是不是 repo 层支持的 ElementKind. */
export function isRepoKind(kind: string): kind is ElementKind {
  return (ELEMENT_REPO_KINDS as string[]).includes(kind);
}

/** clone ImageBrief 数组 (深拷一层 brief 对象, image_id 等浅引用即可). */
export function cloneImageBriefs(briefs: ElementData["image_briefs"]): ImageBrief[] | undefined {
  if (!Array.isArray(briefs)) return undefined;
  return briefs.map((brief) => ({ ...brief }));
}

/** 跨项目导入时 — 把 brief.image_id 映射到目标项目新 image_id. */
export function remapImageBriefIds(briefs: ImageBrief[], imageIdMap: Map<string, string>): ImageBrief[] {
  return briefs.map((brief) => {
    if (!brief.image_id) return { ...brief };
    return { ...brief, image_id: imageIdMap.get(brief.image_id) ?? brief.image_id };
  });
}

/**
 * 反查图片在哪些分镜里出现过.
 * 给删图前的引用检测用 — 有分镜引用则禁止直接删除.
 */
export async function findImageUsageInShots(
  slug: string,
  image: ElementImage,
): Promise<Array<{ episode_id: string; shot_id: string; shot_index: number }>> {
  const ids = new Set(
    [image.image_id, image.asset_id, image.vault_id]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0),
  );
  if (ids.size === 0) return [];

  const usage: Array<{ episode_id: string; shot_id: string; shot_index: number }> = [];
  const episodes = await listEpisodes(slug);
  for (const ep of episodes) {
    const shots = await listShots(slug, ep.id);
    for (const shot of shots) {
      const overrides = shot.reference_overrides ?? [];
      const overrideHit = overrides.some((ref) => typeof ref?.image_id === "string" && ids.has(ref.image_id));
      const legacyHit = Array.isArray(shot.reference_asset_ids)
        && shot.reference_asset_ids.some((id: string) => ids.has(id));
      if (!overrideHit && !legacyHit) continue;
      usage.push({ episode_id: ep.id, shot_id: shot.id, shot_index: shot.index });
    }
  }
  return usage;
}

/**
 * 2026-05-20 display_name 体系统一: 把 assetMeta 单一真理源合并进
 * element.images.display_name 返回前端.
 *
 * 优先级 assetMeta.display_name > image.display_name (老数据兼容).
 * asset key 优先用 image_id (本系列本地标识, 防跨系列串味), 退到 vault_id (跨实体共享老数据兼容).
 */
export async function mergeElementImagesWithAssetMeta(element: ElementData): Promise<ElementData> {
  if (!element.images || element.images.length === 0) return element;
  const keys: string[] = [];
  for (const im of element.images) {
    if (im.image_id) keys.push(im.image_id);
    if (im.vault_id) keys.push(im.vault_id);
  }
  if (keys.length === 0) return element;
  const metas = await listAssetMeta(keys);
  if (metas.size === 0) return element;
  const newImages = element.images.map((im) => {
    const fromVault = im.vault_id ? metas.get(im.vault_id) : null;
    const fromImg = metas.get(im.image_id);
    // 防跨系列串味: 本系列 image_id-keyed 优先, vault_id-keyed (跨系列 SHA 去重共享) 仅作老数据 fallback.
    const dn = fromImg?.display_name ?? fromVault?.display_name;
    return dn ? { ...im, display_name: dn } : im;
  });
  return { ...element, images: newImages };
}

/**
 * 内联 LLM 文本调用 — 与 aiController 同模式, 不引额外依赖.
 * 给 compile-prompt 端点用 (polish=true 时调).
 *
 * 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
 * 不再设 AbortSignal.timeout(120_000), signal 留空 (远端等多久就等多久).
 */
export async function callLlmPolish(system: string, prompt: string, llmModelRef?: string): Promise<string> {
  const registry = getRegistry();
  const all = registry.listAvailable("llm").map((p: any) => p.id);
  const lead = (llmModelRef && llmModelRef.split(":")[0]) || getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55");
  const chain = resolveChain(lead, all, (id: string) => getKeyFor(id) !== null, getConfigValue("LLM_PROVIDER_CHAIN"));
  if (chain.length === 0) throw new Error("没有可用的文字模型 (去设置配 Key)");
  const ctx: ProviderContext = {
    series_slug: "asset-prompt-compile",
    job_id: `compile_${Date.now().toString(36)}`,
    task_id: `compile_${Date.now().toString(36)}`,
    log: () => {},
  };
  const result = await tryWithFallback(
    chain,
    (id) => registry.getLlm(id),
    { prompt, system, response_format: "text", max_tokens: 900 },
    ctx,
  );
  return result.text.trim();
}

// 出口侧出口 (子文件 import) — 顺手 re-export elementRepo 用到的类型供子文件用.
export type { ElementKind, ElementData, ElementImage, ImageBrief } from "../../../repositories/elementRepo";
export { listElements };
