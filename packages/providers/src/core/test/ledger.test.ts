// P20: CostLedger tests

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CostLedger, paramsDigest, type LedgerEntry } from "../ledger";

function makeEntry(overrides?: Partial<LedgerEntry>): LedgerEntry {
  return {
    at: new Date().toISOString(),
    series_slug: "test-series",
    job_id: "job-1",
    task_id: "task-1",
    kind: "image",
    provider_id: "jimeng_image_4",
    ok: true,
    params_digest: "abc12345",
    cost: { currency: "CNY", amount: 0.12, basis: "measured" },
    duration_ms: 2345,
    ...overrides,
  };
}

describe("CostLedger", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `ledger-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("records and queries entries", async () => {
    const ledger = new CostLedger(tmpDir);
    ledger.record(makeEntry({ series_slug: "s1", provider_id: "p1" }));
    ledger.record(makeEntry({ series_slug: "s2", provider_id: "p2" }));
    await ledger.flush();

    const all = await ledger.query({});
    assert.equal(all.length, 2);
  });

  it("filters by series_slug", async () => {
    const ledger = new CostLedger(tmpDir);
    ledger.record(makeEntry({ series_slug: "s1" }));
    ledger.record(makeEntry({ series_slug: "s2" }));
    ledger.record(makeEntry({ series_slug: "s1" }));
    await ledger.flush();

    const filtered = await ledger.query({ series_slug: "s1" });
    assert.equal(filtered.length, 2);
  });

  it("filters by kind", async () => {
    const ledger = new CostLedger(tmpDir);
    ledger.record(makeEntry({ kind: "image" }));
    ledger.record(makeEntry({ kind: "video" }));
    ledger.record(makeEntry({ kind: "image" }));
    await ledger.flush();

    const filtered = await ledger.query({ kind: "image" });
    assert.equal(filtered.length, 2);
  });

  it("aggregate sums correctly", async () => {
    const ledger = new CostLedger(tmpDir);
    for (let i = 0; i < 100; i++) {
      ledger.record(makeEntry({
        provider_id: i < 60 ? "p1" : "p2",
        cost: { currency: "CNY", amount: i < 60 ? 0.10 : 0.20, basis: "measured" },
      }));
    }
    await ledger.flush();

    const agg = await ledger.aggregate({});
    assert.ok(Math.abs(agg.by_provider["p1"] - 6.0) < 0.001);
    assert.ok(Math.abs(agg.by_provider["p2"] - 8.0) < 0.001);
    assert.ok(Math.abs(agg.total - 14.0) < 0.001);
  });

  it("includes buffered entries in query", async () => {
    const ledger = new CostLedger(tmpDir);
    ledger.record(makeEntry({ series_slug: "buffered" }));
    // Don't flush — should still be in query results
    const all = await ledger.query({});
    assert.equal(all.length, 1);
    assert.equal(all[0].series_slug, "buffered");
  });

  it("handles empty dir gracefully", async () => {
    const emptyDir = path.join(tmpDir, "empty");
    const ledger = new CostLedger(emptyDir);
    const results = await ledger.query({});
    assert.equal(results.length, 0);
    const agg = await ledger.aggregate({});
    assert.equal(agg.total, 0);
  });
});

describe("paramsDigest", () => {
  it("produces consistent output for same input", () => {
    const d1 = paramsDigest({ prompt: "hello", width: 512 });
    const d2 = paramsDigest({ width: 512, prompt: "hello" });
    assert.equal(d1, d2);
  });

  it("produces different output for different input", () => {
    const d1 = paramsDigest({ prompt: "hello" });
    const d2 = paramsDigest({ prompt: "world" });
    assert.notEqual(d1, d2);
  });

  it("returns 8-char string", () => {
    const d = paramsDigest({ a: 1 });
    assert.equal(d.length, 8);
  });
});
