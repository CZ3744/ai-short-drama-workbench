/**
 * useCharacters — SWR hook for character data within a series.
 *
 * Wave Z-10 (2026-05-21): 收口到 element API. 数据源从 /api/v2/series/:slug/characters
 * 切到 /api/v2/series/:slug/elements?kind=character, 消除双 API 并存.
 *
 * Character 类型现在等同 ElementData (素材统一模型). 旧 Character 独有字段 (role /
 * personality / appearance / outfit / voice_id 等) 存在 ElementData.tags / attrs 里,
 * 通过 helper CharacterFields 访问.
 */
import useSWR from "swr";
import {
  listElements,
  getElement,
  createElement,
  patchElement,
  deleteElement,
  type ElementData,
  type ElementKind,
  type ElementTag,
} from "../lib/elementApi";
import { apiPost } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";

// ── 类型 ──────────────────────────────────────────────────────────────

/** Character 现等价于 ElementData (kind="character"). 旧 Character 独有字段走 helper. */
export type Character = ElementData;

export type CharacterCreate = {
  name: string;
  role: string;
  appearance_prompt?: string;
  personality: string;
  appearance?: string;
  outfit?: string;
};

export type CharacterPatch = Partial<{
  name: string;
  role: string;
  appearance_prompt: string;
  appearance: string;
  outfit: string;
  personality: string;
  voice_id: string;
  voice_style_map: Record<string, string | undefined>;
  primary_ref_image_id: string;
  status: string;
  reference_image_set: string[];
  locked_seed: number;
  style_prompt_fingerprint: string;
}>;

export type CharacterLockBody = {
  asset_id: string;
  reference_image_set?: string[];
};

// ── 字段 helper (从 ElementData tags/attrs 提取旧 Character 独有字段) ─

function tagText(el: ElementData, axis: string): string | undefined {
  return el.tags?.find((t) => t.axis === axis)?.value;
}

export function characterRole(el: ElementData): string | undefined {
  return tagText(el, "role");
}
function attrString(el: ElementData, key: string): string | undefined {
  const v = el.attrs?.[key];
  return typeof v === "string" ? v : undefined;
}
export function characterAppearance(el: ElementData): string | undefined {
  return attrString(el, "appearance");
}
export function characterOutfit(el: ElementData): string | undefined {
  return attrString(el, "outfit");
}
export function characterPersonality(el: ElementData): string | undefined {
  return attrString(el, "personality");
}
export function characterVoiceId(el: ElementData): string | undefined {
  return attrString(el, "voice_id");
}

// ── hooks ─────────────────────────────────────────────────────────────

export function useCharacters(slug: string | undefined) {
  const key = slug ? `characters:${slug}` : null;
  // P1-38 (2026-05-28 audit wave 4): fetch 失败时给空数组 fallback, 防止 caller 硬解构 data 整页崩.
  // SWR 会保留 error + data fallback 共存, showErrorToast 已通知用户.
  return useSWR<Character[]>(
    key,
    async () => {
      const { elements } = await listElements(slug!, "character");
      return elements;
    },
    {
      revalidateOnFocus: false,
      dedupingInterval: 3000,
      fallbackData: [],
      onError: (err) => {
        showErrorToast(err);
      },
    },
  );
}

export function useCharacter(slug: string | undefined, charId: string | undefined) {
  const key = slug && charId ? `characters-item:${slug}:${charId}` : null;
  return useSWR<Character>(
    key,
    async () => {
      const { element } = await getElement(slug!, charId!);
      return element;
    },
    {
      revalidateOnFocus: false,
      onError: (err) => {
        showErrorToast(err);
      },
    },
  );
}

// ── CRUD (thin wrappers → element API) ────────────────────────────────

function characterToElementCreate(input: CharacterCreate) {
  const tags: ElementTag[] = [
    ...(input.role ? [{ axis: "role", value: input.role }] : []),
  ];
  const attrs: Record<string, unknown> = {};
  if (input.appearance) attrs.appearance = input.appearance;
  if (input.outfit) attrs.outfit = input.outfit;
  if (input.personality) attrs.personality = input.personality;
  return {
    kind: "character" as ElementKind,
    name: input.name,
    description: input.appearance_prompt ?? "",
    tags,
    attrs,
  };
}

function characterPatchToElementPatch(patch: CharacterPatch) {
  const result: {
    name?: string;
    description?: string;
    tags?: ElementTag[];
    attrs?: Record<string, unknown>;
  } = {};
  if (patch.name !== undefined) result.name = patch.name;
  if (patch.appearance_prompt !== undefined) result.description = patch.appearance_prompt;
  if (patch.role !== undefined) {
    result.tags = [{ axis: "role", value: patch.role }];
  }
  const attrs: Record<string, unknown> = {};
  if (patch.appearance !== undefined) attrs.appearance = patch.appearance;
  if (patch.outfit !== undefined) attrs.outfit = patch.outfit;
  if (patch.personality !== undefined) attrs.personality = patch.personality;
  if (patch.voice_id !== undefined) attrs.voice_id = patch.voice_id;
  if (patch.voice_style_map !== undefined) attrs.voice_style_map = patch.voice_style_map;
  if (patch.reference_image_set !== undefined) attrs.reference_image_set = patch.reference_image_set;
  if (patch.locked_seed !== undefined) attrs.locked_seed = patch.locked_seed;
  if (patch.style_prompt_fingerprint !== undefined) attrs.style_prompt_fingerprint = patch.style_prompt_fingerprint;
  if (Object.keys(attrs).length > 0) result.attrs = attrs;
  return result;
}

export async function createCharacter(
  slug: string,
  input: CharacterCreate,
): Promise<Character> {
  const { element } = await createElement(slug, characterToElementCreate(input));
  return element;
}

export async function patchCharacter(
  slug: string,
  charId: string,
  patch: CharacterPatch,
): Promise<Character> {
  const { element } = await patchElement(slug, charId, characterPatchToElementPatch(patch));
  return element;
}

export async function deleteCharacter(slug: string, charId: string): Promise<void> {
  await deleteElement(slug, charId);
}

export async function lockCharacter(
  slug: string,
  charId: string,
  assetId: string,
  extraRefIds?: string[],
): Promise<Character> {
  const body: CharacterLockBody = { asset_id: assetId };
  if (extraRefIds && extraRefIds.length > 0) {
    body.reference_image_set = extraRefIds;
  }
  const res = await apiPost<{ ok: boolean; character: Character }>(
    `/api/v2/series/${slug}/characters/${charId}/lock`,
    body,
  );
  return res.character;
}
