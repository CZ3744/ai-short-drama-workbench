/**
 * Wave 2C — CLIP 一致性检查 单元测试
 *
 * 运行:
 *   cd C:/Projects/video-studio/myapp/video-generate
 *   npx tsx --test packages/drama/src/test/consistencyCheck.test.ts
 *
 * 所有 LLM API 调用通过 mock 实现, 不产生真实 API 调用。
 * 总真实 API 调用 <= 0 CNY。
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

// ── Mock fetch BEFORE importing the module ──
// The mock is installed at the module level via a helper.

const ORIGINAL_FETCH = globalThis.fetch;

let mockFetchImpl: typeof fetch | null = null;

function installMockFetch(impl: typeof fetch) {
  mockFetchImpl = impl;
  globalThis.fetch = impl;
}

function restoreFetch() {
  globalThis.fetch = ORIGINAL_FETCH;
  mockFetchImpl = null;
}

// ── Helpers ──

import { parseVisionScore as parseScoreForTest } from "../consistency/consistencyCheck";

// ── Tests ──

describe("consistencyCheck — Wave 2C", () => {
  // ── 1. parseVisionScore (内联逻辑) ──

  describe("parseVisionScore", () => {
    it("parses JSON {score: 0.85}", () => {
      assert.equal(parseScoreForTest('{"score": 0.85}'), 0.85);
    });

    it("parses JSON {score: 0.85, is_same_character: true}", () => {
      assert.equal(
        parseScoreForTest('{"score":0.85,"is_same_character":true,"is_same_scene":false,"reason":"same girl diff pose"}'),
        0.85,
      );
    });

    it("parses JSON {similarity: 0.72}", () => {
      assert.equal(parseScoreForTest('{"similarity": 0.72}'), 0.72);
    });

    it("parses JSON {match_score: 0.3}", () => {
      assert.equal(parseScoreForTest('{"match_score": 0.3}'), 0.3);
    });

    it("parses bare number 0.77", () => {
      assert.equal(parseScoreForTest("0.77"), 0.77);
    });

    it("parses percentage 92% → 0.92", () => {
      assert.equal(parseScoreForTest("92%"), 0.92);
    });

    it("rejects empty input", () => {
      assert.throws(() => parseScoreForTest(""));
    });

    it("rejects garbage text", () => {
      assert.throws(() => parseScoreForTest("I think these are the same"));
    });

    it("rejects scores above one", () => {
      assert.throws(() => parseScoreForTest("1.5"));
      assert.throws(() => parseScoreForTest('{"score": 2.0}'));
    });

    it("rejects negative scores", () => {
      assert.throws(() => parseScoreForTest("-0.5"));
    });

    it("rejects Infinity", () => {
      assert.throws(() => parseScoreForTest("Infinity"));
    });
  });

  // ── 2. computeClipSimilarityWithMeta — fallback_fake ──

  describe("computeClipSimilarityWithMeta (fallback_fake)", () => {
    let computeClipSimilarityWithMeta: typeof import("../consistency/consistencyCheck").computeClipSimilarityWithMeta;

    before(async () => {
      // Import after mocking fetch to force gemini_flash to fail
      // We mock getConfigValue by setting env var and making fetch throw
      process.env.CONSISTENCY_SCORER_PROVIDER = "gemini_flash";
      // No OPENROUTER_API_KEY → will throw → fallback
      delete process.env.OPENROUTER_API_KEY;
      const mod = await import("../consistency/consistencyCheck");
      computeClipSimilarityWithMeta = mod.computeClipSimilarityWithMeta;
    });

    after(() => {
      delete process.env.CONSISTENCY_SCORER_PROVIDER;
    });

    it("reports unavailable instead of inventing a score when no API is configured", async () => {
      await assert.rejects(() => computeClipSimilarityWithMeta(
        "https://example.com/img/a.png", "https://example.com/img/b.png",
      ), { code: "ConsistencyScorerUnavailable" });
    });

    it("returns 1.0 with method identical for same images", async () => {
      const result = await computeClipSimilarityWithMeta(
        "data:image/png;base64,YQ==",
        "data:image/png;base64,YQ==",
      );
      assert.equal(result.similarity, 1.0);
      assert.equal(result.method, "byte_identical");
    });

    it("repeated unavailable requests never invent a deterministic score", async () => {
      const a = "https://example.com/img/x.png";
      const b = "https://example.com/img/y.png";
      await assert.rejects(() => computeClipSimilarityWithMeta(a, b), { code: "ConsistencyScorerUnavailable" });
      await assert.rejects(() => computeClipSimilarityWithMeta(a, b), { code: "ConsistencyScorerUnavailable" });
    });
  });

  // ── 3. computeClipSimilarityWithMeta — gemini_flash mock ──

  describe("computeClipSimilarityWithMeta (gemini_flash mock)", () => {
    let computeClipSimilarityWithMeta: typeof import("../consistency/consistencyCheck").computeClipSimilarityWithMeta;

    before(async () => {
      // Set env so local-settings returns the key (our mock will handle fetch)
      process.env.OPENROUTER_API_KEY = "sk-test-mock-key";
      process.env.CONSISTENCY_SCORER_PROVIDER = "gemini_flash";

      // Mock fetch to return a fake LLM response
      installMockFetch((async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"score":0.87,"is_same_character":true,"is_same_scene":false,"reason":"same character, different background"}',
                },
              },
            ],
            usage: { prompt_tokens: 400, completion_tokens: 30 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch);

      const mod = await import("../consistency/consistencyCheck");
      computeClipSimilarityWithMeta = mod.computeClipSimilarityWithMeta;
    });

    after(() => {
      restoreFetch();
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.CONSISTENCY_SCORER_PROVIDER;
    });

    it("returns gemini_flash score from mocked API", async () => {
      const result = await computeClipSimilarityWithMeta(
        "https://example.com/img/char1.png",
        "https://example.com/img/char2.png",
      );
      assert.equal(result.similarity, 0.87);
      assert.equal(result.method, "gemini_flash");
    });

    it("handles low similarity response", async () => {
      installMockFetch((async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"score":0.15,"is_same_character":false,"is_same_scene":false,"reason":"completely different"}',
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch);

      const result = await computeClipSimilarityWithMeta("https://example.com/a.png", "https://example.com/b.png");
      assert.equal(result.similarity, 0.15);
      assert.equal(result.method, "gemini_flash");
    });

    it("reports unavailable when API returns HTTP 500", async () => {
      installMockFetch((async () => {
        return new Response("Internal Server Error", { status: 500 });
      }) as typeof fetch);

      await assert.rejects(() => computeClipSimilarityWithMeta("https://example.com/x.png", "https://example.com/y.png"), { code: "ConsistencyScorerUnavailable" });
    });

    it("reports unavailable when API throws network error", async () => {
      installMockFetch((async () => {
        throw new Error("NetworkError: fetch failed");
      }) as typeof fetch);

      await assert.rejects(() => computeClipSimilarityWithMeta("https://example.com/x.png", "https://example.com/y.png"), { code: "ConsistencyScorerUnavailable" });
    });
  });

  // ── 4. computePairwiseSimilarities ──

  describe("computePairwiseSimilarities", () => {
    let computePairwiseSimilarities: typeof import("../consistency/consistencyCheck").computePairwiseSimilarities;

    before(async () => {
      process.env.CONSISTENCY_SCORER_PROVIDER = "gemini_flash";

      // Mock fetch returns score=0.9
      installMockFetch((async () => {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"score":0.9}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch);

      process.env.OPENROUTER_API_KEY = "sk-test-mock";
      const mod = await import("../consistency/consistencyCheck");
      computePairwiseSimilarities = mod.computePairwiseSimilarities;
    });

    after(() => {
      restoreFetch();
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.CONSISTENCY_SCORER_PROVIDER;
    });

    it("returns n*(n-1)/2 pairs for n assets", async () => {
      const assets = [
        { id: "a1", image_url: "https://example.com/a1.png", created_at: "2025-01-01T00:00:00Z" },
        { id: "a2", image_url: "https://example.com/a2.png", created_at: "2025-01-02T00:00:00Z" },
        { id: "a3", image_url: "https://example.com/a3.png", created_at: "2025-01-03T00:00:00Z" },
        { id: "a4", image_url: "https://example.com/a4.png", created_at: "2025-01-04T00:00:00Z" },
      ];
      const pairs = await computePairwiseSimilarities(assets);
      assert.equal(pairs.length, 6); // 4*3/2 = 6
    });

    it("each pair has method field", async () => {
      const assets = [
        { id: "x", image_url: "https://example.com/x.png", created_at: "2025-01-01T00:00:00Z" },
        { id: "y", image_url: "https://example.com/y.png", created_at: "2025-01-01T00:00:00Z" },
      ];
      const pairs = await computePairwiseSimilarities(assets);
      assert.equal(pairs.length, 1);
      assert.ok(typeof pairs[0].method === "string");
      assert.ok(pairs[0].method.length > 0);
    });

    it("each pair has correct asset ids", async () => {
      const assets = [
        { id: "alpha", image_url: "https://example.com/a.png", created_at: "2025-01-01T00:00:00Z" },
        { id: "beta", image_url: "https://example.com/b.png", created_at: "2025-01-01T00:00:00Z" },
      ];
      const pairs = await computePairwiseSimilarities(assets);
      assert.equal(pairs[0].asset_a_id, "alpha");
      assert.equal(pairs[0].asset_b_id, "beta");
    });

    it("returns empty array for 0-1 assets", async () => {
      assert.deepEqual(await computePairwiseSimilarities([]), []);
      assert.deepEqual(
        await computePairwiseSimilarities([
          { id: "solo", image_url: "solo.png", created_at: "2025-01-01T00:00:00Z" },
        ]),
        [],
      );
    });
  });

  // ── 5. computeClipSimilarity (backward compat) ──

  describe("computeClipSimilarity (backward compat)", () => {
    let computeClipSimilarity: typeof import("../consistency/consistencyCheck").computeClipSimilarity;

    before(async () => {
      process.env.CONSISTENCY_SCORER_PROVIDER = "gemini_flash";
      delete process.env.OPENROUTER_API_KEY;
      const mod = await import("../consistency/consistencyCheck");
      computeClipSimilarity = mod.computeClipSimilarity;
    });

    after(() => {
      delete process.env.CONSISTENCY_SCORER_PROVIDER;
    });

    it("the numeric wrapper rejects an unavailable scorer", async () => {
      await assert.rejects(() => computeClipSimilarity("https://example.com/a.png", "https://example.com/b.png"), { code: "ConsistencyScorerUnavailable" });
    });

    it("returns 1.0 for identical images", async () => {
      const score = await computeClipSimilarity("data:image/png;base64,YQ==", "data:image/png;base64,YQ==");
      assert.equal(score, 1.0);
    });
  });

  // ── 6. runConsistencyCheck ──

  describe("runConsistencyCheck", () => {
    let runConsistencyCheck: typeof import("../consistency/consistencyCheck").runConsistencyCheck;
    const scorer = async () => ({ similarity: 0.8, method: "fixture" });

    before(async () => {
      process.env.CONSISTENCY_SCORER_PROVIDER = "gemini_flash";
      delete process.env.OPENROUTER_API_KEY;
      const mod = await import("../consistency/consistencyCheck");
      runConsistencyCheck = mod.runConsistencyCheck;
    });

    after(() => {
      delete process.env.CONSISTENCY_SCORER_PROVIDER;
    });

    it("handles <2 assets gracefully", async () => {
      const report = await runConsistencyCheck("char_1", [
        { id: "only", image_url: "only.png", created_at: "2025-01-01T00:00:00Z" },
      ]);
      assert.equal(report.total_assets, 1);
      assert.equal(report.avg_similarity, null);
      assert.equal(report.pairs.length, 0);
      assert.equal(report.drift_warnings.length, 0);
      assert.equal(report.lora_recommendation?.should_train, false);
    });

    it("generates complete report for 3 assets", async () => {
      const assets = [
        { id: "c1", image_url: "c1.png", created_at: "2025-01-01T00:00:00Z" },
        { id: "c2", image_url: "c2.png", created_at: "2025-01-02T00:00:00Z" },
        { id: "c3", image_url: "c3.png", created_at: "2025-01-03T00:00:00Z" },
      ];
      const report = await runConsistencyCheck("char_test", assets, undefined, scorer);

      assert.equal(report.character_id, "char_test");
      assert.equal(report.total_assets, 3);
      assert.equal(report.pairs.length, 3); // 3*2/2
      assert.ok(typeof report.avg_similarity === "number");
      assert.ok(typeof report.min_similarity === "number");
      assert.ok(typeof report.max_similarity === "number");
      assert.ok(report.avg_similarity >= 0 && report.avg_similarity <= 1);
      assert.equal(report.drift_threshold, 0.65);
    });

    it("scatter_data has same length as pairs", async () => {
      const assets = [
        { id: "d1", image_url: "d1.png", created_at: "2025-01-01T00:00:00Z" },
        { id: "d2", image_url: "d2.png", created_at: "2025-01-02T00:00:00Z" },
        { id: "d3", image_url: "d3.png", created_at: "2025-01-03T00:00:00Z" },
      ];
      const report = await runConsistencyCheck("char_scatter", assets, undefined, scorer);
      assert.equal(report.scatter_data.length, report.pairs.length);
      if (report.scatter_data.length > 0) {
        assert.ok(typeof report.scatter_data[0].value === "number");
        assert.ok(typeof report.scatter_data[0].is_drift === "boolean");
      }
    });

    it("respects custom drift threshold", async () => {
      const assets = [
        { id: "t1", image_url: "t1.png", created_at: "2025-01-01T00:00:00Z" },
        { id: "t2", image_url: "t2.png", created_at: "2025-01-02T00:00:00Z" },
      ];
      const report = await runConsistencyCheck("char_thresh", assets, 0.5, scorer);
      assert.equal(report.drift_threshold, 0.5);
    });

    it("pairs identify the injected scorer instead of a fabricated hash", async () => {
      // 报告测试注入确定的评分结果，不依赖真实 API 或工作站设置。
      const assets = [
        { id: "m1", image_url: "m1.png", created_at: "2025-01-01T00:00:00Z" },
        { id: "m2", image_url: "m2.png", created_at: "2025-01-02T00:00:00Z" },
      ];
      const report = await runConsistencyCheck("char_method", assets, undefined, scorer);
      assert.ok(report.pairs.length > 0);
      for (const pair of report.pairs) {
        assert.equal(pair.method, "fixture");
      }
    });
  });

  // ── 7. trainCharacterLoRA (v2 placeholder) ──

  describe("trainCharacterLoRA", () => {
    it("returns placeholder result", async () => {
      const { trainCharacterLoRA } = await import("../consistency/consistencyCheck");
      const result = await trainCharacterLoRA("test_char", ["img1.png"]);
      assert.equal(result.success, false);
      assert.equal(result.lora_path, null);
      assert.ok(result.message.includes("v2"));
    });
  });
});
