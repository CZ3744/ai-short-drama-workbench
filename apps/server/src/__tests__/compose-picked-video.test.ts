/**
 * 2026-05-22 entity-first compose 修复回归测试.
 *
 * 覆盖 pickGenerationEntityFirst 的 4 个核心 case:
 *   A. shot.picked_video_generation_id 设了 + generation.picked=false  → 取 picked_id 指向的那条 (entity-first)
 *   B. shot.picked_video_generation_id 未设 + generation.picked=true   → fallback 用 picked=true 的 (legacy)
 *   C. shot.picked_video_generation_id 指向不存在的 generation         → throw generation-not-found, 绝不 silent mock
 *   D. shot 无任何 video generation                                    → throw no-picked-generation, 上层走 mock 占位
 *
 * 不依赖文件系统 — 只测 pickGenerationEntityFirst 的纯逻辑判断. 文件解析 resolveGenerationPath
 * 涉及 vault / asset / 本地 fs, 由 e2e smoke (test:e2e-smoke) + 真实迁移脚本运行验证.
 */
import { describe, it } from "node:test";
import assert from "node:assert";

import {
  pickGenerationEntityFirst,
  PickedAssetUnresolvedError,
  type PickedShotLike,
  type PickedGenerationLike,
} from "../application/compose/pickedAssetResolver";

function mkGen(overrides: Partial<PickedGenerationLike>): PickedGenerationLike {
  return {
    generation_id: overrides.generation_id ?? "gen_default",
    type: overrides.type ?? "video",
    status: overrides.status ?? "done",
    created_at: overrides.created_at ?? new Date().toISOString(),
    ...overrides,
  };
}

