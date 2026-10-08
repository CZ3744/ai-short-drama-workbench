// T13: Episode CRUD operations
import { getDb } from "./database";
import { getProject } from "./projects";
import { ulid } from "ulid";

export interface EpisodeRow {
  id: string;
  project_id: string;
  title: string;
  episode_number: number;
  status: string;
  job_id: string | null;
  aspect_ratio: string;
  resolution: string;
  style: string;
  created_at: string;
  updated_at: string;
}

export function createEpisode(input: {
  projectSlug: string;
  title: string;
  episode_number?: number;
  job_id?: string;
  aspect_ratio?: string;
  resolution?: string;
  style?: string;
}): EpisodeRow {
  const db = getDb();
  const project = getProject(input.projectSlug);
  if (!project) throw new Error(`Project not found: ${input.projectSlug}`);
  const now = new Date().toISOString();
  const id = ulid();
  db.prepare(`
    INSERT INTO episodes (id, project_id, title, episode_number, status, job_id, aspect_ratio, resolution, style, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
  `).run(id, project.id, input.title, input.episode_number ?? 1, input.job_id ?? null, input.aspect_ratio ?? "16:9", input.resolution ?? "1920x1080", input.style ?? "auto", now, now);
  return getEpisode(id)!;
}

export function getEpisode(id: string): EpisodeRow | undefined {
  return getDb().prepare("SELECT * FROM episodes WHERE id = ?").get(id) as EpisodeRow | undefined;
}

export function getEpisodeByJobId(jobId: string): EpisodeRow | undefined {
  return getDb().prepare("SELECT * FROM episodes WHERE job_id = ?").get(jobId) as EpisodeRow | undefined;
}

export function listEpisodes(projectSlug: string): EpisodeRow[] {
  const project = getProject(projectSlug);
  if (!project) return [];
  return getDb().prepare("SELECT * FROM episodes WHERE project_id = ? ORDER BY episode_number ASC").all(project.id) as EpisodeRow[];
}

export function updateEpisode(id: string, updates: Partial<Pick<EpisodeRow, "title" | "episode_number" | "status" | "job_id" | "aspect_ratio" | "resolution" | "style">>): EpisodeRow | undefined {
  const db = getDb();
  const existing = getEpisode(id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const merged = { ...existing, ...updates, updated_at: now };
  db.prepare(`
    UPDATE episodes SET title=?, episode_number=?, status=?, job_id=?, aspect_ratio=?, resolution=?, style=?, updated_at=?
    WHERE id=?
  `).run(merged.title, merged.episode_number, merged.status, merged.job_id, merged.aspect_ratio, merged.resolution, merged.style, merged.updated_at, id);
  return getEpisode(id);
}

export function deleteEpisode(id: string): boolean {
  const result = getDb().prepare("DELETE FROM episodes WHERE id = ?").run(id);
  return result.changes > 0;
}
