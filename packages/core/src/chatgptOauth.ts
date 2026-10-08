// ChatGPT (Codex) OAuth — PKCE flow + token store
//
// This module implements the OAuth 2.0 + PKCE flow that the official OpenAI Codex CLI
// uses to authenticate ChatGPT Plus/Pro/Team accounts. After successful authorization,
// the access_token + refresh_token are persisted (encrypted) in local-settings.json
// alongside the existing API-key style provider secrets.
//
// References (May 2026):
//   - https://developers.openai.com/codex/auth
//   - https://github.com/openai/codex (Codex CLI source)
//   - Codex public client_id: app_EMoamEEZ73f0CkXaXp7hrann
//   - Redirect URI required by OpenAI for that client: http://localhost:1455/auth/callback
//
// Tokens are usable against:
//   - https://chatgpt.com/backend-api/codex/responses (Responses API with image_generation tool)
//   - https://api.openai.com/v1/* if the account has API access (fallback path)
//
// SECURITY NOTES:
//   - Refresh & access tokens are stored encrypted with the existing enc:v1: scheme.
//   - The PKCE verifier is held only in-memory and discarded after token exchange.
//   - The local callback server binds 127.0.0.1:1455 (loopback only).

import crypto from "node:crypto";
import http from "node:http";
import { writeLocalSettings, getConfigValue } from "./localSettings";

// ─── Constants ──────────────────────────────────────────────────────

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_SCOPES = "openid profile email offline_access";
export const CODEX_OAUTH_CALLBACK_PORT = 1455;

// Default endpoints once authenticated.
export const CHATGPT_BACKEND_BASE_URL = "https://chatgpt.com/backend-api";
// API-style image endpoint (some accounts may route OAuth tokens through this; we keep both).
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

// ─── Types ──────────────────────────────────────────────────────────

export interface ChatgptOauthTokens {
  access_token: string;
  refresh_token: string | null;
  id_token: string | null;
  expires_at_ms: number;            // absolute epoch ms when access_token expires
  account_id: string | null;        // chatgpt_account_id from id_token JWT claims
  account_email: string | null;     // email claim from id_token
  organization_id: string | null;
  project_id: string | null;
  last_refresh_at_ms: number;
}

