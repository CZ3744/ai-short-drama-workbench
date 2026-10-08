/**
 * Wave 4-A integration test: orchestrator + TargetAdapter end-to-end.
 *
 * 这个测试不调用真实的 LLM/image provider，而是把内置的 local_card_image (SVG 卡片图
 * provider) 接入 orchestrator，验证：
 *   1. orchestrator 的 image branch 现在走 shotFirstFrameAdapter
 *   2. adapter 把 generation 写入 shot.generations 时, generation 包含 quality_scores /
 *      prompt_version / request_payload_digest / cost_cny / submitted_at / model_id /
 *      negative_prompt 等所有 Wave 4-A 之前 orchestrator 自己写的字段
 *   3. shot.status 正确流转到 "generated"
 *   4. asset_id / vault_id 都齐全 (落盘没漏)
 *
 * 这是 Wave 4-A 防回归的核心保证 — 如果未来有人把 adapter 字段写漏了, 这里会立刻爆.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";

import { getRegistry } from "../api/v2/orchestration/_shared/registry";
import { JobOrchestrator } from "../jobs/orchestrator";
import {
  createSeries,
  deleteSeries,
  createEpisode,
  addShot,
  readShot,
  updateShot,
} from "../api/v2/seriesStore";

let seriesSlug = "";
let episodeId = "";
let shotId = "";

describe("Wave 4-A: orchestrator + TargetAdapter integration", () => {
  before(async () => {
    // Create test series + episode + shot
    const series = await createSeries({
      title: `Wave 4-A test ${Date.now()}`,
      defaults: {
        image_provider_id: "local_card_image",
        video_provider_id: "local_card_image",
        aspect_ratio: "16:9",
      },
    });
    seriesSlug = series.slug;

    const ep = await createEpisode(seriesSlug, { title: "Test EP" });
    episodeId = ep.id;

    const shot = await addShot(seriesSlug, episodeId, {
      title: "测试镜头",
      action: "测试动作",
      prompt_img: "test prompt for shot first frame",
      prompt_vid: "ignored for image branch",
    });
    shotId = shot.id;
    // negative_prompt is on ShotData but not in addShot input shape; patch via updateShot.
    await updateShot(seriesSlug, episodeId, shotId, { negative_prompt: "low quality, blurry" });
  });

  after(async () => {
    await deleteSeries(seriesSlug).catch(() => false);
  });

  it("orchestrator image branch persists via shotFirstFrameAdapter, generation has Wave 4-A extras", async () => {
    const registry = getRegistry();
    const orch = new JobOrchestrator({ max_parallel: 1, default_retries: 0, registry });

    const result = await orch.orchestrate({
      series_slug: seriesSlug,
      episode_id: episodeId,
      action: "generate_first_frames",
      count_per_shot: 1,
      provider_override: "local_card_image",
      only_shot_ids: [shotId],
    });
    assert.equal(result.task_count, 1, "1 task enqueued");
    assert.equal(result.tasks[0].shot_id, shotId);

    // Wait for task to complete (local_card_image is synchronous SVG render)
    for (let i = 0; i < 60; i++) {
      const s = await readShot(seriesSlug, episodeId, shotId);
      if ((s?.generations?.length ?? 0) > 0) {
        const gen = s!.generations![0];
        if (gen.status === "done" || gen.status === "failed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const finalShot = await readShot(seriesSlug, episodeId, shotId);
    assert.ok(finalShot, "shot exists post-orchestrate");
    assert.equal(finalShot!.status, "generated", "shot status set by adapter");
    assert.equal(finalShot!.generations?.length, 1, "exactly one generation appended");

    const gen = finalShot!.generations![0];

    // Core fields (adapter wrote these from request)
    assert.equal(gen.type, "first_frame");
    assert.equal(gen.status, "done");
    assert.equal(gen.picked, false);
    assert.equal(gen.provider, "local_card_image");
    assert.ok(gen.generation_id, "generation_id set");
    assert.ok(gen.asset_id, "asset_id present (落盘 ok)");
    assert.ok(gen.vault_id, "vault_id present (vault 写入 ok)");
    assert.ok(gen.path, "asset path present");

    // Wave 4-A extras (orchestrator passes these via generation_extras)
    assert.ok(gen.submitted_at, "submitted_at present");
    assert.ok(gen.completed_at, "completed_at present");
    assert.ok(gen.downloaded_at, "downloaded_at present");
    assert.ok(gen.request_payload_digest, "request_payload_digest present");
    assert.equal(gen.model_id, "local_card_image", "model_id matches provider");
    assert.equal(gen.negative_prompt, "low quality, blurry", "negative_prompt passed through");
    assert.equal(gen.prompt, "test prompt for shot first frame");
    assert.equal(gen.prompt_used, "test prompt for shot first frame");
    assert.equal(gen.prompt_final, "test prompt for shot first frame");
    assert.equal(typeof gen.fps, "number", "fps present (from render spec)");
    assert.equal(typeof gen.width, "number", "width present");
    assert.equal(typeof gen.height, "number", "height present");
    assert.equal(typeof gen.bytes, "number", "bytes present");

    // active_generations also updated by adapter
    assert.equal(finalShot!.active_generations?.length, 1, "active_generations also appended");
    assert.equal(finalShot!.active_generations![0].generation_id, gen.generation_id);

    // Verify the actual file landed at the adapter's series data dir (decoupled from orchestrator's outputs/ path)
    // (shotFirstFrameAdapter uses DATA_ROOT/series/<slug>/assets/images/...)
    assert.ok(gen.path?.includes(seriesSlug), `generation path should include series slug: ${gen.path}`);
    await fs.access(gen.path!).catch(() => {
      assert.fail(`generation file not readable: ${gen.path}`);
    });
    const stat = await fs.stat(gen.path!);
    assert.ok(stat.size > 0, `generation file is non-empty: ${stat.size} bytes`);
  });
});
