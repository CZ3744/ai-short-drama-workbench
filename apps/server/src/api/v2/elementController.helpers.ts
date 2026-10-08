/**
 * elementController 内部 helper 抽出 — 给 imageGenerationOrchestrator adapter 用.
 *
 * 这些 helper 之前内联在 elementController.ts. Phase 1 解耦后, adapter 需要调用
 * addAnyElementImage / readAnyElement 完成业务对象写入, 把它们独立到本文件避免
 * adapter ↔ controller 双向 import.
 *
 * 实现逻辑与原 controller 里那份**完全一致**, 直接搬过来. controller 现在从本文件
 * 反向 re-import 即可保持下游 import 不破.
 */

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import {
  readElement,
  updateElement,
  addElementImage,
  removeElementImage,
  patchElementImageMeta,
  setPrimaryImage,
  type ElementData,
  type ElementImage,
} from "../../repositories/elementRepo";
import {
  readCharacter,
  updateCharacter,
} from "../../repositories/characterRepo";
import {
  readScene,
  updateScene,
} from "../../repositories/sceneRepo";
import { addAsset, readAsset, resolveAssetFilePath } from "../../repositories/assetRepo";
import { DATA_ROOT, ensureDir } from "../../../../../packages/core/src/index";
import {
  saveToVault,
  getVaultEntry,
  getVaultAbsolutePath,
} from "../../../../../packages/library/src/assetVault";
import {
  characterToElement,
  elementPatchToCharacterPatch,
  elementPatchToScenePatch,
  sceneToElement,
} from "../../application/element/elementAdapter";

// ─── url 拼接 ─────────────────────────────────────────────────────────

export function assetUrl(slug: string, assetPath: string | undefined, assetId: string): string {
  const normalized = assetPath?.replace(/\\/g, "/");
  return normalized
    ? `/api/v2/series/${slug}/${normalized}`
    : `/api/v2/series/${slug}/assets/${assetId}/thumbnail?size=512`;
}

/** ref_image_meta 字典单条目类型（与 drama/types.ts Character/Scene.ref_image_meta 同形）*/
type RefImageMeta = {
  display_name?: string;
  available_for_shot?: boolean;
  /** 2026-05-18 三池模型: typical 标志同步到 character/scene ref_image_meta */
  is_typical?: boolean;
  prompt_snapshot?: string;
  note?: string;
  user_note?: string;
  provider_id?: string;
  seed?: number;
  origin?: "generated" | "i2i" | "imported";
  based_on_image_id?: string;
  created_at?: string;
};

/**
 * 把 legacy character/scene ref_image_ids 展平为 ElementImage 数组。
 *
 * @param metaDict — character.ref_image_meta / scene.ref_image_meta 字典（可 undefined）。
 *   老数据（2026-05-16 之前）缺失此字典时，origin 降级为 "legacy"，各字段 undefined。
 *   新数据通过 characterRefAdapter / sceneRefAdapter 写入字典后可完整展平。
 */
export async function resolveLegacyImages(
  slug: string,
  assetIds: string[] | undefined,
  metaDict?: Record<string, RefImageMeta>,
): Promise<ElementImage[]> {
  const images: ElementImage[] = [];
  for (const assetId of assetIds ?? []) {
    const asset = await readAsset(slug, assetId).catch(() => null);
    const m: RefImageMeta = metaDict?.[assetId] ?? {};
    images.push({
      image_id: assetId,
      asset_id: assetId,
      origin: m.origin ?? "legacy",
      prompt_snapshot: m.prompt_snapshot,
      provider_id: m.provider_id,
      seed: m.seed,
      based_on_image_id: m.based_on_image_id,
      url: assetUrl(slug, asset?.path, assetId),
      mime: asset?.mime,
      created_at: m.created_at ?? asset?.created_at ?? new Date().toISOString(),
      note: m.note ?? m.user_note ?? asset?.filename,
      display_name: m.display_name,
      available_for_shot: m.available_for_shot,
      // 2026-05-18 三池模型: 把 character/scene 的 is_typical 标志带回 ElementImage 视图
      is_typical: m.is_typical,
    });
  }
  return images;
}

