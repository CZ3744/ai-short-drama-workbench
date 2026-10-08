import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";

import {
  readSeries,
  readEpisode,
  updateEpisode,
  listShots,
} from "../../api/v2/seriesStore";
import {
  validate,
  ExtractEntitiesSchema,
  GenerateCoverSchema,
  GenerateMetadataSchema,
} from "../../api/v2/validators";
import { sseBroker } from "../../api/v2/sseBroker";
import {
  getRegistry,
  getLedger,
  resolveLlmProviderId,
} from "../../api/v2/orchestration/_shared/registry";
import {
  SSR_BASE,
  episodeBase,
  promptsDir,
  savePromptSnapshot,
} from "../../api/v2/orchestration/_shared/paths";
import {
  passThroughSignal,
  parseJsonFromLlm,
  isRecoverableProviderFailure,
  providerFailureSummary,
} from "../../api/v2/orchestration/_shared/llmJson";
import { EntityExtractionSchema } from "../../api/v2/orchestration/_shared/schemas";
import { buildFallbackEntityExtraction } from "../../api/v2/orchestration/_shared/fallbacks";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";

import { ensureDir, writeJson, pathExists } from "../../../../../packages/core/src/index";
import { loggerSync, logProviderCall } from "../../../../../packages/core/src/logger";
import { compilePrompt } from "../../../../../packages/providers/src/promptCompiler";
import { ProviderError } from "../../../../../packages/providers/src/core/index";
import { saveToVault } from "../../../../../packages/library/src/assetVault";
import { tryWithFallback, resolveChain, FallbackChainError } from "../../../../../packages/providers/src/core/queue";
import type { ProviderContext, CostInfo } from "../../../../../packages/providers/src/core/types";
import { getKeyFor, getConfigValue } from "../../../../../packages/core/src/localSettings";
import {
  recordEvent,
  hashInput,
} from "../../../../../packages/drama/src/memory/preferenceStore";
import {
  maybeBuildProfile,
  enrichSystemPrompt,
  needsProfileBuild,
} from "../../../../../packages/drama/src/memory/profileBuilder";
import { generateImagesWithProvider } from "../generation/imageGenerationService";
import { providerIdFromModelRef } from "../generation/modelRef";
import { resolveCoverReference } from "./coverReference";
import { buildCoverImagePrompt } from "../generation/coverPrompt";
import { readCurrentEpisodeScript } from "../../api/v2/orchestration/_shared/scriptText";

export type EpisodeUseCaseResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "json"; body: Record<string, unknown> };

export interface EpisodeInput {
  slug: string;
  episodeId: string;
}

export interface BodyEpisodeInput extends EpisodeInput {
  body: unknown;
}

export interface EpisodeDeps {
  progress: ProgressSink;
  requestId?: string;
}

