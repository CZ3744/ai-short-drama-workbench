/**
 * P22: JimengVideoProvider tests — all mock fetch, no real API calls
 *
 * Test cases:
 * 1. Submit → poll 3x (2x processing + 1x success) → download success
 * 2. mode="t2v" (no first_frame) → throws invalid_request
 * 3. Poll timeout → throws timeout
 * 4. ctx.signal.abort() → stops polling + rejection
 * 5. Success → ledger records cost.amount = duration_sec * cost_per_second_cny
 * 6. healthCheck: no key → ok:false, has key → ok:true
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JimengVideoProvider } from "../jimengVideoProvider";
import { ProviderError } from "../../core/errors";
import type { PresetOption } from "../../../../core/src/presetSchema";
import type { VideoGenerateRequest, ProviderContext } from "../../core/types";

// ─── Helpers ────────────────────────────────────────────────────────────

function makePreset(overrides?: Partial<PresetOption>): PresetOption {
  return {
    id: "jimeng_video_3pro",
    label_zh: "即梦视频 3.0 Pro",
    label_en: "Jimeng Video 3.0 Pro",
    prompt_phrase: "",
    enabled: true,
    notes: "",
    default: false,
    extras: {
      model_variant: "jimeng_high_aes_general_v30pro",
      cost_per_second_cny: 0.5,
    },
    ...overrides,
  };
}

function make720Preset(): PresetOption {
  return {
    id: "jimeng_video_3_720p",
    label_zh: "即梦视频 3.0 720P",
    label_en: "Jimeng Video 3.0 720P",
    prompt_phrase: "",
    enabled: true,
    notes: "",
    default: false,
    extras: {
      model_variant: "jimeng_high_aes_general_v30",
      cost_per_second_cny: 0.3,
    },
  };
}

function makeCtx(overrides?: Partial<ProviderContext>): ProviderContext {
  return {
    series_slug: "test-series",
    job_id: "job-001",
    task_id: "task-001",
    log: () => {},
    signal: AbortSignal.timeout(60_000),
    ...overrides,
  };
}

function makeReq(overrides?: Partial<VideoGenerateRequest>): VideoGenerateRequest {
  return {
    prompt: "一只可爱的猫咪在草地上奔跑",
    first_frame: { asset_id: firstFramePath },
    duration_sec: 5,
    aspect_ratio: "16:9",
    ...overrides,
  };
}

const VALID_KEY_JSON = JSON.stringify({
  access_key: "test-access-key-12345",
  secret_key: "test-secret-key-67890",
});

/** Create a fake MP4 buffer (minimal valid mp4 header) */
function fakeMp4Buffer(): Buffer {
  // Minimal ftyp box + moov box placeholder
  const hex =
    "0000001c667479706d703432000000006d7034326d70343169736f6d" +
    "000000086d6f6f76";
  return Buffer.from(hex, "hex");
}

const FAKE_MP4 = fakeMp4Buffer();

/** Create a 1x1 red PNG as a minimal valid image buffer */
function fakePngBuffer(): Buffer {
  const pngHex =
    "89504e470d0a1a0a0000000d494844520000000100000001" +
    "0802000000907753de0000000c4944415478016360f8cf00" +
    "0000020001e221bc330000000049454e44ae426082";
  return Buffer.from(pngHex, "hex");
}

const FAKE_PNG = fakePngBuffer();

// ─── Temp file for first_frame ──────────────────────────────────────────

let tmpDir: string;
let firstFramePath: string;

// ─── Mock fetch infrastructure ──────────────────────────────────────────

let mockFetchFn: typeof globalThis.fetch | null = null;
let originalFetch: typeof globalThis.fetch;

function setupMockFetch(fn: typeof globalThis.fetch) {
  mockFetchFn = fn;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    return mockFetchFn!(url, init);
  };
}