export async function adaptCharacterData(
  slug: string,
  idOrData: string | Awaited<ReturnType<typeof readCharacter>>,
): Promise<ElementData | null> {
  const character = typeof idOrData === "string" ? await readCharacter(slug, idOrData) : idOrData;
  if (!character) return null;
  return characterToElement(character, await resolveLegacyImages(slug, character.ref_image_ids, character.ref_image_meta));
}

export async function adaptSceneData(
  slug: string,
  idOrData: string | Awaited<ReturnType<typeof readScene>>,
): Promise<ElementData | null> {
  const scene = typeof idOrData === "string" ? await readScene(slug, idOrData) : idOrData;
  if (!scene) return null;
  // scene 可能是 drama/types.ts Scene（无 ref_image_meta）或 sceneRepo.SceneData（有）
  // 用索引访问兼容两种类型，老数据时 metaDict 为 undefined（安全）
  // 2026-05-28 audit P1 type-safety — SceneData 字段是 SceneLike 子集 (差 [key: string] 索引), 强转 SceneLike
  const sceneAny = scene as { ref_image_ids?: string[]; ref_image_meta?: Record<string, RefImageMeta> };
  return sceneToElement(scene as unknown as import("../../application/element/elementAdapter").SceneLike, await resolveLegacyImages(slug, sceneAny.ref_image_ids, sceneAny.ref_image_meta));
}

export async function readAnyElement(slug: string, id: string): Promise<ElementData | null> {
  const repoElement = await readElement(slug, id);
  if (repoElement) return repoElement;
  return (await adaptCharacterData(slug, id)) ?? (await adaptSceneData(slug, id));
}

export async function updateAnyElement(slug: string, id: string, patch: Partial<ElementData>): Promise<ElementData | null> {
  const repoElement = await updateElement(slug, id, patch);
  if (repoElement) return repoElement;

  const character = await readCharacter(slug, id);
  if (character) {
    const updated = await updateCharacter(slug, id, elementPatchToCharacterPatch(patch));
    return adaptCharacterData(slug, updated);
  }

  const scene = await readScene(slug, id);
  if (scene) {
    // 2026-05-28 audit P1 — elementPatchToScenePatch 返回 Partial<SceneLike>, updateScene 期 Partial<SceneData>
    // SceneLike 包 SceneData 大部分字段, 差几个非主要字段, 这里强转 (两个类型字段语义对齐)
    const updated = await updateScene(slug, id, elementPatchToScenePatch(patch) as Parameters<typeof updateScene>[2]);
    return adaptSceneData(slug, updated);
  }

  return null;
}

