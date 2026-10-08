// T13: Migration tool — auto-migrate old outputs/<jobId>/ to projects/default/episodes/<jobId>/
import fs from "node:fs/promises";
import path from "node:path";
import { outputsRoot, episodeDir, episodeManifestPath } from "./paths";
import { ensureDefaultProject } from "./db/projects";
import { createEpisode, getEpisodeByJobId, listEpisodes } from "./db/episodes";
import type { SceneManifest } from "./types";
import { readJson } from "./fs";
import { getDb } from "./db/database";

export interface MigrationResult {
  migrated: string[];
  skipped: string[];
  errors: Array<{ jobId: string; error: string }>;
}

export async function migrateLegacyJobs(): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: [], skipped: [], errors: [] };

  // Ensure default project
  const project = ensureDefaultProject();

  // Scan outputs directory
  let entries: string[];
  try {
    entries = await fs.readdir(outputsRoot);
  } catch {
    return result; // No outputs directory yet
  }

  for (const entry of entries) {
    if (entry === "tmp" || entry.startsWith(".")) continue;
    const jobDir = path.join(outputsRoot, entry);
    let stat;
    try {
      stat = await fs.stat(jobDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const jobId = entry;
    const manifestPath = path.join(jobDir, "manifests", "segment_manifest.json");

    // Check if already migrated
    const existing = getEpisodeByJobId(jobId);
    if (existing) {
      result.skipped.push(jobId);
      continue;
    }

    // Read manifest to get title
    let title = jobId;
    try {
      const raw = await readJson<SceneManifest>(manifestPath);
      if (raw) title = raw.project_title || jobId;
    } catch {
      // No manifest yet, still migrate the directory structure
    }

    // Create episode record
    try {
      const episode = createEpisode({
        projectSlug: project.slug,
        title,
        job_id: jobId,
      });

      // Create new episode directory structure
      const epDir = episodeDir(project.slug, episode.id);
      await fs.mkdir(epDir, { recursive: true });
      await fs.mkdir(path.join(epDir, "outputs"), { recursive: true });

      // Move job outputs to episode dir
      try {
        const targetOutputs = path.join(epDir, "outputs");
        const sourceEntries = await fs.readdir(jobDir);
        for (const file of sourceEntries) {
          const src = path.join(jobDir, file);
          const dst = path.join(targetOutputs, file);
          try {
            await fs.cp(src, dst, { recursive: true });
          } catch (err: any) {
            result.errors.push({ jobId, error: `Copy ${file}: ${err.message}` });
            // Continue with other files even if one fails
          }
        }

        // Copy manifest to episode root if it exists
        try {
          await fs.copyFile(manifestPath, episodeManifestPath(project.slug, episode.id));
        } catch {
          // Manifest doesn't exist yet, that's fine
        }
      } catch (err: any) {
        result.errors.push({ jobId, error: `Move outputs: ${err.message}` });
      }

      result.migrated.push(jobId);
    } catch (err: any) {
      result.errors.push({ jobId, error: `Create episode: ${err.message}` });
    }
  }

  return result;
}

/** Called at server startup to ensure data migration is complete */
export async function ensureMigration(): Promise<MigrationResult> {
  return migrateLegacyJobs();
}
