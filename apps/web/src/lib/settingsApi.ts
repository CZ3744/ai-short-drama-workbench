// ====================================================================
// settingsApi.ts — Settings / Secrets / Budget (P1 wave 2 #11 解耦)
// ====================================================================
// 覆盖范围:
// - MimoConfig / TtsSettings / MimoTestResult / TtsTestResult / TtsProviderInfo
// - SecretsStatus / SaveSecretsInput / ProviderTestResult
// - V2Settings / PatchV2SettingsInput / BudgetStatus
// - 测试 voice / multimodal image test
// ====================================================================

import {
  apiGet,
  apiPost,
  apiPatch,
  handleResponse,
} from "./_apiClient";

// MiMo 相关 API
export interface MimoConfig {
  apiKeyPresent: boolean;
  baseUrl: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  textModel: string;
  multimodalModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
  note: string;
}

export interface MimoTestResult {
  ok: boolean;
  provider: string;
  model: string;
  mode: "text" | "multimodal";
  message: string;
  error?: string;
  suggestion?: string;
}

export interface TtsProviderInfo {
  id: string;
  label: string;
  requiresApiKey: boolean;
}

export interface TtsTestResult {
  ok: boolean;
  provider: string;
  model: string;
  voice: string;
  selected_mode: "chat_completions_audio" | "audio_speech" | "failed";
  selected_auth: "api-key" | "bearer" | "none";
  format: string;
  duration_sec: number;
  output_path: string;
  fallback_used: boolean;
  error: string | null;
  suggestion: string | null;
  error_type?: string;
}

export interface TtsSettings {
  TTS_PROVIDER: string;
  TTS_ENABLED: boolean;
  TTS_RATE: number;
  TTS_VOICE: string;
  MIMO_TTS_MODEL: string;
  MIMO_TTS_VOICE: string;
  MIMO_TTS_FORMAT: string;
  MIMO_TTS_STYLE_PROMPT: string;
  mimoApiKeyPresent: boolean;
}

export async function getMimoConfig() {
  return apiGet<MimoConfig>("/api/mimo/config");
}

export interface MimoMultimodalImageTestResult {
  ok: boolean;
  provider: string;
  model: string;
  mode: "multimodal";
  message: string;
  content_length?: number;
  keywords_found?: string[];
  keywords_expected?: string[];
  keywords_matched?: number;
  content_preview?: string;
  confidence?: number;
  note?: string;
  error?: string;
  suggestion?: string;
}

export async function testMimoMultimodalImage() {
  const response = await fetch("/api/settings/mimo-multimodal-image-test", { method: "POST" });
  await handleResponse(response);
  return response.json() as Promise<MimoMultimodalImageTestResult>;
}

export async function getTtsSettings() {
  return apiGet<TtsSettings>("/api/settings/tts");
}

// ====================================================================
// UNIFIED SETTINGS API
// ====================================================================

export interface SecretsStatus {
  ikuncode: {
    key_present: boolean;
    base_url: string;
    model: string;
  };
  mimo: {
    key_present: boolean;
    openai_base_url: string;
    anthropic_base_url: string;
    text_model: string;
    multimodal_model: string;
    tts_model: string;
    tts_voice: string;
    tts_format: string;
  };
  tts: {
    provider: string;
    fallback_provider: string;
    enabled: boolean;
    voice: string;
    rate: string;
  };
  minimax: {
    key_present: boolean;
    base_url: string;
    model: string;
    duration: string;
    resolution: string;
    prompt_optimizer: boolean;
    fast_pretreatment: boolean;
    aigc_watermark: boolean;
    poll_interval_ms: string;
    poll_timeout_ms: string;
    download_timeout_ms: string;
  };
  video: {
    key_present: boolean;
    provider: string;
    base_url_present: boolean;
    model: string;
    aspect_ratio: string;
    duration_per_scene: string;
    resolution: string;
  };
  image: {
    key_present: boolean;
    provider: string;
    base_url_present: boolean;
    model: string;
    resolution: string;
  };
  aliyun_wan: {
    key_present: boolean;
    base_url: string;
    region: string;
    model: string;
    resolution_tier: string;
    aspect_ratio: string;
    size: string;
    duration: string;
    prompt_extend: boolean;
    watermark: boolean;
    poll_interval_ms: string;
    poll_timeout_ms: string;
  };
  general: {
    global_model_provider: string;
    subtitle_mode: string;
  };
}

