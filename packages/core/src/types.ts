export type VisualType =
  | "title_card"
  | "keyword_card"
  | "diagram"
  | "concept_image"
  | "ai_video_placeholder"
  | "stock_placeholder";

export type SceneStatus =
  | "planned"
  | "asset_ready"
  | "audio_ready"
  | "subtitle_ready"
  | "rendered"
  | "failed"
  | "fallback"
  | "draft"
  | "approved"
  | "edited"
  | "needs_regen"
  | "generated";

export type AssetVersionStatus = "active" | "superseded" | "failed";

export interface AssetVersion {
  version_id: string;
  provider: string;
  path: string | null;
  source_scene_id?: string;
  file_size_bytes?: number;
  sha256?: string;
  created_at: string;
  activated_at?: string | null;
  status: AssetVersionStatus;
}

export type ClipVersionStatus = "planned" | "generating" | "ready" | "failed" | "active" | "superseded";

export type VideoProviderName = "local_mock_video" | "minimax_hailuo" | "aliyun_wan_t2v" | "vidu_q3_ref" | "future_api";

export interface ClipVersion {
  version_id: string;
  provider: string;
  provider_job_id?: string | null;
  path: string | null;
  prompt: string;
  status: ClipVersionStatus;
  duration_sec?: number;
  aspect_ratio?: string;
  resolution?: string;
  error_type?: string | null;
  source_asset_path?: string | null;
  created_at?: string;
  activated_at?: string | null;
}

export type JobStage =
  | "created"
  | "document_parsing"
  | "awaiting_document_review"
  | "script_understanding"
  | "awaiting_script_review"
  | "scene_planning"
  | "awaiting_storyboard_review"
  | "visual_direction"
  | "awaiting_visual_review"
  | "metadata"
  | "assets"
  | "subtitles"
  | "audio"
  | "render"
  | "awaiting_render_confirm"
  | "qa"
  | "completed"
  | "failed"
  | "revision";

/** 每个 JobStage 的中文用户可见名称 */
export const JOB_STAGE_LABELS: Record<JobStage, string> = {
  created: "已创建",
  document_parsing: "文档解析中",
  awaiting_document_review: "文档待审阅",
  script_understanding: "剧本理解中",
  awaiting_script_review: "剧本待审阅",
  scene_planning: "场景规划中",
  awaiting_storyboard_review: "分镜待审阅",
  visual_direction: "视觉设计",
  awaiting_visual_review: "视觉待审阅",
  metadata: "元数据生成",
  assets: "素材生成",
  subtitles: "字幕合成",
  audio: "音频合成",
  render: "视频渲染",
  awaiting_render_confirm: "渲染待确认",
  qa: "质量检查",
  completed: "已完成",
  failed: "失败",
  revision: "修订中",
};

export type SubtitleMode = "sidecar" | "burn" | "both";

export type AudioMode = "real_tts" | "partial_tts" | "silence" | "fallback" | "anullsrc_fallback";

export type RenderAudioSource = "real_audio" | "partial_real_audio" | "silence_file" | "anullsrc_fallback";

export type GenerationMode = "auto" | "review" | "director";

export type VideoStyle = "knowledge_card" | "cartoon_explainer" | "short_drama" | "auto";

export interface GenerationModeConfig {
  mode: GenerationMode;
  auto_continue: boolean;
  stop_at_gates: string[];
  allow_manual_edit: boolean;
  allow_regeneration: boolean;
}

export interface ScriptUnderstanding {
  summary: string;
  audience: string;
  tone: string;
  content_type?: string;
  recommended_style?: string;
  structure: Array<{
    title: string;
    purpose: string;
    key_points: string[];
  }>;
  visual_direction: string;
  potential_difficulties?: string[];
}

export interface SceneManifestScene {
  scene_id: number;
  stable_scene_id: string;
  order: number;
  chapter: string;
  scene_title: string;
  narration_text: string;
  narration_mode: "verbatim_or_adapted" | "verbatim" | "adapted";
  visual_goal: string;
  visual_type: VisualType;
  visual_prompt: string;
  local_card_prompt: string;
  future_image_prompt: string;
  future_video_prompt: string;
  negative_prompt: string;
  screen_text: string[];
  keywords: string[];
  motion_suggestion: string;
  layout_suggestion: string;
  visual_consistency_tags: string[];
  fallback_strategy: string;
  duration_estimate_sec: number;
  actual_duration_sec: number | null;
  asset_path: string | null;
  audio_path: string | null;
  subtitle_path: string | null;
  status: SceneStatus;
  fallback_used: boolean;
  notes: string;
  locked: boolean;
  needs_regen: boolean;
  needs_audio_regen: boolean;
  version: number;
  major_version?: number;
  minor_version?: number;
  updated_at: string;
  asset_versions: AssetVersion[];
  clip_versions: ClipVersion[];
  active_clip_version_id?: string | null;
  clip_generation_status?: "idle" | "generating" | "ready" | "failed";
  image_versions?: ImageVersion[];
  active_image_version_id?: string | null;
}

