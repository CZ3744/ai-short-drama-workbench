/**
 * Prompt preview use cases (W5-B).
 *
 * 给前端 PromptReviewButton 用 — 调这些函数能拿到"即将发送给模型的完整提示词"
 * 但 **不真发起 LLM/TTS 调用**, 不扣费, 不写状态. 目的是让用户可以:
 *   - 审阅 (看到 system + user + 上下文是否符合预期)
 *   - 复制走 (粘到别的 AI 平台手动生)
 *   - 改完再发 (走真正的 expand-script / plan-storyboard 端点)
 *
 * 4 个函数对应 4 个端点:
 *   previewExpandScriptPrompt        → POST /series/:slug/preview-expand-prompt
 *   previewPlanStoryboardPrompt      → POST /series/:slug/episodes/:epId/preview-plan-storyboard-prompt
 *   previewAiChatPrompt              → POST /series/:slug/preview-ai-chat-prompt
 *   previewTtsPrompt                 → POST /series/:slug/episodes/:epId/preview-tts-prompt
 *
 * 注意: 图像/视频已有 dryRun 端点 (W3-B dryRunElementImage / W1-Y dryRunVideo),
 * 前端 PromptReviewButton 在图像/视频场景直接调它们, **不在此处重复.**
 */

import path from "node:path";
import { isSupportingElement } from "../../../../../packages/drama/src/elementKinds";
import fs from "node:fs/promises";

import { ExpandScriptSchema, PlanStoryboardSchema, validate } from "../../api/v2/validators";
import {
  listEpisodes,
  listCharacters,
  listScenes,
  listShots,
  readEpisode,
  readSeries,
} from "../../api/v2/seriesStore";
import { episodeBase } from "../../api/v2/orchestration/_shared/paths";
import {
  getRegistry,
  resolveLlmProviderId,
} from "../../api/v2/orchestration/_shared/registry";

import { compilePrompt } from "../../../../../packages/providers/src/promptCompiler";
import { loadPrompt, fillTemplate } from "../../../../../packages/providers/src/index";
import { resolveChain } from "../../../../../packages/providers/src/core/queue";
import { enrichSystemPrompt } from "../../../../../packages/drama/src/memory/profileBuilder";
// Wave B-3 (2026-05-16): 统一 character 拆分字段 → LLM context 拼接 helper
import { formatCharacterForLlmContext } from "../../../../../packages/drama/src/characterPrompt";
import { parseDialogue, resolveVoiceForEmotion } from "../../../../../packages/drama/src/dialogueParser";
import { stripMentionTokens } from "../../../../../packages/drama/src/mentionParser";
import { getKeyFor, getConfigValue } from "../../../../../packages/core/src/localSettings";

import { providerIdFromModelRef } from "../generation/modelRef";
// 2026-05-21 X-2 V-38: preview 也暴露已有图清单 (预览 = 真发)
import { formatImagesHint } from "../planStoryboard/_shared";
import { listElements } from "../../repositories/elementRepo";

// ─── 公共结果 ────────────────────────────────────────────────────

export interface PromptPreviewBody {
  kind: "text" | "image" | "video" | "tts";
  full_prompt: string;
  negative_prompt?: string;
  system_prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  reference_images?: Array<{ url: string; label: string }>;
  reference_video?: { url: string; label: string };
  target_provider?: string;
  target_model?: string;
  estimated_cost?: { cny?: number; note?: string };
}

export type PreviewResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "ok"; body: PromptPreviewBody };

// ─── helper: 解析将要调用的 LLM provider id (考虑 fallback chain) ───

