import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PresetOption } from "../../../../core/src/presetSchema";
import type { ProviderContext, VideoGenerateRequest } from "../../core/types";
import { ZhipuCogVideoProvider } from "../zhipuCogVideoProvider";
import { BaiduQianfanVideoProvider } from "../baiduQianfanVideoProvider";
import { TencentHunyuanVideoProvider } from "../tencentHunyuanVideoProvider";

function preset(id: string, overrides?: Record<string, unknown>): PresetOption {
  return {
    id,
    label_zh: id,
    label_en: id,
    prompt_phrase: "",
    enabled: true,
    notes: "",
    default: false,
    base_url: "",
    ...overrides,
  } as PresetOption;
}

function ctx(): ProviderContext {
  return {
    series_slug: "series",
    job_id: "job-1",
    task_id: "task-1",
    log: () => {},
    signal: AbortSignal.timeout(30_000),
  };
}

function req(overrides?: Partial<VideoGenerateRequest>): VideoGenerateRequest {
  return {
    prompt: "a young detective walks through a rainy neon alley",
    duration_sec: 5,
    aspect_ratio: "16:9",
    ...overrides,
  };
}

async function withFetchMock(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function mp4Response(): Response {
  return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), {
    status: 200,
    headers: { "Content-Type": "video/mp4" },
  });
}

function timeoutError(): Error {
  const err = new Error("operation timed out");
  err.name = "TimeoutError";
  return err;
}

describe("ZhipuCogVideoProvider", () => {
  it("simulates successful submit, poll, and download", async () => {
    await withFetchMock(async (input, init) => {
      const url = String(input);
      if (url.includes("/videos/generations")) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "cogvideox-3");
        return new Response(JSON.stringify({ id: "zhipu-task-1", task_status: "PROCESSING" }), { status: 200 });
      }
      if (url.includes("/async-result/")) {
        return new Response(JSON.stringify({ task_status: "SUCCESS", video_result: [{ url: "https://example.com/z.mp4" }] }), { status: 200 });
      }
      if (url.includes("example.com/z.mp4")) return mp4Response();
      return new Response("not found", { status: 404 });
    }, async () => {
      const provider = new ZhipuCogVideoProvider(preset("zhipu_cogvideox", { model_id: "cogvideox-3", base_url: "https://open.bigmodel.cn" }), "test-key");
      const result = await provider.generate(req(), ctx());
      assert.equal(result.video.mime, "video/mp4");
      assert.ok(result.video.buffer.length > 0);
      assert.equal(result.video.width, 1920);
    });
  });

  it("maps rate limit to rate_limit", async () => {
    await withFetchMock(async () => new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 }), async () => {
      const provider = new ZhipuCogVideoProvider(preset("zhipu_cogvideox"), "test-key");
      const err = await provider.generate(req(), ctx()).then(() => null, (e) => e);
      assert.equal(err.code, "rate_limit");
    });
  });

  it("maps quota rejection to quota_exceeded", async () => {
    await withFetchMock(async () => new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 402 }), async () => {
      const provider = new ZhipuCogVideoProvider(preset("zhipu_cogvideox"), "test-key");
      const err = await provider.generate(req(), ctx()).then(() => null, (e) => e);
      assert.equal(err.code, "quota_exceeded");
    });
  });

  it("maps timeout to timeout", async () => {
    await withFetchMock(async () => { throw timeoutError(); }, async () => {
      const provider = new ZhipuCogVideoProvider(preset("zhipu_cogvideox"), "test-key");
      const err = await provider.generate(req(), ctx()).then(() => null, (e) => e);
      assert.equal(err.code, "timeout");
    });
  });
});