export async function extractEntities(
  input: BodyEpisodeInput,
  deps: EpisodeDeps,
): Promise<EpisodeUseCaseResult> {
  const t0 = Date.now();
  const v = validate(ExtractEntitiesSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  const series = await readSeries(input.slug);
  if (!series) return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "系列不存在" } } };

  const scriptPath = path.join(episodeBase(input.slug, input.episodeId), "script.md");
  const fullScript = await readCurrentEpisodeScript(episode, scriptPath);

  const ctx: Record<string, any> = {
    full_script: fullScript,
    content_type_phrase: series.defaults.content_type || "knowledge_card",
    visual_style_phrase: series.defaults.visual_style || "cinematic",
  };
  const compiled = await compilePrompt("entity_extractor", ctx, { missing_slot_policy: "placeholder" });
  const snapshotName = await savePromptSnapshot(input.slug, input.episodeId, "entity_extractor", compiled.text, ctx);

  deps.progress.progress("extract-entities.calling", { episode_id: input.episodeId });

  const providerId = providerIdFromModelRef(v.data.overrides?.llm_provider_id)
    || resolveLlmProviderId(series.defaults as Record<string, any>);
  const chain = resolveChain(
    providerId,
    getRegistry().listAvailable("llm").map(p => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );

  const providerCtx: ProviderContext = {
    series_slug: input.slug,
    job_id: `extract_${Date.now().toString(36)}`,
    task_id: `task_${Date.now().toString(36)}`,
    log: () => {},
    signal: passThroughSignal(),
  };

  let actualProviderId = providerId;
  const baseSystemExtract = "你是一位专业的剧本分析师。只返回合法 JSON，不要包含 Markdown 代码块。";
  const enrichedSystemExtract = enrichSystemPrompt(baseSystemExtract, "extract-entities");

  let llmResult: { text: string; cost?: CostInfo } | null = null;
  let validated: z.infer<typeof EntityExtractionSchema>;
  let usedFallback = false;
  let fallbackReason: string | undefined;

  try {
    llmResult = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
      prompt: compiled.text,
      system: enrichedSystemExtract,
      response_format: "json",
      max_tokens: 4096,
    }, providerCtx, (evt) => {
      actualProviderId = evt.to;
      sseBroker.broadcast("provider.fallback", { from: evt.from, to: evt.to, reason: evt.reason });
    });

    try {
      recordEvent({
        stage: "extract-entities",
        input_hash: hashInput(compiled.text),
        output_json: llmResult.text,
        user_action: "adopt",
      });
      if (needsProfileBuild("extract-entities")) {
        maybeBuildProfile("extract-entities", {
          callLlm: async (sys, usr) => {
            const r = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
              prompt: usr, system: sys, response_format: "text", max_tokens: 1024,
            }, providerCtx);
            return r.text;
          },
        }).catch((e) => loggerSync().warn("[preference] profile build failed:", e));
      }
    } catch (e: unknown) { loggerSync().warn("[preference] recordEvent failed:", e); }

    const raw = parseJsonFromLlm(llmResult.text);
    validated = EntityExtractionSchema.parse(raw);
  } catch (err) {
    if (!isRecoverableProviderFailure(err)) throw err;
    usedFallback = true;
    fallbackReason = providerFailureSummary(err);
    actualProviderId = "local_heuristic";
    validated = buildFallbackEntityExtraction(fullScript);
    deps.progress.progress("extract-entities.local_fallback", {
      episode_id: input.episodeId,
      reason: fallbackReason.slice(0, 300),
    });
    getLedger().record({
      at: new Date().toISOString(),
      series_slug: input.slug,
      job_id: providerCtx.job_id,
      task_id: providerCtx.task_id,
      kind: "llm",
      provider_id: providerId,
      ok: false,
      params_digest: Date.now().toString(36),
      duration_ms: Date.now() - t0,
      error_code: err instanceof FallbackChainError ? "all_providers_failed" : err instanceof ProviderError ? err.code : "provider_failed",
    });
  }

  const entitiesDir = path.join(episodeBase(input.slug, input.episodeId));
  await writeJson(path.join(entitiesDir, "entities.json"), {
    ...validated,
    _extracted_at: new Date().toISOString(),
    _provider: actualProviderId,
  });

  if (validated.characters?.length > 0) {
    for (const ch of validated.characters) {
      const chId = `char_${ch.character_id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const chFile = path.join(SSR_BASE, input.slug, "characters", `${chId}.json`);
      await ensureDir(path.dirname(chFile));
      if (!(await pathExists(chFile))) {
        // Wave B-3 (2026-05-16): 同步写新拆分字段 appearance(给生图模型);
        // legacy appearance_prompt 仍写, 保证向后兼容老前端。
        const visualHint = ch.appearance_hint || ch.description || "";
        await writeJson(chFile, {
          id: chId,
          series_slug: input.slug,
          name: ch.name,
          role: ch.role_type,
          appearance_prompt: visualHint,
          appearance: visualHint || undefined,
          personality: ch.personality_traits?.join(", ") || "",
          ref_image_ids: [],
          status: "drafted",
          _source: "entity_extractor",
        });
      }
    }
  }
  if (validated.scenes?.length > 0) {
    for (const sc of validated.scenes) {
      const scId = `scn_${String(sc.scene_id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const scFile = path.join(SSR_BASE, input.slug, "scenes", `${scId}.json`);
      await ensureDir(path.dirname(scFile));
      if (!(await pathExists(scFile))) {
        await writeJson(scFile, {
          id: scId,
          series_slug: input.slug,
          name: sc.scene_name,
          location: sc.location,
          time_of_day: sc.time_of_day,
          mood: sc.atmosphere,
          visual_style: series.defaults.visual_style || "cinematic",
          ref_image_ids: [],
          status: "drafted",
          _source: "entity_extractor",
        });
      }
    }
  }

  if (llmResult) {
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
      duration_ms: Date.now() - t0,
    });
  }

  await updateEpisode(input.slug, input.episodeId, { status: "scripting" });

  deps.progress.progress("extract-entities.done", {
    episode_id: input.episodeId,
    character_count: validated.characters.length,
    scene_count: validated.scenes.length,
  });

  return {
    kind: "json",
    body: {
      ok: true,
      episode_id: input.episodeId,
      entities: {
        characters: validated.characters.map(ch => ({ id: ch.character_id, name: ch.name, role: ch.role_type })),
        scenes: validated.scenes.map(sc => ({ id: sc.scene_id, name: sc.scene_name, location: sc.location })),
        character_count: validated.characters.length,
        scene_count: validated.scenes.length,
      },
      statistics: validated.statistics,
      prompt_snapshot: snapshotName,
      fallback: usedFallback,
      fallback_reason: fallbackReason,
      cost: llmResult?.cost ?? { currency: "CNY", amount: 0, basis: "estimated" },
    },
  };
}

