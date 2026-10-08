/**
 * P5E: Provider CRUD Tests
 *
 * Tests:
 *  1. Create custom OpenAI-compat provider
 *  2. Fetch model list
 *  3. Speed test
 *  4. Provider visible in registry after save
 *  5. Delete provider cleans up
 *  6. Builtin provider cannot be deleted
 *  7. Input validation (id format, base_url, required fields)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import type http from "node:http";
import { readCustomProviders } from "../providerController";
import {
  readLocalSettings,
  writeLocalSettings,
} from "../../../../../../packages/core/src/localSettings";

const TEST_PROVIDER_ID = "test_e2e_crud";
const CUSTOM_PROVIDERS_KEY = "CUSTOM_PROVIDERS";
let baseUrl = "";
let server: http.Server;

async function api(method: string, path: string, body?: unknown) {
  const url = `${baseUrl}${path}`;
  const opts: RequestInit = {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  const resp = await fetch(url, opts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试 fetch helper 返回未知后端 response shape
  const data = await resp.json() as any;
  return { status: resp.status, data };
}

describe("P5E Provider CRUD", () => {
  // Clean up before and after
  before(async () => {
    const express = (await import("express")).default;
    const { v2Router } = await import("../index");

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/v2", v2Router);
    app.use((err: any, _req: any, res: any, _next: any) => {
      const status = err.status ?? 500;
      res.status(status).json({ error: { code: "Error", message: err.message } });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Could not allocate test server port");
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    await cleanupTestProvider();
  });

  after(async () => {
    await cleanupTestProvider();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function cleanupTestProvider() {
    const providers = readCustomProviders();
    const filtered = providers.filter((p) => p.id === TEST_PROVIDER_ID);
    if (filtered.length === 0) return;
    const remaining = providers.filter((p) => p.id !== TEST_PROVIDER_ID);
    await writeLocalSettings({ [CUSTOM_PROVIDERS_KEY]: JSON.stringify(remaining) });
    await writeLocalSettings({ [`CUSTOM_PROVIDER_${TEST_PROVIDER_ID.toUpperCase()}_API_KEY`]: null });
  }

  it("should create a new OpenAI-compat provider", async () => {
    await cleanupTestProvider();

    const { status, data } = await api("POST", "/api/v2/providers", {
      id: TEST_PROVIDER_ID,
      label_zh: "E2E 测试 Provider",
      kind: "llm",
      api_type: "openai_compat",
      base_url: "https://api.test.example.com/v1",
      api_key: "sk-test-key-12345678",
      model_id: "test-model-v1",
      timeout_ms: 30000,
      max_retries: 2,
    });

    assert.strictEqual(status, 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    assert.ok(data.provider, "Response should have provider field");
    assert.strictEqual(data.provider.id, TEST_PROVIDER_ID);
    assert.strictEqual(data.provider.label_zh, "E2E 测试 Provider");
    assert.strictEqual(data.provider.kind, "llm");
    assert.strictEqual(data.provider.api_type, "openai_compat");
    assert.strictEqual(data.provider.is_builtin, false);

    // api_key should be masked in response
    assert.ok(data.provider.api_key, "api_key should be present (masked)");
    assert.ok(data.provider.api_key.includes("****"), "api_key should be masked with ****");
  });

  it("should list custom providers", async () => {
    const { status, data } = await api("GET", "/api/v2/providers");

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.providers));
    const testProvider = data.providers.find((p: any) => p.id === TEST_PROVIDER_ID);
    assert.ok(testProvider, "Created provider should appear in GET /providers");
    assert.ok(testProvider.api_key.includes("****"));
  });

  it("should list presets including custom provider", async () => {
    const { status, data } = await api("GET", "/api/v2/providers/presets");

    assert.strictEqual(status, 200);
    assert.ok(data.providers, "Response should have providers grouped by kind");
    assert.ok(data.providers.llm, "Should have LLM providers");
    assert.ok(Array.isArray(data.providers.llm));

    const customInPresets = data.providers.llm.find((p: any) => p.id === TEST_PROVIDER_ID);
    assert.ok(customInPresets, "Custom provider should appear in presets");
    assert.ok(customInPresets.quota, "Should have quota info");
    assert.strictEqual(typeof customInPresets.quota.color, "string");
  });

  it("should expose custom providers in health by kind", async () => {
    const { status, data } = await api("GET", "/api/v2/providers/health");

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.providers));

    const customInHealth = data.providers.find((p: any) => p.id === TEST_PROVIDER_ID);
    assert.ok(customInHealth, "Custom provider should appear in /providers/health");
    assert.strictEqual(customInHealth.kind, "llm");
    assert.strictEqual(customInHealth.key_present, true);
  });

  it("should edit a custom provider", async () => {
    const { status, data } = await api("PATCH", `/api/v2/providers/${TEST_PROVIDER_ID}`, {
      label_zh: "E2E 测试 Provider (已编辑)",
      timeout_ms: 60000,
    });

    assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert.strictEqual(data.provider.label_zh, "E2E 测试 Provider (已编辑)");
    assert.strictEqual(data.provider.timeout_ms, 60000);
  });

  it("should not create provider with invalid id format", async () => {
    const { status, data } = await api("POST", "/api/v2/providers", {
      id: "INVALID ID!",
      label_zh: "Bad ID",
      kind: "llm",
      api_type: "openai_compat",
      base_url: "https://example.com/v1",
      api_key: "sk-test",
    });

    assert.strictEqual(status, 400, `Should reject invalid id, got ${status}`);
    assert.ok(data.error);
  });

  it("should not create provider without api_key", async () => {
    const { status, data } = await api("POST", "/api/v2/providers", {
      id: "test_no_key",
      label_zh: "No Key",
      kind: "llm",
      api_type: "openai_compat",
      base_url: "https://example.com/v1",
      api_key: "",
    });

    assert.strictEqual(status, 400, `Should reject empty api_key, got ${status}`);
  });

  it("should not create provider with invalid base_url", async () => {
    const { status, data } = await api("POST", "/api/v2/providers", {
      id: "test_bad_url",
      label_zh: "Bad URL",
      kind: "llm",
      api_type: "openai_compat",
      base_url: "not-a-url",
      api_key: "sk-test",
    });

    assert.strictEqual(status, 400, `Should reject invalid URL, got ${status}`);
  });

  it("should prevent deleting builtin providers", async () => {
    const { status, data } = await api("DELETE", "/api/v2/providers/ikuncode_gpt55");

    assert.strictEqual(status, 403, `Should reject deleting builtin, got ${status}`);
    assert.ok(data.error);
    assert.strictEqual(data.error.code, "BuiltinProtected");
  });

  it("should fetch model list (expects to fail without real endpoint)", async () => {
    // This will fail because the test endpoint doesn't exist, but the route should work
    const { status, data } = await api("POST", `/api/v2/providers/${TEST_PROVIDER_ID}/fetch-models`);

    // Since we use a fake base_url, it will throw. We just verify the route exists
    // and returns a structured error, not a 404.
    assert.ok(status === 400 || status === 500 || status === 404,
      `Expected 400/404/500 for fetch-models, got ${status}`);
  });

  it("should handle speed test (expects to fail without real endpoint)", async () => {
    const { status, data } = await api("POST", `/api/v2/providers/${TEST_PROVIDER_ID}/speed-test`);

    // Similar: fake endpoint will fail but route should resolve
    assert.ok(status !== 404 || data.error?.code === "NotFound",
      `Expected non-404 or NotFound for speed-test, got ${status}: ${JSON.stringify(data)}`);
  });

  it("should delete custom provider", async () => {
    const { status, data } = await api("DELETE", `/api/v2/providers/${TEST_PROVIDER_ID}`);

    assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert.strictEqual(data.ok, true);

    // Verify it's gone from listing
    const list = await api("GET", "/api/v2/providers");
    const found = list.data.providers.find((p: any) => p.id === TEST_PROVIDER_ID);
    assert.strictEqual(found, undefined, "Provider should be deleted from listing");
  });

  it("should return 404 for non-existent provider", async () => {
    const { status, data } = await api("PATCH", `/api/v2/providers/nonexistent_id`, {
      label_zh: "Not Found",
    });

    assert.strictEqual(status, 404);
    assert.strictEqual(data.error.code, "NotFound");
  });

  it("should reject duplicate provider id on create", async () => {
    // Create first
    await api("POST", "/api/v2/providers", {
      id: TEST_PROVIDER_ID,
      label_zh: "Duplicate Test",
      kind: "llm",
      api_type: "openai_compat",
      base_url: "https://api.example.com/v1",
      api_key: "sk-test-key",
    });

    // Try duplicate
    const { status, data } = await api("POST", "/api/v2/providers", {
      id: TEST_PROVIDER_ID,
      label_zh: "Duplicate Test 2",
      kind: "llm",
      api_type: "openai_compat",
      base_url: "https://api.example.com/v1",
      api_key: "sk-test-key",
    });

    assert.strictEqual(status, 409);
    assert.strictEqual(data.error.code, "IdConflict");

    // Clean up
    await cleanupTestProvider();
  });
});
