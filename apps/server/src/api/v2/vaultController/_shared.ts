/**
 * Vault Controller — shared helpers & types
 *
 * Extracted from vaultController.ts during P1-5 split.
 * Contains: display_name merge, SVG placeholder, annotation storage, entity ref append.
 */

import type { Response } from "express";
import path from "node:path";
import {
  pathExists, DATA_ROOT, readJson, writeJson, ensureDir,
} from "../../../../../../packages/core/src/index";
import {
  getAssetMeta, listAssetMeta,
} from "../../../repositories/assetMetaRepo";
import type { VaultEntry } from "../../../../../../packages/library/src/assetVault";

// ─── display_name merge (assetMeta single source of truth) ────────

export async function mergeVaultEntryWithAssetMeta(entry: VaultEntry): Promise<VaultEntry> {
  const meta = await getAssetMeta(entry.vault_id);
  if (meta?.display_name) {
    return { ...entry, display_name: meta.display_name };
  }
  return entry;
}

export async function mergeVaultEntriesWithAssetMeta(entries: VaultEntry[]): Promise<VaultEntry[]> {
  if (entries.length === 0) return entries;
  const metas = await listAssetMeta(entries.map((e) => e.vault_id));
  if (metas.size === 0) return entries;
  return entries.map((e) => {
    const m = metas.get(e.vault_id);
    return m?.display_name ? { ...e, display_name: m.display_name } : e;
  });
}

// ─── SVG thumbnail placeholder ────────────────────────────────────

function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function sendMissingThumbnail(res: Response, rawSize: number, label: string): void {
  const size = Math.max(64, Math.min(Number.isFinite(rawSize) ? rawSize : 256, 1024));
  const safeLabel = escapeSvgText(label);
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${safeLabel}">
      <rect width="${size}" height="${size}" rx="18" fill="rgb(248,246,241)"/>
      <rect x="1" y="1" width="${size - 2}" height="${size - 2}" rx="17" fill="none" stroke="rgb(221,216,209)" stroke-width="2"/>
      <path d="M${size * 0.34} ${size * 0.36}h${size * 0.32}v${size * 0.22}h-${size * 0.32}z" fill="none" stroke="rgb(141,135,128)" stroke-width="3" stroke-linejoin="round"/>
      <circle cx="${size * 0.43}" cy="${size * 0.44}" r="${size * 0.035}" fill="rgb(141,135,128)"/>
      <path d="M${size * 0.34} ${size * 0.58}l${size * 0.09}-${size * 0.08}l${size * 0.07} ${size * 0.05}l${size * 0.07}-${size * 0.07}l${size * 0.09} ${size * 0.1}" fill="none" stroke="rgb(141,135,128)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="50%" y="${size * 0.72}" text-anchor="middle" fill="rgb(106,100,93)" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="${Math.max(12, size * 0.055)}" font-weight="600">${safeLabel}</text>
    </svg>
  `.trim());
}

// ─── Annotation storage ───────────────────────────────────────────

export const ANNOTATIONS_ROOT = path.join(DATA_ROOT, "vault", "annotations");

export interface Annotation {
  id: string;
  type: "pin" | "box";
  coords: { x: number; y: number; w?: number; h?: number };
  note: string;
  created_at: string;
}

function annotationPath(vaultId: string): string {
  const safe = vaultId.replace(/[<>:"/\\|?*]/g, "_");
  return path.join(ANNOTATIONS_ROOT, `${safe}.json`);
}

export async function readAnnotations(vaultId: string): Promise<Annotation[]> {
  const p = annotationPath(vaultId);
  if (!(await pathExists(p))) return [];
  try {
    const data = await readJson<{ annotations: Annotation[] }>(p);
    return data?.annotations || [];
  } catch {
    return [];
  }
}

export async function writeAnnotations(vaultId: string, annotations: Annotation[]): Promise<void> {
  const p = annotationPath(vaultId);
  await ensureDir(path.dirname(p));
  await writeJson(p, { annotations, updated_at: new Date().toISOString() });
}

// ─── Entity vault ref append (remix + inpaint shared) ─────────────

/**
 * Append vault IDs to a character or scene entity's vault_refs list.
 * Series entities use a separate directory structure, library entities use globalLibrary.
 */
export async function appendEntityVaultRefs(
  seriesSlug: string,
  entityType: "characters" | "scenes",
  entityId: string,
  newVaultIds: string[],
): Promise<void> {
  // Try series character/scene JSON first
  const seriesEntityPath = path.join(
    DATA_ROOT, "series", seriesSlug, entityType, `${entityId}.json`,
  );
  if (await pathExists(seriesEntityPath)) {
    const data = await readJson<Record<string, any>>(seriesEntityPath);
    if (!data) return;
    const existing = (data.ref_image_ids || []) as string[];
    const merged = Array.from(new Set([...existing, ...newVaultIds]));
    if (merged.length > existing.length) {
      await writeJson(seriesEntityPath, { ...data, ref_image_ids: merged });
    }
    return;
  }

  // Try library character/scene — uses globalLibrary meta.json refs
  if (seriesSlug === "library") {
    const libBase = path.join(DATA_ROOT, "library", entityType, entityId);
    if (await pathExists(libBase)) {
      const vaultRefsPath = path.join(libBase, "vault_refs.json");
      let existing: string[] = [];
      if (await pathExists(vaultRefsPath)) {
        const data = await readJson<{ refs?: string[] }>(vaultRefsPath);
        existing = data?.refs || [];
      }
      const merged = Array.from(new Set([...existing, ...newVaultIds]));
      if (merged.length > existing.length) {
        await ensureDir(path.dirname(vaultRefsPath));
        await writeJson(vaultRefsPath, { refs: merged, updated_at: new Date().toISOString() });
      }
    }
  }
}
