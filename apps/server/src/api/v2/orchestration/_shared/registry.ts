/**
 * Shared singleton ProviderRegistry + CostLedger access.
 *
 * Step 3a extraction — verbatim from orchestrationController.ts.
 * This file is the SINGLE entry point for ProviderRegistry / CostLedger;
 * all routes files import from here.
 */

import { orchestrator } from "../../../../jobs/orchestrator";
import { ProviderRegistry, registerDefaults, CostLedger } from "../../../../../../../packages/providers/src/core/index";
import { getKeyFor, getConfigValue } from "../../../../../../../packages/core/src/localSettings";
import { listPresets } from "../../../../../../../packages/core/src/presets";
import { DATA_ROOT } from "../../../../../../../packages/core/src/index";
import { invalidateLedgerCache } from "../../seriesStore";
import { providerIdFromModelRef } from "../../../../application/generation/modelRef";

// ─── Singleton registry + ledger ──────────────────────────────────

let _registry: ProviderRegistry | null = null;
let _ledger: CostLedger | null = null;

// Map preset IDs to local-settings keys for base_url / model overrides
export const PRESET_CONFIG_KEYS: Record<string, { base: string; model: string }> = {
  mimo_v25pro: { base: "MIMO_OPENAI_BASE_URL", model: "MIMO_TEXT_MODEL" },
  ikuncode_gpt55: { base: "IKUNCODE_LLM_BASE_URL", model: "IKUNCODE_LLM_MODEL" },
};

export function getRegistry(): ProviderRegistry {
  if (_registry) return _registry;
  const llmPresets = listPresets("llm_provider").map((p) => {
    const keys = PRESET_CONFIG_KEYS[p.id];
    if (!keys) return p;
    const baseOverride = getConfigValue(keys.base, "");
    const modelOverride = getConfigValue(keys.model, "");
    return {
      ...p,
      ...(baseOverride ? { base_url: baseOverride } : {}),
      ...(modelOverride ? { model_id: modelOverride } : {}),
    };
  });
  const imagePresets = listPresets("image_provider");
  const videoPresets = listPresets("video_provider");
  const ttsPresets = listPresets("tts_provider");
  _registry = new ProviderRegistry({
    llmPresets, imagePresets, videoPresets, ttsPresets,
    getKeyFor,
  });
  registerDefaults(_registry);
  orchestrator.setRegistry(_registry);
  return _registry;
}

export function reloadRegistry(): ProviderRegistry {
  _registry = null;
  return getRegistry();
}

export function getLedger(): CostLedger {
  if (_ledger) return _ledger;
  _ledger = new CostLedger(DATA_ROOT, (month) => invalidateLedgerCache(month));
  return _ledger;
}

export function resolveLlmProviderId(seriesDefaults: Record<string, any>): string {
  // Prefer series defaults, then global config, then fallback
  const fromSeries = seriesDefaults?.llm_provider_id as string | undefined;
  if (fromSeries) return providerIdFromModelRef(fromSeries) ?? fromSeries;
  return getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55");
}