describe("BaiduQianfanVideoProvider", () => {
  it("simulates successful submit, poll, and download", async () => {
    await withFetchMock(async (input, init) => {
      const url = String(input);
      if (url.includes("/beta/video/generations/qianfan-video") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.model, "VQ3-Pro");
        assert.equal(body.model_parameters.aspect_ratio, "16:9");
        return new Response(JSON.stringify({ task_id: "baidu-task-1", status: "created" }), { status: 200 });
      }
      if (url.includes("task_id=baidu-task-1")) {
        return new Response(JSON.stringify({ status: "success", creations: [{ url: "https://example.com/b.mp4" }] }), { status: 200 });
      }
      if (url.includes("example.com/b.mp4")) return mp4Response();
      return new Response("not found", { status: 404 });
    }, async () => {
      const provider = new BaiduQianfanVideoProvider(preset("baidu_qianfan_video", { model_id: "VQ3-Pro", base_url: "https://qianfan.baidubce.com" }), "test-key");
      const result = await provider.generate(req(), ctx());
      assert.equal(result.video.mime, "video/mp4");
      assert.ok(result.video.buffer.length > 0);
      assert.equal(result.video.height, 1080);
    });
  });

  it("maps rate limit to rate_limit", async () => {
    await withFetchMock(async () => new Response(JSON.stringify({ err_msg: "rate limit" }), { status: 429 }), async () => {
      const provider = new BaiduQianfanVideoProvider(preset("baidu_qianfan_video"), "test-key");
      const err = await provider.generate(req(), ctx()).then(() => null, (e) => e);
      assert.equal(err.code, "rate_limit");
    });
  });

  it("maps quota rejection to quota_exceeded", async () => {
    await withFetchMock(async () => new Response(JSON.stringify({ err_msg: "insufficient quota" }), { status: 402 }), async () => {
      const provider = new BaiduQianfanVideoProvider(preset("baidu_qianfan_video"), "test-key");
      const err = await provider.generate(req(), ctx()).then(() => null, (e) => e);
      assert.equal(err.code, "quota_exceeded");
    });
  });

  it("maps timeout to timeout", async () => {
    await withFetchMock(async () => { throw timeoutError(); }, async () => {
      const provider = new BaiduQianfanVideoProvider(preset("baidu_qianfan_video"), "test-key");
      const err = await provider.generate(req(), ctx()).then(() => null, (e) => e);
      assert.equal(err.code, "timeout");
    });
  });
});

describe("TencentHunyuanVideoProvider", () => {
  const keyJson = JSON.stringify({ secret_id: "sid", secret_key: "skey", region: "ap-guangzhou" });

  it("simulates successful submit, poll, and download", async () => {
    await withFetchMock(async (input, init) => {
      const url = String(input);
      assert.ok(url.includes("tencentcloudapi.com") || url.includes("example.com"));
      const action = new Headers(init?.headers).get("X-TC-Action");
      if (action === "SubmitHunyuanToVideoJob") {
        return new Response(JSON.stringify({ Response: { JobId: "tx-job-1", RequestId: "r1" } }), { status: 200 });
      }
      if (action === "DescribeHunyuanToVideoJob") {
        return new Response(JSON.stringify({ Response: { Status: "DONE", ResultVideoUrl: "https://example.com/t.mp4", RequestId: "r2" } }), { status: 200 });
      }
      if (url.includes("example.com/t.mp4")) return mp4Response();
      return new Response("not found", { status: 404 });
    }, async () => {
      const provider = new TencentHunyuanVideoProvider(preset("tencent_hunyuan_video", { base_url: "https://vclm.tencentcloudapi.com" }), keyJson);
      const result = await provider.generate(req(), ctx());
      assert.equal(result.video.mime, "video/mp4");
      assert.ok(result.video.buffer.length > 0);
      assert.equal(result.video.width, 1920);
    });
  });

  it("maps rate limit to rate_limit", async () => {
    await withFetchMock(async () => new Response(JSON.stringify({ Response: { Error: { Code: "RequestLimitExceeded", Message: "rate limit" } } }), { status: 200 }), async () => {
      const provider = new TencentHunyuanVideoProvider(preset("tencent_hunyuan_video"), keyJson);
      const err = await provider.generate(req(), ctx()).then(() => null, (e) => e);
      assert.equal(err.code, "rate_limit");
    });
  });

  it("maps quota rejection to quota_exceeded", async () => {
    await withFetchMock(async () => new Response(JSON.stringify({ Response: { Error: { Code: "ResourceInsufficient", Message: "insufficient balance" } } }), { status: 200 }), async () => {
      const provider = new TencentHunyuanVideoProvider(preset("tencent_hunyuan_video"), keyJson);
      const err = await provider.generate(req(), ctx()).then(() => null, (e) => e);
      assert.equal(err.code, "quota_exceeded");
    });
  });

  it("maps timeout to timeout", async () => {
    await withFetchMock(async () => { throw timeoutError(); }, async () => {
      const provider = new TencentHunyuanVideoProvider(preset("tencent_hunyuan_video"), keyJson);
      const err = await provider.generate(req(), ctx()).then(() => null, (e) => e);
      assert.equal(err.code, "timeout");
    });
  });
});