export interface SaveSecretsInput {
  ikuncode?: {
    api_key?: string;
    base_url?: string;
    model?: string;
    temperature?: number | string;
  };
  mimo?: {
    api_key?: string;
    openai_base_url?: string;
    anthropic_base_url?: string;
    text_model?: string;
    multimodal_model?: string;
    tts_model?: string;
    tts_voice?: string;
    tts_format?: string;
  };
  tts?: {
    provider?: string;
    fallback_provider?: string;
    enabled?: boolean | string;
    voice?: string;
    rate?: string;
  };
  minimax?: {
    api_key?: string;
    base_url?: string;
    model?: string;
    duration?: string;
    resolution?: string;
    prompt_optimizer?: boolean | string;
    fast_pretreatment?: boolean | string;
    aigc_watermark?: boolean | string;
    poll_interval_ms?: string;
    poll_timeout_ms?: string;
    download_timeout_ms?: string;
  };
  video?: {
    provider?: string;
    api_key?: string;
    base_url?: string;
    model?: string;
    aspect_ratio?: string;
    duration_per_scene?: string;
    resolution?: string;
  };
  image?: {
    provider?: string;
    api_key?: string;
    base_url?: string;
    model?: string;
    resolution?: string;
  };
  aliyun_wan?: {
    api_key?: string;
    base_url?: string;
    region?: string;
    model?: string;
    resolution_tier?: string;
    aspect_ratio?: string;
    size?: string;
    duration?: string;
    prompt_extend?: boolean | string;
    watermark?: boolean | string;
    seed?: string;
    negative_prompt?: string;
    poll_interval_ms?: string;
    poll_timeout_ms?: string;
  };
  general?: {
    global_model_provider?: string;
    subtitle_mode?: string;
    mock_llm?: boolean | string;
  };
  clear_key?: string[];
}

export interface ProviderTestResult {
  ok: boolean;
  provider: string;
  message: string;
  error?: string;
  error_type?: string;
  details?: Record<string, unknown>;
}

// ====================================================================
// V2 SETTINGS API (settingsController)
// ====================================================================

export interface V2Settings {
  settings: Record<string, string>;
  provider_status: SecretsStatus;
}

export interface PatchV2SettingsInput {
  max_parallel_tasks?: number;
  max_retake_per_shot?: number;
  max_video_seconds_per_job?: number;
  max_clip_seconds_per_shot?: number;
  budget_daily_cap_cny?: number;
  budget_single_job_cap_cny?: number;
  budget_per_provider_cap_cny?: number;
  DEFAULT_TTS_VOICE?: string;
  DEFAULT_ASPECT_RATIO?: string;
  DEFAULT_LLM_PROVIDER_ID?: string;
  BURN_SUBTITLES_DEFAULT?: boolean | string;
  EXPORT_SRT_DEFAULT?: boolean | string;
  REAL_VIDEO_ENABLED?: boolean | string;
  // 2026-05-20 Wave T 留尾 — 一致性体检评分器
  CONSISTENCY_SCORER_PROVIDER?: "gemini_flash" | "local_clip" | "phash";
}

export async function getV2Settings() {
  return apiGet<V2Settings>("/api/v2/settings");
}

export async function patchV2Settings(input: PatchV2SettingsInput) {
  return apiPatch<{ ok: boolean; provider_status: SecretsStatus }>("/api/v2/settings", input);
}

export interface BudgetStatus {
  daily_cap_cny: number;
  single_job_cap_cny: number;
  per_provider_cap_cny: number;
  daily_used_cny: number;
  inflight_count: number;
}

export async function getBudgetStatus() {
  return apiGet<BudgetStatus>("/api/v2/settings/budget");
}

// P1-7 (2026-05-31): 用量仪表盘
export interface UsageDayEntry {
  date: string;
  amount_cny: number;
}

export interface UsageProviderEntry {
  provider: string;
  amount_cny: number;
}

export interface UsageStatus {
  period: string;
  total_cny: number;
  daily: UsageDayEntry[];
  by_provider: UsageProviderEntry[];
}

export async function getUsageStatus(period: "day" | "week" | "month" = "month") {
  return apiGet<UsageStatus>(`/api/v2/settings/usage?period=${period}`);
}

export async function getSecretsStatus() {
  return apiGet<SecretsStatus>("/api/settings/secrets-status");
}

export async function saveSecrets(input: SaveSecretsInput) {
  return apiPost<{ ok: boolean; status: SecretsStatus; message: string }>("/api/settings/save-secrets", input);
}

export async function clearSecret(provider: string) {
  return apiPost<{ ok: boolean; status: SecretsStatus; message: string }>("/api/settings/clear-secret", { provider });
}

export async function testProvider(provider: string) {
  return apiPost<ProviderTestResult>("/api/settings/test-provider", { provider });
}

export async function testTtsVoice(input: { voice_id: string; text: string; provider_id?: string }) {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(60_000).
  const response = await fetch("/api/v2/tts/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await handleResponse(response);
  return response.blob();
}

export async function resetMimoBaseUrl() {
  return apiPost<{ ok: boolean; message: string; openaiBaseUrl: string; anthropicBaseUrl: string }>("/api/settings/mimo-reset-base-url");
}

// ────────────────────────────────────────────────────────────────────
// 真实视频生成全局锁状态 (2026-05-26 audit #7 — 从 jobsApi.ts 迁过来,
// jobsApi v1 整文件已删, 唯一被实际用着的 getRealVideoLockStatus 落地这里).
// 后端 endpoint: GET /api/real-video/lock-status (仍在 routes.ts 真活)
// ────────────────────────────────────────────────────────────────────
export interface RealVideoLockStatus {
  locked: boolean;
  holder: {
    provider: string;
    jobId: string;
    sceneId: string;
    startedAt: string;
  } | null;
}

export async function getRealVideoLockStatus() {
  return apiGet<RealVideoLockStatus>("/api/real-video/lock-status");
}
