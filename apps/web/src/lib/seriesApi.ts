// ====================================================================
// seriesApi.ts — Series CRUD + Inspirations + Templates + Preferences
// (P1 wave 2 #11 解耦)
// ====================================================================
// 覆盖范围:
// - SeriesRecord / EpisodeRecord / 创建/列表/删除/duplicate/update
// - TrashedSeriesEntry (软删 90 天)
// - SeriesAssetRecord (素材上传)
// - InspirationRecord / 灵感箱 CRUD
// - ClarifyQuestion / InferSetting
// - TemplateRecord / BuiltinTemplate / Apply / SaveAsTemplate
// - ProjectPreferenceSummary
// - expandScriptV2
// - createEpisode / deleteEpisode
// ====================================================================

import {
  apiGet,
  apiPost,
  apiDelete,
  apiPatch,
  handleFetchResponse,
} from "./_apiClient";

// ====================================================================
// SERIES CRUD (P31)
// ====================================================================

export interface SeriesRecord {
  slug: string;
  title: string;
  description?: string;
  synopsis?: string;
  cover_url?: string;
  /** 2026-05-21 — 系列封面生成 (StudioHome 卡片读这个,没生成时 fallback CSS 渐变) */
  cover_vault_id?: string;
  cover_prompt_snapshot?: string;
  cover_provider_id?: string;
  episode_count: number;
  total_cost: number;
  created_at: string;
  updated_at: string;
  template_id?: string;
  character_ids?: string[];
  scene_ids?: string[];
  /** 铁律 #4: 系列默认配置 (列表接口只含部分字段, 详情接口含全量) */
  defaults?: { aspect_ratio?: string; [key: string]: unknown };
  /**
   * W5 (2026-05-26) — 单组遗留字段, 已被 W7 cast_ids 取代, 保留兼容.
   * @deprecated W7 起请用 cast_ids 数组
   */
  cast_id?: string;
  /**
   * W7 (2026-05-26) — 本剧加入的素材组 id 数组 (多组合并使用).
   * 空数组 / undefined = 本剧专属, 不与任何组共享.
   */
  cast_ids?: string[];
  /**
   * 2026-05-28 — AI 出图打磨: 全剧美学指南 (Style Bible) 自由文本, 0-600 字.
   * SeriesDetail "全剧美学" 卡片让用户填; deriveSeriesContextForShot 自动喂每镜 prompt.
   * 空时 fallback 到 defaults.visual_style preset.
   */
  visual_style_guide?: string;
}

/**
 * 2026-05-21 — 生成系列封面图 (首页 StudioHome 卡片显示用).
 * 跟 episode generate-cover 镜像: 用 image provider + cover_designer prompt + 1080x1920 竖屏.
 * 落 vault + 写 series.cover_vault_id, 首页卡片自动刷新.
 */
export interface CoverGenerationOptions {
  style?: string;
  title_text?: string;
  provider_override?: string;
  prompt_override?: string;
  reference_shot_id?: string;
  reference_asset_id?: string;
}

export interface CoverPromptPreview {
  ok: boolean;
  prompt: string;
  reference_images: Array<{ url: string; label: string }>;
  reference_asset_id?: string;
  width: number;
  height: number;
  provider_id: string;
}

export function previewCoverPrompt(slug: string, input: CoverGenerationOptions, episodeId?: string) {
  const path = `/api/v2/series/${encodeURIComponent(slug)}${episodeId ? `/episodes/${encodeURIComponent(episodeId)}` : ""}/generate-cover/preview`;
  return apiPost<CoverPromptPreview>(path, input);
}

export async function generateSeriesCover(slug: string, input: CoverGenerationOptions = {}) {
  return apiPost<{
    ok: boolean;
    vault_id: string;
    url: string;
    width: number;
    height: number;
    provider_used: string;
    prompt_snapshot: string;
  }>(`/api/v2/series/${slug}/generate-cover`, input);
}

