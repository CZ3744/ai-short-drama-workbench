// W7 Phase 3 单测:multiTrackSubtitles ASS 构造 + sanitize

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMultiTrackAss,
  buildMultiTrackAssConvenient,
  sanitizeAssText,
} from "../multiTrackSubtitles";

test("sanitizeAssText 清理 ASS 控制字符", () => {
  // 反斜杠 → 空格
  assert.equal(sanitizeAssText("a\\b"), "a b");
  // 大括号删掉
  assert.equal(sanitizeAssText("{prefix}文本{end}"), "prefix文本end");
  // 换行变 \N(ASS 内换行)
  assert.equal(sanitizeAssText("第一行\n第二行"), "第一行\\N第二行");
  // 回车清掉
  assert.equal(sanitizeAssText("a\rb"), "ab");
});

test("buildMultiTrackAss 输出 V4+ Styles 三种 style", () => {
  const ass = buildMultiTrackAss({
    width: 1920,
    height: 1080,
    tracks: [],
  });
  assert.match(ass, /\[Script Info\]/);
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /PlayResY: 1080/);
  assert.match(ass, /Style: MainDialog,/);
  assert.match(ass, /Style: Note,/);
  assert.match(ass, /Style: Watermark,/);
  assert.match(ass, /\[Events\]/);
});

test("buildMultiTrackAss 三层 Dialogue 各用对应 Style", () => {
  const ass = buildMultiTrackAss({
    width: 1920,
    height: 1080,
    tracks: [
      { layer: 0, startSec: 0, endSec: 5, text: "主字幕" },
      { layer: 1, startSec: 0, endSec: 3, text: "辅助注释" },
      { layer: 2, startSec: 0, endSec: 30, text: "第 1 集" },
    ],
  });
  // Layer 0 → MainDialog
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:05\.00,MainDialog,.*主字幕/);
  // Layer 1 → Note
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:03\.00,Note,.*辅助注释/);
  // Layer 2 → Watermark
  assert.match(ass, /Dialogue: 2,0:00:00\.00,0:00:30\.00,Watermark,.*第 1 集/);
});

test("buildMultiTrackAssConvenient — watermark 持续整段", () => {
  const ass = buildMultiTrackAssConvenient({
    width: 1920,
    height: 1080,
    mainDialog: [
      { startSec: 0, endSec: 5, text: "对白 1" },
      { startSec: 5, endSec: 10, text: "对白 2" },
    ],
    notes: [
      { startSec: 0, endSec: 5, text: "注释 1" },
    ],
    watermarkText: "第 1 集",
    totalDurationSec: 10,
  });
  // 主字幕 layer 0
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:05\.00,MainDialog,.*对白 1/);
  assert.match(ass, /Dialogue: 0,0:00:05\.00,0:00:10\.00,MainDialog,.*对白 2/);
  // 注释 layer 1
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:05\.00,Note,.*注释 1/);
  // 角标 layer 2 — 0 到 totalDurationSec
  assert.match(ass, /Dialogue: 2,0:00:00\.00,0:00:10\.00,Watermark,.*第 1 集/);
});

test("buildMultiTrackAss 起始 >= 结束的 track 被丢弃", () => {
  const ass = buildMultiTrackAss({
    width: 1920,
    height: 1080,
    tracks: [
      { layer: 0, startSec: 5, endSec: 5, text: "0 duration" },
      { layer: 0, startSec: 10, endSec: 8, text: "negative" },
      { layer: 0, startSec: 0, endSec: 3, text: "有效" },
    ],
  });
  assert.ok(ass.includes("有效"));
  assert.ok(!ass.includes("0 duration"));
  assert.ok(!ass.includes("negative"));
});

test("buildMultiTrackAssConvenient 不给 watermark 不输出 layer 2", () => {
  const ass = buildMultiTrackAssConvenient({
    width: 1920,
    height: 1080,
    mainDialog: [{ startSec: 0, endSec: 5, text: "对白" }],
  });
  assert.ok(!ass.includes(",Watermark,"));
  assert.ok(ass.includes("MainDialog"));
});
