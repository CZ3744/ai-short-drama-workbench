/**
 * Template Repository — extracted from v2/seriesStore.ts (step 1: split god-module by aggregate root)
 *
 * Zero behavior change. Reverse-imports series/episode/character/scene CRUD from seriesStore
 * (kept in original file until later steps split those aggregates out).
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathExists, readJson, writeJson, ensureDir, slugify } from "../../../../packages/core/src/index";
import {
  // Series
  type SeriesData,
  type SeriesDefaults,
  readSeries,
  updateSeries,
  // Episode
  type EpisodeData,
  createEpisode,
  listEpisodes,
  // Character
  type CharacterData,
  createCharacter,
  listCharacters,
  // Scene
  type SceneData,
  createScene,
  listScenes,
  // Shot
  type ShotData,
  listShots,
} from "../api/v2/seriesStore";
import { TEMPLATES_FILE, CONFIG_TEMPLATES_ROOT, episodeDir } from "./_paths";

// ─── Helpers ────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Template CRUD ──────────────────────────────────────────────

export interface TemplateEntry {
  id: string;
  name: string;
  source_series_slug?: string;
  defaults: SeriesDefaults;
  created_at: string;
}

/** Built-in template descriptor loaded from config/templates/*.json */
export interface BuiltinTemplate {
  id: string;
  label: string;
  preview_image?: string;
  description?: string;
  defaults?: SeriesDefaults;
  character_placeholders?: TemplatePlaceholder[];
  scene_placeholders?: TemplatePlaceholder[];
  storyboard_skeleton?: StoryboardSkeleton;
}

export interface TemplatePlaceholder {
  slot_id: string;
  role?: string;
  hint: string;
}

export interface StoryboardSkeleton {
  episodes: SkeletonEpisode[];
}

export interface SkeletonEpisode {
  index: number;
  title_template: string;
  shots_skeleton: SkeletonShot[];
}

export interface SkeletonShot {
  action_template: string;
  duration: number;
}

export async function listTemplates(): Promise<TemplateEntry[]> {
  if (!(await pathExists(TEMPLATES_FILE))) return [];
  return (await readJson<TemplateEntry[]>(TEMPLATES_FILE)) ?? [];
}

/** List built-in templates from config/templates/ directory */
export async function listBuiltinTemplates(): Promise<BuiltinTemplate[]> {
  if (!(await pathExists(CONFIG_TEMPLATES_ROOT))) return [];
  const files = await fs.readdir(CONFIG_TEMPLATES_ROOT);
  const results: BuiltinTemplate[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const tmpl = await readJson<BuiltinTemplate>(path.join(CONFIG_TEMPLATES_ROOT, file));
      if (tmpl) results.push(tmpl);
    } catch { /* skip invalid */ }
  }
  return results;
}

/** Load a single built-in template by id */
export async function loadBuiltinTemplate(templateId: string): Promise<BuiltinTemplate | null> {
  const builtins = await listBuiltinTemplates();
  return builtins.find(t => t.id === templateId) ?? null;
}

export async function createTemplate(input: { name: string; source_series_slug?: string }): Promise<TemplateEntry> {
  const templates = await listTemplates();
  let defaults: SeriesDefaults = {};
  if (input.source_series_slug) {
    const series = await readSeries(input.source_series_slug);
    if (series) defaults = { ...series.defaults };
  }
  const entry: TemplateEntry = {
    id: newId(),
    name: input.name,
    source_series_slug: input.source_series_slug,
    defaults,
    created_at: nowISO(),
  };
  templates.push(entry);
  await ensureDir(path.dirname(TEMPLATES_FILE));
  await writeJson(TEMPLATES_FILE, templates);
  return entry;
}

export async function deleteTemplate(templateId: string): Promise<boolean> {
  const templates = await listTemplates();
  const idx = templates.findIndex(t => t.id === templateId);
  if (idx === -1) return false;
  templates.splice(idx, 1);
  await writeJson(TEMPLATES_FILE, templates);
  return true;
}

export async function applyTemplate(templateId: string, targetSlug: string): Promise<SeriesData | null> {
  const templates = await listTemplates();
  const template = templates.find(t => t.id === templateId);
  if (!template) return null;
  return updateSeries(targetSlug, { defaults: template.defaults });
}

/**
 * Apply a built-in template skeleton to a series.
 * Creates episodes + shots from the storyboard_skeleton,
 * creates characters from character_bindings, scenes from scene_bindings.
 */
