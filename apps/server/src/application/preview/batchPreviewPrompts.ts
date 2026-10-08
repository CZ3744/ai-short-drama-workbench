/**
 * batchPreviewPrompts — 批量入口的"发送前查看完整提示词"helpers (2026-05-20).
 *
 * 给两个批量 AI 调用入口提供 stage-aware preview:
 *
 *   1. previewBatchElementImagePrompts(slug)
 *      → BatchElementImageDialog "一键补全所有素材图" 用.
 *      返回: 每个 element 的每个未生成 image_brief 的完整 prompt + 自动 reference 图.
 *      用户能逐 brief 审核, 改完点确认走真 autoPipeline.element_images stage.
 *
 *   2. previewAutoPipelinePrompts(slug, epId, opts)
 *      → AutoPipelineLauncher "一键自动生成全集" 用.
 *      返回: 4 个 stage (element_images / firstframes / videos / compose) 各自的:
 *        - 调用数量统计 (total / pending / skipped)
 *        - 前 N 个 sample prompts (含 reference 图)
 *      让用户在启动前能审核每 stage 的代表 prompt + 数量预估, 避免盲点
 *      "一点就是 N×M 次付费调用".
 *
 * 设计原则:
 *   - 纯函数(I/O 只读 series/element/shot data), 不调 provider, 不扣费, 不写状态.
 *   - 提示词拼装统一走 compileImagePrompt / compileShotImagePrompt / compileShotVideoPrompt —
 *     与 autoPipelineRunner / elementController 一字不差, 这样 preview = 真实调用.
 *   - 不在后端 silent 注入参考图, 隐式 reference 走 implicitReferenceCollector,
 *     前端拿到列表, 在 PromptReviewModal 缩略图列表里渲染让用户单张取消.
 *   - 铁律 #13 (含全部图片素材): suggested_references 必须含 url + label, 前端能直接喂
 *     base64 内联到 markdown.
 */

import { buildShotPromptInput } from "../generation/shotPromptInput";
import { compileShotImagePrompt, compileShotVideoPrompt } from "../generation/shotPromptCompiler";
import {
  compileImagePrompt,
  type AssetElementKind,
} from "../generation/assetPromptCompiler";
import {
  collectImplicitReferencesFromShot,
  type SuggestedReference,
} from "../generation/implicitReferenceCollector";
import { readSeries, listEpisodes, listShots } from "../../api/v2/seriesStore";
import { listCharacters, listScenes } from "../../api/v2/seriesStore";
import { listElements } from "../../repositories/elementRepo";
import { readAnyElement, adaptCharacterData, adaptSceneData } from "../../api/v2/elementController.helpers";
import type { ElementData } from "../../repositories/elementRepo";

// ─── 公共类型 ────────────────────────────────────────────────────────

export interface BriefPromptPreview {
  /** element 在系列里的 id */
  element_id: string;
  /** element 类型 — toC 标签由前端翻 */
  element_kind: string;
  /** element 名 — 用户视角的"角色/场景/物品" 名字 */
  element_name: string;
  /** 这条 brief 在 element.image_briefs 数组里的索引 (从 0 计) */
  brief_index: number;
  /** brief 视角 ("正面" / "侧面" 等) */
  angle: string;
  /** brief 自包含描述 */
  brief_description: string;
  /** compileImagePrompt 拼出来即将发给图像 provider 的完整 prompt */
  full_prompt: string;
  /** 负向提示词 */
  negative_prompt?: string;
  /** 已自动累积的 typical/primary 图 — 第 N+1 张 brief 会以这些为 reference */
  suggested_references: SuggestedReference[];
  /** 该 brief 之前是否已生成 (用户可看到"已跳过这条") */
  already_generated: boolean;
}

export interface BatchElementImagePreviewResult {
  slug: string;
  /** 即将调用的图像 provider — 取自 caller 传入 或 series.defaults.image_provider_id */
  image_provider_id: string | null;
  /** element 数量统计 — 让用户知道"会动多少个素材" */
  total_elements: number;
  /** 有 image_briefs 待生成的 element 数 (即 stage 实际处理的) */
  pending_elements: number;
  /** 全部待生成 brief 总数 — 也就是会真实付费的图像数量 */
  total_pending_briefs: number;
  /** 待生成 brief 的逐条 prompt — 顺序与 stage 实际执行顺序一致 */
  briefs: BriefPromptPreview[];
}

export interface ShotPromptPreview {
  shot_id: string;
  shot_index: number;
  /** shot.title — 没有标题时 fallback action 前 40 字 */
  shot_title: string;
  /** compileShotImagePrompt / compileShotVideoPrompt 输出 */
  full_prompt: string;
  negative_prompt?: string;
  /** 隐式 reference 图 — 角色/场景/素材主图 */
  suggested_references: SuggestedReference[];
}

