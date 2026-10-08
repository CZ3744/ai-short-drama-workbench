import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";

import {
  createEpisode,
  listEpisodes,
  readSeries,
  updateEpisode,
  updateSeries,
  type EpisodeVersion,
} from "../../api/v2/seriesStore";
import { validate, ExpandScriptSchema } from "../../api/v2/validators";
import { sseBroker } from "../../api/v2/sseBroker";
import { getRegistry, getLedger, resolveLlmProviderId } from "../../api/v2/orchestration/_shared/registry";
import { episodeBase, seriesBase, saveSeriesPromptSnapshot } from "../../api/v2/orchestration/_shared/paths";
import { passThroughSignal, parseJsonFromLlm } from "../../api/v2/orchestration/_shared/llmJson";
import { ScriptExpandResultSchema } from "../../api/v2/orchestration/_shared/schemas";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";

import { ensureDir, DATA_ROOT } from "../../../../../packages/core/src/index";
import { loggerSync, logProviderCall } from "../../../../../packages/core/src/logger";
import { appendFailure } from "../../repositories/failureRepo";
import { getKeyFor, getConfigValue } from "../../../../../packages/core/src/localSettings";
import { compilePrompt } from "../../../../../packages/providers/src/promptCompiler";
import { tryWithFallback, resolveChain, FallbackChainError } from "../../../../../packages/providers/src/core/queue";
import type { ProviderContext } from "../../../../../packages/providers/src/core/types";
import {
  recordEvent, hashInput,
} from "../../../../../packages/drama/src/memory/preferenceStore";
import { humanizeMentionText } from "../../../../../packages/drama/src/mentionParser";
import {
  enrichSystemPrompt, needsProfileBuild,
  maybeBuildProfileAndSave,
} from "../../../../../packages/drama/src/memory/profileBuilder";
import { providerIdFromModelRef } from "../generation/modelRef";
// W6-B: 多版本管理 — 成功时新建一个 ScriptVersion（不覆盖既有版本）
import { createScriptVersion } from "../../repositories/scriptVersionsRepo";

export interface ExpandScriptInput {
  slug: string;
  body: unknown;
  startedAtMs: number;
  /** 2026-05-20 P1 铁律 #1: caller (路由层) 透传 req.signal 让客户端断开 / 用户取消能真 abort. */
  signal?: AbortSignal;
}

export interface RequestLog {
  info: (obj: Record<string, unknown>, message: string) => void;
}

export interface ExpandScriptDeps {
  progress: ProgressSink;
  requestId?: string;
  requestLog?: RequestLog;
}

export type ExpandScriptResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "respondError"; status: number; body: Record<string, unknown> }
  | { kind: "respondJson"; body: Record<string, unknown> }
  | { kind: "json"; body: Record<string, unknown> };

interface PrimaryEpisodeScript {
  episodeId: string;
  absoluteScriptPath: string;
  dataScriptPath: string;
  relativeScriptPath: string;
}

async function upsertPrimaryEpisodeScript(input: {
  slug: string;
  title: string;
  scriptMd: string;
  summary: string;
  targetDurationSec?: number;
}): Promise<PrimaryEpisodeScript> {
  const episodes = await listEpisodes(input.slug);
  const existing = episodes[0];
  const episode = existing ?? await createEpisode(input.slug, { title: input.title, index: 1 });
  const epId = episode.id;
  const epDir = episodeBase(input.slug, epId);
  const relativeScriptPath = `episodes/${epId}/script.md`;
  const absoluteScriptPath = path.join(epDir, "script.md");

  await ensureDir(epDir);
  await fs.writeFile(absoluteScriptPath, input.scriptMd, "utf8");

  const latestVersion = Math.max(
    episode.version ?? 0,
    ...(episode.versions ?? []).map((v) => v.version),
  );
  const nextVersion = latestVersion + 1;
  const version: EpisodeVersion = {
    version: nextVersion,
    created_at: new Date().toISOString(),
    source: "ai_init",
    summary: input.summary,
    script_md: input.scriptMd,
  };

  await updateEpisode(input.slug, epId, {
    ...(existing ? {} : { title: input.title }),
    script_path: relativeScriptPath,
    script_md: input.scriptMd,
    version: nextVersion,
    versions: [...(episode.versions ?? []), version].slice(-50),
    ...(input.targetDurationSec !== undefined ? { target_duration_sec: input.targetDurationSec } : {}),
    status: "scripted",
  });

  return {
    episodeId: epId,
    absoluteScriptPath,
    relativeScriptPath,
    dataScriptPath: `data/series/${input.slug}/${relativeScriptPath}`,
  };
}

