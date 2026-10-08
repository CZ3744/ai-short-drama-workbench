import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sha256, sha256Prefix } from "../dedupe.js";

describe("dedupe helpers", () => {
  it("sha256 returns consistent 64-char hex string", () => {
    const buf = Buffer.from("hello world");
    const h1 = sha256(buf);
    const h2 = sha256(buf);
    assert.equal(h1, h2, "same input should produce same hash");
    assert.equal(h1.length, 64, "sha256 hex should be 64 chars");
    assert.match(h1, /^[0-9a-f]{64}$/, "should be lowercase hex");
  });

  it("different buffers produce different hashes", () => {
    const h1 = sha256(Buffer.from("aaa"));
    const h2 = sha256(Buffer.from("bbb"));
    assert.notEqual(h1, h2);
  });

  it("sha256Prefix returns first 8 hex chars", () => {
    const full = sha256(Buffer.from("test"));
    const prefix = sha256Prefix(full);
    assert.equal(prefix.length, 8);
    assert.equal(prefix, full.slice(0, 8));
  });

  it("empty buffer has a valid hash", () => {
    const h = sha256(Buffer.alloc(0));
    assert.equal(h.length, 64);
    // Known SHA-256 of empty string
    assert.equal(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
