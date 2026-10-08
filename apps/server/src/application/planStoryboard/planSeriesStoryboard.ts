import path from "node:path";
import { isSupportingElement } from "../../../../../packages/drama/src/elementKinds";
import fs from "node:fs/promises";
import { z } from "zod";

import {
  readSeries,
  createEpisode,
  updateEpisode,
  listEpisodes,
  listCharacters,
  listScenes,
  createCharacter,
  createScene,
  trashEpisodeShotFiles,
  type ShotData,
  type EpisodeData,
} from "../../api/v2/seriesStore";
import { validate, PlanStoryboardSchema } from "../../api/v2/validators";
import { sseBroker } from "../../api/v2/sseBroker";
// 2026-05-21 U-1: 系列级 image_overrides 解析 — 加载 element 列表 + 共享解析函数
import { listElements } from "../../repositories/elementRepo";
import { resolveReferenceOverrides, formatImagesHint } from "./_shared";
import { plainTextToNodes, nodesToPlainText } from "../../../../../packages/drama/src/shotText";
import { getRegistry, getLedger, resolveLlmProviderId } from "../../api/v2/orchestration/_shared/registry";
import { episodeBase, seriesBase, savePromptSnapshot, saveSeriesPromptSnapshot } from "../../api/v2/orchestration/_shared/paths";
import { passThroughSignal, parseJsonFromLlm, providerFailureSummary } from "../../api/v2/orchestration/_shared/llmJson";
import { cleanShotPrompt, extractSpeakerNames } from "../../api/v2/orchestration/_shared/scriptText";
import {
  buildFallbackShotPlan,
  buildFallbackEpisodePlans,
} from "../../api/v2/orchestration/_shared/fallbacks";
import {
  SeriesEpisodePlanSchema,
  ShotPlanSchema,
} from "../../api/v2/orchestration/_shared/schemas";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";

import { ensureDir, writeJson } from "../../../../../packages/core/src/index";
import { loggerSync, logProviderCall } from "../../../../../packages/core/src/logger";
import { getKeyFor, getConfigValue } from "../../../../../packages/core/src/localSettings";
import { tryWithFallback, resolveChain } from "../../../../../packages/providers/src/core/queue";
import type { ProviderContext } from "../../../../../packages/providers/src/core/types";
import { providerIdFromModelRef } from "../generation/modelRef";
// 2026-05-21 X-2: 系列级分镜也暴露已有图清单给 LLM (与 planEpisodeStoryboard 同款)
import { formatCharacterForLlmContext } from "../../../../../packages/drama/src/characterPrompt";

type SeriesEpisodePlan = z.infer<typeof SeriesEpisodePlanSchema>["episodes"][number];

export type PlanSeriesStoryboardResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "respondError"; status: number; body: Record<string, unknown> }
  | { kind: "respondJson"; body: Record<string, unknown> };

export interface PlanSeriesStoryboardInput {
  slug: string;
  body: unknown;
  /** 2026-05-20 P1 铁律 #1: caller 透传 req.signal — 客户端断开能真 abort LLM. */
  signal?: AbortSignal;
}

export interface PlanSeriesStoryboardDeps {
  progress: ProgressSink;
  requestId?: string;
}

