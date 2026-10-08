/**
 * v2 Validators — Zod schemas for all POST/PATCH request bodies
 */

import { z } from "zod";

// ─── Series ─────────────────────────────────────────────────────

export const CreateSeriesSchema = z.object({
  title: z.string().min(1).max(200),
  synopsis: z.string().max(2000).optional().default(""),
  library_character_ids: z.array(z.string()).max(20).optional(),
  library_scene_ids: z.array(z.string()).max(20).optional(),
  defaults: z.object({
    content_type: z.string().max(50).optional(),
    platform: z.string().max(50).optional(),
    aspect_ratio: z.string().max(20).optional(),
    visual_style: z.string().max(50).optional(),
    audience: z.string().max(100).optional(),
    tone: z.string().max(50).optional(),
    pacing: z.string().max(50).optional(),
    camera_style: z.string().max(50).optional(),
    ending_type: z.string().max(50).optional(),
    llm_provider_id: z.string().max(200).optional(),
    image_provider_id: z.string().max(200).optional(),
    video_provider_id: z.string().max(200).optional(),
    tts_provider_id: z.string().max(100).optional(),
    tts_voice_id: z.string().max(100).optional(),
    max_retake_per_shot: z.number().int().min(1).max(20).optional(),
    max_video_seconds_per_job: z.number().int().min(30).max(3600).optional(),
    max_parallel_tasks: z.number().int().min(1).max(10).optional(),
    default_template_id: z.string().max(100).optional(),
    // 2026-05-26 audit #9 修复 — CreateSeriesDialog 真发 5 个新字段,
    // 之前 schema 不声明 → strip 模式静默丢. 必须声明才能持久化到 series.defaults.
    episodes_target: z.number().int().min(1).max(30).optional(),
    duration_target_sec: z.number().int().min(5).max(600).optional(),
    default_llm: z.string().max(200).optional(),
    default_image: z.string().max(200).optional(),
    default_video: z.string().max(200).optional(),
  }).optional(),
});

export const PatchSeriesSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  synopsis: z.string().max(2000).optional(),
  defaults: z.record(z.string(), z.any()).optional(),
  // 2026-05-28 — AI 出图打磨: 全剧美学指南 (Style Bible) 自由文本.
  // 0-600 字 (deriveSeriesContextForShot 也会 slice(0, 600) 防爆 prompt 长度).
  visual_style_guide: z.string().max(600).optional(),
});

// ─── Episode ────────────────────────────────────────────────────

export const CreateEpisodeSchema = z.object({
  title: z.string().max(200).optional(),
  index: z.number().int().min(1).max(999).optional(),
  overrides: z.record(z.string(), z.any()).optional(),
});

export const PatchEpisodeSchema = z.object({
  title: z.string().max(200).optional(),
  synopsis: z.string().max(2000).optional(),
  index: z.number().int().min(1).max(999).optional(),
  status: z.string().max(50).optional(),
  overrides: z.record(z.string(), z.any()).optional(),
  script_md: z.string().max(100_000).optional(),
  version: z.number().int().min(1).optional(),
  versions: z.array(z.any()).optional(),
});

// ─── Character ──────────────────────────────────────────────────

export const CreateCharacterSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(50),
  appearance_prompt: z.string().max(2000).optional(),
  personality: z.string().min(1).max(1000),
  // Wave B-3 (2026-05-16): 拆分字段 — 老 appearance_prompt 仍 required 兼容现有调用方;
  // 新调用方可同时 / 优先填 appearance + outfit。
  appearance: z.string().max(2000).optional(),
  outfit: z.string().max(1000).optional(),
  voice_id: z.string().max(100).optional(),
  voice_style_map: z.record(z.string(), z.string().optional()).optional(),
  library_id: z.string().max(200).optional(),
});

export const PatchCharacterSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.string().max(50).optional(),
  appearance_prompt: z.string().max(2000).optional(),
  personality: z.string().max(1000).optional(),
  // Wave B-3 (2026-05-16): 拆分字段(可独立 PATCH)
  appearance: z.string().max(2000).optional(),
  outfit: z.string().max(1000).optional(),
  voice_id: z.string().max(100).optional(),
  voice_style_map: z.record(z.string(), z.string().optional()).optional(),
  /** B4: 多角度参考图 vault id 列表 */
  reference_image_set: z.array(z.string()).max(5).optional(),
  /** B4: 锁定 seed */
  locked_seed: z.number().int().optional(),
  /** B4: style_prompt 指纹 */
  style_prompt_fingerprint: z.string().max(64).optional(),
  /** B4: LoRA 路径 (v2 占位) */
  lora_path: z.string().max(500).optional(),
  /** 语音克隆样本相对路径 (series-relative) — 仅供 voice-clone-sample 上传接口写入, 前端不要直接 PATCH */
  voice_clone_sample_url: z.string().max(500).optional(),
});

