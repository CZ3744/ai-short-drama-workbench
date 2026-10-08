// P24: Vidu Video Provider tests (mock, no real API key)

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ViduRefVideoProvider, estimateCost } from "../viduRefVideoProvider";
import { sortReferenceImages, InvalidRefRequestError, type RefImageInput } from "../../promptAdapters/vidu";
import type { PresetOption } from "../../../../core/src/presetSchema";
import type { VideoGenerateRequest, ProviderContext } from "../../core/types";

// ─── Helpers ──────────────────────────────────────────────────────────

function makePreset(overrides?: Record<string, any>): PresetOption {
  return {
    id: "vidu_q3_ref",
    label_zh: "Vidu Q3 参考图生视频",
    label_en: "Vidu Q3 Reference-to-Video",
    prompt_phrase: "",
    enabled: true,
    notes: "",
    default: false,
    ...overrides,
  } as PresetOption;
}

function makeCtx(): ProviderContext {
  return {
    series_slug: "test-series",
    job_id: "job-001",
    task_id: "task-001",
    log: () => {},
    signal: AbortSignal.timeout(30_000),
  };
}

function makeRefImages(count: number): Array<{ asset_id: string }> {
  return Array.from({ length: count }, (_, i) => ({
    asset_id: `data:image/png;base64,fake${i}`,
  }));
}

