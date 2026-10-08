/**
 * P11 - Drama 领域 Zod 运行时校验器
 * 每个 TS interface 对应一个 ZodSchema
 */
import { z } from "zod";
import type {
  Series,
  Episode,
  Character,
  Scene,
  Shot,
  Asset,
  GenerationRecord,
  Storyboard,
} from "./types.js";

// ─── 基础 schema ────────────────────────────────────────────────────────────

const SeriesDefaultsSchema = z.object({
  content_type: z.string(),
  platform: z.string(),
  aspect_ratio: z.string(),
  visual_style: z.string(),
  audience: z.string(),
  tone: z.string(),
  pacing: z.string(),
  camera_style: z.string(),
  ending_type: z.string(),
  llm_provider_id: z.string(),
  image_provider_id: z.string(),
  video_provider_id: z.string(),
  tts_provider_id: z.string(),
  tts_voice_id: z.string(),
  max_retake_per_shot: z.number(),
  max_video_seconds_per_job: z.number(),
  max_parallel_tasks: z.number(),
});

// ─── Series ──────────────────────────────────────────────────────────────────

export const SeriesSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  synopsis: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  defaults: SeriesDefaultsSchema,
  episodes: z.array(z.string()),
  character_ids: z.array(z.string()),
  scene_ids: z.array(z.string()),
  target_platform: z.string(),
  publish_meta_template_id: z.string().optional(),
});

// ─── Episode ─────────────────────────────────────────────────────────────────

export const EpisodeSchema = z.object({
  id: z.string(),
  series_slug: z.string(),
  index: z.number(),
  title: z.string(),
  synopsis: z.string(),
  script_path: z.string(),
  target_duration_sec: z.number(),
  target_shot_count: z.number(),
  hook_type: z.string(),
  status: z.enum(["drafted", "scripting", "storyboarded", "generating", "assembled", "exported"]),
  storyboard_path: z.string(),
  overrides: SeriesDefaultsSchema.partial().optional(),
});

// ─── Character ───────────────────────────────────────────────────────────────

const CharacterLockedSchema = z.object({
  image_provider_id: z.string().optional(),
  seed: z.number().optional(),
  negative_prompt: z.string().optional(),
});

const VoiceStyleMapSchema = z.record(z.string(), z.string().optional()).optional();

export const CharacterSchema = z.object({
  id: z.string(),
  series_slug: z.string(),
  name: z.string(),
  role: z.string(),
  appearance_prompt: z.string(),
  personality: z.string(),
  voice_id: z.string().optional(),
  voice_style_map: VoiceStyleMapSchema,
  ref_image_ids: z.array(z.string()),
  primary_ref_image_id: z.string().optional(),
  locked: CharacterLockedSchema,
  status: z.enum(["drafted", "candidates_generated", "locked"]),
});

// ─── Scene ───────────────────────────────────────────────────────────────────

const SceneLockedSchema = z.object({
  image_provider_id: z.string().optional(),
  seed: z.number().optional(),
  negative_prompt: z.string().optional(),
});

export const SceneSchema = z.object({
  id: z.string(),
  series_slug: z.string(),
  name: z.string(),
  location: z.string(),
  time_of_day: z.string(),
  weather: z.string(),
  atmosphere_prompt: z.string(),
  lighting: z.string(),
  style_anchor: z.string(),
  ref_image_ids: z.array(z.string()),
  primary_ref_image_id: z.string().optional(),
  locked: SceneLockedSchema,
  status: z.enum(["drafted", "candidates_generated", "locked"]),
});

// ─── GenerationRecord (D6+D8: unified + all optional fields) ──────────────────

const QualityScoresSchema = z.object({
  composition: z.number(),
  sharpness: z.number(),
  prompt_alignment: z.number(),
  subject_completeness: z.number(),
  checked_at: z.string(),
});

export const GenerationRecordSchema = z.object({
  generation_id: z.string(),
  type: z.enum(["first_frame", "video"]),
  provider: z.string(),
  asset_id: z.string().optional(),
  vault_id: z.string().optional(),
  path: z.string().optional(),
  picked: z.boolean().optional(),
  created_at: z.string(),
  status: z.enum(["pending", "running", "done", "failed"]),
  error: z.string().optional(),
  prompt_version: z.number().optional(),
  quality_scores: QualityScoresSchema.optional(),
  // D8: 补全所有 optional 字段
  provider_job_id: z.string().optional(),
  provider_file_id: z.string().optional(),
  model_id: z.string().optional(),
  request_payload_digest: z.string().optional(),
  prompt_final: z.string().optional(),
  negative_prompt: z.string().optional(),
  duration_sec_requested: z.number().optional(),
  duration_sec_actual: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  bytes: z.number().optional(),
  cost_cny: z.number().optional(),
  submitted_at: z.string().optional(),
  completed_at: z.string().optional(),
  downloaded_at: z.string().optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
});

// ─── Shot (D6: unified with storage ShotData) ─────────────────────────────────

const ShotFailureSchema = z.object({
  at: z.string(),
  stage: z.string(),
  error: z.string(),
});

