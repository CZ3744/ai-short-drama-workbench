/**
 * extractElementsFromScript.ts — 一键从剧本生成素材库 (2026-05-19 反馈).
 *
 * 用户原话:
 * > "素材库要允许一键导入所有素材, 通过拉取项目剧本内容, 要求 AI 分析需要添加什么素材并
 * >  回复结构化文本, 一键落实到本地添加好所有素材的参数, 并且允许一键按顺序生图..."
 * > "剧本页面也要有这个功能, 可以对剧本一键询问, 并引导用户跳转到素材库导入"
 *
 * 核心契约:
 *   - 拉取当前激活剧本 (ScriptVersion or fallback series.script_md)
 *   - 调 LLM 输出结构化 JSON: { characters, scenes, props }, 每项含 image_briefs
 *   - 落盘: createCharacter+image_briefs / createScene+image_briefs / createElement(kind=prop)
 *   - 名称冲突跳过 (已存在的 element 名 → skipped, 不覆盖)
 *   - 支持 parsed_payload: 用户外部 AI 生 JSON 后粘回, 跳过 LLM 直接落盘
 *   - 同步暴露 composeExtractFromScriptPrompt 给前端 "复制完整提示词" 按钮 (零成本)
 *   - 错误兜底: LLM 失败 → 透明返回 fallback chain error, 不静默创建空 element
 *
 * 路由挂载点:
 *   - POST /api/v2/series/:slug/extract-elements-from-script           → extractElementsFromScript()
 *   - POST /api/v2/series/:slug/extract-elements-from-script/preview-prompt → previewPrompt() (不调 LLM)
 */

import { z } from "zod";

import { readSeries } from "../../api/v2/seriesStore";
import {
  listCharacters,
  createCharacter,
  updateCharacter,
} from "../../repositories/characterRepo";
import {
  listScenes,
  createScene,
  updateScene,
} from "../../repositories/sceneRepo";
import {
  listElements,
  createElement,
  updateElement,
} from "../../repositories/elementRepo";
import {
  getRegistry,
  getLedger,
  resolveLlmProviderId,
} from "../../api/v2/orchestration/_shared/registry";
import { saveSeriesPromptSnapshot } from "../../api/v2/orchestration/_shared/paths";
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
import { getActiveScriptVersion } from "../../repositories/scriptVersionsRepo";
import { sseBroker } from "../../api/v2/sseBroker";
import type { ImageBrief } from "../../../../../packages/drama/src/types";

// ─── Input contract ────────────────────────────────────────────────

const ImageBriefSchema = z.object({
  angle: z.string().min(1).max(100),
  description: z.string().min(1).max(800),
});

const ExtractedCharacterSchema = z.object({
  name: z.string().min(1).max(60),
  role: z.string().max(100).optional(),
  appearance: z.string().max(1000).optional(),
  outfit: z.string().max(500).optional(),
  personality: z.string().max(500).optional(),
  image_briefs: z.array(ImageBriefSchema).max(8).optional(),
});

const ExtractedSceneSchema = z.object({
  name: z.string().min(1).max(60),
  location: z.string().max(500).optional(),
  time_of_day: z.string().max(100).optional(),
  mood: z.string().max(200).optional(),
  visual_style: z.string().max(500).optional(),
  image_briefs: z.array(ImageBriefSchema).max(8).optional(),
});

const ExtractedPropSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  image_briefs: z.array(ImageBriefSchema).max(4).optional(),
});

const ExtractedPayloadSchema = z.object({
  characters: z.array(ExtractedCharacterSchema).max(40).optional(),
  scenes: z.array(ExtractedSceneSchema).max(40).optional(),
  props: z.array(ExtractedPropSchema).max(40).optional(),
});

export const ExtractFromScriptInputSchema = z.object({
  model_ref: z.string().max(200).optional(),
  /** 用户在 dialog 改完粘回, 直接走落盘路径而不再调 LLM */
  parsed_payload: ExtractedPayloadSchema.optional(),
  /**
   * 2026-05-19: 先看再落 — dry_run=true 时只调 LLM 返回 payload, 不落盘.
   * 用户原话"AI 分析 → 回复结构化文本 → 一键落实", 必须支持审核环节.
   * UX 流程:
   *   1. "AI 分析" 按钮 dry_run=true → LLM 返回 JSON 填到审核区
   *   2. 用户审核/修改 JSON
   *   3. "创建全部" 按钮 parsed_payload=审核后的 JSON, dry_run=false → 真落盘
   */
  dry_run: z.boolean().optional(),
});