export interface VideoMetadata {
  bilibili_title: string;
  bilibili_description: string;
  bilibili_tags: string[];
  cover_text: string;
  comment_prompt: string;
  episode_suggestions?: string[];
}

export interface SceneManifest {
  job_id: string;
  project_title: string;
  source_language: string;
  target_platform: "bilibili";
  aspect_ratio: string;
  resolution: string;
  style: string;
  visual_strategy: string;
  llm_provider: string;
  llm_base_url: string;
  llm_model: string;
  llm_mock: boolean;
  subtitle_mode: SubtitleMode;
  audio_mode?: AudioMode;
  render_audio_source?: RenderAudioSource;
  burned_subtitles?: boolean;
  created_at: string;
  updated_at: string;
  script_understanding: ScriptUnderstanding;
  scenes: SceneManifestScene[];
  metadata: VideoMetadata;
  revision_history?: RevisionPlan[];
  // 2026-05-28 audit P1 type-safety — QA / runner 写入的实测统计字段, 之前用 (manifest as any).XX 偷加 → 现声明为可选字段
  clip_scene_count?: number;
  card_fallback_scene_count?: number;
  video_provider_used?: string;
}

export interface JobRecord {
  job_id: string;
  created_at: string;
  updated_at: string;
  stage: JobStage;
  progress: number;
  status: "queued" | "running" | "completed" | "failed" | "awaiting_approval";
  style: string;
  visual_strategy: string;
  video_style: VideoStyle;
  generation_mode: GenerationMode;
  aspect_ratio?: string;
  resolution?: string;
  source_filename: string;
  output_dir: string;
  fallback_count: number;
  error?: string;
  agents: Record<string, "pending" | "running" | "completed" | "failed" | "fallback">;
  approvals: Record<string, "pending" | "approved" | "rejected" | "edited">;
}

export interface RevisionPlan {
  revision_id: string;
  created_at: string;
  user_instruction: string;
  summary: string;
  affected_scenes: number[];
  modification_type:
    | "manifest_only"
    | "visual_only"
    | "subtitle_only"
    | "rerender_required"
    | "full_replan";
  rerender_required: boolean;
  full_replan_required: boolean;
  scene_updates: Array<{
    scene_id: number;
    fields_to_update: string[];
    instructions: string;
    replacement?: Partial<SceneManifestScene>;
  }>;
  global_updates?: {
    style?: string;
    visual_strategy?: string;
    tone?: string;
    notes?: string;
  };
  risks: string[];
}

export interface QaReport {
  job_id: string;
  created_at: string;
  status: "pass" | "warning" | "fail";
  summary: string;
  checks: Array<{
    name: string;
    status: "pass" | "warning" | "fail";
    detail: string;
  }>;
  ffprobe?: {
    duration_sec?: number;
    width?: number;
    height?: number;
    video_codec?: string;
    audio_codec?: string;
    has_audio?: boolean;
  };
  llm_mode: "real" | "mock";
  subtitle_mode: SubtitleMode;
  audio_mode: AudioMode;
  render_audio_source: RenderAudioSource;
  burned_subtitles: boolean;
  global_model_provider?: string;
  text_llm_provider?: string;
  multimodal_provider?: string;
  tts_provider?: string;
  tts_model?: string;
  tts_mode?: string;
  tts_selected_endpoint?: string;
  tts_selected_auth?: string;
  tts_fallback_used?: boolean;
  tts_fallback_provider?: string;
  real_audio_scene_count?: number;
  fallback_audio_scene_count?: number;
  audio_silence_suspected?: boolean;
  audio_health_warning?: string;
  audio_duration_sec?: number;
  subtitle_duration_sec?: number;
  audio_subtitle_delta_sec?: number;
  final_audio_size_bytes?: number;
  output_ready_level?: string;
  clip_scene_count?: number;
  card_fallback_scene_count?: number;
  video_provider_used?: string;
  llm_review?: {
    status: "pass" | "warning" | "fail";
    strengths: string[];
    issues: string[];
    recommendations: string[];
  };
  three_layer_qa?: ThreeLayerQa;
  engineering_qa?: EngineeringQa;
  content_qa?: ContentQa;
  publish_qa?: PublishQa;
}

