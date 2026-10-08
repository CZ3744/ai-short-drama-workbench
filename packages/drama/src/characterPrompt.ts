/**
 * characterPrompt — Wave B-3 (2026-05-16): 把 Character 的拆分字段
 * (appearance / outfit / personality) 编译成不同上下文用的字符串。
 *
 * 设计原则(用户解耦信仰):
 * - 拆字段权威只在 packages/drama/src/types.ts 与本文件
 * - 全项目所有"角色 → prompt 段落"拼接走这里, 不允许 controller 各自重写
 * - 严格向后兼容: 新字段缺失自动 fallback 到 legacy appearance_prompt
 *
 * 两个核心函数:
 * - resolveVisualDescription:外貌+服装 → 给生图模型的 description
 * - formatCharacterForLlmContext:角色信息 → 给剧本/分镜 LLM 的 context 行
 */

import type { Character } from "./types.js";

/**
 * 把角色的 appearance(外貌) + outfit(服装) 合成生图模型用的 visual description.
 *
 * 优先级:appearance + outfit 拼接;若两者均为空,fallback 到 legacy appearance_prompt;
 * 全空则返回空字符串(由 caller 决定是否补 fallback)。
 *
 * @example
 * resolveVisualDescription({ appearance: "十岁男孩,短发", outfit: "蓝色校服" })
 *   // → "十岁男孩,短发, 蓝色校服"
 * resolveVisualDescription({ appearance_prompt: "旧版描述" })
 *   // → "旧版描述"
 */
export function resolveVisualDescription(
  c: Pick<Character, "appearance" | "outfit" | "appearance_prompt">,
): string {
  const parts = [c.appearance, c.outfit]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0);
  if (parts.length > 0) return parts.join(", ");
  const legacy = typeof c.appearance_prompt === "string" ? c.appearance_prompt.trim() : "";
  return legacy;
}

/**
 * 把角色信息编译成给剧本/分镜 LLM 上下文的一行文本.
 *
 * 格式: `- {id}: {name} ({role}) — 性格:{personality}; 外观:{visual}; 服装:{outfit}`
 *
 * 与生图不同的是, LLM context 应同时看到 personality(影响对白/动作), 因此 personality
 * 必须始终在行内出现; 外观+服装可以两段分开列(让 LLM 区分换装情景)。
 *
 * 设计折中: 仍保留单行紧凑格式以兼容现有 prompt 模板, 但内部按 "拆开" 显式列出三段。
 *
 * @example
 * formatCharacterForLlmContext({
 *   id: "ming", name: "小明", role: "主角",
 *   appearance: "十岁男孩,短发", outfit: "蓝色校服", personality: "活泼"
 * })
 *   // → "- ming: 小明 (主角) — 性格: 活泼; 外观: 十岁男孩,短发; 服装: 蓝色校服"
 */
export function formatCharacterForLlmContext(
  c: Pick<Character, "id" | "name" | "role" | "appearance" | "outfit" | "appearance_prompt" | "personality">,
): string {
  const id = c.id ?? "";
  const name = c.name ?? "";
  const role = c.role ?? "";
  const personality = typeof c.personality === "string" ? c.personality.trim() : "";

  const appearance = typeof c.appearance === "string" ? c.appearance.trim() : "";
  const outfit = typeof c.outfit === "string" ? c.outfit.trim() : "";
  const legacy = typeof c.appearance_prompt === "string" ? c.appearance_prompt.trim() : "";

  // 拼接策略:
  // - 新数据(有 appearance/outfit):分别列出"外观"与"服装"
  // - 老数据(只有 appearance_prompt):列在"外观"段(legacy fallback)
  const segments: string[] = [];
  if (personality) segments.push(`性格: ${personality}`);
  if (appearance) {
    segments.push(`外观: ${appearance}`);
  } else if (legacy) {
    segments.push(`外观: ${legacy}`);
  }
  if (outfit) segments.push(`服装: ${outfit}`);

  const tail = segments.length > 0 ? ` — ${segments.join("; ")}` : "";
  return `- ${id}: ${name} (${role})${tail}`;
}