// Wave P (2026-05-20): GenerateRefsSchema 删除 — character/scene generate-refs route 已合并到
// /api/v2/generate/image (target.kind="character_ref"|"scene_ref"), 前端 0 caller.

export const LockRefSchema = z.object({
  asset_id: z.string().min(1),
  /** B4: 多角度参考图 vault id 列表 (可选, 最多 5 张) */
  reference_image_set: z.array(z.string()).max(5).optional(),
  /** B4: 锁定 seed (可选) */
  locked_seed: z.number().int().optional(),
  /** B4: style_prompt 指纹 (可选, 后端也可自动生成) */
  style_prompt_fingerprint: z.string().max(64).optional(),
  /** B4: LoRA 路径 (v2 占位) */
  lora_path: z.string().max(500).optional(),
});

export const ImportFromLibrarySchema = z.object({
  library_id: z.string().min(1),
  name_alias: z.string().max(100).optional(),
});

/** 跨项目导入 schema — 既支持从资源库导入也支持从其他系列导入 */
export const ImportFromSeriesSchema = z.object({
  library_id: z.string().min(1).optional(),
  source_series_slug: z.string().min(1).optional(),
  source_character_id: z.string().min(1).optional(),
  name_alias: z.string().max(100).optional(),
  modifications: z.object({
    user_note: z.string().max(1000).optional(),
    keep_face: z.boolean().optional(),
    auto_generate_locked: z.boolean().optional(),
    provider_id: z.string().max(100).optional(),
  }).optional(),
});

/** Vault remix schema — 自然语言迭代修改 */
export const VaultRemixSchema = z.object({
  user_note: z.string().min(1).max(2000),
  count: z.number().int().min(1).max(5).default(1),
  provider_id: z.string().max(100).optional(),
  context_override: z.object({
    keep_face: z.boolean().optional(),
    keep_pose: z.boolean().optional(),
    keep_style: z.boolean().optional(),
  }).optional(),
});

/** Vault inpaint schema — 局部重抽 */
export const VaultInpaintSchema = z.object({
  mask_base64: z.string().min(1),
  user_note: z.string().min(1).max(2000),
  provider_id: z.string().max(100).optional(),
});

// ─── Scene ──────────────────────────────────────────────────────

export const CreateSceneSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  visual_style: z.string().max(100).optional(),
  location: z.string().max(200).optional(),
  time_of_day: z.string().max(50).optional(),
  mood: z.string().max(100).optional(),
  library_id: z.string().max(200).optional(),
});

export const PatchSceneSchema = z.object({
  name: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  visual_style: z.string().max(100).optional(),
  location: z.string().max(200).optional(),
  time_of_day: z.string().max(50).optional(),
  mood: z.string().max(100).optional(),
});

// ─── Shot ───────────────────────────────────────────────────────

/**
 * 2026-05-21 Wave Y P6 — ShotTextNode 富文本节点公共 schema (5 个文本字段都用).
 * 与 packages/drama/src/types.ts 的 ShotTextNode union 同步.
 * 提到 Schema 块之前是为了 CreateShotSchema / PatchShotSchema 都能引用.
 */
const ShotTextNodeArraySchema = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string().max(5000) }),
    z.object({
      type: z.literal("mention"),
      entity_id: z.string().min(1).max(200),
      kind: z.enum(["character", "scene", "element"]),
      display: z.string().min(1).max(100),
      image_id: z.string().max(200).optional(),
    }),
  ]),
).max(400).optional();

