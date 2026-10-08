/**
 * P21: JimengImageProvider tests — all mock fetch, no real API calls
 *
 * Test cases:
 * 1. Normal generation of 2 images → Buffer non-empty
 * 2. Auth failure (401) → ProviderError.code === "missing_key"
 * 3. Rate limit (429) → retriable: true
 * 4. Image URL download failure → ProviderError.code === "server"
 * 5. Reference image → body has base64 field (string length > 100)
 * 6. healthCheck: no key → ok:false, has key → ok:true
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JimengImageProvider } from "../jimengImageProvider";
import { ProviderError } from "../../core/errors";
import type { PresetOption } from "../../../../core/src/presetSchema";
import type { ImageGenerateRequest, ProviderContext } from "../../core/types";

// ─── Helpers ────────────────────────────────────────────────────────────

function makePreset(): PresetOption {
  return {
    id: "jimeng_image_4",
    label_zh: "即梦 Image 4.0",
    label_en: "Jimeng Image 4.0",
    prompt_phrase: "",
    enabled: true,
    notes: "",
    default: false,
  };
}

function makeCtx(overrides?: Partial<ProviderContext>): ProviderContext {
  return {
    series_slug: "test-series",
    job_id: "job-001",
    task_id: "task-001",
    log: () => {},
    signal: AbortSignal.timeout(30_000),
    ...overrides,
  };
}

function makeReq(overrides?: Partial<ImageGenerateRequest>): ImageGenerateRequest {
  return {
    prompt: "一只可爱的猫咪坐在窗台上",
    width: 1024,
    height: 1024,
    count: 1,
    ...overrides,
  };
}

const VALID_KEY_JSON = JSON.stringify({
  access_key: "test-access-key-12345",
  secret_key: "test-secret-key-67890",
});

/** Create a 1x1 red PNG as a minimal valid image buffer */
function fakePngBuffer(): Buffer {
  // Minimal valid PNG: 1x1 red pixel
  const pngHex =
    "89504e470d0a1a0a0000000d494844520000000100000001" +
    "0802000000907753de0000000c4944415478016360f8cf00" +
    "0000020001e221bc330000000049454e44ae426082";
  return Buffer.from(pngHex, "hex");
}

const FAKE_PNG = fakePngBuffer();
const FAKE_PNG_B64 = FAKE_PNG.toString("base64");

// ─── Mock fetch infrastructure ──────────────────────────────────────────

let mockFetchFn: typeof globalThis.fetch | null = null;

function setupMockFetch(fn: typeof globalThis.fetch) {
  mockFetchFn = fn;
  // Override global fetch
  (globalThis as any).fetch = async (url: any, init?: any) => {
    return mockFetchFn!(url, init);
  };
}