function resolveTargetLlm(
  overrides: Record<string, any> | undefined,
  seriesDefaults: Record<string, any>,
): { providerId: string; chain: string[] } {
  const providerId = providerIdFromModelRef(overrides?.llm_provider_id)
    || resolveLlmProviderId(seriesDefaults);
  const chain = resolveChain(
    providerId,
    getRegistry().listAvailable("llm").map(p => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );
  return { providerId, chain };
}

// ─── 1. expand-script preview ────────────────────────────────────

export interface PreviewExpandScriptInput {
  slug: string;
  body: unknown;
}

export async function previewExpandScriptPrompt(
  input: PreviewExpandScriptInput,
): Promise<PreviewResult> {
  const v = validate(ExpandScriptSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const series = await readSeries(input.slug);
  if (!series) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "系列不存在" } },
    };
  }

  const defaults = v.data.overrides ?? {};
  const ctx: Record<string, any> = {
    RAW_INSPIRATION: v.data.raw_inspiration,
    TITLE: series.title,
    SYNOPSIS: series.synopsis,
    PLATFORM: series.defaults.platform || "bilibili",
    AUDIENCE: series.defaults.audience || "通用观众",
    TONE: series.defaults.tone || "清晰",
    CONTENT_TYPE: series.defaults.content_type || "knowledge_card",
    ASPECT_RATIO: series.defaults.aspect_ratio || "16:9",
    DURATION_TARGET: defaults.DURATION_TARGET ?? 60,
    PROJECT_BRIEF_JSON: JSON.stringify({
      topic: series.title,
      audience: series.defaults.audience ?? "通用观众",
      platform: series.defaults.platform ?? "bilibili",
      style: series.defaults.visual_style ?? "cinematic",
      tone: series.defaults.tone ?? "清晰",
      duration_target_sec: defaults.DURATION_TARGET ?? 60,
    }, null, 2),
    ...defaults,
  };

  const compiled = await compilePrompt("script_expander", ctx, { missing_slot_policy: "placeholder" });
  const baseSystem = "你是一位专业的视频脚本编剧。只返回合法 JSON，不要包含 Markdown 代码块。";
  const enrichedSystem = enrichSystemPrompt(baseSystem, "expand-script");

  const { providerId } = resolveTargetLlm(v.data.overrides, series.defaults as Record<string, any>);

  return {
    kind: "ok",
    body: {
      kind: "text",
      full_prompt: compiled.text,
      system_prompt: enrichedSystem,
      target_provider: providerId,
    },
  };
}

// ─── 2. plan-storyboard preview ──────────────────────────────────
// 拆分镜实际是 3 段 (beat_sheet → storyboard_director → critic),
// 第一次发送给 LLM 的 prompt 是 beat_sheet_planner. 复用它做 preview.

export interface PreviewPlanStoryboardInput {
  slug: string;
  episodeId: string;
  body: unknown;
}

export async function previewPlanStoryboardPrompt(
  input: PreviewPlanStoryboardInput,
): Promise<PreviewResult> {
  const v = validate(PlanStoryboardSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const series = await readSeries(input.slug);
  if (!series) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "系列不存在" } } };
  }
  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }

  const scriptPath = path.join(episodeBase(input.slug, input.episodeId), "script.md");
  let scriptText = "";
  try {
    scriptText = await fs.readFile(scriptPath, "utf8");
  } catch {
    scriptText = episode.synopsis || episode.title || "";
  }

  const characters = await listCharacters(input.slug);
  const scenes = await listScenes(input.slug);

  // 2026-05-21 X-2 V-38: preview 也暴露已有图清单 + propsContext (预览 = 真发)
  const allElements = await listElements(input.slug).catch(() => [] as Awaited<ReturnType<typeof listElements>>);
  const propsAndMisc = allElements.filter(isSupportingElement);

  // Wave B-3 (2026-05-16): 用统一 helper, 把 personality/appearance/outfit 分别 surface 给 LLM
  const characterList = characters.length > 0
    ? characters.map(ch => {
        const base = formatCharacterForLlmContext(ch);
        const imgs = formatImagesHint({
          refImageIds: ch.ref_image_ids,
          refImageMeta: ch.ref_image_meta,
          primaryId: ch.primary_ref_image_id,
        });
        return `${base}${imgs}`;
      }).join("\n")
    : "（暂无已锁定角色， 请先运行 extract-entities）";
  const sceneList = scenes.length > 0
    ? scenes.map(sc => {
        const base = `- ${sc.id}: ${sc.name} (${sc.location}, ${sc.time_of_day || "any"}) — ${sc.mood || ""}`;
        const imgs = formatImagesHint({
          refImageIds: sc.ref_image_ids,
          refImageMeta: sc.ref_image_meta,
          primaryId: sc.primary_ref_image_id,
        });
        return `${base}${imgs}`;
      }).join("\n")
    : "（暂无已锁定场景）";
  const propsContext = propsAndMisc.length > 0
    ? propsAndMisc
        .map((p: any) => {
          const base = `- [${p.kind}] ${p.name}${p.description ? `: ${p.description}` : ""}`;
          const imgs = formatImagesHint({
            images: p.images,
            imageBriefs: p.image_briefs,
            primaryId: p.primary_image_id,
          });
          return `${base}${imgs}`;
        })
        .join("\n")
    : "";

  const targetDuration = episode.target_duration_sec ?? 60;

  const beatCtx: Record<string, any> = {
    series_title: series.title,
    series_synopsis: series.synopsis,
    episode_title: episode.title,
    episode_synopsis: episode.synopsis || "",
    content_type_phrase: series.defaults.content_type || "知识科普",
    platform_phrase: series.defaults.platform || "bilibili",
    visual_style_phrase: series.defaults.visual_style || "cinematic",
    tone_phrase: series.defaults.tone || "清晰",
    pacing_phrase: series.defaults.pacing || "适中",
    ending_type_phrase: series.defaults.ending_type || "开放式结尾",
    target_duration_sec: targetDuration,
    character_list: characterList,
    scene_list: sceneList,
    props_context: propsContext || undefined,
    script_text: scriptText,
  };

  const compiled = await compilePrompt("beat_sheet_planner", beatCtx, { missing_slot_policy: "placeholder" });
  const baseSystem = "你是一位叙事节拍设计师。只返回合法 JSON，不要包含 Markdown 代码块。";
  const enrichedSystem = enrichSystemPrompt(baseSystem, "beat_sheet_planner");

  const { providerId } = resolveTargetLlm(v.data.overrides, series.defaults as Record<string, any>);

  return {
    kind: "ok",
    body: {
      kind: "text",
      full_prompt: compiled.text,
      system_prompt: enrichedSystem,
      target_provider: providerId,
    },
  };
}

