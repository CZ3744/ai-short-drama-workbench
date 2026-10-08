import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths";
import { PresetDictSchema, type PresetDict, type PresetOption } from "./presetSchema";

// --- Constants ---

const PRESETS_DIR = path.join(repoRoot, "config", "presets");

// All listed dicts serve as UI dropdown dictionaries for the series creation wizard.
// length.json / episode_count.json: used by CreationSettingsPanel dropdowns (length/num episodes).
// Not referenced by providers — purely user-facing preset catalogs.
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
  "count_per_retake.json",
  "scene_time_of_day.json",
  "scene_weather.json",
  "scene_lighting.json",
  "scene_ref_count.json",
  "transition.json",
  "consistency_scorer_provider.json",
] as const;

// --- In-memory store ---

const _dicts = new Map<string, PresetDict>();
let _loaded = false;
// 2026-05-17: 文件 mtime cache — preset JSON 改了 (e.g. 禁用 Wan / 加新 provider) 自动 reload
// 不用 fs.watchFile (跨 OS / file system 行为不稳, dev server tsx watch 也会发 false event).
// 每次 listPresets() 比 mtime, 改了就重读. 单次 fs.statSync 在 SSD 上 < 1ms, 接受.
const _fileMtimes = new Map<string, number>();

function loadOne(filename: string): void {
  const filePath = path.join(PRESETS_DIR, filename);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const result = PresetDictSchema.safeParse(parsed);
    if (result.success) {
      _dicts.set(result.data.id, result.data);
    } else {
      console.error(
        `[presets] Failed to validate ${filename}:`,
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
      );
    }
  } catch (err) {
    console.error(`[presets] Failed to load ${filename}:`, err);
  }
}

// --- Load all dictionaries on startup ---

function loadAll(): void {
  if (!_loaded) {
    for (const filename of DICT_FILENAMES) {
      const filePath = path.join(PRESETS_DIR, filename);
      try {
        _fileMtimes.set(filename, fs.statSync(filePath).mtimeMs);
      } catch { /* file 不存在初始 0 */ _fileMtimes.set(filename, 0); }
      loadOne(filename);
    }
    _loaded = true;
    return;
  }

  // 已加载过 → 检查 mtime 看哪些文件改了, 只 reload 变化的那些
  for (const filename of DICT_FILENAMES) {
    const filePath = path.join(PRESETS_DIR, filename);
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* skip */ }
    const cached = _fileMtimes.get(filename) ?? 0;
    if (mtime > cached) {
      console.log(`[presets] ${filename} 改了 (mtime ${cached.toFixed(0)} → ${mtime.toFixed(0)}), 热重载`);
      _fileMtimes.set(filename, mtime);
      loadOne(filename);
    }
  }
}

// --- Public API ---

/**
 * Get a single option from a dictionary by its option id.
 * Returns undefined if dict or option not found.
 */
export function getPreset(dictId: string, optionId: string): PresetOption | undefined {
  loadAll();
  const dict = _dicts.get(dictId);
  if (!dict) return undefined;
  return dict.options.find((o) => o.id === optionId);
}

/**
 * List all options in a dictionary (including disabled ones).
 * Returns empty array if dict not found.
 */
export function listPresets(dictId: string): PresetOption[] {
  loadAll();
  const dict = _dicts.get(dictId);
  if (!dict) return [];
  return dict.options;
}

/**
 * Get a single option, throw if dict or option not found.
 */
export function requirePreset(dictId: string, optionId: string): PresetOption {
  loadAll();
  const option = getPreset(dictId, optionId);
  if (!option) {
    const dict = _dicts.get(dictId);
    if (!dict) {
      throw new Error(`Preset dictionary "${dictId}" not found`);
    }
    throw new Error(
      `Preset option "${optionId}" not found in dictionary "${dictId}". Available: ${dict.options.map((o) => o.id).join(", ")}`
    );
  }
  return option;
}

/**
 * Get the default option for a dictionary.
 * Returns undefined if dict not found or no default set.
 */
export function getDefaultPreset(dictId: string): PresetOption | undefined {
  loadAll();
  const dict = _dicts.get(dictId);
  if (!dict) return undefined;
  return dict.options.find((o) => o.default);
}

/**
 * List all loaded dictionary ids.
 */
export function listDictIds(): string[] {
  loadAll();
  return Array.from(_dicts.keys());
}

/**
 * Force reload (for testing / hot-reload).
 */
export function reloadPresets(): void {
  _dicts.clear();
  _loaded = false;
  loadAll();
}
