/**
 * batchSeries.ts — 一站式批量生成短剧系列 (2026-05-19 反馈 #9 + 多剧扩展).
 *
 * 用户原话 (2026-05-19 后续):
 * > "批量生成项目里的参数为什么没有项目数?我可以同时要求生成多部不同的剧、
 * >  每剧不同的集数,想想怎么管理和添加上"
 *
 * 核心契约 (v2 — multi-project):
 *   - **多项目模式**: 同时生成 N 部不同的剧, 每部独立集数 / 灵感 / 参数
 *   - **全局默认参数**: 项目层没填的继承全局 (画面比例 / 平台 / 风格 / 时长)
 *   - **零必填**: 所有参数全部可选 — LLM 自己脑补缺省值
 *   - **向后兼容**: 旧 single-project body (不带 projects 字段) 仍能正常工作
 *   - 一次 LLM 调用产出 N 部 series + 每部的 episodes + shots + characters/scenes
 *   - 落盘: 循环 N 次 createSeries + createEpisode + ScriptVersion + StoryboardVersion
 *   - 同步暴露 composeBatchPrompt 给前端 "复制完整提示词" 按钮 (零成本)
 *   - 错误兜底: LLM 失败 → 透明返回 fallback chain error, 不静默创建空 series
 *
 * 路由挂载点:
 *   - POST /api/v2/series/batch-generate          → batchGenerateSeries()
 *   - POST /api/v2/series/batch-generate/preview-prompt → composeBatchPrompt() (不调 LLM)
 *
 * Wave Z-6: prompt composers → batchPromptComposer.ts, persist → persistSeries.ts
 */

import { z } from "zod";

// ─── Re-export moved modules for backward compat ────────────────────
export {
  composeBatchPrompt,
  composeBatchPromptOnly,
  composeBatchPromptMulti,
  composeBatchPromptMultiOnly,
  mergeProjectParams,
} from "./batchPromptComposer";
export { persistOneSeriesFromEnvelope } from "./persistSeries";

// ─── Internal imports for batch generator entry points ──────────────
import {
  composeBatchPrompt,
  composeBatchPromptMulti,
  mergeProjectParams,
} from "./batchPromptComposer";
import { persistOneSeriesFromEnvelope } from "./persistSeries";

import {
  getRegistry,
  getLedger,
  resolveLlmProviderId,
} from "../../api/v2/orchestration/_shared/registry";
import {
  passThroughSignal,
  parseJsonFromLlm,
} from "../../api/v2/orchestration/_shared/llmJson";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { getKeyFor, getConfigValue } from "../../../../../packages/core/src/localSettings";
import {
  tryWithFallback,
  resolveChain,
  FallbackChainError,
} from "../../../../../packages/providers/src/core/queue";
import type { ProviderContext } from "../../../../../packages/providers/src/core/types";
import { providerIdFromModelRef } from "../generation/modelRef";
import { sseBroker } from "../../api/v2/sseBroker";

// ─── Input contract ────────────────────────────────────────────────

const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "21:9"] as const;
const PLATFORMS = ["bilibili", "douyin", "xhs", "youtube", "wechat_channels"] as const;

export const BatchGenerateInputSchema = z.object({
  // 全部可选 — toC 用户不想填就不填, LLM 自己补
  inspiration: z.string().max(5000).optional(),
  episode_count: z.number().int().min(1).max(20).optional(),
  duration_per_episode_sec: z.number().int().min(5).max(600).optional(),
  aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
  style: z.string().max(200).optional(),
  platform: z.enum(PLATFORMS).optional(),
  model_ref: z.string().max(200).optional(),
  series_title: z.string().max(200).optional(),
});

export type BatchGenerateInput = z.infer<typeof BatchGenerateInputSchema>;

// ─── Multi-project schema (2026-05-19 后续: 同时生成 N 部不同的剧) ────