export interface StagePreview {
  stage: "element_images" | "firstframes" | "videos" | "compose";
  /** 这个 stage 会真实跑多少次调用 (例: element_images 是 brief 总数, firstframes 是镜数) */
  total_calls: number;
  /** 这个 stage 是否会被跳过 (用户选了 only_element_images / only_firstframes / 没数据) */
  will_skip: boolean;
  /** 跳过原因 — 给前端 toC 翻译 */
  skip_reason?: string;
  /** 该 stage 即将使用的 provider id */
  target_provider?: string;
  /** sample prompts — 取前 5 个 (元素/镜) 给用户审核; 全部数量走 total_calls. */
  samples: Array<BriefPromptPreview | ShotPromptPreview>;
}

export interface AutoPipelinePreviewOptions {
  image_provider_id?: string;
  video_provider_id?: string;
  image_count_per_shot?: number;
  video_count_per_shot?: number;
  only_element_images?: boolean;
  only_firstframes?: boolean;
  skip_element_images?: boolean;
  /** preview sample 上限 — 默认 5, 避免 prompt 列表爆 */
  sample_limit?: number;
}

export interface AutoPipelinePreviewResult {
  slug: string;
  episode_id: string;
  /** 总调用数粗算 — 用户看了能知道"批量启动会跑这么多次付费 API" */
  total_calls_estimate: number;
  stages: StagePreview[];
}

// ─── helper: 把 ElementData → CompileImagePromptInput → fullPrompt ─

function buildElementBriefPrompt(
  el: ElementData,
  briefIndex: number,
): { full_prompt: string; negative_prompt: string; angle: string; description: string } {
  const brief = (el.image_briefs ?? [])[briefIndex];
  if (!brief) {
    return {
      full_prompt: "",
      negative_prompt: "",
      angle: "",
      description: "(brief 不存在)",
    };
  }
  // 对齐 autoPipelineRunner.runOneElement 拼 compileInput 的方式:
  //   user_instruction = `视角: ${brief.angle}. 具体内容: ${brief.description}`
  // 这样 preview 显示的 prompt 与 stage 实际拼装一字不差.
  const compiled = compileImagePrompt({
    element_kind: el.kind as AssetElementKind,
    element_name: el.name,
    element_description: el.description,
    element_tags: el.tags.map((t) => ({ axis: t.axis, value: t.value })),
    user_instruction: `视角: ${brief.angle}. 具体内容: ${brief.description}`,
    aspect_hint: "竖屏 9:16 短剧画幅",
  });
  return {
    full_prompt: compiled.full_prompt,
    negative_prompt: compiled.negative_prompt,
    angle: brief.angle,
    description: brief.description,
  };
}

/** 收集 series 所有 element (3 套 repo) — 与 autoPipelineRunner.runElementImagesStage 一致 */
async function loadAllElements(slug: string): Promise<ElementData[]> {
  const all: ElementData[] = [];
  try {
    for (const c of await listCharacters(slug)) {
      const el = await adaptCharacterData(slug, c);
      if (el) all.push(el);
    }
  } catch {
    /* none */
  }
  try {
    for (const s of await listScenes(slug)) {
      const el = await adaptSceneData(slug, s);
      if (el) all.push(el);
    }
  } catch {
    /* none */
  }
  try {
    for (const el of await listElements(slug)) {
      all.push(el);
    }
  } catch {
    /* none */
  }
  return all;
}

/** element 自身已有 typical/primary 图 → 给 brief preview 当 reference */
function elementSelfReferences(el: ElementData, slug: string): SuggestedReference[] {
  const refs: SuggestedReference[] = [];
  const typicals = el.images.filter((im) => im.is_typical === true);
  const pool = typicals.length > 0 ? typicals : (
    el.primary_image_id
      ? el.images.filter((im) => im.image_id === el.primary_image_id)
      : []
  );
  pool.forEach((img, idx) => {
    const label = `素材「${el.name}」${typicals.length > 0 ? `典型 ${idx + 1}/${typicals.length}` : "主图"}`;
    if (img.asset_id) {
      refs.push({
        asset_id: img.asset_id,
        url: `/api/v2/series/${slug}/assets/${img.asset_id}/thumbnail?size=512`,
        thumbnail_url: `/api/v2/series/${slug}/assets/${img.asset_id}/thumbnail?size=256`,
        label,
        source: "element_primary",
        source_id: el.id,
        source_name: el.name,
      });
    } else if (img.vault_id) {
      refs.push({
        asset_id: img.vault_id,
        url: `/api/v2/vault/${img.vault_id}/thumbnail`,
        thumbnail_url: `/api/v2/vault/${img.vault_id}/thumbnail`,
        label,
        source: "element_primary",
        source_id: el.id,
        source_name: el.name,
      });
    }
  });
  return refs;
}

