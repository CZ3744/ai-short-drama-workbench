/**
 * assetPromptCompiler — 素材库「提示词编译器」(纯函数, 无 I/O).
 *
 * 设计见 docs/ASSET_MANAGEMENT_REDESIGN.md §5 §6.
 *
 * 为什么是纯函数:
 *   - 无 fs / 无 provider 调用 / 无网络 → 可单测, 可被任何 controller 复用.
 *   - PM 核心诉求「提示词自包含」: 每一次发给图像模型的 full_prompt, 都必须能
 *     独立喂给一个空上下文模型并正确完成任务. 这个文件就是「自包含」的唯一实现处.
 *
 * 它产出两种东西:
 *   1. compileImagePrompt() — 不调 LLM, 纯模板拼出一段合格的自包含图像提示词.
 *   2. buildLlmPolishMessages() — 当用户要「润色」时, 拼给文字 LLM 的 system+user,
 *      文字 LLM 的输出再作为 full_prompt. 这个 meta-prompt 同样自包含.
 *
 * 本文件刻意不 import ElementData 等聚合根类型 —— 只认下面这组扁平输入接口,
 * 这样它与 elementRepo / drama types 完全解耦, 谁变都不影响它.
 */

// ─── 输入 / 输出契约 ────────────────────────────────────────────────

export type AssetElementKind =
  | "character"
  | "scene"
  | "prop"
  | "wardrobe"
  | "reference"
  | "misc";

export interface CompileImagePromptInput {
  element_kind: AssetElementKind;
  element_name: string;
  element_description: string;
  /** 标签: 性格 / 关系 / 视觉 / 自由 等 */
  element_tags?: { axis: string; value: string }[];
  /** 用户在自由输入区写的本次要求 (如「生成一个穿西服的照片」) */
  user_instruction?: string;
  /** i2i: 基于某张已有图修改时, 对该图的简短描述 + 用户修改意见 */
  i2i?: { based_on_note?: string; modification: string };
  /** 目标画幅语义提示 (短剧多为竖屏 9:16) */
  aspect_hint?: string;
  /** 用户自定义负向提示词追加 */
  extra_negative?: string;
}

export interface CompiledImagePrompt {
  /** 最终发给图像模型的完整自包含提示词 */
  full_prompt: string;
  /** 负向提示词 */
  negative_prompt: string;
  /** 拆段, 给 UI 高亮 / 审核弹窗展示 */
  segments: { label: string; text: string }[];
  /** 是否 i2i 模式 (UI 据此提示「需附带参考图」) */
  is_i2i: boolean;
}

// ─── kind 文案表 ────────────────────────────────────────────────────

const KIND_CN: Record<AssetElementKind, string> = {
  character: "角色",
  scene: "场景",
  prop: "物品 / 道具",
  wardrobe: "服装造型",
  reference: "参考画面",
  misc: "杂物素材",
};

/** 每个 kind 给图像模型的出图取向提示 (让空上下文模型知道这类素材该长什么样) */
const KIND_GUIDANCE: Record<AssetElementKind, string> = {
  character:
    "全身或半身概念设计, 五官清晰, 纯色或简洁背景, 便于作为后续分镜的人物锚定参考",
  scene:
    "环境 / 场景概念图, 不出现主要人物, 强调空间布局、光线与氛围, 便于作为分镜的场景锚定参考",
  prop:
    "单个物件的清晰特写, 居中, 纯色背景, 多角度细节可辨, 便于作为道具锚定参考",
  wardrobe:
    "服装 / 造型平铺或上身展示, 强调款式、material、配色, 便于跨分镜复用",
  reference:
    "按用户描述还原画面, 作为画风 / 构图 / 色调的参考素材",
  misc:
    "单张小灵感、logo、临时参考或零散素材,主体清晰,便于在分镜里作为指定参考调用",
};

const DEFAULT_NEGATIVE =
  "低分辨率, 模糊, 畸变, 多余的肢体, 文字水印, 杂乱背景, 与要求不符的额外元素";

// ─── 通用启动词 (universal preamble) ───────────────────────────────
// 让一个完全没有上下文的图像模型理解「自己是个工具、这次要干什么」.

function buildPreamble(kind: AssetElementKind, isI2i: boolean): string {
  const kindCn = KIND_CN[kind];
  const lines = [
    `你是一个图像生成工具, 正在为一部 AI 短剧项目创建可复用的视觉素材。`,
    `本次任务: 生成一张「${kindCn}」素材。它会在该剧的多个分镜里反复出现, 必须风格统一、可作为后续生成的锚定参考。`,
  ];
  if (isI2i) {
    lines.push(
      `我同时上传了一张参考图, 它是这个素材的已有版本。请在保持其主体一致性的前提下, 按下方「修改意见」调整, 不要改动未提及的部分。`,
    );
  }
  lines.push(`请严格按下述要求出图; 不要添加未要求的元素。`);
  return lines.join("\n");
}