export interface ChatgptOauthStatus {
  logged_in: boolean;
  account_email: string | null;
  account_id: string | null;
  expires_at_ms: number | null;
  expires_in_seconds: number | null;
  needs_refresh: boolean;
  /** D (2026-05-14): local counter of successful images this period. */
  quota_used: number;
  quota_period: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

interface PendingOauthFlow {
  pkce: PkcePair;
  startedAt: number;
  // Promise that resolves with the authorization code once the local callback fires.
  // Resolves with `null` if the user cancelled / timed out.
  callbackPromise: Promise<{ code: string; state: string } | null>;
  server: http.Server;
  cancel: () => void;
}

// Module-level state (single concurrent OAuth flow per process — same as Codex CLI).
let _pendingFlow: PendingOauthFlow | null = null;

// ─── PKCE helpers ───────────────────────────────────────────────────

export function generatePkcePair(): PkcePair {
  const verifier = base64UrlEncode(crypto.randomBytes(64));
  const challenge = base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
  const state = base64UrlEncode(crypto.randomBytes(32));
  return { verifier, challenge, state };
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── Token storage (encrypted by localSettings encryption layer) ────

const STORAGE_KEYS = {
  access_token: "CHATGPT_OAUTH_ACCESS_TOKEN",
  refresh_token: "CHATGPT_OAUTH_REFRESH_TOKEN",
  id_token: "CHATGPT_OAUTH_ID_TOKEN",
  expires_at: "CHATGPT_OAUTH_EXPIRES_AT",
  account_id: "CHATGPT_OAUTH_ACCOUNT_ID",
  account_email: "CHATGPT_OAUTH_ACCOUNT_EMAIL",
  organization_id: "CHATGPT_OAUTH_ORG_ID",
  project_id: "CHATGPT_OAUTH_PROJECT_ID",
  last_refresh: "CHATGPT_OAUTH_LAST_REFRESH"
};

/**
 * Mark these keys as sensitive (so localSettings encrypts them on disk).
 *
 * The existing isSensitiveLocalSettingKey() in localSettings.ts matches
 * `_API_KEY` and `_SECRET_KEY` suffixes. We append CHATGPT_OAUTH_* tokens
 * by suffixing them with `_API_KEY` is wrong (changes the semantic).
 * Instead we rely on writeLocalSettings honoring the new key family —
 * see patch in localSettings.ts: isSensitiveLocalSettingKey now also
 * matches CHATGPT_OAUTH_ACCESS_TOKEN / CHATGPT_OAUTH_REFRESH_TOKEN /
 * CHATGPT_OAUTH_ID_TOKEN explicitly.
 */
export function getStoredTokens(): ChatgptOauthTokens | null {
  const access = getConfigValue(STORAGE_KEYS.access_token);
  if (!access) return null;
  const expires = parseInt(getConfigValue(STORAGE_KEYS.expires_at, "0"), 10) || 0;
  return {
    access_token: access,
    refresh_token: getConfigValue(STORAGE_KEYS.refresh_token) || null,
    id_token: getConfigValue(STORAGE_KEYS.id_token) || null,
    expires_at_ms: expires,
    account_id: getConfigValue(STORAGE_KEYS.account_id) || null,
    account_email: getConfigValue(STORAGE_KEYS.account_email) || null,
    organization_id: getConfigValue(STORAGE_KEYS.organization_id) || null,
    project_id: getConfigValue(STORAGE_KEYS.project_id) || null,
    last_refresh_at_ms: parseInt(getConfigValue(STORAGE_KEYS.last_refresh, "0"), 10) || 0
  };
}

export async function storeTokens(tokens: ChatgptOauthTokens): Promise<void> {
  await writeLocalSettings({
    [STORAGE_KEYS.access_token]: tokens.access_token,
    [STORAGE_KEYS.refresh_token]: tokens.refresh_token ?? "",
    [STORAGE_KEYS.id_token]: tokens.id_token ?? "",
    [STORAGE_KEYS.expires_at]: String(tokens.expires_at_ms),
    [STORAGE_KEYS.account_id]: tokens.account_id ?? "",
    [STORAGE_KEYS.account_email]: tokens.account_email ?? "",
    [STORAGE_KEYS.organization_id]: tokens.organization_id ?? "",
    [STORAGE_KEYS.project_id]: tokens.project_id ?? "",
    [STORAGE_KEYS.last_refresh]: String(tokens.last_refresh_at_ms)
  });
}

export async function clearStoredTokens(): Promise<void> {
  await writeLocalSettings({
    [STORAGE_KEYS.access_token]: null,
    [STORAGE_KEYS.refresh_token]: null,
    [STORAGE_KEYS.id_token]: null,
    [STORAGE_KEYS.expires_at]: null,
    [STORAGE_KEYS.account_id]: null,
    [STORAGE_KEYS.account_email]: null,
    [STORAGE_KEYS.organization_id]: null,
    [STORAGE_KEYS.project_id]: null,
    [STORAGE_KEYS.last_refresh]: null
  });
}

// ─── D (2026-05-14): ChatGPT subscription image quota counter ───────
//
// ChatGPT Plus subscription doesn't give you a public counter — but the
// monthly image cap is real (the docs cite per-tier limits). We track it
// locally as a best-effort approximation: each successful generation bumps
// the counter and the start-of-month rollover resets it.

const QUOTA_USED_KEY = "CHATGPT_QUOTA_USED_COUNT";
const QUOTA_PERIOD_KEY = "CHATGPT_QUOTA_PERIOD_START";

/** YYYY-MM string for the current local-month bucket. */
function currentPeriodKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function getQuotaCounter(): { used: number; period: string } {
  const period = currentPeriodKey();
  const stored = getConfigValue(QUOTA_PERIOD_KEY) || period;
  // If we crossed a month boundary, return 0 (caller will roll over on next bump)
  if (stored !== period) return { used: 0, period };
  const used = parseInt(getConfigValue(QUOTA_USED_KEY, "0"), 10) || 0;
  return { used, period: stored };
}

/** Increment the local quota counter by `n` (default 1). Auto rolls month boundary. */
export async function bumpQuotaCounter(n: number = 1): Promise<{ used: number; period: string }> {
  const period = currentPeriodKey();
  const stored = getConfigValue(QUOTA_PERIOD_KEY) || period;
  const prior = stored === period
    ? (parseInt(getConfigValue(QUOTA_USED_KEY, "0"), 10) || 0)
    : 0;
  const next = prior + Math.max(0, Math.floor(n));
  await writeLocalSettings({
    [QUOTA_USED_KEY]: String(next),
    [QUOTA_PERIOD_KEY]: period,
  });
  return { used: next, period };
}

export async function resetQuotaCounter(): Promise<void> {
  await writeLocalSettings({
    [QUOTA_USED_KEY]: "0",
    [QUOTA_PERIOD_KEY]: currentPeriodKey(),
  });
}

export function getStatus(): ChatgptOauthStatus {
  const quota = getQuotaCounter();
  const tokens = getStoredTokens();
  if (!tokens) {
    return {
      logged_in: false,
      account_email: null,
      account_id: null,
      expires_at_ms: null,
      expires_in_seconds: null,
      needs_refresh: false,
      quota_used: quota.used,
      quota_period: quota.period
    };
  }
  const now = Date.now();
  const expiresIn = Math.max(0, Math.floor((tokens.expires_at_ms - now) / 1000));
  // Consider "needs_refresh" when we're within 60s of expiry.
  const needsRefresh = tokens.expires_at_ms - now < 60_000;
  return {
    logged_in: true,
    account_email: tokens.account_email,
    account_id: tokens.account_id,
    expires_at_ms: tokens.expires_at_ms,
    expires_in_seconds: expiresIn,
    needs_refresh: needsRefresh,
    quota_used: quota.used,
    quota_period: quota.period
  };
}

// ─── JWT decode (id_token claims) ────────────────────────────────────

interface IdTokenClaims {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  sub?: string;
  chatgpt_account_id?: string;
  organization_id?: string;
  project_id?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    organization_id?: string;
    project_id?: string;
    user_id?: string;
  };
  [key: string]: unknown;
}

export function decodeIdToken(idToken: string): IdTokenClaims | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "===".slice((payload.length + 3) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as IdTokenClaims;
  } catch {
    return null;
  }
}

