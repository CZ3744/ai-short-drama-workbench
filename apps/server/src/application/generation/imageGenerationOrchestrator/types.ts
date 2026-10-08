/**
 * Phase 1 解耦重构 — TargetAdapter 模式 · 类型契约 (Wave 1, 2026-05-16).
 *
 * 设计依据: docs/ASSET_MANAGEMENT_REDESIGN.md + memory feedback_decoupling.md.
 *
 * 用户原话:"不就是接收拼接的提示词、调用模型选择器选择的模型发给 api,然后拉取结果
 * 并传给生图需求方吗?... 我绝对禁止在不同的地方分开写同样的逻辑。"
 *
 * 本文件只定义类型契约 + zod schema. 实际编排 / adapter 注册 / 持久化逻辑分布在
 * imageGenerationOrchestrator.ts 和 adapters/*.ts 各自独立的薄文件里.
 *
 * 设计原则:
 *   1. **零 silent fallback**: 任何 provider 缺失情况 throw, 不假数据.
 *   2. **adapter 内部用已有 helper**(saveToVault / addAsset / addElementImage 等),
 *      不重新造轮子. 每个 adapter 不超 50 行.
 *   3. **业务对象写入失败 → throw**, 不 silent ignore.
 *   4. **endpoint URL 不变**: Phase 1 只是后端去重, 不动 routing.
 *   5. **前端零改动**: controller response 字段名形态保留, target_state 由 controller
 *      自己 alias 命名(例: element controller 把 target_state 命名为 element 字段).
 */

import { z } from "zod";
import type { CostInfo, GeneratedImage } from "../../../../../../packages/providers/src/core/types";
import type { ImageInputRef } from "../imageGenerationService";

// ─── Target 定义 ─────────────────────────────────────────────────────

/**
 * ImageGenerationTarget 表示「这次生成的结果要写到哪种业务对象上」.
 *
 * 7 类对应 7 个 adapter, 见 adapters/ 目录. Phase 1 不新增 endpoint, 各 controller
 * 在调用 orchestrator 时传入对应 target.
 */
export type ImageTargetKind =
  /** shot.generations / first_frame_candidates */
  | "shot_first_frame"
  /** shot.last_frame_vault_id */
  | "shot_last_frame"
  /** element.images (走 elementRepo, 含 character/scene legacy 适配) */
  | "element"
  /** character.ref_image_ids (legacy, 不在 elementRepo 里的纯 character) */
  | "character_ref"
  /** scene.ref_image_ids (legacy) */
  | "scene_ref"
  /** library/series_variant (写 vault, 由 caller 决定后续如何处理) */
  | "library_variant"
  /** 只写 vault, 不绑业务对象 (raw /images/generate 等) */
  | "vault_only";

export interface ImageGenerationTarget {
  kind: ImageTargetKind;
  series_slug: string;
  /** 业务对象 id (shot_id / element_id / character_id / scene_id), vault_only 时为 undefined */
  target_id?: string;
  /** 子目标 (例: shot 的 "first" / "last", element 的 "i2i_base"), 可选 */
  sub_target?: string;
  /** 额外上下文 (ep_id / category / user_note 等), 由各 adapter 决定具体字段含义 */
  meta?: Record<string, unknown>;
}

// ─── 输入 / 输出契约 ──────────────────────────────────────────────────

/**
 * GenerateImagesForTargetRequest = generateImagesWithProvider 输入 + target 描述符.
 *
 * adapter 收到 caller 完整 request 可访问 prompt_snapshot / reference_images 等用于
 * 写 prompt_snapshot / origin 字段.
 */
