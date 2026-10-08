/**
 * useScenes — SWR hook for scene data within a series.
 *
 * Wave Z-10 (2026-05-21): 收口到 element API. 数据源从 /api/v2/series/:slug/scenes
 * 切到 /api/v2/series/:slug/elements?kind=scene, 消除双 API 并存.
 *
 * Scene 类型现在等同 ElementData (素材统一模型). 旧 Scene 独有字段 (location / mood 等)
 * 存在 ElementData.tags 里, 通过 helper SceneFields 访问.
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
} from "../lib/elementApi";
import { apiPost } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";

// ── 类型 ──────────────────────────────────────────────────────────────

/** Scene 现等价于 ElementData (kind="scene"). 旧 Scene 独有字段走 helper. */
export type Scene = ElementData;

export type SceneCreate = {
  name: string;
  description?: string;
  visual_style?: string;
  location?: string;
  time_of_day?: string;
  mood?: string;
};

export type ScenePatch = Partial<
  Pick<
    Scene,
    | "name"
    | "description"
  >
> & {
  visual_style?: string;
  location?: string;
  time_of_day?: string;
  mood?: string;
  primary_ref_image_id?: string;
  status?: string;
};

export type SceneLockBody = {
  asset_id: string;
};

// ── 字段 helper (从 ElementData tags/attrs 提取旧 Scene 独有字段) ────

function tagText(el: ElementData, axis: string): string | undefined {
  return el.tags?.find((t) => t.axis === axis)?.value;
}

export function sceneVisualStyle(el: ElementData): string | undefined { return tagText(el, "visual"); }
export function sceneLocation(el: ElementData): string | undefined     { return tagText(el, "location"); }
export function sceneTimeOfDay(el: ElementData): string | undefined    { return tagText(el, "time"); }
export function sceneMood(el: ElementData): string | undefined         { return tagText(el, "mood"); }

// ── hooks ─────────────────────────────────────────────────────────────

export function useScenes(slug: string | undefined) {
  const key = slug ? `scenes:${slug}` : null;
  // P1-38 (2026-05-28 audit wave 4): fetch 失败时给空数组 fallback, 防止 caller 硬解构 data 整页崩.
  return useSWR<Scene[]>(
    key,
    async () => {
      const { elements } = await listElements(slug!, "scene");
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

export function useScene(slug: string | undefined, sceneId: string | undefined) {
  const key = slug && sceneId ? `scenes-item:${slug}:${sceneId}` : null;
  return useSWR<Scene>(
    key,
    async () => {
      const { element } = await getElement(slug!, sceneId!);
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

function sceneToElementCreate(input: SceneCreate) {
  const tags = [
    ...(input.visual_style ? [{ axis: "visual", value: input.visual_style }] : []),
    ...(input.location ? [{ axis: "location", value: input.location }] : []),
    ...(input.time_of_day ? [{ axis: "time", value: input.time_of_day }] : []),
    ...(input.mood ? [{ axis: "mood", value: input.mood }] : []),
  ];
  return {
    kind: "scene" as ElementKind,
    name: input.name,
    description: input.description ?? "",
    tags,
  };
}

function scenePatchToElementPatch(patch: ScenePatch) {
  const result: { name?: string; description?: string; tags?: { axis: string; value: string }[] } = {};
  if (patch.name !== undefined) result.name = patch.name;
  if (patch.description !== undefined) result.description = patch.description;
  const tags = [];
  if (patch.visual_style !== undefined) tags.push({ axis: "visual", value: patch.visual_style });
  if (patch.location !== undefined) tags.push({ axis: "location", value: patch.location });
  if (patch.time_of_day !== undefined) tags.push({ axis: "time", value: patch.time_of_day });
  if (patch.mood !== undefined) tags.push({ axis: "mood", value: patch.mood });
  if (tags.length > 0) result.tags = tags;
  return result;
}

export async function createScene(slug: string, input: SceneCreate): Promise<Scene> {
  const { element } = await createElement(slug, sceneToElementCreate(input));
  return element;
}

export async function patchScene(
  slug: string,
  sceneId: string,
  patch: ScenePatch,
): Promise<Scene> {
  const { element } = await patchElement(slug, sceneId, scenePatchToElementPatch(patch));
  return element;
}

export async function deleteScene(slug: string, sceneId: string): Promise<void> {
  await deleteElement(slug, sceneId);
}

export async function lockScene(
  slug: string,
  sceneId: string,
  assetId: string,
): Promise<Scene> {
  const res = await apiPost<{ ok: boolean; scene: any }>(
    `/api/v2/series/${slug}/scenes/${sceneId}/lock`,
    { asset_id: assetId },
  );
  return res.scene;
}
