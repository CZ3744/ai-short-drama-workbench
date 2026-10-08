/**
 * character/scene <-> ElementData adapter.
 *
 * Pure data mapping only: no fs, no repo calls, no provider calls. Callers pass
 * already resolved legacy images so this file stays testable and decoupled.
 */

import type {
  CharacterData,
  ElementData,
  ElementImage,
  ElementTag,
  ImageBrief,
} from "../../../../../packages/drama/src/types";

export interface SceneLike {
  id: string;
  series_slug: string;
  name: string;
  description?: string;
  visual_style?: string;
  location?: string;
  time_of_day?: string;
  mood?: string;
  ref_image_ids?: string[];
  primary_ref_image_id?: string;
  locked?: Record<string, unknown>;
  status?: string;
  library_id?: string;
  locked_image_path?: string;
  reference_image_set?: string[];
  locked_seed?: number;
  style_prompt_fingerprint?: string;
  image_briefs?: ImageBrief[];
  /** P0-1 (2026-05-28 audit wave 4): 派生来源 (跨项目导入). 与 sceneRepo.SceneData.derived_from 同形. */
  derived_from?: {
    series_slug: string;
    element_id: string;
  };
  [key: string]: unknown;
}

function nowISO(): string {
  return new Date().toISOString();
}

function statusFromLegacy(status: unknown, imageCount: number): ElementData["status"] {
  if (status === "locked") return "locked";
  return imageCount > 0 ? "has_images" : "drafted";
}

function tag(axis: string, value: unknown): ElementTag[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return [{ axis, value: value.trim() }];
}

function attrFrom<T extends Record<string, unknown>>(source: T, keys: string[]): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) attrs[key] = source[key];
  }
  return attrs;
}

// 验收修订 (2026-05-15): *_ATTR_KEYS 只放「没有其它表示形式」的旧字段.
//   - role/visual_style/location/time_of_day/mood → 已映射成 tags, 不入 attrs
//   - ref_image_ids/primary_ref_image_id → 已映射成 images/primary_image_id, 不入 attrs
//   - status → 由 images 数量派生, 不入 attrs
// 之前 SCENE_ATTR_KEYS 误收 ref_image_ids/primary_ref_image_id/status, 会在 PATCH
// 场景元数据时用过期 attrs 覆盖真实图列表 —— 已移除.
//
// Wave B-3 (2026-05-16): 加 appearance / outfit / personality 进 attrs(配合 KIND_FIELD_SCHEMA).
// 注意:role 仍走 tags(axis: "role"); 但 personality 改走 attrs(独立字段,不再是 tag axis).
//   - 旧 personality 映射到 tag(axis:"personality")的逻辑已废, ElementWorkbench 走 attrs.
//   - 向后兼容:legacy tag personality 在 element 读取时 fallback 进 attrs.character_personality.
const CHARACTER_ATTR_KEYS = [
  "appearance",
  "outfit",
  "personality",
  "voice_id",
  "voice_style_map",
  "voice_clone_sample_url",
  "lora_path",
  "locked_seed",
  "style_prompt_fingerprint",
  "library_id",
  "locked_image_path",
  "reference_image_set",
  "locked",
  // 2026-05-26 W2 组合性 — 角色绑定的服装造型 / 常带道具 element id 列表.
  // 双向透传: characterToElement 通过 attrFrom 把 CharacterData.wardrobe_element_ids
  // 抽到 ElementData.attrs.wardrobe_element_ids, 前端 CharacterCompositionPanel 读;
  // PATCH 时前端走 attrs 写回, elementPatchToCharacterPatch 用 assignAttrs 反向落到
  // CharacterData 顶层字段, 让 shotPromptCompiler / implicitReferenceCollector 能直读.
  "wardrobe_element_ids",
  "prop_element_ids",
];

const SCENE_ATTR_KEYS = [
  "library_id",
  "locked_image_path",
  "reference_image_set",
  "locked_seed",
  "style_prompt_fingerprint",
  "locked",
];

export function characterToElement(
  character: CharacterData,
  images: ElementImage[] = [],
): ElementData {
  // Wave B-3 (2026-05-16): appearance + outfit 拼合作 description(给生图 prompt);
  // 新字段缺失时 fallback 到 legacy appearance_prompt(向后兼容老数据)。
  const visualDesc = [character.appearance, character.outfit]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .join(", ");
  const description = visualDesc || character.appearance_prompt || "";

  return {
    id: character.id,
    series_slug: character.series_slug,
    kind: "character",
    name: character.name ?? character.id,
    description,
    // Wave B-3: personality 改走 attrs(KIND_FIELD_SCHEMA 显式字段), 不再作 tag axis。
    // role 保留 tag — 它是分类语义(主角/配角), 不是描述性属性。
    tags: [
      ...tag("role", character.role),
    ],
    images,
    primary_image_id: character.primary_ref_image_id,
    attrs: {
      ...attrFrom(character as unknown as Record<string, unknown>, CHARACTER_ATTR_KEYS),
      legacy_kind: "character",
    },
    status: statusFromLegacy(character.status, images.length),
    // 2026-05-28 audit P1 — Character interface 没声明 created_at/updated_at, 老数据磁盘可能有, 走 unknown narrowing
    created_at: (character as unknown as { created_at?: string }).created_at ?? nowISO(),
    updated_at: (character as unknown as { updated_at?: string }).updated_at ?? nowISO(),
    derived_from: character.derived_from
      ? {
          series_slug: character.derived_from.series_slug,
          element_id: character.derived_from.character_id,
        }
      : undefined,
    // 2026-05-19 #8: 透传 image_briefs 给 ElementData 视图
    image_briefs: character.image_briefs,
  };
}