/** 单个项目的参数 (沿用旧 BatchGenerateInputSchema 字段, 全部 optional) */
export const BatchProjectSchema = z.object({
  series_title: z.string().max(200).optional(),
  inspiration: z.string().max(5000).optional(),
  episode_count: z.number().int().min(1).max(20).optional(),
  duration_per_episode_sec: z.number().int().min(5).max(600).optional(),
  aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
  style: z.string().max(200).optional(),
  platform: z.enum(PLATFORMS).optional(),
});

export type BatchProjectInput = z.infer<typeof BatchProjectSchema>;

/** 全局默认参数 — 项目层没填的继承全局 (同 BatchProjectSchema 但语义上是 fallback) */
export const BatchGlobalDefaultsSchema = BatchProjectSchema;

/** 多项目模式 — 用户原话"同时生成多部不同的剧" */
export const BatchGenerateMultiInputSchema = z.object({
  /** 项目数组 (≥1, ≤10) */
  projects: z.array(BatchProjectSchema).min(1).max(10),
  /** 全局默认参数 — 项目层没填的继承全局 */
  global: BatchGlobalDefaultsSchema.optional(),
  /** 全局灵感总指示, 适用所有项目 (各项目自己的 inspiration 优先) */
  global_inspiration: z.string().max(5000).optional(),
  /** LLM 模型选择 (全局, 同一次调用) */
  model_ref: z.string().max(200).optional(),
});

export type BatchGenerateMultiInput = z.infer<typeof BatchGenerateMultiInputSchema>;

/**
 * Type guard: detect whether request body is multi-project mode.
 * 关键策略: 看 body 里有没有 `projects` 数组字段 → 走多项目分支
 */
function isMultiProjectInput(input: unknown): input is BatchGenerateMultiInput {
  return (
    typeof input === "object" &&
    input !== null &&
    Array.isArray((input as { projects?: unknown }).projects)
  );
}

// ─── LLM 输出 schema (与 prompt 模板字段必须对齐) ────────────────────
//
// 2026-05-22 — LLM (ChatGPT / Claude / Gemini) 经常把空字段输出为 null 而不是省略,
// zod `.optional()` 等价 `T | undefined`, 不接受 null → "JSON 格式不符合预期" 误判.
// 修法: helper 接受 null/undefined, 用 transform 统一吸收成 undefined, 下游 type 不破.
// (用户原话: "一键生成界面解析通过右上角还是报错")

// helper: `.nullable().optional().transform(v => v ?? undefined)` —
// schema 接受 null/undefined/省略, 业务 type 保持 T | undefined 不破下游.
const nullishStr = (max: number) =>
  z.string().max(max).nullable().optional().transform((v) => v ?? undefined);

const nullishNum = (min: number, max: number) =>
  z.number().min(min).max(max).nullable().optional().transform((v) => v ?? undefined);

const nullishStrArr = (innerMax: number, listMax: number) =>
  z.array(z.string().max(innerMax)).max(listMax).nullable().optional().transform((v) => v ?? undefined);

function nullishObjArr<T extends z.ZodTypeAny>(item: T, listMax: number) {
  return z.array(item).max(listMax).nullable().optional().transform((v) => v ?? undefined);
}

const BatchShotSchema = z.object({
  index: z.number().int().min(1).max(9999),
  action: z.string().min(1).max(2000),
  shot_type: nullishStr(50),
  camera_movement: nullishStr(50),
  duration_sec: nullishNum(1, 120),
  dialogue: nullishStr(2000),
  voiceover: nullishStr(2000),
  character_refs: nullishStrArr(100, 20),
  scene_ref: nullishStr(100),
  // 2026-05-19 优化 2: 通用素材引用 (prop/wardrobe/reference/misc).
  element_refs: nullishStrArr(100, 20),
  // 2026-05-21 U-1: image_overrides
  image_overrides: nullishObjArr(z.object({
    element_id: z.string().min(1).max(100),
    image_id: z.string().min(1).max(200),
    reason: nullishStr(500),
  }), 50),
});

const BatchEpisodeSchema = z.object({
  title: z.string().min(1).max(200),
  synopsis: nullishStr(2000),
  script_md: nullishStr(20000),
  shots: z.array(BatchShotSchema).min(1).max(100),
});