export async function ensureAssetFromVault(slug: string, element: ElementData, image: Partial<ElementImage>): Promise<string | undefined> {
  if (image.asset_id) return image.asset_id;
  if (!image.vault_id) return undefined;
  const entry = await getVaultEntry(image.vault_id);
  if (!entry) return undefined;
  const abs = getVaultAbsolutePath(entry);
  const buf = await fs.readFile(abs);
  const ext = entry.mime === "image/jpeg" ? "jpg" : entry.mime === "image/webp" ? "webp" : "png";
  const filename = `element_${element.kind}_${element.id}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
  const assetsDir = path.join(DATA_ROOT, "series", slug, "assets", "images");
  await ensureDir(assetsDir);
  await fs.writeFile(path.join(assetsDir, filename), buf);
  const asset = await addAsset(slug, {
    series_slug: slug,
    kind: "image",
    tags: [`element:${element.id}`, `${element.kind}:${element.id}`, "ref_image"],
    path: `assets/images/${filename}`,
    filename,
    mime: entry.mime,
    size_bytes: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  });
  return asset.asset_id;
}

export async function ensureVaultFromImage(slug: string, element: ElementData, image: ElementImage): Promise<string | undefined> {
  if (image.vault_id) return image.vault_id;
  if (!image.asset_id) return undefined;
  const asset = await readAsset(slug, image.asset_id);
  const abs = asset ? resolveAssetFilePath(slug, asset.path) : null;
  if (!asset || !abs) return undefined;
  const buf = await fs.readFile(abs);
  const vaultEntry = await saveToVault({
    buffer: buf,
    kind: "image",
    mime: asset.mime || "image/png",
    context: {
      kind: element.kind === "character" ? "character_ref" : element.kind === "scene" ? "scene_ref" : "variant",
      series_slug: slug,
      character_id: element.kind === "character" ? element.id : undefined,
      scene_id: element.kind === "scene" ? element.id : undefined,
      user_note: `element:${element.kind}:${element.name}`,
    },
    provider_id: image.provider_id ?? "legacy_asset",
    tags: [`element:${element.id}`, `${element.kind}:${element.id}`, "ref_image"],
  });
  return vaultEntry.vault_id;
}

export async function addAnyElementImage(
  slug: string,
  id: string,
  image: Omit<ElementImage, "image_id" | "created_at"> & Partial<Pick<ElementImage, "image_id" | "created_at">>,
): Promise<{ element: ElementData; image: ElementImage } | null> {
  // 2026-05-19 #3 三级素材库默认值(用户原话"抽卡新图默认进最底层草稿池"):
  //   - generated / i2i / from_shot → 默认 available_for_shot=false (草稿池, 用户需主动晋升)
  //   - imported (用户主动导入)       → 默认 available_for_shot=true (用户意图明确, 进选用集)
  // 仅在 caller 未显式传值时兜底; caller 显式传 true/false 优先(向后兼容旧 caller).
  if (image.available_for_shot === undefined) {
    const isUserImported = image.origin === "imported";
    image = { ...image, available_for_shot: isUserImported };
  }
  // 2026-05-20 Wave T — 自动起默认 display_name(用户原话"为什么图片名没有名?生成之后不是有一个默认名吗?")
  //   caller 没显式传 display_name 时, 用 "{element.name} #{N+1}" 作默认.
  //   用户进 ChipDropdown / ElementListPage 看到的是有名字的图, 不再是 fallback "第 N 张".
  //   用户改名走 InlineLabel + patchElementImage, 改完所有用 display_name 的位置自动同步.
  if (!image.display_name || !image.display_name.trim()) {
    try {
      const preCurrent = await readAnyElement(slug, id);
      if (preCurrent) {
        const nextIndex = (preCurrent.images?.length ?? 0) + 1;
        const elName = preCurrent.name?.trim() || "素材";
        image = { ...image, display_name: `${elName} #${nextIndex}` };
      }
    } catch {
      // 读 element 失败不阻塞主路径 — 没默认名退到 fallback "第 N 张" 即可
    }
  }
  const repoAdded = await addElementImage(slug, id, image);
  if (repoAdded) {
    // V-10: 占位素材生图后自动清除 placeholder 状态
    if (repoAdded.element.is_placeholder && repoAdded.element.images.length > 0) {
      try {
        await updateElement(slug, id, { is_placeholder: false });
        repoAdded.element.is_placeholder = false;
      } catch { /* 非致命: 清理 placeholder 失败不影响主流程 */ }
    }
    return repoAdded;
  }

  const current = await readAnyElement(slug, id);
  // 2026-05-18 红线 #1 防御性日志: addElementImage 返 null 意味着 elementRepo 找不到 element 文件.
  // 4 新 kind (prop/wardrobe/reference/misc) 没有 legacy fallback 路径, 直接返 null → caller 走 404
  // "素材不存在" 是 OK 的;但如果是 elementRepo 文件被外部删除 / 迁移半途等异常,
  // 这里 silent null 会让运维难以排查. 加显式 console.warn 留下 audit 痕迹.
  if (!current || (current.kind !== "character" && current.kind !== "scene")) {
    if (current) {
      // element 存在但 kind 不是 character/scene, elementRepo addElementImage 又返了 null
      // — 这是异常组合, 说明 elementRepo 半途异常. 应当能在 server 日志查到根因.
      console.warn(
        `[addAnyElementImage] elementRepo.addElementImage returned null for existing element ` +
        `slug=${slug} id=${id} kind=${current.kind} — element file may be corrupted or repo locked. ` +
        `Returning null → caller will respond 404.`
      );
    }
    return null;
  }
  const assetId = await ensureAssetFromVault(slug, current, image);
  if (!assetId) return null;
  const full: ElementImage = {
    ...image,
    image_id: assetId,
    asset_id: assetId,
    created_at: image.created_at ?? new Date().toISOString(),
    url: image.url ?? `/api/v2/series/${slug}/assets/${assetId}/thumbnail?size=512`,
  } as ElementImage;

  // 真 bug 修(2026-05-16):character/scene fallback 路径之前**只**写 ref_image_ids,
  // 漏写 ref_image_meta 字典 — 导致 element 路径(elementController.generate-image)
  // 生图后用户点"复制提示词"看到"导入图无提示词"toast(因为 prompt_snapshot/origin/
  // provider_id 等元数据从未被持久化)。这里同步写元数据字典与 characterRefAdapter /
  // sceneRefAdapter(走 character/scene 端点的另一路径)行为对齐。
  const inputOrigin = image.origin;
  const narrowedOrigin: "generated" | "i2i" | "imported" =
    inputOrigin === "i2i" ? "i2i" : inputOrigin === "imported" ? "imported" : "generated";
  const refImageMetaEntry: RefImageMeta = {
    prompt_snapshot: typeof image.prompt_snapshot === "string" ? image.prompt_snapshot : undefined,
    provider_id: typeof image.provider_id === "string" ? image.provider_id : undefined,
    seed: typeof image.seed === "number" ? image.seed : undefined,
    origin: narrowedOrigin,
    based_on_image_id: typeof image.based_on_image_id === "string" ? image.based_on_image_id : undefined,
    created_at: new Date().toISOString(),
    note: typeof image.note === "string" ? image.note : undefined,
    user_note: typeof image.note === "string" ? image.note : undefined,
    display_name: typeof image.display_name === "string" ? image.display_name : undefined,
    available_for_shot: typeof image.available_for_shot === "boolean" ? image.available_for_shot : undefined,
  };

  if (current.kind === "character") {
    const character = await readCharacter(slug, id);
    const refIds = [...new Set([...(character?.ref_image_ids ?? []), assetId])];
    // V-10: 占位素材生图后自动清除 placeholder 状态
    // 2026-05-28 audit P1 type-safety — character.is_placeholder 是 ad-hoc 字段, 用 unknown narrowing
    const charRec = character as unknown as { is_placeholder?: unknown } | null;
    const charPatch: Parameters<typeof updateCharacter>[2] = {
      ref_image_ids: refIds,
      ref_image_meta: {
        ...(character?.ref_image_meta ?? {}),
        [assetId]: refImageMetaEntry,
      },
      ...(charRec?.is_placeholder ? { is_placeholder: false } : {}),
    };
    const updated = await updateCharacter(slug, id, charPatch);
    const element = await adaptCharacterData(slug, updated);
    return element ? { element, image: full } : null;
  }

  const scene = await readScene(slug, id);
  const sceneAny = scene as { ref_image_ids?: string[]; ref_image_meta?: Record<string, RefImageMeta>; is_placeholder?: boolean } | null;
  const refIds = [...new Set([...(scene?.ref_image_ids ?? []), assetId])];
  // V-10: 占位素材生图后自动清除 placeholder 状态
  // 2026-05-28 audit P1 type-safety — scenePatch 用 updateScene 参数类型替代 any
  const scenePatch: Parameters<typeof updateScene>[2] = {
    ref_image_ids: refIds,
    ref_image_meta: {
      ...(sceneAny?.ref_image_meta ?? {}),
      [assetId]: refImageMetaEntry,
    },
  };
  if (sceneAny?.is_placeholder) {
    (scenePatch as Record<string, unknown>).is_placeholder = false;
  }
  const updated = await updateScene(slug, id, scenePatch);
  const element = await adaptSceneData(slug, updated);
  return element ? { element, image: full } : null;
}

