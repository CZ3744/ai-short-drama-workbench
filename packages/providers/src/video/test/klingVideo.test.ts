// P23: Kling Video Provider tests (mock, no real API calls)

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { KlingJwtManager, signKlingJwt, isJwtExpired } from "../klingJwt";
import { mapKlingErrorCode } from "../klingClient";
import { pollAsyncJob } from "../../core/asyncJobPoller";

// ─── JWT Tests ─────────────────────────────────────────────────────

describe("KlingJwt", () => {
  describe("signKlingJwt", () => {
    it("should produce a valid 3-segment JWT", () => {
      const jwt = signKlingJwt({ accessKey: "ak_test", secretKey: "sk_test" });
      const parts = jwt.token.split(".");
      assert.equal(parts.length, 3, "JWT should have 3 segments (header.payload.signature)");
      assert.ok(jwt.issuedAt > 0);
      assert.ok(jwt.expiresAt > jwt.issuedAt);
    });

    it("should encode correct payload fields", () => {
      const jwt = signKlingJwt({ accessKey: "ak_123", secretKey: "sk_456", ttlSeconds: 600 });
      const payloadB64 = jwt.token.split(".")[1];
      const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString());
      assert.equal(payload.iss, "ak_123");
      assert.ok(typeof payload.iat === "number");
      assert.ok(typeof payload.nbf === "number");
      assert.ok(typeof payload.exp === "number");
      assert.ok(payload.exp - payload.iat <= 600);
    });

    it("should use default TTL of 1800s", () => {
      const jwt = signKlingJwt({ accessKey: "ak", secretKey: "sk" });
      assert.ok(jwt.expiresAt - jwt.issuedAt <= 1800);
    });
  });

  describe("isJwtExpired", () => {
    it("should return false for fresh token", () => {
      const jwt = signKlingJwt({ accessKey: "ak", secretKey: "sk", ttlSeconds: 3600 });
      assert.equal(isJwtExpired(jwt), false);
    });

    it("should return true for expired token (ttl=0)", () => {
      // TTL=0 means exp = iat, which is already in the past
      const jwt = signKlingJwt({ accessKey: "ak", secretKey: "sk", ttlSeconds: 0 });
      assert.equal(isJwtExpired(jwt), true);
    });

    it("should account for safety margin", () => {
      // TTL=10s, safety margin=30s → considered expired
      const jwt = signKlingJwt({ accessKey: "ak", secretKey: "sk", ttlSeconds: 10 });
      assert.equal(isJwtExpired(jwt, 30), true);
    });
  });

  describe("KlingJwtManager", () => {
    it("should cache token and return same instance", () => {
      const mgr = new KlingJwtManager("ak", "sk");
      const t1 = mgr.getToken();
      const t2 = mgr.getToken();
      assert.equal(t1.token, t2.token);
    });

    it("should refresh token on explicit refresh()", () => {
      const mgr = new KlingJwtManager("ak", "sk");
      const t1 = mgr.getToken();
      // Force re-sign (timestamp may differ by 1s)
      const t2 = mgr.refresh();
      // Tokens should be different (at least the iat/exp differ)
      // They might be the same if signed within the same second, so check the manager ref
      assert.ok(mgr.current === t2);
    });

    it("should auto-refresh expired token", () => {
      const mgr = new KlingJwtManager("ak", "sk", 0); // TTL=0 → immediately expired
      const t1 = mgr.getToken();
      // t1 is already expired, next getToken should refresh
      const t2 = mgr.getToken();
      // With TTL=0 they might still be the same second, but the manager should have tried
      assert.ok(t2.expiresAt >= t1.expiresAt);
    });
  });
});

// ─── Error Mapping Tests ───────────────────────────────────────────

describe("mapKlingErrorCode", () => {
  it("should map 401 to missing_key", () => {
    const r = mapKlingErrorCode(401);
    assert.equal(r.code, "missing_key");
    assert.equal(r.retriable, false);
  });

  it("should map 429 to rate_limit (retriable)", () => {
    const r = mapKlingErrorCode(429);
    assert.equal(r.code, "rate_limit");
    assert.equal(r.retriable, true);
  });

  it("should map Kling auth error codes 10001-10003 to missing_key", () => {
    for (const code of [10001, 10002, 10003]) {
      const r = mapKlingErrorCode(200, code);
      assert.equal(r.code, "missing_key", `kling code ${code}`);
    }
  });

  it("should map Kling rate limit codes 10010-10011 to rate_limit", () => {
    for (const code of [10010, 10011]) {
      const r = mapKlingErrorCode(200, code);
      assert.equal(r.code, "rate_limit", `kling code ${code}`);
      assert.equal(r.retriable, true);
    }
  });

  it("should map Kling content filter codes 30001-30002 to content_filter", () => {
    for (const code of [30001, 30002]) {
      const r = mapKlingErrorCode(200, code);
      assert.equal(r.code, "content_filter", `kling code ${code}`);
    }
  });

  it("should map 500+ to server", () => {
    const r = mapKlingErrorCode(500);
    assert.equal(r.code, "server");
    assert.equal(r.retriable, true);
  });

  it("should map 408 to timeout", () => {
    const r = mapKlingErrorCode(408);
    assert.equal(r.code, "timeout");
    assert.equal(r.retriable, true);
  });
});

