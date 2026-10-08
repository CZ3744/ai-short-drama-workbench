import type { ApiType, PatchProviderInput } from "./api";

export interface ProviderFormState {
  id: string;
  label_zh: string;
  api_type: ApiType;
  base_url: string;
  api_key: string;
  model_id: string;
  custom_headers: Record<string, string>;
  anthropic_version: string;
  notes: string;
  enabled: boolean;
}

/** Blank Key means keep it; explicit empty header values must reach the server. */
export function buildProviderUpdate(form: ProviderFormState, builtin: boolean): PatchProviderInput {
  const patch: PatchProviderInput = {
    label_zh: form.label_zh, model_id: form.model_id || undefined,
    notes: form.notes || undefined, enabled: form.enabled,
    custom_headers: Object.fromEntries(Object.entries(form.custom_headers).map(([key, value]) => [key, value.trim()])),
  };
  if (form.base_url.trim()) patch.base_url = form.base_url.trim();
  if (!builtin) {
    patch.api_type = form.api_type;
    if (form.api_type === "anthropic") patch.anthropic_version = form.anthropic_version || "2023-06-01";
  }
  if (form.api_key.trim()) patch.api_key = form.api_key.trim();
  return patch;
}
