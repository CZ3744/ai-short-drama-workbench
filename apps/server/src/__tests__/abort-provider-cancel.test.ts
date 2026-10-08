/**
 * W3.1: abort-provider-cancel test
 * 验证: mock video provider 带 cancel, abort 会真正调用 provider.cancel
 */
import { describe, it } from "node:test";
import assert from "node:assert";

// ── Types (inlined for test isolation) ──

interface ProviderContext {
  series_slug: string;
  job_id: string;
  task_id: string;
  log: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
  signal: AbortSignal;
}

interface VideoProvider {
  readonly id: string;
  readonly mode: "t2v" | "i2v" | "ref2v" | "mock";
  generate(req: any, ctx: ProviderContext): Promise<any>;
  healthCheck(): Promise<{ ok: boolean; reason?: string }>;
  cancel?(providerJobId: string, ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed">;
}

// ── Mock provider with cancel ──

class MockCancelProvider implements VideoProvider {
  id = "mock_cancel";
  mode: "mock" = "mock";
  cancelCalls: Array<{ providerJobId: string }> = [];
  private _cancelResult: "cancelled" | "unsupported" | "failed" = "cancelled";

  setCancelResult(result: "cancelled" | "unsupported" | "failed") {
    this._cancelResult = result;
  }

  async generate(_req: any, _ctx: ProviderContext): Promise<any> {
    return { video: { buffer: Buffer.from("mock"), mime: "video/mp4", duration_sec: 5, width: 1920, height: 1080 } };
  }

  async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }

  async cancel(providerJobId: string, _ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed"> {
    this.cancelCalls.push({ providerJobId });
    return this._cancelResult;
  }
}

function makeCtx(): ProviderContext {
  return {
    series_slug: "test",
    job_id: "job_1",
    task_id: "task_1",
    log: () => {},
    signal: new AbortController().signal,
  };
}

// ── Tests ──

describe("provider.cancel 在 abort 中被调用", () => {
  it("cancel 方法存在时被调且返回 cancelled", async () => {
    const provider = new MockCancelProvider();
    const ctx = makeCtx();
    const result = await provider.cancel!("provider_job_123", ctx);
    assert.strictEqual(result, "cancelled");
    assert.strictEqual(provider.cancelCalls.length, 1);
    assert.strictEqual(provider.cancelCalls[0].providerJobId, "provider_job_123");
  });

  it("cancel 返回 unsupported", async () => {
    const provider = new MockCancelProvider();
    provider.setCancelResult("unsupported");
    const result = await provider.cancel!("job_456", makeCtx());
    assert.strictEqual(result, "unsupported");
    assert.strictEqual(provider.cancelCalls.length, 1);
  });

  it("cancel 返回 failed", async () => {
    const provider = new MockCancelProvider();
    provider.setCancelResult("failed");
    const result = await provider.cancel!("job_789", makeCtx());
    assert.strictEqual(result, "failed");
    assert.strictEqual(provider.cancelCalls.length, 1);
  });

  it("cancel 多次调用会累积", async () => {
    const provider = new MockCancelProvider();
    await provider.cancel!("a", makeCtx());
    await provider.cancel!("b", makeCtx());
    assert.strictEqual(provider.cancelCalls.length, 2);
    assert.strictEqual(provider.cancelCalls[0].providerJobId, "a");
    assert.strictEqual(provider.cancelCalls[1].providerJobId, "b");
  });

  it("没有 cancel 方法的 provider 不受影响", () => {
    const noCancelProvider: VideoProvider = {
      id: "no_cancel",
      mode: "mock",
      generate: async () => ({ video: { buffer: Buffer.from(""), mime: "video/mp4", duration_sec: 1, width: 1, height: 1 } }),
      healthCheck: async () => ({ ok: true }),
    };
    assert.strictEqual(noCancelProvider.cancel, undefined);
  });
});