// ─── 3. AI chat preview (剧本页 AI 助手) ──────────────────────────
// 用户在剧本页输入一句 user_message, AI 帮 brainstorm / 润色. preview 拼装出
// 完整发给 LLM 的 system + messages.

export interface PreviewAiChatInput {
  slug: string;
  body: {
    user_message?: string;
    /** 已有对话历史 — 复用给"多轮"展示 */
    history?: Array<{ role: string; content: string }>;
    /** 让用户选用哪个 LLM */
    llm_provider_id?: string;
    /** 助手类型 — brainstorm | polish | summarize, 影响 system prompt. 默认 brainstorm. */
    mode?: "brainstorm" | "polish" | "summarize";
  };
}

const CHAT_SYSTEM: Record<string, string> = {
  brainstorm: "你是一位短剧创作伙伴。基于用户的剧本上下文，给出具体可落地的建议。直接讲要点，避免空话。",
  polish: "你是一位剧本润色编辑。在保持原意的前提下让台词更自然、节奏更紧凑。",
  summarize: "你是一位剧本审读助手。用 5 条以内的要点总结当前剧本的核心冲突、人物动机与节奏问题。",
};

export async function previewAiChatPrompt(input: PreviewAiChatInput): Promise<PreviewResult> {
  const body = input.body ?? {};
  const userMessage = typeof body.user_message === "string" ? body.user_message.trim() : "";
  if (!userMessage) {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "ValidationError", message: "user_message 必填" } },
    };
  }

  const series = await readSeries(input.slug);
  if (!series) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "系列不存在" } } };
  }

  const mode = body.mode ?? "brainstorm";
  const baseSystem = CHAT_SYSTEM[mode] ?? CHAT_SYSTEM.brainstorm;
  const contextLine = [
    `系列: ${series.title}`,
    series.synopsis ? `简介: ${series.synopsis}` : "",
    series.script_md ? `剧本片段(前 600 字):\n${series.script_md.slice(0, 600)}` : "",
  ].filter(Boolean).join("\n\n");

  const systemPrompt = `${baseSystem}\n\n${contextLine}`.trim();
  const enrichedSystem = enrichSystemPrompt(systemPrompt, "ai_chat");

  const history: Array<{ role: string; content: string }> = Array.isArray(body.history)
    ? body.history
        .filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
        .slice(-12)
    : [];

  const messages = [...history, { role: "user", content: userMessage }];

  const { providerId } = resolveTargetLlm(
    { llm_provider_id: body.llm_provider_id },
    series.defaults as Record<string, any>,
  );

  return {
    kind: "ok",
    body: {
      kind: "text",
      full_prompt: userMessage,
      system_prompt: enrichedSystem,
      messages,
      target_provider: providerId,
    },
  };
}