export const CreateShotSchema = z.object({
  title: z.string().max(200).optional(),
  action: z.string().max(2000).optional(),
  prompt_img: z.string().max(2000).optional(),
  prompt_vid: z.string().max(2000).optional(),
  video_mode: z.enum(["i2v", "t2v"]).optional().default("i2v"),
  duration_sec: z.number().min(1).max(120).optional().default(5),
  aspect_ratio: z.string().max(20).optional().default("16:9"),
  shot_type: z.string().max(50).optional(),
  camera_movement: z.string().max(50).optional(),
  dialogue: z.string().max(2000).optional(),
  voiceover: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  style: z.string().max(100).optional(),
  time_of_day: z.string().max(50).optional(),
  lighting: z.string().max(100).optional(),
  mood: z.string().max(100).optional(),
  /** W5-D: 分镜情绪(中性/兴奋/紧张/伤心/愤怒等) */
  emotion: z.string().max(50).optional(),
  /** W5-D: 前置过渡(硬切/淡入/叠化等) */
  transition_in: z.string().max(50).optional(),
  /**
   * 2026-07-09 audit 修复: 单镜级转场时长(秒). ffmpegBuilder / tts 读 shot.transition_duration,
   * 之前 CreateShot/PatchShot schema 未收 → 前端调了被 zod 静默 strip, 保存 toast 虚假成功,
   * 渲染转场时长永远 fallback 0.5s. 渲染层(transitions.ts)已 clamp NaN/越界, schema 层双保险.
   */
  transition_duration: z.number().min(0).max(10).optional(),
  reference_asset_ids: z.array(z.string()).max(20).optional().default([]),
  /**
   * 2026-07-22 X3-5 (A4-14): CreateShot 补齐与 PatchShot 对称的 reference_notes /
   * reference_overrides — 之前 CreateShotSchema 缺这两字段, 前端 CreateShotInput 声明了
   * 但 zod 默认静默 strip, 建分镜时顺手带的参考图备注 / 单镜级 override 会被丢弃且不报错.
   * 定义照抄 PatchShotSchema (见下), 保持建/改两端一致. 落库在 shotController.createShot.
   */
  reference_notes: z.record(z.string(), z.string().max(500)).optional(),
  reference_overrides: z.array(z.object({
    element_id: z.string().min(1).max(100),
    image_id: z.string().min(1).max(200),
  })).max(40).optional(),
  keyframe_asset_id: z.string().max(200).optional(),
  image_model_ref: z.string().max(200).optional(),
  video_model_ref: z.string().max(200).optional(),
  character_ids: z.array(z.string()).max(20).optional().default([]),
  scene_id: z.string().max(100).optional(),
  element_ids: z.array(z.string()).max(40).optional().default([]),
  index: z.number().int().min(0).max(9999).optional(),
  // 2026-05-21 Wave Y P6 — 富文本节点 (entity-first 真理源, 与 PatchShot 同款)
  action_nodes: ShotTextNodeArraySchema,
  dialogue_nodes: ShotTextNodeArraySchema,
  voiceover_nodes: ShotTextNodeArraySchema,
  prompt_img_nodes: ShotTextNodeArraySchema,
  prompt_vid_nodes: ShotTextNodeArraySchema,
});

