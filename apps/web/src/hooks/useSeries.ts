import useSWR from "swr";
import { apiGet, ApiError } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";

export interface SeriesDefaults {
  content_type: string;
  platform: string;
  aspect_ratio: string;
  visual_style: string;
  audience: string;
  tone: string;
  pace: string;
  camera_style: string;
  ending_type: string;
  episode_count: number;
  episode_duration: string;
  llm: string;
  // 2026-05-17 voice-sync v1: 系列默认 TTS provider + voice (后端 series.json 已有,前端这里声明出来)
  tts_provider_id?: string;
  tts_voice_id?: string;
}

export interface Series {
  slug: string;
  title: string;
  defaults: SeriesDefaults;
  created_at: string;
  updated_at: string;
  episode_count: number;
}

export interface SeriesEpisode {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

export function useSeries(slug: string | undefined) {
  return useSWR(
    slug ? ["series", slug] : null,
    () => apiGet<Series>(`/api/v2/series/${slug}`),
    {
      revalidateOnFocus: false,
      onError: (err) => {
        showErrorToast(err);
      },
    }
  );
}

export function useSeriesEpisodes(slug: string | undefined) {
  return useSWR(
    slug ? ["series", slug, "episodes"] : null,
    () => apiGet<{ episodes: SeriesEpisode[] }>(`/api/v2/series/${slug}/episodes`),
    {
      revalidateOnFocus: false,
      onError: (err) => {
        showErrorToast(err);
      },
    }
  );
}
