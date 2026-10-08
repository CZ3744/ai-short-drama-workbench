import { getConfigValue, getConfigValueAny, readLocalSettings, writeLocalSettings, saveSecrets, clearSecret, type SubtitleMode } from "../../core/src/index";
import type { TtsProviderName } from "./tts";

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  mock: boolean;
  subtitleMode: SubtitleMode;
  ttsProvider: TtsProviderName;
  ttsFallbackProvider: TtsProviderName;
  ttsVoice: string;
  ttsRate: string;
  ttsEnabled: boolean;
}

export interface PublicRuntimeSettings {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  mock: boolean;
  apiKeyPresent: boolean;
  localApiKeyPresent: boolean;
  subtitleMode: SubtitleMode;
  ttsProvider: TtsProviderName;
  ttsFallbackProvider: TtsProviderName;
  ttsVoice: string;
  ttsRate: string;
  ttsEnabled: boolean;
  globalModelProvider: string;
  settingsPath: string;
}

export interface LocalSettingsInput {
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_API_KEY?: string;
  LLM_TEMPERATURE?: number | string;
  MOCK_LLM?: boolean | string;
  SUBTITLE_MODE?: SubtitleMode;
  TTS_PROVIDER?: TtsProviderName;
  TTS_FALLBACK_PROVIDER?: TtsProviderName;
  TTS_VOICE?: string;
  TTS_RATE?: string;
  TTS_ENABLED?: boolean | string;
  GLOBAL_MODEL_PROVIDER?: string;
}

export function loadLlmConfig(): LlmConfig {
  const apiKey = getConfigValueAny(["IKUNCODE_API_KEY", "LLM_API_KEY"]);
  const mockRaw = getConfigValue("MOCK_LLM");
  const subtitleMode = normalizeSubtitleMode(getConfigValue("SUBTITLE_MODE", "both"));
  const ttsProvider = normalizeTtsProvider(getConfigValue("TTS_PROVIDER", "edge_tts"));
  const ttsFallbackProvider = normalizeTtsProvider(getConfigValue("TTS_FALLBACK_PROVIDER", "edge_tts"));
  const ttsEnabledRaw = getConfigValue("TTS_ENABLED", "true");

  return {
    provider: getConfigValue("LLM_PROVIDER", "ikuncode").trim() || "ikuncode",
    baseUrl: getConfigValueAny(["IKUNCODE_LLM_BASE_URL", "LLM_BASE_URL"], "https://api.ikuncode.cc/v1").trim() || "https://api.ikuncode.cc/v1",
    apiKey: apiKey.trim(),
    model: getConfigValueAny(["IKUNCODE_LLM_MODEL", "LLM_MODEL"], "gpt-5.5").trim() || "gpt-5.5",
    temperature: Number(getConfigValue("LLM_TEMPERATURE", "0.35")),
    mock: mockRaw === "true" || mockRaw === "1" || apiKey.trim().length === 0,
    subtitleMode,
    ttsProvider,
    ttsFallbackProvider,
    ttsVoice: getConfigValue("TTS_VOICE", "zh-CN-YunxiNeural").trim() || "zh-CN-YunxiNeural",
    ttsRate: getConfigValue("TTS_RATE", "+0%").trim() || "+0%",
    ttsEnabled: ttsEnabledRaw === "true" || ttsEnabledRaw === "1"
  };
}

export function loadPublicRuntimeSettings(): PublicRuntimeSettings {
  const config = loadLlmConfig();
  const local = readLocalSettings();
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    mock: config.mock,
    apiKeyPresent: Boolean(config.apiKey),
    localApiKeyPresent: Boolean(local.IKUNCODE_API_KEY || local.LLM_API_KEY),
    subtitleMode: config.subtitleMode,
    ttsProvider: config.ttsProvider,
    ttsFallbackProvider: config.ttsFallbackProvider,
    ttsVoice: config.ttsVoice,
    ttsRate: config.ttsRate,
    ttsEnabled: config.ttsEnabled,
    globalModelProvider: getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55"),
    settingsPath: "config/local-settings.json"
  };
}

export async function saveLocalSettings(input: LocalSettingsInput) {
  const patch: Record<string, string | null> = {};
  if (typeof input.LLM_BASE_URL === "string") {
    patch.LLM_BASE_URL = input.LLM_BASE_URL.trim();
    patch.IKUNCODE_LLM_BASE_URL = input.LLM_BASE_URL.trim();
  }
  if (typeof input.LLM_MODEL === "string") {
    patch.LLM_MODEL = input.LLM_MODEL.trim();
    patch.IKUNCODE_LLM_MODEL = input.LLM_MODEL.trim();
  }
  if (input.LLM_API_KEY !== undefined && String(input.LLM_API_KEY).trim()) {
    patch.LLM_API_KEY = String(input.LLM_API_KEY).trim();
    patch.IKUNCODE_API_KEY = String(input.LLM_API_KEY).trim();
  }
  if (input.LLM_TEMPERATURE !== undefined) {
    const value = Number(input.LLM_TEMPERATURE);
    patch.LLM_TEMPERATURE = Number.isFinite(value) ? String(value) : "0.35";
  }
  if (input.MOCK_LLM !== undefined) patch.MOCK_LLM = String(input.MOCK_LLM === true || input.MOCK_LLM === "true");
  if (input.SUBTITLE_MODE !== undefined) patch.SUBTITLE_MODE = normalizeSubtitleMode(input.SUBTITLE_MODE);
  if (input.TTS_PROVIDER !== undefined) patch.TTS_PROVIDER = normalizeTtsProvider(input.TTS_PROVIDER);
  if (input.TTS_FALLBACK_PROVIDER !== undefined) patch.TTS_FALLBACK_PROVIDER = normalizeTtsProvider(input.TTS_FALLBACK_PROVIDER);
  if (input.TTS_VOICE !== undefined) patch.TTS_VOICE = String(input.TTS_VOICE).trim();
  if (input.TTS_RATE !== undefined) patch.TTS_RATE = String(input.TTS_RATE).trim();
  if (input.TTS_ENABLED !== undefined) patch.TTS_ENABLED = String(input.TTS_ENABLED === true || input.TTS_ENABLED === "true");
  if (input.GLOBAL_MODEL_PROVIDER !== undefined) patch.GLOBAL_MODEL_PROVIDER = String(input.GLOBAL_MODEL_PROVIDER).trim();

  await writeLocalSettings(patch);
  return loadPublicRuntimeSettings();
}

export async function clearLocalApiKey() {
  await clearSecret("ikuncode");
  return loadPublicRuntimeSettings();
}

export function normalizeSubtitleMode(value: unknown): SubtitleMode {
  if (value === "sidecar" || value === "burn" || value === "both") return value;
  return "both";
}

export function normalizeTtsProvider(value: unknown): TtsProviderName {
  if (value === "silence" || value === "edge_tts" || value === "windows_sapi" || value === "piper" || value === "mimo_tts") return value;
  return "edge_tts";
}