export async function removeAnyElementImage(slug: string, id: string, imageId: string): Promise<ElementData | null> {
  const repoElement = await removeElementImage(slug, id, imageId);
  if (repoElement) return repoElement;

  const character = await readCharacter(slug, id);
  if (character) {
    const nextMeta = { ...(character.ref_image_meta ?? {}) };
    delete nextMeta[imageId];
    const updated = await updateCharacter(slug, id, {
      ref_image_ids: (character.ref_image_ids ?? []).filter((x) => x !== imageId),
      ref_image_meta: nextMeta,
      primary_ref_image_id: character.primary_ref_image_id === imageId ? undefined : character.primary_ref_image_id,
    });
    return adaptCharacterData(slug, updated);
  }

  const scene = await readScene(slug, id);
  if (scene) {
    const sceneAny = scene as { ref_image_meta?: Record<string, RefImageMeta> };
    const nextMeta = { ...(sceneAny.ref_image_meta ?? {}) };
    delete nextMeta[imageId];
    const updated = await updateScene(slug, id, {
      ref_image_ids: (scene.ref_image_ids ?? []).filter((x) => x !== imageId),
      ref_image_meta: nextMeta,
      primary_ref_image_id: scene.primary_ref_image_id === imageId ? undefined : scene.primary_ref_image_id,
    } as Partial<NonNullable<Awaited<ReturnType<typeof readScene>>>>);
    return adaptSceneData(slug, updated);
  }

  return null;
}

