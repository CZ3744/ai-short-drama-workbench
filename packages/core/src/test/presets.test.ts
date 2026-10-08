import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../paths";
import { PresetDictSchema } from "../presetSchema";
import { getPreset, listPresets, requirePreset, getDefaultPreset, listDictIds, reloadPresets } from "../presets";

// --- Helper ---

const PRESETS_DIR = path.join(repoRoot, "config", "presets");

const DICT_FILENAMES = [
  "content_type.json",
  "platform.json",
  "aspect_ratio.json",
  "visual_style.json",
  "audience.json",
  "tone.json",
  "length.json",
  "episode_count.json",
  "pacing.json",
  "camera_style.json",
  "ending_type.json",
  "shot_type.json",
  "camera_movement.json",
  "llm_provider.json",
  "image_provider.json",
  "video_provider.json",
  "tts_provider.json",
  "tts_voice.json",
  "bgm_mood.json",
  "subtitle_style.json",
];

// --- Tests ---

describe("Preset Dictionaries", () => {
  // Force fresh load for tests
  reloadPresets();

  describe("Zod validation", () => {
    for (const filename of DICT_FILENAMES) {
      it(`should parse ${filename} without zod errors`, () => {
        const filePath = path.join(PRESETS_DIR, filename);
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        const result = PresetDictSchema.safeParse(parsed);
        if (!result.success) {
          const issues = result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("\n");
          assert.fail(`Zod validation failed for ${filename}:\n${issues}`);
        }
        assert.ok(result.success);
      });
    }
  });

  describe("Option count", () => {
    for (const filename of DICT_FILENAMES) {
      it(`should have at least 2 options in ${filename}`, () => {
        const filePath = path.join(PRESETS_DIR, filename);
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as { id: string; options: unknown[] };
        assert.ok(
          parsed.options.length >= 2,
          `${filename} has only ${parsed.options.length} options (need >= 2)`
        );
      });
    }
  });

  describe("Unique option IDs within each dict", () => {
    for (const filename of DICT_FILENAMES) {
      it(`should have unique option ids in ${filename}`, () => {
        const filePath = path.join(PRESETS_DIR, filename);
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as { id: string; options: { id: string }[] };
        const ids = parsed.options.map((o) => o.id);
        const unique = new Set(ids);
        assert.equal(
          ids.length,
          unique.size,
          `Duplicate option ids found in ${filename}: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`
        );
      });
    }
  });

  describe("video_provider requires_reference consistency", () => {
    it("should not have requires_reference=true with mode=t2v", () => {
      const filePath = path.join(PRESETS_DIR, "video_provider.json");
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        options: { id: string; requires_reference?: boolean; mode?: string }[];
      };
      for (const opt of parsed.options) {
        if (opt.requires_reference === true && opt.mode === "t2v") {
          assert.fail(
            `Option "${opt.id}" has requires_reference=true but mode="t2v" (contradictory)`
          );
        }
      }
    });
  });

  describe("Default validation", () => {
    for (const filename of DICT_FILENAMES) {
      it(`should have exactly one default in ${filename}`, () => {
        const filePath = path.join(PRESETS_DIR, filename);
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as { options: { id: string; default: boolean }[] };
        const defaults = parsed.options.filter((o) => o.default === true);
        assert.equal(
          defaults.length,
          1,
          `${filename} has ${defaults.length} defaults (expected 1). IDs: ${defaults.map((d) => d.id).join(", ")}`
        );
      });
    }
  });

  describe("API functions", () => {
    it("getPreset should return valid option", () => {
      const opt = getPreset("content_type", "anime_drama");
      assert.ok(opt);
      assert.equal(opt!.id, "anime_drama");
      assert.equal(opt!.label_zh, "漫剧");
    });

    it("getPreset should return undefined for missing dict", () => {
      const opt = getPreset("nonexistent_dict", "some_id");
      assert.equal(opt, undefined);
    });

    it("getPreset should return undefined for missing option", () => {
      const opt = getPreset("content_type", "nonexistent_option");
      assert.equal(opt, undefined);
    });

    it("listPresets should return all options", () => {
      const opts = listPresets("visual_style");
      assert.ok(opts.length >= 20);
    });

    it("listPresets should return empty array for missing dict", () => {
      const opts = listPresets("nonexistent_dict");
      assert.deepEqual(opts, []);
    });

    it("requirePreset should return valid option", () => {
      const opt = requirePreset("video_provider", "kling_3");
      assert.ok(opt);
      assert.equal(opt!.id, "kling_3");
    });

    it("requirePreset should throw for missing dict", () => {
      assert.throws(() => requirePreset("nonexistent_dict", "some_id"));
    });

    it("requirePreset should throw for missing option", () => {
      assert.throws(() => requirePreset("content_type", "nonexistent"));
    });

    it("getDefaultPreset should return the default option", () => {
      const opt = getDefaultPreset("platform");
      assert.ok(opt);
      assert.equal(opt!.id, "douyin");
    });

    it("listDictIds should return all dict ids", () => {
      const ids = listDictIds();
      assert.equal(ids.length, 27); // 27 preset files in config/presets/
    });
  });
});