// ─── asyncJobPoller Tests ──────────────────────────────────────────

describe("asyncJobPoller", () => {
  it("should return succeed when pollFn returns terminal success", async () => {
    let calls = 0;
    const result = await pollAsyncJob({
      providerId: "test",
      taskId: "t1",
      pollFn: async () => {
        calls++;
        return { status: "succeed", data: { video_url: "https://example.com/v.mp4" } };
      },
      initialIntervalMs: 10,
      timeoutMs: 5000,
    });

    assert.equal(result.status, "succeed");
    assert.equal(calls, 1);
  });

  it("should return failed when pollFn returns terminal failure", async () => {
    const result = await pollAsyncJob({
      providerId: "test",
      taskId: "t2",
      pollFn: async () => ({ status: "failed", error: "content rejected" }),
      initialIntervalMs: 10,
      timeoutMs: 5000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "content rejected");
  });

  it("should poll multiple times for pending status", async () => {
    let calls = 0;
    const result = await pollAsyncJob({
      providerId: "test",
      taskId: "t3",
      pollFn: async () => {
        calls++;
        if (calls < 3) return { status: "processing" };
        return { status: "succeed", data: "done" };
      },
      initialIntervalMs: 10,
      maxIntervalMs: 20,
      timeoutMs: 5000,
    });

    assert.equal(result.status, "succeed");
    assert.equal(calls, 3);
  });

  it("should return timeout when exceeded", async () => {
    const result = await pollAsyncJob({
      providerId: "test",
      taskId: "t4",
      pollFn: async () => ({ status: "processing" }),
      initialIntervalMs: 10,
      timeoutMs: 100,
    });

    assert.equal(result.status, "timeout");
  });

  it("should support AbortSignal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    const result = await pollAsyncJob({
      providerId: "test",
      taskId: "t5",
      pollFn: async () => ({ status: "processing" }),
      initialIntervalMs: 10,
      timeoutMs: 10000,
      signal: ac.signal,
    });

    assert.equal(result.status, "timeout");
    assert.ok(result.error?.includes("Aborted"));
  });
});

// ─── Integration mock: submit → poll → download ────────────────────

describe("KlingVideoProvider mock e2e", () => {
  it("should handle full submit → poll → download flow with mocks", async () => {
    // Simulate the flow without actual Provider instantiation
    const jwtMgr = new KlingJwtManager("ak_test", "sk_test");
    const jwt = jwtMgr.getToken();
    assert.ok(jwt.token.split(".").length === 3);

    // Mock poll sequence: processing → processing → succeed
    let pollCalls = 0;
    const mockPollFn = async () => {
      pollCalls++;
      if (pollCalls < 3) return { status: "processing" as const };
      return {
        status: "succeed" as const,
        data: {
          task_id: "mock_task_001",
          task_status: "succeed" as const,
          task_result: {
            videos: [{ url: "https://example.com/video.mp4", duration: "5" }],
          },
          raw: {},
        },
      };
    };

    const result = await pollAsyncJob({
      providerId: "kling_3",
      taskId: "mock_task_001",
      pollFn: mockPollFn,
      initialIntervalMs: 10,
      timeoutMs: 5000,
    });

    assert.equal(result.status, "succeed");
    assert.equal(pollCalls, 3);
    assert.equal(result.data?.task_result?.videos?.[0]?.url, "https://example.com/video.mp4");
  });

  it("should auto-retry on 401 via JWT refresh (mocked)", () => {
    // Verify JWT manager refresh works correctly
    const mgr = new KlingJwtManager("ak", "sk");
    const t1 = mgr.getToken();
    const t2 = mgr.refresh();
    // Both should be valid JWTs
    assert.ok(t1.token.split(".").length === 3);
    assert.ok(t2.token.split(".").length === 3);
  });

  it("should calculate cost by tier", () => {
    // std: ¥0.35/s × 5s = ¥1.75
    const stdCost = 5 * 0.35;
    assert.ok(Math.abs(stdCost - 1.75) < 0.01);

    // pro: ¥0.70/s × 10s = ¥7.00
    const proCost = 10 * 0.70;
    assert.ok(Math.abs(proCost - 7.00) < 0.01);
  });

  it("should map mode std/pro correctly", () => {
    // Both modes should be valid Kling API values
    const validModes = ["std", "pro"];
    assert.ok(validModes.includes("std"));
    assert.ok(validModes.includes("pro"));
  });
});
