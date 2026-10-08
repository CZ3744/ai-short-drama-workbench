import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths";

// --- Types ---

export interface ModelPreset {
  id: string;
  label: string;
  prompt_max_chars: number;
  negative_prompt_max_chars: number;
  duration_mode: "fixed" | "fixed_options" | "range" | "any";
  duration_fixed?: number;
  duration_options?: number[];
  duration_min?: number;
  duration_max?: number;
  duration_default: number;
  resolution_tiers: string[];
  default_resolution_tier: string;
  aspect_ratios: string[];
  default_aspect_ratio: string;
  supports_prompt_extend: boolean;
  supports_watermark: boolean;
  supports_seed: boolean;
  supports_audio: boolean;
  supports_shot_type?: boolean;
  shot_type_options?: string[];
  cost_level: string;
  notes?: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  needs_api_key: boolean;
  is_real_video: boolean;
  region?: string;
  base_url?: string;
  submit_endpoint?: string;
  query_endpoint_prefix?: string;
  supports: {
    text_to_video: boolean;
    image_to_video: boolean;
  };
  models: Record<string, ModelPreset>;
}

export interface VideoProviderPresets {
  version: string;
  updated_at: string;
  providers: Record<string, ProviderPreset>;
  resolution_sizes: Record<string, Record<string, string>>;
  default_provider: string;
  default_model_overrides: Record<string, string>;
}

export interface PresetSelection {
  providerId: string;
  modelId: string;
  aspectRatio: string;
  resolutionTier: string;
  duration: number;
  size: string;
  promptExtend?: boolean;
  watermark?: boolean;
  seed?: number;
  negativePrompt?: string;
}

export interface PresetValidationError {
  field: string;
  message: string;
  allowed?: string[] | number[];
}

// --- Cache ---

let _presetsCache: VideoProviderPresets | null = null;
let _presetsCacheMtime = 0;

const PRESETS_PATH = path.join(repoRoot, "config", "video_provider_presets.json");

// --- Read presets ---

export function readVideoProviderPresets(): VideoProviderPresets {
  try {
    const stat = fs.statSync(PRESETS_PATH);
    if (_presetsCache && stat.mtimeMs === _presetsCacheMtime) {
      return _presetsCache;
    }
    const raw = fs.readFileSync(PRESETS_PATH, "utf8");
    const parsed = JSON.parse(raw) as VideoProviderPresets;
    _presetsCache = parsed;
    _presetsCacheMtime = stat.mtimeMs;
    return parsed;
  } catch {
    if (_presetsCache) return _presetsCache;
    // Return minimal defaults if file missing
    return {
      version: "0.0.0",
      updated_at: "",
      providers: {},
      resolution_sizes: {},
      default_provider: "local_mock_video",
      default_model_overrides: {}
    };
  }
}

export function invalidatePresetsCache(): void {
  _presetsCache = null;
  _presetsCacheMtime = 0;
}

// --- Get provider preset ---

export function getVideoProviderPreset(providerId: string): ProviderPreset | null {
  const presets = readVideoProviderPresets();
  return presets.providers[providerId] || null;
}

// --- Get model preset ---

export function getModelPreset(providerId: string, modelId: string): ModelPreset | null {
  const provider = getVideoProviderPreset(providerId);
  if (!provider) return null;
  return provider.models[modelId] || null;
}

// --- List providers ---

export function listVideoProviders(): ProviderPreset[] {
  const presets = readVideoProviderPresets();
  return Object.values(presets.providers).filter(p => p.enabled);
}

// --- List models for a provider ---

export function listModelsForProvider(providerId: string): ModelPreset[] {
  const provider = getVideoProviderPreset(providerId);
  if (!provider) return [];
  return Object.values(provider.models);
}

// --- Resolve size from resolution tier + aspect ratio ---

export function resolveSize(resolutionTier: string, aspectRatio: string): string | null {
  const presets = readVideoProviderPresets();
  const tierSizes = presets.resolution_sizes[resolutionTier];
  if (!tierSizes) return null;
  return tierSizes[aspectRatio] || null;
}

// --- Resolve and validate a preset selection ---

