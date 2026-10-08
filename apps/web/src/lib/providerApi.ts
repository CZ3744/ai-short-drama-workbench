// ====================================================================
// providerApi.ts — Provider Health / Chain / CRUD / cc-switch helpers
// (P1 wave 2 #11 解耦)
// ====================================================================
// 覆盖范围:
// - ProviderKind / ApiType / ProviderConfig / ProviderFourState / ProviderWithQuota
// - ProviderHealthEntry / ProviderHealthResponse / chain CRUD
// - listProviderPresets / CRUD / fetch-models / speed-test
// - cc-switch UserProvider helpers (text/image/video/tts)
// - Diagnostics ping / Preset dict / 模型字典 helper
// ====================================================================

import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
} from "./_apiClient";

// ====================================================================
// P5B: Provider Health & Fallback Chain
// ====================================================================

export type QuotaState = "ok" | "low" | "exhausted" | "unknown";

// 注: ProviderKind 在下方 P5E 段定义, 由于 TS 类型在同文件 forward reference 合法,
// 这里直接用. 旧 api.ts 的顺序保留以便比对.
export type ProviderKind = "llm" | "image" | "video" | "tts";
export type ApiType = "openai_compat" | "anthropic" | "custom";

export interface ProviderHealthEntry {
  id: string;
  name: string;
  kind?: ProviderKind;
  enabled?: boolean;
  key_present: boolean;
  configured?: boolean;
  tested?: boolean;
  healthy?: boolean;
  quota_state: QuotaState;
  last_checked_at: string;
  reason?: string;
}

export interface ProviderHealthResponse {
  providers: ProviderHealthEntry[];
  chain: string[];
  chain_active: string | null;
}

export interface ProviderChainResponse {
  chain: string[];
  chain_active: string | null;
  overridden: boolean;
  override: string[] | null;
}

export interface UpdateChainResult {
  ok: boolean;
  chain: string[];
  chain_active: string;
  message: string;
}

export async function getProviderHealth() {
  return apiGet<ProviderHealthResponse>("/api/v2/providers/health");
}

export async function getProviderChain() {
  return apiGet<ProviderChainResponse>("/api/v2/providers/chain");
}

export async function updateProviderChain(chain: string[]) {
  return apiPost<UpdateChainResult>("/api/v2/providers/chain", { chain });
}

export async function resetProviderChain() {
  return apiDelete<{ ok: boolean; chain: string[]; chain_active: string | null; message: string }>("/api/v2/providers/chain");
}

// ====================================================================
// P5E: Provider CRUD
// ====================================================================

export interface ProviderConfig {
  id: string;
  label_zh: string;
  kind: ProviderKind;
  api_type: ApiType;
  base_url: string;
  api_key?: string;
  model_id?: string;
  model_list_cache?: string[];
  model_list_fetched_at?: string;
  anthropic_version?: string;
  custom_headers?: Record<string, string>;
  timeout_ms?: number;
  max_retries?: number;
  cost_per_1k_tokens_in?: number;
  cost_per_1k_tokens_out?: number;
  notes?: string;
  enabled?: boolean;
  is_builtin?: boolean;
  /** LLM dual builtin only: 两套 api_type 各自的配置 (前端切 api_type 时直接读, 不调后端) */
  api_type_variants?: {
    openai_compat?: { base_url: string; model_id: string; key_present: boolean };
    anthropic?: { base_url: string; model_id: string; key_present: boolean };
  };
}

// B9: Provider four-state status
export interface ProviderFourState {
  available: boolean;
  configured: boolean;
  /** 是否已有健康检查记录（无论通过与否） */
  tested: boolean;
  healthy: boolean;
  enabled_for_generation: boolean;
  last_checked_at: string;
  reason?: string;
}

export interface ProviderWithQuota extends ProviderConfig {
  quota: { color: "green" | "yellow" | "red" | "gray"; label: string };
  /** B9: 四态状态 */
  provider_status?: ProviderFourState;
}

