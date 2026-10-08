/**
 * W3.2: retake-limit-skip test
 * 验证: 单 shot 超 RETAKE_LIMIT 不中断整个 job (skip 而非 throw)
 */
import { describe, it } from "node:test";
import assert from "node:assert";

// ── Simulated shot data ──

interface ShotGen {
  generation_id: string;
  type: "first_frame" | "video";
  status: "done" | "failed" | "pending";
}

interface ShotData {
  id: string;
  generations: ShotGen[];
}

// ── Simulated orchestrate logic (S9 fixed version) ──

function simulateOrchestrate(
  shots: ShotData[],
  action: "generate_first_frames" | "generate_videos",
  countPerShot: number,
  maxRetake: number,
): { tasks: Array<{ task_id: string; shot_id: string; status: string }>; skipped: number } {
  const tasks: Array<{ task_id: string; shot_id: string; status: string }> = [];

  for (const shot of shots) {
    const taskKind = action === "generate_first_frames" ? "first_frame" : "video";
    const existing = shot.generations.filter(
      (g) => g.type === taskKind && g.status !== "failed"
    );
    const remaining = Math.max(0, maxRetake - existing.length);
    const actualCount = Math.min(countPerShot, remaining);

    // S9: skip 而非 throw
    if (actualCount <= 0) {
      tasks.push({ task_id: "skipped_" + shot.id, shot_id: shot.id, status: "skipped_limit" });
      continue;
    }

    for (let i = 0; i < actualCount; i++) {
      tasks.push({
        task_id: `task_${shot.id}_${i}`,
        shot_id: shot.id,
        status: "queued",
      });
    }
  }

  return { tasks, skipped: tasks.filter(t => t.status === "skipped_limit").length };
}

// ── Tests ──

describe("RETAKE_LIMIT 不中断整个 job", () => {
  it("已达上限的 shot 被 skip,其他 shot 正常生成", () => {
    const shots: ShotData[] = [
      {
        id: "shot_1",
        generations: [
          { generation_id: "g1", type: "first_frame", status: "done" },
          { generation_id: "g2", type: "first_frame", status: "done" },
          { generation_id: "g3", type: "first_frame", status: "done" },
          { generation_id: "g4", type: "first_frame", status: "done" },
          { generation_id: "g5", type: "first_frame", status: "done" },
        ],
      },
      {
        id: "shot_2",
        generations: [
          { generation_id: "g6", type: "first_frame", status: "done" },
        ],
      },
      {
        id: "shot_3",
        generations: [],
      },
    ];

    const result = simulateOrchestrate(shots, "generate_first_frames", 2, 5);

    // shot_1 has 5 done → 0 remaining → skipped
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(
      result.tasks.filter(t => t.status === "skipped_limit").length,
      1,
    );
    assert.strictEqual(
      result.tasks.filter(t => t.status === "skipped_limit")[0].shot_id,
      "shot_1",
    );

    // shot_2 has 1 done → 4 remaining → 2 generated
    assert.strictEqual(
      result.tasks.filter(t => t.shot_id === "shot_2" && t.status === "queued").length,
      2,
    );

    // shot_3 has 0 done → 5 remaining → 2 generated
    assert.strictEqual(
      result.tasks.filter(t => t.shot_id === "shot_3" && t.status === "queued").length,
      2,
    );

    // Total tasks: 1 skipped + 2 + 2 = 5
    assert.strictEqual(result.tasks.length, 5);
  });

  it("全部 shot 超限时全部 skip, 不 throw", () => {
    const shots: ShotData[] = [
      {
        id: "shot_a",
        generations: [
          { generation_id: "g1", type: "video", status: "done" },
          { generation_id: "g2", type: "video", status: "done" },
          { generation_id: "g3", type: "video", status: "done" },
        ],
      },
    ];

    const result = simulateOrchestrate(shots, "generate_videos", 1, 3);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.tasks.length, 1);
    // 不应 throw, 应优雅返回
    assert.ok(result.tasks.every(t => t.status === "skipped_limit"));
  });

  it("无上限时全部正常生成", () => {
    const shots: ShotData[] = [
      { id: "s1", generations: [] },
      { id: "s2", generations: [] },
    ];

    const result = simulateOrchestrate(shots, "generate_videos", 3, 10);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.tasks.length, 6);
    assert.ok(result.tasks.every(t => t.status === "queued"));
  });

  it("failed 不计入已用量", () => {
    const shots: ShotData[] = [
      {
        id: "shot_x",
        generations: [
          { generation_id: "gf1", type: "video", status: "failed" },
          { generation_id: "gf2", type: "video", status: "failed" },
          { generation_id: "gd1", type: "video", status: "done" },
        ],
      },
    ];

    // 3 total, 2 failed + 1 done → only 1 effective, maxRetake=3 → 2 remaining
    const result = simulateOrchestrate(shots, "generate_videos", 3, 3);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.tasks.length, 2);
  });
});
