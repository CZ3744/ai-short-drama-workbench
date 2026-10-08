/**
 * Shared LLM-failure fallback constructors (Step 3a batch 0-B).
 *
 * Extracted verbatim from orchestrationController.ts — zero behavior change.
 * Signatures, JSDoc and inline comments are preserved exactly. All symbols
 * are exported (some were module-private in the original file).
 *
 * The zod response schemas (EntityExtractionSchema / BeatSheetResultSchema /
 * ShotPlanSchema / CriticVerdictResultSchema / SeriesEpisodePlanSchema) stay
 * in orchestrationController.ts and are imported here as types only.
 */

import { z } from "zod";
import {
  compactText,
  labelSnippet,
  splitScriptSegments,
  extractSpeakerNames,
  extractEpisodeSections,
} from "./scriptText";
import type {
  EntityExtractionSchema,
  BeatSheetResultSchema,
  ShotPlanSchema,
  CriticVerdictResultSchema,
  SeriesEpisodePlanSchema,
} from "./schemas";

// B2: Critic 通过阈值
export const CRITIC_PASS_THRESHOLD = 0.7;

type SeriesEpisodePlan = z.infer<typeof SeriesEpisodePlanSchema>["episodes"][number];

export function buildFallbackEntityExtraction(scriptText: string): z.infer<typeof EntityExtractionSchema> {
  const segments = splitScriptSegments(scriptText, 6);
  const speakers = extractSpeakerNames(scriptText);
  const characters = (speakers.length > 0 ? speakers : ["主角"]).map((name, index) => ({
    character_id: `fallback_${index + 1}`,
    name,
    role_type: index === 0 ? "protagonist" : "supporting",
    description: `${name}，由本地启发式从剧本中识别，用于不中断分镜和抽卡流程。`,
    personality_traits: index === 0 ? ["目标明确", "行动驱动"] : ["辅助叙事"],
    appearance_hint: "保持前后统一的清晰人物设定，适合后续首帧抽卡。",
    first_appearance_scene: 1,
    dialogue_count: speakers.length > 0 ? 1 : 0,
    importance: index === 0 ? "high" : "medium",
  }));

  const scenes = segments.map((segment, index) => ({
    scene_id: index + 1,
    scene_name: `场景${index + 1}：${labelSnippet(segment, "剧情段落", 14)}`,
    location: "待定空间",
    time_of_day: "any",
    weather: "none",
    atmosphere: index === 0 ? "开场吸引" : index === segments.length - 1 ? "收束明确" : "推进信息",
    characters_present: characters.slice(0, Math.min(characters.length, 3)).map((ch) => ch.name),
    key_props: [],
    visual_notes: segment.slice(0, 140),
  }));

  return {
    characters,
    scenes,
    relationships: characters.length > 1 ? [{
      from: characters[0].name,
      to: characters[1].name,
      relation: "同一故事线中的关键互动关系",
    }] : [],
    statistics: {
      total_characters: characters.length,
      total_scenes: scenes.length,
      protagonist_count: 1,
      scene_complexity: "local_fallback",
    },
  };
}

export function buildFallbackBeatSheet(scriptText: string, targetDurationSec: number): z.infer<typeof BeatSheetResultSchema> {
  const segments = splitScriptSegments(scriptText, 6);
  const base = Math.max(3, Math.round(targetDurationSec / 6));
  const pick = (index: number, fallback: string) => labelSnippet(segments[index] ?? segments[0] ?? fallback, fallback, 24);
  return {
    hook_3s: { beat_name: "开场钩子", description: pick(0, "先抛出最能吸引用户的问题"), target_duration_sec: Math.min(3, base), key_elements: [] },
    setup: { beat_name: "背景铺垫", description: pick(1, "交代人物、场景或知识背景"), target_duration_sec: base, key_elements: [] },
    inciting_incident: { beat_name: "推进事件", description: pick(2, "让故事或观点进入主要矛盾"), target_duration_sec: base, key_elements: [] },
    midpoint_twist: { beat_name: "中段转折", description: pick(3, "加入反差、证据或新发现"), target_duration_sec: base, key_elements: [] },
    climax: { beat_name: "高潮确认", description: pick(4, "集中呈现最关键的行动或结论"), target_duration_sec: base, key_elements: [] },
    payoff: { beat_name: "结尾回收", description: pick(5, "给出结论、余味或行动引导"), target_duration_sec: base, key_elements: [] },
  };
}

