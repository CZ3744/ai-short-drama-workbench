/**
 * Global Library — Cross-series character/scene asset library.
 *
 * Disk layout:
 *   data/library/
 *   ├── index.json
 *   ├── characters/<id>/
 *   │   ├── meta.json
 *   │   ├── refs/ref_<ulid>.png
 *   │   ├── locked.png
 *   │   └── locked.json
 *   ├── scenes/<id>/   (same structure)
 *   └── _trash/
 *
 * All write operations use atomicWrite (write .tmp, then rename).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import { DATA_ROOT, pathExists, readJson, writeJson, ensureDir } from "../../core/src/index";
import { CURRENT_SCHEMA_VERSION } from "./jsonlIndex.js";

// ─── Paths ─────────────────────────────────────────────────────────────

const LIBRARY_ROOT = path.join(DATA_ROOT, "library");
const INDEX_PATH = path.join(LIBRARY_ROOT, "index.json");
const CHARACTERS_DIR = path.join(LIBRARY_ROOT, "characters");
const SCENES_DIR = path.join(LIBRARY_ROOT, "scenes");
const TRASH_DIR = path.join(LIBRARY_ROOT, "_trash");

// ─── Types ─────────────────────────────────────────────────────────────

export interface LibraryCharacter {
  id: string;
  name: string;
  tags: string[];
  usage_count: number;
  thumb_path: string;
}

export interface LibraryScene {
  id: string;
  name: string;
  tags: string[];
  usage_count: number;
  thumb_path: string;
}

export interface VoiceStyleMap {
  default?: string;
  crying?: string;
  angry?: string;
  cold?: string;
  laugh?: string;
  [emotion: string]: string | undefined;
}

export interface LibraryCharacterMeta {
  id: string;
  name: string;
  appearance: string;
  personality: string;
  tags: string[];
  voice_id?: string;
  voice_style_map?: VoiceStyleMap;
  created_at: string;
  updated_at: string;
}

export interface LibrarySceneMeta {
  id: string;
  name: string;
  description: string;
  visual_style?: string;
  location?: string;
  time_of_day?: string;
  mood?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface RefEntry {
  ref_id: string;
  filename: string;
}

export interface RefResult {
  ref_id: string;
  path: string;
  url: string;
}

export interface LockResult {
  ref_id: string;
  seed?: number;
  model?: string;
  prompt: string;
  locked_at: string;
}

export interface LockData {
  ref_id: string;
  seed?: number;
  model?: string;
  prompt: string;
  locked_at: string;
}

// ─── Variant Types ──────────────────────────────────────────────────────

export type VariantCategory = "outfit" | "emotion" | "pose" | "other" | "time_of_day" | "weather";

export interface CharacterVariant {
  id: string;
  label: string;
  category: VariantCategory;
  vault_id: string;
  parent: "locked" | string;
  /**
   * 2026-05-20: 字段名从 user_note 改为 display_name (display_name 体系统一).
   * 历史 user_note 数据由 listCharacterVariants 读时映射进 display_name.
   */
  display_name: string;
  /** @deprecated 2026-05-20 兼容老数据: 读时映射到 display_name, 不再新写. */
  user_note?: string;
  created_at: string;
}

export interface SceneVariant {
  id: string;
  label: string;
  category: VariantCategory;
  vault_id: string;
  parent: "locked" | string;
  /**
   * 2026-05-20: 字段名从 user_note 改为 display_name (display_name 体系统一).
   * 历史 user_note 数据由 listSceneVariants 读时映射进 display_name.
   */
  display_name: string;
  /** @deprecated 2026-05-20 兼容老数据: 读时映射到 display_name, 不再新写. */
  user_note?: string;
  created_at: string;
}

export interface LibraryCharacterDetail extends LibraryCharacterMeta {
  refs: RefEntry[];
  locked?: LockResult;
}

export interface LibrarySceneDetail extends LibrarySceneMeta {
  refs: RefEntry[];
  locked?: LockResult;
}

interface LibraryIndex {
  characters: LibraryCharacter[];
  scenes: LibraryScene[];
  schema_version: number;
}

// ─── GenerateFn type ───────────────────────────────────────────────────

/**
 * Callback that generates `count` PNG images for a given prompt.
 * Returns buffers — actual provider calls happen in the controller.
 */
