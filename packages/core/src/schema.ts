import { z } from "zod";

// --- Project Bible Schema ---
export const ProjectBibleSchema = z.object({
  job_id: z.string(),
  topic: z.string().max(500),
  source_type: z.enum(["document", "topic", "script"]),
  audience: z.string().max(300),
  platform: z.string().max(100),
  aspect_ratio: z.string().max(20),
  resolution: z.string().max(20),
  duration_target_sec: z.number().min(10).max(600),
  scene_duration_range_sec: z.tuple([z.number(), z.number()]),
  style: z.string().max(100),
  tone: z.string().max(300),
  visual_rules: z.array(z.string().max(200)).max(10),
  narration_rules: z.array(z.string().max(200)).max(10),
  subtitle_rules: z.array(z.string().max(200)).max(10),
  forbidden: z.array(z.string().max(200)).max(10),
  quality_goals: z.array(z.string().max(200)).max(10),
  provider_preferences: z.object({
    llm: z.string(),
    tts: z.string(),
    image: z.string(),
    video: z.string()
  }),
  created_at: z.string(),
  updated_at: z.string()
});

// --- Script Expansion Schema ---
export const ScriptExpansionSchema = z.object({
  title: z.string().max(200),
  hook: z.string().max(500),
  outline: z.array(z.object({
    section_title: z.string().max(100),
    key_points: z.array(z.string().max(200)).max(8)
  })).max(20),
  full_script: z.string().max(20000),
  estimated_duration_sec: z.number().min(10).max(600),
  style_notes: z.array(z.string().max(200)).max(10),
  source_assumptions: z.array(z.string().max(200)).max(10)
});

// --- Scene Prompt Rewrite Schema ---
export const ScenePromptRewriteSchema = z.object({
  scene_id: z.number(),
  changes_summary: z.string().max(500),
  screen_text: z.array(z.string().max(120)).max(4),
  visual_prompt: z.string().max(2000),
  local_card_prompt: z.string().max(2000),
  future_image_prompt: z.string().max(2000),
  future_video_prompt: z.string().max(2000),
  motion_suggestion: z.string().max(500),
  layout_suggestion: z.string().max(500),
  negative_prompt: z.string().max(500),
  narration_text: z.string().max(2000),
  error: z.string().optional()
});

// --- Provider Prompt Adapter Schema ---
export const ProviderPromptAdapterSchema = z.object({
  scene_stable_id: z.string(),
  provider: z.string(),
  modality: z.enum(["image", "video"]),
  provider_prompt: z.string().min(1).max(5000),
  negative_prompt: z.string().max(1000).optional().default(""),
  duration_sec: z.number().min(1).max(60).optional().default(6),
  aspect_ratio: z.string().max(20).optional().default("16:9"),
  resolution: z.string().max(20).optional().default("1920x1080"),
  camera_motion: z.string().max(500).optional().default(""),
  style_tags: z.array(z.string().max(100)).max(10).optional().default([]),
  safety_notes: z.array(z.string().max(200)).max(5).optional().default([])
});

// --- Clip Generation Request Schema ---
export const ClipGenerationRequestSchema = z.object({
  provider: z.string().max(100).optional(),
  duration_sec: z.number().min(1).max(120).optional(),
  use_active_asset: z.boolean().optional(),
  auto_activate: z.boolean().optional()
});

// --- Project Brief Schema ---
export const ProjectBriefSchema = z.object({
  topic: z.string().max(500),
  audience: z.string().max(300),
  platform: z.string().max(100),
  style: z.string().max(100),
  duration_target_sec: z.number().min(10).max(600),
  angle: z.string().max(500),
  core_message: z.string().max(500),
  content_boundaries: z.array(z.string().max(200)).max(10),
  risk_notes: z.array(z.string().max(200)).max(10),
  recommended_workflow: z.array(z.string().max(200)).max(10),
  visual_strategy: z.string().max(100).optional().default("自动"),
  generation_mode: z.enum(["auto", "review", "director"]).optional().default("auto"),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9")
});

// --- Script Understanding Schema ---
export const ScriptUnderstandingSchema = z.object({
  summary: z.string().max(2000),
  audience: z.string().max(300),
  tone: z.string().max(200),
  content_type: z.string().max(100).optional(),
  recommended_style: z.string().max(100).optional(),
  structure: z.array(z.object({
    title: z.string().max(200),
    purpose: z.string().max(500),
    key_points: z.array(z.string().max(300)).max(10)
  })).max(30),
  visual_direction: z.string().max(1000),
  potential_difficulties: z.array(z.string().max(300)).max(10).optional()
});