export async function patchAnyElementImageMeta(
  slug: string,
  id: string,
  imageId: string,
  patch: Partial<Pick<ElementImage, "display_name" | "available_for_shot" | "is_typical" | "image_tags">>,
): Promise<ElementData | null> {
  // 2026-05-18 三池语义同步:
  // - is_typical=true → available_for_shot 强制 true (典型必属真池)
  // - available_for_shot=false → is_typical 强制 false (移出真池则不可能是典型)
  const normalized = { ...patch };
  if (normalized.is_typical === true) normalized.available_for_shot = true;
  if (normalized.available_for_shot === false) normalized.is_typical = false;
  patch = normalized;

  const repoElement = await patchElementImageMeta(slug, id, imageId, patch);
  if (repoElement) return repoElement;

  const character = await readCharacter(slug, id);
  if (character && (character.ref_image_ids ?? []).includes(imageId)) {
    const updated = await updateCharacter(slug, id, {
      ref_image_meta: {
        ...(character.ref_image_meta ?? {}),
        [imageId]: {
          ...(character.ref_image_meta?.[imageId] ?? {}),
          ...patch,
        },
      },
    });
    return adaptCharacterData(slug, updated);
  }

  const scene = await readScene(slug, id);
  const sceneAny = scene as { ref_image_ids?: string[]; ref_image_meta?: Record<string, RefImageMeta> } | null;
  if (scene && (sceneAny?.ref_image_ids ?? []).includes(imageId)) {
    const updated = await updateScene(slug, id, {
      ref_image_meta: {
        ...(sceneAny?.ref_image_meta ?? {}),
        [imageId]: {
          ...(sceneAny?.ref_image_meta?.[imageId] ?? {}),
          ...patch,
        },
      },
    } as Partial<NonNullable<Awaited<ReturnType<typeof readScene>>>>);
    return adaptSceneData(slug, updated);
  }

  return null;
}

export async function setAnyPrimaryImage(slug: string, id: string, imageId: string): Promise<ElementData | null> {
  const repoElement = await setPrimaryImage(slug, id, imageId);
  if (repoElement) return repoElement;

  const character = await readCharacter(slug, id);
  if (character) {
    if (!(character.ref_image_ids ?? []).includes(imageId)) return null;
    const updated = await updateCharacter(slug, id, { primary_ref_image_id: imageId, status: "locked" });
    return adaptCharacterData(slug, updated);
  }

  const scene = await readScene(slug, id);
  if (scene) {
    if (!(scene.ref_image_ids ?? []).includes(imageId)) return null;
    const updated = await updateScene(slug, id, { primary_ref_image_id: imageId, status: "locked" });
    return adaptSceneData(slug, updated);
  }

  return null;
}

/** 取消主图 — 只把 primary_image_id 置空, 图片保留. 兼容 element/character/scene 三套 repo. */
export async function clearAnyPrimaryImage(slug: string, id: string): Promise<ElementData | null> {
  // 先尝试 element repo (null = 取消)
  const repoElement = await setPrimaryImage(slug, id, null);
  if (repoElement) return repoElement;

  const character = await readCharacter(slug, id);
  if (character) {
    const updated = await updateCharacter(slug, id, { primary_ref_image_id: undefined });
    return adaptCharacterData(slug, updated);
  }

  const scene = await readScene(slug, id);
  if (scene) {
    const updated = await updateScene(slug, id, { primary_ref_image_id: undefined });
    return adaptSceneData(slug, updated);
  }

  return null;
}
