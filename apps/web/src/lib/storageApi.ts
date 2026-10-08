// ====================================================================
// storageApi.ts — Storage / Backup / Project Export Import
// (P1 wave 2 #11 解耦)
// ====================================================================
// 覆盖范围:
// - StorageUsageReport / StorageProjectUsage / CleanupReport
// - BackupArchiveResult / restore
// - ProjectDeleteSummary / ProjectExportResult / ProjectImportResult
// ====================================================================

import {
  apiGet,
  apiPost,
  handleFetchResponse,
  handleResponse,
} from "./_apiClient";

// ====================================================================
// DATA MANAGEMENT
// ====================================================================

export interface StorageProjectUsage {
  slug: string;
  title: string;
  bytes: number;
  file_count: number;
  image_count: number;
  video_count: number;
  updated_at: string;
}

export interface StorageUsageReport {
  total_bytes: number;
  project_root_bytes: number;
  assets_root_bytes: number;
  outputs_root_bytes: number;
  config_bytes: number;
  data_bytes: number;
  projects: StorageProjectUsage[];
  generated_at: string;
}

export interface CleanupReport {
  removed_count: number;
  removed_bytes: number;
  removed_paths: string[];
  generated_at: string;
}

export interface BackupArchiveResult {
  path: string;
  filename: string;
  created_at: string;
}

export interface ProjectDeleteSummary {
  slug: string;
  title: string;
  project_dir: string;
  exists_on_disk: boolean;
  bytes: number;
  file_count: number;
  image_count: number;
  video_count: number;
  database_counts: Record<string, number>;
}

export interface ProjectExportResult {
  path: string;
  filename: string;
  project: { id: string; slug: string; title: string };
  created_at: string;
}

export interface ProjectImportResult {
  project: { id: string; slug: string; title: string };
  imported_at: string;
  source_archive: string;
}

export async function getStorageUsage() {
  return apiGet<{ usage: StorageUsageReport }>("/api/storage/usage");
}

export async function cleanupStorage() {
  return apiPost<{ ok: boolean; report: CleanupReport }>("/api/storage/cleanup");
}

export async function createBackupArchive() {
  return apiPost<{ ok: boolean; backup: BackupArchiveResult }>("/api/backup/create");
}

export async function restoreBackupArchive(backup_path: string) {
  return apiPost<{ ok: boolean; restored_at: string }>("/api/backup/restore", { backup_path });
}

export async function getProjectDeleteSummary(slug: string) {
  // 2026-05-28 P0-29: encodeURIComponent — slug 可能含中文 / 空格 / 特殊字符, 不 encode
  // 会被浏览器/路由错误解析甚至拒收.
  return apiGet<{ summary: ProjectDeleteSummary }>(`/api/projects/${encodeURIComponent(slug)}/delete-summary`);
}

export async function exportProject(slug: string) {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(120_000).
  // 2026-05-28 P0-29: slug 必须 encodeURIComponent 防特殊字符.
  const response = await fetch(`/api/projects/${encodeURIComponent(slug)}/export`, {});
  await handleResponse(response);
  return {
    blob: await response.blob(),
    filename: response.headers.get("content-disposition"),
  };
}

export async function importProjectArchive(input: { archive_path?: string; file?: File }) {
  if (input.file) {
    const form = new FormData();
    form.append("file", input.file);
    // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(120_000).
    const response = await fetch("/api/projects/import", { method: "POST", body: form });
    return handleFetchResponse<{ ok: boolean; project: { id: string; slug: string; title: string }; imported_at: string; source_archive: string; message: string }>(response);
  }
  return apiPost<{ ok: boolean; project: { id: string; slug: string; title: string }; imported_at: string; source_archive: string; message: string }>("/api/projects/import", input);
}
