/**
 * Provider Controller — P5E CRUD endpoints.
 *
 * Split from providerController.ts (Wave Z-9).
 * Contains: GET/POST/PATCH/DELETE /providers, GET /providers/presets,
 *           POST /providers/:id/fetch-models, and fetchModelList helper.
 */

import { Router } from "express";
import { handleValidationError } from "../validateHelpers";
import {
  validate,
  CreateProviderSchema,
  PatchProviderSchema,
} from "../validators";
import { writeLocalSettings } from "../../../../../../packages/core/src/localSettings";
import { clearHealthCache } from "../providersHealthCache";
import { reloadRegistry } from "../orchestration/_shared/registry";
import {
  ProviderConfig,
  ProviderFourState,
  readCustomProviders,
  writeCustomProviders,
  maskApiKey,
  getResolvedKey,
  storageId,
  getBuiltinPresets,
  buildBuiltinSettingsPatch,
  resolveProvider,
  getQuotaStatus,
  computeProviderStatus,
  listMergedProviders,
} from "./shared";

export const crudRouter = Router();

// ── GET /providers — list custom providers ──────────────────────

crudRouter.get("/providers", async (_req, res, next) => {
  try {
    const providers = readCustomProviders().map(maskApiKey);
    res.json({ providers });
  } catch (err) { next(err); }
});

// ── GET /providers/presets — all presets (builtin + custom merged, grouped) ──

crudRouter.get("/providers/presets", async (_req, res, next) => {
  try {
    const grouped: Record<string, Array<ProviderConfig & { quota: ReturnType<typeof getQuotaStatus>; provider_status: ProviderFourState }>> = {
      llm: [],
      image: [],
      video: [],
      tts: [],
    };

    for (const p of listMergedProviders()) {
      grouped[p.kind]?.push({ ...maskApiKey(p), quota: getQuotaStatus(p), provider_status: computeProviderStatus(p) });
    }

    res.json({ providers: grouped });
  } catch (err) { next(err); }
});

// ── POST /providers — create custom provider ────────────────────

crudRouter.post("/providers", async (req, res, next) => {
  try {
    const v = validate(CreateProviderSchema, req.body);
    if (handleValidationError(res, v)) return;

    const data = v.data;
    const existing = readCustomProviders();
    const builtins = getBuiltinPresets();

    if (data.kind === "video") {
      res.status(400).json({
        error: {
          code: "UnsupportedCustomProvider",
          message: "自定义视频 Provider 暂无通用适配器；请使用设置页内置视频 Provider，或先为该厂商实现 VideoProvider adapter。",
        },
      });
      return;
    }

    if (builtins.some((b) => b.id === data.id)) {
      res.status(409).json({ error: { code: "IdConflict", message: `id "${data.id}" 与内置 provider 冲突` } });
      return;
    }
    if (existing.some((p) => p.id === data.id)) {
      res.status(409).json({ error: { code: "IdConflict", message: `id "${data.id}" 已存在` } });
      return;
    }

    const newProvider: ProviderConfig = {
      ...data,
      api_key: undefined,
      is_builtin: false,
      anthropic_version: data.anthropic_version || (data.api_type === "anthropic" ? "2023-06-01" : ""),
    };

    existing.push(newProvider);
    await writeCustomProviders(existing);

    if (data.api_key) {
      await writeLocalSettings({ [`CUSTOM_PROVIDER_${storageId(data.id)}_API_KEY`]: data.api_key });
    }
    reloadRegistry();

    res.status(201).json({ provider: maskApiKey(newProvider) });
  } catch (err) { next(err); }
});

// ── PATCH /providers/:id — edit custom provider ─────────────────

