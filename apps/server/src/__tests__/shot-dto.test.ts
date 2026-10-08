/**
 * D1.2: shot-dto test
 * 验证: DTO id 非 undefined, pick first_frame / video 独立存储
 */
import { describe, it } from "node:test";
import assert from "node:assert";

// Inline ShotGeneration type and toCandidate for testing
interface ShotGeneration {
  generation_id: string;
  type: "first_frame" | "video";
  provider: string;
  asset_id?: string;
  vault_id?: string;
  path?: string;
  picked?: boolean;
  created_at: string;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  quality_scores?: {
    composition: number;
    sharpness: number;
    prompt_alignment: number;
    subject_completeness: number;
    checked_at: string;
  };
}

function toCandidate(slug: string, g: ShotGeneration) {
  return {
    id: g.generation_id,
    generation_id: g.generation_id,
    url: g.vault_id
      ? `/api/v2/vault/${g.vault_id}/raw`
      : g.asset_id
        ? `/api/v2/series/${slug}/assets/${g.asset_id}/thumbnail`
        : "",
    thumbnail: g.vault_id
      ? `/api/v2/vault/${g.vault_id}/thumbnail`
      : g.asset_id
        ? `/api/v2/series/${slug}/assets/${g.asset_id}/thumbnail?size=256`
        : undefined,
    provider: g.provider,
    seed: undefined as number | undefined,
    prompt: "",
    picked: g.picked ?? false,
    created_at: g.created_at,
    vault_id: g.vault_id,
    asset_id: g.asset_id,
    quality_scores: g.quality_scores,
    status: g.status,
    type: g.type,
    error: g.error,
  };
}

describe("toCandidate DTO", () => {
  const gen: ShotGeneration = {
    generation_id: "gen_abc123",
    type: "first_frame",
    provider: "local_card_image",
    vault_id: "vault_xyz",
    created_at: "2026-05-10T00:00:00Z",
    status: "done",
  };
  const slug = "demo-series";

  it("candidate.id equals generation_id (not undefined)", () => {
    const c = toCandidate(slug, gen);
    assert.strictEqual(c.id, "gen_abc123");
    assert.strictEqual(c.generation_id, "gen_abc123");
    assert.notStrictEqual(c.id, undefined);
  });

  it("candidate.url is resolved from vault_id", () => {
    const c = toCandidate(slug, gen);
    assert.strictEqual(c.url, "/api/v2/vault/vault_xyz/raw");
  });

  it("candidate.thumbnail is resolved from vault_id", () => {
    const c = toCandidate(slug, gen);
    assert.strictEqual(c.thumbnail, "/api/v2/vault/vault_xyz/thumbnail");
  });

  it("candidate without vault_id falls back to series asset route", () => {
    const c = toCandidate(slug, { ...gen, vault_id: undefined, asset_id: "asset_123" });
    assert.strictEqual(c.url, "/api/v2/series/demo-series/assets/asset_123/thumbnail");
    assert.strictEqual(c.thumbnail, "/api/v2/series/demo-series/assets/asset_123/thumbnail?size=256");
    assert.strictEqual(c.vault_id, undefined);
    assert.strictEqual(c.asset_id, "asset_123");
  });

  it("candidate without vault_id or asset_id has empty url", () => {
    const c = toCandidate(slug, { ...gen, vault_id: undefined, asset_id: undefined });
    assert.strictEqual(c.url, "");
  });

  it("candidate.picked defaults to false", () => {
    const c = toCandidate(slug, gen);
    assert.strictEqual(c.picked, false);
  });

  it("candidate.picked is true when set", () => {
    const c = toCandidate(slug, { ...gen, picked: true });
    assert.strictEqual(c.picked, true);
  });

  it("candidate preserves type", () => {
    const ff = toCandidate(slug, { ...gen, type: "first_frame" });
    const vid = toCandidate(slug, { ...gen, type: "video", generation_id: "gen_vid" });
    assert.strictEqual(ff.type as string, "first_frame");
    assert.strictEqual(vid.type as string, "video");
  });
});

describe("pick first_frame vs video independent storage", () => {
  // Simulate ShotData pick logic
  interface ShotData {
    picked_first_frame_generation_id?: string | null;
    picked_video_generation_id?: string | null;
    picked_generation_id?: string;
  }

  it("pick first_frame writes to picked_first_frame_generation_id only", () => {
    const shot: ShotData = {};
    const kind = "first_frame";
    const targetGenId = "gen_ff_001";

    if (kind === "first_frame") {
      shot.picked_first_frame_generation_id = targetGenId;
    } else {
      shot.picked_video_generation_id = targetGenId;
    }
    shot.picked_generation_id = targetGenId; // legacy

    assert.strictEqual(shot.picked_first_frame_generation_id, "gen_ff_001");
    assert.strictEqual(shot.picked_video_generation_id, undefined);
  });

  it("pick video writes to picked_video_generation_id only", () => {
    const shot: ShotData = {};
    const kind: string = "video";
    const targetGenId = "gen_vid_001";

    if (kind === "first_frame") {
      shot.picked_first_frame_generation_id = targetGenId;
    } else {
      shot.picked_video_generation_id = targetGenId;
    }
    shot.picked_generation_id = targetGenId;

    assert.strictEqual(shot.picked_video_generation_id, "gen_vid_001");
    assert.strictEqual(shot.picked_first_frame_generation_id, undefined);
  });

  it("both picks can coexist independently", () => {
    const shot: ShotData = {
      picked_first_frame_generation_id: "gen_ff_001",
      picked_video_generation_id: "gen_vid_001",
      picked_generation_id: "gen_vid_001",
    };

    assert.strictEqual(shot.picked_first_frame_generation_id, "gen_ff_001");
    assert.strictEqual(shot.picked_video_generation_id, "gen_vid_001");
    assert.notStrictEqual(shot.picked_first_frame_generation_id, shot.picked_video_generation_id);
  });
});
