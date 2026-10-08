/**
 * T6: API key log redaction — unit tests for scrubForClient / scrubForLog
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scrubForClient, scrubForLog } from "../logger";

describe("scrubForClient / scrubForLog", () => {
  it("redacts Bearer token embedded in error message", () => {
    const input = "Request failed: Bearer abcdefghijklmnop connection timeout";
    const result = scrubForClient(input);
    assert.ok(!result.includes("abcdefghijklmnop"), "should redact the token");
    assert.ok(result.includes("Bearer [REDACTED]"), "should replace with [REDACTED] marker");
  });

  it("redacts sk-* key embedded in message", () => {
    const input = `{"error":"invalid key sk-1234567890abcdefghij for provider"}`;
    const result = scrubForClient(input);
    assert.ok(!result.includes("sk-1234567890abcdefghij"), "should redact the sk- key");
    assert.ok(result.includes("sk-[REDACTED]"), "should replace with [REDACTED] marker");
  });

  it("redacts tp-* key (MiMo format) embedded in message", () => {
    const input = `Provider MiMo error: api_key=tp-abc123def456ghi789jk`;
    const result = scrubForClient(input);
    assert.ok(!result.includes("tp-abc123def456ghi789jk"), "should redact the tp- key");
    assert.ok(result.includes("tp-[REDACTED]"), "should replace with [REDACTED] marker");
  });

  it("redacts JSON key-value pair with apiKey field", () => {
    const input = `{"apiKey":"sk-abcdefghijklmnopqrstuv", "model":"gpt-5.5"}`;
    const result = scrubForClient(input);
    assert.ok(!result.includes("sk-abcdefghijklmnopqrstuv"), "should redact the key value");
    assert.ok(result.includes('"apiKey":"[REDACTED]"'), "should replace with [REDACTED] marker");
  });

  it("redacts JSON key-value pair with token field", () => {
    const input = `{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"}`;
    const result = scrubForClient(input);
    assert.ok(result.includes('"token":"[REDACTED]"'), "should redact token field");
  });

  it("redacts JSON key-value pair with secret field", () => {
    const input = `{"secret":"my-super-secret-password-key"}`;
    const result = scrubForClient(input);
    assert.ok(result.includes('"secret":"[REDACTED]"'), "should redact secret field");
  });

  it("redacts JWT token", () => {
    const input = "Auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = scrubForClient(input);
    assert.ok(!result.includes("eyJhbGci"), "should redact JWT");
    assert.ok(result.includes("[REDACTED_JWT]"), "should replace with [REDACTED_JWT] marker");
  });

  it("single call with all 4 formats all redacted", () => {
    const input =
      "Errors: Bearer abcd1234abcd5678 token rejected; " +
      'key sk-1234567890abcdefghij invalid; ' +
      'mimo tp-abc123def456ghi789jk expired; ' +
      '{"apiKey":"abcdefghijklmnopqrstuvwxyz"}';
    const result = scrubForClient(input);
    // Verify original tokens are gone (not in output)
    assert.ok(!result.includes("abcd1234abcd5678"), "Bearer token should be redacted");
    assert.ok(!result.includes("sk-1234567890abcdefghij"), "sk- key should be redacted");
    assert.ok(!result.includes("tp-abc123def456ghi789jk"), "tp- key should be redacted");
    assert.ok(!result.includes("abcdefghijklmnopqrstuvwxyz"), "JSON key value should be redacted");
    // Verify redaction markers present
    assert.ok(result.includes("Bearer [REDACTED]"), "should have Bearer marker");
    assert.ok(result.includes("sk-[REDACTED]"), "should have sk- marker");
    assert.ok(result.includes("tp-[REDACTED]"), "should have tp- marker");
    assert.ok(result.includes('"apiKey":"[REDACTED]"'), "should have apiKey marker");
  });

  it("scrubForLog is identical to scrubForClient", () => {
    const input = "Bearer abcdefghijklmnop and sk-1234567890abcdefghij";
    assert.equal(scrubForLog(input), scrubForClient(input));
  });

  it("returns non-key strings unchanged", () => {
    const input = "Normal error: model mimo-v2.5-pro returned 500, scene scn_12345 failed.";
    const result = scrubForClient(input);
    assert.equal(result, input, "non-key strings should be unchanged");
  });
});
