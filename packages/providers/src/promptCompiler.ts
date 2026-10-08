/**
 * Prompt Compiler
 * 模板编译引擎，支持 Mustache 风格变量替换和条件渲染
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { repoRoot } from "../../core/src/index";

// ============================================================
// 旧版接口（保持向后兼容）
// ============================================================

export interface CompilePromptInput {
  agentName: string;
  handbookName?: string;
  projectBible?: any;
  jobContext?: Record<string, any>;
  sceneContext?: any;
  toolRegistry?: Record<string, any>;
  providerCapabilities?: any[];
  userInstruction?: string;
  outputSchema?: string;
  constraints?: string[];
}

export interface CompiledPrompt {
  system: string;
  user: string;
  prompt_version: string;
  included_sections: string[];
  warnings: string[];
}

// A-4 (2026-05-12): 之前 PROMPT_VERSION 是硬编码 "phase5_v1", 改 prompts/*.md 内容也
// 不会动这个常量, 导致 manifest 记录的版本失去追溯价值. 现在改成
// PHASE 标签 + 实际 system/user 内容的 sha8 复合版本, 任何字段变动都会变 version.
const PROMPT_VERSION_PHASE = "phase5";

function computePromptVersion(system: string, user: string, sections: string[]): string {
  const payload = JSON.stringify({ system, user, sections });
  const hash = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 8);
  return `${PROMPT_VERSION_PHASE}_${hash}`;
}

// PROMPT_VERSION (旧硬编码常量) 已被 computePromptVersion() 取代, grep 全库无外部 import.

export async function compilePromptLegacy(input: CompilePromptInput): Promise<CompiledPrompt> {
  const sections: string[] = [];
  const warnings: string[] = [];
  const systemParts: string[] = [];
  const userParts: string[] = [];

  // 1. Global system rules
  systemParts.push("你是一个专业的 AI 视频创作团队成员。返回严格 JSON，不要包含 Markdown 代码块。");
  sections.push("global_rules");

  // 2. Project Bible summary
  if (input.projectBible) {
    const bible = input.projectBible;
    systemParts.push(`## 项目圣经
主题: ${bible.topic}
受众: ${bible.audience}
平台: ${bible.platform}
风格: ${bible.style}
语调: ${bible.tone}
时长目标: ${bible.duration_target_sec}秒
视觉规则: ${bible.visual_rules.join("；")}
旁白规则: ${bible.narration_rules.join("；")}
禁止事项: ${bible.forbidden.join("；")}`);
    sections.push("project_bible");
  }

  // 3. Agent Handbook
  if (input.handbookName) {
    try {
      const handbookPath = path.join(repoRoot, "agent_handbooks", `${input.handbookName}.md`);
      const handbook = await fs.readFile(handbookPath, "utf8");
      systemParts.push(`## 专业工作手册\n${handbook}`);
      sections.push(`handbook:${input.handbookName}`);
    } catch {
      warnings.push(`handbook_missing:${input.handbookName}`);
    }
  }

  // A-12 (2026-05-12): fewshot examples — 之前 prompts/*.md 都没 fewshot, LLM 输出稳定性
  // 差. 现在按 agentName 约定加载 prompts/<agentName>.fewshot.md (存在才加载, 不存在
  // 安静跳过). 文件格式建议:
  //   ## Example 1
  //   ### Input
  //   ...
  //   ### Output
  //   ```json
  //   {...}
  //   ```
  // 整文件原样塞入 system, 让 LLM 看到 input/output 配对 + 文件内容自由组织.
  if (input.agentName) {
    try {
      const fewshotPath = path.join(repoRoot, "prompts", `${input.agentName}.fewshot.md`);
      const fewshot = await fs.readFile(fewshotPath, "utf8");
      // 限长, 防止超长 fewshot 把 user prompt 挤掉
      const MAX_FEWSHOT_CHARS = 6000;
      const truncated = fewshot.length > MAX_FEWSHOT_CHARS
        ? fewshot.slice(0, MAX_FEWSHOT_CHARS) + "\n\n[...fewshot truncated]"
        : fewshot;
      systemParts.push(`## 参考示例 (few-shot)\n${truncated}`);
      sections.push(`fewshot:${input.agentName}`);
    } catch {
      // 文件不存在是正常情况, 不发 warning (大多数 agent 还没 fewshot)
    }
  }

  // 4. Job context
  if (input.jobContext) {
    userParts.push(`## 任务上下文\n${JSON.stringify(input.jobContext, null, 2).slice(0, 2000)}`);
    sections.push("job_context");
  }

  // 5. Scene context
  if (input.sceneContext) {
    userParts.push(`## 当前分镜\n${JSON.stringify({
      scene_id: input.sceneContext.scene_id,
      stable_scene_id: input.sceneContext.stable_scene_id,
      scene_title: input.sceneContext.scene_title,
      narration_text: input.sceneContext.narration_text?.slice(0, 500),
      visual_prompt: input.sceneContext.visual_prompt?.slice(0, 500),
      screen_text: input.sceneContext.screen_text,
      duration_estimate_sec: input.sceneContext.duration_estimate_sec
    }, null, 2)}`);
    sections.push("scene_context");
  }

  // 6. Tool registry
  if (input.toolRegistry) {
    const toolSummary = Object.entries(input.toolRegistry)
      .map(([name, info]: [string, any]) => `${name} (${info.type}): ${info.status} — ${info.description}`)
      .join("\n");
    systemParts.push(`## 可用工具\n${toolSummary}`);
    sections.push("tool_registry");
  }

  // 7. Provider capabilities
  if (input.providerCapabilities && input.providerCapabilities.length > 0) {
    const capSummary = input.providerCapabilities
      .map((c: any) => `${c.id} (${c.type}): ${c.supports_text_to_video ? "text→video" : ""} ${c.supports_image_to_video ? "image→video" : ""} max=${c.max_duration_sec}s cost=${c.cost_level}`)
      .join("\n");
    systemParts.push(`## Provider 能力\n${capSummary}`);
    sections.push("provider_capabilities");
  }

  // 8. User instruction
  if (input.userInstruction) {
    userParts.push(`## 本次任务\n${input.userInstruction}`);
    sections.push("user_instruction");
  }

  // 9. Output schema
  if (input.outputSchema) {
    userParts.push(`## 输出 JSON Schema\n${input.outputSchema}`);
    sections.push("output_schema");
  }

  // 10. Constraints
  if (input.constraints && input.constraints.length > 0) {
    systemParts.push(`## 禁止事项\n${input.constraints.map(c => `- ${c}`).join("\n")}`);
    sections.push("constraints");
  }

  // 11. Quality standards
  systemParts.push("## 质量标准\n- 返回合法 JSON\n- 字段完整\n- 不虚构用户文档未提供的数据\n- 不夸大事实");
  sections.push("quality_standards");

  // 12. Fallback instructions
  systemParts.push("## 失败处理\n如果无法完成任务，返回 {\"error\": \"原因\"} 格式的 JSON。");
  sections.push("fallback");

  // A-4: 用 system+user 内容计算 sha8 版本, 让 prompt 改动可追溯
  const system = systemParts.join("\n\n");
  const user = userParts.join("\n\n");
  return {
    system,
    user,
    prompt_version: computePromptVersion(system, user, sections),
    included_sections: sections,
    warnings
  };
}

export function getHandbookNames(): string[] {
  return [
    "creative_director",
    "content_planner",
    "scriptwriter",
    "storyboard_director",
    "visual_director",
    "provider_prompt_adapter",
    "asset_producer",
    "editor",
    "qa_reviewer",
    "revision_director"
  ];
}

// ============================================================
// 新版接口（P13 模板编译引擎）
// ============================================================

// YAML 解析（简化版，避免外部依赖）

/**
 * 模板元数据（从 frontmatter 解析）
 */
