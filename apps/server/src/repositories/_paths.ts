/**
 * Shared path helpers for repositories (step 1.5: dedup path helpers).
 *
 * Extracted verbatim from per-repo copies that originated in seriesStore.ts.
 * Zero behavior change — only path-related constants and factories live here.
 * Non-path helpers (withWriteLock / readJsonl / nowISO / newId / slugify / ...)
 * stay in their owning repo on purpose.
 *
 * NOTE: TRASH_ROOT here is `data/_trash` (the seriesStore convention used by
 * series/shot repos). This is distinct from packages/core/src/paths.ts's
 * `TRASH_ROOT` (`data/trash`), so we deliberately do NOT re-export the core
 * constant — callers that want the v2 trash bucket import from this file.
 */

import path from "node:path";
import { DATA_ROOT, repoRoot, outputsRoot } from "../../../../packages/core/src/index";

// Re-export the core constants used by the repos so they only need one import.
export { DATA_ROOT, repoRoot, outputsRoot };

// ─── Roots ──────────────────────────────────────────────────────

export const SERIES_ROOT = path.join(DATA_ROOT, "series");
export const SAMPLES_ROOT = path.join(DATA_ROOT, "samples");
export const TRASH_ROOT = path.join(DATA_ROOT, "_trash");
export const TASKS_ROOT = path.join(DATA_ROOT, "tasks");
export const TASKS_FILE = path.join(TASKS_ROOT, "tasks.jsonl");
export const LEDGER_ROOT = path.join(DATA_ROOT, "cost_ledger");
export const TEMPLATES_FILE = path.join(DATA_ROOT, "templates.json");
export const CONFIG_TEMPLATES_ROOT = path.join(repoRoot, "config", "templates");

// ─── Series / Episode / Shot ────────────────────────────────────

export function seriesDir(slug: string): string {
  return path.join(SERIES_ROOT, slug);
}

export function seriesFile(slug: string): string {
  return path.join(seriesDir(slug), "series.json");
}

export function episodeDir(slug: string, epId: string): string {
  return path.join(seriesDir(slug), "episodes", epId);
}

export function episodeFile(slug: string, epId: string): string {
  return path.join(episodeDir(slug, epId), "episode.json");
}

export function versionsDir(slug: string, epId: string): string {
  return path.join(episodeDir(slug, epId), "versions");
}

export function versionFilePath(slug: string, epId: string, version: number): string {
  return path.join(versionsDir(slug, epId), `v${version}.json`);
}

export function shotsDir(slug: string, epId: string): string {
  return path.join(episodeDir(slug, epId), "shots");
}

export function shotFile(slug: string, epId: string, shotId: string): string {
  return path.join(shotsDir(slug, epId), `${shotId}.json`);
}

// ─── Character ──────────────────────────────────────────────────

export function charactersDir(slug: string): string {
  return path.join(seriesDir(slug), "characters");
}

export function characterFile(slug: string, charId: string): string {
  return path.join(charactersDir(slug), `${charId}.json`);
}

export function charVariantDir(slug: string, charId: string): string {
  return path.join(charactersDir(slug), charId, "variants");
}

export function charVariantPath(slug: string, charId: string, varId: string): string {
  return path.join(charVariantDir(slug, charId), `${varId}.json`);
}

// ─── Scene ──────────────────────────────────────────────────────

export function scenesDir(slug: string): string {
  return path.join(seriesDir(slug), "scenes");
}

export function sceneFile(slug: string, sceneId: string): string {
  return path.join(scenesDir(slug), `${sceneId}.json`);
}

export function sceneVariantDir(slug: string, sceneId: string): string {
  return path.join(scenesDir(slug), sceneId, "variants");
}

export function sceneVariantPath(slug: string, sceneId: string, varId: string): string {
  return path.join(sceneVariantDir(slug, sceneId), `${varId}.json`);
}

// ─── Assets ─────────────────────────────────────────────────────

export function assetsDir(slug: string): string {
  return path.join(seriesDir(slug), "assets");
}

export function assetIndexFile(slug: string): string {
  return path.join(assetsDir(slug), "index.jsonl");
}

// ─── Mood Board ─────────────────────────────────────────────────

export function moodBoardDir(slug: string): string {
  return path.join(seriesDir(slug), "mood_board");
}

export function moodBoardFile(slug: string, vaultId: string): string {
  return path.join(moodBoardDir(slug), `${vaultId}.json`);
}

export function moodBoardConfigFile(slug: string): string {
  return path.join(moodBoardDir(slug), "_config.json");
}

// ─── Generic ────────────────────────────────────────────────────

/**
 * Check whether `target` is inside `root` (path-wise, after normalization).
 * Returns true for equality and any descendant path; false otherwise.
 */
export function isPathInside(root: string, target: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(target));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}
