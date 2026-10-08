// W7 Phase 2 单测:transitions.ts xfade chain 构造 + 规范化

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTransition,
  buildXfadeFilterChain,
  hasAnyXfade,
} from "../transitions";

test("normalizeTransition 兼容旧字段 / 中文 / 未知值兜底 hard", () => {
  // 英文
  assert.equal(normalizeTransition("fade"), "fade");
  assert.equal(normalizeTransition("dissolve"), "crossfade");
  assert.equal(normalizeTransition("crossfade"), "crossfade");
  assert.equal(normalizeTransition("wipe"), "wipe-left");
  assert.equal(normalizeTransition("wipe-up"), "wipe-up");
  assert.equal(normalizeTransition("hard"), "hard");
  // 中文(ShotStagePage TRANSITION_OPTIONS)
  assert.equal(normalizeTransition("硬切"), "hard");
  assert.equal(normalizeTransition("淡入"), "fade");
  assert.equal(normalizeTransition("淡出"), "fade");
  assert.equal(normalizeTransition("叠化"), "crossfade");
  assert.equal(normalizeTransition("划像"), "wipe-left");
  // 推/拉 没有原生 xfade,降级 hard
  assert.equal(normalizeTransition("推镜接"), "hard");
  // 未知 / null / 空 → hard
  assert.equal(normalizeTransition(undefined), "hard");
  assert.equal(normalizeTransition(null), "hard");
  assert.equal(normalizeTransition(""), "hard");
  assert.equal(normalizeTransition("UnknownThing"), "hard");
});

test("normalizeTransition 映射 transition.json 全部 preset id(防 silent fallback hard)", () => {
  // config/presets/transition.json options[].id — 历史上 hard_cut / cross_dissolve / push
  // 缺 alias,被 silent fallback 成 hard,用户选"硬切/交叉溶解/推拉"全变硬切无察觉。
  assert.equal(normalizeTransition("fade"), "fade");
  assert.equal(normalizeTransition("hard_cut"), "hard");
  assert.equal(normalizeTransition("cross_dissolve"), "crossfade");
  assert.equal(normalizeTransition("push"), "wipe-left");
  assert.equal(normalizeTransition("none"), "hard");
  // 兜底路径 — 未识别 / undefined / 空串 → hard
  assert.equal(normalizeTransition("NotARealPreset"), "hard");
  assert.equal(normalizeTransition(undefined), "hard");
  assert.equal(normalizeTransition(""), "hard");
  // label_zh 也走得通(用户/LLM 可能直接存中文)
  assert.equal(normalizeTransition("淡入淡出"), "fade");
  assert.equal(normalizeTransition("交叉溶解"), "crossfade");
  assert.equal(normalizeTransition("推拉"), "wipe-left");
});

test("buildXfadeFilterChain 单镜直接输出 [0:v]", () => {
  const chain = buildXfadeFilterChain([
    { durationSec: 5, transitionToNext: "hard" },
  ]);
  assert.equal(chain.filterComplex, "");
  assert.equal(chain.outputLabel, "[0:v]");
  assert.equal(chain.totalDurationSec, 5);
});

test("buildXfadeFilterChain 两段 fade 转场", () => {
  const chain = buildXfadeFilterChain([
    { durationSec: 4, transitionToNext: "fade", transitionDurationSec: 0.5 },
    { durationSec: 6, transitionToNext: "hard" },
  ]);
  // 期望:[0:v][1:v]xfade=transition=fade:duration=0.500:offset=3.500[vout]
  assert.match(chain.filterComplex, /\[0:v\]\[1:v\]xfade=transition=fade:duration=0\.500:offset=3\.500\[vout\]/);
  assert.equal(chain.outputLabel, "[vout]");
  // 总时长 = 4 + 6 - 0.5 = 9.5
  assert.equal(chain.totalDurationSec, 9.5);
});

test("buildXfadeFilterChain 三段链路 — 中间转场不同类型", () => {
  const chain = buildXfadeFilterChain([
    { durationSec: 3, transitionToNext: "crossfade", transitionDurationSec: 0.5 },
    { durationSec: 4, transitionToNext: "wipe-left", transitionDurationSec: 0.5 },
    { durationSec: 5, transitionToNext: "hard" },
  ]);
  // 第一个 xfade:[0:v][1:v]xfade=transition=dissolve:duration=0.500:offset=2.500[v1]
  // 第二个 xfade:[v1][2:v]xfade=transition=wipeleft:duration=0.500:offset=6.000[vout]
  assert.match(chain.filterComplex, /\[0:v\]\[1:v\]xfade=transition=dissolve:duration=0\.500:offset=2\.500\[v1\]/);
  assert.match(chain.filterComplex, /\[v1\]\[2:v\]xfade=transition=wipeleft:duration=0\.500:offset=6\.000\[vout\]/);
  assert.equal(chain.outputLabel, "[vout]");
});

test("hasAnyXfade 至少一对非 hard 转场返回 true", () => {
  assert.equal(hasAnyXfade([
    { durationSec: 3, transitionToNext: "hard" },
    { durationSec: 4, transitionToNext: "fade" },
    { durationSec: 5, transitionToNext: "hard" },
  ]), true);

  // 最后一段的 transitionToNext 不算
  assert.equal(hasAnyXfade([
    { durationSec: 3, transitionToNext: "hard" },
    { durationSec: 4, transitionToNext: "hard" },
    { durationSec: 5, transitionToNext: "fade" }, // 最后一段,无下一段
  ]), false);

  // 全 hard → false
  assert.equal(hasAnyXfade([
    { durationSec: 3, transitionToNext: "hard" },
    { durationSec: 4, transitionToNext: "hard" },
  ]), false);
});

test("buildXfadeFilterChain 空数组应 throw", () => {
  assert.throws(() => buildXfadeFilterChain([]), /segments 为空/);
});
