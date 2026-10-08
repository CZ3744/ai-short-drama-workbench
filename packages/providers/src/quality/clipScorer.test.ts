/** 直接测试产品实现，不再把评分算法复制到测试里自测。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseScore, scoreImage } from "./clipScorer";

const config = (key: string, fallback = "") => key === "OPENROUTER_API_KEY" ? "fixture-only" : fallback;
const reply = (content: unknown) => Response.json({ choices: [{ message: { content } }] });

describe("clipScorer", () => {
  const cases: Array<[string, number]> = [
    ['{"score":0.85}', 0.85], ['{"match_score":0.3}', 0.3], ['{"quality":0.92}', 0.92],
    ['{"rating":0.7}', 0.7], ["0.65", 0.65], ["85%", 0.85], ["Score: 0.73", 0.73],
    ["The match is about 45%", 0.45], ["1.5", 1], ["-0.5", 0], ["0", 0],
    ['{"score":"85%"}', 0.85], ['```json\n{"score":0.6}\n```', 0.6],
  ];
  for (const [input, expected] of cases) it(`parses ${input}`, () => assert.equal(parseScore(input), expected));
  for (const input of ["", "no numbers here", "Infinity", "NaN", "HTTP 500", "null", "true", "[]", '{"score":"error 85"}']) {
    it(`does not fabricate a score for ${JSON.stringify(input)}`, () => assert.equal(parseScore(input), undefined));
  }
  it("preserves the existing low-score threshold", () => {
    assert.ok(parseScore("0.21")! < 0.22);
    assert.ok(!(parseScore("0.22")! < 0.22));
  });
  it("does not call any provider without a key", async () => {
    let calls = 0;
    assert.equal(await scoreImage(Buffer.from("fixture"), "prompt", {
      config: () => "", fetcher: async () => { calls++; return reply("0.8"); },
    }), undefined);
    assert.equal(calls, 0);
  });
  it("sends the supplied prompt and image and uses the actual parser", async () => {
    const score = await scoreImage(Buffer.from("fixture"), "中文提示词", { config,
      fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        assert.ok(request.messages[0].content[1].text.includes("中文提示词"));
        assert.ok(request.messages[0].content[0].image_url.url.endsWith(Buffer.from("fixture").toString("base64")));
        return reply('{"score":0.81}');
      },
    });
    assert.equal(score, 0.81);
  });
  it("does not grade HTTP failures or invalid response content as neutral", async () => {
    for (const response of [new Response("error", { status: 500 }), reply("garbage"), reply([]), reply(null)]) {
      assert.equal(await scoreImage(Buffer.alloc(1), "prompt", { config, fetcher: async () => response }), undefined);
    }
  });
  it("does not grade a network failure or cancelled call", async () => {
    assert.equal(await scoreImage(Buffer.alloc(1), "prompt", { config,
      fetcher: async () => { throw new Error("fixture network failure"); },
    }), undefined);
    const controller = new AbortController(); controller.abort();
    assert.equal(await scoreImage(Buffer.alloc(1), "prompt", { config, signal: controller.signal,
      fetcher: async () => { assert.fail("cancelled calls must not reach the provider"); },
    }), undefined);
  });
});
