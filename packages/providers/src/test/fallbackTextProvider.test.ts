/**
 * 验证 FallbackTextProvider 顺序降级的语义:
 *   - 第 1 家成功 → 直接返回, 不试第 2 家
 *   - 第 1 家失败 → 调第 2 家
 *   - 全失败 → 抛出最后一次错误 (留给 agentRunner 接 hardcoded fallback)
 *   - id / label 字段包含链上 provider id
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FallbackTextProvider, type TextLlmProvider } from "../mimo";
import type { ProviderTestResult } from "../mimo";

function makeProvider(id: string, behavior: {
  chatJson?: () => Promise<any>;
  chatText?: () => Promise<string>;
  test?: () => Promise<ProviderTestResult>;
}): TextLlmProvider {
  return {
    id,
    label: id.toUpperCase(),
    chatJson: behavior.chatJson ?? (async () => { throw new Error(`${id}: chatJson not implemented`); }),
    chatText: behavior.chatText ?? (async () => { throw new Error(`${id}: chatText not implemented`); }),
    test: behavior.test ?? (async () => ({ ok: true, provider: id, model: "x", mode: "text", message: "" })),
  };
}

describe("FallbackTextProvider", () => {
  it("第 1 家成功 → 不调第 2 家", async () => {
    let secondCalled = false;
    const chain = new FallbackTextProvider([
      makeProvider("alpha", { chatJson: async () => ({ ok: true, who: "alpha" }) }),
      makeProvider("beta", { chatJson: async () => { secondCalled = true; return { who: "beta" }; } }),
    ]);
    const r = await chain.chatJson<{ who: string }>({ system: "s", user: "u" });
    assert.equal(r.who, "alpha");
    assert.equal(secondCalled, false, "beta 不应该被调用");
  });

  it("第 1 家失败 → 调第 2 家", async () => {
    let secondCalled = false;
    const chain = new FallbackTextProvider([
      makeProvider("alpha", { chatJson: async () => { throw new Error("alpha down"); } }),
      makeProvider("beta", { chatJson: async () => { secondCalled = true; return { who: "beta" }; } }),
    ]);
    const r = await chain.chatJson<{ who: string }>({ system: "s", user: "u" });
    assert.equal(r.who, "beta");
    assert.equal(secondCalled, true);
  });

  it("全部失败 → 抛出最后一次错误", async () => {
    const chain = new FallbackTextProvider([
      makeProvider("alpha", { chatJson: async () => { throw new Error("alpha down"); } }),
      makeProvider("beta", { chatJson: async () => { throw new Error("beta down"); } }),
    ]);
    await assert.rejects(
      async () => chain.chatJson({ system: "s", user: "u" }),
      (err: any) => err instanceof Error && /beta down|All LLM providers/.test(err.message),
    );
  });

  it("chatText 同样顺序降级", async () => {
    const chain = new FallbackTextProvider([
      makeProvider("alpha", { chatText: async () => { throw new Error("nope"); } }),
      makeProvider("beta", { chatText: async () => "beta result" }),
    ]);
    const r = await chain.chatText({ system: "s", user: "u" });
    assert.equal(r, "beta result");
  });

  it("test() 返回第一个 ok 的; 都 not ok 时返最后一次", async () => {
    const chainAllFail = new FallbackTextProvider([
      makeProvider("alpha", { test: async () => ({ ok: false, provider: "alpha", model: "", mode: "text", message: "fail1" }) }),
      makeProvider("beta", { test: async () => ({ ok: false, provider: "beta", model: "", mode: "text", message: "fail2" }) }),
    ]);
    const r1 = await chainAllFail.test();
    assert.equal(r1.ok, false);
    assert.equal(r1.provider, "beta", "should return last attempt when all fail");

    const chainSecondOk = new FallbackTextProvider([
      makeProvider("alpha", { test: async () => ({ ok: false, provider: "alpha", model: "", mode: "text", message: "fail" }) }),
      makeProvider("beta", { test: async () => ({ ok: true, provider: "beta", model: "", mode: "text", message: "ok" }) }),
    ]);
    const r2 = await chainSecondOk.test();
    assert.equal(r2.ok, true);
    assert.equal(r2.provider, "beta");
  });

  it("id / label 反映链上所有 provider", () => {
    const chain = new FallbackTextProvider([
      makeProvider("alpha", {}),
      makeProvider("beta", {}),
      makeProvider("gamma", {}),
    ]);
    assert.match(chain.id, /alpha.*beta.*gamma/);
    assert.match(chain.label, /ALPHA.*BETA.*GAMMA/);
  });

  it("空链 → 构造时抛", () => {
    assert.throws(() => new FallbackTextProvider([]), /至少需要 1 个 provider/);
  });
});
