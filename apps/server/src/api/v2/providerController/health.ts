/**
 * Provider Controller — Health, chain, test, and speed-test endpoints.
 *
 * Split from providerController.ts (Wave Z-9).
 * Contains: GET/POST/DELETE /providers/chain, GET /providers/health,
 *           POST /providers/:id/test, POST /providers/:id/speed-test,
 *           and the speed-test implementation helpers.
 */

import { Router } from "express";
import { handleValidationError } from "../validateHelpers";
import { validate, ProviderTestSchema } from "../validators";
import { getConfigValue, writeLocalSettings } from "../../../../../../packages/core/src/localSettings";
import {
  getCachedHealth,
  setCachedHealth,
  clearHealthCache,
} from "../providersHealthCache";
import { sseBroker } from "../sseBroker";
import { getRegistry } from "../orchestration/_shared/registry";
import type { ProviderConfig } from "./shared";
import {
  resolveProvider,
  getResolvedKey,
  listMergedProviders,
  computeProviderStatus,
  percentile,
} from "./shared";

export const healthRouter = Router();

// ── SpeedTestResult interface ────────────────────────────────────

export interface SpeedTestResult {
  provider_id: string;
  model_id: string;
  p50_ms: number;
  p95_ms: number;
  error_rate: number;
  total_requests: number;
  tested_at: string;
}

// ── Chain management ────────────────────────────────────────────

let chainOverride: string[] | null = null;
function getChain(): string[] {
  if (chainOverride) return chainOverride;
  const raw = getConfigValue("LLM_PROVIDER_CHAIN", "");
  if (raw) {
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return parsed; } catch { /* ignore */ }
  }
  return ["ikuncode_gpt55", "mimo_v25pro", "openai_gpt5", "claude_opus47", "deepseek"];
}

// ── GET /providers/health — 业务页 LlmProviderSelect 调这里 (合并 builtin + custom 列出) ─────

healthRouter.get("/providers/health", async (_req, res, next) => {
  try {
    const providers = listMergedProviders().map((p) => {
      const healthEntry = getCachedHealth(p.id);
      const providerStatus = computeProviderStatus(p);
      return {
        id: p.id,
        name: p.label_zh,
        model_id: p.model_id,
        api_type: p.api_type,
        base_url: p.base_url,
        kind: p.kind,
        enabled: p.enabled !== false,
        key_present: providerStatus.configured,
        configured: providerStatus.configured,
        tested: providerStatus.tested,
        healthy: providerStatus.healthy,
        quota_state: healthEntry?.quota_state ?? "unknown",
        last_checked_at: providerStatus.last_checked_at,
        reason: providerStatus.reason,
      };
    });
    const chain = getChain();
    res.json({ providers, chain, chain_active: chain[0] ?? null });
  } catch (err) { next(err); }
});

healthRouter.get("/providers/chain", (_req, res) => {
  const chain = getChain();
  res.json({ chain, chain_active: chain[0] ?? null, overridden: chainOverride !== null, override: chainOverride ?? null });
});

healthRouter.post("/providers/chain", async (req, res, next) => {
  try {
    const { chain } = req.body as { chain?: string[] };
    if (!chain || !Array.isArray(chain) || chain.length === 0) {
      res.status(400).json({ error: { code: "ValidationError", message: "chain 必须是非空字符串数组" } }); return;
    }
    if (!chain.every((x: unknown) => typeof x === "string")) {
      res.status(400).json({ error: { code: "ValidationError", message: "chain 的每个元素必须是字符串" } }); return;
    }
    chainOverride = chain;
    await writeLocalSettings({ LLM_PROVIDER_CHAIN: JSON.stringify(chain) });
    sseBroker.broadcast("provider.fallback", { event: "chain_changed", chain, active: chain[0] });
    res.json({ ok: true, chain, chain_active: chain[0], message: "Fallback 链已更新（已持久化）" });
  } catch (err) { next(err); }
});

