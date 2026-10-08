import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";

export interface VersionEntry {
  version: number;
  created_at: string;
  source: "ai_init" | "user_edit" | "ai_revise" | "revert";
  summary?: string;
  script_md: string;
}

interface UseVersionsResult {
  versions: VersionEntry[];
  loading: boolean;
  error: string | null;
  /** 回滚到指定版本 */
  revertTo: (version: number) => Promise<boolean>;
  /** 比较两个版本的文本 */
  getVersionText: (version: number) => string;
  reload: () => Promise<void>;
}

/**
 * 版本时间线管理。
 */
export function useVersions(slug: string, epId: string): UseVersionsResult {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchVersions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiGet<{ versions: VersionEntry[] }>(
        `/api/v2/series/${slug}/episodes/${epId}/versions`
      );
      setVersions(data.versions || []);
    } catch (e: any) {
      setError(e?.message || "加载版本历史失败");
    } finally {
      setLoading(false);
    }
  }, [slug, epId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const revertTo = useCallback(
    async (version: number): Promise<boolean> => {
      try {
        await apiPost(`/api/v2/series/${slug}/episodes/${epId}/revert`, { to_version: version });
        await fetchVersions();
        return true;
      } catch (e: any) {
        setError(e?.message || "回滚失败");
        return false;
      }
    },
    [slug, epId, fetchVersions]
  );

  const getVersionText = useCallback(
    (version: number): string => {
      const v = versions.find((v) => v.version === version);
      return v?.script_md || "";
    },
    [versions]
  );

  return {
    versions,
    loading,
    error,
    revertTo,
    getVersionText,
    reload: fetchVersions,
  };
}