export const PatchShotSchema = z.object({
  title: z.string().max(200).optional(),
  duration_sec: z.number().min(1).max(120).optional(),
  shot_type: z.string().max(50).optional(),
  camera_movement: z.string().max(50).optional(),
  action: z.string().max(2000).optional(),
  dialogue: z.string().max(2000).optional(),
  voiceover: z.string().max(2000).optional(),
  prompt_img: z.string().max(2000).optional(),
  prompt_vid: z.string().max(2000).optional(),
  /**
   * 2026-05-27 — 负向词 / 排除内容. orchestrator 8 处真读 shot.negative_prompt 发给模型,
   * 但之前 PatchShotSchema 没列, 用户改了被 zod 拒收. 默认值靠 series.defaults.negative_prompt
   * 或 orchestrator 兜底 "低分辨率, 模糊, 畸变, 多余的肢体, 文字水印, 杂乱背景".
   */
  negative_prompt: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  style: z.string().max(100).optional(),
  time_of_day: z.string().max(50).optional(),
  lighting: z.string().max(100).optional(),
  mood: z.string().max(100).optional(),
  /** W5-D: 分镜情绪 */
  emotion: z.string().max(50).optional(),
  /** W5-D: 前置过渡 */
  transition_in: z.string().max(50).optional(),
  /**
   * 2026-07-09 audit 修复: 单镜级转场时长(秒). ffmpegBuilder / tts 读 shot.transition_duration,
   * 之前 CreateShot/PatchShot schema 未收 → 前端调了被 zod 静默 strip, 保存 toast 虚假成功,
   * 渲染转场时长永远 fallback 0.5s. 渲染层(transitions.ts)已 clamp NaN/越界, schema 层双保险.
   */
  transition_duration: z.number().min(0).max(10).optional(),
  /** 2026-05-17 voice-sync v1: 单镜级 TTS 声线覆盖 (优先级最高), 留空走 character.voice_id */
  tts_voice_override: z.string().max(100).optional(),
  character_ids: z.array(z.string()).max(20).optional(),
  scene_id: z.string().max(100).optional(),
  element_ids: z.array(z.string()).max(40).optional(),
  /** 2026-05-26 W1 组合性: 本镜出场角色穿的服装造型 element id (kind=wardrobe) */
  wardrobe_id: z.string().max(100).optional(),
  /** 2026-05-26 W1 组合性: 本镜额外出现的道具 element id 列表 (kind=prop) */
  prop_ids: z.array(z.string()).max(40).optional(),
  reference_asset_ids: z.array(z.string()).max(20).optional(),
  reference_notes: z.record(z.string(), z.string().max(500)).optional(),
  /**
   * 2026-05-19 Wave O Entity-first Case B: 单镜级 reference 图 override.
   * 用户在 ShotStage 给某个素材(角色/场景/项目素材)挑"本镜用这张"时写入.
   * orchestrator 拼 reference_images 时, 该 element 的图用 image_id 那张, 不走 primary fallback.
   * - element_id: 任一 character.id / scene.id / element.id
   * - image_id: 对应 element.images[i].image_id (或 asset_id)
   * 显式数组而非字典, 允许同一 element 后续扩展多张(本期仅 1:1).
   */
  reference_overrides: z.array(z.object({
    element_id: z.string().min(1).max(100),
    image_id: z.string().min(1).max(200),
  })).max(40).optional(),
  keyframe_asset_id: z.string().max(200).optional(),
  image_model_ref: z.string().max(200).optional(),
  video_model_ref: z.string().max(200).optional(),
  /** Wave 3B: 是否使用上一镜末帧作为参考 */
  use_prev_last_frame: z.boolean().optional(),
  /** Wave 1C: 视频生成模式 */
  video_mode: z.enum(["i2v", "t2v"]).optional(),
  /** W7 Phase 4: 单镜入帧裁剪起点(秒,默认 0) */
  trim_start_sec: z.number().min(0).max(120).optional(),
  /** W7 Phase 4: 单镜出帧裁剪终点(秒,默认 = duration_sec) */
  trim_end_sec: z.number().min(0).max(120).optional(),
  /**
   * 2026-05-26 W8 双阶段提交锁已下线 (用户反馈"功能没什么用 + 状态丢失感")
   * 字段保留 schema 兼容性以接受老数据 PATCH, 但服务端 / 前端均不再读取使用.
   * 见 packages/drama/src/types.ts Shot.ready_for_video.
   */
  ready_for_video: z.boolean().optional(),
  frame_anchors: z.array(z.object({
    id: z.string(),
    role: z.enum(["first", "end", "key"]),
    position: z.number().min(0).max(1),
    vault_id: z.string().optional(),
    asset_id: z.string().optional(),
    generation_id: z.string().optional(),
    created_at: z.string(),
  })).max(12).optional(),
  /**
   * 2026-05-21 Wave Y P6 — 用户编辑画面描述等富文本字段时, 前端 plainTextToNodes parse 出
   * ShotTextNode[] 同步写后端 (与 action / dialogue / voiceover / prompt_img / prompt_vid
   * plain text 字段双写, 后端读 nodes 作真理源, plain text 作 derived 兼容).
   */
  action_nodes: ShotTextNodeArraySchema,
  dialogue_nodes: ShotTextNodeArraySchema,
  voiceover_nodes: ShotTextNodeArraySchema,
  prompt_img_nodes: ShotTextNodeArraySchema,
  prompt_vid_nodes: ShotTextNodeArraySchema,
});

export const BatchToggleLastFrameSchema = z.object({
  use_prev_last_frame: z.boolean(),
});

export const GenerateFirstFrameSchema = z.object({
  count: z.number().int().min(1).max(5).default(1),
  provider_override: z.string().max(100).optional(),
  // 2026-05-20 P1 audit Bug 7: 与 shotStageController flat endpoint 对齐 — 接受 model_ref_override (provider:model 形)
  model_ref_override: z.string().max(200).optional(),
  prompt_override: z.string().max(2000).optional(),
  seed: z.number().int().optional(),
});

export const GenerateVideoSchema = z.object({
  count: z.number().int().min(1).max(3).default(1),
  provider_override: z.string().max(100).optional(),
  model_ref_override: z.string().max(200).optional(),
  prompt_override: z.string().max(2000).optional(),
  seed: z.number().int().optional(),
});

export const PickGenerationSchema = z.object({
  generation_id: z.string().min(1),
  kind: z.enum(["first_frame", "video"]).default("video"),
});

export const RetakeSchema = z.object({
  note: z.string().max(500).optional(),
});

// ── B5: Retry-until-satisfied 正式化 ───────────────────────────

export const RetryUntilSatisfiedSchema = z.object({
  max_attempts: z.number().int().min(1).max(100).default(10),
  quality_threshold: z.number().min(0).max(1).default(0.7),
  budget_cap_cny: z.number().min(0).max(10000).default(0),
  stop_on_first_green: z.boolean().default(true),
  auto_pick_best: z.boolean().default(true),
  action: z.enum(["generate_first_frames", "generate_videos"]).default("generate_videos"),
});

// ─── Orchestration ──────────────────────────────────────────────