// ─── 4. AI suggest preview (剧本页 / 行内改写) ─────────────────────

export interface AiSuggestPromptPartsInput {
  context?: string;
  instruction?: string;
  scope?: unknown;
}

export function buildAiSuggestPromptParts(input: AiSuggestPromptPartsInput): { system: string; prompt: string } {
  const context = String(input.context ?? "").slice(0, 12000);
  const instruction = String(input.instruction ?? "");
  const system = [
    "你是视频短剧创作编辑。只返回 JSON。",
    "格式: {\"patches\":[{\"kind\":\"modify|insert|rewrite|delete\",\"path\":\"...\",\"title\":\"...\",\"before\":\"...\",\"after\":\"...\",\"affect\":\"...\"}]}",
    "patch 要可直接展示给用户确认，after 必须是完整可替换文本。",
  ].join("\n");
  const prompt = `上下文:\n${context}\n\n用户想怎么改:\n${instruction}\n\n范围:\n${JSON.stringify(input.scope ?? {})}`;
  return { system, prompt };
}

export interface PreviewAiSuggestInput {
  slug: string;
  body: {
    context?: string;
    instruction?: string;
    scope?: unknown;
    llm_provider_id?: string;
  };
}

export async function previewAiSuggestPrompt(input: PreviewAiSuggestInput): Promise<PreviewResult> {
  const body = input.body ?? {};
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "ValidationError", message: "instruction 必填" } },
    };
  }

  const series = await readSeries(input.slug);
  if (!series) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "系列不存在" } } };
  }

  const { system, prompt } = buildAiSuggestPromptParts({
    context: body.context,
    instruction,
    scope: body.scope,
  });
  const { providerId } = resolveTargetLlm(
    { llm_provider_id: body.llm_provider_id },
    series.defaults as Record<string, any>,
  );

  return {
    kind: "ok",
    body: {
      kind: "text",
      full_prompt: prompt,
      system_prompt: system,
      target_provider: providerId,
    },
  };
}

// ─── 5. plan-storyboard preview (系列级，无 epId) ─────────────────
// ScriptCanvasPage "查看完整提示词" 按钮用。系列还没拆集，直接用 series.script_md。

export interface PreviewSeriesPlanStoryboardInput {
  slug: string;
  body: unknown;
}

export async function previewSeriesPlanStoryboardPrompt(
  input: PreviewSeriesPlanStoryboardInput,
): Promise<PreviewResult> {
  const series = await readSeries(input.slug);
  if (!series) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "系列不存在" } } };
  }

  // 系列级剧本：直接取 script_md，未写则退回 synopsis
  const scriptText = (series.script_md ?? series.synopsis ?? "").trim();

  const characters = await listCharacters(input.slug);
  const scenes = await listScenes(input.slug);

  // Wave B-3 (2026-05-16): 用统一 helper, 把 personality/appearance/outfit 分别 surface 给 LLM
  const characterList = characters.length > 0
    ? characters.map(ch => formatCharacterForLlmContext(ch)).join("\n")
    : "（暂无已锁定角色）";
  const sceneList = scenes.length > 0
    ? scenes.map(sc => `- ${sc.id}: ${sc.name} (${sc.location}, ${sc.time_of_day || "any"}) — ${sc.mood || ""}`).join("\n")
    : "（暂无已锁定场景）";

  const beatCtx: Record<string, any> = {
    series_title: series.title,
    series_synopsis: series.synopsis ?? "",
    episode_title: series.title,
    episode_synopsis: series.synopsis ?? "",
    content_type_phrase: series.defaults.content_type || "知识科普",
    platform_phrase: series.defaults.platform || "bilibili",
    visual_style_phrase: series.defaults.visual_style || "cinematic",
    tone_phrase: series.defaults.tone || "清晰",
    pacing_phrase: series.defaults.pacing || "适中",
    ending_type_phrase: series.defaults.ending_type || "开放式结尾",
    target_duration_sec: 60,
    character_list: characterList,
    scene_list: sceneList,
    script_text: scriptText,
  };

  const compiled = await compilePrompt("beat_sheet_planner", beatCtx, { missing_slot_policy: "placeholder" });
  const baseSystem = "你是一位叙事节拍设计师。只返回合法 JSON，不要包含 Markdown 代码块。";
  const enrichedSystem = enrichSystemPrompt(baseSystem, "beat_sheet_planner");

  const body = (input.body ?? {}) as Record<string, any>;
  const { providerId } = resolveTargetLlm(body.overrides, series.defaults as Record<string, any>);

  return {
    kind: "ok",
    body: {
      kind: "text",
      full_prompt: compiled.text,
      system_prompt: enrichedSystem,
      target_provider: providerId,
    },
  };
}

