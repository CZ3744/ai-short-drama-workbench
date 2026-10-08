/**
 * useSeriesAssets — 统一 series 素材 SWR hook
 *
 * 合并了原 useCharacterAssets / useSceneAssets（两者字段完全相同）。
 * 原 hook 文件保留向后兼容 re-export。
 */
import useSWR from "swr";
import { apiGet, apiDelete } from "../lib/api";

// ── 统一接口（原 CharacterAsset / SceneAsset 字段完全一致）────────────
export interface SeriesAsset {
  asset_id: string;
  series_slug: string;
  kind: "image" | "video" | "audio";
  tags: string[];
  path: string;
  filename: string;
  mime: string;
  size_bytes: number;
  sha256?: string;
  created_at: string;
}

const fetcher = (url: string) =>
  apiGet<{ assets: SeriesAsset[] }>(url).then((r) => r.assets);

/**
 * Fetch assets tagged with `"${entityKind}:${entityId}"` for a given series.
 *
 * @param entityKind  "character" | "scene" (可扩展到其他 kind)
 * @param entityId    对应实体 id
 */
export function useSeriesAssets(
  slug: string | undefined,
  entityKind: string,
  entityId: string | undefined,
) {
  const tag = entityId ? `${entityKind}:${entityId}` : null;
  const key =
    slug && tag
      ? `/api/v2/series/${slug}/assets?tags=${encodeURIComponent(tag)}`
      : null;
  return useSWR<SeriesAsset[]>(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
  });
}

export async function deleteSeriesAsset(
  slug: string,
  assetId: string,
): Promise<void> {
  await apiDelete(`/api/v2/series/${slug}/assets/${assetId}`);
}