export const ExpandScriptSchema = z.object({
  raw_inspiration: z.string().min(1).max(20_000),
  overrides: z.record(z.string(), z.any()).optional(),
  /** W6-B: 用于生成此版本的灵感 ID 列表（追踪溯源） */
  source_inspirations: z.array(z.string()).max(50).optional(),
  /** W6-B: 用户输入的额外提示词 */
  user_prompt: z.string().max(5000).optional(),
  /** W6-B: fork 自哪个剧本版本 id（手动新建版本场景） */
  parent_version_id: z.string().max(120).optional(),
  /** W6-B: 用户自定义版本标题（不传则自动生成 "剧本 vN — 首段"） */
  version_title: z.string().max(120).optional(),
  /**
   * 2026-05-20 P1 铁律 #12 (批改+发送一致): 用户在 PromptReviewButton 弹窗里编辑了
   * 完整 prompt 后点"用修改后版本发送", 把 textarea 当前文本透传到这里, 替换原始
   * compilePrompt() 生成的提示词. 默认 undefined 走原 compile 路径, 不破坏既有行为.
   *
   * 注: 这是"已编译完整 prompt", 不是 raw_inspiration. caller 仍需传原 raw_inspiration
   * 以保留 LLM 的版本溯源信息.
   */
  prompt_override: z.string().max(50_000).optional(),
});

export const GenerateAllFirstFramesSchema = z.object({
  count_per_shot: z.number().int().min(1).max(5).default(1),
  provider_override: z.string().max(100).optional(),
  prompt_override: z.string().max(2000).optional(),
  seed: z.number().int().optional(),
  only_shot_ids: z.array(z.string()).optional(),
});

export const GenerateAllVideosSchema = z.object({
  count_per_shot: z.number().int().min(1).max(3).default(1),
  provider_override: z.string().max(100).optional(),
  prompt_override: z.string().max(2000).optional(),
  seed: z.number().int().optional(),
  only_shot_ids: z.array(z.string()).optional(),
});