export async function runQualityCheck(input: EpisodeInput): Promise<EpisodeUseCaseResult> {
  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };

  const baseDir = episodeBase(input.slug, input.episodeId);
  const finalPath = path.join(baseDir, "compose", "final.mp4");
  const composeDir = path.join(baseDir, "compose");

  if (!(await pathExists(finalPath))) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "合成产物不存在, 请先完成合成" } },
    };
  }

  const { runOutputCheck } = await import("../../../../../packages/drama/src/quality/outputCheck");
  const report = await runOutputCheck(finalPath, composeDir);
  return { kind: "json", body: { ok: true, report } };
}

export async function generateCover(input: BodyEpisodeInput, deps: { requestId?: string; preview?: boolean }): Promise<EpisodeUseCaseResult> {
  const v = validate(GenerateCoverSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };

  const series = await readSeries(input.slug);
  const defaults = (series?.defaults ?? {}) as Record<string, any>;

  // W7 (2026-05-15) — Bug 1: 不再 silent fallback 到 local_card_image。
  // 封面图也是用户付费 AI 内容,未选 provider → 400。
  const imageProviderId = v.data.provider_override
    || (typeof defaults.image_provider_id === "string" && defaults.image_provider_id.trim()
      ? defaults.image_provider_id
      : "");
  if (!imageProviderId && !deps.preview) {
    return {
      kind: "error",
      status: 400,
      body: {
        error: {
          code: "provider_not_selected",
          message: "请先选择图像模型，或在设置中配置默认图像模型",
        },
      },
    };
  }

  const ctx: Record<string, any> = {
    series_title: series?.title || episode.title,
    series_synopsis: series?.synopsis || "",
    episode_title: episode.title,
    episode_index: episode.index,
    episode_synopsis: episode.synopsis || "",
    content_type_phrase: defaults.content_type || "知识科普",
    visual_style_phrase: v.data.style || defaults.visual_style || "cinematic",
    platform_phrase: defaults.platform || "B站",
    aspect_ratio: "9:16",
    key_characters: "",
    key_scene: "",
  };

  let promptText = buildCoverImagePrompt(ctx);

  // 2026-05-26 — 选了参考帧时, 在 prompt 末尾追加"按图风格"指令,
  //   让模型理解这张参考图代表本集人物/服装/场景的视觉锚定.
  if (v.data.reference_shot_id) {
    promptText += `\n\n【附带参考图】这是本集一个分镜的首帧画面, 请保持其人物外观、服装、场景气氛的强一致性, 在此视觉基础上扩展成 1080×1920 竖屏封面构图 (人物可上移留出标题文字空间)。`;
  }

  if (v.data.title_text) promptText += `\n\n封面标题文字：${v.data.title_text}`;
  if (v.data.prompt_override !== undefined) promptText = v.data.prompt_override;
  let reference: Awaited<ReturnType<typeof resolveCoverReference>> | undefined;
  if (v.data.reference_shot_id) {
    try {
      reference = await resolveCoverReference(input.slug, input.episodeId, v.data.reference_shot_id);
    } catch (error) {
      return { kind: "error", status: 400, body: { error: { code: "InvalidReference", message: error instanceof Error ? error.message : "参考图无法读取，请重新选择" } } };
    }
  }
  if (deps.preview) {
    return { kind: "json", body: { ok: true, prompt: promptText, reference_images: reference ? [{ url: reference.url, label: reference.label }] : [], reference_asset_id: reference?.asset_id, width: 1080, height: 1920, provider_id: imageProviderId } };
  }
  if (v.data.reference_asset_id && reference?.asset_id !== v.data.reference_asset_id) {
    return { kind: "error", status: 409, body: { error: { code: "ReferenceChanged", message: "所选参考图已发生变化，请重新查看完整提示词后再生成" } } };
  }

  const dir = promptsDir(input.slug, input.episodeId);
  await ensureDir(dir);
  const ts = Date.now();
  await writeJson(path.join(dir, `${ts}_cover_designer.json`), { prompt: promptText, context: ctx });

  const registry = getRegistry();
  let providerIdUsed = imageProviderId;
  let generatedImages: Array<{ buffer: Buffer; mime: string; width: number; height: number }> = [];

  const tryGenerate = async (pid: string): Promise<boolean> => {
    const startMs = Date.now();
    try {
      const genResult = await generateImagesWithProvider({
        provider_id: pid,
        prompt: promptText,
        width: 1080,
        height: 1920,
        count: 1,
        series_slug: input.slug,
        ...(reference
          ? { reference_images: [{ asset_id: reference.asset_id, weight: 0.85 }] }
          : {}),
      }, { registry });
      providerIdUsed = genResult.provider_id;
      generatedImages = genResult.images || [];
      logProviderCall({
        requestId: deps.requestId,
        providerId: pid,
        kind: "image",
        durationMs: Date.now() - startMs,
        success: true,
        meta: { purpose: "cover_gen" },
      }).catch((e) => { console.warn("[orch] logProviderCall failed:", (e as Error)?.message ?? e); });
      return generatedImages.length > 0;
    } catch (e: unknown) {
      loggerSync().warn(`[cover] provider ${pid} failed:`, e instanceof Error ? e.message : String(e));
      logProviderCall({
        requestId: deps.requestId,
        providerId: pid,
        kind: "image",
        durationMs: Date.now() - startMs,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        meta: { purpose: "cover_gen" },
      }).catch((err) => { console.warn("[orch] logProviderCall failed:", (err as Error)?.message ?? err); });
      return false;
    }
  };

  // 2026-05-18 (红线 #1 禁伪 mock): 移除 local_card_image silent retry — 用户付费选了 AI 模型,
  // 失败必须返失败让用户看到, 不许偷换成本地 SVG 卡片图冒充付费 AI 封面.
  // 历史: ok 为 false 时静默 retry local_card_image, 写入 vault tags=["cover","generated"]
  //   → 前端 useCover / CoverBlock 不消费 provider_used 字段 → 用户以为得到付费 AI 封面.
  const ok = await tryGenerate(imageProviderId);

  if (ok && generatedImages.length > 0) {
    const img = generatedImages[0];
    const vaultEntry = await saveToVault({
      buffer: img.buffer,
      kind: "image",
      mime: img.mime || "image/png",
      width: img.width || 1080,
      height: img.height || 1920,
      provider_id: providerIdUsed,
      context: {
        kind: "mood_board",
        series_slug: input.slug,
        prompt_digest_sha256: "",
      },
      tags: ["cover", "generated", "episode_cover"],
    });

    // 2026-05-21 — 回写 episode.cover_vault_id 持久化, SeriesDetail 集卡片刷新即可读真图
    await updateEpisode(input.slug, input.episodeId, {
      cover_vault_id: vaultEntry.vault_id,
      cover_prompt_snapshot: `${ts}_cover_designer.json`,
      cover_provider_id: providerIdUsed,
    });

    return {
      kind: "json",
      body: {
        ok: true,
        asset_id: vaultEntry.vault_id,
        url: `/api/v2/vault/${vaultEntry.vault_id}/raw`,
        width: vaultEntry.width,
        height: vaultEntry.height,
        provider_used: providerIdUsed,
        prompt_snapshot: `${ts}_cover_designer.json`,
      },
    };
  }

  return {
    kind: "error",
    status: 502,
    body: {
      ok: false,
      error: { code: "GenerationFailed", message: "封面生成失败：图像服务未返回有效图片，请重试或更换模型" },
      prompt_snapshot: `${ts}_cover_designer.json`,
    },
  };
}