const BatchImageBriefSchema = z.object({
  angle: z.string().min(1).max(100),
  description: z.string().min(1).max(800),
});

const BatchCharacterSchema = z.object({
  name: z.string().min(1).max(100),
  role: nullishStr(100),
  appearance: nullishStr(1000),
  outfit: nullishStr(500),
  personality: nullishStr(500),
  image_briefs: nullishObjArr(BatchImageBriefSchema, 8),
});

const BatchSceneSchema = z.object({
  name: z.string().min(1).max(100),
  location: nullishStr(500),
  mood: nullishStr(200),
  visual_style: nullishStr(500),
  image_briefs: nullishObjArr(BatchImageBriefSchema, 8),
});

export const BatchSeriesEnvelopeSchema = z.object({
  series: z.object({
    title: z.string().min(1).max(200),
    synopsis: nullishStr(2000),
    style_notes: nullishStr(1000),
    characters: nullishObjArr(BatchCharacterSchema, 30),
    scenes: nullishObjArr(BatchSceneSchema, 30),
    /**
     * 2026-05-22 — 让 LLM 在 envelope.series 里输出剧画面比例,
     * 用户原话: "这部剧的比例是什么, 视频、图片缩略图的比例就是什么".
     * 之前 schema 没此字段, LLM 输出也不被接受 → persistSeries fallback 16:9.
     * 现在 prompt 让 LLM 输出短剧默认 9:16, import 路径透传到 series.defaults.
     */
    aspect_ratio: z.enum(ASPECT_RATIOS).nullable().optional().transform((v) => v ?? undefined),
    platform: z.enum(PLATFORMS).nullable().optional().transform((v) => v ?? undefined),
  }),
  episodes: z.array(BatchEpisodeSchema).min(1).max(20),
});

export type BatchEnvelope = z.infer<typeof BatchSeriesEnvelopeSchema>;

/** 多项目 envelope — LLM 一次输出 N 部剧. */
export const BatchMultiEnvelopeSchema = z.object({
  projects: z.array(BatchSeriesEnvelopeSchema).min(1).max(10),
});

export type BatchMultiEnvelope = z.infer<typeof BatchMultiEnvelopeSchema>;

// ─── Result types ──────────────────────────────────────────────────

export interface BatchSeriesOk {
  ok: true;
  series_slug: string;
  series_title: string;
  episodes_created: number;
  total_shots: number;
  characters_created: number;
  scenes_created: number;
  pending_image_briefs: number;
  script_version_id?: string;
  storyboard_version_ids: string[];
  prompt_snapshot: string;
  prompt_used: string;
  raw_llm_output: string;
  duration_ms: number;
}

export type BatchSeriesResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "ok"; body: BatchSeriesOk }
  | { kind: "ok-multi"; body: BatchSeriesMultiOk };

/** 多项目模式的成功响应 — 一次返 N 部剧的汇总 */
export interface BatchSeriesMultiOk {
  ok: true;
  mode: "multi";
  projects_created: number;
  series: Array<{
    series_slug: string;
    series_title: string;
    episodes_created: number;
    total_shots: number;
    characters_created: number;
    scenes_created: number;
    pending_image_briefs: number;
    script_version_id?: string;
    storyboard_version_ids: string[];
  }>;
  total_episodes: number;
  total_shots: number;
  total_characters: number;
  total_scenes: number;
  total_pending_image_briefs: number;
  series_slugs: string[];
  prompt_used: string;
  raw_llm_output: string;
  duration_ms: number;
}

// ─── Main entry ────────────────────────────────────────────────────

export interface BatchSeriesDeps {
  requestId?: string;
}

/**
 * Top-level dispatcher. 根据 body 形态走 single / multi 分支.
 *   - body.projects 数组 → 多项目模式
 *   - 否则 → 旧 single-project 兼容
 */