export interface EpisodeRecord {
  id?: string;
  episode_id?: string;
  index?: number;
  episode_number?: number;
  title: string;
  synopsis?: string;
  script_path?: string;
  script_md?: string;
  target_duration_sec?: number;
  target_shot_count?: number;
  storyboard_path?: string;
  status: string;
  created_at: string;
  updated_at?: string;
  /** 2026-05-21 — 集级封面图 vault_id (用户点 SeriesDetail 集卡片 "生成封面" 后落盘) */
  cover_vault_id?: string;
  cover_prompt_snapshot?: string;
  cover_provider_id?: string;
  /**
   * 2026-05-26 — 后端 GET /series/:slug/episodes 聚合返回字段, 给前端卡片显示真实进度用.
   * 修复用户反馈: 用户选了视频但卡片仍显示"时长待定"; 用户分不清"待完善"具体缺啥.
   */
  /** 真实分镜数 (vs target_shot_count = LLM 拆镜目标) */
  actual_shot_count?: number;
  /** 2026-05-27: 已挑首帧的分镜数 — 一键生成 launcher 展示进度用 */
  picked_first_frame_count?: number;
  /** 已选定视频的分镜数 */
  picked_video_count?: number;
  /** 已选视频的真长累加 (秒, 优先 duration_sec_actual) */
  picked_video_total_duration_sec?: number;
}

/**
 * 2026-05-21 — 集封面生成
 * 路由: POST /api/v2/series/:slug/episodes/:epId/generate-cover
 * 后端 episodeUseCases.generateCover, 成功后回写 episode.cover_vault_id
 */
export async function generateEpisodeCover(slug: string, epId: string, input: CoverGenerationOptions = {}) {
  return apiPost<{
    ok: boolean;
    asset_id: string;
    url: string;
    width: number;
    height: number;
    provider_used: string;
    prompt_snapshot: string;
  }>(`/api/v2/series/${slug}/episodes/${epId}/generate-cover`, input);
}

export async function listSeries(options?: { includeInternal?: boolean }) {
  const qs = options?.includeInternal ? "?include_internal=1" : "";
  return apiGet<{ series: SeriesRecord[] }>(`/api/v2/series${qs}`);
}

export async function getSeries(slug: string) {
  return apiGet<{ series: SeriesRecord; episodes: EpisodeRecord[] }>(`/api/v2/series/${slug}`);
}

export async function createEpisode(slug: string, input: { title?: string; index?: number; overrides?: Record<string, any> }) {
  return apiPost<{ episode: { id: string; title: string; index: number; status: string } }>(`/api/v2/series/${slug}/episodes`, input);
}

/**
 * 2026-05-19 #14: 删除分集 — 后端走软删 (.trash/ 90 天可恢复, 铁律 #6).
 * 用户原话"不小心新建的分集无法删除" — 加 UI 入口 + 二次确认 + 真发后端.
 */
export async function deleteEpisode(slug: string, epId: string) {
  return apiDelete<{ ok: boolean; message?: string }>(`/api/v2/series/${slug}/episodes/${epId}`);
}

export async function createSeries(input: {
  title: string;
  synopsis?: string;
  library_character_ids?: string[];
  library_scene_ids?: string[];
  defaults?: Record<string, any>;
}) {
  return apiPost<{ series: SeriesRecord }>("/api/v2/series", input);
}

export async function duplicateSeries(slug: string) {
  return apiPost<{ series: SeriesRecord }>(`/api/v2/series/${slug}/duplicate`);
}