export interface PresetsGroupedResponse {
  providers: {
    llm: ProviderWithQuota[];
    image: ProviderWithQuota[];
    video: ProviderWithQuota[];
    tts: ProviderWithQuota[];
  };
}

export interface CreateProviderInput {
  id: string;
  label_zh: string;
  kind: ProviderKind;
  api_type: ApiType;
  base_url: string;
  api_key: string;
  model_id?: string;
  anthropic_version?: string;
  custom_headers?: Record<string, string>;
  timeout_ms?: number;
  max_retries?: number;
  cost_per_1k_tokens_in?: number;
  cost_per_1k_tokens_out?: number;
  notes?: string;
  enabled?: boolean;
}

export interface PatchProviderInput {
  label_zh?: string;
  kind?: ProviderKind;
  api_type?: ApiType;
  base_url?: string;
  api_key?: string;
  model_id?: string;
  anthropic_version?: string;
  custom_headers?: Record<string, string>;
  timeout_ms?: number;
  max_retries?: number;
  cost_per_1k_tokens_in?: number;
  cost_per_1k_tokens_out?: number;
  notes?: string;
  enabled?: boolean;
}

export interface FetchModelsResult {
  provider_id: string;
  models: string[];
  fetched_at: string;
}

export interface SpeedTestResult {
  provider_id: string;
  model_id: string;
  p50_ms: number;
  p95_ms: number;
  error_rate: number;
  total_requests: number;
  tested_at: string;
}

// List custom providers
export async function listCustomProviders() {
  return apiGet<{ providers: ProviderConfig[] }>("/api/v2/providers");
}

// List all presets (builtin + custom)
export async function listProviderPresets() {
  return apiGet<PresetsGroupedResponse>("/api/v2/providers/presets");
}

// Create custom provider
export async function createProvider(input: CreateProviderInput) {
  return apiPost<{ provider: ProviderConfig }>("/api/v2/providers", input);
}

// Edit custom provider
export async function updateProvider(id: string, input: PatchProviderInput) {
  return apiPatch<{ provider: ProviderConfig }>(`/api/v2/providers/${id}`, input);
}

// Delete custom provider
export async function deleteProvider(id: string) {
  return apiDelete<{ ok: boolean; message: string }>(`/api/v2/providers/${id}`);
}

// Fetch model list from provider
export async function fetchProviderModels(id: string) {
  return apiPost<FetchModelsResult>(`/api/v2/providers/${id}/fetch-models`);
}

// Speed test
export async function speedTestProvider(id: string) {
  return apiPost<SpeedTestResult>(`/api/v2/providers/${id}/speed-test`);
}

export interface ProviderHealthTestResult {
  ok: boolean;
  provider: string;
  message: string;
  error_type?: string;
}

// P1-3: LLM "试一下" — 发一句固定提示词, 收到回复
export interface LlmTryResult {
  ok: boolean;
  provider_id: string;
  prompt?: string;
  reply?: string;
  model?: string;
  error?: string;
}

export async function tryProviderLlm(providerId: string): Promise<LlmTryResult> {
  try {
    return await apiPost<LlmTryResult>(`/api/v2/providers/${providerId}/try`);
  } catch (err: any) {
    return { ok: false, provider_id: providerId, error: err?.message || String(err) };
  }
}

export async function testProviderConnectionV2(id: string, kind?: ProviderKind) {
  return apiPost<ProviderHealthTestResult>(`/api/v2/providers/${id}/test`, kind ? { kind } : {});
}

// ====================================================================
// cc-switch 风格 Provider Settings Helpers (2026-05-13)
// 用于 SettingsPage (text/image/video tab). 包装现有 P5E /api/v2/providers*.
// 后端 kind 是 "llm"|"image"|"video"|"tts"; 这里 UI 把 llm 显示为 "text".
// ====================================================================

/** ProviderConfig 的别名 — UI 层用 UserProvider 这个名字, 沿用后端字段. */
export type UserProvider = ProviderConfig & {
  /** 后端 presets 接口返回的健康四态 (可选, 仅 listProviderPresets 提供). */
  provider_status?: ProviderFourState;
  /** 后端 presets 接口返回的配额标记 (可选). */
  quota?: { color: "green" | "yellow" | "red" | "gray"; label: string };
};

