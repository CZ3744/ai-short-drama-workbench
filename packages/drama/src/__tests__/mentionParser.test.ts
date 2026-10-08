/**
 * 2026-05-20: 短格式 @ mention 解析单元测试
 *
 * 覆盖路径:
 *   - 长格式 @角色:林深 仍能解析 (向后兼容)
 *   - 短格式 @林深 用 ctx 反查归类为 character
 *   - 重名时优先级 character > scene > element
 *   - 短格式贪婪匹配最长 name (避免 "@林深" → "@林" + "深")
 *   - 不在 ctx 的 @ 不抛错, 跳过
 *   - dedupe (同 token 多次只算一次)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseShortMentionTokens, parseMentionTokens, shortMentionTokenOf } from "../mentionParser.js";

describe("parseShortMentionTokens (2026-05-20 短格式)", () => {
  it("short format @林深 resolves to character via ctx", () => {
    const ctx = {
      characters: [{ name: "林深" }],
      scenes: [],
      elements: [],
    };
    const tokens = parseShortMentionTokens("@林深 走进咖啡馆", ctx);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].kind, "character");
    assert.equal(tokens[0].name, "林深");
    assert.equal(tokens[0].raw, "@林深");
  });

  it("short format @茶水间 resolves to scene", () => {
    const ctx = {
      characters: [],
      scenes: [{ name: "茶水间" }],
      elements: [],
    };
    const tokens = parseShortMentionTokens("@茶水间 灯光昏黄", ctx);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].kind, "scene");
    assert.equal(tokens[0].name, "茶水间");
  });

  it("short format @微波炉 resolves to element", () => {
    const ctx = {
      characters: [],
      scenes: [],
      elements: [{ name: "微波炉" }],
    };
    const tokens = parseShortMentionTokens("打开 @微波炉", ctx);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].kind, "element");
    assert.equal(tokens[0].name, "微波炉");
  });

  it("name conflict: character > scene > element priority", () => {
    const ctx = {
      characters: [{ name: "影子" }],
      scenes: [{ name: "影子" }],
      elements: [{ name: "影子" }],
    };
    const tokens = parseShortMentionTokens("@影子 移动了", ctx);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].kind, "character", "name 冲突时优先 character");
  });

  it("greedy match — longest name wins (avoid @林深 → @林 + 深)", () => {
    const ctx = {
      characters: [{ name: "林" }, { name: "林深" }],
      scenes: [],
      elements: [],
    };
    const tokens = parseShortMentionTokens("@林深 现身", ctx);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].name, "林深", "应匹配最长 name");
  });

  it("unknown @ not in ctx — silent skip, no throw", () => {
    const ctx = {
      characters: [{ name: "林深" }],
      scenes: [],
      elements: [],
    };
    const tokens = parseShortMentionTokens("@unknown 看着 @林深", ctx);
    // unknown 不在 ctx 跳过, 林深 命中
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].name, "林深");
  });

  it("dedupe — 同一短 token 出现多次仅算一次", () => {
    const ctx = {
      characters: [{ name: "林深" }],
      scenes: [],
      elements: [],
    };
    const tokens = parseShortMentionTokens("@林深 又见 @林深", ctx);
    assert.equal(tokens.length, 1);
  });

  it("long format 仍兼容 — @角色:林深 解析", () => {
    const ctx = { characters: [], scenes: [], elements: [] };
    const tokens = parseShortMentionTokens("@角色:林深 走来", ctx);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].kind, "character");
    assert.equal(tokens[0].name, "林深");
  });

  it("mixed long + short — 都能解析", () => {
    const ctx = {
      characters: [],
      scenes: [{ name: "茶水间" }],
      elements: [],
    };
    const tokens = parseShortMentionTokens("@角色:林深 进 @茶水间", ctx);
    assert.equal(tokens.length, 2);
    // 长格式 @角色:林深 优先扫
    const charTok = tokens.find(t => t.name === "林深");
    const sceneTok = tokens.find(t => t.name === "茶水间");
    assert.ok(charTok && charTok.kind === "character");
    assert.ok(sceneTok && sceneTok.kind === "scene");
  });

  it("parseMentionTokens (long-only) 仍能解析旧 token (向后兼容)", () => {
    const tokens = parseMentionTokens("@角色:林深 走 @场景:茶水间");
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].kind, "character");
    assert.equal(tokens[1].kind, "scene");
  });

  it("shortMentionTokenOf 序列化 — @<name>", () => {
    assert.equal(shortMentionTokenOf({ name: "林深" }), "@林深");
    assert.equal(shortMentionTokenOf({ name: "茶水间" }), "@茶水间");
    // name 内含 @ / 空格 → 转义成 _ (避免 token 解析歧义)
    assert.equal(shortMentionTokenOf({ name: "小 林" }), "@小_林");
  });

  it("empty ctx — 长格式仍解析, 短格式跳过", () => {
    const tokens = parseShortMentionTokens("@角色:林深 看 @陌生人", { characters: [], scenes: [], elements: [] });
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].name, "林深");
  });

  it("empty text — 返空数组", () => {
    const tokens = parseShortMentionTokens("", { characters: [], scenes: [], elements: [] });
    assert.equal(tokens.length, 0);
  });
});