// --- Scene Planner Schema ---
export const ScenePlannerSchema = z.object({
  scenes: z.array(z.object({
    scene_id: z.number(),
    scene_title: z.string().max(200),
    narration_text: z.string().max(3000),
    visual_goal: z.string().max(500),
    visual_type: z.enum(["title_card", "keyword_card", "diagram", "concept_image", "ai_video_placeholder", "stock_placeholder"]),
    duration_estimate_sec: z.number().min(1).max(120),
    screen_text: z.array(z.string().max(120)).max(4),
    keywords: z.array(z.string().max(50)).max(10),
    chapter: z.string().max(100).optional()
  })).min(1).max(50),
  total_duration_sec: z.number().min(5).max(600),
  scene_count: z.number().min(1).max(50)
});

// --- Visual Director Schema ---
export const VisualDirectorSchema = z.object({
  scenes: z.array(z.object({
    scene_id: z.number(),
    visual_prompt: z.string().max(2000),
    local_card_prompt: z.string().max(2000),
    future_image_prompt: z.string().max(2000).optional(),
    future_video_prompt: z.string().max(2000).optional(),
    negative_prompt: z.string().max(500).optional(),
    motion_suggestion: z.string().max(500).optional(),
    layout_suggestion: z.string().max(500).optional(),
    visual_consistency_tags: z.array(z.string().max(100)).max(5).optional()
  })).min(1).max(50)
});

// --- Metadata Schema ---
export const MetadataSchema = z.object({
  bilibili_title: z.string().max(200),
  bilibili_description: z.string().max(2000),
  bilibili_tags: z.array(z.string().max(50)).max(15),
  cover_text: z.string().max(200),
  comment_prompt: z.string().max(500),
  episode_suggestions: z.array(z.string().max(200)).max(5).optional()
});

// --- Revision Plan Schema ---
export const RevisionPlanSchema = z.object({
  summary: z.string().max(1000),
  affected_scenes: z.array(z.number()).max(50),
  modification_type: z.enum(["manifest_only", "visual_only", "subtitle_only", "rerender_required", "full_replan"]),
  rerender_required: z.boolean(),
  full_replan_required: z.boolean().optional(),
  scene_updates: z.array(z.object({
    scene_id: z.number(),
    fields_to_update: z.array(z.string().max(50)).max(10),
    instructions: z.string().max(1000),
    replacement: z.record(z.string(), z.any()).optional()
  })).max(50).optional(),
  risks: z.array(z.string().max(300)).max(10).optional()
});

// --- QA Review Schema ---
export const QaReviewSchema = z.object({
  status: z.enum(["pass", "warning", "fail"]),
  summary: z.string().max(2000),
  checks: z.array(z.object({
    name: z.string().max(100),
    status: z.enum(["pass", "warning", "fail"]),
    detail: z.string().max(500)
  })).max(30),
  engineering_qa: z.object({
    status: z.enum(["pass", "warning", "fail"]),
    checks: z.array(z.object({
      name: z.string().max(100),
      status: z.enum(["pass", "warning", "fail"]),
      detail: z.string().max(500)
    })).max(20)
  }).optional(),
  content_qa: z.object({
    status: z.enum(["pass", "warning", "fail"]),
    issues: z.array(z.string().max(300)).max(10),
    recommendations: z.array(z.string().max(300)).max(10)
  }).optional(),
  publish_qa: z.object({
    status: z.enum(["pass", "warning", "fail"]),
    platform: z.string().max(50),
    title_quality: z.string().max(200),
    cover_quality: z.string().max(200),
    publish_notes: z.array(z.string().max(300)).max(10)
  }).optional()
});

// --- Generic JSON extraction and validation ---

export function extractFirstBalancedJson(text: string): string | null {
  // 1. Try markdown code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{") || inner.startsWith("[")) return inner;
  }

  // 2. Find the first { or [ and extract balanced JSON
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;

    const openBracket = ch;
    const closeBracket = ch === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\" && inString) {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === openBracket) depth++;
      if (c === closeBracket) {
        depth--;
        if (depth === 0) {
          return text.slice(i, j + 1);
        }
      }
    }
  }

  return null;
}