crudRouter.patch("/providers/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const v = validate(PatchProviderSchema, req.body);
    if (handleValidationError(res, v)) return;

    const builtin = getBuiltinPresets().find((p) => p.id === id);
    if (builtin) {
      const data = { ...v.data };
      const patch = buildBuiltinSettingsPatch(id, data);
      if (Object.keys(patch).length > 0) {
        await writeLocalSettings(patch);
        clearHealthCache();
        reloadRegistry();
      }
      const updated = resolveProvider(id) ?? builtin;
      res.json({ provider: maskApiKey(updated) });
      return;
    }

    const providers = readCustomProviders();
    const idx = providers.findIndex((p) => p.id === id);
    if (idx === -1) {
      res.status(404).json({ error: { code: "NotFound", message: `provider "${id}" 不存在` } });
      return;
    }

    const { api_key: patchApiKey, ...dataWithoutKey } = v.data;
    if (patchApiKey) {
      await writeLocalSettings({ [`CUSTOM_PROVIDER_${storageId(id)}_API_KEY`]: patchApiKey });
    }
    const data = dataWithoutKey;

    const updated = { ...providers[idx], ...data };
    if (updated.api_type === "anthropic" && !updated.anthropic_version) {
      updated.anthropic_version = "2023-06-01";
    }
    providers[idx] = updated;
    await writeCustomProviders(providers);
    clearHealthCache();
    reloadRegistry();

    res.json({ provider: maskApiKey(updated) });
  } catch (err) { next(err); }
});

// ── DELETE /providers/:id — delete custom provider ──────────────

crudRouter.delete("/providers/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const builtins = getBuiltinPresets();
    if (builtins.some((b) => b.id === id)) {
      res.status(403).json({ error: { code: "BuiltinProtected", message: "内置 provider 不可删除" } });
      return;
    }

    const providers = readCustomProviders();
    const idx = providers.findIndex((p) => p.id === id);
    if (idx === -1) {
      res.status(404).json({ error: { code: "NotFound", message: `provider "${id}" 不存在` } });
      return;
    }

    providers.splice(idx, 1);
    await writeCustomProviders(providers);
    await writeLocalSettings({ [`CUSTOM_PROVIDER_${storageId(id)}_API_KEY`]: null });
    clearHealthCache();
    reloadRegistry();

    res.json({ ok: true, message: `provider "${id}" 已删除` });
  } catch (err) { next(err); }
});

// ── POST /providers/:id/fetch-models ────────────────────────────

crudRouter.post("/providers/:id/fetch-models", async (req, res, next) => {
  try {
    const { id } = req.params;
    const provider = resolveProvider(id);
    if (!provider) { res.status(404).json({ error: { code: "NotFound", message: `provider "${id}" 不存在` } }); return; }

    const apiKey = provider.api_key ?? getResolvedKey(id);
    if (!apiKey || apiKey.trim() === "") {
      res.status(400).json({ error: { code: "KeyMissing", message: "API key 未配置，无法拉取模型列表" } });
      return;
    }

    const models = await fetchModelList(provider, apiKey);
    const now = new Date().toISOString();

    const providers = readCustomProviders();
    const idx = providers.findIndex((p) => p.id === id);
    if (idx !== -1) {
      providers[idx].model_list_cache = models;
      providers[idx].model_list_fetched_at = now;
      await writeCustomProviders(providers);
    }

    res.json({ provider_id: id, models, fetched_at: now });
  } catch (err) { next(err); }
});

async function fetchModelList(provider: ProviderConfig, apiKey: string): Promise<string[]> {
  const baseUrl = provider.base_url.replace(/\/$/, "");

  if (provider.api_type === "anthropic") {
    const resp = await fetch(`${baseUrl}/v1/models`, {
      headers: { "x-api-key": apiKey, "anthropic-version": provider.anthropic_version || "2023-06-01" },
    });
    if (!resp.ok) throw new Error(`Anthropic /v1/models 返回 HTTP ${resp.status}`);
    const data = await resp.json() as Record<string, unknown>;
    return ((data.data as unknown[]) || []).map((m) => (m as Record<string, unknown>).id as string);
  }

  const resp = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) throw new Error(`GET /models 返回 HTTP ${resp.status}`);
  const data2 = await resp.json() as Record<string, unknown>;
  return ((data2.data as unknown[]) || []).map((m) => (m as Record<string, unknown>).id as string);
}