export function buildFallbackShotPlan(input: {
  scriptText: string;
  targetDurationSec: number;
  targetShotCount?: number;
  characters: Array<{ id: string; name?: string }>;
  scenes: Array<{ id: string; name?: string }>;
}): z.infer<typeof ShotPlanSchema> {
  const shotCount = Math.max(3, Math.min(input.targetShotCount ?? 8, 12));
  const segments = splitScriptSegments(input.scriptText, shotCount);
  const duration = Math.max(4, Math.round(input.targetDurationSec / Math.max(segments.length, 1)));
  // 无实体时的占位 id 也作 toC 兜底 (铁律#9): 用友好名而非 char_fallback_1 这种技术下划线代号,
  // 万一分镜板/单镜页直接显示未解析 id 也读得通.
  const defaultCharId = input.characters[0]?.id ?? "角色 1";
  const defaultSceneId = input.scenes[0]?.id ?? "场景 1";

  return segments.map((segment, index) => ({
    shot_id: index + 1,
    shot_type: index === 0 ? "hook_close_up" : index === segments.length - 1 ? "ending_wide" : "medium",
    scene_id: input.scenes[index % Math.max(input.scenes.length, 1)]?.id ?? defaultSceneId,
    characters: [input.characters[index % Math.max(input.characters.length, 1)]?.id ?? defaultCharId],
    action: segment.slice(0, 180),
    dialogue: "",
    voiceover: segment.slice(0, 220),
    camera_movement: index % 3 === 0 ? "slow_push_in" : index % 3 === 1 ? "static" : "gentle_pan",
    camera_angle: index === 0 ? "eye_level_close" : "eye_level",
    duration_sec: duration,
    transition: "cut",
    visual_focus: labelSnippet(segment, "核心画面", 26),
    mood: index === 0 ? "hook" : index === segments.length - 1 ? "resolution" : "development",
    notes: "local_fallback_storyboard",
    prompt_img: "",
    prompt_vid: "",
  }));
}

export function buildFallbackCriticVerdict(shots: z.infer<typeof ShotPlanSchema>, targetDurationSec: number): z.infer<typeof CriticVerdictResultSchema> {
  const total = shots.reduce((sum, shot) => sum + Number(shot.duration_sec || 0), 0);
  return {
    coverage_score: 0.74,
    drift_flags: [],
    missing_beats: [],
    overall_comment: "LLM 不可用时由本地启发式生成，可继续抽首帧、生成视频并由用户二次精修。",
    duration_analysis: {
      total_sec: total,
      target_sec: targetDurationSec,
      verdict: total > targetDurationSec * 1.25 ? "over" : total < targetDurationSec * 0.75 ? "under" : "ok",
    },
  };
}

export function buildFallbackEpisodePlans(
  series: { title: string; defaults?: Record<string, any> },
  scriptText: string,
  requestedCount?: number,
): SeriesEpisodePlan[] {
  const fromHeadings = extractEpisodeSections(scriptText);
  if (fromHeadings.length > 0) return fromHeadings;

  const cleaned = compactText(scriptText, "");
  const countFromLength = Math.max(1, Math.min(8, Math.ceil(cleaned.length / 1400)));
  const targetCount = Math.max(1, Math.min(requestedCount ?? countFromLength, 12));
  const segments = splitScriptSegments(scriptText, targetCount);
  const fallbackDuration = Number(series.defaults?.episode_duration_sec ?? series.defaults?.target_duration_sec ?? 60);
  const targetDuration = Number.isFinite(fallbackDuration) ? Math.max(30, Math.min(fallbackDuration, 1800)) : 60;

  return segments.map((segment, index) => {
    const title = `第 ${index + 1} 集`;
    const synopsis = labelSnippet(segment, `${series.title}第${index + 1}集`, 80);
    return {
      title,
      synopsis,
      script_md: `# ${title}\n\n${segment}`,
      target_duration_sec: targetDuration,
      target_shot_count: Math.max(6, Math.min(12, Math.round(targetDuration / 8))),
    };
  });
}