healthRouter.delete("/providers/chain", async (_req, res, next) => {
  try {
    chainOverride = null;
    await writeLocalSettings({ LLM_PROVIDER_CHAIN: null });
    const chain = getChain();
    res.json({ ok: true, chain, chain_active: chain[0] ?? null, message: "已恢复为默认链（已清除持久化）" });
  } catch (err) { next(err); }
});

healthRouter.post("/providers/:id/test", async (req, res, next) => {
  try {
    const { id } = req.params;
    const v = validate(ProviderTestSchema, req.body || {});
    if (handleValidationError(res, v)) return;
    const provider = resolveProvider(id);
    if (!provider) { res.status(404).json({ error: { code: "NotFound", message: `provider "${id}" 不存在` } }); return; }

    let health: { ok: boolean; reason?: string };
    try {
      const registry = getRegistry();
      if (provider.kind === "llm") health = await registry.getLlm(id).healthCheck();
      else if (provider.kind === "image") health = await registry.getImage(id).healthCheck();
      else if (provider.kind === "video") health = await registry.getVideo(id).healthCheck();
      else health = await registry.getTts(id).healthCheck();
    } catch (err) {
      health = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    const result = {
      ok: health.ok,
      provider: id,
      message: health.ok ? "连接检查通过" : (health.reason ?? "连接检查失败"),
      error_type: health.ok ? undefined : "connection_failed",
    };

    setCachedHealth(id, {
      id, ok: result.ok,
      quota_state: result.ok ? "ok" : "unknown",
      last_checked_at: new Date().toISOString(),
      reason: result.ok ? undefined : result.message,
    });
    res.json(result);
  } catch (err) { next(err); }
});

healthRouter.post("/providers/:id/speed-test", async (req, res, next) => {
  try {
    const { id } = req.params;

    const provider = resolveProvider(id);
    if (!provider) { res.status(404).json({ error: { code: "NotFound", message: `provider "${id}" 不存在` } }); return; }

    const apiKey = provider.api_key ?? getResolvedKey(id);
    if (!apiKey || apiKey.trim() === "") {
      res.status(400).json({ error: { code: "KeyMissing", message: "API key 未配置，无法测速" } });
      return;
    }

    try {
      const result = await runSpeedTest(provider, apiKey);
      setCachedHealth(id, {
        id,
        ok: result.error_rate < 1 && result.p50_ms >= 0,
        quota_state: result.error_rate < 1 && result.p50_ms >= 0 ? "ok" : "unknown",
        last_checked_at: result.tested_at,
        reason: result.error_rate < 1 && result.p50_ms >= 0 ? undefined : `error_rate=${result.error_rate}`,
      });
      res.json(result);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const testedAt = new Date().toISOString();
      setCachedHealth(id, {
        id,
        ok: false,
        quota_state: "unknown",
        last_checked_at: testedAt,
        reason,
      });
      res.json({
        provider_id: id,
        model_id: provider.model_id || "",
        p50_ms: -1, p95_ms: -1,
        error_rate: 1,
        total_requests: 0,
        tested_at: testedAt,
        ok: false,
        error: reason,
      });
    }
  } catch (err) { next(err); }
});

// ── Speed test implementation ────────────────────────────────────

async function runSpeedTest(provider: ProviderConfig, apiKey: string): Promise<SpeedTestResult> {
  const modelId = provider.model_id || "(models list)";
  const timeoutMs = Math.min(provider.timeout_ms ?? 8_000, 8_000);
  const measures = 3;

  const latencies: number[] = [];
  let errors = 0;
  let useChat = false;

  for (let i = 0; i < measures; i++) {
    try {
      const start = Date.now();
      try {
        await pingModelsEndpoint(provider, apiKey, timeoutMs);
      } catch (err) {
        if (i === 0 && provider.model_id) {
          useChat = true;
          await singleChatRequest(
            provider.base_url.replace(/[/]+$/, ""), apiKey, provider.api_type,
            provider.anthropic_version, provider.model_id, timeoutMs,
          );
        } else {
          throw err;
        }
      }
      latencies.push(Date.now() - start);
    } catch (err) {
      errors++;
      if (i === measures - 1 && latencies.length === 0) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`所有 ${measures} 次测速都失败. 最后错误: ${reason}`);
      }
    }
  }

  const sorted = latencies.sort((a, b) => a - b);
  const p50 = sorted.length > 0 ? percentile(sorted, 0.50) : -1;
  const p95 = sorted.length > 0 ? percentile(sorted, 0.95) : -1;

  return {
    provider_id: provider.id,
    model_id: useChat ? modelId : "(GET /models)",
    p50_ms: Math.round(p50),
    p95_ms: Math.round(p95),
    error_rate: Math.round((measures > 0 ? errors / measures : 1) * 100) / 100,
    total_requests: measures,
    tested_at: new Date().toISOString(),
  };
}

