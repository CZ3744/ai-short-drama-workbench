/**
 * D1.1 + W7: orchestrator provider-routing test
 * 验证: first_frame 走 image_provider, video 走 video_provider
 *
 * W7 (2026-05-15): silent mock fallback 已删除 — 无 override 且无 defaults 时
 * 必须 throw ProviderNotSelectedError (Bug 1 修复)。
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { ProviderNotSelectedError } from "../jobs/errors";

// Test resolveProviderId logic (inlined from orchestrator.ts — must mirror the real impl)
function resolveProviderId(
  action: "generate_first_frames" | "generate_videos",
  override: string | undefined,
  defaults: { image_provider_id?: string | null; video_provider_id?: string | null }
): string {
  if (override) return override;
  const fromDefaults = action === "generate_first_frames"
    ? defaults.image_provider_id
    : defaults.video_provider_id;
  if (fromDefaults) return fromDefaults;
  throw new ProviderNotSelectedError(action);
}

describe("resolveProviderId", () => {
  it("first_frame with no override and no defaults → throws ProviderNotSelectedError (image)", () => {
    assert.throws(
      () => resolveProviderId("generate_first_frames", undefined, {}),
      (err: unknown) => {
        return err instanceof ProviderNotSelectedError
          && err.code === "provider_not_selected"
          && err.httpStatus === 400
          && err.kind === "image"
          && err.action === "generate_first_frames";
      },
      "应该抛 ProviderNotSelectedError 而非 silent fallback 到 local_card_image",
    );
  });

  it("video with no override and no defaults → throws ProviderNotSelectedError (video)", () => {
    assert.throws(
      () => resolveProviderId("generate_videos", undefined, {}),
      (err: unknown) => {
        return err instanceof ProviderNotSelectedError
          && err.code === "provider_not_selected"
          && err.httpStatus === 400
          && err.kind === "video"
          && err.action === "generate_videos";
      },
      "应该抛 ProviderNotSelectedError 而非 silent fallback 到 local_mock_video",
    );
  });

  it("first_frame respects image_provider_id from defaults", () => {
    const id = resolveProviderId("generate_first_frames", undefined, {
      image_provider_id: "jimeng_image_4",
      video_provider_id: "minimax_hailuo",
    });
    assert.strictEqual(id, "jimeng_image_4");
  });

  it("video respects video_provider_id from defaults", () => {
    const id = resolveProviderId("generate_videos", undefined, {
      image_provider_id: "jimeng_image_4",
      video_provider_id: "minimax_hailuo",
    });
    assert.strictEqual(id, "minimax_hailuo");
  });

  it("first_frame does NOT use video_provider_id (only video_provider in defaults → still throws)", () => {
    assert.throws(
      () => resolveProviderId("generate_first_frames", undefined, {
        video_provider_id: "minimax_hailuo",
      }),
      (err: unknown) => err instanceof ProviderNotSelectedError && err.kind === "image",
      "first_frame 不应该兜底使用 video_provider_id, 应抛 image kind 的 ProviderNotSelectedError",
    );
  });

  it("override takes precedence over defaults", () => {
    const id = resolveProviderId("generate_first_frames", "kling_3", {
      image_provider_id: "jimeng_image_4",
    });
    assert.strictEqual(id, "kling_3");
  });

  it("video override takes precedence", () => {
    const id = resolveProviderId("generate_videos", "kling_3", {
      video_provider_id: "minimax_hailuo",
    });
    assert.strictEqual(id, "kling_3");
  });

  it("override with empty string falls through to defaults check", () => {
    // 防御性测试: 空字符串 override 不应被当作有效 provider
    assert.throws(
      () => resolveProviderId("generate_first_frames", "", {}),
      (err: unknown) => err instanceof ProviderNotSelectedError,
    );
  });
});

describe("ProviderNotSelectedError", () => {
  it("image kind message is toC-friendly (no technical field names)", () => {
    const err = new ProviderNotSelectedError("generate_first_frames");
    assert.match(err.message, /图像模型/);
    assert.doesNotMatch(err.message, /image_provider_id/);
    assert.doesNotMatch(err.message, /provider_id/);
  });

  it("video kind message is toC-friendly", () => {
    const err = new ProviderNotSelectedError("generate_videos");
    assert.match(err.message, /视频模型/);
    assert.doesNotMatch(err.message, /video_provider_id/);
  });
});