export const ComposeSchema = z.object({
  tts_provider: z.string().max(100).optional(),
  /**
   * 2026-05-27 — 加 tts_voice 字段接前端 ComposeSettingsPanel "全局默认音色" 选择.
   * 之前 ComposeSchema 完全没这字段, zod strip 模式静默丢弃, 用户选了等于没选 — silent
   * fallback 红线 #3 教科书案例. 优先级在 series.defaults.tts_voice_id 之上 (这一次合成
   * 临时覆盖), 但在 episode_voice_override 之下 (整集统一音色覆盖更显式).
   */
  tts_voice: z.string().max(100).optional(),
  /**
   * 2026-05-17 两阶段 TTS 工作流: 全集统一音色覆盖。
   * 优先级最高: episode_voice_override > shot.tts_voice_override
   *           > character.voice_style_map[emotion] > character.voice_id
   *           > series.defaults.tts_voice_id > 全局默认.
   *
   * 业内做法: 抽视频时用快速 TTS 对口型(节省 GPU 冷启动), 导出时用高质量音色统一覆盖。
   * 用户在 ComposeSettingsDrawer 选一个音色 → 整集所有 TTS 强制走该 voice_id.
   */
  episode_voice_override: z.string().max(100).optional(),
  /** 配合 episode_voice_override 使用: 显式指定 TTS provider, 避免被 character voice 的 provider 携带过来 */
  episode_voice_provider_override: z.string().max(100).optional(),
  subtitle_style: z.string().max(50).optional(),
  subtitle_animation: z.enum(["none", "fade_in", "typewriter", "slide_up", "slide_down", "scale_up", "bounce", "glow", "karaoke", "shake"]).optional(),
  /** Preserve the editor's custom appearance through validation to the renderer. */
  custom_style: z.object({
    font_family: z.string().trim().min(1).max(64).regex(/^[^\r\n{},\\]+$/, "字体名称包含无效字符").optional(),
    font_size: z.number().min(8).max(200).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色应为六位十六进制色值").optional(),
    stroke_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色应为六位十六进制色值").optional(),
    stroke_width: z.number().min(0).max(20).optional(),
    bg_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色应为六位十六进制色值").optional(),
    bg_opacity: z.number().min(0).max(1).optional(),
    position: z.enum(["bottom", "top", "center"]).optional(),
  }).strict().optional(),
  bgm_mood: z.string().max(50).optional(),
  /** 2026-05-19 P1: BGM 相对响度 0.0-1.0, 默认 0.35 (跟人声 ducking 后留住氛围) */
  bgm_volume: z.number().min(0).max(1).optional(),
  /** 合成比例必须有效；保留任意正整数比例支持，不擅自改写为默认竖屏。 */
  aspect_ratio: z.string().regex(/^[1-9]\d{0,4}:[1-9]\d{0,4}$/, "画面比例应为正整数宽:高，例如 16:9 或 9:16").optional(),
  /** 2026-05-19: 默认转场 (cut / fade / dissolve / wipe-left/right/up/down / crossfade) */
  transition: z.string().max(40).optional(),
  provider_override: z.string().max(100).optional(),
  /** Wave 4A: "rough" = 粗剪预览(免费/静态帧+ken burns), "full" = 精剪成片(真视频拼接) */
  mode: z.enum(["rough", "full"]).optional().default("full"),
  /** C4: 单镜头无缝重生成 — 仅重合成指定 shot,其余保留 */
  only_shot_ids: z.array(z.string()).optional(),
  /** X4: optional LLM overrides, e.g. { llm_provider_id: "ikuncode_gpt55" } */
  overrides: z.record(z.string(), z.any()).optional(),
  /**
   * W7 Phase 3: 多轨字幕 — 给了任一字段就走 ASS Layer 0/1/2 烧录,不烧 SRT。
   *  - notes:  Layer 1 辅助字幕(注释 / 翻译),时间戳由用户提供
   *  - watermark: Layer 2 角标,整集持续显示
   *
   * Layer 0 主字幕(对白)仍由 compose 自动从对白生成(由 TTS + Whisper 对齐)。
   */
  subtitle_tracks: z.object({
    notes: z.array(z.object({
      start_sec: z.number().min(0),
      end_sec: z.number().min(0),
      text: z.string().min(1).max(200),
      shot_id: z.string().max(200).optional(),
    })).max(500).optional(),
    watermark: z.string().min(1).max(60).optional(),
  }).optional(),
  /**
   * 2026-05-21 V-4 修通多角色 TTS 链路。
   * 用户在 ComposeSettingsDrawer 为每个角色单独选音色,前端按 `{ charId: { default: voiceId } }` 构造。
   * 后端 composeEpisode 在 voice resolver 优先级里放在 character.voice_style_map 之前 (临时态高于配置)。
   *
   * 与 character schema 里 `voice_style_map: Record<emotion, voiceId>` 区别:
   *   - 那个是角色配置 (持久),只有一层 (emotion → voice)
   *   - 这个是合成临时覆盖,两层 (charId → emotion → voice)
   */
  voice_style_map: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  /**
   * 2026-05-21 X-4: TTS 文本逐镜临时覆盖。
   * 用户在 PromptReview 弹窗改 TTS prompt 后,前端把 shot_id → 改后文本 map 发到此字段。
   * compose TTS 循环优先读这里的 override 而非 shot.dialogue。
   *
   * 用法: 抽完视频导出前发现某句对白绕口,直接在 PromptReview 改 + 提交,
   * 不必回 ShotStage 改 dialogue 再重新合成。
   *
   * 特殊键 __all: 若存在则对全集所有 shot 应用同一段话 (简易全局 override)。
   */
  tts_script_override: z.record(z.string(), z.string()).optional(),
  /**
   * 2026-05-22 P0 — 音轨来源 (用户原话: "我说用视频原声不等于不烧录字幕").
   * 与 burn_subtitles 是两个完全独立的维度, 4 种组合都合法:
   *   - "original" = 直接保留每镜真实视频片段自带的音轨 (视频原声), 不调 TTS 替换;
   *     TTS 仍会生成 (用于 Whisper 字幕对齐), 但不 mux 进成片音轨。
   *   - "tts"      = 把每镜 TTS 合成语音按时间轴拼成整集音轨, 替换视频原声。
   * 默认 "tts" 维持旧行为(rough 模式始终走 TTS, 与本字段无关)。
   */
  audio_mode: z.enum(["original", "tts"]).optional().default("tts"),
  /**
   * 2026-05-22 P0 — 字幕是否烧进画面 (独立于 audio_mode)。
   *   - true  = 字幕烧录到视频画面 (维持旧行为)。
   *   - false = 字幕仍写盘成 final.srt sidecar 文件, 但不烧进 final.mp4。
   */
  burn_subtitles: z.boolean().optional().default(true),
});

export const ExportSchema = z.object({
  include_cover: z.boolean().optional().default(true),
  include_metadata: z.boolean().optional().default(true),
  /** C7: 导出目标 — zip=下载压缩包, library=复制到资料库, folder=用户自选目录 */
  target: z.enum(["zip", "library", "folder"]).optional().default("zip"),
  /** C7: target=folder 时用户指定的绝对路径 */
  folder_path: z.string().max(500).optional(),
  /** P170 3E: 多规格导出 — 格式ID数组，如 ["1080p_16x9","1080p_9x16","720p_1x1","gif_10fps"] */
  formats: z.array(z.string()).optional(),
  /**
   * 2026-05-26 整集片头片尾 trim — 在 FinalPreviewPlayer 时间轴拖把手选 [start, end] 区间,
   * 导出时 ffmpeg -ss + -to 切掉两端多余. 单位秒, 跟 final.mp4 时间轴一致 (经多镜 ffprobe 真长累加).
   * 缺省 = 不裁切 (导出完整 final.mp4). 仅"整集级"裁切, 跟 shot.trim_start/end_sec 单镜级 trim 互不影响.
   */
  episode_trim_start_sec: z.number().min(0).max(3600).optional(),
  episode_trim_end_sec: z.number().min(0).max(3600).optional(),
});