export async function expandScript(
  input: ExpandScriptInput,
  deps: ExpandScriptDeps,
): Promise<ExpandScriptResult> {
  const v = validate(ExpandScriptSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const series = await readSeries(input.slug);
  if (!series) {
    return {
      kind: "respondError",
      status: 404,
      body: { error: { code: "NotFound", message: "系列不存在" } },
    };
  }

  if (deps.requestLog) deps.requestLog.info({ action: "expand_script", series_slug: input.slug }, "EXPAND script");

  // Resolve defaults + overrides
  const defaults = v.data.overrides ?? {};
  // 2026-05-20 Wave T hotfix — humanize chip token (Inbox 阶段 series 可能没建素材,ctx 空,只处理长格式)
  const cleanInspiration = humanizeMentionText(v.data.raw_inspiration ?? "");
  // 2026-05-26 audit #9 修复 — DURATION_TARGET 优先级: overrides > series.defaults.duration_target_sec > 60.
  // 用户在 CreateSeriesDialog 填的 "单集时长目标秒" 走到这里,
  // 之前硬编码 60 → 用户填了 30 / 120 全被忽略.
  const seriesDur = (series.defaults as { duration_target_sec?: number } | undefined)?.duration_target_sec;
  const durationTarget = defaults.DURATION_TARGET
    ?? (typeof seriesDur === "number" && seriesDur > 0 ? seriesDur : 60);
  const ctx: Record<string, any> = {
    RAW_INSPIRATION: cleanInspiration,
    TITLE: series.title,
    SYNOPSIS: series.synopsis,
    PLATFORM: series.defaults.platform || "bilibili",
    AUDIENCE: series.defaults.audience || "通用观众",
    TONE: series.defaults.tone || "清晰",
    CONTENT_TYPE: series.defaults.content_type || "knowledge_card",
    ASPECT_RATIO: series.defaults.aspect_ratio || "16:9",
    DURATION_TARGET: durationTarget,
    PROJECT_BRIEF_JSON: JSON.stringify({
      topic: series.title,
      audience: series.defaults.audience ?? "通用观众",
      platform: series.defaults.platform ?? "bilibili",
      style: series.defaults.visual_style ?? "cinematic",
      tone: series.defaults.tone ?? "清晰",
      duration_target_sec: durationTarget,
    }, null, 2),
    ...defaults,
  };

  // Compile prompt
  const compiled = await compilePrompt("script_expander", ctx, { missing_slot_policy: "placeholder" });
  // 2026-05-20 P1 铁律 #12 (批改+发送一致): 如果用户在 PromptReviewButton 弹窗里改了完整 prompt
  // 并点"用修改后版本发送", v.data.prompt_override 是用户编辑后的最终 prompt — 透传到 LLM,
  // 不再用 compile 重新生成. 默认 undefined 时仍走 compilePrompt 输出.
  const promptText = (typeof v.data.prompt_override === "string" && v.data.prompt_override.trim().length > 0)
    ? v.data.prompt_override
    : compiled.text;
  if (v.data.prompt_override && v.data.prompt_override.trim().length > 0) {
    deps.requestLog?.info({
      action: "expand_script.prompt_override",
      series_slug: input.slug,
      override_length: v.data.prompt_override.length,
    }, "expand-script using prompt_override from PromptReviewButton edit");
  }

  const scriptId = "series";
  const scriptDir = seriesBase(input.slug);
  await ensureDir(scriptDir);

  // Save prompt snapshot
  const snapshotName = await saveSeriesPromptSnapshot(input.slug, "expand-script", promptText, ctx);

  // Get LLM provider — prefer request body override, then series defaults, then global config
  const providerId = providerIdFromModelRef(v.data.overrides?.llm_provider_id)
    || resolveLlmProviderId(series.defaults as Record<string, any>);
  // Resolve fallback chain — supports provider failover
  const chain = resolveChain(
    providerId,
    getRegistry().listAvailable("llm").map(p => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );

  // Track actual provider used (may change during fallback)
  let actualProviderId = providerId;

  // SSE: calling LLM
  deps.progress.progress("expand-script.calling", { script_id: scriptId, provider_id: actualProviderId, chain });

  const providerCtx: ProviderContext = {
    series_slug: input.slug,
    job_id: `expand_${Date.now().toString(36)}`,
    task_id: `task_${Date.now().toString(36)}`,
    log: () => {},
    // 2026-05-20 P1 铁律 #1: 不本地设 timeout, 只透传 caller signal — 用户点"中止"或客户端断开才 abort
    signal: passThroughSignal(input.signal),
  };

  let llmResult;
  let expandLlmStartMs = Date.now();
  try {
    // B4: enrich system prompt with user preference profile + few-shot examples
    const baseSystemExpand = "你是一位专业的视频脚本编剧。只返回合法 JSON，不要包含 Markdown 代码块。";
    const enrichedSystemExpand = enrichSystemPrompt(baseSystemExpand, "expand-script");

    llmResult = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
      prompt: promptText,
      system: enrichedSystemExpand,
      response_format: "json",
      max_tokens: 4096,
    }, providerCtx, (evt) => {
      actualProviderId = evt.to;
      sseBroker.broadcast("provider.fallback", { from: evt.from, to: evt.to, reason: evt.reason });
    });
    logProviderCall({
      requestId: deps.requestId,
      providerId: actualProviderId || chain[0] || "llm",
      kind: "llm",
      durationMs: Date.now() - expandLlmStartMs,
      success: true,
      meta: { purpose: "expand_script" },
    }).catch((e) => { console.warn("[orch] logProviderCall failed:", (e as Error)?.message ?? e); });

    // B4: record event (adopt) — LLM output was accepted by the system
    try {
      recordEvent({
        stage: "expand-script",
        input_hash: hashInput(promptText),
        output_json: llmResult.text,
        user_action: "adopt",
      });
      // B5: Background profile rebuild if threshold met (also saves project_preferences.json)
      if (needsProfileBuild("expand-script")) {
        const seriesDir = path.join(DATA_ROOT, "series", input.slug);
        maybeBuildProfileAndSave("expand-script", seriesDir, {
          callLlm: async (sys: string, usr: string) => {
            const r = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
              prompt: usr, system: sys, response_format: "text", max_tokens: 1024,
            }, providerCtx);
            return r.text;
          },
        }).catch((e: unknown) => loggerSync().warn("[preference] profile build failed:", e));
      }
    } catch (e: unknown) { loggerSync().warn("[preference] recordEvent failed:", e); }
  } catch (err: unknown) {
    logProviderCall({
      requestId: deps.requestId,
      providerId: chain.join(","),
      kind: "llm",
      durationMs: Date.now() - expandLlmStartMs,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      meta: { purpose: "expand_script" },
    }).catch((e) => { console.warn("[orch] logProviderCall failed:", (e as Error)?.message ?? e); });

      if (err instanceof FallbackChainError) {
        // 2026-05-26 Codex walkthrough P0-1 — 铁律 #3 (silent mock fallback 红线):
        //   旧逻辑会把 "# 标题\n\n## 灵感原文\n\n原文" 当成剧本写进 episode/series 主版本,
        //   episode.status 改成 "scripted", 下游分镜板以为有真剧本可以继续 — 这是欺骗.
        //   即便前端 toast 警告了,数据被污染. 改成硬失败:不动任何 episode/series 数据,
        //   throw 502 让前端 toast 红字 + 拦住后续流程, 用户去修 LLM provider 或换模型再试.
        deps.progress.progress("expand-script.failed", {
          script_id: scriptId,
          chain,
          reason: "all_providers_failed",
          providers_attempted: err.errors.map(e => e.provider_id),
          error: err.summary(),
        });
        // 2026-05-27 — 写入 FailureCenter, 让用户能在 /cockpit/failures 看见 + 主动重试.
        appendFailure(input.slug, {
          code: "LLMUnavailable",
          message: `扩写剧本失败: ${err.summary()}`,
          kind: "expand_script",
          provider: err.errors.map(e => e.provider_id).join(","),
        }).catch(() => {});

        return {
          kind: "respondError",
          status: 502,
          body: {
            error: {
              code: "LLMUnavailable",
              message: `AI 扩写失败:已尝试 ${err.errors.length} 个模型全部不可用。${err.suggestion()}`,
              providers_attempted: err.errors.map(e => e.provider_id),
            },
          },
        };
      }
      throw err;
    }

  // Parse and validate
  // 2026-05-27 — 删 silent fallback. 之前 LLM 没按 JSON 回, 旧逻辑把 LLM 原始文本
  // 当 full_script 写进 episode + 新建 ScriptVersion → 用户在前端看"扩写成功"+
  // 一份内容"剧本", 但其实是 LLM 乱码污染数据, 下游拆分镜继续基于污染脚本走,
  // 失败用户找不到根因. 跟上面 FallbackChainError 同处理: 502 + 不动数据.
  let script: z.infer<typeof ScriptExpandResultSchema>;
  try {
    script = ScriptExpandResultSchema.parse(parseJsonFromLlm(llmResult.text));
  } catch (parseErr) {
    deps.progress.progress("expand-script.failed", {
      script_id: scriptId,
      chain,
      reason: "llm_output_not_json",
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      raw_preview: llmResult.text.slice(0, 200),
    });
    // 2026-05-27 — 写 FailureCenter 同 FallbackChainError 路径
    appendFailure(input.slug, {
      code: "LLMOutputInvalid",
      message: `扩写剧本失败: LLM 输出非合法 JSON (${parseErr instanceof Error ? parseErr.message.slice(0, 100) : String(parseErr).slice(0, 100)})`,
      kind: "expand_script",
    }).catch(() => {});
    return {
      kind: "respondError",
      status: 502,
      body: {
        error: {
          code: "LLMOutputInvalid",
          message: "AI 扩写返回内容不是合法剧本格式 (JSON 解析失败), 请换模型或重试。原内容已丢弃, 不会污染你的剧本。",
          raw_preview: llmResult.text.slice(0, 200),
        },
      },
    };
  }

  // Write script.md
  const scriptMd = [
    `# ${script.title}`,
    "",
    `> 时长预估: ${script.estimated_duration_sec}秒 | 风格: ${script.style_notes}`,
    "",
    script.hook ? `## 开场钩子\n\n${script.hook}\n` : "",
    script.outline && script.outline.length > 0
      ? `## 大纲\n\n${script.outline.map((s) => `- **${s.section_title}**: ${s.key_points.join(", ")}`).join("\n")}\n`
      : "",
    "## 完整脚本",
    "",
    script.full_script,
    "",
    script.source_assumptions ? `---\n*来源说明: ${script.source_assumptions}*` : "",
  ].filter(Boolean).join("\n");

  await fs.writeFile(path.join(scriptDir, "script.md"), scriptMd, "utf8");
  const primaryEpisode = await upsertPrimaryEpisodeScript({
    slug: input.slug,
    title: script.title,
    scriptMd,
    summary: `AI 生成 v${(series.script_version ?? 0) + 1}: ${script.title} (${script.estimated_duration_sec}s)`,
    targetDurationSec: script.estimated_duration_sec,
  });

  // Log to cost ledger
  getLedger().record({
    at: new Date().toISOString(),
    series_slug: input.slug,
    job_id: providerCtx.job_id,
    task_id: providerCtx.task_id,
    kind: "llm",
    provider_id: actualProviderId,
    ok: true,
    params_digest: Date.now().toString(36),
    cost: llmResult.cost,
    duration_ms: Date.now() - input.startedAtMs,
  });

  const nextVersion = (series.script_version ?? 0) + 1;
  const version = {
    version: nextVersion,
    created_at: new Date().toISOString(),
    source: "ai_init" as const,
    summary: `AI 生成 v${nextVersion}: ${script.title} (${script.estimated_duration_sec}s)`,
    script_md: scriptMd,
  };

  await updateSeries(input.slug, {
    script_path: "script.md",
    script_md: scriptMd,
    script_version: nextVersion,
    script_versions: [...(series.script_versions ?? []), version].slice(-50),
  });

  // W6-B: 新建一个独立的 ScriptVersion（多版本并行，不覆盖既有），并设为 active。
  // 旧 series.script_md / script_versions 同步保留作为"当前激活版本的镜像 + 历史时间轴"。
  let scriptVersionRecord: { id: string; title: string } | null = null;
  try {
    const created = await createScriptVersion({
      series_slug: input.slug,
      title: v.data.version_title,
      content_md: scriptMd,
      source_inspirations: v.data.source_inspirations ?? [],
      user_prompt: v.data.user_prompt,
      parent_version_id: v.data.parent_version_id,
      activate: true,
    });
    scriptVersionRecord = { id: created.id, title: created.title };
  } catch (e: unknown) {
    loggerSync().warn("[expand-script] createScriptVersion failed (legacy path still ok):",
      e instanceof Error ? e.message : e);
  }

  deps.progress.progress("expand-script.done", { script_id: scriptId, estimated_duration_sec: script.estimated_duration_sec });

  return {
    kind: "json",
    body: {
      ok: true,
      episode_id: primaryEpisode.episodeId,
      script_id: scriptId,
      script_path: primaryEpisode.dataScriptPath,
      series_script_path: `data/series/${input.slug}/script.md`,
      script: {
        title: script.title,
        hook: script.hook,
        outline_count: script.outline.length,
        estimated_duration_sec: script.estimated_duration_sec,
      },
      prompt_snapshot: snapshotName,
      cost: llmResult.cost,
      // W6-B: 暴露新建的 ScriptVersion 给前端
      script_version: scriptVersionRecord,
    },
  };
}
