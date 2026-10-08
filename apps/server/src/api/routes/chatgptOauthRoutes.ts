// Backend routes for ChatGPT OAuth (Codex flow).
//
// Endpoints (mounted under /api):
//   GET  /oauth/chatgpt/status           — current login state
//   POST /oauth/chatgpt/start            — begin auth flow; returns authorize_url
//   POST /oauth/chatgpt/cancel           — abort an in-progress flow
//   POST /oauth/chatgpt/logout           — clear stored tokens
//   POST /oauth/chatgpt/refresh          — force refresh of access_token (debug)
//   POST /oauth/chatgpt/test             — probe userinfo with current token
//
// v2 aliases (mounted under /api/v2):
//   GET  /chatgpt-oauth/status
//   POST /chatgpt-oauth/start
//   POST /chatgpt-oauth/cancel
//   POST /chatgpt-oauth/logout
//   POST /chatgpt-oauth/refresh
//   POST /chatgpt-oauth/test
//   POST /chatgpt-oauth/test-generate
//
// The OAuth callback itself is NOT served by Express — it's bound to
// http://localhost:1455/auth/callback by the chatgptOauth module, because
// OpenAI only allows that exact redirect_uri for the Codex public client_id.

import fs from "node:fs/promises";
import path from "node:path";
import express, { type RequestHandler } from "express";
import {
  startAuthFlow,
  cancelFlow,
  clearStoredTokens,
  getStatus,
  refreshAccessToken,
  probeToken,
  isPending
} from "../../../../../packages/core/src/chatgptOauth";
import { DATA_ROOT } from "../../../../../packages/core/src/paths";
import { ChatgptCodexImageProvider } from "../../../../../packages/providers/src/image/chatgptCodexImageProvider";
import type { ProviderContext } from "../../../../../packages/providers/src/core/types";
import { listPendingJobs } from "../../jobs/pendingJobs";

export const chatgptOauthRouter = express.Router();
export const chatgptOauthV2Router = express.Router();

// A2 (2026-05-14): A logout while a chatgpt_codex_image job is still in flight
// will leave the running fetch with a token that's about to be invalidated.
// Surface a "still running" hint so the UI can prompt the user.
function countInFlightChatgptImageJobs(): number {
  try {
    const running = listPendingJobs({ status: "running" });
    return running.filter((j) => {
      const purposeMatch = j.purpose === "shot.firstframe.generate"
        || j.purpose === "shot.firstframe.regen_from_reject";
      if (!purposeMatch) return false;
      // Check if this job was dispatched against chatgpt_codex_image.
      // The job context records `model` (per-call override) and provider sometimes
      // shows up in `provider`. Be permissive: include either match.
      const meta = (j.target ?? {}) as Record<string, unknown>;
      const refs = [meta.model, meta.provider, meta.provider_id].filter(Boolean) as string[];
      return refs.some((r) => typeof r === "string" && r.includes("chatgpt_codex_image"));
    }).length;
  } catch {
    return 0;
  }
}

function sendError(res: any, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({ error: { code, message, details } });
}

function errorCode(err: unknown, fallback: string): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return fallback;
}

const statusHandler: RequestHandler = (_req, res) => {
  try {
    const status = getStatus();
    res.json({ ok: true, status, pending: isPending() });
  } catch (err) {
    sendError(res, 500, "OAUTH_STATUS_ERROR", err instanceof Error ? err.message : String(err));
  }
};

const startHandler: RequestHandler = async (req, res) => {
  try {
    const force_login = !!(req.body as { force_login?: unknown } | undefined)?.force_login;
    const flow = await startAuthFlow({ timeoutMs: 10 * 60_000, forceLogin: force_login });
    res.json({
      ok: true,
      authorize_url: flow.authorize_url,
      state: flow.state,
      port: flow.port,
      redirect_uri: flow.redirect_uri,
      instructions: [
        "1. 你的默认浏览器即将打开 OpenAI 登录页面 (若未自动打开,请手动复制 authorize_url)。",
        "2. 使用 ChatGPT 账号完成登录与授权。",
        "3. 授权后浏览器会跳回 http://localhost:1455/auth/callback —— 看到登录成功后即可关闭该页面。",
        "4. 完成后调用 GET /oauth/chatgpt/status 应该返回 logged_in。"
      ]
    });
  } catch (err) {
    const code = errorCode(err, "OAUTH_START_ERROR");
    sendError(res, code === "OAUTH_PORT_IN_USE" ? 409 : 500, code, err instanceof Error ? err.message : String(err));
  }
};

const cancelHandler: RequestHandler = (_req, res) => {
  try {
    cancelFlow();
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, "OAUTH_CANCEL_ERROR", err instanceof Error ? err.message : String(err));
  }
};

const logoutHandler: RequestHandler = async (req, res) => {
  try {
    const force = !!(req.body as { force?: unknown } | undefined)?.force;
    const inFlight = countInFlightChatgptImageJobs();
    if (inFlight > 0 && !force) {
      sendError(
        res,
        409,
        "INFLIGHT_TASKS",
        `还有 ${inFlight} 个 ChatGPT 生图任务正在运行, 请等待完成后再退出登录, 或选择强制退出。`,
        { in_flight: inFlight },
      );
      return;
    }
    await clearStoredTokens();
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, "OAUTH_LOGOUT_ERROR", err instanceof Error ? err.message : String(err));
  }
};