export interface CreateJobInput {
  scriptText: string;
  filename?: string;
  style: string;
  visualStrategy: string;
  videoStyle?: VideoStyle;
  generationMode?: GenerationMode;
  documentJobId?: string;
  aspectRatio?: string;
  resolution?: string;
}

export type ImageProviderName = "local_card_image" | "future_gpt_image_2" | "future_flux" | "future_wanx" | "future_hunyuan_image";

export interface ImageProviderConfig {
  id: ImageProviderName;
  label: string;
  enabled: boolean;
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
}

export type ImageVersionStatus = "planned" | "generating" | "ready" | "failed" | "active" | "superseded";

export interface ImageVersion {
  version_id: string;
  provider: string;
  path: string | null;
  prompt: string;
  status: ImageVersionStatus;
  source_scene_id: string;
  sha256?: string;
  file_size_bytes?: number;
  created_at?: string;
  activated_at?: string | null;
}

export interface ProjectBible {
  job_id: string;
  topic: string;
  source_type: "document" | "topic" | "script";
  audience: string;
  platform: string;
  aspect_ratio: string;
  resolution: string;
  duration_target_sec: number;
  scene_duration_range_sec: [number, number];
  style: string;
  tone: string;
  visual_rules: string[];
  narration_rules: string[];
  subtitle_rules: string[];
  forbidden: string[];
  quality_goals: string[];
  provider_preferences: {
    llm: string;
    tts: string;
    image: string;
    video: string;
  };
  created_at: string;
  updated_at: string;
}

export interface ProjectBrief {
  topic: string;
  audience: string;
  platform: string;
  style: string;
  duration_target_sec: number;
  angle: string;
  core_message: string;
  content_boundaries: string[];
  risk_notes: string[];
  recommended_workflow: string[];
  visual_strategy?: string;
  generation_mode?: "auto" | "review" | "director";
  aspect_ratio?: "16:9" | "9:16" | "1:1";
}

export interface ExpandedScript {
  title: string;
  hook: string;
  outline: Array<{ section_title: string; key_points: string[] }>;
  full_script: string;
  estimated_duration_sec: number;
  style_notes: string[];
  source_assumptions: string[];
}

export interface ClipManifestEntry {
  clip_id: string;
  scene_stable_id: string;
  scene_id: number;
  provider: string;
  provider_job_id: string | null;
  status: string;
  path: string;
  duration_sec: number;
  resolution: string;
  aspect_ratio: string;
  prompt: string;
  source_asset_path: string | null;
  sha256?: string;
  file_size_bytes?: number;
  active: boolean;
  created_at: string;
}

export interface ClipManifest {
  job_id: string;
  updated_at: string;
  clips: ClipManifestEntry[];
}

export interface EngineeringQa {
  status: "pass" | "warning" | "fail";
  checks: QaReport["checks"];
}

export interface ContentQa {
  status: "pass" | "warning" | "fail";
  issues: string[];
  recommendations: string[];
}

export interface PublishQa {
  status: "pass" | "warning" | "fail";
  platform: string;
  title_quality: string;
  cover_quality: string;
  publish_notes: string[];
}

export interface ThreeLayerQa {
  engineering_qa: EngineeringQa;
  content_qa: ContentQa;
  publish_qa: PublishQa;
}

export interface CostPolicy {
  max_video_jobs_per_project: number;
  max_retries_per_scene: number;
  max_candidate_clips_per_scene: number;
  video_provider_concurrency: number;
  tts_provider_concurrency: number;
  fallback_on_video_failure: string;
  fallback_on_tts_failure: string;
  stop_on_quota_error: boolean;
  mode: "economy" | "balanced" | "quality_first";
}

export interface ProviderPromptAdapterOutput {
  scene_stable_id: string;
  provider: string;
  modality: "image" | "video";
  provider_prompt: string;
  negative_prompt: string;
  duration_sec: number;
  aspect_ratio: string;
  resolution: string;
  camera_motion: string;
  style_tags: string[];
  safety_notes: string[];
}

export interface ToolRegistryEntry {
  type: string;
  status: string;
  description: string;
  cost_level?: string;
  supports_batch?: boolean | string;
  fallback?: string | null;
  supports_text_to_video?: boolean;
  supports_image_to_video?: boolean;
}

export interface ProviderCapability {
  id: string;
  type: string;
  env_names: string[];
  needs_api_key: boolean;
  is_async: boolean;
  is_polling: boolean;
  downloads_file: boolean;
  supports_text_to_video: boolean;
  supports_image_to_video: boolean;
  supports_text_to_image: boolean;
  max_duration_sec: number;
  default_duration_sec: number;
  cost_level: string;
  reliability_notes: string;
  fallback_provider: string | null;
}