export async function deleteSeries(slug: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/series/${slug}`);
}

// 2026-05-19 Wave O 致命遗留 2: 系列回收站 API client
export interface TrashedSeriesEntry {
  trash_id: string;
  original_slug: string;
  trashed_at: string;
  expires_at: string;
  days_remaining: number;
  title?: string;
  synopsis?: string;
  episode_count?: number;
  total_cost?: number;
}
export async function listTrashedSeries() {
  return apiGet<{ ok: boolean; records: TrashedSeriesEntry[] }>(`/api/v2/series-trash`);
}
export async function restoreTrashedSeries(trashId: string) {
  return apiPost<{ ok: boolean; slug: string; message: string }>(`/api/v2/series-trash/${encodeURIComponent(trashId)}/restore`);
}
export async function permanentDeleteTrashedSeries(trashId: string) {
  return apiDelete<{ ok: boolean; message: string }>(`/api/v2/series-trash/${encodeURIComponent(trashId)}`);
}

export async function updateSeries(slug: string, patch: {
  title?: string;
  synopsis?: string;
  defaults?: Record<string, any>;
  /** 2026-05-28 — AI 出图打磨: 全剧美学指南 (Style Bible) 自由文本 */
  visual_style_guide?: string;
}) {
  return apiPatch<{ series: SeriesRecord }>(`/api/v2/series/${slug}`, patch);
}

export interface SeriesAssetRecord {
  asset_id: string;
  series_slug: string;
  kind: "image" | "video" | "audio";
  tags: string[];
  path: string;
  filename: string;
  mime: string;
  size_bytes: number;
  sha256?: string;
  created_at: string;
}

export async function uploadSeriesAssets(slug: string, files: File[], tags: string[] = []) {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  if (tags.length > 0) form.append("tags", tags.join(","));
  const response = await fetch(`/api/v2/series/${encodeURIComponent(slug)}/assets`, {
    method: "POST",
    body: form,
    // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(DEFAULT_TIMEOUT_MS).
  });
  return handleFetchResponse<{ ok: boolean; assets: SeriesAssetRecord[] }>(response);
}

/** v2: POST /api/v2/series/:slug/expand-script */
export async function expandScriptV2(slug: string, input: {
  raw_inspiration: string;
  overrides?: Record<string, unknown>;
  title?: string;
  file_texts?: string[];
  /**
   * 2026-05-20 P1 铁律 #12 (批改+发送一致): 用户在 PromptReviewButton 弹窗里改完
   * 完整 prompt 后点"用修改后版本发送"时, 把编辑后的完整 prompt 透传到这里,
   * 后端用它替代 compilePrompt() 输出. 默认 undefined 走原 compile 路径.
   */
  prompt_override?: string;
}) {
  return apiPost<{ ok: boolean; episode_id?: string; script_id?: string; script: any; message?: string }>(`/api/v2/series/${slug}/expand-script`, input);
}

export type InspirationSource = "Twitter" | "微博" | "Pinterest" | "截图" | "灵感" | "朋友圈" | "B 站";

export interface InspirationRecord {
  id: string;
  src: InspirationSource;
  user: string;
  text: string;
  tags: string[];
  createdAt: number;
  unread: boolean;
  saved?: boolean;
  type: "image" | "video" | "text";
  expandedEpisodeId?: string | null;
}

export async function listInspirations(slug: string) {
  return apiGet<{ inspirations: InspirationRecord[] }>(`/api/v2/series/${encodeURIComponent(slug)}/inspirations`);
}

export async function createInspiration(slug: string, input: {
  src?: InspirationSource;
  user?: string;
  text: string;
  tags?: string[];
  type?: "image" | "video" | "text";
  saved?: boolean;
}) {
  return apiPost<{ inspiration: InspirationRecord }>(`/api/v2/series/${encodeURIComponent(slug)}/inspirations`, input);
}

export async function patchInspiration(
  slug: string,
  id: string,
  patch: Partial<Pick<InspirationRecord, "text" | "tags" | "unread" | "saved" | "expandedEpisodeId">>,
) {
  return apiPatch<{ inspiration: InspirationRecord }>(
    `/api/v2/series/${encodeURIComponent(slug)}/inspirations/${encodeURIComponent(id)}`,
    patch,
  );
}

export async function deleteInspiration(slug: string, id: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/series/${encodeURIComponent(slug)}/inspirations/${encodeURIComponent(id)}`);
}

// ====================================================================
// CLARIFY & INFER (P160-B1 创作起点三入口)
// ====================================================================

export interface ClarifyQuestionDef {
  dim: string;
  question: string;
  options: string[];
}

export type ClarifySeriesResult =
  | { proceed: true; inferred_settings: Record<string, any> }
  | { proceed: false; questions: ClarifyQuestionDef[] };

