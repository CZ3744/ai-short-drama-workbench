import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, "../../..");
export const outputsRoot = path.join(repoRoot, "outputs");
export const promptsRoot = path.join(repoRoot, "prompts");
export const samplesRoot = path.join(repoRoot, "samples");

/**
 * 2026-09-20 — 项目重新收口为单根目录:
 *   video-generate/
 *     apps + packages + config + data + outputs + ...
 *
 * 历史上 DATA_ROOT 可指向同级的 video-generate-data，造成“一个项目三目录”
 * 以及测试/迁移/备份时的路径漂移。现在 data/ 与 outputs/ 都固定归属 repoRoot。
 *
 * VIDEO_GENERATE_DATA_ROOT 不再改变运行时根目录。保留该环境变量只用于兼容诊断，
 * 避免旧机器配置把运行时重新导向已废弃的外部目录。
 */
export const DATA_ROOT = path.join(repoRoot, "data");

if (
  process.env.NODE_ENV !== "test" &&
  !process.env.VIDEO_GENERATE_QUIET_PATHS &&
  process.env.VIDEO_GENERATE_DATA_ROOT?.trim()
) {
  queueMicrotask(() => {
    console.warn(
      "[paths] VIDEO_GENERATE_DATA_ROOT 已废弃并被忽略；当前数据固定使用 <repo>/data。"
    );
  });
}

export const VAULT_ROOT = path.join(DATA_ROOT, "vault");
export const TRASH_ROOT = path.join(DATA_ROOT, "trash");

// T13: New multi-project paths
export const projectsRoot = path.join(repoRoot, "projects");
export const assetsRoot = path.join(repoRoot, "assets");

export function projectDir(slug: string) {
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    throw new Error(`Invalid project slug: ${slug}`);
  }
  return path.join(projectsRoot, slug);
}

export function episodeDir(projectSlug: string, episodeId: string) {
  return path.join(projectDir(projectSlug), "episodes", episodeId);
}

export function episodeOutputsDir(projectSlug: string, episodeId: string) {
  return path.join(episodeDir(projectSlug, episodeId), "outputs");
}

export function episodeManifestPath(projectSlug: string, episodeId: string) {
  return path.join(episodeDir(projectSlug, episodeId), "manifest.json");
}

export function projectCharactersDir(slug: string) {
  return path.join(projectDir(slug), "characters");
}

export function projectScenesDir(slug: string) {
  return path.join(projectDir(slug), "scenes");
}

export function projectStylesDir(slug: string) {
  return path.join(projectDir(slug), "styles");
}

export function projectVaultDir(slug: string) {
  return path.join(projectDir(slug), "vault");
}

export function assetsCharactersDir() {
  return path.join(assetsRoot, "characters");
}

export function assetsScenesDir() {
  return path.join(assetsRoot, "scenes");
}

export function assetsVoicesDir() {
  return path.join(assetsRoot, "voices");
}

export function assetsVaultDir() {
  return path.join(assetsRoot, "vault");
}

// Deprecated: kept for backward compatibility, maps to default project
export function jobDir(jobId: string) {
  if (jobId.includes("..") || jobId.includes("/") || jobId.includes("\\")) {
    throw new Error(`Invalid jobId: ${jobId}`);
  }
  return path.join(outputsRoot, jobId);
}

export function jobPath(jobId: string, ...parts: string[]) {
  return path.join(jobDir(jobId), ...parts);
}

export const jobSubdirs = [
  "input",
  "manifests",
  "scenes",
  "assets",
  "audio",
  "subtitles",
  "renders",
  "final",
  "logs",
  "qa"
] as const;
