/**
 * Shared series/episode path helpers + prompt snapshot writers.
 *
 * Step 3a extraction — verbatim from orchestrationController.ts.
 */

import path from "node:path";
import { ensureDir, writeJson, DATA_ROOT } from "../../../../../../../packages/core/src/index";

// ─── Helpers ──────────────────────────────────────────────────────

export const SSR_BASE = path.join(DATA_ROOT, "series");

export function seriesBase(slug: string): string {
  return path.join(SSR_BASE, slug);
}

export function episodeBase(slug: string, epId: string): string {
  return path.join(seriesBase(slug), "episodes", epId);
}

export function seriesPromptsDir(slug: string): string {
  return path.join(seriesBase(slug), "_prompts");
}

export function promptsDir(slug: string, epId: string): string {
  return path.join(episodeBase(slug, epId), "_prompts");
}

export async function saveSeriesPromptSnapshot(
  slug: string, templateId: string, promptText: string, context: Record<string, any>
): Promise<string> {
  const dir = seriesPromptsDir(slug);
  await ensureDir(dir);
  const ts = Date.now();
  const filename = `${ts}_${templateId}.json`;
  await writeJson(path.join(dir, filename), {
    template_id: templateId,
    timestamp: new Date(ts).toISOString(),
    prompt: promptText,
    context,
  });
  return filename;
}

export async function savePromptSnapshot(
  slug: string, epId: string, templateId: string, promptText: string, context: Record<string, any>
): Promise<string> {
  const dir = promptsDir(slug, epId);
  await ensureDir(dir);
  const ts = Date.now();
  const filename = `${ts}_${templateId}.json`;
  await writeJson(path.join(dir, filename), {
    template_id: templateId,
    timestamp: new Date(ts).toISOString(),
    prompt: promptText,
    context,
  });
  return filename;
}