export type GenerateFn = (prompt: string, count: number) => Promise<Buffer[]>;

export interface AutoPackResult<V = CharacterVariant | SceneVariant> {
  variants: V[];
  succeeded: number;
  failed: number;
}

/** Write JSON with schema_version injected. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeVersionedJson(filePath: string, value: any): Promise<void> {
  await writeJson(filePath, { ...value, schema_version: CURRENT_SCHEMA_VERSION });
}

// ─── Index helpers ─────────────────────────────────────────────────────

async function ensureLibraryRoot(): Promise<void> {
  if (!(await pathExists(LIBRARY_ROOT))) {
    await ensureDir(LIBRARY_ROOT);
    await ensureDir(CHARACTERS_DIR);
    await ensureDir(SCENES_DIR);
    await ensureDir(TRASH_DIR);
    const initialIndex: LibraryIndex = { characters: [], scenes: [], schema_version: CURRENT_SCHEMA_VERSION };
    await writeJson(INDEX_PATH, initialIndex);
  }
}

async function readIndex(): Promise<LibraryIndex> {
  await ensureLibraryRoot();
  return (await readJson<LibraryIndex>(INDEX_PATH)) ?? { characters: [] as LibraryCharacter[], scenes: [] as LibraryScene[], schema_version: 1 } as LibraryIndex;
}

async function writeIndex(idx: LibraryIndex): Promise<void> {
  await writeJson(INDEX_PATH, idx);
}

// ─── Character entity paths ────────────────────────────────────────────

function charDir(id: string): string {
  return path.join(CHARACTERS_DIR, id);
}

function charMetaPath(id: string): string {
  return path.join(charDir(id), "meta.json");
}

function charRefsDir(id: string): string {
  return path.join(charDir(id), "refs");
}

function charLockedPngPath(id: string): string {
  return path.join(charDir(id), "locked.png");
}

function charLockedJsonPath(id: string): string {
  return path.join(charDir(id), "locked.json");
}

function charTrashDir(id: string): string {
  return path.join(TRASH_DIR, `char_${id}_${Date.now()}`);
}

// ─── Scene entity paths ────────────────────────────────────────────────

function sceneDir(id: string): string {
  return path.join(SCENES_DIR, id);
}

function sceneMetaPath(id: string): string {
  return path.join(sceneDir(id), "meta.json");
}

function sceneRefsDir(id: string): string {
  return path.join(sceneDir(id), "refs");
}

function sceneLockedPngPath(id: string): string {
  return path.join(sceneDir(id), "locked.png");
}

function sceneLockedJsonPath(id: string): string {
  return path.join(sceneDir(id), "locked.json");
}

function sceneTrashDir(id: string): string {
  return path.join(TRASH_DIR, `scene_${id}_${Date.now()}`);
}

// ─── Variant path helpers ──────────────────────────────────────────────

function charVariantsDir(id: string): string {
  return path.join(charDir(id), "variants");
}

function charVariantPath(id: string, varId: string): string {
  return path.join(charVariantsDir(id), `${varId}.json`);
}

function sceneVariantsDir(id: string): string {
  return path.join(sceneDir(id), "variants");
}

function sceneVariantPath(id: string, varId: string): string {
  return path.join(sceneVariantsDir(id), `${varId}.json`);
}

// ─── List refs ─────────────────────────────────────────────────────────

async function listRefs(refsDir: string): Promise<RefEntry[]> {
  if (!(await pathExists(refsDir))) return [];
  const entries = await fs.readdir(refsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.startsWith("ref_") && e.name.endsWith(".png"))
    .map((e) => ({
      ref_id: e.name.replace(/^ref_/, "").replace(/\.png$/, ""),
      filename: e.name,
    }));
}

async function readLockedJson(id: string, lockedJsonPath: string): Promise<LockResult | undefined> {
  if (!(await pathExists(lockedJsonPath))) return undefined;
  const data = await readJson<LockData>(lockedJsonPath);
  if (!data) return undefined;
  // If locked.png is missing, the lock is stale
  const lockedPngPath = path.join(path.dirname(lockedJsonPath), "locked.png");
  if (!(await pathExists(lockedPngPath))) return undefined;
  return {
    ref_id: data.ref_id,
    seed: data.seed,
    model: data.model,
    prompt: data.prompt,
    locked_at: data.locked_at,
  };
}

// ─── Characters ────────────────────────────────────────────────────────

export async function listLibraryCharacters(): Promise<LibraryCharacter[]> {
  const idx = await readIndex();
  return Promise.all(
    idx.characters.map(async (entry) => ({
      ...entry,
      thumb_path: (await pathExists(charLockedPngPath(entry.id)))
        ? `/api/v2/library/characters/${entry.id}/locked.png`
        : "",
    })),
  );
}

export async function getLibraryCharacter(id: string): Promise<LibraryCharacterDetail | null> {
  const metaPath = charMetaPath(id);
  if (!(await pathExists(metaPath))) return null;

  const meta = await readJson<LibraryCharacterMeta>(metaPath);
  if (!meta) return null;
  const refs = await listRefs(charRefsDir(id));
  const locked = await readLockedJson(id, charLockedJsonPath(id));

  return { ...meta, refs, locked } as LibraryCharacterDetail;
}

export async function createLibraryCharacter(
  data: { name: string; appearance: string; personality: string; tags?: string[]; voice_id?: string; voice_style_map?: VoiceStyleMap },
): Promise<LibraryCharacter> {
  const id = ulid();
  const now = new Date().toISOString();
  const tags = data.tags ?? [];

  // Create character directory and write meta.json
  await ensureDir(charDir(id));
  const meta: LibraryCharacterMeta = {
    id,
    name: data.name,
    appearance: data.appearance,
    personality: data.personality,
    tags,
    voice_id: data.voice_id,
    voice_style_map: data.voice_style_map,
    created_at: now,
    updated_at: now,
  };
  await writeVersionedJson(charMetaPath(id), meta);

  // Update index
  const idx = await readIndex();
  const entry: LibraryCharacter = {
    id,
    name: data.name,
    tags,
    usage_count: 0,
    thumb_path: "",
  };
  idx.characters.push(entry);
  await writeIndex(idx);

  return entry;
}

export async function updateLibraryCharacter(
  id: string,
  patch: Partial<Pick<LibraryCharacterMeta, "name" | "appearance" | "personality" | "tags" | "voice_id" | "voice_style_map">>,
): Promise<LibraryCharacter | null> {
  const metaPath = charMetaPath(id);
  if (!(await pathExists(metaPath))) return null;

  const meta = await readJson<LibraryCharacterMeta>(metaPath);
  if (!meta) return null;
  const updated: LibraryCharacterMeta = {
    ...meta,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.appearance !== undefined ? { appearance: patch.appearance } : {}),
    ...(patch.personality !== undefined ? { personality: patch.personality } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.voice_id !== undefined ? { voice_id: patch.voice_id } : {}),
    ...(patch.voice_style_map !== undefined ? { voice_style_map: patch.voice_style_map } : {}),
    updated_at: new Date().toISOString(),
  };
  await writeVersionedJson(metaPath, updated);

  // Update index entry
  const idx = await readIndex();
  const idxEntry = idx.characters.find((c) => c.id === id);
  if (idxEntry) {
    if (patch.name !== undefined) idxEntry.name = patch.name;
    if (patch.tags !== undefined) idxEntry.tags = patch.tags;
    await writeIndex(idx);
  }

  return idx.characters.find((c) => c.id === id) ?? null;
}

export async function deleteLibraryCharacter(id: string): Promise<boolean> {
  const metaPath = charMetaPath(id);
  if (!(await pathExists(metaPath))) return false;

  const trashTarget = charTrashDir(id);
  await ensureDir(TRASH_DIR);

  // Move character directory to _trash
  try {
    await fs.rename(charDir(id), trashTarget);
  } catch {
    // Fallback: copy then delete (cross-device move may fail on Windows)
    await copyDir(charDir(id), trashTarget);
    await fs.rm(charDir(id), { recursive: true, force: true });
  }

  // Remove from index
  const idx = await readIndex();
  idx.characters = idx.characters.filter((c) => c.id !== id);
  await writeIndex(idx);

  return true;
}

// Wave P (2026-05-20): generateLibraryRefs 删除 — 唯一 caller (libraryController
// generate-refs route) 已删, 改走 /api/v2/generate/image (target.kind="library_variant").

export async function lockLibraryCharacter(
  id: string,
  refId: string,
): Promise<LockResult> {
  const metaPath = charMetaPath(id);
  if (!(await pathExists(metaPath))) {
    throw Object.assign(new Error("角色不存在"), { status: 404 });
  }

  const refsDir = charRefsDir(id);
  const refFilename = `ref_${refId}.png`;
  const refPath = path.join(refsDir, refFilename);

  if (!(await pathExists(refPath))) {
    throw Object.assign(new Error("参考图不存在"), { status: 404 });
  }

  const lockedPngPath = charLockedPngPath(id);
  const lockedJsonPath = charLockedJsonPath(id);

  // Copy ref to locked.png (atomic)
  const refBuf = await fs.readFile(refPath);
  const tmpPngPath = lockedPngPath + ".tmp";
  await fs.writeFile(tmpPngPath, refBuf);
  await fs.rename(tmpPngPath, lockedPngPath);

  // Write locked.json (atomic)
  const lockedData: LockData = {
    ref_id: refId,
    prompt: "",
    locked_at: new Date().toISOString(),
  };
  await writeVersionedJson(lockedJsonPath, lockedData);

  return {
    ref_id: refId,
    prompt: "",
    locked_at: lockedData.locked_at,
  };
}

export async function getLibraryCharacterLockedPng(id: string): Promise<Buffer | null> {
  const pngPath = charLockedPngPath(id);
  if (!(await pathExists(pngPath))) return null;
  return fs.readFile(pngPath);
}

export async function getLibraryCharacterRefBuffer(
  id: string,
  refId: string,
): Promise<Buffer | null> {
  const refPath = path.join(charRefsDir(id), `ref_${refId}.png`);
  if (!(await pathExists(refPath))) return null;
  return fs.readFile(refPath);
}

// ─── Scenes ────────────────────────────────────────────────────────────

export async function listLibraryScenes(): Promise<LibraryScene[]> {
  const idx = await readIndex();
  return Promise.all(
    idx.scenes.map(async (entry) => ({
      ...entry,
      thumb_path: (await pathExists(sceneLockedPngPath(entry.id)))
        ? `/api/v2/library/scenes/${entry.id}/locked.png`
        : "",
    })),
  );
}

export async function getLibraryScene(id: string): Promise<LibrarySceneDetail | null> {
  const metaPath = sceneMetaPath(id);
  if (!(await pathExists(metaPath))) return null;

  const meta = await readJson<LibrarySceneMeta>(metaPath);
  if (!meta) return null;
  const refs = await listRefs(sceneRefsDir(id));
  const locked = await readLockedJson(id, sceneLockedJsonPath(id));

  return { ...meta, refs, locked } as LibrarySceneDetail;
}

export async function createLibraryScene(
  data: { name: string; description: string; visual_style?: string; location?: string; time_of_day?: string; mood?: string; tags?: string[] },
): Promise<LibraryScene> {
  const id = ulid();
  const now = new Date().toISOString();
  const tags = data.tags ?? [];

  await ensureDir(sceneDir(id));
  const meta: LibrarySceneMeta = {
    id,
    name: data.name,
    description: data.description,
    visual_style: data.visual_style,
    location: data.location,
    time_of_day: data.time_of_day,
    mood: data.mood,
    tags,
    created_at: now,
    updated_at: now,
  };
  await writeVersionedJson(sceneMetaPath(id), meta);

  const idx = await readIndex();
  const entry: LibraryScene = {
    id,
    name: data.name,
    tags,
    usage_count: 0,
    thumb_path: "",
  };
  idx.scenes.push(entry);
  await writeIndex(idx);

  return entry;
}

export async function updateLibraryScene(
  id: string,
  patch: Partial<Pick<LibrarySceneMeta, "name" | "description" | "visual_style" | "location" | "time_of_day" | "mood" | "tags">>,
): Promise<LibraryScene | null> {
  const metaPath = sceneMetaPath(id);
  if (!(await pathExists(metaPath))) return null;

  const meta = await readJson<LibrarySceneMeta>(metaPath);
  if (!meta) return null;
  const updated: LibrarySceneMeta = {
    ...meta,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await writeVersionedJson(metaPath, updated);

  const idx = await readIndex();
  const idxEntry = idx.scenes.find((s) => s.id === id);
  if (idxEntry) {
    if (patch.name !== undefined) idxEntry.name = patch.name;
    if (patch.tags !== undefined) idxEntry.tags = patch.tags;
    await writeIndex(idx);
  }

  return idx.scenes.find((s) => s.id === id) ?? null;
}

export async function deleteLibraryScene(id: string): Promise<boolean> {
  const metaPath = sceneMetaPath(id);
  if (!(await pathExists(metaPath))) return false;

  const trashTarget = sceneTrashDir(id);
  await ensureDir(TRASH_DIR);

  try {
    await fs.rename(sceneDir(id), trashTarget);
  } catch {
    await copyDir(sceneDir(id), trashTarget);
    await fs.rm(sceneDir(id), { recursive: true, force: true });
  }

  const idx = await readIndex();
  idx.scenes = idx.scenes.filter((s) => s.id !== id);
  await writeIndex(idx);

  return true;
}

// Wave P (2026-05-20): generateLibrarySceneRefs 删除 — 唯一 caller 已删, 走统一端点.

export async function lockLibraryScene(
  id: string,
  refId: string,
): Promise<LockResult> {
  const metaPath = sceneMetaPath(id);
  if (!(await pathExists(metaPath))) {
    throw Object.assign(new Error("场景不存在"), { status: 404 });
  }

  const refsDir = sceneRefsDir(id);
  const refFilename = `ref_${refId}.png`;
  const refPath = path.join(refsDir, refFilename);

  if (!(await pathExists(refPath))) {
    throw Object.assign(new Error("参考图不存在"), { status: 404 });
  }

  const lockedPngPath = sceneLockedPngPath(id);
  const lockedJsonPath = sceneLockedJsonPath(id);

  const refBuf = await fs.readFile(refPath);
  const tmpPngPath = lockedPngPath + ".tmp";
  await fs.writeFile(tmpPngPath, refBuf);
  await fs.rename(tmpPngPath, lockedPngPath);

  const lockedData: LockData = {
    ref_id: refId,
    prompt: "",
    locked_at: new Date().toISOString(),
  };
  await writeVersionedJson(lockedJsonPath, lockedData);

  return {
    ref_id: refId,
    prompt: "",
    locked_at: lockedData.locked_at,
  };
}

export async function getLibrarySceneLockedPng(id: string): Promise<Buffer | null> {
  const pngPath = sceneLockedPngPath(id);
  if (!(await pathExists(pngPath))) return null;
  return fs.readFile(pngPath);
}

export async function getLibrarySceneRefBuffer(
  id: string,
  refId: string,
): Promise<Buffer | null> {
  const refPath = path.join(sceneRefsDir(id), `ref_${refId}.png`);
  if (!(await pathExists(refPath))) return null;
  return fs.readFile(refPath);
}

// ─── Utility ───────────────────────────────────────────────────────────

/**
 * Recursive directory copy fallback for cross-device moves on Windows.
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// ─── Mock PNG ───────────────────────────────────────────────────────────

/** 1x1 white pixel PNG — used as mock generateFn output when no real provider is wired. */
export const MOCK_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

