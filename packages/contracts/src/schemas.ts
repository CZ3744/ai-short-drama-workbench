/**
 * orchestration/_shared/schemas.ts
 *
 * Step 3a: 从 orchestrationController.ts 抽出的 Zod schema 集中地。
 * 覆盖两类:
 *  - LLM 响应 schema (ScriptExpandResult / SeriesEpisodePlan / EntityExtraction /
 *    ShotPlan / BeatSheet / CriticVerdict)
 *  - 请求体 schema (Feedback / ScriptEdit / CopyPreferences)
 *
 * 后续 Step 6 会把这些 schema 进一步下沉到 packages/contracts 做前后端共享。
 */

import { z } from "zod";

// ─── LLM 响应 schema ──────────────────────────────────────────────

export const ScriptExpandResultSchema = z.object({
  title: z.string(),
  hook: z.string(),
  outline: z.array(z.object({
    section_title: z.string(),
    key_points: z.array(z.string()),
  })),
  full_script: z.string(),
  estimated_duration_sec: z.number(),
  style_notes: z.string(),
  source_assumptions: z.string(),
});

export const SeriesEpisodePlanSchema = z.object({
  episodes: z.array(z.object({
    title: z.string().min(1).max(120),
    synopsis: z.string().max(1200).optional().default(""),
    script_md: z.string().min(1).max(80_000),
    target_duration_sec: z.number().int().min(15).max(1800).optional().default(60),
    target_shot_count: z.number().int().min(3).max(30).optional().default(8),
  })).min(1).max(24),
});

export const EntityExtractionSchema = z.object({
  characters: z.array(z.object({
    character_id: z.string(),
    name: z.string(),
    role_type: z.string(),
    description: z.string(),
    personality_traits: z.array(z.string()),
    appearance_hint: z.string().optional(),
    first_appearance_scene: z.union([z.number(), z.string()]),
    dialogue_count: z.union([z.number(), z.string()]),
    importance: z.string(),
  })),
  scenes: z.array(z.object({
    scene_id: z.union([z.number(), z.string()]),
    scene_name: z.string(),
    location: z.string(),
    time_of_day: z.string(),
    weather: z.string(),
    atmosphere: z.string(),
    characters_present: z.array(z.string()),
    key_props: z.array(z.string()),
    visual_notes: z.string(),
  })),
  relationships: z.array(z.object({
    from: z.string(),
    to: z.string(),
    relation: z.string(),
  })).optional(),
  statistics: z.object({
    total_characters: z.union([z.number(), z.string()]),
    total_scenes: z.union([z.number(), z.string()]),
    protagonist_count: z.union([z.number(), z.string()]).optional(),
    scene_complexity: z.string().optional(),
  }).optional(),
});

export const ShotPlanSchema = z.array(z.object({
  shot_id: z.union([z.number(), z.string()]),
  shot_type: z.string(),
  scene_id: z.union([z.number(), z.string()]),
  characters: z.array(z.string()),
  action: z.string(),
  dialogue: z.string().optional().default(""),
  voiceover: z.string().optional().default(""),
  camera_movement: z.string(),
  camera_angle: z.string().optional().default("eye_level"),
  duration_sec: z.union([z.number(), z.string()]),
  transition: z.string().optional().default("cut"),
  visual_focus: z.string().optional().default(""),
  mood: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  prompt_img: z.string().optional().default(""),
  prompt_vid: z.string().optional().default(""),
  // 2026-05-19 优化 2: LLM 输出的素材引用 (用 name 而不是 id), 落盘时解析为 element_ids.
  // 让 storyboard 拆分时能精确指明用了哪个 prop/wardrobe/reference/misc,
  // 后续 implicitReferenceCollector 走 element_ids 拿 typical 图保持视觉一致.
  //
  // 注意:这里用纯 .optional() (不带 default), 让 z.infer 出来的字段在 output 类型里
  // 也是 optional, 避免现有 fallback 构造路径 (buildFallbackShotPlan 等) 报缺字段.
  element_refs: z.array(z.string()).optional(),
  // 2026-05-19 Wave O Entity-first: LLM 反向抽取的实体名(可能含未在素材列表的新名).
  // 后端 plan-storyboard 路由在 LLM 返回 shots 写盘之后, 把这些 name dedupe 后:
  //   - 已存在的 character/scene/element → skip
  //   - 不存在的 → 自动 createCharacter/createScene/createElement, status="placeholder" 概念
  // 老 LLM 不输出本字段时, z.infer 出来仍然是 undefined, 后端按空数组兜底处理.
  auto_extracted_entities: z
    .object({
      characters: z.array(z.string()).optional().default([]),
      scenes: z.array(z.string()).optional().default([]),
      elements: z.array(z.string()).optional().default([]),
    })
    .optional(),
  // 2026-05-20 Wave T Phase 2 — LLM 显式指定本镜用某 element 的某张图作 reference (而非默认主图).
  // LLM 在 character_list / propsContext 里能看到每个 element 的"已有图: id=display_name(angle)"列表,
  // 当某镜动作需要特定姿势/表情时 (e.g. 抢夺动作 / 哭泣特写) 可在此显式指定.
  // 后端落盘到 shot.reference_overrides → orchestrator 生图时只发指定那一张作 reference.
  // 也兼容 LLM 在 action / prompt_img 里用 `@角色:名.img:image_id` 长格式 — 解析时合并。
  image_overrides: z
    .array(z.object({
      element_id: z.string(),
      image_id: z.string(),
      reason: z.string().optional(),
    }))
    .optional(),
}));

// B2: BeatSheet LLM 响应 schema
export const BeatSchema = z.object({
  beat_name: z.string(),
  description: z.string(),
  target_duration_sec: z.union([z.number(), z.string()]),
  key_elements: z.array(z.string()).optional().default([]),
});

export const BeatSheetResultSchema = z.object({
  hook_3s: BeatSchema,
  setup: BeatSchema,
  inciting_incident: BeatSchema,
  midpoint_twist: BeatSchema,
  climax: BeatSchema,
  payoff: BeatSchema,
});

// B2: CriticVerdict LLM 响应 schema
export const CriticVerdictResultSchema = z.object({
  coverage_score: z.number().min(0).max(1),
  drift_flags: z.array(z.object({
    shot_id: z.string(),
    reason: z.string(),
    suggestion: z.string(),
  })).optional().default([]),
  missing_beats: z.array(z.object({
    beat_name: z.string(),
    reason: z.string(),
    suggestion: z.string(),
  })).optional().default([]),
  overall_comment: z.string().optional().default(""),
  duration_analysis: z.object({
    total_sec: z.number(),
    target_sec: z.number(),
    verdict: z.enum(["ok", "over", "under"]),
  }).optional(),
});

// ─── 请求体 schema ────────────────────────────────────────────────

// B5: Feedback & Preferences endpoints
export const FeedbackSchema = z.object({
  shot_id: z.string(),
  stage: z.string().optional(),
  feedback: z.enum(["more", "less", "ok"]),
});

// B5: script-edit 偏好档案闭环
export const ScriptEditSchema = z.object({
  old_content: z.string(),
  new_content: z.string(),
  episode_id: z.string().optional(),
});

// B5: copy-preferences 偏好复用
export const CopyPreferencesSchema = z.object({
  source_slug: z.string(),
});
