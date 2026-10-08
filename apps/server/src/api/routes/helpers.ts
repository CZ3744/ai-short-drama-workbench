import fs from "node:fs/promises";
import path from "node:path";
import {
  jobPath,
  pathExists,
  readJson,
  writeJson,
  ensureDir,
  validateAndRepairManifest,
  type SceneManifest
} from "../../../../../packages/core/src/index";

/**
 * Resolve a relative path safely within a job root directory.
 * Rejects path traversal attempts (..) and absolute paths outside jobRoot.
 */
export function resolveJobSafePath(jobRoot: string, relativeOrAbsolutePath: string): string {
  if (typeof relativeOrAbsolutePath !== "string" || !relativeOrAbsolutePath) {
    throw new Error("resolveJobSafePath: path must be a non-empty string");
  }
  // v0.2.4: reject null bytes, drive-letter hijacks and UNC paths on Windows.
  if (relativeOrAbsolutePath.includes("\0")) {
    throw new Error("Path traversal detected: null byte");
  }
  if (/^[A-Za-z]:/.test(relativeOrAbsolutePath) || relativeOrAbsolutePath.startsWith("\\\\") || relativeOrAbsolutePath.startsWith("//")) {
    // Absolute Windows / UNC paths: verify they fall inside jobRoot below.
  }
  const normalized = relativeOrAbsolutePath.replace(/\\/g, "/");
  // Reject `..` as either a whole segment or a prefix/suffix; `..abc` is fine.
  if (normalized.split("/").some(seg => seg === "..")) {
    throw new Error("Path traversal detected: .. is not allowed");
  }
  // Reject absolute paths that point outside jobRoot
  if (path.isAbsolute(relativeOrAbsolutePath)) {
    const normalizedRoot = path.resolve(jobRoot);
    const resolvedAbs = path.resolve(relativeOrAbsolutePath);
    if (!resolvedAbs.startsWith(normalizedRoot + path.sep) && resolvedAbs !== normalizedRoot) {
      throw new Error(`Absolute path outside job root: ${relativeOrAbsolutePath}`);
    }
  }
  const resolved = path.resolve(jobRoot, ...normalized.split("/").filter(Boolean));
  const normalizedRoot = path.resolve(jobRoot);
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new Error(`Path outside job root: ${relativeOrAbsolutePath}`);
  }
  return resolved;
}

export function relativePath(root: string, target: string) {
  return path.relative(root, target).replace(/\\/g, "/");
}

export function padNum(value: number) {
  return value.toString().padStart(3, "0");
}

export async function loadAndMigrateManifest(jobId: string): Promise<{ manifest: SceneManifest; file: string }> {
  const file = jobPath(jobId, "manifests", "scene_manifest.json");
  if (!(await pathExists(file))) {
    throw Object.assign(new Error("manifest not found"), { status: 404 });
  }
  const raw = await readJson<SceneManifest>(file);
  if (!raw) throw Object.assign(new Error("manifest 文件损坏或为空"), { status: 500 });
  const { manifest, warnings, changed } = validateAndRepairManifest(raw, { jobRoot: jobPath(jobId) });
  if (changed) {
    await writeJson(file, manifest);
  }
  return { manifest, file };
}

export async function backupManifest(file: string, jobId: string) {
  const historyDir = jobPath(jobId, "manifests", "history");
  await ensureDir(historyDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(historyDir, `scene_manifest_${timestamp}.json`);
  try {
    await fs.copyFile(file, backupFile);
  } catch { /* best effort */ }
}

/**
 * v0.2.4: Per-scene serialization lock (in-memory Map of Promise chains).
 *
 * Protects against two concurrent generate-clip / retry-clip / activate /
 * deactivate / delete requests on the same (jobId, sceneId) — those would
 * otherwise interleave the read-modify-write cycle of scene_manifest.json
 * and drop one of the clip_versions, which is especially dangerous for
 * real-video providers where a lost version means silently paying for
 * clip bytes we no longer reference.
 *
 * Usage:
 *   await withSceneLock(jobId, sceneId, async () => { ...mutation... });
 */
const _sceneLocks = new Map<string, Promise<unknown>>();

export async function withSceneLock<T>(jobId: string, sceneId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${jobId}::${sceneId}`;
  const prev = _sceneLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const chainPromise = prev.then(() => next);
  _sceneLocks.set(key, chainPromise);
  try {
    await prev; // wait for any in-flight mutation on this scene
    return await fn();
  } finally {
    release();
    // Clean up if we are still the tail of the chain
    if (_sceneLocks.get(key) === chainPromise) {
      _sceneLocks.delete(key);
    }
  }
}
