import useSWR from "swr";
import { apiGet, ApiError } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";

/**
 * Episode 数据，与 useEpisodeScript 中的 EpisodeData 结构一致。
 * 此处用 SWR 以支持 ["episode", slug, epId] 缓存键供全局 (AppSideNav 等) 读取。
 */
export interface EpisodeData {
  id: string;
  series_slug: string;
  title: string;
  script_md?: string;
  version?: number;
  versions?: EpisodeVersion[];
  overrides?: Record<string, string>;
  status: string;
}

export interface EpisodeVersion {
  version: number;
  created_at: string;
  source: "ai_init" | "user_edit" | "ai_revise" | "revert";
  summary?: string;
  script_md: string;
}

/**
 * 用 SWR 读取单集详情，key=["episode", slug, epId]。
 * slug 或 epId 为空时 suspense 自动跳过（传 null key）。
 */
export function useEpisode(slug: string | undefined, epId: string | undefined) {
  return useSWR(
    slug && epId ? ["episode", slug, epId] : null,
    async () => {
      const data = await apiGet<{ episode: EpisodeData }>(
        `/api/v2/series/${slug}/episodes/${epId}`
      );
      return data.episode;
    },
    {
      revalidateOnFocus: false,
      onError: (err) => {
        showErrorToast(err);
      },
    }
  );
}