export function extractJsonFromText(text: string): string {
  // Try balanced extraction first
  const balanced = extractFirstBalancedJson(text);
  if (balanced) return balanced;

  // Fallback: Remove markdown code fences and regex match
  let cleaned = text.replace(/```(?:json)?\s*\n?/gi, "").replace(/```\s*$/gim, "").trim();
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  return match ? match[1] : cleaned;
}

export type ValidationResult<T> =
  | { success: true; data: T; repaired: boolean; warnings: string[] }
  | { success: false; errors: string[]; raw: string; repaired: boolean; warnings: string[] };

export function parseAndValidate<T>(text: string, schema: z.ZodSchema<T>): ValidationResult<T> {
  const jsonStr = extractJsonFromText(text);
  const warnings: string[] = [];

  // Try direct parse first
  try {
    const parsed = JSON.parse(jsonStr);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data, repaired: false, warnings };
    }
    return {
      success: false,
      errors: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
      raw: jsonStr,
      repaired: false,
      warnings
    };
  } catch (e) {
    // Try JSON repair
    try {
      const repaired = tryJsonRepair(jsonStr);
      const parsed = JSON.parse(repaired);
      const result = schema.safeParse(parsed);
      if (result.success) {
        warnings.push("JSON was auto-repaired (trailing commas, missing braces, or unquoted keys)");
        return { success: true, data: result.data, repaired: true, warnings };
      }
      return {
        success: false,
        errors: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
        raw: jsonStr,
        repaired: true,
        warnings
      };
    } catch {
      return {
        success: false,
        errors: [`JSON parse failed: ${e instanceof Error ? e.message : String(e)}`],
        raw: jsonStr,
        repaired: false,
        warnings
      };
    }
  }
}

function tryJsonRepair(text: string): string {
  let repaired = text;
  // Fix trailing commas (safe: only before ] or })
  repaired = repaired.replace(/,\s*([\]}])/g, "$1");
  // Fix missing closing braces/brackets
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;
  for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += "]";
  for (let i = 0; i < openBraces - closeBraces; i++) repaired += "}";
  // NOTE: Unquoted key repair removed — it risks corrupting string values.
  // LLM retry should fix malformed JSON instead of local heuristic.
  return repaired;
}

export function fillDefaults<T extends Record<string, any>>(data: Partial<T>, defaults: T): T {
  return { ...defaults, ...data };
}

// --- Validation helper functions ---

export function validatePreserveNarration(
  originalNarration: string,
  resultNarration: string,
  preserveNarration: boolean
): string[] {
  const warnings: string[] = [];
  if (preserveNarration && originalNarration !== resultNarration) {
    warnings.push(`preserve_narration=true 但 narration_text 已被修改 (${originalNarration.length}→${resultNarration.length} chars)`);
  }
  return warnings;
}

export function validateProviderPromptAdapter(data: {
  provider_prompt?: string;
  duration_sec?: number;
  aspect_ratio?: string;
}, expectedDurationSec?: number): string[] {
  const warnings: string[] = [];
  if (!data.provider_prompt || data.provider_prompt.trim().length === 0) {
    warnings.push("provider_prompt 不能为空");
  }
  if (data.duration_sec && expectedDurationSec) {
    const delta = Math.abs(data.duration_sec - expectedDurationSec);
    if (delta > expectedDurationSec * 0.3) {
      warnings.push(`duration_sec (${data.duration_sec}) 与场景时长 (${expectedDurationSec}) 误差超过 30%`);
    }
  }
  const validAspectRatios = ["16:9", "9:16", "1:1", "custom"];
  if (data.aspect_ratio && !validAspectRatios.includes(data.aspect_ratio)) {
    warnings.push(`aspect_ratio "${data.aspect_ratio}" 不是有效值 (应为 ${validAspectRatios.join("/")})`);
  }
  return warnings;
}

export function validateScriptExpansion(data: {
  full_script?: string;
  estimated_duration_sec?: number;
}, targetDurationSec?: number): string[] {
  const warnings: string[] = [];
  if (data.full_script && data.full_script.length < 100) {
    warnings.push(`full_script 太短 (${data.full_script.length} chars)，可能内容不足`);
  }
  if (data.estimated_duration_sec && targetDurationSec) {
    const ratio = data.estimated_duration_sec / targetDurationSec;
    if (ratio < 0.7 || ratio > 1.3) {
      warnings.push(`estimated_duration_sec (${data.estimated_duration_sec}s) 与目标时长 (${targetDurationSec}s) 误差超过 30%`);
    }
  }
  return warnings;
}