// ─── Authorization URL builder ─────────────────────────────────────

export function buildAuthorizeUrl(pkce: PkcePair, opts: { forceLogin?: boolean } = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    scope: CODEX_OAUTH_SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
    // Codex-specific signals used by OpenAI's auth server.
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true"
  });
  // E (2026-05-14): when user wants to switch accounts, ask OpenAI to force
  // the account picker even if a session cookie is still valid.
  if (opts.forceLogin) params.set("prompt", "login");
  return `${CODEX_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

// ─── Callback server ────────────────────────────────────────────────

// SUCCESS_HTML notifies the originating tab via postMessage so the UI flips
// to "logged in" without any polling. The script targets a broad set of common
// dev / prod origins; user can extend via CHATGPT_OAUTH_OPENER_ORIGINS.
const SUCCESS_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>登录成功</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#f1f5f9;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:480px;text-align:center}
h1{font-size:24px;margin:0 0 12px;color:#10b981}p{margin:0;color:#cbd5e1;line-height:1.5}
.muted{margin-top:14px;font-size:12px;color:#94a3b8}</style>
</head><body><div class="card"><h1>✅ ChatGPT 登录成功</h1>
<p>访问令牌已安全保存到本机配置中。</p>
<p class="muted">几秒后将自动关闭此页面 —— 如果未自动关闭, 请手动关闭并回到 video-generate.</p>
</div>
<script>
  // 2026-05-14: postMessage 通知打开此 tab 的 video-generate UI, 不依赖轮询。
  // targetOrigin 用 "*" 因为 video-generate 在本机的 origin 可能是
  // http://127.0.0.1:5173 / http://localhost:5173 / 用户自定义。loopback-only,
  // 不会泄露给外网 (此页本身就在 http://localhost:1455/auth/callback)。
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: "chatgpt_oauth_success", at: Date.now() }, "*");
    }
  } catch (e) { /* opener closed or cross-origin restriction */ }
  // 2 秒后尝试自动关闭, 用户可以更早手动关
  setTimeout(function() { try { window.close(); } catch(e) {} }, 2000);
</script>
</body></html>`;