export async function clarifySeries(slug: string, userInput: string) {
  return apiPost<ClarifySeriesResult>(`/api/v2/series/${slug}/clarify`, { user_input: userInput });
}

export interface InferSettingInput {
  setting_key: string;
  dict_id: string;
  context?: {
    inspiration?: string;
    current_settings?: Record<string, string>;
  };
}

export interface InferSettingResult {
  ok: boolean;
  suggested_value: string;
  reason: string;
}

export async function inferSeriesSetting(slug: string, input: InferSettingInput) {
  return apiPost<InferSettingResult>(`/api/v2/series/${slug}/infer-setting`, input);
}

export async function listSamples() {
  return apiGet<{ samples: string[] }>("/api/v2/series/samples");
}

export async function cloneSample(sampleId: string) {
  return apiPost<{ series: SeriesRecord & { episodes?: string[] } }>("/api/v2/series/clone-sample", { sample_id: sampleId });
}

// ====================================================================
// B5: PREFERENCES
// ====================================================================

export interface ProjectPreferenceSummary {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
}

export async function listProjectsWithPreferences() {
  return apiGet<{ ok: boolean; projects: ProjectPreferenceSummary[] }>("/api/v2/preferences/projects");
}

export async function getSeriesPreferences(slug: string) {
  return apiGet<{
    ok: boolean;
    has_preferences: boolean;
    preferences?: {
      version: number;
      built_at: string;
      total_events: number;
      summary: string;
      tags: string[];
    };
  }>(`/api/v2/series/${slug}/preferences`);
}

export async function copyPreferences(targetSlug: string, sourceSlug: string) {
  return apiPost<{ ok: boolean; preferences: ProjectPreferenceSummary }>(
    `/api/v2/series/${targetSlug}/copy-preferences`,
    { source_slug: sourceSlug }
  );
}

// ====================================================================
// TEMPLATES (P31 settings drawer + P130 Wave 2E)
// ====================================================================

export interface TemplateRecord {
  id: string;
  name: string;
  description?: string;
}

/** Built-in template from config/templates/*.json */
export interface BuiltinTemplate {
  id: string;
  label: string;
  preview_image?: string;
  description?: string;
  defaults?: Record<string, any>;
  character_placeholders?: TemplatePlaceholder[];
  scene_placeholders?: TemplatePlaceholder[];
  storyboard_skeleton?: TemplateSkeleton;
}

export interface TemplatePlaceholder {
  slot_id: string;
  role?: string;
  hint: string;
}

export interface TemplateSkeleton {
  episodes: TemplateSkeletonEpisode[];
}

export interface TemplateSkeletonEpisode {
  index: number;
  title_template: string;
  shots_skeleton: TemplateSkeletonShot[];
}

export interface TemplateSkeletonShot {
  action_template: string;
  duration: number;
}

export interface ApplyTemplateInput {
  template_id: string;
  character_bindings?: Record<string, { name?: string; role?: string; appearance_prompt?: string; personality?: string } | null>;
  scene_bindings?: Record<string, { name?: string; description?: string } | null>;
}

export async function listTemplates() {
  return apiGet<{ templates: TemplateRecord[]; builtin_templates?: BuiltinTemplate[] }>("/api/v2/templates");
}

/** Fetch a single template by id (built-in or user) */
export async function getTemplate(id: string) {
  return apiGet<{ template: BuiltinTemplate | TemplateRecord; source: "builtin" | "user" }>(`/api/v2/templates/${id}`);
}

/** Apply a built-in template skeleton to create episodes/shots/characters/scenes */
export async function applyTemplateToSeries(slug: string, input: ApplyTemplateInput) {
  return apiPost<{ ok: boolean; series: any; episodes: any[]; shots: any[]; characters: any[]; scenes: any[] }>(
    `/api/v2/series/${slug}/apply-template`,
    input
  );
}

/** Save current series as a custom built-in template */
export async function saveSeriesAsTemplate(slug: string) {
  return apiPost<{ template: BuiltinTemplate }>(`/api/v2/templates/from-series/${slug}`);
}