export interface UserProvidersGrouped {
  /** llm → text 重命名, 与 UI tab 对齐. */
  text: UserProvider[];
  image: UserProvider[];
  video: UserProvider[];
  /** 暂未在 SettingsPage 直接使用, 但保留方便后续 TTS section. */
  tts: UserProvider[];
}

/**
 * 拉取所有 provider (内置 + 自定义合并), 按 modality 分桶.
 * 把后端 kind=llm 重命名为 text, 其他保持不变.
 */
export async function listUserProviders(): Promise<UserProvidersGrouped> {
  const data = await listProviderPresets();
  return {
    text: data.providers.llm ?? [],
    image: data.providers.image ?? [],
    video: data.providers.video ?? [],
    tts: data.providers.tts ?? [],
  };
}

/** 新增 provider. 字段对照 CreateProviderInput. UI 调用方需自己给 id (slugify label). */
export async function createUserProvider(input: CreateProviderInput): Promise<UserProvider> {
  const { provider } = await createProvider(input);
  return provider;
}

/** 编辑 provider (kind 不可改, 其他字段可选 patch). 仅 custom provider 可改. */
export async function updateUserProvider(id: string, patch: PatchProviderInput): Promise<UserProvider> {
  const { provider } = await updateProvider(id, patch);
  return provider;
}

/** 删除 custom provider. 内置 provider 后端会返回 403. */
export async function deleteUserProvider(id: string): Promise<void> {
  await deleteProvider(id);
}

export interface KnownModelsResult {
  models: string[];
  source: "live" | "hardcoded";
}

/**
 * 一键拉模型. 优先走 live API (POST /providers/:id/fetch-models),
 * 当前后端尚无 hardcoded fallback endpoint, 只返回 live 来源.
 */
export async function getKnownModels(providerId: string): Promise<KnownModelsResult> {
  const r = await fetchProviderModels(providerId);
  return { models: r.models, source: "live" };
}

export interface ProviderLatencyResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

/**
 * 测延迟 (仅文字 provider 有意义 — 后端 speed-test 跑 chat/completions).
 * 拿 p50_ms 作为单次延迟代表. error_rate > 0 视为失败.
 */
export async function testProviderLatency(providerId: string): Promise<ProviderLatencyResult> {
  try {
    const r = await speedTestProvider(providerId);
    if (r.error_rate > 0 || r.p50_ms < 0) {
      return { ok: false, error: `error_rate=${r.error_rate} p50=${r.p50_ms}ms` };
    }
    return { ok: true, latency_ms: r.p50_ms };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function testUserProviderConnection(providerId: string, kind?: ProviderKind): Promise<ProviderLatencyResult> {
  try {
    const r = await testProviderConnectionV2(providerId, kind);
    return r.ok ? { ok: true, latency_ms: 0 } : { ok: false, error: r.message };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ====================================================================
// DIAGNOSTICS PING (T12)
// ====================================================================

export interface ProviderPingResult {
  provider_id: string;
  ok: boolean;
  latency_ms: number;
  model_count: number;
  error?: string | null;
}

export async function pingProviderDiagnostics(providerId: string) {
  return apiGet<ProviderPingResult>(`/api/v2/diagnostics/providers/${providerId}/ping`);
}

// ====================================================================
// PRESET FETCH (T03 模型路由表)
// ====================================================================

export interface PresetOption {
  id: string;
  label_zh: string;
  label_en: string;
  enabled: boolean;
  default: boolean;
  notes?: string;
  model_id?: string;
  cost_per_1k_tokens_in?: number;
  cost_per_1k_tokens_out?: number;
  cost_per_image_cny?: number;
  cost_per_second_cny?: number;
}

export interface PresetDict {
  id: string;
  options: PresetOption[];
}

export async function getPresetDict(dictId: string) {
  return apiGet<{ dict_id: string; options: PresetOption[] }>(`/api/v2/presets/${dictId}`);
}