function restoreFetch() {
  mockFetchFn = null;
  // Note: in real test harness, restore original fetch
  // For node:test, we just set it back to a basic impl
  (globalThis as any).fetch = async (url: any, _init?: any) => {
    throw new Error(`Unmocked fetch: ${url}`);
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("JimengImageProvider", () => {
  beforeEach(() => {
    restoreFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  // --- Test 1: Normal generation of 2 images ---

  it("generates 2 images, returns non-empty Buffers", async () => {
    let callCount = 0;

    setupMockFetch(async (url: any, _init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes("visual.volcengineapi.com")) {
        callCount++;
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: {
              binary_data_base64: [FAKE_PNG_B64],
            },
            response_metadata: { request_id: "req-001", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const provider = new JimengImageProvider(makePreset(), VALID_KEY_JSON);
    const result = await provider.generate(makeReq({ count: 2 }), makeCtx());

    assert.equal(result.images.length, 2, "should return 2 images");
    assert.ok(result.images[0].buffer.length > 0, "image 0 buffer non-empty");
    assert.ok(result.images[1].buffer.length > 0, "image 1 buffer non-empty");
    assert.equal(callCount, 2, "should call API twice for count=2");
  });

  // --- Test 2: Auth failure (401) → missing_key ---

  it("maps 401 to ProviderError.code === 'missing_key'", async () => {
    setupMockFetch(async () => {
      return new Response(
        JSON.stringify({
          code: 50403,
          message: "Authentication failed",
          response_metadata: {
            request_id: "req-002",
            status_code: 401,
            error: { code: "AuthFailure", message: "Invalid credentials" },
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new JimengImageProvider(makePreset(), VALID_KEY_JSON);

    await assert.rejects(
      () => provider.generate(makeReq(), makeCtx()),
      (err: any) => {
        assert.ok(err instanceof ProviderError, "should be ProviderError");
        assert.equal(err.code, "missing_key", "code should be missing_key");
        return true;
      },
    );
  });

  // --- Test 3: Rate limit (429) → retriable: true ---

  it("maps 429 to retriable: true", async () => {
    setupMockFetch(async () => {
      return new Response(
        JSON.stringify({
          code: 50429,
          message: "Rate limit exceeded",
          response_metadata: {
            request_id: "req-003",
            status_code: 429,
            error: { code: "Throttling", message: "Too many requests" },
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new JimengImageProvider(makePreset(), VALID_KEY_JSON);

    await assert.rejects(
      () => provider.generate(makeReq(), makeCtx()),
      (err: any) => {
        assert.ok(err instanceof ProviderError, "should be ProviderError");
        assert.equal(err.code, "rate_limit", "code should be rate_limit");
        assert.equal(err.retriable, true, "retriable should be true");
        return true;
      },
    );
  });

  // --- Test 4: Image URL download failure → server error ---

  it("maps URL download failure to ProviderError.code === 'server'", async () => {
    setupMockFetch(async (url: any, _init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes("visual.volcengineapi.com")) {
        // API returns a URL
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: {
              image_urls: ["https://example.com/fake-image.png"],
            },
            response_metadata: { request_id: "req-004", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Image download fails
      if (urlStr.includes("example.com")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const provider = new JimengImageProvider(makePreset(), VALID_KEY_JSON);

    await assert.rejects(
      () => provider.generate(makeReq(), makeCtx()),
      (err: any) => {
        assert.ok(err instanceof ProviderError, "should be ProviderError");
        assert.equal(err.code, "server", "code should be server");
        return true;
      },
    );
  });

  // --- Test 5: Reference image → body has base64 field ---

  it("sends base64 reference image in request body", async (t) => {
    let capturedBody: string | null = null;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "jimeng-reference-"));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const referencePath = path.join(folder, "reference.png");
    await fs.writeFile(referencePath, Buffer.from(FAKE_PNG_B64, "base64"));

    setupMockFetch(async (url: any, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes("visual.volcengineapi.com")) {
        capturedBody = init?.body ?? null;
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: {
              binary_data_base64: [FAKE_PNG_B64],
            },
            response_metadata: { request_id: "req-005", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const provider = new JimengImageProvider(makePreset(), VALID_KEY_JSON);

    const result = await provider.generate(
      makeReq({ reference_images: [{ asset_id: referencePath }] }),
      makeCtx(),
    );

    assert.ok(result.images.length === 1, "should return 1 image");
    assert.ok(capturedBody, "should have captured request body");

    const body = JSON.parse(capturedBody!);
    assert.deepEqual(body.binary_data_base64, [FAKE_PNG_B64]);

    capturedBody = null;
    await assert.rejects(() => provider.generate(
      makeReq({ reference_images: [{ asset_id: "nonexistent-id" }] }), makeCtx(),
    ), /Reference image not found/);
    assert.equal(capturedBody, null, "缺失参考图不能静默当作无参考图请求发送");
  });

  // --- Test 6: healthCheck ---

  describe("healthCheck", () => {
    it("returns ok:false when no key configured", async () => {
      const provider = new JimengImageProvider(makePreset(), null);
      const result = await provider.healthCheck();
      assert.equal(result.ok, false, "ok should be false without key");
      assert.ok(result.reason, "should provide reason");
    });

    it("returns ok:true when key is configured", async () => {
      const provider = new JimengImageProvider(makePreset(), VALID_KEY_JSON);
      const result = await provider.healthCheck();
      assert.equal(result.ok, true, "ok should be true with key");
    });

    it("returns ok:false when only partial keys (missing secret)", async () => {
      const partialKey = JSON.stringify({ access_key: "only-access" });
      const provider = new JimengImageProvider(makePreset(), partialKey);
      const result = await provider.healthCheck();
      assert.equal(result.ok, false, "ok should be false with partial key");
    });
  });

  // --- Additional: no key → missing_key error on generate ---

  it("throws missing_key when no API key configured", async () => {
    const provider = new JimengImageProvider(makePreset(), null);

    await assert.rejects(
      () => provider.generate(makeReq(), makeCtx()),
      (err: any) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.code, "missing_key");
        return true;
      },
    );
  });

  // --- Additional: provider id ---

  it("has correct id", () => {
    const provider = new JimengImageProvider(makePreset(), null);
    assert.equal(provider.id, "jimeng_image_4");
  });
});
