import { useState, useCallback, useEffect } from "react";
import {
  listProviderPresets,
  listCustomProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  fetchProviderModels,
  speedTestProvider,
  type ProviderConfig,
  type ProviderWithQuota,
  type PresetsGroupedResponse,
  type CreateProviderInput,
  type PatchProviderInput,
  type FetchModelsResult,
  type SpeedTestResult,
} from "../lib/api";

interface UseProvidersReturn {
  presets: PresetsGroupedResponse | null;
  customProviders: ProviderConfig[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  selectedProvider: ProviderWithQuota | null;

  // Actions
  refresh: () => Promise<void>;
  selectProvider: (id: string | null) => void;
  create: (input: CreateProviderInput) => Promise<ProviderConfig>;
  update: (id: string, input: PatchProviderInput) => Promise<ProviderConfig>;
  remove: (id: string) => Promise<void>;
  fetchModels: (id: string) => Promise<FetchModelsResult>;
  speedTest: (id: string) => Promise<SpeedTestResult>;

  // Per-action states
  saving: boolean;
  deleting: boolean;
  fetchingModels: boolean;
  speedTesting: boolean;
  modelsResult: FetchModelsResult | null;
  speedTestResult: SpeedTestResult | null;
}

export function useProviders(): UseProvidersReturn {
  const [presets, setPresets] = useState<PresetsGroupedResponse | null>(null);
  const [customProviders, setCustomProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Per-action states
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [speedTesting, setSpeedTesting] = useState(false);
  const [modelsResult, setModelsResult] = useState<FetchModelsResult | null>(null);
  const [speedTestResult, setSpeedTestResult] = useState<SpeedTestResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [presetsData, customsData] = await Promise.all([
        listProviderPresets(),
        listCustomProviders(),
      ]);
      setPresets(presetsData);
      setCustomProviders(customsData.providers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Selected provider computed
  const selectedProvider: ProviderWithQuota | null = (() => {
    if (!selectedId) return null;
    if (presets) {
      for (const kind of ["llm", "image", "video", "tts"] as const) {
        const found = presets.providers[kind]?.find((p) => p.id === selectedId);
        if (found) return found;
      }
    }
    const custom = customProviders.find((p) => p.id === selectedId);
    if (custom) {
      return {
        ...custom,
        quota: { color: "gray" as const, label: "自定义" },
      } satisfies ProviderWithQuota;
    }
    return null;
  })();

  const selectProvider = useCallback((id: string | null) => {
    setSelectedId(id);
    // Reset per-action states when switching
    setModelsResult(null);
    setSpeedTestResult(null);
  }, []);

  const create = useCallback(async (input: CreateProviderInput): Promise<ProviderConfig> => {
    setSaving(true);
    try {
      const res = await createProvider(input);
      await refresh();
      return res.provider;
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const update = useCallback(async (id: string, input: PatchProviderInput): Promise<ProviderConfig> => {
    setSaving(true);
    try {
      const res = await updateProvider(id, input);
      await refresh();
      return res.provider;
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const remove = useCallback(async (id: string): Promise<void> => {
    setDeleting(true);
    try {
      await deleteProvider(id);
      if (selectedId === id) setSelectedId(null);
      await refresh();
    } finally {
      setDeleting(false);
    }
  }, [refresh, selectedId]);

  const fetchModels = useCallback(async (id: string): Promise<FetchModelsResult> => {
    setFetchingModels(true);
    try {
      const res = await fetchProviderModels(id);
      setModelsResult(res);
      // Also update cache in custom providers
      await refresh();
      return res;
    } finally {
      setFetchingModels(false);
    }
  }, [refresh]);

  const speedTest = useCallback(async (id: string): Promise<SpeedTestResult> => {
    setSpeedTesting(true);
    try {
      const res = await speedTestProvider(id);
      setSpeedTestResult(res);
      return res;
    } finally {
      setSpeedTesting(false);
    }
  }, []);

  return {
    presets,
    customProviders,
    loading,
    error,
    selectedId,
    selectedProvider,
    refresh,
    selectProvider,
    create,
    update,
    remove,
    fetchModels,
    speedTest,
    saving,
    deleting,
    fetchingModels,
    speedTesting,
    modelsResult,
    speedTestResult,
  };
}