// ─── 6. episode revise preview ──────────────────────────────────

export type ReviseScope = "global" | "paragraph" | "dialog_only";

export interface ReviseSelection {
  start: number;
  end: number;
}

export interface ReviseOverrides {
  length?: string;
  ending?: string;
  tone?: string;
  rhythm?: string;
  llm_provider_id?: string;
}

export interface BuildRevisePromptInput {
  slug: string;
  episodeId: string;
  user_note?: string;
  scope?: ReviseScope;
  selection?: ReviseSelection;
  overrides?: ReviseOverrides;
}

export async function buildRevisePromptParts(input: BuildRevisePromptInput): Promise<{
  note: string;
  systemPrompt: string;
  userPrompt: string;
  currentScript: string;
}> {
  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) {
    throw Object.assign(new Error("集不存在"), { status: 404, code: "NotFound" });
  }

  const note = String(input.user_note || "").trim();
  if (!note) {
    throw Object.assign(new Error("user_note 不能为空"), { status: 400, code: "ValidationError" });
  }

  const currentScript = episode.script_md || "";
  const scope = input.scope || "global";
  const overrides = input.overrides;

  let prevContext = "";
  try {
    if (typeof episode.index === "number" && episode.index > 1) {
      const allEps = await listEpisodes(input.slug);
      const prevEp = allEps.find((e) => e.index === episode.index - 1);
      if (prevEp) {
        const prevShots = await listShots(input.slug, prevEp.id);
        const last3 = prevShots
          .sort((a, b) => a.index - b.index)
          .slice(-3);
        const lines = last3
          .map((s) => {
            const txt = (s.dialogue || s.voiceover || s.action || "").trim();
            return txt ? `- 镜 ${s.index}: ${txt.slice(0, 200)}` : "";
          })
          .filter(Boolean);
        if (lines.length > 0) {
          prevContext = `\n\n## 上一集 (${prevEp.title || prevEp.id}) 结尾参考 (后 ${lines.length} 镜)\n${lines.join("\n")}\n\n要求: 本集开头要承接上集结尾, 保持线索连贯, 避免突兀切入.`;
        }
      }
    }
  } catch (e) {
    console.warn("[episode-revise] build prev_ep context failed (continuing):", e instanceof Error ? e.message : e);
  }

  const prompt = await loadPrompt("script_revision.md").catch(() => null);
  let systemPrompt: string;
  let userPrompt: string;

  if (prompt) {
    let selectionContext = "";
    if (scope === "paragraph" && input.selection) {
      const selectedText = currentScript.slice(input.selection.start, input.selection.end);
      selectionContext = `\n\n用户选中的段落:\n---\n${selectedText}\n---\n请仅修改上述选中段落, 保持其余部分不变。`;
    }

    let overridesInfo = "无特殊要求";
    if (overrides) {
      const parts: string[] = [];
      if (overrides.length) parts.push(`目标长度: ${overrides.length}`);
      if (overrides.ending) parts.push(`结局风格: ${overrides.ending}`);
      if (overrides.tone) parts.push(`语气: ${overrides.tone}`);
      if (overrides.rhythm) parts.push(`节奏: ${overrides.rhythm}`);
      if (parts.length > 0) overridesInfo = parts.join(", ");
    }

    const filled = fillTemplate(prompt, {
      CURRENT_SCRIPT: currentScript,
      USER_NOTE: note,
      SCOPE: scope,
      SELECTION_CONTEXT: selectionContext,
      OVERRIDES_INFO: overridesInfo,
    });
    systemPrompt = "你是专业的剧本编辑 AI。只输出修改后的完整剧本, 不要加任何解释。";
    userPrompt = filled;
  } else {
    let contextInfo = "";
    if (scope === "paragraph" && input.selection) {
      const selectedText = currentScript.slice(input.selection.start, input.selection.end);
      contextInfo = `\n\n用户选中的段落:\n---\n${selectedText}\n---\n请仅修改上述选中段落, 保持其余部分不变。`;
    }

    let overrideInfo = "";
    if (overrides) {
      const parts: string[] = [];
      if (overrides.length) parts.push(`目标长度: ${overrides.length}`);
      if (overrides.ending) parts.push(`结局风格: ${overrides.ending}`);
      if (overrides.tone) parts.push(`语气: ${overrides.tone}`);
      if (overrides.rhythm) parts.push(`节奏: ${overrides.rhythm}`);
      if (parts.length > 0) overrideInfo = `\n\n参数要求:\n${parts.join("\n")}`;
    }

    systemPrompt = "你是专业的剧本编辑 AI。请根据用户的修改意见返回修改后的完整剧本。保留 Markdown 格式。只输出修改后的剧本内容, 不要加解释。";
    userPrompt = `当前剧本:\n---\n${currentScript}\n---\n\n用户修改意见: ${note}${contextInfo}${overrideInfo}`;
  }

  if (prevContext) {
    userPrompt = `${userPrompt}${prevContext}`;
  }

  return { note, systemPrompt, userPrompt, currentScript };
}