export interface GenerateImagesForTargetRequest {
  prompt: string;
  negative_prompt?: string;
  provider_id?: string;
  /** ModelPicker 完整 ref, e.g. "chatgpt_codex_image:gpt-image-2" */
  model_ref?: string;
  count?: number;
  width?: number;
  height?: number;
  seed?: number;
  reference_images?: ImageInputRef[];
  strict_reference_images?: boolean;
  /** 用于 imageGenerationService.deps.default_provider_id (series.defaults 兜底) */
  default_provider_id?: string;
  /** SSE 任务追踪可选 */
  job_id?: string;
  task_id?: string;
  /** 写入业务对象的目标 */
  target: ImageGenerationTarget;
  /** i2i 模式: 基于某张已有素材图修改 (用于 origin 标记 "i2i" / based_on_image_id) */
  i2i_base?: {
    image_id?: string;
    note?: string;
  };
  /** 额外标签 (写 vault.tags + asset.tags); adapter 会拼上自己的标准 tag */
  extra_tags?: string[];
  /**
   * Wave 4-A (2026-05-16): 业务后处理产生的额外字段, adapter 把这些字段一并写入业务对象.
   *
   * 用途: jobs/orchestrator 主流量在 provider 调用前后做了 ffprobe/CLIP/precheck/prompt
   * versioning / cost 累计等深度后处理, 拿到的结果(`quality_scores` / `prompt_version` /
   * `request_payload_digest` / `cost_cny` / `negative_prompt` / `submitted_at` 等)需要
   * 完整写入 `shot.generations[i]` 记录, 让前端候选卡 / FailureCenter / 复盘工具能看到.
   *
   * Phase 1 的轻量 endpoint(shotStageController 等)不需要这些 — 留空即可, adapter 不写.
   * 该字段为通用 escape hatch, 各 adapter 自己决定哪些字段感兴趣并写入业务对象.
   */
  generation_extras?: ShotGenerationExtras;
}

/**
 * jobs/orchestrator 主流量做完业务后处理后, 通过 generation_extras 把以下字段透传给
 * shotFirstFrameAdapter / shotVideoAdapter, 写入 shot.generations[i].
 *
 * 字段语义对齐 packages/drama/src/types.ts 的 GenerationRecord:
 *   - quality_scores: postGenCheck 评分 (composition/sharpness/alignment/subject_completeness)
 *   - prompt_version: 关联 PromptVersion.version 用于追溯
 *   - request_payload_digest: sha1(JSON.stringify(request)) 用于幂等/重放检测
 *   - cost_cny: 累计成本(已经经过 USD→CNY 兑换)
 *   - submitted_at / completed_at / downloaded_at: 任务生命周期时戳
 *   - prompt_final / prompt_used: 拼接前缀(末帧连续/风格权重)后的最终 prompt
 *   - negative_prompt: shot.negative_prompt 副本
 *   - model_id: provider 适配器实际使用的模型(可能不同于 provider_id)
 *   - fps: render_spec.fps 副本(写入视频生成时用)
 *
 * 所有字段都 optional, 各 adapter 按自己业务写或忽略.
 */
export interface ShotGenerationExtras {
  quality_scores?: import("../../../../../../packages/providers/src/quality/postGenCheck").QualityScores;
  prompt_version?: number;
  provider_job_id?: string;
  provider_file_id?: string;
  model_id?: string;
  request_payload_digest?: string;
  prompt_final?: string;
  prompt_used?: string;
  negative_prompt?: string;
  duration_sec_requested?: number;
  duration_sec_actual?: number;
  fps?: number;
  cost_cny?: number;
  submitted_at?: string;
  completed_at?: string;
  downloaded_at?: string;
  /** orchestrator 在视频生成成功后用 ffmpeg 抽取末帧, 把 vault_id 给 adapter 写到 shot.last_frame_vault_id */
  last_frame_vault_id?: string;
  /** Wave 3B 标记: 本张首帧用了上一镜末帧做参考 (orchestrator 写 promptPrefix 时置为 true) */
  first_frame_from_prev?: boolean;
  /**
   * orchestrator 可以预先生成 generation_id (用于 logProviderCall / failure 记录复用同一 id),
   * 传入后 adapter 不再自己 random 生成. 留空时 adapter 自己生成.
   */
  generation_id?: string;
}

/**
 * PersistedImage = adapter 持久化后的统一返回结构.
 *
 * 各 adapter 内部写 vault / asset / 业务对象的字段名可能略异(elementRepo 用 image_id,
 * character.ref_image_ids 用 asset_id), 此处统一收口给 controller 使用.
 */
