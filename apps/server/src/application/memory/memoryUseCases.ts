import path from "node:path";
import fs from "node:fs/promises";

import { validate, MemoryRecordActionSchema } from "../../api/v2/validators";
import { FeedbackSchema, ScriptEditSchema, CopyPreferencesSchema } from "../../api/v2/orchestration/_shared/schemas";
import { getRegistry, resolveLlmProviderId } from "../../api/v2/orchestration/_shared/registry";

import { readJson, DATA_ROOT } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { getKeyFor, getConfigValue } from "../../../../../packages/core/src/localSettings";
import { tryWithFallback, resolveChain } from "../../../../../packages/providers/src/core/queue";
import type { ProviderContext } from "../../../../../packages/providers/src/core/types";
import {
  recordEvent,
  hashInput,
  clearAllLearningData,
  getProfile,
  countEventsByStage,
  recordFeedbackEvent,
  getTotalEventCount,
} from "../../../../../packages/drama/src/memory/preferenceStore";
import {
  maybeBuildProfile,
  needsProfileBuild,
  maybeBuildProfileAndSave,
  loadProjectPreferences,
} from "../../../../../packages/drama/src/memory/profileBuilder";

export type MemoryUseCaseResult =
  | { kind: "validationBare"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "json"; body: Record<string, unknown> };

function validationError(errors: Array<{ path: string; message: string }>): MemoryUseCaseResult {
  return {
    kind: "error",
    status: 400,
    body: { error: { code: "ValidationError", message: "请求体校验失败", details: errors } },
  };
}

function resolveLlmChain() {
  const providerId = resolveLlmProviderId({});
  return resolveChain(
    providerId,
    getRegistry().listAvailable("llm").map(p => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );
}

export async function recordMemoryAction(body: unknown): Promise<MemoryUseCaseResult> {
  const validated = validate(MemoryRecordActionSchema, body);
  if (!validated.ok) {
    return { kind: "validationBare", status: validated.status, errors: validated.errors };
  }
  const { stage, input_text, output_text, action } = validated.data;

  const event = recordEvent({
    stage,
    input_hash: hashInput(input_text),
    output_json: output_text,
    user_action: action,
  });

  if (needsProfileBuild(stage)) {
    const chain = resolveLlmChain();
    // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 不设 AbortSignal.timeout.
    const providerCtx: ProviderContext = {
      series_slug: "",
      job_id: `profile_${Date.now().toString(36)}`,
      task_id: `task_${Date.now().toString(36)}`,
      log: () => {},
    };
    maybeBuildProfile(stage, {
      callLlm: async (sys, usr) => {
        const r = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
          prompt: usr, system: sys, response_format: "text", max_tokens: 1024,
        }, providerCtx);
        return r.text;
      },
    }).catch((e) => loggerSync().warn("[preference] profile build failed:", e));
  }

  return { kind: "json", body: { ok: true, event_id: event.id, stage, action } };
}

export async function getMemoryProfile(stage: string): Promise<MemoryUseCaseResult> {
  const profileKey = `profile:${stage}`;
  const profile = getProfile(profileKey);
  const eventCount = countEventsByStage(stage);

  return {
    kind: "json",
    body: {
      stage,
      has_profile: !!profile,
      event_count: eventCount,
      profile: profile ? JSON.parse(profile.profile_json) : null,
      updated_at: profile?.updated_at ?? null,
    },
  };
}

export async function clearMemory(): Promise<MemoryUseCaseResult> {
  clearAllLearningData();
  return { kind: "json", body: { ok: true, message: "已清除全部学习数据" } };
}

export async function recordSeriesFeedback(slug: string, body: unknown): Promise<MemoryUseCaseResult> {
  const v = validate(FeedbackSchema, body);
  if (!v.ok) return validationError(v.errors);

  const event = recordFeedbackEvent({
    stage: v.data.stage || "shot_generation",
    shot_id: v.data.shot_id,
    feedback: v.data.feedback,
  });

  const totalEvents = getTotalEventCount();
  const seriesDir = path.join(DATA_ROOT, "series", slug);
  if (totalEvents >= 10) {
    const chain = resolveLlmChain();
    // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 不设 AbortSignal.timeout.
    const providerCtx: ProviderContext = {
      series_slug: slug,
      job_id: `feedback_${Date.now().toString(36)}`,
      task_id: `task_${Date.now().toString(36)}`,
      log: () => {},
    };
    maybeBuildProfileAndSave("shot_generation", seriesDir, {
      callLlm: async (sys: string, usr: string) => {
        try {
          const r = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
            prompt: usr, system: sys, response_format: "text", max_tokens: 1024,
          }, providerCtx);
          return r.text;
        } catch {
          return "";
        }
      },
    }).catch((e) => loggerSync().warn("[preference] background profile build failed:", e));
  }

  return { kind: "json", body: { ok: true, event_id: event.id, total_events: totalEvents } };
}

