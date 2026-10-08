/**
 * useStoryboardVersions — W6-B 多版本分镜管理 hook
 *
 * 内部通过 createVersionedListHook factory 实现，对外 export 保持向后兼容。
 * SWR key: ["storyboard-versions", slug, epId]
 */

import { createVersionedListHook } from "./createVersionedListHook";
import type { KeyedMutator } from "swr";

export interface StoryboardVersionEntry {
  id: string;
  series_slug: string;
  episode_id: string;
  name: string;
  script_version_id: string;
  shot_ids: string[];
  created_at: string;
  is_active: boolean;
}

export type StoryboardVersionCreateBody = {
  name?: string;
  script_version_id?: string;
  shot_ids?: string[];
  activate?: boolean;
};

export interface UseStoryboardVersionsResult {
  versions: StoryboardVersionEntry[];
  loading: boolean;
  error: Error | undefined;
  activate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /**
   * 显式新建一个版本。不传 shot_ids 时后端会快照当前 episode 的 shot 列表。
   */
  create: (body: StoryboardVersionCreateBody) => Promise<StoryboardVersionEntry | null>;
  reload: KeyedMutator<{ versions: StoryboardVersionEntry[] }>;
}

// ── factory 实例 ───────────────────────────────────────────────────────
const _useStoryboardVersionsList = createVersionedListHook<
  StoryboardVersionEntry,
  StoryboardVersionCreateBody
>({
  cacheKey: (slug, epId) =>
    slug && epId ? ["storyboard-versions", slug, epId] : null,
  listPath: (slug, epId) =>
    `/api/v2/series/${slug}/episodes/${epId}/storyboard-versions`,
  activatePath: (id, slug, epId) =>
    `/api/v2/series/${slug}/episodes/${epId}/storyboard-versions/${id}/activate`,
  removePath: (id, slug, epId) =>
    `/api/v2/series/${slug}/episodes/${epId}/storyboard-versions/${id}`,
  createPath: (slug, epId) =>
    `/api/v2/series/${slug}/episodes/${epId}/storyboard-versions`,
  listResponseKey: "versions",
  itemResponseKey: "version",
  requiredArgCount: 2,
});

// ── 向后兼容 export ────────────────────────────────────────────────────
export function useStoryboardVersions(
  slug: string | undefined,
  epId: string | undefined,
): UseStoryboardVersionsResult {
  return _useStoryboardVersionsList(slug, epId) as UseStoryboardVersionsResult;
}