const ERROR_HTML = (msg: string) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>登录失败</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#f1f5f9;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border:1px solid #b91c1c;border-radius:12px;padding:32px;max-width:480px;text-align:center}
h1{font-size:24px;margin:0 0 12px;color:#f87171}pre{margin:0;color:#fca5a5;white-space:pre-wrap;text-align:left;font-size:13px}</style>
</head><body><div class="card"><h1>❌ ChatGPT 登录失败</h1>
<pre>${msg.replace(/[<&>]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!))}</pre></div></body></html>`;

/**
 * Start the OAuth flow. Returns the authorize URL and creates an in-memory
 * record of the pending PKCE pair. The callback server listens on
 * 127.0.0.1:1455 and resolves the `callbackPromise` when the user comes back.
 *
 * Caller responsibilities:
 *   - Open the returned URL in the user's default browser.
 *   - Poll `getStatus()` or await `awaitCallback()` to know when complete.
 *   - Call `cancelFlow()` to abort if the user wants to give up.
 */
export async function startAuthFlow(opts: { timeoutMs?: number; forceLogin?: boolean } = {}): Promise<{
  authorize_url: string;
  state: string;
  port: number;
  redirect_uri: string;
}> {
  // If a flow is already in progress, cancel it before starting a new one.
  if (_pendingFlow) {
    try { _pendingFlow.cancel(); } catch { /* ignore */ }
    _pendingFlow = null;
  }

  const pkce = generatePkcePair();
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // 5 min default

  let resolveCallback: (v: { code: string; state: string } | null) => void;
  const callbackPromise = new Promise<{ code: string; state: string } | null>((resolve) => {
    resolveCallback = resolve;
  });

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${CODEX_OAUTH_CALLBACK_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not Found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (error) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(ERROR_HTML(`${error}\n\n${errorDescription ?? ""}`));
        resolveCallback(null);
        return;
      }
      if (!code || !state) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(ERROR_HTML("Missing code or state in callback"));
        resolveCallback(null);
        return;
      }
      if (state !== pkce.state) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(ERROR_HTML("State mismatch — possible CSRF. Please retry."));
        resolveCallback(null);
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      resolveCallback({ code, state });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(ERROR_HTML(msg));
      resolveCallback(null);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(CODEX_OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    // EADDRINUSE on port 1455 is the most likely cause — Codex CLI / OpenClaw
    // / a stale callback server. Surface a friendly, specific error so the
    // frontend can show actionable guidance instead of raw spawn-EADDRINUSE.
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EADDRINUSE") {
      const friendly = new Error(
        `本机 127.0.0.1:${CODEX_OAUTH_CALLBACK_PORT} 已被占用 — 通常是 Codex CLI / OpenClaw 正在做 OAuth, 或上次未完成的 OAuth 流程残留. 关掉它们 (或几秒后重试) 再来登录.`
      ) as Error & { code: string };
      friendly.code = "OAUTH_PORT_IN_USE";
      throw friendly;
    }
    throw err;
  }

  // Auto-timeout watchdog
  // 2026-05-28 audit P1-29: timer 需要 unref 否则即便 OAuth 已完成 (resolveCallback 跑过),
  // 这个未到期 timer 会 keep Node event loop 活着, 程序退出时多挂 5 分钟. unref 让它非引用.
  const timer = setTimeout(() => {
    resolveCallback(null);
    try { server.close(); } catch { /* ignore */ }
  }, timeoutMs);
  timer.unref?.();

  const cancel = () => {
    clearTimeout(timer);
    resolveCallback(null);
    try { server.close(); } catch { /* ignore */ }
  };

  _pendingFlow = {
    pkce,
    startedAt: Date.now(),
    callbackPromise,
    server,
    cancel
  };

  // Begin the token-exchange watcher in the background — when the callback
  // fires, swap code for tokens and persist. This makes the flow fully
  // self-contained: caller only needs to navigate the user to authorize_url.
  callbackPromise.then(async (cb) => {
    clearTimeout(timer);
    try { server.close(); } catch { /* ignore */ }
    if (!cb) {
      _pendingFlow = null;
      return;
    }
    try {
      const tokens = await exchangeCodeForTokens(cb.code, pkce.verifier);
      await storeTokens(tokens);
    } catch (err) {
      // Token exchange failed — we already discarded code, user must retry.
      console.error("[chatgpt-oauth] Token exchange failed:", err instanceof Error ? err.message : err);
    } finally {
      _pendingFlow = null;
    }
  });

  return {
    authorize_url: buildAuthorizeUrl(pkce, { forceLogin: opts.forceLogin }),
    state: pkce.state,
    port: CODEX_OAUTH_CALLBACK_PORT,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI
  };
}

export function cancelFlow(): boolean {
  if (!_pendingFlow) return false;
  _pendingFlow.cancel();
  _pendingFlow = null;
  return true;
}

export function isPending(): boolean {
  return _pendingFlow !== null;
}

// ─── Token exchange + refresh ───────────────────────────────────────

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number; // seconds
  scope?: string;
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<ChatgptOauthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier
  });

  const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(20_000).
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const raw = (await res.json()) as RawTokenResponse;
  const now = Date.now();
  const expiresInSec = typeof raw.expires_in === "number" && raw.expires_in > 0 ? raw.expires_in : 3600;
  const claims = raw.id_token ? decodeIdToken(raw.id_token) : null;
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token ?? null,
    id_token: raw.id_token ?? null,
    expires_at_ms: now + expiresInSec * 1000,
    account_id: claims?.chatgpt_account_id ?? null,
    account_email: claims?.email ?? null,
    organization_id: claims?.organization_id ?? null,
    project_id: claims?.project_id ?? null,
    last_refresh_at_ms: now,
  };
}

export async function refreshAccessToken(): Promise<ChatgptOauthTokens> {
  const stored = getStoredTokens();
  if (!stored || !stored.refresh_token) {
    throw new Error("No refresh_token available");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(20_000).
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const raw = (await res.json()) as RawTokenResponse;
  const now = Date.now();
  const expiresInSec = typeof raw.expires_in === "number" && raw.expires_in > 0 ? raw.expires_in : 3600;
  const claims = raw.id_token ? decodeIdToken(raw.id_token) : null;
  const next: ChatgptOauthTokens = {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token ?? stored.refresh_token,
    id_token: raw.id_token ?? stored.id_token,
    expires_at_ms: now + expiresInSec * 1000,
    account_id: claims?.chatgpt_account_id ?? stored.account_id,
    account_email: claims?.email ?? stored.account_email,
    organization_id: claims?.organization_id ?? stored.organization_id,
    project_id: claims?.project_id ?? stored.project_id,
    last_refresh_at_ms: now,
  };
  await storeTokens(next);
  return next;
}

export async function probeToken(): Promise<{ ok: boolean; status: number; body?: unknown; checked_at_ms: number }> {
  const stored = getStoredTokens();
  const checkedAt = Date.now();
  if (!stored) return { ok: false, status: 0, checked_at_ms: checkedAt };
  try {
    await getValidAccessToken();
    return {
      ok: true,
      status: 200,
      checked_at_ms: checkedAt,
      body: {
        mode: "local_token_check",
        note: "/backend-api/me may return 403 for Codex OAuth tokens, so login check verifies stored token + refreshability instead."
      }
    };
  } catch (err) {
    return {
      ok: false,
      status: 401,
      checked_at_ms: checkedAt,
      body: { error: err instanceof Error ? err.message : String(err) }
    };
  }
}

/**
 * Returns a valid access_token, refreshing if it has expired or is about to.
 * Throws if no tokens are stored.
 */
export async function getValidAccessToken(): Promise<string> {
  const stored = getStoredTokens();
  if (!stored) throw new Error("No ChatGPT OAuth tokens stored — please login first");
  const now = Date.now();
  const skewMs = 60_000; // refresh 60s early
  if (stored.expires_at_ms - now > skewMs) {
    return stored.access_token;
  }
  if (!stored.refresh_token) {
    throw new Error("access_token expired and no refresh_token available — please re-login");
  }
  const refreshed = await refreshAccessToken();
  return refreshed.access_token;
}