function makeReq(overrides?: Partial<VideoGenerateRequest>): VideoGenerateRequest {
  return {
    prompt: "A character walks through a neon-lit city street",
    reference_images: makeRefImages(3),
    duration_sec: 4,
    aspect_ratio: "16:9",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("ViduRefVideoProvider", () => {
  it("throws missing_key when no API key", async () => {
    const provider = new ViduRefVideoProvider(makePreset(), null);
    const err = await provider.generate(makeReq(), makeCtx()).then(
      () => { throw new Error("should have thrown"); },
      (e) => e,
    );
    assert.equal(err.code, "missing_key");
    assert.match(err.message, /VIDU_API_KEY/);
  });

  it("throws invalid_request when < 3 reference images", async () => {
    const provider = new ViduRefVideoProvider(makePreset(), "fake-key");
    const req = makeReq({ reference_images: makeRefImages(2) });
    const err = await provider.generate(req, makeCtx()).then(
      () => { throw new Error("should have thrown"); },
      (e) => e,
    );
    assert.equal(err.code, "invalid_request");
    assert.match(err.message, /at least 3/);
  });

  it("throws invalid_request when > 7 reference images", async () => {
    const provider = new ViduRefVideoProvider(makePreset(), "fake-key");
    const req = makeReq({ reference_images: makeRefImages(8) });
    const err = await provider.generate(req, makeCtx()).then(
      () => { throw new Error("should have thrown"); },
      (e) => e,
    );
    assert.equal(err.code, "invalid_request");
    assert.match(err.message, /at most 7/);
  });

  it("healthCheck returns ok when key present", async () => {
    const provider = new ViduRefVideoProvider(makePreset(), "fake-key");
    const result = await provider.healthCheck();
    assert.equal(result.ok, true);
  });

  it("healthCheck returns not ok when no key", async () => {
    const provider = new ViduRefVideoProvider(makePreset(), null);
    const result = await provider.healthCheck();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing key");
  });
});

describe("sortReferenceImages", () => {
  const pseudoShot = { character_ids: ["char-A", "char-B"] } as any;

  it("sorts: main char first, scene second, others last", () => {
    const inputs: RefImageInput[] = [
      { asset_id: "scene1", role: "scene", url: "u1", label: "scene" },
      { asset_id: "charB", role: "character", character_id: "char-B", url: "u2", label: "charB" },
      { asset_id: "charA", role: "character", character_id: "char-A", url: "u3", label: "charA" },
    ];
    const sorted = sortReferenceImages(pseudoShot, inputs);
    assert.equal(sorted.length, 3);
    assert.match(sorted[0].label, /charA/);
    assert.equal(sorted[1].label, "scene");
    assert.match(sorted[2].label, /charB/);
  });

  it("throws when < 3 images", () => {
    const inputs: RefImageInput[] = [
      { asset_id: "a", role: "character", character_id: "char-A", url: "u1" },
      { asset_id: "b", role: "scene", url: "u2" },
    ];
    assert.throws(
      () => sortReferenceImages(pseudoShot, inputs),
      (err: any) => err instanceof InvalidRefRequestError && /at least 3/.test(err.message),
    );
  });

  it("throws when > 7 images", () => {
    const inputs: RefImageInput[] = Array.from({ length: 8 }, (_, i) => ({
      asset_id: `a${i}`,
      role: "prop" as const,
      url: `u${i}`,
    }));
    assert.throws(
      () => sortReferenceImages(pseudoShot, inputs),
      (err: any) => err instanceof InvalidRefRequestError && /at most 7/.test(err.message),
    );
  });

  it("accepts exactly 3 images", () => {
    const inputs: RefImageInput[] = [
      { asset_id: "a1", role: "character", character_id: "char-A", url: "u1" },
      { asset_id: "a2", role: "scene", url: "u2" },
      { asset_id: "a3", role: "prop", url: "u3" },
    ];
    const sorted = sortReferenceImages(pseudoShot, inputs);
    assert.equal(sorted.length, 3);
  });

  it("accepts exactly 7 images", () => {
    const inputs: RefImageInput[] = [
      { asset_id: "a1", role: "character", character_id: "char-A", url: "u1" },
      { asset_id: "a2", role: "scene", url: "u2" },
      { asset_id: "a3", role: "character", character_id: "char-B", url: "u3" },
      { asset_id: "a4", role: "prop", url: "u4" },
      { asset_id: "a5", role: "prop", url: "u5" },
      { asset_id: "a6", role: "scene", url: "u6" },
      { asset_id: "a7", role: "prop", url: "u7" },
    ];
    const sorted = sortReferenceImages(pseudoShot, inputs);
    assert.equal(sorted.length, 7);
    // Main char first
    assert.match(sorted[0].label, /char-A/);
  });
});

describe("estimateCost", () => {
  it("general 4s = 0.35 CNY", () => {
    const cost = estimateCost("general", 4);
    assert.equal(cost.amount, 0.35);
    assert.equal(cost.currency, "CNY");
    assert.equal(cost.basis, "estimated");
  });

  it("general 8s = 0.70 CNY", () => {
    const cost = estimateCost("general", 8);
    assert.equal(cost.amount, 0.70);
  });

  it("anime 4s = 0.40 CNY", () => {
    const cost = estimateCost("anime", 4);
    assert.equal(cost.amount, 0.40);
  });

  it("anime 8s = 0.80 CNY", () => {
    const cost = estimateCost("anime", 8);
    assert.equal(cost.amount, 0.80);
  });

  it("unknown style falls back to general", () => {
    const cost = estimateCost("unknown", 4);
    assert.equal(cost.amount, 0.35);
  });

  it("unknown duration falls back to 4s rate", () => {
    const cost = estimateCost("general", 16);
    assert.equal(cost.amount, 0.35);
  });
});

describe("ViduRefVideoProvider (async mock)", () => {
  // These tests mock fetch to simulate the async create → poll → download flow

  let fetchCalls: Array<{ url: string; method: string; body?: any }>;
  let mockResponses: Map<string, any>;

  beforeEach(() => {
    fetchCalls = [];
    mockResponses = new Map();
  });

  function setupMockFetch() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      let body: any;
      if (init?.body) {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      fetchCalls.push({ url, method, body });

      // Match create endpoint
      if (url.includes("/reference2video") && method === "POST") {
        return new Response(
          JSON.stringify({
            task_id: "mock-task-001",
            state: "created",
            model: body?.model,
            prompt: body?.prompt,
            images: body?.images,
            duration: body?.duration,
            seed: 0,
            aspect_ratio: body?.aspect_ratio,
            resolution: "720p",
            bgm: false,
            audio: true,
            credits: 0,
            created_at: new Date().toISOString(),
          }),
          { status: 200 },
        );
      }

      // Match query endpoint
      if (url.includes("/tasks/") && url.includes("/creations") && method === "GET") {
        return new Response(
          JSON.stringify({
            id: "mock-task-001",
            state: "success",
            err_code: "",
            credits: 4,
            creations: [
              {
                id: "creation-001",
                url: "https://example.com/video.mp4",
                cover_url: "https://example.com/cover.jpg",
              },
            ],
          }),
          { status: 200 },
        );
      }

      // Match download
      if (url.includes("example.com/video.mp4")) {
        // Return a tiny fake mp4 buffer
        return new Response(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  it("3 reference images → successful async flow", async () => {
    const restore = setupMockFetch();
    try {
      const provider = new ViduRefVideoProvider(makePreset({ model: "viduq3" }), "test-key");
      const req = makeReq({
        reference_images: makeRefImages(3),
        extras: { style: "general" },
      });
      const result = await provider.generate(req, makeCtx());
      assert.equal(result.video.mime, "video/mp4");
      assert.ok(result.video.buffer.length > 0);
      assert.equal(result.video.duration_sec, 4);
      assert.ok(result.cost);
      assert.equal(result.cost!.currency, "CNY");

      // Verify create was called with correct body
      const createCall = fetchCalls.find((c) => c.method === "POST");
      assert.ok(createCall);
      assert.equal(createCall.body.model, "viduq3");
      assert.equal(createCall.body.images.length, 3);
      assert.equal(createCall.body.duration, 4);
      assert.equal(createCall.body.bgm, false);
    } finally {
      restore();
    }
  });

  it("style=anime sets correct body field", async () => {
    const restore = setupMockFetch();
    try {
      const provider = new ViduRefVideoProvider(makePreset({ model: "viduq3" }), "test-key");
      const req = makeReq({
        reference_images: makeRefImages(4),
        extras: { style: "anime" },
      });
      await provider.generate(req, makeCtx());

      const createCall = fetchCalls.find((c) => c.method === "POST");
      assert.ok(createCall);
      assert.equal(createCall.body.style, "anime");
    } finally {
      restore();
    }
  });

  it("cost differs by duration and style", () => {
    const general4 = estimateCost("general", 4);
    const general8 = estimateCost("general", 8);
    const anime4 = estimateCost("anime", 4);
    const anime8 = estimateCost("anime", 8);

    assert.equal(general4.amount, 0.35);
    assert.equal(general8.amount, 0.70);
    assert.equal(anime4.amount, 0.40);
    assert.equal(anime8.amount, 0.80);
    assert.ok(anime4.amount > general4.amount);
    assert.ok(general8.amount > general4.amount);
  });
});