function formatTags(tags?: { axis: string; value: string }[]): string {
  if (!tags || tags.length === 0) return "";
  const byAxis = new Map<string, string[]>();
  for (const t of tags) {
    if (!t || !t.value) continue;
    const axis = t.axis || "标签";
    if (!byAxis.has(axis)) byAxis.set(axis, []);
    byAxis.get(axis)!.push(t.value);
  }
  const parts: string[] = [];
  for (const [axis, vals] of byAxis) parts.push(`${axis}: ${vals.join("、")}`);
  return parts.join("; ");
}

// ─── 1. 纯模板编译 (不调 LLM) ───────────────────────────────────────

export function compileImagePrompt(
  input: CompileImagePromptInput,
): CompiledImagePrompt {
  const kind = input.element_kind;
  const isI2i = !!input.i2i && !!input.i2i.modification.trim();
  const segments: { label: string; text: string }[] = [];

  const preamble = buildPreamble(kind, isI2i);
  segments.push({ label: "通用启动词", text: preamble });

  const subjectLines: string[] = [];
  if (input.element_name.trim()) {
    subjectLines.push(`素材名称: ${input.element_name.trim()}`);
  }
  if (input.element_description.trim()) {
    subjectLines.push(`已有描述: ${input.element_description.trim()}`);
  }
  const tagStr = formatTags(input.element_tags);
  if (tagStr) subjectLines.push(`标签: ${tagStr}`);
  subjectLines.push(`出图取向: ${KIND_GUIDANCE[kind]}`);
  const subject = subjectLines.join("\n");
  segments.push({ label: "素材信息", text: subject });

  let instruction = (input.user_instruction || "").trim();
  if (isI2i) {
    const based = (input.i2i!.based_on_note || "").trim();
    const mod = input.i2i!.modification.trim();
    const i2iText = based
      ? `参考图说明: ${based}\n修改意见: ${mod}`
      : `修改意见: ${mod}`;
    segments.push({ label: "基于图片的修改", text: i2iText });
    instruction = instruction ? `${instruction}\n${i2iText}` : i2iText;
  } else if (instruction) {
    segments.push({ label: "本次要求", text: instruction });
  }

  if (input.aspect_hint && input.aspect_hint.trim()) {
    segments.push({ label: "画幅", text: input.aspect_hint.trim() });
  }

  const fullParts = [preamble, "", subject];
  if (instruction) fullParts.push("", instruction);
  if (input.aspect_hint && input.aspect_hint.trim()) {
    fullParts.push("", `画幅要求: ${input.aspect_hint.trim()}`);
  }
  const full_prompt = fullParts.join("\n").trim();

  const negative_prompt = [DEFAULT_NEGATIVE, (input.extra_negative || "").trim()]
    .filter(Boolean)
    .join(", ");

  return { full_prompt, negative_prompt, segments, is_i2i: isI2i };
}

// ─── 2. LLM 润色 meta-prompt ────────────────────────────────────────
// 用户点「润色提示词」时调用. 给文字 LLM 的 system + user 也必须自包含,
// 这样换任何文字 provider 都能正确理解任务.

export interface LlmPolishMessages {
  system: string;
  user: string;
}

export function buildLlmPolishMessages(
  input: CompileImagePromptInput,
): LlmPolishMessages {
  const kindCn = KIND_CN[input.element_kind];
  const isI2i = !!input.i2i && !!input.i2i.modification.trim();

  const system = [
    "我在做一个 AI 短剧素材管理工具。请把下面这些零散信息, 润色成一段【可以直接发给图像生成模型】的中文提示词。",
    "硬性要求:",
    "- 输出的提示词面向一个没有任何上下文的图像模型, 必须自包含: 说明这是在为 AI 短剧创建可复用素材、要生成什么、风格取向。",
    isI2i
      ? "- 本次是基于上传图片的修改, 必须在提示词里明确写出「请对我上传的参考图做 XX 修改, 保持其余部分一致」。"
      : "- 本次是全新生成 (无参考图)。",
    "- 只输出最终提示词正文, 不要解释、不要 markdown、不要前后缀。",
  ].join("\n");

  const lines: string[] = [
    `素材类别: ${kindCn}`,
    `名称: ${input.element_name || "(未命名)"}`,
  ];
  if (input.element_description.trim()) {
    lines.push(`已有描述: ${input.element_description.trim()}`);
  }
  const tagStr = formatTags(input.element_tags);
  if (tagStr) lines.push(`标签: ${tagStr}`);
  if (input.user_instruction && input.user_instruction.trim()) {
    lines.push(`用户本次要求: ${input.user_instruction.trim()}`);
  }
  if (isI2i) {
    const based = (input.i2i!.based_on_note || "").trim();
    if (based) lines.push(`参考图说明: ${based}`);
    lines.push(`基于参考图的修改意见: ${input.i2i!.modification.trim()}`);
  }
  if (input.aspect_hint && input.aspect_hint.trim()) {
    lines.push(`画幅: ${input.aspect_hint.trim()}`);
  }

  return { system, user: lines.join("\n") };
}

/**
 * 兜底负向提示词 —— 当走 LLM 润色路径 (full_prompt 由 LLM 产出) 时,
 * 仍用本编译器给一个一致的 negative_prompt.
 */
export function defaultNegativePrompt(extra?: string): string {
  return [DEFAULT_NEGATIVE, (extra || "").trim()].filter(Boolean).join(", ");
}
