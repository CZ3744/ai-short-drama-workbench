/**
 * Unit tests for postGenCheck.
 *
 * Quality checks must never fabricate "neutral" numbers when the real scorer/decoder
 * is unavailable. Undefined means "not scored" and is intentionally distinct from 0.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { postGenCheck, computeSharpness } from "./postGenCheck";

describe("postGenCheck", () => {
  describe("mock mode", () => {
    it("reports external checks as unscored instead of fake neutral values", async () => {
      const fakeBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const scores = await postGenCheck(fakeBuffer, {
        prompt: "a beautiful forest scene",
        mock: true,
      });

      assert.equal(scores.composition, undefined);
      assert.equal(scores.sharpness, undefined);
      assert.equal(scores.prompt_alignment, undefined);
      assert.equal(scores.subject_completeness, 1.0);
      assert.equal(typeof scores.checked_at, "string");
    });

    it("returns 1.0 for subject completeness when no character is required", async () => {
      const scores = await postGenCheck(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        prompt: "a landscape",
        character_ids: [],
        mock: true,
      });

      assert.equal(scores.subject_completeness, 1.0);
    });

    it("reports subject completeness as unscored when characters require vision", async () => {
      const scores = await postGenCheck(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        prompt: "a character portrait",
        character_ids: ["char_001"],
        mock: true,
      });

      assert.equal(scores.subject_completeness, undefined);
    });
  });

  describe("score ranges", () => {
    it("every available score stays within 0..1", async () => {
      const scores = await postGenCheck(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        prompt: "test prompt",
        mock: true,
      });

      for (const key of ["composition", "sharpness", "prompt_alignment", "subject_completeness"] as const) {
        const score = scores[key];
        if (score !== undefined) {
          assert.ok(score >= 0, `${key} should be >= 0`);
          assert.ok(score <= 1, `${key} should be <= 1`);
        }
      }
    });
  });
});

describe("computeSharpness", () => {
  it("returns undefined for undecodable buffers instead of fabricating a score", async () => {
    assert.equal(await computeSharpness(Buffer.alloc(100, 128)), undefined);
    assert.equal(await computeSharpness(Buffer.from("not an image at all")), undefined);
    assert.equal(await computeSharpness(Buffer.alloc(0)), undefined);
  });
});