export interface TemplateMeta {
  id: string;
  version: number;
  input_slots: string[];
  output_format: string;
  output_schema_ref?: string;
}

/**
 * 编译结果
 */
export interface CompileResult {
  text: string;
  meta: {
    template_id: string;
    version: number;
    filled_slots: string[];
    missing_slots: string[];
  };
}

/**
 * 编译选项
 */
export interface CompileOptions {
  missing_slot_policy?: "error" | "empty" | "placeholder";
  max_length_chars?: number;
  renderer?: (slotName: string, value: any) => string;
}

/**
 * 模板缓存
 */
const templateCache = new Map<string, { meta: TemplateMeta; content: string }>();

/**
 * 解析 frontmatter
 */
function parseFrontmatter(content: string): { meta: TemplateMeta | null; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { meta: null, body: content };
  }

  try {
    const meta = parseSimpleYaml(match[1]) as TemplateMeta;
    return { meta, body: match[2] };
  } catch (e) {
    console.warn("Failed to parse frontmatter:", e);
    return { meta: null, body: content };
  }
}

/**
 * 简单的 YAML 解析器（仅支持基本格式）
 */
function parseSimpleYaml(yamlStr: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = yamlStr.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value: any = trimmed.slice(colonIndex + 1).trim();

    // 处理数组
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((v: string) => v.trim().replace(/^["']|["']$/g, ""));
    }
    // 处理数字
    else if (/^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }
    // 处理布尔值
    else if (value === "true") {
      value = true;
    } else if (value === "false") {
      value = false;
    }
    // 处理字符串（去除引号）
    else if ((value.startsWith('"') && value.endsWith('"')) ||
             (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * 加载模板文件
 */
async function loadTemplate(templateId: string): Promise<{ meta: TemplateMeta; content: string }> {
  // 检查缓存
  if (templateCache.has(templateId)) {
    return templateCache.get(templateId)!;
  }

  // 加载文件
  const templatePath = path.join(repoRoot, "prompts", `${templateId}.md`);
  const rawContent = await fs.readFile(templatePath, "utf8");
  const { meta, body } = parseFrontmatter(rawContent);

  // 如果没有 frontmatter，创建默认元数据
  const templateMeta: TemplateMeta = meta || {
    id: templateId,
    version: 1,
    input_slots: extractSlotsFromBody(body),
    output_format: "json"
  };

  const result = { meta: templateMeta, content: body };

  // 缓存（非开发环境）
  if (process.env.NODE_ENV !== "development") {
    templateCache.set(templateId, result);
  }

  return result;
}

/**
 * 从模板内容中提取槽位名称
 */
function extractSlotsFromBody(body: string): string[] {
  const slotRegex = /\{\{(\w+)\}\}/g;
  const slots = new Set<string>();
  let match;

  while ((match = slotRegex.exec(body)) !== null) {
    slots.add(match[1]);
  }

  return Array.from(slots);
}

/**
 * 渲染槽位值
 */
function renderSlotValue(
  slotName: string,
  value: any,
  renderer?: (slotName: string, value: any) => string
): string {
  // 使用自定义渲染器
  if (renderer) {
    return renderer(slotName, value);
  }

  // 数组类型
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    // 如果是对象数组，格式化为列表
    if (typeof value[0] === "object") {
      return value.map((item, i) => `${i + 1}. ${JSON.stringify(item)}`).join("\n");
    }
    // 如果是字符串数组，用逗号分隔
    return value.join("、");
  }

  // 对象类型
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value, null, 2);
  }

  // 基本类型
  return String(value ?? "");
}

/**
 * 处理条件块 {{#if slot}} ... {{/if}}
 */
function processConditionals(content: string, context: Record<string, any>): string {
  const conditionalRegex = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

  return content.replace(conditionalRegex, (match, slotName, innerContent) => {
    const value = context[slotName];
    // 如果值存在且不为空，保留内容
    if (value !== undefined && value !== null && value !== "" &&
        !(Array.isArray(value) && value.length === 0)) {
      return innerContent;
    }
    return "";
  });
}

/**
 * 替换变量槽位
 */
function replaceSlots(
  content: string,
  context: Record<string, any>,
  options: CompileOptions
): { text: string; filled: string[]; missing: string[] } {
  const filled: string[] = [];
  const missing: string[] = [];

  const slotRegex = /\{\{(\w+)\}\}/g;
  const text = content.replace(slotRegex, (match, slotName) => {
    const value = context[slotName];

    if (value !== undefined && value !== null) {
      filled.push(slotName);
      return renderSlotValue(slotName, value, options.renderer);
    }

    // 缺失槽位处理
    missing.push(slotName);

    switch (options.missing_slot_policy) {
      case "empty":
        return "";
      case "placeholder":
        return `[${slotName}]`;
      case "error":
      default:
        return match; // 保留原样，后续报错
    }
  });

  return { text, filled, missing };
}

/**
 * 清理空行
 */
function cleanEmptyLines(text: string): string {
  return text
    .split("\n")
    .map(line => line.trim())
    .reduce((acc: string[], line) => {
      // 连续空行合并为一个
      if (line === "" && acc.length > 0 && acc[acc.length - 1] === "") {
        return acc;
      }
      acc.push(line);
      return acc;
    }, [])
    .join("\n")
    .trim();
}

/**
 * 编译模板（新版接口）
 */
export async function compilePrompt(
  templateId: string,
  context: Record<string, any>,
  options: CompileOptions = {}
): Promise<CompileResult> {
  const {
    missing_slot_policy = "error",
    max_length_chars,
    renderer
  } = options;

  // 加载模板
  const { meta, content } = await loadTemplate(templateId);

  // 处理条件块
  let processedContent = processConditionals(content, context);

  // 替换变量槽位
  const { text, filled, missing } = replaceSlots(processedContent, context, {
    missing_slot_policy,
    renderer
  });

  // 清理空行
  const cleanedText = cleanEmptyLines(text);

  // 检查缺失槽位
  if (missing_slot_policy === "error" && missing.length > 0) {
    throw new Error(`Template "${templateId}" has missing slots: ${missing.join(", ")}`);
  }

  // 检查长度限制
  if (max_length_chars && cleanedText.length > max_length_chars) {
    console.warn(`Template "${templateId}" output exceeds max length: ${cleanedText.length} > ${max_length_chars}`);
  }

  return {
    text: cleanedText,
    meta: {
      template_id: meta.id,
      version: meta.version,
      filled_slots: filled,
      missing_slots: missing
    }
  };
}

/**
 * 获取模板元数据
 */
export async function getTemplateMeta(templateId: string): Promise<TemplateMeta> {
  const { meta } = await loadTemplate(templateId);
  return meta;
}

/**
 * 列出所有可用模板
 */
export async function listTemplates(): Promise<TemplateMeta[]> {
  const promptsDir = path.join(repoRoot, "prompts");
  const files = await fs.readdir(promptsDir);
  const templates: TemplateMeta[] = [];

  for (const file of files) {
    if (file.endsWith(".md") && !file.startsWith("_")) {
      const templateId = file.replace(".md", "");
      try {
        const meta = await getTemplateMeta(templateId);
        templates.push(meta);
      } catch (e) {
        console.warn(`Failed to load template "${templateId}":`, e);
      }
    }
  }

  return templates;
}

/**
 * 清除模板缓存
 */
export function clearTemplateCache(): void {
  templateCache.clear();
}

export interface AdaptPromptOptions {
  modality?: "image" | "video";
  negativePrompt?: string;
  maxLength?: number;
}

export interface AdaptPromptResult {
  prompt: string;
  negative_prompt: string;
  from_provider: string;
  to_provider: string;
  adapter_version: string;
  warnings: string[];
}

function normalizeProviderPrompt(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^(provider|model|base[_-]?url|endpoint|resolution|aspect[_-]?ratio|duration|negative[_-]?prompt)\s*[:=]/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampPrompt(prompt: string, maxLength: number): { prompt: string; truncated: boolean } {
  if (prompt.length <= maxLength) return { prompt, truncated: false };
  return { prompt: prompt.slice(0, Math.max(0, maxLength - 1)).trimEnd(), truncated: true };
}

export function adapt(
  prompt: string,
  fromProvider: string,
  toProvider: string,
  options: AdaptPromptOptions = {}
): AdaptPromptResult {
  const warnings: string[] = [];
  const source = String(prompt ?? "").trim();
  let adapted = normalizeProviderPrompt(source);
  const from = String(fromProvider || "source").trim();
  const to = String(toProvider || "target").trim();
  const target = to.toLowerCase();

  if (!adapted) {
    warnings.push("empty_prompt");
  }

  const negativePrompt = String(options.negativePrompt ?? "").trim();
  const modality = options.modality ?? "video";

  if (/minimax|hailuo/.test(target)) {
    adapted = adapted.replace(/\b(?:prompt|negative prompt|camera motion)\s*[:=].*$/gim, "").trim();
    if (modality === "video" && adapted.length < 20) {
      warnings.push("prompt_too_short_for_minimax");
    }
  } else if (/wan|aliyun|dashscope/.test(target)) {
    adapted = adapted.replace(/\b(?:prompt|negative prompt)\s*[:=].*$/gim, "").trim();
    if (!/[\u4e00-\u9fff]/.test(adapted) && /[A-Za-z]/.test(adapted)) {
      adapted = `请将以下内容转成适合视频生成的中文提示词：${adapted}`;
      warnings.push("added_chinese_wrapper");
    }
  } else if (/image/.test(target)) {
    adapted = adapted.replace(/\s+/g, " ").trim();
  }

  const maxLength = options.maxLength ?? (/minimax|hailuo/.test(target) ? 1800 : /wan|aliyun|dashscope/.test(target) ? 1200 : 4000);
  const clamped = clampPrompt(adapted, maxLength);
  if (clamped.truncated) warnings.push("prompt_truncated");

  const normalizedNegative = negativePrompt || (modality === "video" ? "低清晰度、文字遮挡、过曝、强压缩、抖动、卡顿" : "");

  return {
    prompt: clamped.prompt,
    negative_prompt: normalizedNegative,
    from_provider: from,
    to_provider: to,
    adapter_version: "adapt_v1",
    warnings
  };
}

/**
 * 预热模板缓存
 */
export async function warmupTemplateCache(): Promise<void> {
  await listTemplates();
}
