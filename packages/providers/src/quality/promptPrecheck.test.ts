/**
 * Unit tests for promptPrecheck — B2 Wave B
 *
 * Tests the rule-based prompt validation engine.
 * No real API calls — all tests use the pure function directly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { precheckPrompt, type PrecheckResult } from "./promptPrecheck";

describe("promptPrecheck", () => {
  describe("mock mode", () => {
    it("always returns pass in mock mode", () => {
      const result = precheckPrompt("anything at all", { mock: true });
      assert.equal(result.pass, true);
      assert.equal(result.score, 1.0);
      assert.equal(result.issues.length, 0);
    });

    it("returns pass even with forbidden words in mock mode", () => {
      const result = precheckPrompt("nude violence gore", { mock: true });
      assert.equal(result.pass, true);
    });
  });

  describe("forbidden word detection", () => {
    it("detects NSFW forbidden words", () => {
      const result = precheckPrompt("a beautiful nude painting");
      assert.equal(result.pass, false);
      assert.equal(result.issues.some(i => i.type === "forbidden"), true);
    });

    it("detects violence forbidden words", () => {
      const result = precheckPrompt("a scene with blood and gore");
      assert.equal(result.pass, false);
      assert.equal(result.issues.some(i => i.type === "forbidden"), true);
    });

    it("passes with clean prompts", () => {
      const result = precheckPrompt("a beautiful sunset over the ocean with warm colors");
      assert.equal(result.pass, true);
      assert.equal(result.issues.filter(i => i.type === "forbidden").length, 0);
    });
  });

  describe("conflict detection", () => {
    it("detects style conflicts (realistic vs anime)", () => {
      const result = precheckPrompt("a realistic anime character in a forest scene");
      const conflictIssues = result.issues.filter(i => i.type === "conflict");
      assert.ok(conflictIssues.length > 0, "Should detect realistic/anime conflict");
    });

    it("detects lighting conflicts (dark vs bright)", () => {
      const result = precheckPrompt("a dark bright room with a person inside");
      const conflictIssues = result.issues.filter(i => i.type === "conflict");
      assert.ok(conflictIssues.length > 0, "Should detect dark/bright conflict");
    });

    it("detects composition conflicts (close-up vs wide shot)", () => {
      const result = precheckPrompt("a close-up wide shot of a mountain scene");
      const conflictIssues = result.issues.filter(i => i.type === "conflict");
      assert.ok(conflictIssues.length > 0, "Should detect close-up/wide shot conflict");
    });

    it("does not false-positive on unrelated words", () => {
      const result = precheckPrompt("a young woman standing in a bright forest scene");
      const conflictIssues = result.issues.filter(i => i.type === "conflict");
      assert.equal(conflictIssues.length, 0, "Should not detect false conflicts");
    });
  });

  describe("missing descriptor detection", () => {
    it("warns on very short prompts", () => {
      const result = precheckPrompt("cat");
      const missingIssues = result.issues.filter(i => i.type === "missing");
      assert.ok(missingIssues.length > 0, "Should warn about short prompt");
    });

    it("warns when scene description is missing", () => {
      const result = precheckPrompt("a young woman with long hair smiling at the camera");
      const missingScene = result.issues.find(i => i.message.includes("场景"));
      assert.ok(missingScene, "Should warn about missing scene description");
    });

    it("does not warn when descriptors are present", () => {
      const result = precheckPrompt("a young woman standing in a forest background with warm lighting");
      const missingIssues = result.issues.filter(i => i.type === "missing");
      assert.equal(missingIssues.length, 0, "Should not warn when descriptors are present");
    });
  });

  describe("score calculation", () => {
    it("returns 1.0 for a perfect prompt", () => {
      const result = precheckPrompt("a young woman standing in a beautiful forest scene, warm lighting, photorealistic");
      assert.equal(result.score, 1.0);
    });

    it("deducts for forbidden words", () => {
      const result = precheckPrompt("a nude figure in a scene");
      assert.ok(result.score <= 0.5, "Score should be significantly reduced for forbidden words");
    });

    it("deducts for conflicts", () => {
      const result = precheckPrompt("a realistic anime character in a dark bright forest scene");
      assert.ok(result.score < 1.0, "Score should be reduced for conflicts");
    });
  });

  describe("auto-fix", () => {
    it("removes forbidden words from fixed prompt", () => {
      const result = precheckPrompt("a beautiful scene with blood effects");
      assert.ok(result.fixedPrompt, "Should have a fixed prompt");
      assert.ok(!result.fixedPrompt!.toLowerCase().includes("blood"), "Fixed prompt should not contain forbidden word");
    });

    it("does not provide fixed prompt when no fixable issues", () => {
      const result = precheckPrompt("a young woman standing in a forest scene");
      assert.equal(result.fixedPrompt, undefined, "Should not have fixed prompt when no fixable issues");
    });
  });

  describe("edge cases", () => {
    it("handles empty prompt", () => {
      const result = precheckPrompt("");
      assert.equal(result.pass, false); // too short
    });

    it("handles very long prompt", () => {
      const longPrompt = "a ".repeat(500) + "young woman in a forest scene";
      const result = precheckPrompt(longPrompt);
      // Should not crash
      assert.ok(typeof result.score === "number");
    });
  });
});