export async function applyTemplateSkeleton(
  slug: string,
  templateId: string,
  characterBindings?: Record<string, { name?: string; role?: string; appearance_prompt?: string; personality?: string } | null>,
  sceneBindings?: Record<string, { name?: string; description?: string } | null>,
): Promise<{ series: SeriesData; episodes: EpisodeData[]; shots: ShotData[]; characters: CharacterData[]; scenes: SceneData[] }> {
  const tmpl = await loadBuiltinTemplate(templateId);
  if (!tmpl) throw Object.assign(new Error("模板不存在"), { status: 404, code: "NotFound" });

  // Apply defaults to series
  if (tmpl.defaults) {
    await updateSeries(slug, { defaults: tmpl.defaults });
  }

  const characters: CharacterData[] = [];
  const scenes: SceneData[] = [];
  const allEpisodes: EpisodeData[] = [];
  const allShots: ShotData[] = [];

  // Process character bindings
  if (characterBindings && tmpl.character_placeholders) {
    for (const ph of tmpl.character_placeholders) {
      const binding = characterBindings[ph.slot_id];
      if (!binding) continue; // skip unbound slots
      const char = await createCharacter(slug, {
        name: binding.name || ph.role || ph.slot_id,
        role: binding.role || ph.role || ph.slot_id,
        appearance_prompt: binding.appearance_prompt || ph.hint,
        personality: binding.personality || "",
      });
      characters.push(char);
    }
  }

  // Process scene bindings
  if (sceneBindings && tmpl.scene_placeholders) {
    for (const ph of tmpl.scene_placeholders) {
      const binding = sceneBindings[ph.slot_id];
      if (!binding) continue;
      const scene = await createScene(slug, {
        name: binding.name || ph.hint,
        description: binding.description || ph.hint,
      });
      scenes.push(scene);
    }
  }

  // Create episodes from skeleton
  if (tmpl.storyboard_skeleton?.episodes) {
    for (const skelEp of tmpl.storyboard_skeleton.episodes) {
      const episodeTitle = _resolvePlaceholders(skelEp.title_template, characterBindings ?? {}, sceneBindings ?? {});
      const ep = await createEpisode(slug, {
        title: episodeTitle,
        index: skelEp.index,
      });
      allEpisodes.push(ep);

      // Create shots for this episode
      if (skelEp.shots_skeleton) {
        for (let si = 0; si < skelEp.shots_skeleton.length; si++) {
          const skelShot = skelEp.shots_skeleton[si];
          const action = _resolvePlaceholders(skelShot.action_template, characterBindings ?? {}, sceneBindings ?? {});
          const shotId = `s${String(si + 1).padStart(4, "0")}`;
          const shotData: ShotData = {
            id: shotId,
            series_slug: slug,
            episode_id: ep.id,
            index: si + 1,
            duration_sec: skelShot.duration,
            character_ids: characters.map(c => c.id),
            scene_id: scenes.length > 0 ? scenes[0].id : undefined,
            action,
            status: "drafted",
            shot_type: "medium",
          };
          await ensureDir(path.join(episodeDir(slug, ep.id), "shots"));
          await writeJson(path.join(episodeDir(slug, ep.id), "shots", `${shotId}.json`), shotData);
          allShots.push(shotData);
        }
      }
    }
  }

  const series = await readSeries(slug);
  if (!series) throw Object.assign(new Error("系列不存在"), { status: 404, code: "NotFound" });

  return { series: series!, episodes: allEpisodes, shots: allShots, characters, scenes };
}

/** Resolve {slot_id} placeholders in a template string */
function _resolvePlaceholders(
  text: string,
  charBindings: Record<string, { name?: string } | null>,
  sceneBindings: Record<string, { name?: string } | null>,
): string {
  return text.replace(/\{(\w+)\}/g, (_match, key) => {
    const cb = charBindings?.[key];
    if (cb?.name) return cb.name;
    const sb = sceneBindings?.[key];
    if (sb?.name) return sb.name;
    return `[${key}]`;
  });
}

/**
 * Save current series as a custom built-in template to config/templates/.
 */
export async function saveSeriesAsTemplate(slug: string): Promise<BuiltinTemplate> {
  const series = await readSeries(slug);
  if (!series) throw Object.assign(new Error("系列不存在"), { status: 404, code: "NotFound" });

  const characters = await listCharacters(slug);
  const scenes = await listScenes(slug);
  const episodes = await listEpisodes(slug);

  // Build character placeholders
  const character_placeholders: TemplatePlaceholder[] = characters.map(c => ({
    slot_id: slugify(c.name),
    role: c.role,
    hint: `${c.name}(${c.role}): ${(c.appearance_prompt || c.appearance || "").slice(0, 80)}`,
  }));

  // Build scene placeholders
  const scene_placeholders: TemplatePlaceholder[] = scenes.map(s => ({
    slot_id: slugify(s.name),
    hint: s.description || s.name,
  }));

  // Build skeleton from episodes
  const skeletonEpisodes: SkeletonEpisode[] = [];
  for (const ep of episodes) {
    const shots = await listShots(slug, ep.id);
    skeletonEpisodes.push({
      index: ep.index,
      title_template: ep.title,
      shots_skeleton: shots.map(s => ({
        action_template: s.action || "",
        duration: s.duration_sec,
      })),
    });
  }

  const builtin: BuiltinTemplate = {
    id: slugify(series.title),
    label: `${series.title} (自定义模板)`,
    description: `从系列「${series.title}」导出的自定义模板`,
    defaults: series.defaults,
    character_placeholders,
    scene_placeholders,
    storyboard_skeleton: { episodes: skeletonEpisodes },
  };

  await ensureDir(CONFIG_TEMPLATES_ROOT);
  await writeJson(path.join(CONFIG_TEMPLATES_ROOT, `${builtin.id}.json`), builtin);
  return builtin;
}
