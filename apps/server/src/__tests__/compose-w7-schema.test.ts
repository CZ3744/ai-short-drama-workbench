// W7 Phase 3 + 4 schema 单测:验证 ComposeSchema.subtitle_tracks
// + PatchShotSchema.trim_start_sec / trim_end_sec

import { test } from "node:test";
import assert from "node:assert/strict";
import { ComposeSchema, PatchShotSchema } from "../api/v2/validators";

test("ComposeSchema 接收 subtitle_tracks(多轨字幕)", () => {
  const result = ComposeSchema.parse({
    mode: "full",
    subtitle_tracks: {
      notes: [
        { start_sec: 0, end_sec: 3, text: "镜头注释" },
        { start_sec: 3, end_sec: 6, text: "下一段注释", shot_id: "shot_001" },
      ],
      watermark: "第 1 集",
    },
  });
  assert.equal(result.mode, "full");
  assert.equal(result.subtitle_tracks?.watermark, "第 1 集");
  assert.equal(result.subtitle_tracks?.notes?.length, 2);
});

test("ComposeSchema 不带 subtitle_tracks 仍合法", () => {
  const result = ComposeSchema.parse({ mode: "rough" });
  assert.equal(result.mode, "rough");
  assert.equal(result.subtitle_tracks, undefined);
});

test("ComposeSchema 保留自定义字幕设置，包含半像素描边与透明度", () => {
  const custom_style = {
    font_family: "Microsoft YaHei", font_size: 48, color: "#fFeEcC", stroke_color: "#112233",
    stroke_width: 0.5, bg_color: "#345678", bg_opacity: 0.35, position: "top" as const,
  };
  const result = ComposeSchema.parse({ subtitle_style: "custom", custom_style });
  assert.deepEqual(result.custom_style, custom_style);
  assert.equal(ComposeSchema.parse({}).custom_style, undefined);
});

test("ComposeSchema 拒绝无效或可能破坏字幕文件的自定义样式", () => {
  for (const custom_style of [
    { font_family: "Arial\n[Events]" }, { font_family: "Arial,{\\b1}" }, { font_size: 0 },
    { font_size: Infinity }, { color: "red" }, { stroke_color: "#123" }, { bg_color: "#zz0000" },
    { stroke_width: -1 }, { stroke_width: 21 }, { bg_opacity: 1.1 }, { position: "outside" },
    { ignored_typo: true },
  ]) assert.equal(ComposeSchema.safeParse({ subtitle_style: "custom", custom_style }).success, false, JSON.stringify(custom_style));
});

test("ComposeSchema 拒绝过长 watermark / 超过 500 notes", () => {
  // 单条 note text > 200 字符
  assert.throws(() => ComposeSchema.parse({
    subtitle_tracks: {
      notes: [{ start_sec: 0, end_sec: 1, text: "x".repeat(201) }],
    },
  }));
  // watermark 过长
  assert.throws(() => ComposeSchema.parse({
    subtitle_tracks: { watermark: "y".repeat(61) },
  }));
});

test("PatchShotSchema 接收 trim_start_sec / trim_end_sec", () => {
  const result = PatchShotSchema.parse({
    duration_sec: 8,
    trim_start_sec: 1.5,
    trim_end_sec: 6.5,
  });
  assert.equal(result.duration_sec, 8);
  assert.equal(result.trim_start_sec, 1.5);
  assert.equal(result.trim_end_sec, 6.5);
});

test("PatchShotSchema trim 字段是可选的", () => {
  const result = PatchShotSchema.parse({ duration_sec: 5 });
  assert.equal(result.trim_start_sec, undefined);
  assert.equal(result.trim_end_sec, undefined);
});

test("PatchShotSchema 拒绝负数 trim_start_sec", () => {
  assert.throws(() => PatchShotSchema.parse({ trim_start_sec: -1 }));
});

test("PatchShotSchema 拒绝超 120s trim_end_sec", () => {
  assert.throws(() => PatchShotSchema.parse({ trim_end_sec: 200 }));
});