export type ExtractFromScriptInput = z.infer<typeof ExtractFromScriptInputSchema>;
export type ExtractedPayload = z.infer<typeof ExtractedPayloadSchema>;

// ─── Result types ──────────────────────────────────────────────────

export interface ExtractFromScriptOk {
  ok: true;
  /**
   * 2026-05-19: dry_run=true 时是 LLM 解析出来的 payload (不落盘);
   * dry_run=false 时是真实落盘后的实际写入计数 (跟旧版语义一致).
   * 前端 dry_run 路径用 dry_run_payload 拿到结构化数据填到审核区.
   */
  dry_run?: boolean;
  dry_run_payload?: ExtractedPayload;
  added: {
    characters: number;
    scenes: number;
    props: number;
  };
  pending_image_briefs: number;
  skipped: Array<{ kind: "character" | "scene" | "prop"; name: string; reason: string }>;
  prompt_used?: string;
  raw_llm_output?: string;
  duration_ms: number;
}

export type ExtractFromScriptResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "ok"; body: ExtractFromScriptOk };

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * 拉取当前激活剧本 markdown.
 *
 * P1-32 (2026-05-28 audit wave 4) 修复 — 优先级:
 *   1. activated ScriptVersion
 *   2. series.script_md (系列级总剧本)
 *   3. 拼接所有 episode.script_md (按 index 排序, 各集间分隔符) — 之前漏
 *
 * 老 bug: 用户在分集页面写剧本 (走 episode.script_md), 来 ExtractFromScript 看到剧本为空.
 */
async function loadActiveScriptMd(slug: string): Promise<string> {
  const active = await getActiveScriptVersion(slug);
  if (active?.content_md && active.content_md.trim()) return active.content_md;
  const series = await readSeries(slug);
  if (series?.script_md && series.script_md.trim()) return series.script_md;
  // P1-32: episode 级 fallback — 拼所有非空 episode.script_md
  try {
    const { listEpisodes } = await import("../../repositories/episodeRepo");
    const episodes = await listEpisodes(slug).catch(() => []);
    const parts = (episodes ?? [])
      .filter((ep) => typeof ep.script_md === "string" && ep.script_md.trim())
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((ep) => {
        const title = ep.title ? ` ${ep.title}` : "";
        return `## 第${ep.index ?? "?"}集${title}\n\n${ep.script_md!.trim()}`;
      });
    if (parts.length > 0) return parts.join("\n\n---\n\n");
  } catch { /* episode 读取失败不阻塞主路径 */ }
  return "";
}

/**
 * 收集 series 下所有已有素材名 — 用于 LLM 上下文 (避免重复推荐) + 落盘时跳过同名.
 */
async function collectExistingNames(slug: string): Promise<{
  characters: Set<string>;
  scenes: Set<string>;
  elements: Set<string>;
  all: string[];
}> {
  const characters = new Set<string>();
  const scenes = new Set<string>();
  const elements = new Set<string>();

  try {
    for (const c of await listCharacters(slug)) characters.add(c.name.toLowerCase().trim());
  } catch { /* ignore */ }
  try {
    for (const s of await listScenes(slug)) scenes.add(s.name.toLowerCase().trim());
  } catch { /* ignore */ }
  try {
    for (const el of await listElements(slug)) elements.add(el.name.toLowerCase().trim());
  } catch { /* ignore */ }

  const all = [
    ...Array.from(characters),
    ...Array.from(scenes),
    ...Array.from(elements),
  ].sort();
  return { characters, scenes, elements, all };
}

/**
 * 拼 prompt — 给前端 "复制完整提示词" 按钮 + 真调用共用.
 *
 * 设计参考 batchSeries.composeBatchPrompt:
 *  - 显式 JSON schema 在 prompt 里
 *  - 「直接输出 JSON, 不要 markdown 包裹」硬性要求
 *  - 已有素材名列入避重清单
 *  - image_briefs 的「数量自决 + 视角 + 描述自包含」说明
 */