async function persistShotPlanForEpisode(
  slug: string,
  epId: string,
  shots: z.infer<typeof ShotPlanSchema>,
  /** 2026-05-21 U-1: 可选 name→id 映射, 解析 LLM image_overrides 用 */
  nameMaps?: {
    elementNameToId: Map<string, string>;
    characterNameToId: Map<string, string>;
    sceneNameToId: Map<string, string>;
  },
  /**
   * 2026-05-21 auto-annotate — entity name 集合, 给 action/dialogue/voiceover/prompt_*
   * 文本里出现的 entity name 自动加 @ prefix (LLM 经常输出纯中文, 这里 fallback annotate).
   */
  annotateCtx?: {
    characters: ReadonlyArray<{ name: string; id?: string }>;
    scenes: ReadonlyArray<{ name: string; id?: string }>;
    elements: ReadonlyArray<{ name: string; id?: string }>;
  },
): Promise<Array<{ shot_id: string; index: number }>> {
  const epBase = episodeBase(slug, epId);
  const shotsPath = path.join(epBase, "shots");
  await ensureDir(shotsPath);

  // 2026-07-10 Fable P0-1 — 重拆前把旧 shot 文件"整批移入垃圾桶"(不再 fs.rm 硬删): 保住用户
  // 挑选劳动(picked/trim/帧锚点/命名/generation↔asset), listShots 仍不返回旧镜(已挪出 shots/ 目录)
  // 继续防幽灵镜重复扣费. 兼容 plan 的 s0001.json 与 import 的 s0001_xxxx.json 跨路径残留.
  await trashEpisodeShotFiles(slug, epId);

  const shotEntries: Array<{ shot_id: string; index: number }> = [];
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const shotId = `s${String(i + 1).padStart(4, "0")}`;
    const now = new Date().toISOString();
    const promptImg = cleanShotPrompt(shot.prompt_img) ||
      cleanShotPrompt(`${shot.visual_focus || ""} ${shot.action || ""} ${shot.mood || ""}`);
    const promptVid = cleanShotPrompt(shot.prompt_vid) ||
      cleanShotPrompt(`${shot.visual_focus || ""} ${shot.action || ""} ${shot.camera_movement || ""}`);

    // 2026-05-21 U-1: 解析 LLM image_overrides → shot.reference_overrides
    const referenceOverrides = nameMaps
      ? resolveReferenceOverrides(shot, nameMaps)
      : [];

    // 2026-05-21 Wave Y — 富文本节点: parse 一次 → 落 nodes + derive plain text
    const ctxOrEmpty = annotateCtx ?? { characters: [], scenes: [], elements: [] };
    const actionNodes = plainTextToNodes(shot.action || "", ctxOrEmpty);
    const dialogueNodes = plainTextToNodes(shot.dialogue || "", ctxOrEmpty);
    const voiceoverNodes = plainTextToNodes(shot.voiceover || "", ctxOrEmpty);
    const promptImgNodes = plainTextToNodes(promptImg, ctxOrEmpty);
    const promptVidNodes = plainTextToNodes(promptVid, ctxOrEmpty);

    const shotData: ShotData = {
      id: shotId,
      series_slug: slug,
      episode_id: epId,
      index: i + 1,
      // 2026-07-09 audit 补漏(终验) — 负/NaN duration 防护(同 persistStoryboard): 负数 truthy 会穿透 ||5.
      duration_sec: (() => { const d = Number(shot.duration_sec); return Number.isFinite(d) && d > 0 ? Math.min(d, 120) : 5; })(),
      character_ids: shot.characters || [],
      scene_id: typeof shot.scene_id === "number" ? `scn_${shot.scene_id}` : String(shot.scene_id),
      element_ids: [],
      reference_overrides: referenceOverrides.length > 0 ? referenceOverrides : undefined,
      shot_type: shot.shot_type,
      camera_movement: shot.camera_movement,
      action_nodes: actionNodes,
      dialogue_nodes: dialogueNodes,
      voiceover_nodes: voiceoverNodes,
      prompt_img_nodes: promptImgNodes,
      prompt_vid_nodes: promptVidNodes,
      action: nodesToPlainText(actionNodes),
      dialogue: nodesToPlainText(dialogueNodes),
      voiceover: nodesToPlainText(voiceoverNodes),
      prompt_img: nodesToPlainText(promptImgNodes),
      prompt_vid: nodesToPlainText(promptVidNodes),
      prompt_img_versions: [{ version: 1, content: nodesToPlainText(promptImgNodes), created_at: now, created_by: "ai" }],
      prompt_vid_versions: [{ version: 1, content: nodesToPlainText(promptVidNodes), created_at: now, created_by: "ai" }],
      status: "drafted",
      generations: [],
      active_generations: [],
      trashed_generations: [],
    };
    await writeJson(path.join(shotsPath, `${shotId}.json`), shotData);
    shotEntries.push({ shot_id: shotId, index: i + 1 });
  }

  await writeJson(path.join(epBase, "storyboard.json"), {
    episode_id: epId,
    series_slug: slug,
    shots: shotEntries,
    updated_at: new Date().toISOString(),
  });
  await updateEpisode(slug, epId, {
    storyboard_path: `episodes/${epId}/storyboard.json`,
    status: "storyboarded",
  });
  return shotEntries;
}