const refreshHandler: RequestHandler = async (_req, res) => {
  try {
    const result = await refreshAccessToken();
    const status = getStatus();
    res.json({
      ok: true,
      expires_at_ms: result.expires_at_ms,
      expires_in_seconds: status.expires_in_seconds,
      refreshed_at_ms: result.last_refresh_at_ms,
      account_id: result.account_id,
      account_email: result.account_email
    });
  } catch (err) {
    sendError(res, 500, "OAUTH_REFRESH_ERROR", err instanceof Error ? err.message : String(err));
  }
};

const testHandler: RequestHandler = async (_req, res) => {
  try {
    const result = await probeToken();
    const status = getStatus();
    const message = result.ok
      ? `ChatGPT OAuth 登录状态正常${status.account_email ? `: ${status.account_email}` : ""}`
      : result.status > 0
        ? "ChatGPT OAuth 令牌不可用, 请刷新或重新登录"
        : "ChatGPT 账号未登录";
    res.json({
      ok: result.ok,
      message,
      account_id: status.account_id ?? undefined,
      status: result.status,
      expires_in_seconds: status.expires_in_seconds,
      checked_at_ms: result.checked_at_ms
    });
  } catch (err) {
    sendError(res, 500, "OAUTH_TEST_ERROR", err instanceof Error ? err.message : String(err));
  }
};

const testGenerateHandler: RequestHandler = async (req, res) => {
  const started = Date.now();
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      sendError(res, 400, "VALIDATION_ERROR", "prompt 不能为空");
      return;
    }
    const width = typeof body.width === "number" && Number.isFinite(body.width) ? Math.round(body.width) : 1024;
    const height = typeof body.height === "number" && Number.isFinite(body.height) ? Math.round(body.height) : 1024;
    const taskId = `chatgpt_oauth_smoke_${Date.now()}`;
    const provider = new ChatgptCodexImageProvider({
      // PresetOption 必填字段 (zod passthrough — kind/api_type/model_id 走 extras 通道)
      id: "chatgpt_codex_image",
      label_zh: "OAuth · gpt-image-2",
      label_en: "OAuth · gpt-image-2",
      prompt_phrase: "",
      enabled: true,
      notes: "",
      default: false,
      kind: "image",
      api_type: "oauth",
      model_id: "gpt-image-2",
    }, null);

    // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 不设 AbortSignal.timeout(180_000).
    const ctx: ProviderContext = {
      series_slug: "chatgpt-oauth-smoke",
      job_id: taskId,
      task_id: taskId,
      log: (level, msg, meta) => {
        const line = `[chatgpt-oauth-test-generate] ${msg}`;
        if (level === "error") console.error(line, meta ?? "");
        else if (level === "warn") console.warn(line, meta ?? "");
        else console.log(line, meta ?? "");
      }
    };

    const result = await provider.generate({ prompt, width, height, count: 1 }, ctx);
    const savedDir = path.join(DATA_ROOT, "oauth_codex_smoke");
    await fs.mkdir(savedDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const responseImages = [];
    const savedImages = [];
    for (const [idx, image] of result.images.entries()) {
      const mime = image.mime || "image/png";
      const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
      const filename = `${stamp}-${idx + 1}.${ext}`;
      const filePath = path.join(savedDir, filename);
      await fs.writeFile(filePath, image.buffer);
      responseImages.push({
        data_url: `data:${mime};base64,${image.buffer.toString("base64")}`,
        mime,
        bytes: image.buffer.length
      });
      savedImages.push({ path: filePath, mime, bytes: image.buffer.length, width: image.width, height: image.height });
    }

    const elapsedMs = Date.now() - started;
    const metaPath = path.join(savedDir, `${stamp}.json`);
    await fs.writeFile(metaPath, JSON.stringify({
      created_at: new Date().toISOString(),
      provider: "chatgpt_codex_image",
      prompt,
      width,
      height,
      elapsed_ms: elapsedMs,
      images: savedImages
    }, null, 2), "utf8");

    res.json({
      ok: true,
      images: responseImages,
      elapsed_ms: elapsedMs,
      meta_path: metaPath,
      saved_dir: savedDir
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /未登录|No ChatGPT OAuth tokens|please login/i.test(message) ? 401 : 500;
    sendError(res, status, errorCode(err, "OAUTH_TEST_GENERATE_ERROR"), message, { elapsed_ms: Date.now() - started });
  }
};

function registerRoutes(router: express.Router, basePath: string) {
  router.get(`${basePath}/status`, statusHandler);
  router.post(`${basePath}/start`, startHandler);
  router.post(`${basePath}/cancel`, cancelHandler);
  router.post(`${basePath}/logout`, logoutHandler);
  router.post(`${basePath}/refresh`, refreshHandler);
  router.post(`${basePath}/test`, testHandler);
  router.post(`${basePath}/test-generate`, testGenerateHandler);
}

registerRoutes(chatgptOauthRouter, "/oauth/chatgpt");
registerRoutes(chatgptOauthV2Router, "/chatgpt-oauth");
