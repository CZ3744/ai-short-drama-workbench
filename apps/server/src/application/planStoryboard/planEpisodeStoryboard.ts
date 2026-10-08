import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";

import {
  listCharacters,
  listScenes,
  readEpisode,
  readSeries,
  updateEpisode,
} from "../../api/v2/seriesStore";
import { listElements } from "../../repositories/elementRepo";
import { validate, PlanStoryboardSchema } from "../../api/v2/validators";
import { sseBroker } from "../../api/v2/sseBroker";
import { getLedger, getRegistry, resolveLlmProviderId } from "../../api/v2/orchestration/_shared/registry";
import { episodeBase, savePromptSnapshot } from "../../api/v2/orchestration/_shared/paths";
import {
  isRecoverableProviderFailure,
  parseJsonFromLlm,
  providerFailureSummary,
  passThroughSignal,
} from "../../api/v2/orchestration/_shared/llmJson";
import {
  buildFallbackBeatSheet,
  buildFallbackCriticVerdict,
  buildFallbackShotPlan,
  CRITIC_PASS_THRESHOLD,
} from "../../api/v2/orchestration/_shared/fallbacks";
import {
  BeatSheetResultSchema,
  CriticVerdictResultSchema,
  ShotPlanSchema,
} from "../../api/v2/orchestration/_shared/schemas";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";

import { writeJson } from "../../../../../packages/core/src/index";
import { loggerSync, logProviderCall } from "../../../../../packages/core/src/logger";
import { getConfigValue, getKeyFor } from "../../../../../packages/core/src/localSettings";
import { ProviderError } from "../../../../../packages/providers/src/core/index";
import { appendFailure } from "../../repositories/failureRepo";
import { resolveChain, tryWithFallback, FallbackChainError } from "../../../../../packages/providers/src/core/queue";
import type { ProviderContext } from "../../../../../packages/providers/src/core/types";
import { compilePrompt } from "../../../../../packages/providers/src/promptCompiler";
import {
  runDirectorLoop,
  type DirectorDecision,
  type DirectorTool,
  type ProjectManifest,
  type QualitySignals,
} from "../../../../../packages/drama/src/index";
import { hashInput, recordEvent } from "../../../../../packages/drama/src/memory/preferenceStore";
// Wave B-3 (2026-05-16): 角色拆分字段拼接 helper, 给 LLM 上下文用
import { formatCharacterForLlmContext } from "../../../../../packages/drama/src/characterPrompt";
import { providerIdFromModelRef } from "../generation/modelRef";
import {
  enrichSystemPrompt,
  maybeBuildProfile,
  needsProfileBuild,
} from "../../../../../packages/drama/src/memory/profileBuilder";
// 2026-05-21 U-1: image_overrides 解析抽成共享函数, planSeries / batchSeries 也复用
import { formatImagesHint, normalizeShotPlanShotTypes } from "./_shared";
import { persistStoryboard } from "./persistStoryboard";

export type PlanEpisodeStoryboardResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "respondJson"; body: Record<string, unknown> };

export interface PlanEpisodeStoryboardInput {
  slug: string;
  episodeId: string;
  body: unknown;
  useDirector: boolean;
  /** 2026-05-20 P1 铁律 #1: caller 透传 req.signal — 客户端断开能真 abort LLM. */
  signal?: AbortSignal;
}

export interface PlanEpisodeStoryboardDeps {
  progress: ProgressSink;
  requestId?: string;
}