export async function planSeriesStoryboard(
  input: PlanSeriesStoryboardInput,
  deps: PlanSeriesStoryboardDeps,
): Promise<PlanSeriesStoryboardResult> {
  const t0 = Date.now();
  const bodyValidated = validate(PlanStoryboardSchema, input.body);
  if (!bodyValidated.ok) {
    return { kind: "validation", status: bodyValidated.status, errors: bodyValidated.errors };
  }

  const slug = input.slug;
  const series = await readSeries(slug);
  if (!series) {
    return { kind: "respondError", status: 404, body: { error: { code: "NotFound", message: "系列不存在" } } };
  }

  let scriptText = series.script_md || "";
  if (!scriptText && series.script_path) {
    try {
      scriptText = await fs.readFile(path.join(seriesBase(slug), series.script_path), "utf8");
    } catch { /* fall through to episode fallback */ }
  }

  const existingEpisodes = await listEpisodes(slug);
  if (!scriptText) {
    const fallbackEpisode = existingEpisodes.find((ep) => Boolean(ep.script_md));
    scriptText = fallbackEpisode?.script_md || "";
  }

  if (!scriptText.trim()) {
    return {
      kind: "respondError",
      status: 400,
      body: {
        error: { code: "MissingScript", message: "请先从灵感生成系列剧本，或在剧本页填写内容后再生成分集与分镜" },
      },
    };
  }

  const providerId = providerIdFromModelRef(bodyValidated.data.overrides?.llm_provider_id)
    || resolveLlmProviderId(series.defaults as Record<string, any>);
  const chain = resolveChain(
    providerId,
    getRegistry().listAvailable("llm").map(p => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );
  let actualProviderId = providerId;
  const totalCost = { input_tokens: 0, output_tokens: 0, estimated_cny: 0 };
  const addCost = (cost: any) => {
    if (!cost) return;
    totalCost.input_tokens += cost.input_tokens ?? 0;
    totalCost.output_tokens += cost.output_tokens ?? 0;
    totalCost.estimated_cny += cost.estimated_cny ?? 0;
  };
  const providerCtx: ProviderContext = {
    series_slug: slug,
    job_id: `series_storyboard_${Date.now().toString(36)}`,
    task_id: `task_series_${Date.now().toString(36)}`,
    log: () => {},
    // 2026-05-20 P1 铁律 #1: 透传 caller signal
    signal: passThroughSignal(input.signal),
  };

  // 2026-05-26 Codex P1-3 — series.defaults 真存到字段名是 episodes_target (validators.ts 5 字段保存),
  // 之前只读 episode_count 永远 undefined → LLM 拿到 "由内容自然决定" 自己决定要几集 → 用户填 2 集没用.
  // body 走 episode_count (旧 schema 兼容), defaults 走 episodes_target (新 schema 真理源).
  const bodyRec = (input.body && typeof input.body === "object") ? input.body as Record<string, unknown> : {};
  const defaultsRec = series.defaults as unknown as Record<string, unknown>;
  const requestedEpisodeCount =
    Number(
      bodyRec.episode_count
        ?? defaultsRec.episodes_target
        ?? defaultsRec.episode_count,
    ) || undefined;
  // 同理: duration target 优先 body, 再读 series.defaults.duration_target_sec
  const requestedDurationSec =
    Number(
      bodyRec.duration_per_episode_sec
        ?? defaultsRec.duration_target_sec,
    ) || undefined;
  let episodePlans: SeriesEpisodePlan[] = [];
  let fallback = false;
  let fallbackReason: string | undefined;

  deps.progress.progress("plan-storyboard.series_episodes", { series_slug: slug, provider_id: actualProviderId });
  try {
    const ctx: Record<string, any> = {
      series_title: series.title,
      series_synopsis: series.synopsis,
      content_type: series.defaults.content_type || "短视频",
      platform: series.defaults.platform || "bilibili",
      requested_episode_count: requestedEpisodeCount ?? "由内容自然决定",
      requested_duration_per_episode_sec: requestedDurationSec ?? "由内容自然决定",
      script_text: scriptText,
      user_note: bodyValidated.data.user_note || "",
    };
    // 2026-05-26 Codex P1-3 — prompt 加硬约束行, 让 LLM 看到用户填的"集数 / 单集时长", 不能自由发挥.
    const constraintLines: string[] = [];
    if (requestedEpisodeCount) {
      constraintLines.push(`【硬约束】用户已选定要拆 ${requestedEpisodeCount} 集 — 必须输出恰好 ${requestedEpisodeCount} 集,多一集少一集都不可.`);
    }
    if (requestedDurationSec) {
      constraintLines.push(`【硬约束】每集目标时长 ${requestedDurationSec} 秒 — 每集 target_duration_sec 必须等于 ${requestedDurationSec}.`);
    }
    const promptText = [
      "请把下面的系列剧本拆成适合短视频制作的分集。",
      ...constraintLines,
      "只返回合法 JSON，不要 Markdown。格式:",
      `{"episodes":[{"title":"第 1 集","synopsis":"本集摘要","script_md":"本集完整剧本","target_duration_sec":${requestedDurationSec ?? 60},"target_shot_count":8}]}`,
      "",
      JSON.stringify(ctx, null, 2),
    ].join("\n");
    const snapshotName = await saveSeriesPromptSnapshot(slug, "episode_breakdown", promptText, ctx);
    const startMs = Date.now();
    const result = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
      prompt: promptText,
      system: "你是一位短剧/短视频制片统筹。你负责把系列剧本拆成分集，每集必须能独立进入分镜制作。只返回 JSON。",
      response_format: "json",
      max_tokens: 8192,
    }, providerCtx, (evt) => {
      actualProviderId = evt.to;
      sseBroker.broadcast("provider.fallback", { from: evt.from, to: evt.to, reason: evt.reason });
    });
    addCost(result.cost);
    logProviderCall({
      requestId: deps.requestId,
      providerId: actualProviderId || chain[0] || "llm",
      kind: "llm",
      durationMs: Date.now() - startMs,
      success: true,
      meta: { purpose: "episode_breakdown", prompt_snapshot: snapshotName },
    }).catch((e) => { console.warn("[orch] logProviderCall failed:", (e as Error)?.message ?? e); });
    const raw = parseJsonFromLlm(result.text);
    episodePlans = SeriesEpisodePlanSchema.parse(Array.isArray(raw) ? { episodes: raw } : raw).episodes;
  } catch (err) {
    fallback = true;
    fallbackReason = providerFailureSummary(err);
    actualProviderId = "local_heuristic";
    episodePlans = buildFallbackEpisodePlans(series, scriptText, requestedEpisodeCount);
    loggerSync().warn("[plan-storyboard] episode breakdown fallback:", fallbackReason);
  }

  let characters = await listCharacters(slug);
  let scenes = await listScenes(slug);

  // 2026-05-26 walkthrough fix (铁律 #9 toC 兜底): LLM 失败 fallback 时, 如果还没建任何
  // character/scene entity, 用启发式从剧本抽真名建实体 (而不是用 char_fallback_1 / scn_fallback_1
  // 这种技术 id 暴露 toC). entity-first 一致性也需要分镜引用真 entity id, 后续抽图才能拿到角色描述.
  if (fallback && characters.length === 0) {
    const speakers = extractSpeakerNames(scriptText);
    const namesToCreate = speakers.length > 0 ? speakers.slice(0, 6) : ["主角"];
    for (let i = 0; i < namesToCreate.length; i++) {
      const name = namesToCreate[i];
      try {
        await createCharacter(slug, {
          name,
          role: i === 0 ? "protagonist" : "supporting",
          personality: "从剧本中自动识别 (LLM 不可用时启发式抽取). 请补充性格描述.",
          appearance: "请补充外貌描述以提升首帧一致性.",
          is_placeholder: true,
        });
      } catch (e) { loggerSync().warn(`[plan-storyboard] auto-create character "${name}" failed:`, e); }
    }
    characters = await listCharacters(slug);
  }
  if (fallback && scenes.length === 0) {
    // 给个默认场景 (用户后续可改). 抽不出场景名时用 "默认场景".
    try {
      await createScene(slug, {
        name: "默认场景",
        description: "从剧本中自动识别 (LLM 不可用时启发式占位). 请补充地点/氛围描述.",
        is_placeholder: true,
      });
    } catch (e) { loggerSync().warn(`[plan-storyboard] auto-create default scene failed:`, e); }
    scenes = await listScenes(slug);
  }

  // 2026-05-21 U-1: 加载 element 列表 + 构建 name→id 映射, 供 persistShotPlanForEpisode
  // 解析 LLM image_overrides 用 (与 planEpisodeStoryboard 同款逻辑)
  const allElements = await listElements(slug).catch(() => [] as Awaited<ReturnType<typeof listElements>>);
  const elementsList = allElements.filter(isSupportingElement);
  const elementNameToId = new Map<string, string>();
  for (const el of elementsList) {
    elementNameToId.set(el.name, el.id);
    elementNameToId.set(el.name.toLowerCase().trim(), el.id);
  }
  const characterNameToId = new Map<string, string>();
  for (const c of characters) {
    characterNameToId.set(c.name, c.id);
    characterNameToId.set(c.name.toLowerCase().trim(), c.id);
    characterNameToId.set(c.id, c.id);
    characterNameToId.set(c.id.toLowerCase().trim(), c.id);
  }
  const sceneNameToId = new Map<string, string>();
  for (const sc of scenes) {
    sceneNameToId.set(sc.name, sc.id);
    sceneNameToId.set(sc.name.toLowerCase().trim(), sc.id);
    sceneNameToId.set(sc.id, sc.id);
    sceneNameToId.set(sc.id.toLowerCase().trim(), sc.id);
  }
  const storyboardNameMaps = { elementNameToId, characterNameToId, sceneNameToId };

  const refreshedEpisodes = await listEpisodes(slug);
  const outputs: Array<{
    episode_id: string;
    title: string;
    shot_count: number;
    storyboard_path: string;
    fallback?: boolean;
  }> = [];

  for (let index = 0; index < episodePlans.length; index++) {
    const plan = episodePlans[index];
    let episode: EpisodeData | undefined = refreshedEpisodes[index];
    if (!episode) {
      episode = await createEpisode(slug, { title: plan.title, index: index + 1 });
    }

    const epId = episode.id;
    const episodeScript = plan.script_md.trim();
    await ensureDir(episodeBase(slug, epId));
    await fs.writeFile(path.join(episodeBase(slug, epId), "script.md"), episodeScript, "utf8");
    await updateEpisode(slug, epId, {
      title: plan.title,
      synopsis: plan.synopsis,
      script_path: `episodes/${epId}/script.md`,
      script_md: episodeScript,
      target_duration_sec: plan.target_duration_sec,
      target_shot_count: plan.target_shot_count,
      status: "scripted",
    });

    deps.progress.progress("plan-storyboard.series_episode", {
      series_slug: slug,
      episode_id: epId,
      episode_index: index + 1,
      episode_count: episodePlans.length,
    });

    let shots: z.infer<typeof ShotPlanSchema>;
    let episodeUsedFallback = fallback;
    try {
      // 2026-05-21 X-2 V-37: 系列级分镜也暴露已有图清单给 LLM (镜像 planEpisodeStoryboard)
      const propsAndMisc = elementsList;
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

      const storyboardCtx = {
        series_title: series.title,
        episode_title: plan.title,
        episode_synopsis: plan.synopsis,
        target_duration_sec: plan.target_duration_sec,
        target_shot_count: plan.target_shot_count,
        aspect_ratio: series.defaults.aspect_ratio || "16:9",
        visual_style: series.defaults.visual_style || "cinematic",
        tone: series.defaults.tone || "清晰",
        character_list: characterList,
        scene_list: sceneList,
        props_context: propsContext,
        script_text: episodeScript,
      };
      const promptText = [
        "请把这一集剧本拆成分镜。只返回合法 JSON 数组，不要 Markdown。",
        "每个元素字段: shot_id, shot_type, scene_id, characters, action, dialogue, voiceover, camera_movement, camera_angle, transition, visual_focus, mood, notes, duration_sec, prompt_img, prompt_vid。",
        JSON.stringify(storyboardCtx, null, 2),
      ].join("\n");
      await savePromptSnapshot(slug, epId, "series_storyboard_director", promptText, storyboardCtx);
      const startMs = Date.now();
      const result = await tryWithFallback(chain, (id) => getRegistry().getLlm(id), {
        prompt: promptText,
        system: "你是一位资深分镜导演。严格基于剧本拆镜，镜头数量贴近 target_shot_count。只返回 JSON 数组。",
        response_format: "json",
        max_tokens: 8192,
      }, { ...providerCtx, task_id: `task_storyboard_${epId}_${Date.now().toString(36)}` }, (evt) => {
        actualProviderId = evt.to;
        sseBroker.broadcast("provider.fallback", { from: evt.from, to: evt.to, reason: evt.reason });
      });
      addCost(result.cost);
      logProviderCall({
        requestId: deps.requestId,
        providerId: actualProviderId || chain[0] || "llm",
        kind: "llm",
        durationMs: Date.now() - startMs,
        success: true,
        meta: { purpose: "series_storyboard_director", episode_id: epId },
      }).catch((e) => { console.warn("[orch] logProviderCall failed:", (e as Error)?.message ?? e); });
      let raw: unknown = parseJsonFromLlm(result.text);
      if (!Array.isArray(raw) && raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
          if (Array.isArray(obj[key])) {
            raw = obj[key];
            break;
          }
        }
      }
      shots = ShotPlanSchema.parse(raw);
    } catch (err) {
      episodeUsedFallback = true;
      const reason = providerFailureSummary(err);
      loggerSync().warn(`[plan-storyboard] episode ${epId} storyboard fallback:`, reason);
      shots = buildFallbackShotPlan({
        scriptText: episodeScript,
        targetDurationSec: plan.target_duration_sec,
        targetShotCount: plan.target_shot_count,
        characters,
        scenes,
      });
    }

    const shotEntries = await persistShotPlanForEpisode(slug, epId, shots, storyboardNameMaps, {
      characters: characters.map((c) => ({ name: c.name, id: c.id })),
      scenes: scenes.map((s) => ({ name: s.name, id: s.id })),
      elements: elementsList.map((el) => ({ name: el.name, id: el.id })),
    });
    outputs.push({
      episode_id: epId,
      title: plan.title,
      shot_count: shotEntries.length,
      storyboard_path: `episodes/${epId}/storyboard.json`,
      fallback: episodeUsedFallback,
    });
  }

  getLedger().record({
    at: new Date().toISOString(),
    series_slug: slug,
    job_id: providerCtx.job_id,
    task_id: providerCtx.task_id,
    kind: "llm",
    provider_id: actualProviderId,
    ok: !fallback,
    params_digest: Date.now().toString(36),
    cost: { currency: "CNY", amount: totalCost.estimated_cny, basis: "estimated" },
    duration_ms: Date.now() - t0,
    error_code: fallback ? "local_fallback_used" : undefined,
  });

  // 2026-07-10 Fable P0-1 边界 case③ — 新计划集数比原来少时, 多出来的旧集按下标不被覆盖(原样残留).
  // 这些旧集的分镜/产出都还在, 但已不在本次计划里 — 如实告知用户, 让他自己决定是否去删除多余旧集.
  const leftoverEpisodeCount = Math.max(0, refreshedEpisodes.length - episodePlans.length);

  deps.progress.progress("plan-storyboard.series_done", {
    series_slug: slug,
    episode_count: outputs.length,
    shot_count: outputs.reduce((sum, ep) => sum + ep.shot_count, 0),
  });

  return {
    kind: "respondJson",
    body: {
      ok: true,
      series_slug: slug,
      episode_count: outputs.length,
      episodes: outputs,
      leftover_episode_count: leftoverEpisodeCount,
      fallback,
      fallback_reason: fallbackReason,
      cost: totalCost,
    },
  };
}