export async function batchGenerateSeries(
  input: unknown,
  deps: BatchSeriesDeps = {},
): Promise<BatchSeriesResult> {
  if (isMultiProjectInput(input)) {
    return batchGenerateSeriesMulti(input, deps);
  }
  return batchGenerateSeriesSingle(input, deps);
}

/**
 * 旧 single-project 实现 (向后兼容).
 */
async function batchGenerateSeriesSingle(
  input: unknown,
  _deps: BatchSeriesDeps = {},
): Promise<BatchSeriesResult> {
  const startedAtMs = Date.now();

  // 1. zod 校验
  const parsed = BatchGenerateInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      kind: "validation",
      status: 400,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  }
  const body = parsed.data;

  // 2. compile prompt
  const promptText = composeBatchPrompt(body);

  // 3. resolve LLM provider chain
  const providerId =
    providerIdFromModelRef(body.model_ref) ??
    resolveLlmProviderId({});
  const chain = resolveChain(
    providerId,
    getRegistry().listAvailable("llm").map((p) => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );

  if (chain.length === 0) {
    return {
      kind: "error",
      status: 400,
      body: {
        error: {
          code: "no_llm_provider",
          message: "没有配置任何 LLM provider 的 API Key — 去设置页填一个 (任意一家都行)",
        },
      },
    };
  }

  // 4. call LLM
  const providerCtx: ProviderContext = {
    series_slug: "_batch_pending_",
    job_id: `batch_${Date.now().toString(36)}`,
    task_id: `task_${Date.now().toString(36)}`,
    log: () => {},
    signal: passThroughSignal(),
  };

  let llmResult;
  let actualProviderId = providerId;
  try {
    llmResult = await tryWithFallback(
      chain,
      (id) => getRegistry().getLlm(id),
      {
        prompt: promptText,
        system:
          "你是一位资深短剧编剧+分镜师。只返回合法 JSON, 不要任何 markdown 包裹, 不要任何说明文字。",
        response_format: "json",
        max_tokens: 8192,
      },
      providerCtx,
      (evt) => {
        actualProviderId = evt.to;
        sseBroker.broadcast("provider.fallback", {
          from: evt.from,
          to: evt.to,
          reason: evt.reason,
        });
      },
    );
  } catch (err: unknown) {
    if (err instanceof FallbackChainError) {
      return {
        kind: "error",
        status: 502,
        body: {
          error: {
            code: "llm_chain_failed",
            message: `所有 LLM provider 都失败了。${err.suggestion()}`,
            attempts: err.errors.map((e) => ({ provider_id: e.provider_id, reason: e.code })),
          },
        },
      };
    }
    throw err;
  }

  // 5. parse + validate envelope
  let envelope: BatchEnvelope;
  try {
    const raw = parseJsonFromLlm(llmResult.text);
    envelope = BatchSeriesEnvelopeSchema.parse(raw);
  } catch (err: unknown) {
    loggerSync().warn("[batch-series] LLM 输出 JSON 解析失败:", err instanceof Error ? err.message : err);
    return {
      kind: "error",
      status: 422,
      body: {
        error: {
          code: "llm_output_invalid",
          message:
            "AI 模型输出的内容不是预期的 JSON 结构。可能它擅自加了 markdown 包裹或说明文字。建议: 1) 重试一次 2) 改用更强模型 (GPT-4o / Claude Opus 4) 3) 用 '复制完整提示词' 按钮去 ChatGPT 自己生再粘贴回来",
          raw_output_preview: llmResult.text.slice(0, 800),
        },
      },
    };
  }

  // 6. 落盘 — 复用 persistOneSeriesFromEnvelope helper
  const persisted = await persistOneSeriesFromEnvelope(
    envelope,
    body,
    promptText,
    actualProviderId,
  );

  // 7. Log to cost ledger
  getLedger().record({
    at: new Date().toISOString(),
    series_slug: persisted.series_slug,
    job_id: providerCtx.job_id,
    task_id: providerCtx.task_id,
    kind: "llm",
    provider_id: actualProviderId,
    ok: true,
    params_digest: Date.now().toString(36),
    cost: llmResult.cost,
    duration_ms: Date.now() - startedAtMs,
  });

  // 8. SSE — done
  sseBroker.broadcast("batch-series.done", {
    series_slug: persisted.series_slug,
    series_title: persisted.series_title,
    episodes_created: persisted.episodes_created,
    total_shots: persisted.total_shots,
  });

  return {
    kind: "ok",
    body: {
      ok: true,
      series_slug: persisted.series_slug,
      series_title: persisted.series_title,
      episodes_created: persisted.episodes_created,
      total_shots: persisted.total_shots,
      characters_created: persisted.characters_created,
      scenes_created: persisted.scenes_created,
      pending_image_briefs: persisted.pending_image_briefs,
      script_version_id: persisted.script_version_id,
      storyboard_version_ids: persisted.storyboard_version_ids,
      prompt_snapshot: persisted.prompt_snapshot,
      prompt_used: promptText,
      raw_llm_output: llmResult.text,
      duration_ms: Date.now() - startedAtMs,
    },
  };
}

