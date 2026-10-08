import { useCallback, useState } from "react";
import { apiPost } from "../lib/api";
import { useAsyncAction } from "./useAsyncAction";

export interface CoverAsset {
  asset_id: string;
  path: string;
  width: number;
  height: number;
}

export interface UseCoverResult {
  cover: CoverAsset | null;
  loading: boolean;
  error: string | null;
  generateCover: (seriesSlug: string, epId: string, style?: string, titleText?: string, llmProviderId?: string) => Promise<void>;
  setCover: (cover: CoverAsset | null) => void;
}

/**
 * Drives POST /episodes/:epId/generate-cover.
 * Returns cover asset info (path, dimensions).
 *
 * P2 (2026-05-20): 用 useAsyncAction 接管 busy/try/catch — 调用者拿到的 error 仍是 string (inline 展示用)
 */
export function useCover(): UseCoverResult {
  const [cover, setCover] = useState<CoverAsset | null>(null);
  const [error, setError] = useState<string | null>(null);

  const action = useAsyncAction(
    async (args: { seriesSlug: string; epId: string; style?: string; titleText?: string; llmProviderId?: string }) => {
      const body: Record<string, any> = { style: args.style, title_text: args.titleText };
      if (args.llmProviderId) {
        body.overrides = { llm_provider_id: args.llmProviderId };
      }
      const res = await apiPost<{ ok: boolean; asset: CoverAsset }>(
        `/api/v2/series/${args.seriesSlug}/episodes/${args.epId}/generate-cover`,
        body,
      );
      if (!res.ok || !res.asset) throw new Error("封面生成失败");
      return res.asset;
    },
    {
      silent: true,
      onSuccess: (asset) => {
        setError(null);
        setCover(asset);
      },
      onError: (err: any) => setError(err?.message ?? "封面生成请求失败"),
    },
  );

  const generateCover = useCallback(
    async (seriesSlug: string, epId: string, style?: string, titleText?: string, llmProviderId?: string) => {
      await action.run({ seriesSlug, epId, style, titleText, llmProviderId });
    },
    [action],
  );

  return { cover, loading: action.busy, error, generateCover, setCover };
}
