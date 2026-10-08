import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToPlainText, plainTextToHtml } from "./scriptText";

test("script editing preserves literal markup, entity text, Chinese and headings", () => {
  for (const source of ['# 雨夜\n\n## 场景\n**对白**和*旁白*', '<img src=x onerror="alert(1)">', 'A < B & C > D', '保留 &lt; 与 &amp;', '@小雨 说：你好']) {
    assert.equal(htmlToPlainText(plainTextToHtml(source)), source);
  }
  assert.ok(!plainTextToHtml('<img src=x>').includes('<img'));
});