// ─── Character Variants ─────────────────────────────────────────────────

/**
 * 2026-05-20 display_name 体系统一: 读老数据 user_note 兜底映射为 display_name.
 */
function migrateCharVariantUserNote(v: CharacterVariant): CharacterVariant {
  if (v.display_name) return v;
  if (v.user_note !== undefined) return { ...v, display_name: v.user_note };
  return { ...v, display_name: "" };
}

export async function listCharacterVariants(id: string): Promise<CharacterVariant[]> {
  const vDir = charVariantsDir(id);
  if (!(await pathExists(vDir))) return [];
  const entries = await fs.readdir(vDir);
  const results: CharacterVariant[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const v = await readJson<CharacterVariant>(path.join(vDir, entry)); if (v) results.push(migrateCharVariantUserNote(v));
    } catch { /* skip corrupted */ }
  }
  return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function createCharacterVariant(
  id: string,
  params: {
    label: string;
    category: VariantCategory;
    source_vault_id?: string;
    // 2026-05-20: 兼容老入参 user_note (向后兼容 caller), 内部统一存 display_name
    display_name?: string;
    user_note?: string;
    provider_id?: string;
    generateFn?: GenerateFn;
  },
): Promise<CharacterVariant> {
  const metaPath = charMetaPath(id);
  if (!(await pathExists(metaPath))) {
    throw Object.assign(new Error("角色不存在"), { status: 404 });
  }

  const meta = await readJson<LibraryCharacterMeta>(metaPath);
  if (!meta) throw Object.assign(new Error("角色 meta 损坏"), { status: 500 });
  const varId = ulid();
  const now = new Date().toISOString();
  let vault_id = params.source_vault_id ?? "";

  // 2026-05-20 display_name 体系统一: 入参 display_name > user_note > 默认值
  const displayName = params.display_name ?? params.user_note ?? "";

  // If generateFn is provided, generate a new image
  if (params.generateFn) {
    const prompt = `${meta.name}, ${meta.appearance}, 变体:${params.label}(${params.category})`;
    const buffers = await params.generateFn(prompt, 1);

    // Save to vault
    const { saveToVault } = await import("./assetVault");
    const entry = await saveToVault({
      buffer: buffers[0],
      kind: "image",
      mime: "image/png",
      context: {
        kind: "variant",
        character_id: id,
        parent_vault_id: params.source_vault_id,
        // VaultContext.user_note 跟 SeriesVariant/CharVariant.display_name 是不同语义,
        // 这里保留是 vault context 的"分类标识"用途, 不动.
        user_note: params.user_note ?? `${params.category}:${params.label}`,
        display_name: displayName || undefined,
      },
      provider_id: params.provider_id,
      width: 1024,
      height: 1024,
    });
    vault_id = entry.vault_id;
  }

  const variant: CharacterVariant = {
    id: varId,
    label: params.label,
    category: params.category,
    vault_id,
    parent: "locked",
    display_name: displayName,
    created_at: now,
  };

  await ensureDir(charVariantsDir(id));
  await writeVersionedJson(charVariantPath(id, varId), variant);
  return variant;
}