export function resolveVideoPresetSelection(input: {
  providerId: string;
  modelId?: string;
  aspectRatio?: string;
  resolutionTier?: string;
  duration?: number;
  promptExtend?: boolean;
  watermark?: boolean;
  seed?: number;
  negativePrompt?: string;
}): { ok: true; selection: PresetSelection } | { ok: false; errors: PresetValidationError[] } {
  const errors: PresetValidationError[] = [];
  const presets = readVideoProviderPresets();

  // Validate provider
  const provider = presets.providers[input.providerId];
  if (!provider) {
    return {
      ok: false,
      errors: [{
        field: "providerId",
        message: `Unknown provider: ${input.providerId}`,
        allowed: Object.keys(presets.providers)
      }]
    };
  }

  if (!provider.enabled) {
    return {
      ok: false,
      errors: [{ field: "providerId", message: `Provider ${input.providerId} is disabled` }]
    };
  }

  // Resolve model
  const defaultModel = presets.default_model_overrides[input.providerId];
  const modelId = input.modelId || defaultModel || Object.keys(provider.models)[0];
  const model = provider.models[modelId];
  if (!model) {
    return {
      ok: false,
      errors: [{
        field: "modelId",
        message: `Unknown model ${modelId} for provider ${input.providerId}`,
        allowed: Object.keys(provider.models)
      }]
    };
  }

  // Resolve aspect ratio
  const aspectRatio = input.aspectRatio || model.default_aspect_ratio;
  if (!model.aspect_ratios.includes(aspectRatio)) {
    errors.push({
      field: "aspectRatio",
      message: `Aspect ratio ${aspectRatio} not supported by model ${modelId}`,
      allowed: model.aspect_ratios
    });
  }

  // Resolve resolution tier
  const resolutionTier = input.resolutionTier || model.default_resolution_tier;
  if (!model.resolution_tiers.includes(resolutionTier)) {
    errors.push({
      field: "resolutionTier",
      message: `Resolution tier ${resolutionTier} not supported by model ${modelId}`,
      allowed: model.resolution_tiers
    });
  }

  // Resolve size
  const size = resolveSize(resolutionTier, aspectRatio);
  if (!size && !errors.some(e => e.field === "resolutionTier" || e.field === "aspectRatio")) {
    errors.push({
      field: "size",
      message: `No size mapping for ${resolutionTier} + ${aspectRatio}`
    });
  }

  // Resolve and validate duration
  let duration = input.duration ?? model.duration_default;
  let durationWarning: string | undefined;

  switch (model.duration_mode) {
    case "fixed":
      // v0.2.4 fix: non-null assertion could inject undefined into the request
      // body if a preset JSON forgot to declare duration_fixed.
      if (typeof model.duration_fixed !== "number") {
        errors.push({
          field: "duration_fixed",
          message: `Model ${modelId} declared duration_mode="fixed" but duration_fixed is missing; falling back to duration_default.`,
          allowed: model.duration_default != null ? [model.duration_default] : undefined
        });
        duration = typeof model.duration_default === "number" ? model.duration_default : duration;
      } else if (duration !== model.duration_fixed) {
        durationWarning = `Model ${modelId} requires duration=${model.duration_fixed}, auto-corrected from ${duration}`;
        duration = model.duration_fixed;
      }
      break;
    case "fixed_options":
      if (model.duration_options && !model.duration_options.includes(duration)) {
        errors.push({
          field: "duration",
          message: `Duration ${duration} not supported by model ${modelId}`,
          allowed: model.duration_options
        });
      }
      break;
    case "range":
      if (model.duration_min !== undefined && duration < model.duration_min) {
        errors.push({
          field: "duration",
          message: `Duration ${duration} is below minimum ${model.duration_min} for model ${modelId}`
        });
      }
      if (model.duration_max !== undefined && duration > model.duration_max) {
        errors.push({
          field: "duration",
          message: `Duration ${duration} exceeds maximum ${model.duration_max} for model ${modelId}`
        });
      }
      break;
    case "any":
      break;
  }

  // Validate negative prompt length
  if (input.negativePrompt && input.negativePrompt.length > model.negative_prompt_max_chars) {
    errors.push({
      field: "negativePrompt",
      message: `Negative prompt exceeds ${model.negative_prompt_max_chars} chars (got ${input.negativePrompt.length})`
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const selection: PresetSelection = {
    providerId: input.providerId,
    modelId,
    aspectRatio,
    resolutionTier,
    duration,
    size: size!,
    promptExtend: input.promptExtend ?? (model.supports_prompt_extend ? true : undefined),
    watermark: input.watermark ?? (model.supports_watermark ? false : undefined),
    seed: input.seed,
    negativePrompt: input.negativePrompt
  };

  return { ok: true, selection };
}

// --- Redact video_url from raw status ---

export function redactVideoUrl(raw: unknown): unknown {
  if (typeof raw === "string") {
    return raw.replace(/https?:\/\/[^\s"]+\.mp4[^\s"]*/gi, "[VIDEO_URL_REDACTED]");
  }
  if (Array.isArray(raw)) return raw.map(redactVideoUrl);
  if (raw && typeof raw === "object") {
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => {
        const lower = k.toLowerCase();
        if (lower === "video_url" || lower === "download_url") {
          return [k, typeof v === "string" && v.length > 0 ? "[VIDEO_URL_REDACTED]" : v];
        }
        return [k, redactVideoUrl(v)];
      })
    );
  }
  return raw;
}
