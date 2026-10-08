/**
 * B4 (2026-05-15): scrubForClient 新增 Token / api-key header 模式测试.
 *
 * 测试目的:
 *  - Vidu 的 `Authorization: Token <key>` 头不能被原样泄露 (viduClient.ts:91)
 *  - api-key / x-api-key header 不能被原样泄露 (Volcengine 等自定义签名头, 以及
 *    curl -H 命令回显场景)
 *  - 不破坏既有 Bearer / sk- / tp- / JWT 等正则
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scrubForClient } from "../logger";

describe("scrubForClient — Token / api-key header redaction (B4)", () => {
  it("redacts Vidu-style `Token <apikey>` Authorization header", () => {
    const input = "Request failed: Authorization: Token vidu_secret_abcdef1234567890XYZ rejected";
    const result = scrubForClient(input);
    assert.ok(!result.includes("vidu_secret_abcdef1234567890XYZ"), "Token 后面的 key 不应残留");
    assert.ok(result.includes("Token [REDACTED]"), "应替换为 [REDACTED] 标记");
  });

  it("redacts `api-key: <value>` header dump (lowercase)", () => {
    const input = "curl -H 'api-key: 1234567890abcdefABCDEF'";
    const result = scrubForClient(input);
    assert.ok(!result.includes("1234567890abcdefABCDEF"), "api-key value 不应残留");
    assert.ok(/api-key:\s*\[REDACTED\]/.test(result), "应替换为 [REDACTED]");
  });

  it("redacts `X-Api-Key: <value>` header (mixed case)", () => {
    const input = "headers={X-Api-Key: secret_volc_signature_xyz123456}";
    const result = scrubForClient(input);
    assert.ok(!result.includes("secret_volc_signature_xyz123456"), "X-Api-Key value 不应残留");
    assert.ok(/X-Api-Key:\s*\[REDACTED\]/.test(result), "应替换为 [REDACTED]");
  });

  it("redacts `api_key=<value>` query-string / curl 等号形式", () => {
    const input = "url=https://api.example.com?api_key=abcdef0123456789zzz&other=1";
    const result = scrubForClient(input);
    assert.ok(!result.includes("abcdef0123456789zzz"), "api_key value 不应残留");
    assert.ok(/api_key:\s*\[REDACTED\]/.test(result), "应替换为 [REDACTED]");
  });

  it("still redacts Bearer token (regression — 不破坏既有 Bearer 正则)", () => {
    const input = "Authorization: Bearer abcdefghijklmnopqrstuv";
    const result = scrubForClient(input);
    assert.ok(!result.includes("abcdefghijklmnopqrstuv"), "Bearer token 不应残留");
    assert.ok(result.includes("Bearer [REDACTED]"));
  });

  it("still redacts sk- / tp- / JWT (regression)", () => {
    const input =
      "sk-1234567890abcdefghij tp-abc123def456ghi789jk " +
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = scrubForClient(input);
    assert.ok(!result.includes("1234567890abcdefghij"));
    assert.ok(!result.includes("abc123def456ghi789jk"));
    assert.ok(!result.includes("eyJhbGci"));
    assert.ok(result.includes("sk-[REDACTED]"));
    assert.ok(result.includes("tp-[REDACTED]"));
    assert.ok(result.includes("[REDACTED_JWT]"));
  });
});