export async function planEpisodeStoryboard(
  input: PlanEpisodeStoryboardInput,
  deps: PlanEpisodeStoryboardDeps,
): Promise<PlanEpisodeStoryboardResult> {
  const t0 = Date.now();
  const progress = (stage: string, data: Record<string, unknown> = {}) => deps.progress.progress(stage, data);

  const bodyValidated = validate(PlanStoryboardSchema, input.body);
  if (!bodyValidated.ok) {
    return {
      kind: "validation",
      status: bodyValidated.status,
      errors: bodyValidated.errors,
    };
  }

  const series = await readSeries(input.slug);
  if (!series) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "系列不存在" } } };
  }
  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }
  const _series = series;
  const _episode = episode;

  const scriptPath = path.join(episodeBase(input.slug, input.episodeId), "script.md");
  let scriptText = "";
  try {
    scriptText = await fs.readFile(scriptPath, "utf8");
  } catch {
    scriptText = episode.synopsis || episode.title || "";
  }

  const characters = await listCharacters(input.slug);
  const scenes = await listScenes(input.slug);

  // 2026-05-19 优化 2: 读 prop / wardrobe / reference / misc 四类 Element.
  // listElements(opts?.kind) 只接受单数 kind, 这里干脆全量拉再 filter (素材数量级 < 100, 性能可忽略).
  // 一键抽首帧的 implicitReferenceCollector 走 shot.element_ids 拿 typical 图,
  // 但前提是 storyboard LLM 在拆分镜时把可用素材的 name 写进 shot.element_refs.
  // health-ignore: character/scene 走上方 listCharacters/listScenes 专门 API (line 297-298),
  // 此处 propsAndMisc 只管 4 类通用素材, 是设计上的职责分离, 不是 ElementKind 覆盖缺失
  const allElements = await listElements(input.slug);
  const propsAndMisc = allElements.filter(
    e => e.kind === "prop" || e.kind === "wardrobe" || e.kind === "reference" || e.kind === "misc",
  );

  // name → id 映射, 落盘 ShotData.element_ids 时需要 (LLM 输出的是 name).
  // 同时 lower-case 兜底, 容错 LLM 大小写不一致.
  const elementNameToId = new Map<string, string>();
  for (const el of propsAndMisc) {
    elementNameToId.set(el.name, el.id);
    elementNameToId.set(el.name.toLowerCase().trim(), el.id);
  }

  // 2026-05-20 Wave T Phase 1 — formatImagesHint 已抽到 ./_shared.ts (X-2 共享)

  // Wave B-3 (2026-05-16): 用统一 helper 拼接 character LLM context
  // 把 personality / appearance / outfit 分别 surfaced 给 LLM, 让对白和外观/服装权重分离。
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

  // 2026-05-19 优化 2: 把"可用的道具/服装/参考素材"列表拼进 LLM 上下文.
  // 让 LLM 在拆分镜时输出 shot.element_refs (用 name 引用), 避免发明新素材,
  // 并让后续生图阶段 implicitReferenceCollector 走 element_ids 拿到 typical 图.
  const propsContext = propsAndMisc.length > 0
    ? `\n\n## 可用的道具/服装/参考/杂项素材 (请优先引用, 避免 LLM 自己发明)\n\n${propsAndMisc
        .map(p => {
          const base = `- [${p.kind}] ${p.name}${p.description ? `: ${p.description}` : ""}`;
          const imgs = formatImagesHint({
            images: p.images,
            imageBriefs: p.image_briefs,
            primaryId: p.primary_image_id,
          });
          return `${base}${imgs}`;
        })
        .join("\n")}\n\n要求: shot 内容如果出现这些素材, 必须在 shot.element_refs 数组里列出对应的 name (大小写需与上方完全一致), 让系统自动复用 typical 图保证视觉一致.`
    : "";

  const epBase = episodeBase(input.slug, input.episodeId);
  const targetDuration = episode.target_duration_sec ?? 60;

  const providerId = providerIdFromModelRef(bodyValidated.data.overrides?.llm_provider_id)
    || resolveLlmProviderId(series.defaults as Record<string, any>);
  const chain = resolveChain(
    providerId,
    getRegistry().listAvailable("llm").map(p => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );
  let actualProviderId = providerId;

  const makeProviderCtx = (tag: string): ProviderContext => ({
    series_slug: input.slug,
    job_id: `storyboard_${Date.now().toString(36)}`,
    task_id: `task_${tag}_${Date.now().toString(36)}`,
    log: () => {},
    // 2026-05-20 P1 铁律 #1: 透传 caller signal
    signal: passThroughSignal(input.signal),
  });

  const totalCost = { input_tokens: 0, output_tokens: 0, estimated_cny: 0 };
  const addCost = (cost: unknown) => {
    if (!cost || typeof cost !== "object") return;
    const c = cost as Record<string, unknown>;
    totalCost.input_tokens += (c.input_tokens as number) ?? 0;
    totalCost.output_tokens += (c.output_tokens as number) ?? 0;
    totalCost.estimated_cny += (c.estimated_cny as number) ?? 0;
  };

  const generateBeatSheet = async (): Promise<z.infer<typeof BeatSheetResultSchema>> => {
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
      script_text: scriptText,
    };
    const compiled = await compilePrompt("beat_sheet_planner", beatCtx, { missing_slot_policy: "placeholder" });
    await savePromptSnapshot(input.slug, input.episodeId, "beat_sheet_planner", compiled.text, beatCtx);
    const provCtx = makeProviderCtx("beat");
    const sys = enrichSystemPrompt("你是一位叙事节拍设计师。只返回合法 JSON，不要包含 Markdown 代码块。", "beat_sheet_planner");
    const beatStartMs = Date.now();
    const result = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
      prompt: compiled.text,
      system: sys,
      response_format: "json",
      max_tokens: 4096,
    }, provCtx, (evt) => {
      actualProviderId = evt.to;
      sseBroker.broadcast("provider.fallback", { from: evt.from, to: evt.to, reason: evt.reason });
    });
    addCost(result.cost);
    getLedger().record({
      at: new Date().toISOString(),
      series_slug: input.slug,
      job_id: provCtx.job_id,
      task_id: provCtx.task_id,
      kind: "llm",
      provider_id: actualProviderId,
      ok: true,
      params_digest: Date.now().toString(36),
      cost: result.cost,
      duration_ms: Date.now() - t0,
    });
    logProviderCall({
      requestId: deps.requestId,
      providerId: actualProviderId || chain[0] || "llm",
      kind: "llm",
      durationMs: Date.now() - beatStartMs,
      success: true,
      meta: { purpose: "beat_sheet_planner" },
    }).catch((e) => { console.warn("[orch] logProviderCall failed:", (e as Error)?.message ?? e); });
    try {
      recordEvent({ stage: "beat_sheet_planner", input_hash: hashInput(compiled.text), output_json: result.text, user_action: "adopt" });
    } catch (e) {
      loggerSync().warn("[preference] recordEvent failed:", e);
    }
    try {
      return BeatSheetResultSchema.parse(parseJsonFromLlm(result.text));
    } catch {
      const d = Math.round(targetDuration / 6);
      return {
        hook_3s: { beat_name: "开场钩子", description: "抓住注意力", target_duration_sec: Math.min(3, d), key_elements: [] },
        setup: { beat_name: "铺垫", description: "交代背景", target_duration_sec: d, key_elements: [] },
        inciting_incident: { beat_name: "激励事件", description: "推动冲突", target_duration_sec: d, key_elements: [] },
        midpoint_twist: { beat_name: "中点转折", description: "方向逆转", target_duration_sec: d, key_elements: [] },
        climax: { beat_name: "高潮", description: "冲突顶点", target_duration_sec: d, key_elements: [] },
        payoff: { beat_name: "收尾", description: "解决冲突", target_duration_sec: d, key_elements: [] },
      };
    }
  };

  const runBeatToScenes = async (
    bs: z.infer<typeof BeatSheetResultSchema>,
    extraCtx: Record<string, any> = {},
  ): Promise<{ validated: z.infer<typeof ShotPlanSchema>; cost: any }> => {
    const sceneCtx: Record<string, any> = {
      series_title: _series.title,
      series_synopsis: _series.synopsis,
      episode_title: _episode.title,
      episode_index: _episode.index,
      episode_count: _series.episodes.length || 1,
      episode_synopsis: _episode.synopsis || "",
      content_type_phrase: _series.defaults.content_type || "知识科普",
      platform_phrase: _series.defaults.platform || "bilibili",
      visual_style_phrase: _series.defaults.visual_style || "cinematic",
      tone_phrase: _series.defaults.tone || "清晰",
      pacing_phrase: _series.defaults.pacing || "适中",
      ending_type_phrase: _series.defaults.ending_type || "开放式结尾",
      target_duration_sec: targetDuration,
      shot_count_hint: _episode.target_shot_count ?? 10,
      character_list: characterList,
      scene_list: sceneList,
      // 2026-05-19 优化 2: 注入 prop/wardrobe/reference/misc 素材列表给 LLM,
      // 让分镜阶段 LLM 能看到这些非角色/场景素材, 输出 shot.element_refs[].
      props_context: propsContext,
      aspect_ratio: _series.defaults.aspect_ratio || "16:9",
      user_note: (input.body && typeof input.body === "object" && "user_note" in input.body && typeof input.body.user_note === "string" ? input.body.user_note : "") || "",
      beat_sheet: JSON.stringify(bs, null, 2),
      ...extraCtx,
    };
    const compiled = await compilePrompt("storyboard_director", sceneCtx, { missing_slot_policy: "placeholder" });
    await savePromptSnapshot(input.slug, input.episodeId, "storyboard_director", compiled.text, sceneCtx);
    const provCtx = makeProviderCtx("scenes");
    const sys = enrichSystemPrompt("你是一位资深分镜导演。严格根据节拍表(BeatSheet)展开分镜。只返回合法 JSON 数组，不要包含 Markdown 代码块。", "plan-storyboard");
    const llmResult = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
      prompt: compiled.text,
      system: sys,
      response_format: "json",
      max_tokens: 8192,
    }, provCtx, (evt) => {
      actualProviderId = evt.to;
      sseBroker.broadcast("provider.fallback", { from: evt.from, to: evt.to, reason: evt.reason });
    });
    try {
      recordEvent({ stage: "plan-storyboard", input_hash: hashInput(compiled.text), output_json: llmResult.text, user_action: "adopt" });
      if (needsProfileBuild("plan-storyboard")) {
        maybeBuildProfile("plan-storyboard", {
          callLlm: async (s, u) => {
            const r = await tryWithFallback(
              chain,
              (id) => getRegistry().getLlm(id),
              { prompt: u, system: s, response_format: "text", max_tokens: 1024 },
              provCtx,
            );
            return r.text;
          },
        }).catch((e) => loggerSync().warn("[preference] profile build failed:", e));
      }
    } catch (e) {
      loggerSync().warn("[preference] recordEvent failed:", e);
    }
    let raw: unknown = parseJsonFromLlm(llmResult.text);
    if (!Array.isArray(raw) && raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (Array.isArray(obj[k]) && (obj[k] as unknown[]).length > 0) {
          raw = obj[k];
          break;
        }
      }
    }
    // 2026-05-27 — 删本地启发式拼凑分镜兜底. 之前 ShotPlanSchema.parse 失败时
    // 就地切字符串拼凑出 N 个 fallback 分镜 (defaultCharId="char_unknown",
    // defaultSceneId="scn_default"), 用户在分镜板看到"假分镜"以为是 LLM 真输出,
    // 但其实是兜底拼出来的, 完全脱离剧情. 改成抛 ProviderError → 外层 catch
    // 用结构化 buildFallbackShotPlan + 设置 usedFallback=true, 前端 respondJson
    // 拿到 fallback:true 红 banner 提示用户重试.
    let validated: z.infer<typeof ShotPlanSchema>;
    try {
      validated = ShotPlanSchema.parse(raw);
    } catch (zodErr) {
      throw new ProviderError({
        message: `分镜 schema 校验失败: ${zodErr instanceof Error ? zodErr.message.slice(0, 200) : String(zodErr)}`,
        code: "invalid_output",
        provider_id: actualProviderId ?? "unknown",
        retriable: false,
      });
    }
    validated = normalizeShotPlanShotTypes(validated, "beat_to_scenes");
    getLedger().record({
      at: new Date().toISOString(),
      series_slug: input.slug,
      job_id: provCtx.job_id,
      task_id: provCtx.task_id,
      kind: "llm",
      provider_id: actualProviderId,
      ok: true,
      params_digest: Date.now().toString(36),
      cost: llmResult.cost,
      duration_ms: Date.now() - t0,
    });
    return { validated, cost: llmResult.cost };
  };

  const runCritic = async (
    bs: z.infer<typeof BeatSheetResultSchema>,
    shotsData: z.infer<typeof ShotPlanSchema>,
  ): Promise<{ verdict: z.infer<typeof CriticVerdictResultSchema>; cost: any }> => {
    const criticCtx: Record<string, any> = {
      beat_sheet_json: JSON.stringify(bs, null, 2),
      shots_json: JSON.stringify(shotsData, null, 2),
      series_title: _series.title,
      episode_title: _episode.title,
      target_duration_sec: targetDuration,
      shot_count_hint: _episode.target_shot_count ?? 10,
      // 2026-05-20 Wave 优化留尾: 注入角色/场景/道具素材列表, 让 critic 能审查引用合理性
      character_list: characterList,
      scene_list: sceneList,
      props_context: propsContext,
    };
    const compiled = await compilePrompt("storyboard_critic", criticCtx, { missing_slot_policy: "placeholder" });
    await savePromptSnapshot(input.slug, input.episodeId, "storyboard_critic", compiled.text, criticCtx);
    const provCtx = makeProviderCtx("critic");
    const sys = enrichSystemPrompt("你是一位严格的分镜质量审查员。只返回合法 JSON，不要包含 Markdown 代码块。", "storyboard_critic");
    const criticStartMs = Date.now();
    const llmResult = await tryWithFallback(
      chain,
      (id) => getRegistry().getLlm(id),
      { prompt: compiled.text, system: sys, response_format: "json", max_tokens: 2048 },
      provCtx,
      (evt) => {
        actualProviderId = evt.to;
        sseBroker.broadcast("provider.fallback", { from: evt.from, to: evt.to, reason: evt.reason });
      },
    );
    logProviderCall({
      requestId: deps.requestId,
      providerId: actualProviderId || chain[0] || "llm",
      kind: "llm",
      durationMs: Date.now() - criticStartMs,
      success: true,
      meta: { purpose: "storyboard_critic" },
    }).catch((e) => { console.warn("[orch] logProviderCall failed:", (e as Error)?.message ?? e); });
    try {
      recordEvent({ stage: "storyboard_critic", input_hash: hashInput(compiled.text), output_json: llmResult.text, user_action: "adopt" });
    } catch (e) {
      loggerSync().warn("[preference] recordEvent failed:", e);
    }
    // 2026-05-27 — 删 silent "默认通过 80 分" 兜底. 之前 critic JSON parse 失败 →
    // 硬编 0.8 + "审查输出解析失败,默认通过", 前端显示"分镜通过审查 80 分", 但
    // 实际质量根本没审过 (铁律 #5 状态显示与真实状态不一致). 改为显式失败让用户
    // 主动 retry: coverage_score=0 + passed=false + 友好原因.
    let verdict: z.infer<typeof CriticVerdictResultSchema>;
    try {
      verdict = CriticVerdictResultSchema.parse(parseJsonFromLlm(llmResult.text));
    } catch (parseErr) {
      loggerSync().warn(
        "[critic] AI 审查输出解析失败, 标记为未审 (passed=false)",
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
      verdict = {
        coverage_score: 0,
        drift_flags: [],
        missing_beats: [],
        overall_comment: "AI 审查输出无法解析 (非 JSON 格式), 本镜质量未审过, 建议点重试。",
        duration_analysis: {
          total_sec: shotsData.reduce((s, sh) => s + Number(sh.duration_sec), 0),
          target_sec: targetDuration,
          verdict: "ok",
        },
      };
    }
    getLedger().record({
      at: new Date().toISOString(),
      series_slug: input.slug,
      job_id: provCtx.job_id,
      task_id: provCtx.task_id,
      kind: "llm",
      provider_id: actualProviderId,
      ok: true,
      params_digest: Date.now().toString(36),
      cost: llmResult.cost,
      duration_ms: Date.now() - t0,
    });
    return { verdict, cost: llmResult.cost };
  };

  if (input.useDirector) {
    const directorState: {
      beatSheet: z.infer<typeof BeatSheetResultSchema> | null;
      validated: z.infer<typeof ShotPlanSchema>;
      criticVerdict: z.infer<typeof CriticVerdictResultSchema> | null;
      retried: boolean;
      criticAttempt: number;
    } = {
      beatSheet: null,
      validated: [],
      criticVerdict: null,
      retried: false,
      criticAttempt: 0,
    };

    const getManifest = async (): Promise<ProjectManifest> => {
      const shotCount = directorState.validated.length;
      const totalDuration = directorState.validated.reduce((sum, s) => sum + Number(s.duration_sec), 0);
      const qualitySignals: QualitySignals = {
        critic_score: directorState.criticVerdict?.coverage_score,
        failure_count: 0,
        error_messages: [],
      };
      return {
        series_slug: input.slug,
        episode_id: input.episodeId,
        stage: !directorState.beatSheet
          ? "scripting"
          : directorState.validated.length === 0
            ? "storyboarding"
            : (directorState.criticVerdict && directorState.criticVerdict.coverage_score >= CRITIC_PASS_THRESHOLD)
              ? "done"
              : "critic",
        script_done: true,
        storyboard_done: directorState.validated.length > 0 && !!directorState.criticVerdict && directorState.criticVerdict.coverage_score >= CRITIC_PASS_THRESHOLD,
        first_frames_done: false,
        videos_done: false,
        compose_done: false,
        shot_count: shotCount,
        shots_with_video: 0,
        shots_with_first_frame: 0,
        total_duration_sec: totalDuration,
        quality_signals: qualitySignals,
      };
    };

    const executeTool = async (tool: DirectorTool, params: Record<string, unknown>): Promise<ProjectManifest> => {
      switch (tool) {
        case "plan_scenes": {
          progress("plan-storyboard.step1_beat_sheet", { episode_id: input.episodeId });
          directorState.beatSheet = await generateBeatSheet();
          await writeJson(path.join(epBase, "beat_sheet.json"), { ...directorState.beatSheet, _generated_at: new Date().toISOString(), _provider: actualProviderId });
          progress("plan-storyboard.step1_done", { episode_id: input.episodeId, beat_names: [directorState.beatSheet.hook_3s.beat_name, directorState.beatSheet.setup.beat_name, directorState.beatSheet.inciting_incident.beat_name, directorState.beatSheet.midpoint_twist.beat_name, directorState.beatSheet.climax.beat_name, directorState.beatSheet.payoff.beat_name] });

          progress("plan-storyboard.step2_beat_to_scenes", { episode_id: input.episodeId });
          const result = await runBeatToScenes(directorState.beatSheet, (params?.extraCtx ?? {}) as Record<string, any>);
          addCost(result.cost);
          directorState.validated = result.validated;
          progress("plan-storyboard.step2_done", { episode_id: input.episodeId, shot_count: directorState.validated.length });
          break;
        }
        case "run_critic": {
          if (!directorState.beatSheet || directorState.validated.length === 0) {
            progress("plan-storyboard.error", { episode_id: input.episodeId, reason: "Critic 需要已有 beatSheet 和 shots" });
            break;
          }
          directorState.criticAttempt++;
          progress("plan-storyboard.step3_critic", { episode_id: input.episodeId, attempt: directorState.criticAttempt });
          const result = await runCritic(directorState.beatSheet, directorState.validated);
          addCost(result.cost);
          directorState.criticVerdict = result.verdict;
          await writeJson(path.join(epBase, "critic_verdict.json"), { ...directorState.criticVerdict, attempt: directorState.criticAttempt, director_agent: true, _evaluated_at: new Date().toISOString() });
          progress("plan-storyboard.critic_done", { episode_id: input.episodeId, coverage_score: directorState.criticVerdict.coverage_score, threshold: CRITIC_PASS_THRESHOLD, passed: directorState.criticVerdict.coverage_score >= CRITIC_PASS_THRESHOLD });
          break;
        }
        case "replan": {
          if (!directorState.beatSheet || !directorState.criticVerdict) {
            progress("plan-storyboard.error", { episode_id: input.episodeId, reason: "Replan 需要已有 beatSheet 和 critic 结果" });
            break;
          }
          directorState.retried = true;
          progress("plan-storyboard.retry", { episode_id: input.episodeId, coverage_score: directorState.criticVerdict.coverage_score, threshold: CRITIC_PASS_THRESHOLD, reason: (params?.reason as string) || directorState.criticVerdict.overall_comment });
          const retryCtx: Record<string, any> = {};
          if (directorState.criticVerdict.missing_beats.length > 0) {
            retryCtx.critic_feedback = `上一轮审查发现以下问题，请修正：\n${directorState.criticVerdict.missing_beats.map(b => `- ${b.beat_name}: ${b.reason}。建议: ${b.suggestion}`).join("\n")}${directorState.criticVerdict.drift_flags.length > 0 ? `\n主题漂移：\n${directorState.criticVerdict.drift_flags.map(d => `- ${d.shot_id}: ${d.reason}`).join("\n")}` : ""}`;
          }
          Object.assign(retryCtx, (params?.extraCtx ?? {}) as Record<string, any>);
          const result = await runBeatToScenes(directorState.beatSheet, retryCtx);
          addCost(result.cost);
          directorState.validated = result.validated;
          progress("plan-storyboard.replan_done", { episode_id: input.episodeId, shot_count: directorState.validated.length });
          directorState.criticAttempt++;
          const criticRes = await runCritic(directorState.beatSheet, directorState.validated);
          addCost(criticRes.cost);
          directorState.criticVerdict = criticRes.verdict;
          await writeJson(path.join(epBase, "critic_verdict.json"), { ...directorState.criticVerdict, attempt: directorState.criticAttempt, director_agent: true, retried: true, _evaluated_at: new Date().toISOString() });
          progress("plan-storyboard.critic_done", { episode_id: input.episodeId, coverage_score: directorState.criticVerdict.coverage_score, threshold: CRITIC_PASS_THRESHOLD });
          break;
        }
        case "finalize": {
          if (directorState.validated.length === 0) {
            progress("plan-storyboard.error", { episode_id: input.episodeId, reason: "Finalize 需要已有 shots" });
            break;
          }
          progress("plan-storyboard.finalize", { episode_id: input.episodeId, shot_count: directorState.validated.length });
          break;
        }
        case "generate_script":
        case "generate_first_frame":
        case "generate_video": {
          progress("plan-storyboard.skip", { episode_id: input.episodeId, tool, reason: "该工具不在 plan-storyboard 阶段可用" });
          break;
        }
        case "ask_user": {
          progress("plan-storyboard.ask_user", { episode_id: input.episodeId, question: params?.question, options: params?.options });
          break;
        }
      }
      return getManifest();
    };

    try {
      progress("plan-storyboard.director_start", {
        episode_id: input.episodeId,
        provider_id: actualProviderId,
      });

      const loopResult = await runDirectorLoop(getManifest, executeTool, {
        registry: getRegistry(),
        chain,
        getKeyFor,
        maxIterations: 15,
        beforeStep: (iteration: number) => {
          progress("plan-storyboard.director_call_start", {
            episode_id: input.episodeId,
            iteration,
            provider_id: actualProviderId,
          });
        },
        afterStep: (iteration: number, _decision, durationMs: number, success: boolean, error?: string) => {
          progress("plan-storyboard.director_call_end", {
            episode_id: input.episodeId,
            iteration,
            duration_ms: durationMs,
            success,
            error: error ?? null,
            provider_id: actualProviderId,
          });
        },
        onStep: (decision: DirectorDecision, iteration: number) => {
          progress("plan-storyboard.director_step", {
            episode_id: input.episodeId,
            iteration,
            action: decision.action,
            tool: decision.tool ?? null,
            reason: decision.reason,
            thinking: decision.thinking ?? null,
            provider_id: actualProviderId,
          });
        },
        // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(300_000).
      });

      let shotEntries: Array<{ shot_id: string; index: number }> = [];
      if (directorState.validated.length > 0) {
        shotEntries = await persistStoryboard(input.slug, input.episodeId, directorState.validated);
      }

      const totalDuration = directorState.validated.reduce((sum, s) => sum + Number(s.duration_sec), 0);

      progress("plan-storyboard.done", {
        episode_id: input.episodeId,
        shot_count: directorState.validated.length,
        total_duration_sec: totalDuration,
        coverage_score: directorState.criticVerdict?.coverage_score ?? 0,
        retried: directorState.retried,
        director_agent: true,
        director_iterations: loopResult.iterations,
        director_status: loopResult.status,
      });

      return {
        kind: "respondJson",
        body: {
          ok: true,
          episode_id: input.episodeId,
          shots: shotEntries,
          shot_count: directorState.validated.length,
          total_duration_sec: totalDuration,
          beat_sheet: directorState.beatSheet ? {
            hook_3s: directorState.beatSheet.hook_3s.beat_name,
            setup: directorState.beatSheet.setup.beat_name,
            inciting_incident: directorState.beatSheet.inciting_incident.beat_name,
            midpoint_twist: directorState.beatSheet.midpoint_twist.beat_name,
            climax: directorState.beatSheet.climax.beat_name,
            payoff: directorState.beatSheet.payoff.beat_name,
          } : null,
          critic: directorState.criticVerdict ? {
            coverage_score: directorState.criticVerdict.coverage_score,
            threshold: CRITIC_PASS_THRESHOLD,
            passed: directorState.criticVerdict.coverage_score >= CRITIC_PASS_THRESHOLD,
            retried: directorState.retried,
            missing_beats: directorState.criticVerdict.missing_beats.map(b => b.beat_name),
            drift_count: directorState.criticVerdict.drift_flags.length,
            overall_comment: directorState.criticVerdict.overall_comment,
          } : null,
          director_agent_used: true,
          director_status: loopResult.status,
          director_iterations: loopResult.iterations,
          director_decisions: loopResult.decisions.map(d => ({ action: d.action, tool: d.tool, reason: d.reason })),
          cost: totalCost,
        },
      };
    } catch (directorErr: unknown) {
      if (isRecoverableProviderFailure(directorErr)) {
        const fallbackReason = providerFailureSummary(directorErr);
        actualProviderId = "local_heuristic";
        const beatSheet = buildFallbackBeatSheet(scriptText, targetDuration);
        const validated = normalizeShotPlanShotTypes(buildFallbackShotPlan({
          scriptText,
          targetDurationSec: targetDuration,
          targetShotCount: episode.target_shot_count ?? 8,
          characters,
          scenes,
        }), "director_local_fallback");
        const criticVerdict = buildFallbackCriticVerdict(validated, targetDuration);
        await writeJson(path.join(epBase, "beat_sheet.json"), { ...beatSheet, _generated_at: new Date().toISOString(), _provider: actualProviderId, _fallback_reason: fallbackReason });
        await writeJson(path.join(epBase, "critic_verdict.json"), { ...criticVerdict, attempt: 0, director_agent: true, local_fallback: true, _evaluated_at: new Date().toISOString() });
        const shotEntries = await persistStoryboard(input.slug, input.episodeId, validated);
        const totalDuration = validated.reduce((sum, s) => sum + Number(s.duration_sec), 0);
        progress("plan-storyboard.local_fallback", {
          episode_id: input.episodeId,
          shot_count: validated.length,
          reason: fallbackReason.slice(0, 300),
        });
        return {
          kind: "respondJson",
          body: {
            ok: true,
            episode_id: input.episodeId,
            shots: shotEntries,
            shot_count: validated.length,
            total_duration_sec: totalDuration,
            beat_sheet: {
              hook_3s: beatSheet.hook_3s.beat_name,
              setup: beatSheet.setup.beat_name,
              inciting_incident: beatSheet.inciting_incident.beat_name,
              midpoint_twist: beatSheet.midpoint_twist.beat_name,
              climax: beatSheet.climax.beat_name,
              payoff: beatSheet.payoff.beat_name,
            },
            critic: {
              coverage_score: criticVerdict.coverage_score,
              threshold: CRITIC_PASS_THRESHOLD,
              passed: criticVerdict.coverage_score >= CRITIC_PASS_THRESHOLD,
              retried: false,
              missing_beats: [],
              drift_count: 0,
              overall_comment: criticVerdict.overall_comment,
            },
            director_agent_used: true,
            fallback: true,
            fallback_reason: fallbackReason,
            cost: totalCost,
          },
        };
      }
      throw directorErr;
    }
  }

  let beatSheet: z.infer<typeof BeatSheetResultSchema>;
  let validated: z.infer<typeof ShotPlanSchema>;
  let criticVerdict: z.infer<typeof CriticVerdictResultSchema>;
  let retried = false;
  let usedFallback = false;
  let fallbackReason: string | undefined;

  try {
    progress("plan-storyboard.step1_beat_sheet", { episode_id: input.episodeId });
    beatSheet = await generateBeatSheet();

    await writeJson(path.join(epBase, "beat_sheet.json"), { ...beatSheet, _generated_at: new Date().toISOString(), _provider: actualProviderId });

    progress("plan-storyboard.step1_done", { episode_id: input.episodeId, beat_names: [beatSheet.hook_3s.beat_name, beatSheet.setup.beat_name, beatSheet.inciting_incident.beat_name, beatSheet.midpoint_twist.beat_name, beatSheet.climax.beat_name, beatSheet.payoff.beat_name] });

    progress("plan-storyboard.step2_beat_to_scenes", { episode_id: input.episodeId });
    const scenesResult = await runBeatToScenes(beatSheet);
    addCost(scenesResult.cost);
    validated = scenesResult.validated;
    progress("plan-storyboard.step2_done", { episode_id: input.episodeId, shot_count: validated.length });

    progress("plan-storyboard.step3_critic", { episode_id: input.episodeId });

    const criticResult = await runCritic(beatSheet, validated);
    addCost(criticResult.cost);
    criticVerdict = criticResult.verdict;
    await writeJson(path.join(epBase, "critic_verdict.json"), { ...criticVerdict, attempt: 1, _evaluated_at: new Date().toISOString() });

    if (criticVerdict.coverage_score < CRITIC_PASS_THRESHOLD) {
      retried = true;
      progress("plan-storyboard.retry", { episode_id: input.episodeId, coverage_score: criticVerdict.coverage_score, threshold: CRITIC_PASS_THRESHOLD, reason: criticVerdict.overall_comment, missing_beats: criticVerdict.missing_beats.map(b => b.beat_name) });
      const retryCtx: Record<string, any> = {};
      if (criticVerdict.missing_beats.length > 0) {
        retryCtx.critic_feedback = `上一轮审查发现以下问题，请修正：\n${criticVerdict.missing_beats.map(b => `- ${b.beat_name}: ${b.reason}。建议: ${b.suggestion}`).join("\n")}${criticVerdict.drift_flags.length > 0 ? `\n主题漂移：\n${criticVerdict.drift_flags.map(d => `- ${d.shot_id}: ${d.reason}`).join("\n")}` : ""}`;
      }
      const retryResult = await runBeatToScenes(beatSheet, retryCtx);
      addCost(retryResult.cost);
      validated = retryResult.validated;
      const retryCritic = await runCritic(beatSheet, validated);
      addCost(retryCritic.cost);
      criticVerdict = retryCritic.verdict;
      await writeJson(path.join(epBase, "critic_verdict.json"), { ...criticVerdict, attempt: 2, retried: true, _evaluated_at: new Date().toISOString() });
    }
  } catch (err) {
    if (!isRecoverableProviderFailure(err)) throw err;
    usedFallback = true;
    fallbackReason = providerFailureSummary(err);
    actualProviderId = "local_heuristic";
    // 2026-05-27 — 写 FailureCenter, 用户能在 /cockpit/failures 看到失败并主动 retry.
    //   之前 fallback 路径只 ledger + progress 事件, FailureCenter 看不到 — 用户在
    //   失败列表找不到这条记录, 无法用 BatchRetryButton 重抽.
    appendFailure(input.slug, {
      code: "plan_storyboard_fallback",
      message: `分镜规划走启发式兜底: ${fallbackReason.slice(0, 300)}`,
      kind: "plan_storyboard",
    }).catch(() => {});
    beatSheet = buildFallbackBeatSheet(scriptText, targetDuration);
    validated = normalizeShotPlanShotTypes(buildFallbackShotPlan({
      scriptText,
      targetDurationSec: targetDuration,
      targetShotCount: episode.target_shot_count ?? 8,
      characters,
      scenes,
    }), "local_fallback");
    criticVerdict = buildFallbackCriticVerdict(validated, targetDuration);
    await writeJson(path.join(epBase, "beat_sheet.json"), { ...beatSheet, _generated_at: new Date().toISOString(), _provider: actualProviderId, _fallback_reason: fallbackReason });
    await writeJson(path.join(epBase, "critic_verdict.json"), { ...criticVerdict, attempt: 0, local_fallback: true, _evaluated_at: new Date().toISOString() });
    getLedger().record({
      at: new Date().toISOString(),
      series_slug: input.slug,
      job_id: `storyboard_${Date.now().toString(36)}`,
      task_id: `task_local_${Date.now().toString(36)}`,
      kind: "llm",
      provider_id: providerId,
      ok: false,
      params_digest: Date.now().toString(36),
      duration_ms: Date.now() - t0,
      error_code: err instanceof FallbackChainError ? "all_providers_failed" : err instanceof ProviderError ? err.code : "provider_failed",
    });
    progress("plan-storyboard.local_fallback", {
      episode_id: input.episodeId,
      shot_count: validated.length,
      reason: fallbackReason.slice(0, 300),
    });
  }

  const shotEntries = await persistStoryboard(input.slug, input.episodeId, validated);
  const totalDuration = validated.reduce((sum, s) => sum + Number(s.duration_sec), 0);

  progress("plan-storyboard.done", {
    episode_id: input.episodeId,
    shot_count: validated.length,
    total_duration_sec: totalDuration,
    coverage_score: criticVerdict.coverage_score,
    retried,
  });

  return {
    kind: "respondJson",
    body: {
      ok: true,
      episode_id: input.episodeId,
      shots: shotEntries,
      shot_count: validated.length,
      total_duration_sec: totalDuration,
      beat_sheet: {
        hook_3s: beatSheet.hook_3s.beat_name,
        setup: beatSheet.setup.beat_name,
        inciting_incident: beatSheet.inciting_incident.beat_name,
        midpoint_twist: beatSheet.midpoint_twist.beat_name,
        climax: beatSheet.climax.beat_name,
        payoff: beatSheet.payoff.beat_name,
      },
      critic: {
        coverage_score: criticVerdict.coverage_score,
        threshold: CRITIC_PASS_THRESHOLD,
        passed: criticVerdict.coverage_score >= CRITIC_PASS_THRESHOLD,
        retried,
        missing_beats: criticVerdict.missing_beats.map(b => b.beat_name),
        drift_count: criticVerdict.drift_flags.length,
        overall_comment: criticVerdict.overall_comment,
      },
      fallback: usedFallback,
      fallback_reason: fallbackReason,
      cost: totalCost,
    },
  };
}
