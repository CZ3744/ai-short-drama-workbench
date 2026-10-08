// ====================================================================
// chatgptOauthApi.ts — ChatGPT OAuth (Codex gpt-image-2)
// (P1 wave 2 #11 解耦)
// ====================================================================
// 覆盖范围:
// - ChatgptOauthStatusPayload / Response
// - start/cancel/logout/refresh/test/testGenerate
//
// Stubs wired to /api/v2/chatgpt-oauth/* backend routes. If routes are missing
// the request will surface as ApiError; callers should showErrorToast() it.
// see project_chatgpt_oauth_integration memory.
// ====================================================================

import { ApiError, apiGet, apiPost } from "./_apiClient";

export interface ChatgptOauthStatusPayload {
  logged_in: boolean;
  email?: string;
  account_email?: string;
  expires_at_ms?: number;
  expires_in_seconds?: number | null;
  needs_refresh?: boolean;
  account_id?: string;
  scopes?: string[];
  quota_used?: number;
  quota_period?: string;
  [k: string]: unknown;
}

export interface ChatgptOauthStatusResponse {
  status: ChatgptOauthStatusPayload | null;
}

export async function getChatgptOauthStatus(): Promise<ChatgptOauthStatusResponse> {
  try {
    return await apiGet<ChatgptOauthStatusResponse>("/api/v2/chatgpt-oauth/status");
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 501)) {
      return { status: null };
    }
    throw err;
  }
}

export interface StartChatgptOauthInput {
  force_login?: boolean;
}

export interface StartChatgptOauthResult {
  authorize_url: string;
  state?: string;
  pkce_verifier?: string;
}

export async function startChatgptOauth(input: StartChatgptOauthInput = {}): Promise<StartChatgptOauthResult> {
  return apiPost<StartChatgptOauthResult>("/api/v2/chatgpt-oauth/start", input);
}

export async function cancelChatgptOauth(): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>("/api/v2/chatgpt-oauth/cancel", {});
}

export interface LogoutChatgptOauthOptions {
  force?: boolean;
}

export async function logoutChatgptOauth(opts: LogoutChatgptOauthOptions = {}): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>("/api/v2/chatgpt-oauth/logout", opts);
}

export interface RefreshChatgptOauthResult {
  ok: true;
  expires_at_ms: number;
  expires_in_seconds?: number | null;
  refreshed_at_ms?: number;
}

export async function refreshChatgptOauth(): Promise<RefreshChatgptOauthResult> {
  return apiPost<RefreshChatgptOauthResult>("/api/v2/chatgpt-oauth/refresh", {});
}

export interface TestChatgptOauthResult {
  ok: boolean;
  message: string;
  account_id?: string;
  status?: number;
  expires_in_seconds?: number | null;
  checked_at_ms?: number;
}

export async function testChatgptOauth(): Promise<TestChatgptOauthResult> {
  return apiPost<TestChatgptOauthResult>("/api/v2/chatgpt-oauth/test", {});
}

export interface TestGenerateChatgptImageResult {
  ok: boolean;
  images?: Array<{ data_url: string; mime?: string; bytes?: number }>;
  elapsed_ms: number;
  meta_path?: string;
  saved_dir?: string;
  error?: { code?: string; message: string };
}

export async function testGenerateChatgptImage(
  prompt: string,
  size: { width: number; height: number },
): Promise<TestGenerateChatgptImageResult> {
  return apiPost<TestGenerateChatgptImageResult>("/api/v2/chatgpt-oauth/test-generate", { prompt, ...size });
}
