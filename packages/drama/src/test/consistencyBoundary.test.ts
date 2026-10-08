import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVisionScore, runConsistencyCheck, computeClipSimilarityWithMeta } from "../consistency/consistencyCheck";

test("vision scores reject unrelated numbers, non-finite, empty or malformed responses", () => {
  for (const raw of ["", "compared 2 images", '{"score":"NaN"}', '{"score":1e999}', '{"score":-1}', '{"score":2}', '{"score":"0.8 garbage"}', '{"reason":"85% similar"}']) assert.throws(() => parseVisionScore(raw), raw);
  assert.equal(parseVisionScore('```json\n{"score":0.85}\n```'), 0.85);
});
test("reports do not aggregate different metrics or accept non-finite scores", async () => {
  const assets = ["a", "b", "c"].map(id => ({ id, image_url: id, created_at: "" }));
  let count = 0;
  await assert.rejects(runConsistencyCheck("char", assets, 0.65, async () => ({ similarity: 0.8, method: count++ ? "local_clip" : "gemini_flash" })), { code: "ConsistencyScorerUnavailable" });
  await assert.rejects(runConsistencyCheck("char", assets, 0.65, async () => ({ similarity: NaN, method: "fixture" })), /无效/);
  await assert.rejects(runConsistencyCheck("char", assets, NaN), { status: 400 });
  const report = await runConsistencyCheck("char", []);
  assert.equal(report.status, "insufficient_assets"); assert.equal(report.avg_similarity, null);
});
test("same missing URL is not treated as evidence of identical images", async () => {
  await assert.rejects(computeClipSimilarityWithMeta("missing.png", "missing.png"), { code: "ConsistencyScorerUnavailable" });
  const result = await computeClipSimilarityWithMeta("data:image/png;base64,YQ==", "data:image/png;base64,YQ==");
  assert.equal(result.method, "byte_identical");
});
