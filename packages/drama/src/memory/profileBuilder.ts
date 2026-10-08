/**
 * B4 — Profile Builder
 *
 * Offline summarizer: when a stage accumulates >= 10 events,
 * this module calls the LLM to summarize "user style preferences"
 * and stores the result in the profiles table.
 *
 * Also provides helpers to build profile-enriched system prompts
 * and few-shot examples for the next LLM call to the same stage.
 */

import {
  countEventsByStage,
  getEventsByStage,
  getRecentAcceptedSamples,
  getProfile,
  upsertProfile,
  getTotalEventCount,
  type PrefEvent,
} from "./preferenceStore.js";
import fs from "node:fs";
import path from "node:path";
import { migrateToLatest } from "../../../core/src/migrations.js";

// ─── Threshold ─────────────────────────────────────────────────

/** Minimum events before triggering a profile summary build. */
const PROFILE_BUILD_THRESHOLD = 10;

// ─── Types ─────────────────────────────────────────────────────

export interface ProfileBuilderDeps {
  /** Call an LLM with a prompt and return the text response. */
  callLlm: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export interface ProfileInjection {
  /** Profile text to prepend to the system prompt, or empty string if no profile. */
  profileText: string;
  /** Up to 3 recent accepted samples as few-shot examples. */
  fewShotExamples: string[];
  /** Whether a profile exists for this stage. */
  hasProfile: boolean;
}

// ─── Build Profile ─────────────────────────────────────────────

/**
 * Check if the stage has enough events to trigger a profile build,
 * and if so, call the LLM to summarize the user's preferences.
 *
 * Returns true if a profile was built/updated, false if threshold not met.
 */
export async function maybeBuildProfile(
  stage: string,
  deps: ProfileBuilderDeps,
): Promise<boolean> {
  const count = countEventsByStage(stage);
  if (count < PROFILE_BUILD_THRESHOLD) return false;

  const events = getEventsByStage(stage);

  // Format events for the summarizer prompt
  const eventSummaries = events.map((e: PrefEvent, i: number) => {
    const outputSnippet = e.output_json.length > 200
      ? e.output_json.slice(0, 200) + "..."
      : e.output_json;
    return `[${i + 1}] action=${e.user_action} | output=${outputSnippet}`;
  }).join("\n");

  const systemPrompt = `你是一位用户偏好分析师。根据以下用户的操作历史，总结该用户在该创作阶段的风格偏好。
输出要求:
- 用中文写
- 100-200 字
- 聚焦于: 语言风格、内容偏好、构图/视觉偏好、节奏偏好、拒绝过的模式
- 不要复述事件列表，只提炼偏好
- 直接输出总结文本，不要 JSON 包裹`;

  const userPrompt = `## 阶段: ${stage}
## 事件历史 (${count} 条):
${eventSummaries}`;

  try {
    const summary = await deps.callLlm(systemPrompt, userPrompt);
    const profileKey = `profile:${stage}`;
    upsertProfile(profileKey, JSON.stringify({
      stage,
      summary: summary.trim(),
      event_count: count,
      built_at: new Date().toISOString(),
    }));
    return true;
  } catch (err) {
    console.warn(`[profileBuilder] Failed to build profile for stage "${stage}":`, err instanceof Error ? err.message : err);
    return false;
  }
}

// ─── Inject into Prompt ────────────────────────────────────────

/**
 * Build profile injection data for a given stage.
 * Returns profile text + few-shot examples to inject into the system prompt.
 */
export function buildProfileInjection(stage: string): ProfileInjection {
  const profileKey = `profile:${stage}`;
  const profile = getProfile(profileKey);

  const samples = getRecentAcceptedSamples(stage, 3);

  let profileText = "";
  let hasProfile = false;

  if (profile) {
    try {
      const parsed = JSON.parse(profile.profile_json);
      if (parsed.summary) {
        profileText = [
          "## 用户风格偏好 (来自历史学习)",
          "",
          parsed.summary,
          "",
          `> 以上偏好基于 ${parsed.event_count} 次交互自动学习。`,
          "",
        ].join("\n");
        hasProfile = true;
      }
    } catch {
      // corrupt profile JSON, skip
    }
  }

  const fewShotExamples = samples
    .map((s) => {
      try {
        const snippet = s.output_json.length > 500
          ? s.output_json.slice(0, 500) + "..."
          : s.output_json;
        return snippet;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  return { profileText, fewShotExamples, hasProfile };
}

/**
 * Compose a full system prompt with profile + few-shot injection.
 * Call this instead of using a bare system prompt string.
 */
export function enrichSystemPrompt(
  baseSystemPrompt: string,
  stage: string,
): string {
  const { profileText, fewShotExamples, hasProfile } = buildProfileInjection(stage);

  if (!hasProfile && fewShotExamples.length === 0) {
    return baseSystemPrompt;
  }

  const parts: string[] = [baseSystemPrompt];

  if (profileText) {
    parts.push("", profileText);
  }

  if (fewShotExamples.length > 0) {
    parts.push("", "## 该阶段用户偏好的历史采纳样例 (参考风格，不要照搬内容)");
    for (let i = 0; i < fewShotExamples.length; i++) {
      parts.push("", `### 样例 ${i + 1}`, "```json", fewShotExamples[i], "```");
    }
  }

  return parts.join("\n");
}

/**
 * Check if a stage needs a profile rebuild.
 * Useful for the orchestrator to decide whether to trigger background build.
 */
export function needsProfileBuild(stage: string): boolean {
  return countEventsByStage(stage) >= PROFILE_BUILD_THRESHOLD;
}

// ─── Project Preferences JSON ─────────────────────────────────────

export interface ProjectPreferences {
  version: 1;
  built_at: string;
  total_events: number;
  summary: string;
  /** Key style attributes extracted for quick system-prompt injection */
  tags: string[];
}

/**
 * Save project_preferences.json into the series directory.
 * Called after profile is built (>= 10 events threshold).
 */
export function saveProjectPreferences(seriesDir: string, opts: {
  summary: string;
  totalEvents: number;
  tags?: string[];
}): void {
  const prefs: ProjectPreferences = {
    version: 1,
    built_at: new Date().toISOString(),
    total_events: opts.totalEvents,
    summary: opts.summary,
    tags: opts.tags ?? [],
  };
  const filePath = path.join(seriesDir, "project_preferences.json");
  try {
    fs.writeFileSync(filePath, JSON.stringify(prefs, null, 2), "utf8");
  } catch (err) {
    console.warn(`[profileBuilder] Failed to save project_preferences.json:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Load project_preferences.json from a series directory.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadProjectPreferences(seriesDir: string): ProjectPreferences | null {
  const filePath = path.join(seriesDir, "project_preferences.json");
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // E3: apply global schema version migration
    const migrated = migrateToLatest(parsed);
    if (typeof migrated.summary === "string") {
      return migrated as unknown as ProjectPreferences;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a concise preference prefix for system prompts.
 * Returns a string like "用户偏好:暖色调、特写、2秒节奏" or empty string if no preferences.
 */
export function buildPreferencePrefix(seriesDir: string): string {
  const prefs = loadProjectPreferences(seriesDir);
  if (!prefs || !prefs.summary) return "";

  // Extract short tags from summary or use stored tags
  const tags = prefs.tags.length > 0
    ? prefs.tags
    : extractTagsFromSummary(prefs.summary);

  if (tags.length === 0) {
    return `用户偏好:${prefs.summary.slice(0, 80)}`;
  }
  return `用户偏好:${tags.join("、")}`;
}

/**
 * Quick tag extraction from a summary string.
 * Looks for common style keywords.
 */
function extractTagsFromSummary(summary: string): string[] {
  const keywords = [
    "暖色调", "冷色调", "特写", "远景", "中景", "快节奏", "慢节奏",
    "2秒", "3秒", "5秒", "幽默", "严肃", "温馨", "悬疑", "浪漫",
    "紧凑", "舒缓", "暗色调", "亮色调", "电影感", "纪实感",
  ];
  const found: string[] = [];
  for (const kw of keywords) {
    if (summary.includes(kw)) found.push(kw);
  }
  return found.slice(0, 5); // max 5 tags
}

/**
 * Enhanced version of maybeBuildProfile that also saves project_preferences.json.
 * Call this instead of maybeBuildProfile when seriesDir is available.
 */
export async function maybeBuildProfileAndSave(
  stage: string,
  seriesDir: string,
  deps: ProfileBuilderDeps,
): Promise<boolean> {
  const built = await maybeBuildProfile(stage, deps);
  if (built) {
    const totalEvents = getTotalEventCount();
    const profile = getProfile(`profile:${stage}`);
    if (profile) {
      try {
        const parsed = JSON.parse(profile.profile_json);
        const tags = extractTagsFromSummary(parsed.summary || "");
        saveProjectPreferences(seriesDir, {
          summary: parsed.summary || "",
          totalEvents,
          tags,
        });
      } catch { /* ignore parse errors */ }
    }
  }
  return built;
}