async function singleChatRequest(baseUrl: string, apiKey: string, apiType: string, anthropicVersion: string | undefined, modelId: string, _timeoutMs: number): Promise<void> {
  if (apiType === "anthropic") {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": anthropicVersion || "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`POST /v1/messages HTTP ${resp.status}${text ? ": " + text.slice(0, 200) : ""}`);
    }
    return;
  }
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`POST /chat/completions HTTP ${resp.status}${text ? ": " + text.slice(0, 200) : ""}`);
  }
}

// ── P1-3: LLM "试一下" endpoint ───────────────────────────────────
// POST /providers/:id/try — 发一句固定提示词给 LLM, 收到回复返回给前端.
// 用于设置页 ProviderCard "试一下" 按钮.

healthRouter.post("/providers/:id/try", async (req, res, next) => {
  try {
    const { id } = req.params;

    const provider = resolveProvider(id);
    if (!provider) {
      res.status(404).json({ error: { code: "NotFound", message: `provider "${id}" 不存在` } });
      return;
    }

    if (provider.kind !== "llm") {
      res.status(400).json({ error: { code: "BadRequest", message: `"试一下" 仅支持文字模型 Provider, 当前类型: ${provider.kind}` } });
      return;
    }

    const apiKey = provider.api_key ?? getResolvedKey(id);
    if (!apiKey || apiKey.trim() === "") {
      res.status(400).json({ error: { code: "KeyMissing", message: "API Key 未配置, 无法测试" } });
      return;
    }

    const modelId = provider.model_id || "gpt-4o";
    const baseUrl = provider.base_url.replace(/[/]+$/, "");
    const testPrompt = "用一句话介绍你自己。";

    try {
      let reply = "";
      if (provider.api_type === "anthropic") {
        const resp = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": provider.anthropic_version || "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 200,
            messages: [{ role: "user", content: testPrompt }],
          }),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Anthropic API 返回 HTTP ${resp.status}${text ? ": " + text.slice(0, 200) : ""}`);
        }
        const data = await resp.json() as Record<string, unknown>;
        const content = data.content as Array<{ type: string; text: string }> | undefined;
        reply = content?.[0]?.text ?? "(空回复)";
      } else {
        // OpenAI-compatible
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 200,
            messages: [{ role: "user", content: testPrompt }],
          }),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`API 返回 HTTP ${resp.status}${text ? ": " + text.slice(0, 200) : ""}`);
        }
        const data = await resp.json() as Record<string, unknown>;
        const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
        reply = choices?.[0]?.message?.content ?? "(空回复)";
      }

      res.json({
        ok: true,
        provider_id: id,
        prompt: testPrompt,
        reply: reply.trim(),
        model: modelId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      res.status(502).json({
        ok: false,
        provider_id: id,
        error: reason,
      });
    }
  } catch (err) { next(err); }
});

async function pingModelsEndpoint(provider: ProviderConfig, apiKey: string, _timeoutMs: number): Promise<void> {
  const baseUrl = provider.base_url.replace(/[/]+$/, "");
  if (provider.api_type === "anthropic") {
    const resp = await fetch(`${baseUrl}/v1/models`, {
      headers: { "x-api-key": apiKey, "anthropic-version": provider.anthropic_version || "2023-06-01" },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GET /v1/models HTTP ${resp.status}${text ? ": " + text.slice(0, 200) : ""}`);
    }
    return;
  }
  const resp = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GET /models HTTP ${resp.status}${text ? ": " + text.slice(0, 200) : ""}`);
  }
}