export interface PreviewReviseInput {
  slug: string;
  episodeId: string;
  body: {
    user_note?: string;
    scope?: ReviseScope;
    selection?: ReviseSelection;
    overrides?: ReviseOverrides;
  };
}

export async function previewRevisePrompt(input: PreviewReviseInput): Promise<PreviewResult> {
  try {
    const body = input.body ?? {};
    const parts = await buildRevisePromptParts({
      slug: input.slug,
      episodeId: input.episodeId,
      user_note: body.user_note,
      scope: body.scope,
      selection: body.selection,
      overrides: body.overrides,
    });
    const series = await readSeries(input.slug);
    const target = series
      ? resolveTargetLlm(body.overrides, series.defaults as Record<string, any>).providerId
      : undefined;
    return {
      kind: "ok",
      body: {
        kind: "text",
        full_prompt: parts.userPrompt,
        system_prompt: parts.systemPrompt,
        target_provider: target,
      },
    };
  } catch (err) {
    const e = err as Error & { status?: number; code?: string };
    return {
      kind: "error",
      status: e.status ?? 500,
      body: { error: { code: e.code ?? "PreviewError", message: e.message || "预览失败" } },
    };
  }
}

// ─── 7. TTS preview ──────────────────────────────────────────────
// TTS 没有"prompt"概念, 但有"将要发给 TTS provider 的最终请求体":
//   - 把每个 shot 的 dialogue / voiceover 串起来 → 完整 text
//   - voice_id / speed / provider_id 写进 metadata
// 用户可以复制走, 在别的 TTS 服务自己合成 wav, 再粘贴回来 manual upload.

export interface PreviewTtsInput {
  slug: string;
  episodeId: string;
  body: {
    voice_id?: string;
    tts_provider_id?: string;
    speed?: number;
  };
}

export async function previewTtsPrompt(input: PreviewTtsInput): Promise<PreviewResult> {
  const series = await readSeries(input.slug);
  if (!series) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "系列不存在" } } };
  }
  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }

  const shots = await listShots(input.slug, input.episodeId);
  const body = input.body ?? {};
  const ttsProviderId = body.tts_provider_id || series.defaults.tts_provider_id || "edge_tts";
  const voiceId = body.voice_id || series.defaults.tts_voice_id || "zh-CN-XiaoxiaoNeural";
  const speed = typeof body.speed === "number" ? body.speed : 1.0;

  // 拼出"按 shot 分行"的最终 TTS 文本 — 这就是要发给 TTS provider 的字面 text
  const lines: string[] = [];
  for (const shot of shots) {
    const text = (shot.dialogue || shot.voiceover || "").trim();
    if (!text) continue;
    lines.push(`[SHOT_${String(shot.index).padStart(2, "0")}] ${text}`);
  }
  const fullText = lines.length > 0 ? lines.join("\n\n") : "(无台词 / 旁白, 此集 TTS 将跳过)";

  // 等价的 JSON 请求体, 让用户能直接复制走到第三方 TTS
  const requestBody = {
    provider_id: ttsProviderId,
    voice_id: voiceId,
    speed,
    text: fullText,
    shot_count: shots.length,
    has_dialogue_count: lines.length,
  };

  const fullPrompt = `# TTS 请求预览 (provider=${ttsProviderId}, voice=${voiceId}, speed=${speed})\n\n` +
    `## 等价 JSON 请求体\n\`\`\`json\n${JSON.stringify(requestBody, null, 2)}\n\`\`\`\n\n` +
    `## 实际要合成的 text\n${fullText}`;

  return {
    kind: "ok",
    body: {
      kind: "tts",
      full_prompt: fullPrompt,
      target_provider: ttsProviderId,
      target_model: voiceId,
    },
  };
}

