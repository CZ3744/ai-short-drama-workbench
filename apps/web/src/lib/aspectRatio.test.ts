import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ComposeSchema } from "../../../server/src/api/v2/validators";
import { aspectRatioToPresetId, normalizeAspectRatio, seriesAspectToCss } from "./aspectRatio";

const presets = JSON.parse(readFileSync(path.join(process.cwd(), "config/presets/aspect_ratio.json"), "utf8")).options as Array<{ id: string; width: number; height: number }>;

test("every distributed aspect preset round-trips through the selector and accepted compose request", () => {
  assert.ok(presets.length >= 5);
  for (const preset of presets) {
    const ratio = normalizeAspectRatio(preset.id);
    assert.ok(ratio, preset.id);
    assert.equal(aspectRatioToPresetId(ratio), preset.id);
    assert.ok(ComposeSchema.safeParse({ aspect_ratio: ratio }).success, preset.id);
    const [width, height] = seriesAspectToCss(ratio).split("/").map(Number);
    assert.equal(width / height, preset.width / preset.height, preset.id);
  }
});

test("stored API, legacy preset and CSS values describe the same screen geometry", () => {
  for (const value of ["16:9", "16x9", "16/9", " 1920 : 1080 "]) {
    assert.equal(normalizeAspectRatio(value), "16:9");
    assert.equal(aspectRatioToPresetId(value), "16x9");
    assert.equal(seriesAspectToCss(value), "16/9");
  }
  assert.equal(normalizeAspectRatio("2.39:1"), "239:100");
  assert.ok(ComposeSchema.safeParse({ aspect_ratio: normalizeAspectRatio("2.39:1") }).success);
  assert.equal(seriesAspectToCss("2.39:1"), "239/100");
});

test("malformed or unsupported ratios cannot become compose parameters or CSS", () => {
  for (const value of [null, undefined, "", "0:16", "16:-9", "16:9:1", "16x9;script", "1e2:9", "Infinity:9", "100000:1", "1:0.000001"]) {
    assert.equal(normalizeAspectRatio(value), undefined, String(value));
    assert.equal(aspectRatioToPresetId(value), undefined, String(value));
    assert.equal(seriesAspectToCss(value, "9/16"), "9/16", String(value));
  }
});