export async function deleteCharacterVariant(id: string, varId: string): Promise<boolean> {
  const vp = charVariantPath(id, varId);
  if (!(await pathExists(vp))) return false;
  // W-3.2: 软删 — 移到 _trash/ 子目录并记 deleted_at (铁律 #6 数据保留)
  const trashDir = path.join(charVariantsDir(id), "_trash");
  await fs.mkdir(trashDir, { recursive: true });
  const trashPath = path.join(trashDir, `${varId}.json`);
  // 读原数据, 加 deleted_at 时间戳
  const variant = JSON.parse(await fs.readFile(vp, "utf8"));
  variant.deleted_at = new Date().toISOString();
  await fs.writeFile(trashPath, JSON.stringify(variant, null, 2), "utf8");
  await fs.unlink(vp);
  return true;
}

/**
 * autoPackCharacterVariants — 锁定后自动生 6 张变体图并行执行
 * (服装×2 / 情绪×2 / 时段×1 / 天气×1) 各 1 张 = 6 张
 * 单张失败不阻断其他，返回 succeeded/failed 计数。
 */
export async function autoPackCharacterVariants(
  id: string,
  provider_id: string,
  generateFn: GenerateFn,
): Promise<AutoPackResult<CharacterVariant>> {
  const lockedPng = charLockedPngPath(id);
  if (!(await pathExists(lockedPng))) {
    throw Object.assign(new Error("请先锁定标准像"), { status: 400 });
  }

  const meta = await readJson<LibraryCharacterMeta>(charMetaPath(id));
  if (!meta) throw Object.assign(new Error("角色 meta 损坏"), { status: 500 });
  const lockedData = (await readJson<LockData>(charLockedJsonPath(id)).catch(() => null)) ?? { ref_id: "", prompt: "", locked_at: "" };
  const basePrompt = lockedData.prompt || meta.appearance;

  const packs: Array<{ label: string; category: VariantCategory; prompt_suffix: string }> = [
    // 服装 ×2
    { label: "商务正装", category: "outfit", prompt_suffix: "穿着正式商务正装，干练专业" },
    { label: "休闲便装", category: "outfit", prompt_suffix: "穿着舒适休闲便装，轻松自然" },
    // 情绪 ×2
    { label: "微笑", category: "emotion", prompt_suffix: "微笑着，温暖的表情，眼神柔和" },
    { label: "悲伤", category: "emotion", prompt_suffix: "悲伤的表情，眼中含泪，情绪低落" },
    // 时段 ×1
    { label: "黄昏时分", category: "time_of_day", prompt_suffix: "黄昏时分，暖金色的夕阳光线洒落" },
    // 天气 ×1
    { label: "雨天氛围", category: "weather", prompt_suffix: "下雨天，阴雨绵绵的氛围，伞下凝望" },
  ];

  const { saveToVault: saveVault } = await import("./assetVault");

  const settled = await Promise.allSettled(
    packs.map(async (pack) => {
      const prompt = `${basePrompt}, ${pack.prompt_suffix}`;
      const buffers = await generateFn(prompt, 1);

      const entry = await saveVault({
        buffer: buffers[0],
        kind: "image",
        mime: "image/png",
        context: {
          kind: "variant",
          character_id: id,
          user_note: `auto-pack: ${pack.label}`,
        },
        provider_id,
        width: 1024,
        height: 1024,
      });

      const now = new Date().toISOString();
      const varId = ulid();
      const variant: CharacterVariant = {
        id: varId,
        label: pack.label,
        category: pack.category,
        vault_id: entry.vault_id,
        parent: "locked",
        display_name: `auto-pack: ${pack.label}`,
        created_at: now,
      };

      await ensureDir(charVariantsDir(id));
      await writeVersionedJson(charVariantPath(id, varId), variant);
      return variant;
    }),
  );

  const variants: CharacterVariant[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") {
      variants.push(r.value);
      succeeded++;
    } else {
      console.warn(`[autoPackCharacterVariants] 单张变体生成失败: ${r.reason?.message ?? r.reason}`);
      failed++;
    }
  }

  return { variants, succeeded, failed };
}