// ─── 1. previewBatchElementImagePrompts ────────────────────────────

export interface PreviewBatchElementImageInput {
  slug: string;
  image_provider_id?: string;
  /** sample 上限 — 默认全列, 数量太多时 caller 自己截断 */
  limit?: number;
}

export async function previewBatchElementImagePrompts(
  input: PreviewBatchElementImageInput,
): Promise<BatchElementImagePreviewResult | { error: string; status: number }> {
  const series = await readSeries(input.slug);
  if (!series) {
    return { error: "系列不存在", status: 404 };
  }

  const providerId =
    input.image_provider_id?.trim()
    || series.defaults?.image_provider_id?.trim()
    || null;

  const allElements = await loadAllElements(input.slug);
  const totalElements = allElements.length;

  // 过滤出有 image_briefs 且至少 1 张未生成的 element — 与 runElementImagesStage 一致
  const pendingElements = allElements.filter((el) => {
    const briefs = el.image_briefs ?? [];
    return briefs.some((b) => !b.generated);
  });

  const briefs: BriefPromptPreview[] = [];
  for (const el of pendingElements) {
    const elBriefs = el.image_briefs ?? [];
    for (let i = 0; i < elBriefs.length; i++) {
      const brief = elBriefs[i];
      const compiled = buildElementBriefPrompt(el, i);
      briefs.push({
        element_id: el.id,
        element_kind: el.kind,
        element_name: el.name,
        brief_index: i,
        angle: brief.angle,
        brief_description: brief.description,
        full_prompt: compiled.full_prompt,
        negative_prompt: compiled.negative_prompt,
        suggested_references: elementSelfReferences(el, input.slug),
        already_generated: brief.generated === true,
      });
    }
  }

  const limit = input.limit;
  const limited = typeof limit === "number" && limit > 0 ? briefs.slice(0, limit) : briefs;
  const totalPending = briefs.filter((b) => !b.already_generated).length;

  return {
    slug: input.slug,
    image_provider_id: providerId,
    total_elements: totalElements,
    pending_elements: pendingElements.length,
    total_pending_briefs: totalPending,
    briefs: limited,
  };
}

// ─── 2. previewAutoPipelinePrompts ─────────────────────────────────

export interface PreviewAutoPipelineInput {
  slug: string;
  episode_id: string;
  options: AutoPipelinePreviewOptions;
}

