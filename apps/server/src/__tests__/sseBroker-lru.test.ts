// V7: sseBroker LRU correctness test
// 验证: 连续 emit 101 个不同 jobId，_jobRings.size <= 100 且最旧的被淘汰

import { describe, it } from "node:test";
import assert from "node:assert";

// Directly import the SseBroker class for isolated testing
// We need to access internals, so we use a dynamic import

describe("sseBroker LRU eviction", () => {
  it("keeps at most MAX_JOB_RINGS (100) after 101 distinct jobIds", async () => {
    // Create a fresh isolated broker for testing
    const { sseBroker } = await import("../api/v2/sseBroker");

    // Access private members for verification
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试访问 _jobRings 等私有字段验证 LRU eviction
    const broker = sseBroker as any;

    // Emit 101 events with distinct job_ids
    for (let i = 1; i <= 101; i++) {
      broker.emit({
        type: "task.queued",
        job_id: `test-job-${i}`,
        data: { n: i },
        at: new Date().toISOString(),
      });
    }

    // Verify ring count <= 100
    assert.ok(
      broker._jobRings.size <= 100,
      `_jobRings.size ${broker._jobRings.size} should be <= 100`
    );

    // The first job (test-job-1) should have been evicted (oldest)
    assert.strictEqual(
      broker._jobRings.has("test-job-1"),
      false,
      "oldest job ring (test-job-1) should be evicted"
    );

    // The last job (test-job-101) should still be present
    assert.strictEqual(
      broker._jobRings.has("test-job-101"),
      true,
      "newest job ring (test-job-101) should be present"
    );

    console.log(`LRU eviction verified: ${broker._jobRings.size} rings (max 100)`);
  });

  it("per-job rings evict oldest entries when exceeding MAX_JOB_RING_SIZE", async () => {
    const { sseBroker } = await import("../api/v2/sseBroker");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试访问 _jobRings 等私有字段验证 LRU eviction
    const broker = sseBroker as any;

    const jobId = "test-ring-overflow";
    for (let i = 1; i <= 1100; i++) {
      broker.emit({
        type: "shot.updated",
        job_id: jobId,
        data: { seq: i },
        at: new Date().toISOString(),
      });
    }

    const ring = broker._jobRings.get(jobId);
    assert.ok(ring, "ring should exist");
    assert.ok(
      ring.length <= 1000,
      `ring length ${ring.length} should be <= 1000`
    );

    // The oldest entries should have been evicted
    assert.ok(ring[0].event.data.seq > 1, "oldest entries evicted from ring");

    console.log(`Per-job ring size verified: ${ring.length} (max 1000)`);
  });
});