// ─── Scene Variants ─────────────────────────────────────────────────────

/**
 * 2026-05-20 display_name 体系统一: 读老数据 user_note 兜底映射为 display_name.
 */
function migrateSceneVariantUserNote(v: SceneVariant): SceneVariant {
  if (v.display_name) return v;
  if (v.user_note !== undefined) return { ...v, display_name: v.user_note };
  return { ...v, display_name: "" };
}

export async function listSceneVariants(id: string): Promise<SceneVariant[]> {
  const vDir = sceneVariantsDir(id);
  if (!(await pathExists(vDir))) return [];
  const entries = await fs.readdir(vDir);
  const results: SceneVariant[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const v = await readJson<SceneVariant>(path.join(vDir, entry)); if (v) results.push(migrateSceneVariantUserNote(v));
    } catch { /* skip corrupted */ }
  }
  return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function createSceneVariant(
  id: string,
  params: {
    label: string;
    category: VariantCategory;
    source_vault_id?: string;
    // 2026-05-20: 兼容老入参 user_note, 内部统一存 display_name
    display_name?: string;
    user_note?: string;
    provider_id?: string;
    generateFn?: GenerateFn;
  },
): Promise<SceneVariant> {
  const metaPath = sceneMetaPath(id);
  if (!(await pathExists(metaPath))) {
    throw Object.assign(new Error("场景不存在"), { status: 404 });
  }

  const meta = await readJson<LibrarySceneMeta>(metaPath);
  if (!meta) throw Object.assign(new Error("场景 meta 损坏"), { status: 500 });
  const varId = ulid();
  const now = new Date().toISOString();
  let vault_id = params.source_vault_id ?? "";

  // 2026-05-20 display_name 体系统一
  const displayName = params.display_name ?? params.user_note ?? "";

  if (params.generateFn) {
    const prompt = [meta.name, meta.description, `变体:${params.label}(${params.category})`].filter(Boolean).join(", ");
    const buffers = await params.generateFn(prompt, 1);

    const { saveToVault } = await import("./assetVault");
    const entry = await saveToVault({
      buffer: buffers[0],
      kind: "image",
      mime: "image/png",
      context: {
        kind: "variant",
        scene_id: id,
        parent_vault_id: params.source_vault_id,
        // VaultContext.user_note 是分类标识用途, 保留不动
        user_note: params.user_note ?? `${params.category}:${params.label}`,
        display_name: displayName || undefined,
      },
      provider_id: params.provider_id,
      width: 1024,
      height: 1024,
    });
    vault_id = entry.vault_id;
  }

  const variant: SceneVariant = {
    id: varId,
    label: params.label,
    category: params.category,
    vault_id,
    parent: "locked",
    display_name: displayName,
    created_at: now,
  };

  await ensureDir(sceneVariantsDir(id));
  await writeVersionedJson(sceneVariantPath(id, varId), variant);
  return variant;
}