export async function getSeriesPreferences(slug: string): Promise<MemoryUseCaseResult> {
  const seriesDir = path.join(DATA_ROOT, "series", slug);
  const prefs = loadProjectPreferences(seriesDir);
  if (!prefs) return { kind: "json", body: { ok: true, has_preferences: false } };
  return { kind: "json", body: { ok: true, has_preferences: true, preferences: prefs } };
}

export async function listPreferenceProjects(): Promise<MemoryUseCaseResult> {
  const seriesRoot = path.join(DATA_ROOT, "series");
  const entries = await fs.readdir(seriesRoot, { withFileTypes: true }).catch(() => []);
  const results: Array<{ slug: string; title: string; summary: string; tags: string[] }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const seriesDir = path.join(seriesRoot, entry.name);
    const prefs = loadProjectPreferences(seriesDir);
    if (prefs) {
      let title = entry.name;
      try {
        const seriesData = await readJson<{ title?: string }>(path.join(seriesDir, "series.json"));
        if (seriesData?.title) title = seriesData.title;
      } catch { /* use slug as fallback */ }
      results.push({
        slug: entry.name,
        title,
        summary: prefs.summary,
        tags: prefs.tags,
      });
    }
  }

  return { kind: "json", body: { ok: true, projects: results } };
}

export async function recordScriptEdit(slug: string, body: unknown): Promise<MemoryUseCaseResult> {
  const v = validate(ScriptEditSchema, body);
  if (!v.ok) return validationError(v.errors);

  const { old_content, new_content } = v.data;
  const oldLines = old_content.split("\n");
  const newLines = new_content.split("\n");
  const added = newLines.filter(l => !oldLines.includes(l)).length;
  const removed = oldLines.filter(l => !newLines.includes(l)).length;
  const diffSummary = `+${added}/-${removed} lines`;

  const changedSections: string[] = [];
  const sectionPattern = /^#+\s+(.+)/;
  for (const line of newLines) {
    const match = line.match(sectionPattern);
    if (match && match[1]) changedSections.push(match[1].trim());
  }
  const fullDiffSummary = changedSections.length > 0
    ? `${diffSummary} (${changedSections.slice(0, 3).join(", ")})`
    : diffSummary;

  const event = recordEvent({
    stage: "script_edit",
    input_hash: hashInput(old_content),
    output_json: JSON.stringify({ new_content_preview: new_content.slice(0, 200) }),
    user_action: "manual_edit",
    diff_summary: fullDiffSummary,
  });

  const seriesDir = path.join(DATA_ROOT, "series", slug);
  if (needsProfileBuild("script_edit")) {
    const chain = resolveLlmChain();
    // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 不设 AbortSignal.timeout.
    const providerCtx: ProviderContext = {
      series_slug: slug,
      job_id: `script_edit_${Date.now().toString(36)}`,
      task_id: `task_${Date.now().toString(36)}`,
      log: () => {},
    };
    maybeBuildProfileAndSave("script_edit", seriesDir, {
      callLlm: async (sys: string, usr: string) => {
        try {
          const r = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
            prompt: usr, system: sys, response_format: "text", max_tokens: 1024,
          }, providerCtx);
          return r.text;
        } catch {
          return "";
        }
      },
    }).catch((e) => loggerSync().warn("[preference] script_edit profile build failed:", e));
  }

  return { kind: "json", body: { ok: true, event_id: event.id, diff_summary: fullDiffSummary } };
}

export async function copyPreferences(targetSlug: string, body: unknown): Promise<MemoryUseCaseResult> {
  const v = validate(CopyPreferencesSchema, body);
  if (!v.ok) return validationError(v.errors);

  const { isValidSlug } = await import("../../api/v2/index");
  if (!isValidSlug(v.data.source_slug)) {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "ValidationError", message: "source_slug 含非法字符" } },
    };
  }

  const sourceDir = path.join(DATA_ROOT, "series", v.data.source_slug);
  const targetDir = path.join(DATA_ROOT, "series", targetSlug);

  const sourcePrefs = loadProjectPreferences(sourceDir);
  if (!sourcePrefs) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "源项目没有偏好档案" } },
    };
  }

  const sourcePath = path.join(sourceDir, "project_preferences.json");
  const targetPath = path.join(targetDir, "project_preferences.json");
  await fs.copyFile(sourcePath, targetPath);

  return { kind: "json", body: { ok: true, preferences: sourcePrefs } };
}