export interface PreviewComposeInput {
  slug: string;
  episodeId: string;
  body: Record<string, any>;
}

/** Minimal shot shape used by preview helpers (avoids `any`). */
interface PreviewShotInput {
  id: string;
  index?: number;
  title?: string;
  dialogue?: string;
  voiceover?: string;
  action?: string;
  duration_sec?: number;
  tts_voice_override?: string | null;
  picked_video_generation_id?: string | null;
  picked_video_id?: string | null;
  generations?: Array<{
    generation_id?: string;
    id?: string;
    type?: string;
    status?: string;
    picked?: boolean;
    display_name?: string;
    user_label?: string;
    provider_label?: string;
    provider?: string;
    source?: string;
    duration_sec?: number;
  }>;
}

function subtitleSafeZonePct(aspectRatio?: string): number {
  const normalized = (aspectRatio || "9:16").trim().replace("x", ":");
  if (normalized === "16:9") return 5;
  if (normalized === "1:1") return 12;
  return 20;
}

function pickedVideoLabel(shot: PreviewShotInput): string {
  const generations = Array.isArray(shot.generations) ? shot.generations : [];
  const videoGens = generations.filter((g) => g?.type === "video" && g?.status !== "failed");
  const pickedId = shot.picked_video_generation_id || shot.picked_video_id;
  const picked = videoGens.find((g) => g.generation_id === pickedId || g.id === pickedId)
    || videoGens.find((g) => g.picked === true)
    || videoGens[0];
  if (!picked) return "未选定视频片段";
  const source =
    picked.display_name
    || picked.user_label
    || picked.provider_label
    || picked.provider
    || picked.source
    || "已选视频片段";
  const duration = typeof picked.duration_sec === "number" ? `，${picked.duration_sec}s` : "";
  return `${source}${duration}`;
}

function resolvePreviewVoiceForShot(
  shot: PreviewShotInput,
  text: string,
  characters: Awaited<ReturnType<typeof listCharacters>>,
  body: Record<string, any>,
  fallbackVoiceId: string,
): string {
  const episodeOverride = typeof body.episode_voice_override === "string" ? body.episode_voice_override : "";
  if (episodeOverride) return episodeOverride;
  if (typeof shot.tts_voice_override === "string" && shot.tts_voice_override) return shot.tts_voice_override;

  const dialogueLines = parseDialogue(text);
  if (dialogueLines.length === 0) return fallbackVoiceId;

  const firstLine = dialogueLines[0];
  const charData = characters.find((ch) => ch.name === firstLine.character_name);
  const overrideVoiceStyleMap = body.voice_style_map && typeof body.voice_style_map === "object"
    ? body.voice_style_map as Record<string, Record<string, string | undefined>>
    : {};
  const tempOverrideForChar = charData ? overrideVoiceStyleMap[charData.id] : undefined;

  if (tempOverrideForChar) {
    return resolveVoiceForEmotion(
      tempOverrideForChar,
      firstLine.emotion,
      charData?.voice_id ?? fallbackVoiceId,
    );
  }
  if (charData?.voice_style_map) {
    return resolveVoiceForEmotion(
      charData.voice_style_map,
      firstLine.emotion,
      charData.voice_id ?? fallbackVoiceId,
    );
  }
  return charData?.voice_id || fallbackVoiceId;
}