export const GenerateCoverSchema = z.object({
  style: z.string().max(100).optional(),
  title_text: z.string().max(200).optional(),
  provider_override: z.string().max(100).optional(),
  /** Reviewed text is the final prompt sent to the image provider. */
  prompt_override: z.string().trim().min(1).max(50000).optional(),
  /** X4: optional LLM overrides, e.g. { llm_provider_id: "ikuncode_gpt55" } */
  overrides: z.record(z.string(), z.any()).optional(),
  /**
   * 2026-05-26 — 用户在弹窗里选定的"参考某镜首帧"shot_id (可选).
   * 后端读 shot.picked_first_frame_generation_id → 拿 asset/vault →
   * 作 i2i reference_image 喂生图模型, 让封面跟剧情视觉锚定.
   * 不传 → 走纯文生路径 (跟历史一致).
   */
  reference_shot_id: z.string().max(200).optional(),
  /** Pin the reviewed reference; a changed pick requires a fresh review. */
  reference_asset_id: z.string().max(200).optional(),
});

export const ExtractEntitiesSchema = z.object({
  /** optional LLM overrides, e.g. { llm_provider_id: "ikuncode_gpt55" } */
  overrides: z.record(z.string(), z.any()).optional(),
});

export const PlanStoryboardSchema = z.object({
  user_note: z.string().max(2000).optional(),
  overrides: z.record(z.string(), z.any()).optional(),
  /** B2 DirectorAgent mode: use multi-step generator-critic loop */
  use_director: z.boolean().optional(),
  /** optional beat sheet to inject (skip step 1) */
  beat_sheet: z.any().optional(),
});

export const InferSettingSchema = z.object({
  setting_key: z.string().min(1).max(100),
  dict_id: z.string().min(1).max(100),
  context: z.object({
    inspiration: z.string().max(5000).optional(),
    current_settings: z.record(z.string(), z.string()).optional(),
  }).optional(),
});

export const TtsTestSchema = z.object({
  voice_id: z.string().min(1).max(100),
  text: z.string().min(1).max(1000),
  provider_id: z.string().max(100).optional(),
});

export const MemoryRecordActionSchema = z.object({
  stage: z.string().min(1).max(100),
  input_text: z.string().min(1).max(50_000),
  output_text: z.string().min(1).max(50_000),
  action: z.enum(["adopt", "redo", "manual_edit", "reject"]),
});

export const GenerateMetadataSchema = z.object({
  /** optional overrides for LLM context */
  overrides: z.record(z.string(), z.any()).optional(),
});

// ─── Template ───────────────────────────────────────────────────

export const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  source_series_slug: z.string().max(100).optional(),
});

export const ApplyTemplateSchema = z.object({
  target_series_slug: z.string().min(1).max(100),
});

// ─── Provider Test ──────────────────────────────────────────────

export const ProviderTestSchema = z.object({
  kind: z.enum(["llm", "image", "video", "tts"]).optional(),
  sample_params: z.record(z.string(), z.any()).optional(),
});

// ─── Settings ───────────────────────────────────────────────────

export const PatchSettingsSchema = z.object({
  max_parallel_tasks: z.number().int().min(1).max(10).optional(),
  max_retake_per_shot: z.number().int().min(1).max(20).optional(),
  max_video_seconds_per_job: z.number().int().min(30).max(3600).optional(),
  max_clip_seconds_per_shot: z.number().int().min(3).max(30).optional(),
  default_template_id: z.string().max(100).optional(),
  provider_keys: z.record(z.string(), z.string()).optional(),
  budget_daily_cap_cny: z.number().min(0).max(10000).optional(),
  budget_single_job_cap_cny: z.number().min(0).max(10000).optional(),
  budget_per_provider_cap_cny: z.number().min(0).max(10000).optional(),
  // Quick settings — user-facing defaults
  DEFAULT_TTS_VOICE: z.string().max(100).optional(),
  DEFAULT_ASPECT_RATIO: z.string().max(20).optional(),
  DEFAULT_LLM_PROVIDER_ID: z.string().max(100).optional(),
  BURN_SUBTITLES_DEFAULT: z.union([z.boolean(), z.string()]).optional(),
  EXPORT_SRT_DEFAULT: z.union([z.boolean(), z.string()]).optional(),
  REAL_VIDEO_ENABLED: z.union([z.boolean(), z.string()]).optional(),
  // 2026-05-20 Wave T 留尾 — 一致性体检评分器切换(铁律 #2 可干预性)
  CONSISTENCY_SCORER_PROVIDER: z.enum(["gemini_flash", "local_clip", "phash"]).optional(),
});