export interface PersistedImage {
  /** 业务对象内的稳定 id (element.image_id / asset_id 等) */
  image_id: string;
  /** v2 asset 记录 id (从未参与 asset_index 的 vault_only 时可空) */
  asset_id?: string;
  /** vault 记录 id (付费资产永不删) */
  vault_id?: string;
  /** 前端展示的 url */
  url: string;
  width?: number;
  height?: number;
  seed?: number;
  mime: string;
  provider_id: string;
  /** 完整自包含提示词快照 — 失败/复盘都要能看到 */
  prompt_snapshot: string;
  /**
   * Wave 4-A (2026-05-16): 落盘绝对路径. orchestrator 主流量需要拿它做 CLIP 评分 /
   * ffprobe 末帧抽取 / 文件完整性自检. 轻量 endpoint 不需要可忽略.
   * vault_only adapter 不写文件时可空.
   */
  abs_path?: string;
}

/**
 * GenerateImagesForTargetResult = orchestrator 给 controller 的回包.
 *
 * `target_state` 是业务对象最新快照, controller 把它 alias 成自己的 response 字段名
 * (elementController 命名为 "element", characterController 命名为 "character",
 * vault_only 时为 undefined).
 */
export interface GenerateImagesForTargetResult {
  /** 真实拉到的图片列表, 顺序与 provider 返回一致 */
  images: PersistedImage[];
  /** 实际使用的 provider id (经 provider_id / model_ref / default_provider_id 解析后) */
  provider_id: string;
  cost?: CostInfo;
  /**
   * 业务对象最新状态 (ElementData / CharacterData / SceneData / ShotData 等).
   * vault_only target 没有业务对象 → 永远 undefined.
   * 各 adapter 自己决定返回什么类型, 由 controller 知道 target.kind 后断言类型.
   */
  target_state?: unknown;
}

// ─── ImageTargetAdapter 接口 ─────────────────────────────────────────

export interface AdapterPersistInput {
  image: GeneratedImage;
  target: ImageGenerationTarget;
  provider_id: string;
  request: GenerateImagesForTargetRequest;
  /** 同批次内的索引 (用于生成不重复 filename) */
  batch_index: number;
}

export interface ImageTargetAdapter {
  /**
   * 把 provider 返回的单张 buffer 持久化到对应业务对象 (写 vault + addAsset + 更新
   * 业务对象). adapter 内部必须用已有 helper, 不重新造轮子.
   *
   * 任何中间步骤失败 → throw. 不 silent ignore (红线: 禁伪 mock).
   */
  persist(input: AdapterPersistInput): Promise<PersistedImage>;

  /**
   * 拉取业务对象最新状态返给 controller. vault_only adapter 返回 undefined.
   */
  readState(target: ImageGenerationTarget): Promise<unknown>;
}

// ─── zod schema (适用 controller 入参校验) ───────────────────────────

// Phase 3 (Wave 2): zod v4 自定义错误信息 — 默认英文 "Invalid option: expected ..."
// 不符合 toC 兜底, 翻成中文人话.
export const ImageTargetKindSchema = z.enum(
  [
    "shot_first_frame",
    "shot_last_frame",
    "element",
    "character_ref",
    "scene_ref",
    "library_variant",
    "vault_only",
  ],
  { error: (issue) => issue.input === undefined
    ? "target.kind 必填"
    : `target.kind 必须是以下之一: shot_first_frame / shot_last_frame / element / character_ref / scene_ref / library_variant / vault_only` },
);

/**
 * Phase 3 (Wave 2): 统一生成端点 body 校验.
 *
 * 关键约束:**slug 校验必须 Unicode-safe** — 项目此前因 SLUG_WHITELIST = /[A-Za-z0-9_\-]+/
 * 在路径参数 middleware 里误伤"小明"这类中文 slug, 已修过一次(commit 90288012).
 * body 里的 series_slug 没有路径参数 middleware 兜底, 必须在 schema 自己防御:
 *   - 仅禁止显式 path-traversal (..)
 *   - 仅禁止文件路径分隔符 (/ \) 防止跨目录写盘
 *   - **不限定 ASCII** — 中文 / 日韩 / emoji 都允许
 */
const SLUG_PATH_SAFE = (s: string): boolean => !s.includes("..") && !/[/\\]/.test(s);

export const ImageGenerationTargetSchema = z.object({
  kind: ImageTargetKindSchema,
  series_slug: z.string()
    .min(1, "series_slug 不可为空")
    .max(128, "series_slug 不可超过 128 字符")
    .refine(SLUG_PATH_SAFE, "series_slug 不可含路径分隔符 / \\ 或父目录符 .."),
  target_id: z.string().max(256).optional(),
  sub_target: z.string().max(64).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