export async function previewComposePrompt(input: PreviewComposeInput): Promise<PreviewResult> {
  const series = await readSeries(input.slug);
  if (!series) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "系列不存在" } } };
  }
  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }

  const shots = await listShots(input.slug, input.episodeId);
  const characters = await listCharacters(input.slug);
  const body = input.body ?? {};
  const ttsProviderId =
    body.episode_voice_provider_override
    || body.tts_provider
    || body.tts_provider_id
    || series.defaults.tts_provider_id
    || "edge_tts";
  const defaultVoiceId =
    body.episode_voice_override
    || body.tts_voice
    || body.tts_voice_id
    || series.defaults.tts_voice_id
    || "zh-CN-XiaoxiaoNeural";
  const audioMode = body.audio_mode === "original" ? "original" : "tts";
  const burnSubtitles = body.burn_subtitles !== false;
  const aspectRatio = body.aspect_ratio || series.defaults.aspect_ratio || "9:16";
  const subtitleStyle = body.subtitle_style || "default";
  const subtitleAnimation = body.subtitle_animation || "none";
  const safeZone = subtitleSafeZonePct(aspectRatio);
  const ttsOverride = body.tts_script_override && typeof body.tts_script_override === "object"
    ? body.tts_script_override as Record<string, string>
    : {};
  const globalTtsOverride = typeof ttsOverride.__all === "string" ? ttsOverride.__all : null;

  const shotRows = shots.map((shot) => {
    const rawText = ttsOverride[shot.id] ?? globalTtsOverride ?? (shot.dialogue || shot.voiceover || shot.action || "");
    const text = stripMentionTokens(rawText).trim();
    const voice = resolvePreviewVoiceForShot(shot, text, characters, body, defaultVoiceId);
    const title = shot.title?.trim() || `第 ${shot.index ?? "?"} 镜`;
    return {
      shot: `第 ${shot.index ?? "?"} 镜`,
      title,
      duration_sec: shot.duration_sec || 5,
      tts_text: text || "（无对白/旁白，本镜不发 TTS 文本）",
      voice_id: voice,
      picked_video: pickedVideoLabel(shot),
    };
  });

  const onlyShotLabels = Array.isArray(body.only_shot_ids)
    ? shots
        .filter((shot) => body.only_shot_ids.includes(shot.id))
        .map((shot) => `第 ${shot.index ?? "?"} 镜`)
    : [];

  const requestBody = {
    compose: {
      mode: body.mode || "full",
      audio_mode: audioMode,
      burn_subtitles: burnSubtitles,
      aspect_ratio: aspectRatio,
      subtitle: {
        style: subtitleStyle,
        animation: subtitleAnimation,
        safe_zone_bottom_pct: safeZone,
        tracks: body.subtitle_tracks ?? null,
      },
      tts: {
        provider_id: ttsProviderId,
        default_voice_id: defaultVoiceId,
        per_character_voice_style_map: body.voice_style_map ?? null,
      },
      bgm: {
        mood: body.bgm_mood ?? null,
        volume: body.bgm_volume ?? null,
      },
      transition: body.transition ?? null,
      only_shots: onlyShotLabels,
    },
    shots: shotRows,
  };

  const fullPrompt =
    `# 合成请求预览\n\n` +
    `## 全局设置\n` +
    `- 音轨来源: ${audioMode === "original" ? "使用视频原声" : "使用 TTS 朗读对白"}\n` +
    `- 字幕烧录: ${burnSubtitles ? "烧录到画面" : "仅生成字幕文件，不烧录"}\n` +
    `- 画面比例: ${aspectRatio}\n` +
    `- 字幕样式: ${subtitleStyle}；动画: ${subtitleAnimation}；安全区: 底部 ${safeZone}%\n` +
    `- TTS Provider: ${ttsProviderId}；默认声线: ${defaultVoiceId}\n` +
    `- BGM: ${body.bgm_mood || "不指定"}；音量: ${body.bgm_volume ?? "默认"}\n` +
    `- 转场: ${body.transition || "默认"}\n\n` +
    `## 分镜拼接与 TTS 文本\n` +
    shotRows.map((row) =>
      `### ${row.shot} · ${row.title}\n` +
      `- 时长: ${row.duration_sec}s\n` +
      `- 拼接视频: ${row.picked_video}\n` +
      `- TTS 声线: ${row.voice_id}\n` +
      `- 实际 TTS 输入: ${row.tts_text}`
    ).join("\n\n") +
    `\n\n## 等价合成请求 JSON\n\`\`\`json\n${JSON.stringify(requestBody, null, 2)}\n\`\`\``;

  return {
    kind: "ok",
    body: {
      kind: "tts",
      full_prompt: fullPrompt,
      target_provider: ttsProviderId,
      target_model: defaultVoiceId,
    },
  };
}