const PromptVersionSchema = z.object({
  version: z.number(),
  content: z.string(),
  created_at: z.string(),
  created_by: z.enum(["ai", "user"]),
});

export const ShotSchema = z.object({
  id: z.string(),
  series_slug: z.string(),
  episode_id: z.string(),
  index: z.number(),
  duration_sec: z.number(),
  character_ids: z.array(z.string()),
  scene_id: z.string().optional(),
  element_ids: z.array(z.string()).optional().default([]),
  shot_type: z.string().optional(),
  camera_movement: z.string().optional(),
  action: z.string().optional(),
  dialogue: z.string().optional(),
  voiceover: z.string().optional(),
  prompt_img: z.string().optional(),
  prompt_vid: z.string().optional(),
  prompt_img_versions: z.array(PromptVersionSchema).optional(),
  prompt_vid_versions: z.array(PromptVersionSchema).optional(),
  negative_prompt: z.string().optional(),
  aspect_ratio: z.string().optional(),
  generations: z.array(GenerationRecordSchema).optional(),
  active_generations: z.array(GenerationRecordSchema).optional(),
  trashed_generations: z.array(GenerationRecordSchema).optional(),
  picked_generation_id: z.string().optional(),
  picked_first_frame_generation_id: z.string().nullable().optional(),
  picked_video_generation_id: z.string().nullable().optional(),
  video_mode: z.enum(["i2v", "t2v"]).optional(),
  status: z.string(),
  failures: z.array(ShotFailureSchema).optional(),
  use_prev_last_frame: z.boolean().optional(),
  first_frame_from_prev: z.boolean().optional(),
  last_frame_vault_id: z.string().optional(),
  title: z.string().optional(),
  scene_label: z.string().optional(),
  visual_prompt: z.string().optional(),
  quality_warning: z.object({ score: z.number(), at: z.string() }).optional(),
  continuity_warning: z.object({ reason: z.string().optional(), at: z.string() }).optional(),
});

// ─── Asset ───────────────────────────────────────────────────────────────────

const AssetSourceSchema = z.object({
  provider_id: z.string().optional(),
  generation_id: z.string().optional(),
  upload_original_name: z.string().optional(),
});

export const AssetSchema = z.object({
  id: z.string(),
  series_slug: z.string(),
  kind: z.enum(["image", "video", "audio", "doc"]),
  mime: z.string(),
  relative_path: z.string(),
  bytes: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration_sec: z.number().optional(),
  tags: z.array(z.string()),
  source: AssetSourceSchema,
  created_at: z.string(),
});

// ─── BeatSheet (B2: Generator-Critic 两阶段叙事节拍) ─────────────────────────

const BeatSchema = z.object({
  beat_name: z.string(),
  description: z.string(),
  target_duration_sec: z.number(),
  key_elements: z.array(z.string()),
});

export const BeatSheetSchema = z.object({
  hook_3s: BeatSchema,
  setup: BeatSchema,
  inciting_incident: BeatSchema,
  midpoint_twist: BeatSchema,
  climax: BeatSchema,
  payoff: BeatSchema,
});

export type BeatSheet = z.infer<typeof BeatSheetSchema>;

// ─── CriticVerdict (B2: 分镜质量审查结果) ────────────────────────────────────

const DriftFlagSchema = z.object({
  shot_id: z.string(),
  reason: z.string(),
  suggestion: z.string(),
});

const MissingBeatSchema = z.object({
  beat_name: z.string(),
  reason: z.string(),
  suggestion: z.string(),
});

const DurationAnalysisSchema = z.object({
  total_sec: z.number(),
  target_sec: z.number(),
  verdict: z.enum(["ok", "over", "under"]),
});

export const CriticVerdictSchema = z.object({
  coverage_score: z.number().min(0).max(1),
  drift_flags: z.array(DriftFlagSchema),
  missing_beats: z.array(MissingBeatSchema),
  overall_comment: z.string(),
  duration_analysis: DurationAnalysisSchema,
});

export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;

// ─── Storyboard ──────────────────────────────────────────────────────────────

const StoryboardEntrySchema = z.object({
  shot_id: z.string(),
  index: z.number(),
});

export const StoryboardSchema = z.object({
  episode_id: z.string(),
  series_slug: z.string(),
  shots: z.array(StoryboardEntrySchema),
  updated_at: z.string(),
});

// ─── 解析入口 ────────────────────────────────────────────────────────────────

export function parseSeries(json: unknown): Series {
  return SeriesSchema.parse(json) as Series;
}

export function safeParseSeries(json: unknown) {
  return SeriesSchema.safeParse(json);
}

export function parseEpisode(json: unknown): Episode {
  return EpisodeSchema.parse(json) as Episode;
}

export function parseCharacter(json: unknown): Character {
  return CharacterSchema.parse(json) as Character;
}

export function parseScene(json: unknown): Scene {
  return SceneSchema.parse(json) as Scene;
}

export function parseShot(json: unknown): Shot {
  return ShotSchema.parse(json) as Shot;
}

export function parseAsset(json: unknown): Asset {
  return AssetSchema.parse(json) as Asset;
}

export function parseStoryboard(json: unknown): Storyboard {
  return StoryboardSchema.parse(json) as Storyboard;
}
