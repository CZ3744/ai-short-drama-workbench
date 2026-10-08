// P25: Tests for OpenAIGptImage2Provider — mock fetch

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PresetOption } from "../../../../core/src/presetSchema";
import type { ProviderContext } from "../../core/types";

function makePreset(overrides?: Record<string, unknown>): PresetOption {
  return {
    id: "openai_gpt_image_2",
    label_zh: "OpenAI gpt-image-2",
    label_en: "OpenAI gpt-image-2",
    prompt_phrase: "gpt-image-2",
    enabled: true,
    notes: "",
    default: false,
    ...overrides,
  } as PresetOption;
}

function makeCtx(overrides?: Partial<ProviderContext>): ProviderContext {
  return {
    series_slug: "test",
    job_id: "job-1",
    task_id: "task-1",
    log: () => {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

// Minimal 1x1 red PNG (67 bytes)
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

describe("OpenAIGptImage2Provider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("throws missing_key when no API key", async () => {
    const { OpenAIGptImage2Provider } = await import("../openaiGptImage2Provider");
    const provider = new OpenAIGptImage2Provider(makePreset(), null);

    await assert.rejects(
      () => provider.generate({
        prompt: "a red circle",
        width: 1024,
        height: 1024,
        count: 1,
      }, makeCtx()),
      (err: any) => {
        assert.equal(err.code, "missing_key");
        return true;
      }
    );
  });

  it("healthCheck returns ok:false without key", async () => {
    const { OpenAIGptImage2Provider } = await import("../openaiGptImage2Provider");
    const provider = new OpenAIGptImage2Provider(makePreset(), null);
    const result = await provider.healthCheck();
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("OPENAI_API_KEY"));
  });

  it("healthCheck returns ok with key", async () => {
    const { OpenAIGptImage2Provider } = await import("../openaiGptImage2Provider");
    const provider = new OpenAIGptImage2Provider(makePreset(), "sk-test-key");
    const result = await provider.healthCheck();
    assert.equal(result.ok, true);
  });

  it("generates image via mocked fetch", async () => {
    // Mock global fetch
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        created: Date.now(),
        data: [{ b64_json: TINY_PNG_B64 }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

    const { OpenAIGptImage2Provider } = await import("../openaiGptImage2Provider");
    const provider = new OpenAIGptImage2Provider(makePreset(), "sk-test-key");
    const ctx = makeCtx();

    const response = await provider.generate({
      prompt: "a beautiful sunset",
      width: 1024,
      height: 1024,
      count: 1,
    }, ctx);

    assert.equal(response.images.length, 1);
    assert.ok(Buffer.isBuffer(response.images[0].buffer));
    assert.equal(response.images[0].mime, "image/png");
    assert.equal(response.images[0].width, 1024);
    assert.equal(response.images[0].height, 1024);

    globalThis.fetch = originalFetch;
  });

  it("returns cost when cost_per_image_usd is set", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        created: Date.now(),
        data: [{ b64_json: TINY_PNG_B64 }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

    const { OpenAIGptImage2Provider } = await import("../openaiGptImage2Provider");
    const preset = makePreset({ cost_per_image_usd: 0.04 });
    const provider = new OpenAIGptImage2Provider(preset, "sk-test-key");

    const response = await provider.generate({
      prompt: "test",
      width: 1024,
      height: 1024,
      count: 2,
    }, makeCtx());

    assert.ok(response.cost);
    assert.equal(response.cost!.currency, "USD");
    // API returned 1 image (mock), so cost = 0.04 * 1
    assert.equal(response.cost!.amount, 0.04);
    assert.equal(response.cost!.basis, "estimated");

    globalThis.fetch = originalFetch;
  });

  it("maps dimensions to correct size", async () => {
    let capturedBody: any = null;
    globalThis.fetch = async (_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({ created: Date.now(), data: [{ b64_json: TINY_PNG_B64 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const { OpenAIGptImage2Provider } = await import("../openaiGptImage2Provider");
    const provider = new OpenAIGptImage2Provider(makePreset(), "sk-test-key");

    // Landscape
    await provider.generate({ prompt: "test", width: 1536, height: 1024, count: 1 }, makeCtx());
    assert.equal(capturedBody.size, "1536x1024");

    // Portrait
    await provider.generate({ prompt: "test", width: 1024, height: 1536, count: 1 }, makeCtx());
    assert.equal(capturedBody.size, "1024x1536");

    // Square
    await provider.generate({ prompt: "test", width: 1024, height: 1024, count: 1 }, makeCtx());
    assert.equal(capturedBody.size, "1024x1024");

    globalThis.fetch = originalFetch;
  });

  it("throws server error on API failure", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "Rate limit exceeded" } }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );

    const { OpenAIGptImage2Provider } = await import("../openaiGptImage2Provider");
    const provider = new OpenAIGptImage2Provider(makePreset(), "sk-test-key");

    await assert.rejects(
      () => provider.generate({ prompt: "test", width: 1024, height: 1024, count: 1 }, makeCtx()),
      (err: any) => {
        assert.equal(err.code, "rate_limit");
        assert.equal(err.retriable, true);
        return true;
      }
    );

    globalThis.fetch = originalFetch;
  });
});
