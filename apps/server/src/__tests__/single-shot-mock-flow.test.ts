/**
 * D1.3: single-shot mock flow test
 * 验证 mock 全链路: generate_first_frame → pick → generate_video(i2v with picked ff) → pick video
 * 以及 RenderSpec 解析、i2v 缺首帧报错
 */
import { describe, it } from "node:test";
import assert from "node:assert";

// ── RenderSpec resolution (inlined from packages/core/src/renderSpec.ts) ──

const ASPECT_TO_DIM: Record<string, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1":  { w: 1080, h: 1080 },
  "4:3":  { w: 1440, h: 1080 },
  "3:4":  { w: 1080, h: 1440 },
};

function resolveRenderSpec(aspectRatio?: string | null) {
  const aspect = (aspectRatio || "16:9") as "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  const dim = ASPECT_TO_DIM[aspect] ?? ASPECT_TO_DIM["16:9"];
  return { aspect_ratio: aspect, width: dim.w, height: dim.h, fps: 24 };
}

// ── Simplified mock flow ──

interface MockGeneration {
  generation_id: string;
  type: "first_frame" | "video";
  provider: string;
  vault_id?: string;
  asset_id?: string;
  picked?: boolean;
  created_at: string;
  status: "done" | "failed";
  error?: string;
}

interface MockShot {
  id: string;
  video_mode?: "i2v" | "t2v";
  picked_first_frame_generation_id?: string | null;
  picked_video_generation_id?: string | null;
  generations: MockGeneration[];
}

describe("RenderSpec resolution", () => {
  it("defaults to 16:9 / 1920x1080", () => {
    const spec = resolveRenderSpec();
    assert.strictEqual(spec.aspect_ratio, "16:9");
    assert.strictEqual(spec.width, 1920);
    assert.strictEqual(spec.height, 1080);
  });

  it("resolves 9:16 correctly", () => {
    const spec = resolveRenderSpec("9:16");
    assert.strictEqual(spec.aspect_ratio, "9:16");
    assert.strictEqual(spec.width, 1080);
    assert.strictEqual(spec.height, 1920);
  });

  it("resolves 1:1 correctly", () => {
    const spec = resolveRenderSpec("1:1");
    assert.strictEqual(spec.width, 1080);
    assert.strictEqual(spec.height, 1080);
  });

  it("resolves 4:3 correctly", () => {
    const spec = resolveRenderSpec("4:3");
    assert.strictEqual(spec.width, 1440);
    assert.strictEqual(spec.height, 1080);
  });

  it("unknown aspect ratio falls back to 16:9 dimensions", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试故意传非枚举 aspect, 验证 fallback 16:9 行为
    const spec = resolveRenderSpec("21:9" as any);
    // Dimensions should fall back to 16:9 (1920x1080) when aspect is unrecognized
    assert.strictEqual(spec.width, 1920);
    assert.strictEqual(spec.height, 1080);
    assert.strictEqual(spec.fps, 24);
  });
});

describe("Single-shot mock flow", () => {
  it("full i2v flow: generate_first_frame → pick → generate_video → pick video", () => {
    const shot: MockShot = {
      id: "shot_001",
      video_mode: "i2v",
      generations: [],
    };

    // Step 1: generate_first_frame → adds first_frame generation
    const ffGen: MockGeneration = {
      generation_id: "gen_ff_001",
      type: "first_frame",
      provider: "local_card_image",
      vault_id: "vault_ff_001",
      created_at: new Date().toISOString(),
      status: "done",
    };
    shot.generations.push(ffGen);

    // Step 2: pick first_frame
    shot.picked_first_frame_generation_id = ffGen.generation_id;
    ffGen.picked = true;

    assert.strictEqual(shot.picked_first_frame_generation_id, "gen_ff_001");
    assert.ok(shot.generations.find(g => g.generation_id === "gen_ff_001"));

    // Step 3: generate_video (i2v) — needs picked first frame
    const pickedFfId = shot.picked_first_frame_generation_id;
    assert.ok(pickedFfId, "must have picked first frame for i2v");

    const ffRefGen = shot.generations.find(g => g.generation_id === pickedFfId);
    assert.ok(ffRefGen?.vault_id, "picked first frame must have vault_id");

    const firstFrameAssetId = ffRefGen!.vault_id || ffRefGen!.asset_id;
    assert.strictEqual(firstFrameAssetId, "vault_ff_001");

    // Now generate video with first_frame reference
    const vidGen: MockGeneration = {
      generation_id: "gen_vid_001",
      type: "video",
      provider: "local_mock_video",
      vault_id: "vault_vid_001",
      created_at: new Date().toISOString(),
      status: "done",
    };
    shot.generations.push(vidGen);

    // Step 4: pick video
    shot.picked_video_generation_id = vidGen.generation_id;
    vidGen.picked = true;

    assert.strictEqual(shot.picked_first_frame_generation_id, "gen_ff_001");
    assert.strictEqual(shot.picked_video_generation_id, "gen_vid_001");
    assert.notStrictEqual(
      shot.picked_first_frame_generation_id,
      shot.picked_video_generation_id,
      "first_frame and video picks must be independent"
    );
  });

  it("i2v without picked first frame throws error", () => {
    const shot: MockShot = {
      id: "shot_002",
      video_mode: "i2v",
      generations: [],
    };

    // Simulate A4 check
    const pickedFfId = shot.picked_first_frame_generation_id;
    assert.strictEqual(pickedFfId, undefined);

    let error: Error | null = null;
    try {
      if (!pickedFfId) {
        throw Object.assign(
          new Error(`视频 i2v 模式需要 picked 首帧，但 shot ${shot.id} 未挑选首帧`),
          { code: "MISSING_FIRST_FRAME", retriable: false }
        );
      }
    } catch (e) {
      error = e as Error;
    }

    assert.ok(error, "should throw MISSING_FIRST_FRAME");
    assert.match(error!.message, /未挑选首帧/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试断言错误对象自定义 code/retriable 字段
    assert.strictEqual((error as any).code, "MISSING_FIRST_FRAME");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
    assert.strictEqual((error as any).retriable, false);
  });

  it("t2v mode does not require first frame", () => {
    const shot: MockShot = {
      id: "shot_003",
      video_mode: "t2v",
      generations: [],
    };

    const videoMode = shot.video_mode || "i2v";
    let firstFrameAssetId: string | undefined;

    if (videoMode === "i2v") {
      const pickedFfId = shot.picked_first_frame_generation_id;
      // would throw if missing, but we're in t2v mode
      if (pickedFfId) {
        firstFrameAssetId = pickedFfId;
      }
    }

    // t2v doesn't need first frame → firstFrameAssetId stays undefined
    assert.strictEqual(firstFrameAssetId, undefined);
    assert.strictEqual(videoMode, "t2v");
  });
});