export function composeExtractFromScriptPrompt(input: {
  script_md: string;
  series_title: string;
  existing_names: string[];
}): string {
  const scriptBody = input.script_md.trim() || "(剧本为空 — 用户还没写, 你可以提示用户先去灵感箱写剧本)";
  const existingNotice =
    input.existing_names.length > 0
      ? input.existing_names.join("、")
      : "(还没有任何素材, 全部从零创建)";

  return [
    "你是短剧素材库分析助手。请阅读下面的剧本, 分析需要创建哪些角色 / 场景 / 物品 (prop) 素材,",
    "返回结构化 JSON。这些素材会进入项目素材库, 后续每个分镜会引用它们作为视觉锚点。",
    "",
    `## 系列名`,
    "",
    input.series_title,
    "",
    `## 当前已有素材 (避免重复推荐相同名字)`,
    "",
    existingNotice,
    "",
    "## 剧本内容",
    "",
    scriptBody,
    "",
    "## 输出严格 JSON Schema (不要 markdown 包裹, 不要任何说明文字)",
    "",
    "```json",
    JSON.stringify(
      {
        characters: [
          {
            name: "角色名",
            role: "主角 / 配角 / 反派",
            appearance: "外貌(年龄/脸型/发型/身材, 用于图像生成 prompt)",
            outfit: "服装基调",
            personality: "性格简述",
            image_briefs: [
              { angle: "正面 / 标准像", description: "干净中性背景, 五官清晰, 作为后续分镜的人物锚定参考" },
              { angle: "侧面 / 全身", description: "侧脸表情, 全身站姿, 体现性格状态" },
            ],
          },
        ],
        scenes: [
          {
            name: "场景名",
            location: "拍摄地点",
            time_of_day: "白天 / 黄昏 / 深夜",
            mood: "氛围",
            visual_style: "视觉风格 prompt 片段",
            image_briefs: [
              { angle: "宽景", description: "整体空间布局, 含家具 / 落地窗等关键元素, 不出现人物" },
              { angle: "近景", description: "靠近桌面的细节, 用于近景分镜锚定" },
            ],
          },
        ],
        props: [
          {
            name: "物品名 (例: 主角的怀表)",
            description: "外观 / 材质 / 用途简述",
            image_briefs: [
              { angle: "标准像", description: "物品本体, 干净背景, 用于近景分镜参考" },
            ],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "## 硬性要求",
    "",
    "- **直接输出 JSON 对象**, 不要 markdown 代码块包裹",
    '- 不要写 "好的我来帮你..." 之类的开场白',
    "- 不要在 JSON 外加任何说明文字",
    "- `name` 不要与「当前已有素材」列表里的名字重复",
    "- 不重要的群演 / 一闪而过的物品不要建素材, 只建会重复出现的视觉锚点",
    "- 如果剧本里没有明显的某类别 (例如没有出现具体物品), 对应数组返回空 `[]`, 不要硬塞",
    "",
    "## 关于 image_briefs (素材图规划, 重要)",
    "",
    "- 每个 character / scene / prop 都给 `image_briefs` 数组, 描述「这个素材需要几张参考图、每张要画什么」",
    "- **每张 brief 必填**: `angle` (例如 '正面' / '侧面' / '全身' / '宽景' / '近景' / '俯视') + `description` (这张图要画什么)",
    "- **数量自决**: 角色多形象 / 跨情境出现 → 2-4 张; 简单 prop → 1 张. 单 element 上限: character/scene 8 张, prop 4 张",
    "- 每张 brief 要够具体, 让一个空上下文的图像模型独立画出: 含背景 + 状态 + 服装 + 情绪",
    "- 第 1 张默认作「典型代表图」(代表外貌锚点), 后续张会自动以第 1 张为 i2i 参考保持五官一致",
    "- 如果实在没想清楚要几张, 至少给 1 张 angle='标准像' 的 brief 兜底",
  ].join("\n");
}

/**
 * brief 兜底 — LLM 给空 / 没传 image_briefs 时, 自动塞 1 张 angle="标准像" brief.
 * 跟 batchSeries.ensureBriefs 同款实现, 保证 autoPipelineRunner.runElementImagesStage 流水线一致.
 */
function ensureBriefs(
  rawBriefs: ReadonlyArray<{ angle: string; description: string }> | undefined,
  fallbackDescription: string,
): ImageBrief[] {
  if (rawBriefs && rawBriefs.length > 0) {
    return rawBriefs.map((b) => ({
      angle: b.angle,
      description: b.description,
      generated: false,
    }));
  }
  const desc = fallbackDescription.trim() || "标准代表像";
  return [{ angle: "标准像", description: desc, generated: false }];
}

// ─── Preview prompt (zero-cost) ────────────────────────────────────

export interface PreviewPromptResult {
  prompt: string;
  script_md: string;
  series_title: string;
  existing_names: string[];
}

export async function previewExtractFromScriptPrompt(
  slug: string,
): Promise<PreviewPromptResult | { error: { code: string; message: string }; status: number }> {
  const series = await readSeries(slug);
  if (!series) {
    return {
      error: { code: "NotFound", message: `系列 "${slug}" 不存在` },
      status: 404,
    };
  }
  const scriptMd = await loadActiveScriptMd(slug);
  const { all: existing_names } = await collectExistingNames(slug);
  const prompt = composeExtractFromScriptPrompt({
    script_md: scriptMd,
    series_title: series.title,
    existing_names,
  });
  return {
    prompt,
    script_md: scriptMd,
    series_title: series.title,
    existing_names,
  };
}

// ─── Main entry ────────────────────────────────────────────────────

export interface ExtractFromScriptDeps {
  requestId?: string;
  /** 2026-05-20 P1 铁律 #1: caller 透传 req.signal — 客户端断开 / 用户取消能真 abort LLM. */
  signal?: AbortSignal;
}

export async function extractElementsFromScript(
  slug: string,
  input: unknown,
  _deps: ExtractFromScriptDeps = {},
): Promise<ExtractFromScriptResult> {
  const startedAtMs = Date.now();

  // 1. zod 校验
  const parsed = ExtractFromScriptInputSchema.safeParse(input ?? {});
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

  // 2. 校验 series 存在
  const series = await readSeries(slug);
  if (!series) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: `系列 "${slug}" 不存在` } },
    };
  }

  // 3. 决定走 LLM 还是直接落盘 (用户粘 JSON)
  let payload: ExtractedPayload;
  let promptText = "";
  let rawLlmOutput: string | undefined;
  let actualProviderId: string | undefined;

  if (body.parsed_payload) {
    payload = body.parsed_payload;
  } else {
    // 调 LLM 路径
    const scriptMd = await loadActiveScriptMd(slug);
    if (!scriptMd.trim()) {
      return {
        kind: "error",
        status: 400,
        body: {
          error: {
            code: "script_empty",
            message:
              "当前系列还没有剧本内容 — 请先去剧本页写或扩写剧本, 再回来分析素材",
          },
        },
      };
    }

    const { all: existing_names } = await collectExistingNames(slug);
    promptText = composeExtractFromScriptPrompt({
      script_md: scriptMd,
      series_title: series.title,
      existing_names,
    });

    // 解析 provider chain
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

    actualProviderId = providerId;
    const providerCtx: ProviderContext = {
      series_slug: slug,
      job_id: `extract_${Date.now().toString(36)}`,
      task_id: `task_${Date.now().toString(36)}`,
      log: () => {},
      // 2026-05-20 P1 铁律 #1: 透传 deps.signal 让客户端断开能真 abort
      signal: passThroughSignal(_deps.signal),
    };

    let llmResult;
    try {
      llmResult = await tryWithFallback(
        chain,
        (id) => getRegistry().getLlm(id),
        {
          prompt: promptText,
          system:
            "你是一位资深短剧素材库分析师。只返回合法 JSON, 不要任何 markdown 包裹, 不要任何说明文字。",
          response_format: "json",
          max_tokens: 4096,
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

    rawLlmOutput = llmResult.text;

    // 解析 JSON
    try {
      const raw = parseJsonFromLlm(llmResult.text);
      payload = ExtractedPayloadSchema.parse(raw);
    } catch (err: unknown) {
      loggerSync().warn(
        "[extract-elements-from-script] LLM 输出 JSON 解析失败:",
        err instanceof Error ? err.message : err,
      );
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

    // 落 prompt snapshot 给后续审计
    try {
      await saveSeriesPromptSnapshot(
        slug,
        "extract-elements-from-script",
        promptText,
        { input: body, provider: actualProviderId },
      );
    } catch (err) {
      loggerSync().warn(
        "[extract-elements-from-script] saveSeriesPromptSnapshot failed (continuing):",
        err instanceof Error ? err.message : err,
      );
    }

    // ledger
    try {
      getLedger().record({
        at: new Date().toISOString(),
        series_slug: slug,
        job_id: providerCtx.job_id,
        task_id: providerCtx.task_id,
        kind: "llm",
        provider_id: actualProviderId ?? providerId,
        ok: true,
        params_digest: Date.now().toString(36),
        cost: llmResult.cost,
        duration_ms: Date.now() - startedAtMs,
      });
    } catch { /* ignore ledger errors */ }
  }

  // 2026-05-19: dry_run 短路 — 用户原话"AI 分析→回复结构化文本→一键落实",
  // dry_run=true 时只返回 LLM 解析出的 payload, 不落盘. 让前端审核区填好后再
  // 用 parsed_payload + dry_run=false 真落盘.
  if (body.dry_run) {
    return {
      kind: "ok",
      body: {
        ok: true,
        dry_run: true,
        dry_run_payload: payload,
        added: { characters: 0, scenes: 0, props: 0 },
        pending_image_briefs:
          (payload.characters ?? []).reduce((n, c) => n + (c.image_briefs?.length ?? 0), 0) +
          (payload.scenes ?? []).reduce((n, s) => n + (s.image_briefs?.length ?? 0), 0) +
          (payload.props ?? []).reduce((n, p) => n + (p.image_briefs?.length ?? 0), 0),
        skipped: [],
        prompt_used: promptText || undefined,
        raw_llm_output: rawLlmOutput,
        duration_ms: Date.now() - startedAtMs,
      },
    };
  }

  // 4. 落盘 — 名称冲突跳过 (不覆盖)
  const existing = await collectExistingNames(slug);
  const skipped: ExtractFromScriptOk["skipped"] = [];
  let charsAdded = 0;
  let scenesAdded = 0;
  let propsAdded = 0;
  let pendingBriefs = 0;

  for (const ch of payload.characters ?? []) {
    const key = ch.name.toLowerCase().trim();
    if (existing.characters.has(key) || existing.elements.has(key)) {
      skipped.push({ kind: "character", name: ch.name, reason: "已存在同名素材" });
      continue;
    }
    try {
      const briefs = ensureBriefs(ch.image_briefs, ch.appearance ?? "");
      const created = await createCharacter(slug, {
        name: ch.name,
        role: ch.role ?? "",
        appearance_prompt: ch.appearance ?? "",
        personality: ch.personality ?? "",
        appearance: ch.appearance,
        outfit: ch.outfit,
      });
      await updateCharacter(slug, created.id, { image_briefs: briefs });
      charsAdded += 1;
      pendingBriefs += briefs.length;
      existing.characters.add(key);
    } catch (err) {
      loggerSync().warn(
        `[extract-elements-from-script] createCharacter "${ch.name}" failed:`,
        err instanceof Error ? err.message : err,
      );
      skipped.push({
        kind: "character",
        name: ch.name,
        reason: err instanceof Error ? err.message : "落盘失败",
      });
    }
  }

  for (const sc of payload.scenes ?? []) {
    const key = sc.name.toLowerCase().trim();
    if (existing.scenes.has(key) || existing.elements.has(key)) {
      skipped.push({ kind: "scene", name: sc.name, reason: "已存在同名素材" });
      continue;
    }
    try {
      const briefs = ensureBriefs(sc.image_briefs, sc.visual_style ?? sc.location ?? "");
      const created = await createScene(slug, {
        name: sc.name,
        location: sc.location,
        mood: sc.mood,
        visual_style: sc.visual_style,
        time_of_day: sc.time_of_day,
      });
      await updateScene(slug, created.id, { image_briefs: briefs });
      scenesAdded += 1;
      pendingBriefs += briefs.length;
      existing.scenes.add(key);
    } catch (err) {
      loggerSync().warn(
        `[extract-elements-from-script] createScene "${sc.name}" failed:`,
        err instanceof Error ? err.message : err,
      );
      skipped.push({
        kind: "scene",
        name: sc.name,
        reason: err instanceof Error ? err.message : "落盘失败",
      });
    }
  }

  for (const pr of payload.props ?? []) {
    const key = pr.name.toLowerCase().trim();
    if (existing.elements.has(key) || existing.characters.has(key) || existing.scenes.has(key)) {
      skipped.push({ kind: "prop", name: pr.name, reason: "已存在同名素材" });
      continue;
    }
    try {
      const briefs = ensureBriefs(pr.image_briefs, pr.description ?? "");
      const created = await createElement(slug, {
        kind: "prop",
        name: pr.name,
        description: pr.description,
      });
      await updateElement(slug, created.id, { image_briefs: briefs });
      propsAdded += 1;
      pendingBriefs += briefs.length;
      existing.elements.add(key);
    } catch (err) {
      loggerSync().warn(
        `[extract-elements-from-script] createElement(prop) "${pr.name}" failed:`,
        err instanceof Error ? err.message : err,
      );
      skipped.push({
        kind: "prop",
        name: pr.name,
        reason: err instanceof Error ? err.message : "落盘失败",
      });
    }
  }

  // 5. SSE 通知
  sseBroker.broadcast("elements.extracted", {
    series_slug: slug,
    added: { characters: charsAdded, scenes: scenesAdded, props: propsAdded },
    pending_image_briefs: pendingBriefs,
  });

  return {
    kind: "ok",
    body: {
      ok: true,
      added: {
        characters: charsAdded,
        scenes: scenesAdded,
        props: propsAdded,
      },
      pending_image_briefs: pendingBriefs,
      skipped,
      prompt_used: promptText || undefined,
      raw_llm_output: rawLlmOutput,
      duration_ms: Date.now() - startedAtMs,
    },
  };
}
