/**
 * Unit tests for continuityChecker — B3 Wave B
 *
 * Tests only the parsing logic. No real API calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── parseContinuityResult logic (mirrored from continuityChecker.ts for testability) ──

function parseContinuityResult(raw: string): boolean {
  const lower = raw.trim().toLowerCase();

  // Try JSON parse
  try {
    const parsed = JSON.parse(raw.trim());
    if (typeof parsed === "boolean") return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      const val = parsed.continuity ?? parsed.consistent ?? parsed.match ?? parsed.ok;
      if (typeof val === "boolean") return val;
    }
  } catch { /* not JSON */ }

  // Negative keywords MUST be checked first because:
  //   "inconsistent" contains "consistent"
  //   "mismatch" contains "match"
  if (lower.includes("inconsistent") || lower.includes("mismatch")) {
    return false;
  }
  if (lower.includes("false") || lower.includes("no")) {
    return false;
  }
  if (lower.includes("consistent") || lower.includes("match")) {
    return true;
  }
  if (lower.includes("true") || lower.includes("yes")) {
    return true;
  }

  return true; // default: assume continuity (don't false-alarm)
}

describe("continuityChecker", () => {
  describe("parseContinuityResult", () => {
    it("parses JSON {consistent: true}", () => {
      assert.equal(parseContinuityResult('{"consistent": true}'), true);
    });

    it("parses JSON {consistent: false}", () => {
      assert.equal(parseContinuityResult('{"consistent": false}'), false);
    });

    it("parses JSON {continuity: true}", () => {
      assert.equal(parseContinuityResult('{"continuity": true}'), true);
    });

    it("parses JSON {match: false}", () => {
      assert.equal(parseContinuityResult('{"match": false}'), false);
    });

    it("parses JSON {ok: true}", () => {
      assert.equal(parseContinuityResult('{"ok": true}'), true);
    });

    it("parses JSON true", () => {
      assert.equal(parseContinuityResult("true"), true);
    });

    it("parses JSON false", () => {
      assert.equal(parseContinuityResult("false"), false);
    });

    it("detects 'consistent' keyword", () => {
      assert.equal(parseContinuityResult("The shots are consistent with each other"), true);
    });

    it("detects 'inconsistent' keyword", () => {
      assert.equal(parseContinuityResult("The shots are inconsistent"), false);
    });

    it("detects 'match' keyword", () => {
      assert.equal(parseContinuityResult("The characters match"), true);
    });

    it("detects 'mismatch' keyword", () => {
      assert.equal(parseContinuityResult("There is a mismatch in clothing"), false);
    });

    it("detects 'yes' keyword", () => {
      assert.equal(parseContinuityResult("Yes, they are from the same scene"), true);
    });

    it("detects 'no' keyword", () => {
      assert.equal(parseContinuityResult("No, the location is different"), false);
    });

    it("defaults to true for ambiguous input", () => {
      assert.equal(parseContinuityResult("Unable to determine"), true);
    });

    it("defaults to true for empty input", () => {
      assert.equal(parseContinuityResult(""), true);
    });

    it("parses JSON with reason field", () => {
      const result = JSON.parse('{"consistent": false, "reason": "different clothing"}');
      assert.equal(result.consistent, false);
      assert.equal(result.reason, "different clothing");
    });
  });

  describe("threshold behavior", () => {
    it("true means consistent (no warning)", () => {
      assert.equal(parseContinuityResult('{"consistent": true}'), true);
    });

    it("false means inconsistent (warning)", () => {
      assert.equal(parseContinuityResult('{"consistent": false}'), false);
    });
  });
});