export async function previewAutoPipelinePrompts(
  input: PreviewAutoPipelineInput,
): Promise<AutoPipelinePreviewResult | { error: string; status: number }> {
  const series = await readSeries(input.slug);
  if (!series) {
    return { error: "系列不存在", status: 404 };
  }
  // episode 校验 — 走 listEpisodes 拿到一份完整列表 (与 BatchElementImageDialog 兜底 "ep01" 兼容)
  const episodes = await listEpisodes(input.slug);
  const targetEp = episodes.find((e) => e.id === input.episode_id);
  // only_element_images 模式不严格要求 episode 存在 (autoPipelineRunner 也这样)
  const opts = input.options ?? {};
  if (!targetEp && !(opts.only_element_images === true)) {
    return { error: `集 ${input.episode_id} 不存在`, status: 404 };
  }

  const sampleLimit = opts.sample_limit && opts.sample_limit > 0 ? opts.sample_limit : 5;
  const imageProvider = opts.image_provider_id?.trim() || series.defaults?.image_provider_id?.trim() || null;
  const videoProvider = opts.video_provider_id?.trim() || series.defaults?.video_provider_id?.trim() || null;

  const stages: StagePreview[] = [];
  let totalCalls = 0;

  // ── stage 1: element_images ──
  const skipElementImages = opts.skip_element_images === true;
  let elementImagesStage: StagePreview;
  if (skipElementImages) {
    elementImagesStage = {
      stage: "element_images",
      total_calls: 0,
      will_skip: true,
      skip_reason: "已选跳过素材图阶段",
      samples: [],
    };
  } else {
    const elPreview = await previewBatchElementImagePrompts({
      slug: input.slug,
      image_provider_id: imageProvider ?? undefined,
      limit: sampleLimit,
    });
    if ("error" in elPreview) {
      // 单 stage 失败不阻塞整 preview, 标 skip + reason 让前端展示
      elementImagesStage = {
        stage: "element_images",
        total_calls: 0,
        will_skip: true,
        skip_reason: elPreview.error,
        samples: [],
      };
    } else {
      elementImagesStage = {
        stage: "element_images",
        total_calls: elPreview.total_pending_briefs,
        will_skip: elPreview.total_pending_briefs === 0,
        skip_reason: elPreview.total_pending_briefs === 0 ? "所有素材已有图, 无需补全" : undefined,
        target_provider: imageProvider ?? undefined,
        samples: elPreview.briefs.slice(0, sampleLimit),
      };
      totalCalls += elPreview.total_pending_briefs;
    }
  }
  stages.push(elementImagesStage);

  // only_element_images 时后面 3 个 stage 全 skip
  const onlyElement = opts.only_element_images === true;
  const onlyFirstframes = opts.only_firstframes === true;

  // 加载 shots — firstframes / videos 都要用
  const shots = (!onlyElement && targetEp)
    ? await listShots(input.slug, input.episode_id)
    : [];

  // ── stage 2: firstframes ──
  if (onlyElement) {
    stages.push({
      stage: "firstframes",
      total_calls: 0,
      will_skip: true,
      skip_reason: "已选「只跑素材图」模式",
      samples: [],
    });
  } else {
    const imageCountPerShot = opts.image_count_per_shot ?? 1;
    const totalFirstframes = shots.length * imageCountPerShot;
    const sampleShots = shots.slice(0, sampleLimit);
    const samples: ShotPromptPreview[] = [];
    for (const shot of sampleShots) {
      const compilerInput = await buildShotPromptInput(input.slug, shot);
      const compiled = compileShotImagePrompt(compilerInput);
      const refs = await collectImplicitReferencesFromShot(input.slug, shot);
      samples.push({
        shot_id: shot.id,
        shot_index: shot.index ?? 0,
        shot_title:
          (shot.title?.trim() || (shot.action?.trim().slice(0, 40)) || shot.id),
        full_prompt: compiled.full_prompt,
        negative_prompt: compiled.negative_prompt,
        suggested_references: refs,
      });
    }
    stages.push({
      stage: "firstframes",
      total_calls: totalFirstframes,
      will_skip: totalFirstframes === 0,
      skip_reason: totalFirstframes === 0 ? "本集无分镜" : undefined,
      target_provider: imageProvider ?? undefined,
      samples,
    });
    totalCalls += totalFirstframes;
  }

  // ── stage 3: videos ──
  if (onlyElement || onlyFirstframes) {
    stages.push({
      stage: "videos",
      total_calls: 0,
      will_skip: true,
      skip_reason: onlyElement ? "已选「只跑素材图」模式" : "已选「素材图 + 首帧」模式",
      samples: [],
    });
  } else {
    const videoCountPerShot = opts.video_count_per_shot ?? 1;
    const totalVideos = shots.length * videoCountPerShot;
    const sampleShots = shots.slice(0, sampleLimit);
    const samples: ShotPromptPreview[] = [];
    for (const shot of sampleShots) {
      const compilerInput = await buildShotPromptInput(input.slug, shot);
      const compiled = compileShotVideoPrompt(compilerInput);
      const refs = await collectImplicitReferencesFromShot(input.slug, shot);
      samples.push({
        shot_id: shot.id,
        shot_index: shot.index ?? 0,
        shot_title:
          (shot.title?.trim() || (shot.action?.trim().slice(0, 40)) || shot.id),
        full_prompt: compiled.full_prompt,
        negative_prompt: compiled.negative_prompt,
        suggested_references: refs,
      });
    }
    stages.push({
      stage: "videos",
      total_calls: totalVideos,
      will_skip: totalVideos === 0,
      skip_reason: totalVideos === 0 ? "本集无分镜" : undefined,
      target_provider: videoProvider ?? undefined,
      samples,
    });
    totalCalls += totalVideos;
  }

  // ── stage 4: compose ──
  if (onlyElement || onlyFirstframes) {
    stages.push({
      stage: "compose",
      total_calls: 0,
      will_skip: true,
      skip_reason: onlyElement ? "已选「只跑素材图」模式" : "已选「素材图 + 首帧」模式",
      samples: [],
    });
  } else {
    // compose 不调云 API (ffmpeg 本地), 不计费但仍 1 次任务
    stages.push({
      stage: "compose",
      total_calls: 1,
      will_skip: false,
      skip_reason: undefined,
      target_provider: "local_ffmpeg",
      samples: [],
    });
    totalCalls += 1;
  }

  return {
    slug: input.slug,
    episode_id: input.episode_id,
    total_calls_estimate: totalCalls,
    stages,
  };
}