describe("pickGenerationEntityFirst — 4 核心 case", () => {
  it("A. shot.picked_video_generation_id 设了, generation.picked=false → 取 picked_id 指向的那条", () => {
    // 这是 2026-05-22 用户实测黑屏的直接 case:
    // 数据库里 picked_video_generation_id="01KS5..." 但 generation.picked=false,
    // 旧 `find(g => g.picked === true)` 永远找不到 → silent mock.
    const shot: PickedShotLike = {
      id: "s0001",
      picked_video_generation_id: "gen_video_user_picked",
      generations: [
        mkGen({ generation_id: "gen_video_other", type: "video", picked: false, created_at: "2026-05-21T10:00:00Z" }),
        mkGen({ generation_id: "gen_video_user_picked", type: "video", picked: false, created_at: "2026-05-21T09:00:00Z", asset_id: "asset_xxx" }),
        mkGen({ generation_id: "gen_video_newer", type: "video", picked: false, created_at: "2026-05-21T11:00:00Z" }),
      ],
    };
    const result = pickGenerationEntityFirst(shot, "video");
    assert.strictEqual(result.generation.generation_id, "gen_video_user_picked",
      "必须严格按 shot.picked_video_generation_id, 不能选 created_at 最新的");
    assert.strictEqual(result.pickedBy, "shot_picked_id");
  });

  it("B. shot.picked_video_generation_id 未设 + generation.picked=true → fallback 取 picked=true 的", () => {
    // 老数据兼容: 旧版只写 generation.picked 标志, 没写 shot.picked_*_generation_id
    const shot: PickedShotLike = {
      id: "s0002",
      generations: [
        mkGen({ generation_id: "gen_a", type: "video", picked: false, created_at: "2026-05-21T11:00:00Z" }),
        mkGen({ generation_id: "gen_b", type: "video", picked: true, created_at: "2026-05-21T09:00:00Z" }),
        mkGen({ generation_id: "gen_c", type: "video", picked: false, created_at: "2026-05-21T10:00:00Z" }),
      ],
    };
    const result = pickGenerationEntityFirst(shot, "video");
    assert.strictEqual(result.generation.generation_id, "gen_b",
      "未设 picked_id 时 legacy fallback 必须取 picked=true 的, 不是 created_at 最新的");
    assert.strictEqual(result.pickedBy, "generation_picked_flag");
  });

  it("B-bis. 全都没 picked + 多条 generation → fallback 取 created_at 最新", () => {
    const shot: PickedShotLike = {
      id: "s0002b",
      generations: [
        mkGen({ generation_id: "gen_old", type: "video", picked: false, created_at: "2026-05-21T09:00:00Z" }),
        mkGen({ generation_id: "gen_new", type: "video", picked: false, created_at: "2026-05-21T11:00:00Z" }),
      ],
    };
    const result = pickGenerationEntityFirst(shot, "video");
    assert.strictEqual(result.generation.generation_id, "gen_new");
    assert.strictEqual(result.pickedBy, "generation_picked_flag");
  });

  it("C. shot.picked_video_generation_id 指向不存在的 generation → throw generation-not-found", () => {
    const shot: PickedShotLike = {
      id: "s0003",
      picked_video_generation_id: "gen_ghost",
      generations: [
        mkGen({ generation_id: "gen_actually_here", type: "video", picked: false }),
      ],
    };
    assert.throws(
      () => pickGenerationEntityFirst(shot, "video"),
      (err: unknown) => {
        assert.ok(err instanceof PickedAssetUnresolvedError, "必须抛 PickedAssetUnresolvedError, 不能 fallback 到 picked=true / 最新条");
        assert.strictEqual((err as PickedAssetUnresolvedError).code, "generation-not-found");
        assert.match((err as PickedAssetUnresolvedError).reasonZh, /已选定/, "reason 必须是中文人话");
        assert.match((err as PickedAssetUnresolvedError).reasonZh, /重新选择|重新生成/, "必须给用户出路");
        return true;
      },
    );
  });

  it("D. shot 完全无 video generation → throw no-picked-generation", () => {
    const shot: PickedShotLike = {
      id: "s0004",
      generations: [
        mkGen({ generation_id: "gen_ff", type: "first_frame", picked: true }), // 有首帧但没视频
      ],
    };
    assert.throws(
      () => pickGenerationEntityFirst(shot, "video"),
      (err: unknown) => {
        assert.ok(err instanceof PickedAssetUnresolvedError);
        assert.strictEqual((err as PickedAssetUnresolvedError).code, "no-picked-generation");
        return true;
      },
    );
  });

  it("D-bis. shot generations 全部 status=failed → no-picked-generation (不能取 failed 的当 picked)", () => {
    const shot: PickedShotLike = {
      id: "s0005",
      generations: [
        mkGen({ generation_id: "gen_failed_a", type: "video", status: "failed", picked: false }),
        mkGen({ generation_id: "gen_failed_b", type: "video", status: "failed", picked: false }),
      ],
    };
    assert.throws(
      () => pickGenerationEntityFirst(shot, "video"),
      (err: unknown) => err instanceof PickedAssetUnresolvedError && (err as PickedAssetUnresolvedError).code === "no-picked-generation",
    );
  });

  it("first_frame kind 走 picked_first_frame_generation_id, 不串到 picked_video_generation_id", () => {
    const shot: PickedShotLike = {
      id: "s0006",
      picked_first_frame_generation_id: "gen_ff_picked",
      picked_video_generation_id: "gen_vid_picked",
      generations: [
        mkGen({ generation_id: "gen_ff_picked", type: "first_frame", picked: false }),
        mkGen({ generation_id: "gen_vid_picked", type: "video", picked: false }),
      ],
    };
    const ff = pickGenerationEntityFirst(shot, "first_frame");
    assert.strictEqual(ff.generation.generation_id, "gen_ff_picked");
    assert.strictEqual(ff.generation.type, "first_frame");

    const vid = pickGenerationEntityFirst(shot, "video");
    assert.strictEqual(vid.generation.generation_id, "gen_vid_picked");
    assert.strictEqual(vid.generation.type, "video");
  });

  it("禁止 silent fallback: picked_id 指向 first_frame 但 kind=video → throw generation-not-found", () => {
    // 防 entity-first 的 type 假阳性: picked_video_generation_id 误指向 first_frame generation
    // 时必须抛错, 不能松到"反正找到一条 done 的就用".
    const shot: PickedShotLike = {
      id: "s0007",
      picked_video_generation_id: "gen_actually_a_first_frame",
      generations: [
        mkGen({ generation_id: "gen_actually_a_first_frame", type: "first_frame", picked: true }),
        mkGen({ generation_id: "gen_real_video", type: "video", picked: false }),
      ],
    };
    assert.throws(
      () => pickGenerationEntityFirst(shot, "video"),
      (err: unknown) => err instanceof PickedAssetUnresolvedError && (err as PickedAssetUnresolvedError).code === "generation-not-found",
    );
  });
});