// ─── Provider CRUD (P5E) ─────────────────────────────────────────

export const ProviderKindEnum = z.enum(["llm", "image", "video", "tts"]);
export const ApiTypeEnum = z.enum(["openai_compat", "anthropic", "custom"]);

export const CreateProviderSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/, "id 只能包含小写字母、数字和下划线"),
  label_zh: z.string().min(1).max(100),
  kind: ProviderKindEnum,
  api_type: ApiTypeEnum,
  base_url: z.string().url("base_url 必须是有效的 http(s):// URL"),
  api_key: z.string().min(1, "api_key 为必填"),
  model_id: z.string().max(200).optional().default(""),
  anthropic_version: z.string().max(50).optional().default(""),
  custom_headers: z.record(z.string(), z.string()).optional().default({}),
  timeout_ms: z.number().int().min(1000).max(300_000).optional().default(30_000),
  max_retries: z.number().int().min(0).max(10).optional().default(2),
  cost_per_1k_tokens_in: z.number().min(0).optional().default(0),
  cost_per_1k_tokens_out: z.number().min(0).optional().default(0),
  notes: z.string().max(500).optional().default(""),
  enabled: z.boolean().optional().default(true),
});

export const PatchProviderSchema = z.object({
  label_zh: z.string().min(1).max(100).optional(),
  kind: ProviderKindEnum.optional(),
  api_type: ApiTypeEnum.optional(),
  base_url: z.string().url("base_url 必须是有效的 http(s):// URL").optional(),
  api_key: z.string().min(1).optional(),
  model_id: z.string().max(200).optional(),
  anthropic_version: z.string().max(50).optional(),
  custom_headers: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().min(1000).max(300_000).optional(),
  max_retries: z.number().int().min(0).max(10).optional(),
  cost_per_1k_tokens_in: z.number().min(0).optional(),
  cost_per_1k_tokens_out: z.number().min(0).optional(),
  notes: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
});

// ─── Library Character ───────────────────────────────────────────

export const CreateLibraryCharacterSchema = z.object({
  name: z.string().min(1).max(100),
  appearance: z.string().min(1).max(2000),
  personality: z.string().min(1).max(1000),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
});

export const PatchLibraryCharacterSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  appearance: z.string().max(2000).optional(),
  personality: z.string().max(1000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

// ─── Library Scene ───────────────────────────────────────────────

export const CreateLibrarySceneSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  visual_style: z.string().max(100).optional(),
  location: z.string().max(200).optional(),
  time_of_day: z.string().max(50).optional(),
  mood: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
});

export const PatchLibrarySceneSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  visual_style: z.string().max(100).optional(),
  location: z.string().max(200).optional(),
  time_of_day: z.string().max(50).optional(),
  mood: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

// ─── Library Lock ─────────────────────────────────
// Wave P (2026-05-20): LibraryGenerateRefsSchema 删除 — library generate-refs 已合并到
// /api/v2/generate/image (target.kind="library_variant"), 前端 0 caller.

export const LibraryLockSchema = z.object({
  ref_id: z.string().min(1),
});

// ─── Annotations ─────────────────────────────────────────────────

export const VaultAnnotationSchema = z.object({
  type: z.enum(["pin", "box"]),
  coords: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().optional(),
    h: z.number().optional(),
  }),
  note: z.string().min(1).max(500),
});

// ─── Variants ────────────────────────────────────────────────────

export const CreateVariantSchema = z.object({
  label: z.string().min(1).max(100),
  category: z.enum(["outfit", "emotion", "pose", "other"]),
  source_vault_id: z.string().optional(),
  // 2026-05-20 display_name 体系统一: 新 caller 应传 display_name. user_note 保留向后兼容.
  display_name: z.string().max(500).optional(),
  user_note: z.string().max(500).optional().default(""),
  provider_id: z.string().max(100).optional(),
});

export const AutoPackSchema = z.object({
  provider_id: z.string().min(1).max(100),
});

// ─── Validation helper ──────────────────────────────────────────

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; errors: Array<{ path: string; message: string }> };

export function validate<T>(schema: z.ZodSchema<T>, body: unknown): ValidationResult<T> {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    status: 400,
    errors: result.error.issues.map(i => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}