export async function deleteSceneVariant(id: string, varId: string): Promise<boolean> {
  const vp = sceneVariantPath(id, varId);
  if (!(await pathExists(vp))) return false;
  // W-3.2: 软删 — 移到 _trash/ 子目录并记 deleted_at (铁律 #6 数据保留)
  const trashDir = path.join(sceneVariantsDir(id), "_trash");
  await fs.mkdir(trashDir, { recursive: true });
  const trashPath = path.join(trashDir, `${varId}.json`);
  const variant = JSON.parse(await fs.readFile(vp, "utf8"));
  variant.deleted_at = new Date().toISOString();
  await fs.writeFile(trashPath, JSON.stringify(variant, null, 2), "utf8");
  await fs.unlink(vp);
  return true;
}

/**
 * autoPackSceneVariants — 锁定后自动生 6 张变体图并行执行
 * (时段×2 / 天气×2 / 季节×1 / 灯光×1) 各 1 张 = 6 张
 * 单张失败不阻断其他，返回 succeeded/failed 计数。
 */
export async function autoPackSceneVariants(
  id: string,
  provider_id: string,
  generateFn: GenerateFn,
): Promise<AutoPackResult<SceneVariant>> {
  const lockedPng = sceneLockedPngPath(id);
  if (!(await pathExists(lockedPng))) {
    throw Object.assign(new Error("请先锁定标准像"), { status: 400 });
  }

  const meta = await readJson<LibrarySceneMeta>(sceneMetaPath(id));
  if (!meta) throw Object.assign(new Error("场景 meta 损坏"), { status: 500 });
  const lockedData = (await readJson<LockData>(sceneLockedJsonPath(id)).catch(() => null)) ?? { ref_id: "", prompt: "", locked_at: "" };
  const basePrompt = lockedData.prompt || [meta.description, meta.visual_style, meta.location, meta.time_of_day, meta.mood].filter(Boolean).join(", ");

  const packs: Array<{ label: string; category: VariantCategory; prompt_suffix: string }> = [
    // 时段 ×2
    { label: "白天·晴", category: "time_of_day", prompt_suffix: "晴朗的白天，阳光明媚，光影清晰" },
    { label: "黄昏·阴", category: "time_of_day", prompt_suffix: "阴天的黄昏，天色昏暗，氛围沉静" },
    // 天气 ×2
    { label: "夜晚·雨", category: "weather", prompt_suffix: "雨夜的场景，雨水落下，路面反光" },
    { label: "雪景", category: "weather", prompt_suffix: "雪景覆盖，白雪皑皑，空气清冷" },
    // 季节 ×1
    { label: "秋日红叶", category: "other", prompt_suffix: "深秋时节，红叶满枝，暖色调" },
    // 灯光 ×1
    { label: "霓虹夜色", category: "other", prompt_suffix: "夜晚霓虹灯灯光氛围，赛博质感" },
  ];

  const { saveToVault: saveVault } = await import("./assetVault");

  const settled = await Promise.allSettled(
    packs.map(async (pack) => {
      const prompt = `${basePrompt}, ${pack.prompt_suffix}`;
      const buffers = await generateFn(prompt, 1);

      const entry = await saveVault({
        buffer: buffers[0],
        kind: "image",
        mime: "image/png",
        context: {
          kind: "variant",
          scene_id: id,
          user_note: `auto-pack: ${pack.label}`,
        },
        provider_id,
        width: 1024,
        height: 1024,
      });

      const now = new Date().toISOString();
      const varId = ulid();
      const variant: SceneVariant = {
        id: varId,
        label: pack.label,
        category: pack.category,
        vault_id: entry.vault_id,
        parent: "locked",
        display_name: `auto-pack: ${pack.label}`,
        created_at: now,
      };

      await ensureDir(sceneVariantsDir(id));
      await writeVersionedJson(sceneVariantPath(id, varId), variant);
      return variant;
    }),
  );

  const variants: SceneVariant[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") {
      variants.push(r.value);
      succeeded++;
    } else {
      console.warn(`[autoPackSceneVariants] 单张变体生成失败: ${r.reason?.message ?? r.reason}`);
      failed++;
    }
  }

  return { variants, succeeded, failed };
}