function restoreFetch() {
  mockFetchFn = null;
  (globalThis as any).fetch = originalFetch ?? (async (url: any) => {
    throw new Error(`Unmocked fetch: ${url}`);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("JimengVideoProvider", () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    restoreFetch();
    // Create temp dir and first frame file
    tmpDir = path.join(os.tmpdir(), `jimeng-video-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    firstFramePath = path.join(tmpDir, "first_frame.png");
    await fs.writeFile(firstFramePath, FAKE_PNG);
  });

  afterEach(async () => {
    restoreFetch();
    // Cleanup temp dir
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // --- Test 1: Submit → poll 3x (2x processing + 1x success) → download ---

  it("submit → poll 3x (2 processing + 1 success) → download success", async () => {
    let pollCount = 0;
    const taskId = "task-abc-123";

    setupMockFetch(async (url: any, init?: any) => {
      const urlStr = String(url);
      const body = init?.body ? JSON.parse(init.body) : {};

      // Submit endpoint
      if (urlStr.includes("Action=CVSync2AsyncSubmitTask")) {
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: { task_id: taskId },
            response_metadata: { request_id: "req-submit", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Query endpoint
      if (urlStr.includes("Action=CVSync2AsyncGetResult")) {
        pollCount++;
        if (pollCount <= 2) {
          // Processing
          return new Response(
            JSON.stringify({
              code: 10000,
              message: "success",
              data: { task_id: taskId, task_status: "Running" },
              response_metadata: { request_id: `req-poll-${pollCount}`, status_code: 200 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Success
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: {
              task_id: taskId,
              task_status: "Succeeded",
              video_url: "https://example.com/result.mp4",
            },
            response_metadata: { request_id: "req-poll-success", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Download endpoint
      if (urlStr.includes("example.com/result.mp4")) {
        return new Response(new Uint8Array(FAKE_MP4), { status: 200 });
      }

      return new Response("Not Found", { status: 404 });
    });

    const provider = new JimengVideoProvider(makePreset(), VALID_KEY_JSON);
    const result = await provider.generate(makeReq(), makeCtx());

    assert.ok(result.video.buffer.length > 0, "video buffer should be non-empty");
    assert.equal(result.video.mime, "video/mp4");
    assert.equal(result.video.duration_sec, 5);
    assert.equal(result.video.width, 1280);
    assert.equal(result.video.height, 720);
    assert.equal(pollCount, 3, "should poll 3 times");
  });

  // --- Test 2: mode="t2v" (no first_frame) → invalid_request ---

  it("throws invalid_request when first_frame is missing (t2v mode)", async () => {
    const provider = new JimengVideoProvider(makePreset(), VALID_KEY_JSON);

    await assert.rejects(
      () => provider.generate(makeReq({ first_frame: undefined }), makeCtx()),
      (err: any) => {
        assert.ok(err instanceof ProviderError, "should be ProviderError");
        assert.equal(err.code, "invalid_request", "code should be invalid_request");
        return true;
      },
    );
  });

  // --- Test 3: Poll timeout → timeout ---

  it("throws timeout when polling exceeds timeout", async () => {
    setupMockFetch(async (url: any, _init?: any) => {
      const urlStr = String(url);

      if (urlStr.includes("Action=CVSync2AsyncSubmitTask")) {
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: { task_id: "timeout-task" },
            response_metadata: { request_id: "req-submit", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("Action=CVSync2AsyncGetResult")) {
        // Always return "Running" to trigger timeout
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: { task_id: "timeout-task", task_status: "Running" },
            response_metadata: { request_id: "req-poll", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    });

    // Create provider with very short timeout
    const preset = makePreset();
    const provider = new JimengVideoProvider(preset, VALID_KEY_JSON);

    // Override config poll timeout to 1 second for fast test
    (provider as any)._config.pollTimeoutMs = 1_000;
    (provider as any)._config.pollIntervalMs = 200;

    await assert.rejects(
      () => provider.generate(makeReq(), makeCtx()),
      (err: any) => {
        assert.ok(err instanceof ProviderError, "should be ProviderError");
        assert.equal(err.code, "timeout", "code should be timeout");
        return true;
      },
    );
  });

  // --- Test 4: ctx.signal.abort() → stops polling + rejection ---

  it("stops polling and rejects when ctx.signal is aborted", async () => {
    const abortController = new AbortController();

    setupMockFetch(async (url: any, _init?: any) => {
      const urlStr = String(url);

      if (urlStr.includes("Action=CVSync2AsyncSubmitTask")) {
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: { task_id: "abort-task" },
            response_metadata: { request_id: "req-submit", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("Action=CVSync2AsyncGetResult")) {
        // Abort after first poll
        abortController.abort();
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: { task_id: "abort-task", task_status: "Running" },
            response_metadata: { request_id: "req-poll", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    });

    const provider = new JimengVideoProvider(makePreset(), VALID_KEY_JSON);
    (provider as any)._config.pollIntervalMs = 100;

    const ctx = makeCtx({ signal: abortController.signal });

    await assert.rejects(
      () => provider.generate(makeReq(), ctx),
      (err: any) => {
        assert.ok(err instanceof ProviderError, "should be ProviderError");
        // The poller returns "timeout" status when aborted
        assert.equal(err.code, "timeout", "code should be timeout");
        return true;
      },
    );
  });

  // --- Test 5: Success → cost = duration_sec * cost_per_second_cny ---

  it("records cost.amount = duration_sec * cost_per_second_cny on success", async () => {
    setupMockFetch(async (url: any, _init?: any) => {
      const urlStr = String(url);

      if (urlStr.includes("Action=CVSync2AsyncSubmitTask")) {
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: { task_id: "cost-task" },
            response_metadata: { request_id: "req-submit", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("Action=CVSync2AsyncGetResult")) {
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: {
              task_id: "cost-task",
              task_status: "Succeeded",
              video_url: "https://example.com/cost-result.mp4",
            },
            response_metadata: { request_id: "req-poll", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("example.com/cost-result.mp4")) {
        return new Response(new Uint8Array(FAKE_MP4), { status: 200 });
      }

      return new Response("Not Found", { status: 404 });
    });

    // cost_per_second_cny = 0.5, duration = 5s → expected cost = 2.5
    const provider = new JimengVideoProvider(makePreset(), VALID_KEY_JSON);
    const result = await provider.generate(makeReq({ duration_sec: 5 }), makeCtx());

    assert.ok(result.cost, "should have cost info");
    assert.equal(result.cost!.currency, "CNY");
    assert.ok(Math.abs(result.cost!.amount - 2.5) < 0.001, `cost should be 2.5, got ${result.cost!.amount}`);
    assert.equal(result.cost!.basis, "measured");
  });

  // --- Test 6: healthCheck ---

  describe("healthCheck", () => {
    it("returns ok:false when no key configured", async () => {
      const provider = new JimengVideoProvider(makePreset(), null);
      const result = await provider.healthCheck();
      assert.equal(result.ok, false, "ok should be false without key");
      assert.ok(result.reason, "should provide reason");
    });

    it("returns ok:true when key is configured", async () => {
      const provider = new JimengVideoProvider(makePreset(), VALID_KEY_JSON);
      const result = await provider.healthCheck();
      assert.equal(result.ok, true, "ok should be true with key");
    });

    it("returns ok:false when only partial keys (missing secret)", async () => {
      const partialKey = JSON.stringify({ access_key: "only-access" });
      const provider = new JimengVideoProvider(makePreset(), partialKey);
      const result = await provider.healthCheck();
      assert.equal(result.ok, false, "ok should be false with partial key");
    });
  });

  // --- Additional: no key → missing_key error on generate ---

  it("throws missing_key when no API key configured", async () => {
    const provider = new JimengVideoProvider(makePreset(), null);

    await assert.rejects(
      () => provider.generate(makeReq(), makeCtx()),
      (err: any) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.code, "missing_key");
        return true;
      },
    );
  });

  // --- Additional: provider id and mode ---

  it("has correct id and mode", () => {
    const provider = new JimengVideoProvider(makePreset(), null);
    assert.equal(provider.id, "jimeng_video_3pro");
    assert.equal(provider.mode, "i2v");
  });

  // --- Additional: 720P variant uses correct model ---

  it("720P preset resolves to jimeng_high_aes_general_v30", async () => {
    let capturedBody: string | null = null;

    setupMockFetch(async (url: any, init?: any) => {
      const urlStr = String(url);

      if (urlStr.includes("Action=CVSync2AsyncSubmitTask")) {
        capturedBody = init?.body ?? null;
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: { task_id: "720p-task" },
            response_metadata: { request_id: "req-submit", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("Action=CVSync2AsyncGetResult")) {
        return new Response(
          JSON.stringify({
            code: 10000,
            message: "success",
            data: {
              task_id: "720p-task",
              task_status: "Succeeded",
              video_url: "https://example.com/720p.mp4",
            },
            response_metadata: { request_id: "req-poll", status_code: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("example.com/720p.mp4")) {
        return new Response(new Uint8Array(FAKE_MP4), { status: 200 });
      }

      return new Response("Not Found", { status: 404 });
    });

    const provider = new JimengVideoProvider(make720Preset(), VALID_KEY_JSON);
    await provider.generate(makeReq(), makeCtx());

    assert.ok(capturedBody, "should have captured request body");
    const body = JSON.parse(capturedBody!);
    assert.equal(body.req_key, "jimeng_high_aes_general_v30", "720P should use v30 model");
  });

  // --- Additional: missing first_frame asset file → invalid_request ---

  it("throws invalid_request when first_frame file does not exist", async () => {
    const provider = new JimengVideoProvider(makePreset(), VALID_KEY_JSON);

    await assert.rejects(
      () => provider.generate(makeReq({ first_frame: { asset_id: "/nonexistent/file.png" } }), makeCtx()),
      (err: any) => {
        assert.ok(err instanceof ProviderError, "should be ProviderError");
        assert.equal(err.code, "invalid_request", "code should be invalid_request");
        return true;
      },
    );
  });
});
