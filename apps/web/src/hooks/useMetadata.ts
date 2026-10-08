import { useState, useCallback, useEffect, useRef } from "react";
import { apiPost } from "../lib/api";

export interface MetadataResult {
  titles: string[];
  summary: string;
  tags: string[];
}

export interface UseMetadataResult {
  metadata: MetadataResult | null;
  loading: boolean;
  error: string | null;
  /** Currently selected title (index into titles array) */
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  /** User-edited title (overrides candidate) */
  customTitle: string;
  setCustomTitle: (t: string) => void;
  /** User-edited summary */
  customSummary: string;
  setCustomSummary: (s: string) => void;
  /** Tags (mutable copy) */
  tags: string[];
  addTag: (tag: string) => void;
  removeTag: (index: number) => void;
  /** Regenerate metadata */
  generateMetadata: (seriesSlug: string, epId: string) => Promise<void>;
}

/**
 * Drives POST /episodes/:epId/generate-metadata.
 * Returns 3 title candidates, summary, tags.
 */
export function useMetadata(scopeKey?: string): UseMetadataResult {
  const [metadata, setMetadata] = useState<MetadataResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [customTitle, setCustomTitle] = useState("");
  const [customSummary, setCustomSummary] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setMetadata(null);
    setLoading(false);
    setError(null);
    setSelectedIndex(0);
    setCustomTitle("");
    setCustomSummary("");
    setTags([]);
    inFlightRef.current = null;
    inFlightKeyRef.current = null;
  }, [scopeKey]);

  const generateMetadata = useCallback(async (seriesSlug: string, epId: string) => {
    const nextKey = `${seriesSlug}:${epId}`;
    if (inFlightRef.current && inFlightKeyRef.current === nextKey) {
      return inFlightRef.current;
    }

    const request = (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiPost<{ ok: boolean; metadata: MetadataResult }>(
          `/api/v2/series/${seriesSlug}/episodes/${epId}/generate-metadata`,
          {},
        );
        if (inFlightKeyRef.current !== nextKey) {
          return;
        }
        if (res.ok && res.metadata) {
          setMetadata(res.metadata);
          setSelectedIndex(0);
          setCustomTitle(res.metadata.titles[0] ?? "");
          setCustomSummary(res.metadata.summary ?? "");
          setTags([...res.metadata.tags]);
        } else {
          setError("元数据生成失败");
        }
      } catch (err: any) {
        if (inFlightKeyRef.current !== nextKey) {
          return;
        }
        setError(err?.message ?? "元数据生成请求失败");
      } finally {
        if (inFlightKeyRef.current !== nextKey) {
          return;
        }
        setLoading(false);
      }
    })();

    inFlightRef.current = request;
    inFlightKeyRef.current = nextKey;
    try {
      await request;
    } finally {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
        inFlightKeyRef.current = null;
      }
    }
  }, []);

  const addTag = useCallback((tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags(prev => [...prev, trimmed]);
    }
  }, [tags]);

  const removeTag = useCallback((index: number) => {
    setTags(prev => prev.filter((_, i) => i !== index));
  }, []);

  return {
    metadata, loading, error,
    selectedIndex, setSelectedIndex,
    customTitle, setCustomTitle,
    customSummary, setCustomSummary,
    tags, addTag, removeTag,
    generateMetadata,
  };
}
