/**
 * useScriptVersions — W6-B 多版本剧本管理 hook
 *
 * 内部通过 createVersionedListHook factory 实现，对外 export 保持向后兼容。
 * SWR key: ["script-versions", slug]
 */

import { createVersionedListHook } from "./createVersionedListHook";
import type { KeyedMutator } from "swr";

export interface ScriptVersionEntry {
  id: string;
  series_slug: string;
  title: string;
  content_md: string;
  source_inspirations: string[];
  user_prompt?: string;
  created_at: string;
  is_active: boolean;
  parent_version_id?: string;
}

export type ScriptVersionCreateBody = {
  title?: string;
  content_md?: string;
  source_inspirations?: string[];
  user_prompt?: string;
  parent_version_id?: string;
  activate?: boolean;
};

export interface UseScriptVersionsResult {
  versions: ScriptVersionEntry[];
  loading: boolean;
  error: Error | undefined;
  /** 切换激活版本（旧 series.script_md 镜像也会被同步刷新） */
  activate: (id: string) => Promise<void>;
  /** 软删一个版本 */
  remove: (id: string) => Promise<void>;
  /**
   * 显式新建一个版本（手动快照 / fork）。
   * 不传 content_md 时后端会取当前 series.script_md 作为快照。
   */
  create: (body: ScriptVersionCreateBody) => Promise<ScriptVersionEntry | null>;
  reload: KeyedMutator<{ versions: ScriptVersionEntry[] }>;
}

// ── factory 实例 ───────────────────────────────────────────────────────
const _useScriptVersionsList = createVersionedListHook<
  ScriptVersionEntry,
  ScriptVersionCreateBody
>({
  cacheKey: (slug) => (slug ? ["script-versions", slug] : null),
  listPath: (slug) => `/api/v2/series/${slug}/script-versions`,
  activatePath: (id, slug) => `/api/v2/series/${slug}/script-versions/${id}/activate`,
  removePath: (id, slug) => `/api/v2/series/${slug}/script-versions/${id}`,
  createPath: (slug) => `/api/v2/series/${slug}/script-versions`,
  listResponseKey: "versions",
  itemResponseKey: "version",
  requiredArgCount: 1,
});

// ── 向后兼容 export ────────────────────────────────────────────────────
export function useScriptVersions(slug: string | undefined): UseScriptVersionsResult {
  return _useScriptVersionsList(slug) as UseScriptVersionsResult;
}