export async function generateMetadata(input: BodyEpisodeInput): Promise<EpisodeUseCaseResult> {
  const v = validate(GenerateMetadataSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };

  const series = await readSeries(input.slug);

  const understandingJson = JSON.stringify({
    title: episode.title,
    synopsis: episode.synopsis || series?.synopsis || "",
    script_md: episode.script_md ? episode.script_md.slice(0, 2000) : "",
    version: episode.version ?? 0,
    target_duration_sec: episode.target_duration_sec ?? 0,
  });
  const shots = await listShots(input.slug, input.episodeId);
  const scenesJson = JSON.stringify(shots.slice(0, 30).map(s => ({
    id: s.id,
    title: s.title || s.scene_label || `镜头${s.index}`,
    dialogue: (s.dialogue || "").slice(0, 200),
    voiceover: (s.voiceover || "").slice(0, 200),
    action: (s.action || "").slice(0, 200),
    visual_prompt: (s.visual_prompt || "").slice(0, 300),
    duration_sec: s.duration_sec ?? 0,
  })));

  const ctx: Record<string, any> = {
    UNDERSTANDING_JSON: understandingJson,
    SCENES_JSON: scenesJson,
    EPISODE_TITLE: episode.title,
    EPISODE_SYNOPSIS: episode.synopsis || "",
    ...v.data.overrides,
  };

  let metadataPrompt: string;
  try {
    const result = await compilePrompt("metadata_agent", ctx, { missing_slot_policy: "placeholder" });
    metadataPrompt = result.text;
  } catch {
    metadataPrompt = `为短剧"${episode.title}"生成3条爆款标题、一段简介和若干标签。`;
  }

  const dir = promptsDir(input.slug, input.episodeId);
  await ensureDir(dir);
  const ts = Date.now();
  await writeJson(path.join(dir, `${ts}_metadata_agent.json`), { prompt: metadataPrompt, context: ctx });

  const defaults = (series?.defaults ?? {}) as Record<string, any>;
  const providerId = providerIdFromModelRef(defaults.llm_provider_id) || resolveLlmProviderId(defaults);
  const registry = getRegistry();
  const chain = resolveChain(
    providerId,
    registry.listAvailable("llm").map(p => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );

  const providerCtx: ProviderContext = {
    series_slug: input.slug,
    job_id: `meta_${Date.now().toString(36)}`,
    task_id: `task_meta_${Date.now().toString(36)}`,
    log: () => {},
    signal: passThroughSignal(),
  };

  let llmText: string;
  try {
    const llmResult = await tryWithFallback(chain, (id) => registry.getLlm(id), {
      prompt: metadataPrompt,
      system: "你是B站视频元数据专家。只返回合法JSON，不要Markdown代码块。",
      response_format: "json",
      max_tokens: 1024,
    }, providerCtx);
    llmText = llmResult.text;
  } catch (llmErr: unknown) {
    loggerSync().warn("[metadata] LLM call failed:", llmErr instanceof Error ? llmErr.message : llmErr);
    return {
      kind: "json",
      body: {
        ok: true,
        message: "LLM 调用失败，返回基础元数据",
        metadata: {
          titles: [episode.title, `${episode.title}完整版`, `${episode.title}精讲`],
          summary: episode.synopsis || series?.synopsis || `短剧${episode.title}的精彩内容。`,
          tags: ["AI视频", "知识分享", "创作"],
        },
        prompt_snapshots: [`${ts}_metadata_agent.json`],
        llm_failed: true,
      },
    };
  }

  let parsed: Record<string, unknown> | null;
  try {
    const cleaned = llmText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === "object") {
    const titles: string[] = [];
    if (parsed.bilibili_title) titles.push(String(parsed.bilibili_title));

    let titlePrompt: string;
    try {
      const titleCtx = { EPISODE_TITLE: episode.title, EPISODE_SYNOPSIS: episode.synopsis || "", ...v.data.overrides };
      const tr = await compilePrompt("title_copywriter", titleCtx, { missing_slot_policy: "placeholder" });
      titlePrompt = tr.text;
    } catch {
      titlePrompt = `为"${episode.title}"生成3条爆款标题`;
    }
    await writeJson(path.join(dir, `${ts}_title_copywriter.json`), { prompt: titlePrompt, context: ctx });

    try {
      const titleResult = await tryWithFallback(chain, (id) => registry.getLlm(id), {
        prompt: `基于元数据"${JSON.stringify({ title: episode.title, summary: parsed.bilibili_description || episode.synopsis })}"，生成2条不同风格的爆款标题(非clickbait)，返回JSON: { "titles": ["标题1", "标题2"] }`,
        system: "你是视频标题专家。只返回合法JSON。",
        response_format: "json",
        max_tokens: 256,
      }, { ...providerCtx, task_id: `task_title_${Date.now().toString(36)}` });
      const titleCleaned = titleResult.text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const titleParsed = JSON.parse(titleCleaned);
      if (Array.isArray(titleParsed.titles)) titles.push(...titleParsed.titles);
    } catch { /* fall through */ }

    while (titles.length < 3) titles.push(`${episode.title}·视角${titles.length + 1}`);

    return {
      kind: "json",
      body: {
        ok: true,
        metadata: {
          titles: titles.slice(0, 5),
          summary: parsed.bilibili_description || parsed.summary || episode.synopsis || "",
          tags: parsed.bilibili_tags || parsed.tags || ["AI视频", "创作"],
          cover_text: parsed.cover_text || "",
          comment_prompt: parsed.comment_prompt || "",
        },
        prompt_snapshots: [`${ts}_metadata_agent.json`, `${ts}_title_copywriter.json`],
      },
    };
  }

  return {
    kind: "json",
    body: {
      ok: true,
      metadata: {
        titles: [episode.title, `${episode.title}深度版`, `${episode.title}速览`],
        summary: episode.synopsis || `短剧${episode.title}的精彩内容。`,
        tags: ["AI视频", "创作"],
      },
      prompt_snapshots: [`${ts}_metadata_agent.json`],
    },
  };
}