export function sceneToElement(scene: SceneLike, images: ElementImage[] = []): ElementData {
  return {
    id: scene.id,
    series_slug: scene.series_slug,
    kind: "scene",
    name: scene.name ?? scene.id,
    description: scene.description ?? "",
    tags: [
      ...tag("visual", scene.visual_style),
      ...tag("location", scene.location),
      ...tag("time", scene.time_of_day),
      ...tag("mood", scene.mood),
    ],
    images,
    primary_image_id: scene.primary_ref_image_id,
    attrs: {
      ...attrFrom(scene, SCENE_ATTR_KEYS),
      legacy_kind: "scene",
    },
    status: statusFromLegacy(scene.status, images.length),
    created_at: typeof scene.created_at === "string" ? scene.created_at : nowISO(),
    updated_at: typeof scene.updated_at === "string" ? scene.updated_at : nowISO(),
    // P0-1 (2026-05-28 audit wave 4): scene 跨项目导入后 derived_from 没透传给前端,
    // 导致前端再次拉取看不到来源信息. characterToElement 一直透传, sceneToElement 漏了.
    derived_from: scene.derived_from
      ? {
          series_slug: scene.derived_from.series_slug,
          element_id: scene.derived_from.element_id,
        }
      : undefined,
    // 2026-05-19 #8: 透传 image_briefs 给 ElementData 视图(SceneLike.image_briefs 走 [key] index)
    image_briefs: scene.image_briefs as ElementData["image_briefs"],
  };
}

function firstTag(tags: ElementTag[] | undefined, axis: string): string | undefined {
  return tags?.find((t) => t.axis === axis)?.value;
}

function assignAttrs(
  target: Record<string, unknown>,
  attrs: Record<string, unknown> | undefined,
  keys: string[],
): void {
  if (!attrs) return;
  for (const key of keys) {
    if (key === "legacy_kind") continue;
    if (attrs[key] !== undefined) target[key] = attrs[key];
  }
}

export function elementPatchToCharacterPatch(patch: Partial<ElementData>): Partial<CharacterData> {
  const out: Record<string, unknown> = {};
  if (typeof patch.name === "string") out.name = patch.name;
  // Wave B-3 (2026-05-16): description = 视觉描述总览(appearance+outfit 拼接);
  // 收到 description PATCH 时同时写 legacy appearance_prompt(向后兼容);
  // 实际拆分字段走 attrs(下方 assignAttrs 处理 appearance/outfit/personality).
  if (typeof patch.description === "string") out.appearance_prompt = patch.description;
  assignAttrs(out, patch.attrs, CHARACTER_ATTR_KEYS);

  // tags 是 role 的权威来源(personality Wave B-3 改走 attrs).
  // patch.tags 存在即代表用户编辑过标签: 命中则写值, 未命中则显式清空.
  // 向后兼容: 如果 patch.tags 包含 axis="personality" 的旧 tag, 也读出来作 personality.
  if (patch.tags !== undefined) {
    out.role = firstTag(patch.tags, "role") ?? "";
    const legacyPersonalityTag = firstTag(patch.tags, "personality");
    if (legacyPersonalityTag && out.personality === undefined) {
      out.personality = legacyPersonalityTag;
    }
  }
  if (patch.primary_image_id !== undefined) out.primary_ref_image_id = patch.primary_image_id;
  // 2026-05-19 #8: image_briefs 透传 (autoPipelineRunner 标 generated 时走这条路径)
  if (patch.image_briefs !== undefined) out.image_briefs = patch.image_briefs;
  return out as Partial<CharacterData>;
}

export function elementPatchToScenePatch(patch: Partial<ElementData>): Partial<SceneLike> {
  const out: Record<string, unknown> = {};
  if (typeof patch.name === "string") out.name = patch.name;
  if (typeof patch.description === "string") out.description = patch.description;
  assignAttrs(out, patch.attrs, SCENE_ATTR_KEYS);

  if (patch.tags !== undefined) {
    out.visual_style = firstTag(patch.tags, "visual") ?? "";
    out.location = firstTag(patch.tags, "location") ?? "";
    out.time_of_day = firstTag(patch.tags, "time") ?? "";
    out.mood = firstTag(patch.tags, "mood") ?? "";
  }
  if (patch.primary_image_id !== undefined) out.primary_ref_image_id = patch.primary_image_id;
  // 2026-05-19 #8: image_briefs 透传 (autoPipelineRunner 标 generated 时走这条路径)
  if (patch.image_briefs !== undefined) out.image_briefs = patch.image_briefs;
  return out as Partial<SceneLike>;
}