// ─── Multi-project entry ──────────────────────────────────────────

/**
 * 多项目模式: 一次生成 N 部不同的剧.
 */
async function batchGenerateSeriesMulti(
  input: unknown,
  _deps: BatchSeriesDeps = {},
): Promise<BatchSeriesResult> {
  const startedAtMs = Date.now();

  // 1. zod 校验
  const parsed = BatchGenerateMultiInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      kind: "validation",
      status: 400,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  }
  const body = parsed.data;

  // 2. compile prompt
  const promptText = composeBatchPromptMulti(body);

  // 3. resolve LLM provider chain
  const providerId =
    providerIdFromModelRef(body.model_ref) ??
    resolveLlmProviderId({});
  const chain = resolveChain(
    providerId,
    getRegistry().listAvailable("llm").map((p) => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );

  if (chain.length === 0) {
    return {
      kind: "error",
      status: 400,
      body: {
        error: {
          code: "no_llm_provider",
          message: "没有配置任何 LLM provider 的 API Key — 去设置页填一个 (任意一家都行)",
        },
      },
    };
  }

  // 4. call LLM
  const providerCtx: ProviderContext = {
    series_slug: "_batch_multi_pending_",
    job_id: `batch_multi_${Date.now().toString(36)}`,
    task_id: `task_${Date.now().toString(36)}`,
    log: () => {},
    signal: passThroughSignal(),
  };

  let llmResult;
  let actualProviderId = providerId;
  try {
    llmResult = await tryWithFallback(
      chain,
      (id) => getRegistry().getLlm(id),
      {
        prompt: promptText,
        system:
          "你是一位资深短剧编剧+分镜师, 擅长多剧同时构思。只返回合法 JSON, 不要任何 markdown 包裹, 不要任何说明文字。",
        response_format: "json",
        max_tokens: 16384,
      },
      providerCtx,
      (evt) => {
        actualProviderId = evt.to;
        sseBroker.broadcast("provider.fallback", {
          from: evt.from,
          to: evt.to,
          reason: evt.reason,
        });
      },
    );
  } catch (err: unknown) {
    if (err instanceof FallbackChainError) {
      return {
        kind: "error",
        status: 502,
        body: {
          error: {
            code: "llm_chain_failed",
            message: `所有 LLM provider 都失败了。${err.suggestion()}`,
            attempts: err.errors.map((e) => ({ provider_id: e.provider_id, reason: e.code })),
          },
        },
      };
    }
    throw err;
  }

  // 5. parse + validate multi envelope
  let multiEnvelope: BatchMultiEnvelope;
  try {
    const raw = parseJsonFromLlm(llmResult.text);
    multiEnvelope = BatchMultiEnvelopeSchema.parse(raw);
  } catch (err: unknown) {
    loggerSync().warn("[batch-series-multi] LLM 输出 JSON 解析失败:", err instanceof Error ? err.message : err);
    return {
      kind: "error",
      status: 422,
      body: {
        error: {
          code: "llm_output_invalid",
          message:
            "AI 模型输出的内容不是预期的多项目 JSON 结构。建议: 1) 重试一次 2) 改用更强模型 (GPT-4o / Claude Opus 4) 3) 用'复制完整提示词'按钮去 ChatGPT 自己生再粘贴回来 4) 项目数过多时可以拆分两次调用",
          raw_output_preview: llmResult.text.slice(0, 800),
        },
      },
    };
  }

  // 5b. 数量一致性校验
  if (multiEnvelope.projects.length !== body.projects.length) {
    loggerSync().warn(
      `[batch-series-multi] LLM 返回 ${multiEnvelope.projects.length} 部剧, 期望 ${body.projects.length} 部`,
    );
  }

  // 6. 落盘 — 循环每部剧
  const seriesResults: BatchSeriesMultiOk["series"] = [];
  const seriesSlugs: string[] = [];
  let totalEpisodes = 0;
  let totalShots = 0;
  let totalCharacters = 0;
  let totalScenes = 0;
  let totalPendingImageBriefs = 0;

  const pairCount = Math.min(multiEnvelope.projects.length, body.projects.length);
  for (let i = 0; i < pairCount; i++) {
    const envelope = multiEnvelope.projects[i];
    const projectInput = body.projects[i];
    const mergedParams = mergeProjectParams(projectInput, body.global);

    try {
      const persisted = await persistOneSeriesFromEnvelope(
        envelope,
        mergedParams,
        promptText,
        actualProviderId,
      );
      seriesResults.push({
        series_slug: persisted.series_slug,
        series_title: persisted.series_title,
        episodes_created: persisted.episodes_created,
        total_shots: persisted.total_shots,
        characters_created: persisted.characters_created,
        scenes_created: persisted.scenes_created,
        pending_image_briefs: persisted.pending_image_briefs,
        script_version_id: persisted.script_version_id,
        storyboard_version_ids: persisted.storyboard_version_ids,
      });
      seriesSlugs.push(persisted.series_slug);
      totalEpisodes += persisted.episodes_created;
      totalShots += persisted.total_shots;
      totalCharacters += persisted.characters_created;
      totalScenes += persisted.scenes_created;
      totalPendingImageBriefs += persisted.pending_image_briefs;

      sseBroker.broadcast("batch-series.done", {
        series_slug: persisted.series_slug,
        series_title: persisted.series_title,
        episodes_created: persisted.episodes_created,
        total_shots: persisted.total_shots,
      });
    } catch (e: unknown) {
      loggerSync().warn(
        `[batch-series-multi] persist project #${i + 1} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  if (seriesResults.length === 0) {
    return {
      kind: "error",
      status: 500,
      body: {
        error: {
          code: "all_projects_failed",
          message: "所有项目落盘均失败 — 请检查磁盘权限或重试",
        },
      },
    };
  }

  // 7. Log to cost ledger
  getLedger().record({
    at: new Date().toISOString(),
    series_slug: seriesSlugs[0],
    job_id: providerCtx.job_id,
    task_id: providerCtx.task_id,
    kind: "llm",
    provider_id: actualProviderId,
    ok: true,
    params_digest: Date.now().toString(36),
    cost: llmResult.cost,
    duration_ms: Date.now() - startedAtMs,
  });

  // 8. SSE — multi done aggregate
  sseBroker.broadcast("batch-series-multi.done", {
    projects_created: seriesResults.length,
    series_slugs: seriesSlugs,
    total_episodes: totalEpisodes,
    total_shots: totalShots,
  });

  return {
    kind: "ok-multi",
    body: {
      ok: true,
      mode: "multi",
      projects_created: seriesResults.length,
      series: seriesResults,
      total_episodes: totalEpisodes,
      total_shots: totalShots,
      total_characters: totalCharacters,
      total_scenes: totalScenes,
      total_pending_image_briefs: totalPendingImageBriefs,
      series_slugs: seriesSlugs,
      prompt_used: promptText,
      raw_llm_output: llmResult.text,
      duration_ms: Date.now() - startedAtMs,
    },
  };
}
